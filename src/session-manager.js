import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { extractLead } from './extractor.js';
import { recordMessageOnce, upsertLead } from './firestore-leads.js';

const baileysLogger = pino({ level: 'silent' });

function log(tag, message, detail) {
  const line = detail ? `[${tag}] ${message} | ${detail}` : `[${tag}] ${message}`;
  console.log(line);
}
function logError(tag, message, err, detail) {
  const errMsg = err?.message || err;
  const line = detail ? `[${tag}] ${message}: ${errMsg} | ${detail}` : `[${tag}] ${message}: ${errMsg}`;
  console.error(line);
}

const sessions = new Map();
const metadataPath = path.join(config.dataDir, 'sales-sessions.json');
let restoring = false;
const QR_IDLE_TIMEOUT_MS = Number(process.env.QR_IDLE_TIMEOUT_MS || 90000);

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
function label(session) {
  return `${session.sales.salesName}/${session.sales.branch}`;
}

export function listSessions() { return [...sessions.values()].map(statusOf); }
export function getSession(salesId) { const s = sessions.get(salesId); return s ? statusOf(s) : null; }
export function getQr(salesId) {
  const s = sessions.get(salesId);
  if (!s) return null;
  return s.qr || null;
}

export function touchSession(salesId) {
  const s = sessions.get(salesId);
  if (s) s.lastRequestedAt = Date.now();
}

