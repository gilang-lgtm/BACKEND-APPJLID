import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { extractLead } from './extractor.js';
import { recordMessageOnce, upsertLead } from './firestore-leads.js';

// Logger KHUSUS untuk Baileys -- dibikin silent supaya log internal
// socket/websocket yang super detail (ratusan baris JSON teknis) tidak
// membanjiri log server. Logger ini TIDAK dipakai untuk log aplikasi kita.
const baileysLogger = pino({ level: 'silent' });

// Log aplikasi sendiri -- sengaja dibuat simpel & gampang dibaca,
// format: [TAG] pesan | detail
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

// Kalau tidak ada yang minta/cek QR selama ini (sales menutup halaman
// "Tautkan WhatsApp"), hentikan loop reconnect-buat-QR otomatis supaya
// tidak jalan terus-menerus di background tanpa guna.
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
  // SENGAJA tidak touchSession() di sini -- ini dipanggil oleh polling
  // background tiap 3 detik dari app, kalau ikut memperpanjang jam idle
  // maka QR akan terus dibuat ulang selama halaman terbuka, walau sales
  // sudah tidak aktif. Jam idle hanya diperpanjang oleh AKSI EKSPLISIT
  // (tombol "Tampilkan QR" / "Muat ulang QR" ditekan), lihat connectSales().
  return s.qr || null;
}

// Dipanggil hanya dari aksi eksplisit sales (tekan tombol connect),
// BUKAN dari polling pasif -- lihat komentar di getQr().
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

    // `creds.registered` adalah penanda resmi dari Baileys: true hanya
    // kalau proses pairing WA ini PERNAH berhasil sebelumnya (file
    // kredensial valid tersimpan di folder sesi). Dipakai untuk membedakan
    // sesi yang "sudah pernah discan sales" (boleh auto-reconnect terus
    // walau idle, wajar dipulihkan kalau cuma putus jaringan) dari sesi
    // yang "belum pernah discan sama sekali" (harus tunduk ke jam idle,
    // supaya tidak auto-generate QR selamanya tanpa ada yang minta).
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

        // Sesi yang SUDAH PERNAH terhubung tetap direconnect otomatis
        // seperti biasa -- wajar dipulihkan kalau cuma putus jaringan.
        if (session.hasEverConnected) {
          log('WA', 'reconnect dalam 3 dtk', label(session));
          setTimeout(() => startSocket(session, folder).catch(err => logError('WA', 'Reconnect gagal', err, label(session))), 3000);
          return;
        }

        // Sesi BELUM PERNAH terhubung -- hanya lanjut buat QR baru kalau
        // masih ada yang aktif minta/lihat QR dalam QR_IDLE_TIMEOUT_MS
        // terakhir. Kalau tidak, berhenti sampai sales buka lagi
        // halamannya / tekan tombol "Tampilkan QR".
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

// WhatsApp "Linked ID" (@lid): format JID baru untuk kontak yang belum
// tersimpan di address book pengirim (atau akun bisnis). Angka di depan
// "@lid" BUKAN nomor telepon asli -- harus di-resolve dulu lewat mapping
// internal Baileys. Nama API persis berbeda-beda antar versi Baileys
// (fitur ini masih terus berubah di WhatsApp/Baileys), jadi dicoba
// beberapa kemungkinan secara defensif. Kalau semua gagal, fungsi ini
// mengembalikan null dan pesan akan di-skip dengan log yang jelas.
async function resolvePhoneFromLid(sock, msg) {
  const key = msg.key || {};
  const lidJid = key.remoteJid || '';

  // Cara 1: beberapa versi Baileys menaruh versi nomor-telepon-asli
  // berdampingan dengan JID @lid, langsung di field pesan itu sendiri
  // (nama field berbeda-beda antar versi, dicoba semua kemungkinan).
  const altCandidates = [key.remoteJidAlt, key.senderPn, key.participantAlt, key.participantPn, msg.verifiedBizName];
  for (const candidate of altCandidates) {
    if (typeof candidate === 'string' && candidate.endsWith('@s.whatsapp.net')) {
      const phone = candidate.split('@')[0].replace(/\D/g, '');
      if (phone) return phone;
    }
  }

  // Cara 2: lewat signalRepository.lidMapping (kalau versi Baileys-nya
  // mendukung -- diketahui dari log DEBUG sebelumnya versi kamu TIDAK
  // punya ini, tapi tetap dicoba untuk jaga-jaga kalau nanti di-update).
  try {
    const mapping = sock?.signalRepository?.lidMapping;
    const resolved =
      (await mapping?.getPNForLID?.(lidJid)) ||
      (await mapping?.getPNForLid?.(lidJid)) ||
      null;
    if (resolved) {
      const phone = String(resolved).split('@')[0].replace(/\D/g, '');
      if (phone) return phone;
    }
  } catch (err) {
    logError('MSG', 'Gagal resolve @lid lewat lidMapping', err, lidJid);
  }

  // Semua cara gagal -- dump seluruh field di key pesan (bukan seluruh
  // pesan, supaya tidak kepanjangan) supaya kelihatan field apa saja yang
  // sebenarnya dikirim WhatsApp untuk pesan @lid ini.
  log('MSG', 'DEBUG @lid: semua cara resolve gagal, isi msg.key', JSON.stringify(key));
  return null;
}

