import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { extractLead } from './extractor.js';
import { recordMessageOnce, upsertLead } from './firestore-leads.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const sessions = new Map();
const metadataPath = path.join(config.dataDir, 'sales-sessions.json');
let restoring = false;

fs.mkdirSync(config.sessionsDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

function safeFolder(salesId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(salesId)) throw new Error('salesId hanya boleh huruf, angka, _ atau -');
  return path.join(config.sessionsDir, salesId);
}
function saveMetadata() {
  const data = [...sessions.values()].map(s => ({
    salesId: s.sales.salesId,
    salesName: s.sales.salesName,
    branch: s.sales.branch,
    enabled: s.enabled !== false,
  }));
  fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}
function statusOf(s) {
  return { salesId: s.sales.salesId, salesName: s.sales.salesName, branch: s.sales.branch, connected: Boolean(s.connected), hasQr: Boolean(s.qr), phone: s.phone || null, enabled: s.enabled !== false };
}

export function listSessions() { return [...sessions.values()].map(statusOf); }
export function getSession(salesId) { const s = sessions.get(salesId); return s ? statusOf(s) : null; }
export function getQr(salesId) { const s = sessions.get(salesId); return s?.qr || null; }

export async function connectSales({ salesId, salesName, branch }) {
  const folder = safeFolder(String(salesId || ''));
  if (!salesName?.trim() || !branch?.trim()) throw new Error('salesName dan branch wajib diisi');
  const sales = { salesId: String(salesId), salesName: salesName.trim(), branch: branch.trim() };
  let current = sessions.get(sales.salesId);
  if (current?.starting || current?.connected) {
    current.sales = sales;
    current.enabled = true;
    saveMetadata();
    return statusOf(current);
  }
  if (!current) {
    current = { sales, connected: false, qr: null, phone: null, enabled: true, starting: false, socket: null };
    sessions.set(sales.salesId, current);
  } else {
    current.sales = sales;
    current.enabled = true;
  }
  saveMetadata();
  await startSocket(current, folder);
  return statusOf(current);
}

