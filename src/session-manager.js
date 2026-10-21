import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { extractLead } from './extractor.js';
import { recordMessageOnce, upsertLead } from './firestore-leads.js';

// Logger internal Baileys: hanya warn/error supaya log tidak penuh JSON noise.
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
const sessions = new Map();
const metadataPath = path.join(config.dataDir, 'sales-sessions.json');
let restoring = false;

fs.mkdirSync(config.sessionsDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

// ---------- Log satu baris, info penting di depan ----------
const cut = (v, n = 60) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
function log(tag, text) {
  console.log(`[${tag}] ${text}`);
}
function logErr(tag, text, err) {
  console.error(`[${tag}] ERROR ${text}${err ? ` -> ${err?.message || err}` : ''}`);
  if (err?.stack) console.error(err.stack);
}
const who = (session) => session.sales.salesName || session.sales.salesId;

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
      logger: baileysLogger.child({ salesId: session.sales.salesId }),
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
        try {
          session.qr = await QRCode.toDataURL(qr);
          log('WA', `QR baru dibuat | ${who(session)}`);
        } catch (e) { logErr('WA', `gagal membuat QR | ${who(session)}`, e); }
      }
      if (connection === 'open') {
        session.connected = true;
        session.qr = null;
        session.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
        log('WA', `TERHUBUNG ${session.phone} | ${who(session)}`);
      }
      if (connection === 'close') {
        session.connected = false;
        session.qr = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        log('WA', `TERPUTUS kode=${code ?? '-'} | ${who(session)}`);
        if (session.enabled && code !== DisconnectReason.loggedOut) {
          setTimeout(() => startSocket(session, folder).catch(err => logErr('WA', `reconnect gagal | ${who(session)}`, err)), 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      log('MSG', `upsert type=${type} jumlah=${messages.length} | ${who(session)}`);
      if (type !== 'notify') {
        log('MSG', `SKIP type bukan notify (${type}) | ${who(session)}`);
        return;
      }
      for (const msg of messages) {
        try { await handleIncoming(session, msg); }
        catch (err) { logErr('MSG', `gagal memproses id=${msg?.key?.id} | ${who(session)}`, err); }
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

function skip(session, reason, who2 = '') {
  log('MSG', `SKIP ${reason}${who2 ? ` | ${who2}` : ''} | ${who(session)}`);
}

async function handleIncoming(session, msg) {
  const salesId = session.sales.salesId;
  if (!msg?.key) return skip(session, 'tidak ada key');

  const remoteJid = msg.key.remoteJid || '';
  const altJid = msg.key.remoteJidAlt || msg.key.senderPn || '';
  const msgId = msg.key.id;

  if (msg.key.fromMe) return skip(session, 'pesan dari sales sendiri', remoteJid);
  if (remoteJid.endsWith('@g.us')) return skip(session, 'grup');
  if (remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast') return skip(session, 'broadcast/status');
  if (remoteJid.endsWith('@newsletter')) return skip(session, 'newsletter');

  // Tangani format LID: pakai nomor asli jika tersedia
  let jid = remoteJid;
  if (remoteJid.endsWith('@lid')) {
    if (altJid.endsWith('@s.whatsapp.net')) {
      jid = altJid;
      log('MSG', `LID dipetakan ${remoteJid.split('@')[0]} -> ${altJid.split('@')[0]} | ${who(session)}`);
    } else {
      return skip(session, 'JID @lid tanpa nomor asli (remoteJidAlt/senderPn kosong)', remoteJid);
    }
  }
  if (!jid.endsWith('@s.whatsapp.net')) return skip(session, 'JID bukan nomor personal', jid);

  const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!phone) return skip(session, 'nomor kosong');
  if (phone === session.phone) return skip(session, 'nomor sama dengan akun sales', phone);

  const text = getMessageText(msg).trim();
  if (!text) {
    return skip(session, `tanpa teks/caption (${Object.keys(msg.message || {}).join(',') || 'kosong'})`, phone);
  }
  log('MSG', `MASUK ${phone} "${cut(text)}" | ${who(session)}`);

  // Ekstraksi DULU, baru tandai sebagai sudah diproses
  const extracted = await extractLead({ text, pushName: msg.pushName || '', phone });
  if (!extracted) return skip(session, 'bukan lead (tidak ada intent/kebutuhan/budget/referensi)', phone);

  log(
    'MSG',
    `EKSTRAKSI ${phone} | nama=${extracted.nama || '-'} | kebutuhan=${extracted.kebutuhan || '-'} | budget=${extracted.budget || '-'} | ref=${cut(extracted.referensiLaptop, 30) || '-'} | ${who(session)}`
  );

  if (msgId && !(await recordMessageOnce(salesId, msgId))) {
    return skip(session, 'duplikat (sudah pernah diproses)', phone);
  }

  const result = await upsertLead({ sales: session.sales, extracted });
  log('MSG', `SIMPAN ${result.action} ${phone} lead=${result.id} | ${who(session)}`);
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
  } catch (err) { logErr('WA', `penutupan sesi ${salesId}`, err); }
  if (logout) {
    fs.rmSync(safeFolder(salesId), { recursive: true, force: true });
    sessions.delete(salesId);
  }
  saveMetadata();
  log('WA', `${logout ? 'LOGOUT' : 'DISCONNECT'} ${salesId}`);
  return { salesId, disconnected: true, loggedOut: logout };
}

export async function restoreSessions() {
  if (restoring) return;
  restoring = true;
  try {
    if (!fs.existsSync(metadataPath)) return;
    const entries = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    log('WA', `memulihkan ${entries.length} sesi`);
    for (const item of entries) {
      if (item.enabled === false) continue;
      const s = { sales: { salesId: item.salesId, salesName: item.salesName, branch: item.branch }, connected: false, qr: null, phone: null, enabled: true, starting: false, socket: null };
      sessions.set(item.salesId, s);
      await startSocket(s, safeFolder(item.salesId));
    }
  } catch (err) { logErr('WA', 'gagal memulihkan sesi', err); }
  finally { restoring = false; }
}
