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
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleIncoming(session, msg); }
        catch (err) { logger.error({ err, salesId: session.sales.salesId }, 'Gagal memproses chat masuk'); }
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

async function handleIncoming(session, msg) {
  if (!msg?.key || msg.key.fromMe) return;
  const remoteJid = msg.key.remoteJid || '';
  // Abaikan grup, broadcast, status, dan JID non-nomor.
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) return;
  if (!remoteJid.endsWith('@s.whatsapp.net')) return;
  const phone = remoteJid.split('@')[0].replace(/\D/g, '');
  if (!phone || phone === session.phone) return;
  const messageKey = msg.key.id;
  if (messageKey && !(await recordMessageOnce(session.sales.salesId, messageKey))) return;

  const text = getMessageText(msg).trim();
  if (!text) return; // Media tanpa caption tidak bisa diekstrak dengan aturan teks.
  const extracted = extractLead({ text, pushName: msg.pushName || '', phone });
  if (!extracted) return;
  const result = await upsertLead({ sales: session.sales, extracted });
  logger.info({ salesId: session.sales.salesId, phone, action: result.action, leadId: result.id, kebutuhan: extracted.kebutuhan, budget: extracted.budget }, 'Lead diproses');
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