async function startSocket(session, folder) {
  if (session.starting) return;
  session.starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const sock = makeWASocket({
      auth: state,
      logger: logger.child({ salesId: session.sales.salesId }),
      printQRInTerminal: false,
      browser: ['Erra Auto Lead', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    session.socket = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr) {
        try { session.qr = await QRCode.toDataURL(qr); }
        catch (e) { logger.error({ err: e }, 'Gagal membuat QR'); }
      }
      if (connection === 'open') {
        session.connected = true;
        session.qr = null;
        session.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
        logger.info({ salesId: session.sales.salesId, phone: session.phone }, 'WhatsApp sales terhubung');
      }
      if (connection === 'close') {
        session.connected = false;
        session.qr = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        logger.warn({ salesId: session.sales.salesId, code }, 'Koneksi WhatsApp terputus');
        if (session.enabled && code !== DisconnectReason.loggedOut) {
          setTimeout(() => startSocket(session, folder).catch(err => logger.error({ err }, 'Reconnect gagal')), 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.info(
        { salesId: session.sales.salesId, type, count: messages.length },
        '[MSG] upsert diterima'
      );
      if (type !== 'notify') {
        logger.info({ salesId: session.sales.salesId, type }, '[MSG] dilewati: type bukan notify');
        return;
      }
      for (const msg of messages) {
        try { await handleIncoming(session, msg); }
        catch (err) {
          logger.error(
            { err, salesId: session.sales.salesId, msgId: msg?.key?.id },
            '[MSG] GAGAL memproses'
          );
        }
      }
    });
  } finally {
    session.starting = false;
  }
}

function getMessageText(msg) {
  const m = msg.message || {};
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || '';
}

function logSkip(session, reason, extra = {}) {
  logger.info({ salesId: session.sales.salesId, reason, ...extra }, '[MSG] dilewati');
}

async function handleIncoming(session, msg) {
  const salesId = session.sales.salesId;
  if (!msg?.key) return logSkip(session, 'tidak ada key');

  const remoteJid = msg.key.remoteJid || '';
  const altJid = msg.key.remoteJidAlt || msg.key.senderPn || '';
  const msgId = msg.key.id;

  logger.info(
    { salesId, msgId, remoteJid, altJid, fromMe: !!msg.key.fromMe, pushName: msg.pushName || '' },
    '[MSG] pesan masuk'
  );

  if (msg.key.fromMe) return logSkip(session, 'pesan dari sales sendiri', { msgId });

  if (remoteJid.endsWith('@g.us')) return logSkip(session, 'grup', { msgId });
  if (remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast') return logSkip(session, 'broadcast/status', { msgId });
  if (remoteJid.endsWith('@newsletter')) return logSkip(session, 'newsletter', { msgId });

  // Tangani format LID: pakai nomor asli jika tersedia
  let jid = remoteJid;
  if (remoteJid.endsWith('@lid')) {
    if (altJid.endsWith('@s.whatsapp.net')) {
      jid = altJid;
      logger.info({ salesId, msgId, lid: remoteJid, resolved: altJid }, '[MSG] LID dipetakan ke nomor');
    } else {
      return logSkip(session, 'JID @lid tanpa nomor asli (remoteJidAlt/senderPn kosong)', { msgId, remoteJid });
    }
  }
  if (!jid.endsWith('@s.whatsapp.net')) return logSkip(session, 'JID bukan nomor personal', { msgId, jid });

  const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!phone) return logSkip(session, 'nomor kosong', { msgId });
  if (phone === session.phone) return logSkip(session, 'nomor sama dengan akun sales', { msgId });

  const text = getMessageText(msg).trim();
  if (!text) {
    return logSkip(session, 'tidak ada teks/caption', { msgId, phone, tipe: Object.keys(msg.message || {}).join(',') });
  }
  logger.info({ salesId, msgId, phone, preview: text.slice(0, 80) }, '[MSG] teks terbaca');

  // Ekstraksi DULU, baru tandai sebagai sudah diproses
  const extracted = await extractLead({ text, pushName: msg.pushName || '', phone });
  if (!extracted) {
    return logSkip(session, 'bukan lead (tidak ada intent/kebutuhan/budget/referensi)', { msgId, phone });
  }
  logger.info(
    { salesId, msgId, phone, nama: extracted.nama, kebutuhan: extracted.kebutuhan, budget: extracted.budget, referensi: extracted.referensiLaptop },
    '[MSG] hasil ekstraksi'
  );

  if (msgId && !(await recordMessageOnce(salesId, msgId))) {
    return logSkip(session, 'duplikat (sudah pernah diproses)', { msgId });
  }

  const result = await upsertLead({ sales: session.sales, extracted });
  logger.info({ salesId, msgId, phone, action: result.action, leadId: result.id }, '[MSG] lead tersimpan');
}

export async function disconnectSales(salesId, logout = false) {
  const s = sessions.get(salesId);
  if (!s) throw new Error('Sesi sales tidak ditemukan');
  s.enabled = false;
  s.connected = false;
  s.qr = null;
  try {
    if (logout) await s.socket?.logout();
    else s.socket?.end(undefined);
  } catch (err) { logger.warn({ err, salesId }, 'Penutupan sesi'); }
  if (logout) {
    fs.rmSync(safeFolder(salesId), { recursive: true, force: true });
    sessions.delete(salesId);
  }
  saveMetadata();
  return { salesId, disconnected: true, loggedOut: logout };
}

export async function restoreSessions() {
  if (restoring) return;
  restoring = true;
  try {
    if (!fs.existsSync(metadataPath)) return;
    const entries = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    for (const item of entries) {
      if (item.enabled === false) continue;
      const s = { sales: { salesId: item.salesId, salesName: item.salesName, branch: item.branch }, connected: false, qr: null, phone: null, enabled: true, starting: false, socket: null };
      sessions.set(item.salesId, s);
      await startSocket(s, safeFolder(item.salesId));
    }
  } catch (err) { logger.error({ err }, 'Gagal memulihkan sesi'); }
  finally { restoring = false; }
}