export async function connectSales({ salesId, salesName, branch }) {
  const folder = safeFolder(String(salesId || ''));
  if (!salesName?.trim() || !branch?.trim()) throw new Error('salesName dan branch wajib diisi');
  const sales = { salesId: String(salesId), salesName: salesName.trim(), branch: branch.trim() };
  let current = sessions.get(sales.salesId);
  if (current?.starting || current?.connected) {
    current.sales = sales;
    current.enabled = true;
    current.lastRequestedAt = Date.now();
    saveMetadata();
    return statusOf(current);
  }
  if (!current) {
    current = {
      sales, connected: false, qr: null, phone: null, enabled: true, starting: false, socket: null,
      hasEverConnected: false, lastRequestedAt: Date.now(),
    };
    sessions.set(sales.salesId, current);
  } else {
    current.sales = sales;
    current.enabled = true;
    current.lastRequestedAt = Date.now();
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

    if (state.creds?.registered) {
      session.hasEverConnected = true;
    }

    const sock = makeWASocket({
      auth: state,
      logger: baileysLogger, // logger silent khusus baileys, bukan logger aplikasi
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
          log('WA', 'QR baru dibuat', label(session));
        } catch (e) {
          logError('WA', 'Gagal membuat QR', e, label(session));
        }
      }
      if (connection === 'open') {
        session.connected = true;
        session.qr = null;
        session.hasEverConnected = true;
        session.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
        log('WA', 'Terhubung', `${label(session)} (${session.phone})`);
      }
      if (connection === 'close') {
        session.connected = false;
        session.qr = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        log('WA', `TERPUTUS kode=${code}`, label(session));

        if (!session.enabled || code === DisconnectReason.loggedOut) {
          return; // sesi memang dimatikan / logout -- jangan reconnect
        }

        if (session.hasEverConnected) {
          log('WA', 'reconnect dalam 3 dtk', label(session));
          setTimeout(() => startSocket(session, folder).catch(err => logError('WA', 'Reconnect gagal', err, label(session))), 3000);
          return;
        }

        const idleFor = Date.now() - (session.lastRequestedAt || 0);
        if (idleFor < QR_IDLE_TIMEOUT_MS) {
          log('WA', 'reconnect dalam 3 dtk', label(session));
          setTimeout(() => startSocket(session, folder).catch(err => logError('WA', 'Reconnect gagal', err, label(session))), 3000);
        } else {
          log('WA', 'idle, hentikan auto-QR (tekan tombol untuk coba lagi)', label(session));
          session.socket = null;
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        log('MSG', `SKIP type=${type}`, label(session));
        return;
      }
      log('MSG', `upsert type=notify jumlah=${messages.length}`, label(session));
      for (const msg of messages) {
        try { await handleIncoming(session, msg); }
        catch (err) { logError('MSG', 'Gagal memproses chat masuk', err, label(session)); }
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

async function resolvePhoneFromLid(sock, lidJid) {
  try {
    const mapping = sock?.signalRepository?.lidMapping;
    const resolved =
      (await mapping?.getPNForLID?.(lidJid)) ||
      (await mapping?.getPNForLid?.(lidJid)) ||
      null;
    if (resolved) {
      const phone = String(resolved).split('@')[0].replace(/\D/g, '');
      return phone || null;
    }
  } catch (err) {
    logError('MSG', 'Gagal resolve @lid ke nomor asli', err, lidJid);
  }
  return null;
}

async function handleIncoming(session, msg) {
  if (!msg?.key) {
    log('MSG', 'SKIP pesan tanpa key', label(session));
    return;
  }
  if (msg.key.fromMe) {
    log('MSG', 'SKIP pesan dari diri sendiri (fromMe)', label(session));
    return;
  }
  const remoteJid = msg.key.remoteJid || '';
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) {
    log('MSG', 'SKIP grup/broadcast/status', `${label(session)} | jid=${remoteJid}`);
    return;
  }

  let phone = null;

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    phone = remoteJid.split('@')[0].replace(/\D/g, '');
  } else if (remoteJid.endsWith('@lid')) {
    // Coba resolve LID -> nomor asli dulu sebelum di-skip.
    phone = await resolvePhoneFromLid(session.socket, remoteJid);
    if (phone) {
      log('MSG', 'Berhasil resolve @lid ke nomor asli', `${label(session)} | lid=${remoteJid} -> ${phone}`);
    } else {
      log('MSG', 'SKIP @lid tidak bisa di-resolve ke nomor asli', `${label(session)} | jid=${remoteJid}`);
      return;
    }
  } else {
    log('MSG', 'SKIP format JID tidak dikenali', `${label(session)} | jid=${remoteJid}`);
    return;
  }

  if (!phone) {
    log('MSG', 'SKIP nomor kosong setelah parsing JID', `${label(session)} | jid=${remoteJid}`);
    return;
  }
  if (phone === session.phone) {
    log('MSG', 'SKIP nomor sama dengan nomor toko sendiri', `${label(session)} | ${phone}`);
    return;
  }
  const messageKey = msg.key.id;
  if (messageKey && !(await recordMessageOnce(session.sales.salesId, messageKey))) {
    log('MSG', 'SKIP sudah pernah diproses sebelumnya (duplikat)', `${label(session)} | ${phone} | id=${messageKey}`);
    return;
  }

  const text = getMessageText(msg).trim();
  if (!text) {
    log('MSG', 'SKIP media tanpa teks/caption (gambar, voice note, stiker, dll)', `${label(session)} | ${phone}`);
    return;
  }

  log('CHAT', `masuk dari ${phone}`, `${session.sales.branch} | "${text}"`);

  const { lead: extracted, method, fallbackReason } = await extractLead({ text, pushName: msg.pushName || '', phone });

  const methodLabel = method === 'gemini' ? 'AI Gemini' : 'aturan kata kunci (fallback)';
  if (fallbackReason) {
    log('CHAT', `Gemini gagal, pakai fallback (${fallbackReason})`, `${phone} | ${session.sales.branch}`);
  }

  if (!extracted) {
    log('CHAT', `diabaikan, tidak dikenali sebagai lead (via ${methodLabel})`, `${phone} | ${session.sales.branch}`);
    return;
  }

  const result = await upsertLead({ sales: session.sales, extracted });
  log(
    'LEAD',
    `${result.action} id=${result.id} via ${methodLabel}`,
    `${phone} | ${session.sales.branch} | nama=${extracted.nama || '-'} kebutuhan=${extracted.kebutuhan || '-'} budget=${extracted.budget || '-'} referensi=${extracted.referensiLaptop || '-'}`
  );
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
  } catch (err) { logError('WA', 'Penutupan sesi', err, salesId); }
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
      const s = {
        sales: { salesId: item.salesId, salesName: item.salesName, branch: item.branch },
        connected: false, qr: null, phone: null, enabled: true, starting: false, socket: null,
       
        hasEverConnected: false,
        lastRequestedAt: Date.now(),
      };
      sessions.set(item.salesId, s);
      await startSocket(s, safeFolder(item.salesId));
    }
  } catch (err) { logError('WA', 'Gagal memulihkan sesi', err); }
  finally { restoring = false; }
}