async function handleIncoming(session, msg) {
  // Diagnostik paling awal -- supaya kelihatan kalaupun pesan ke-skip di
  // pengecekan paling pertama (fromMe, tanpa key, dll), yang mana sebelum
  // ini TIDAK ada log-nya sama sekali kalau ke-skip di sini.
  log(
    'MSG',
    'DEBUG diterima',
    `${label(session)} | hasKey=${Boolean(msg?.key)} | fromMe=${msg?.key?.fromMe} | remoteJid=${msg?.key?.remoteJid || '-'} | msgTypeKeys=${msg?.message ? Object.keys(msg.message).join(',') : '(tanpa field message)'}`
  );

  if (!msg?.key || msg.key.fromMe) return;
  const remoteJid = msg.key.remoteJid || '';
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) {
    return;
  }

  const text = getMessageText(msg).trim();

  // Resolve nomor pengirim dari JID. Untuk @lid (kontak belum tersimpan
  // di address book), angka di JID BUKAN nomor asli -- coba resolve dulu.
  let phone = null;
  let phoneIssue = null;
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    phone = remoteJid.split('@')[0].replace(/\D/g, '');
  } else if (remoteJid.endsWith('@lid')) {
    phone = await resolvePhoneFromLid(session.socket, msg);
    if (!phone) phoneIssue = 'gagal resolve @lid';
  } else {
    phoneIssue = `jid tidak dikenali (${remoteJid})`;
  }

  let skip = null;
  if (!phone) skip = phoneIssue || 'nomor tidak diketahui';
  else if (phone === session.phone) skip = 'nomor sama dengan nomor toko sendiri';
  else if (msg.key.id && !(await recordMessageOnce(session.sales.salesId, msg.key.id))) skip = 'duplikat, sudah pernah diproses';
  else if (!text) skip = 'tanpa teks/caption (media)';

  let extracted = null;
  let method = null;
  let fallbackReason = null;
  if (!skip) {
    ({ lead: extracted, method, fallbackReason } = await extractLead({ text, pushName: msg.pushName || '', phone }));
  }

  const methodLabel = method === 'gemini' ? 'gemini' : 'manual';
  const diextrak = skip
    ? `tidak diproses (${skip})`
    : !extracted
      ? `diabaikan, bukan lead (${methodLabel}${fallbackReason ? `, gemini gagal: ${fallbackReason}` : ''})`
      : `${methodLabel}${fallbackReason ? ` (gemini gagal: ${fallbackReason})` : ''}`;

  // Satu baris ringkas per pesan masuk: isi pesan, nomor wa, hasil ekstraksi.
  log('CHAT', `pesan masuk="${text || '-'}"`, `no wa=${phone || '-'} | ${label(session)} | diextrak=${diextrak}`);

  if (skip || !extracted) return;

  const result = await upsertLead({ sales: session.sales, extracted });
  log(
    'LEAD',
    `${result.action} id=${result.id}`,
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
        // JANGAN di-hardcode true di sini -- startSocket() di bawah akan
        // menentukan nilai sebenarnya dari creds.registered begitu folder
        // sesinya dibaca. Sesi yang BELUM pernah discan (creds.registered
        // masih false) harus tetap tunduk ke jam idle, bukan dianggap
        // "sudah terhubung" cuma karena pernah tersimpan di metadata.
        hasEverConnected: false,
        lastRequestedAt: Date.now(),
      };
      sessions.set(item.salesId, s);
      await startSocket(s, safeFolder(item.salesId));
    }
  } catch (err) { logError('WA', 'Gagal memulihkan sesi', err); }
  finally { restoring = false; }
}
