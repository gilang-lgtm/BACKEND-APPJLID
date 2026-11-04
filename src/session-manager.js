import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { extractLead } from './extractor.js';
import { publishServerHeartbeat, publishSessionDoc, recordMessageOnce, upsertLead } from './firestore-leads.js';

// Logger KHUSUS untuk Baileys -- dibikin silent supaya log internal
// socket/websocket yang super detail tidak membanjiri log server.
const baileysLogger = pino({ level: 'silent' });

// Log aplikasi sendiri -- format: [TAG] pesan | detail
function log(tag, message, detail) {
  console.log(detail ? `[${tag}] ${message} | ${detail}` : `[${tag}] ${message}`);
}
function logError(tag, message, err, detail) {
  const errMsg = err?.message || err;
  console.error(detail ? `[${tag}] ${message}: ${errMsg} | ${detail}` : `[${tag}] ${message}: ${errMsg}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------
// PENGATURAN (bisa diubah lewat environment variable)
// ------------------------------------------------------------
const WA_DEBUG = process.env.WA_DEBUG === '1';                                   // log detail per pesan
const QR_IDLE_TIMEOUT_MS = Number(process.env.QR_IDLE_TIMEOUT_MS || 90000);      // berhenti auto-QR kalau tidak ada yang minta
const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS || 3000);         // jeda reconnect pertama
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS || 120000);         // jeda reconnect terpanjang (2 menit)
const STABLE_AFTER_MS = Number(process.env.STABLE_AFTER_MS || 60000);            // terhubung selama ini = dianggap stabil
const BAD_SESSION_LIMIT = Number(process.env.BAD_SESSION_LIMIT || 3);            // kode 500 berturut-turut sebelum menyerah
const DECRYPT_FAIL_LIMIT = Number(process.env.DECRYPT_FAIL_LIMIT || 15);         // pesan gagal didekripsi / 10 menit = sesi tidak sinkron
const DECRYPT_WINDOW_MS = 10 * 60 * 1000;
const DRAFT_RETRY_MS = Number(process.env.DRAFT_RETRY_MS || 60000);              // ulang simpan draft yang gagal
const DRAFT_MAX_QUEUE = 500;
const DRAFT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Pesan yang gagal didekripsi datang dari Baileys sebagai stub CIPHERTEXT (=2)
// tanpa isi pesan.
const STUB_CIPHERTEXT = 2;

const sessions = new Map();
const metadataPath = path.join(config.dataDir, 'sales-sessions.json');
let restoring = false;

fs.mkdirSync(config.sessionsDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

function safeFolder(salesId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(salesId)) throw new Error('salesId hanya boleh huruf, angka, _ atau -');
  return path.join(config.sessionsDir, salesId);
}

// Tulis atomik (file sementara lalu rename) supaya file tidak rusak/setengah
// tertulis kalau proses mati tepat saat menyimpan.
function saveMetadata() {
  try {
    const data = [...sessions.values()].map((s) => ({
      salesId: s.sales.salesId,
      salesName: s.sales.salesName,
      branch: s.sales.branch,
      enabled: s.enabled !== false,
    }));
    const tmp = `${metadataPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, metadataPath);
  } catch (err) { logError('WA', 'Gagal menyimpan metadata sesi', err); }
}

function statusOf(s) {
  return { salesId: s.sales.salesId, salesName: s.sales.salesName, branch: s.sales.branch, connected: Boolean(s.connected), hasQr: Boolean(s.qr), phone: s.phone || null, enabled: s.enabled !== false };
}
function label(session) {
  return `${session.sales.salesName}/${session.sales.branch}`;
}

function newSession(sales) {
  return {
    sales,
    connected: false, qr: null, phone: null, enabled: true, starting: false, socket: null,
    // Nilai sebenarnya ditentukan startSocket() dari creds.registered.
    hasEverConnected: false,
    lastRequestedAt: Date.now(),
    gen: 0,                 // nomor generasi socket; event dari socket lama diabaikan
    failStreak: 0,          // jumlah gagal/putus beruntun (untuk jeda reconnect)
    badSessionCount: 0,
    decryptFails: [],       // waktu pesan gagal didekripsi (10 menit terakhir)
    decryptWarned: false,
    reconnectTimer: null,
    stableTimer: null,
    queue: Promise.resolve(), // pesan diproses satu per satu per sesi
  };
}

// ------------------------------------------------------------
// MONITORING: status tiap sesi dipublikasikan ke Firestore (waSessions)
// ------------------------------------------------------------
const SERVER_STARTED_AT = new Date();
const DISCONNECT_REASONS = {
  401: 'Logout dari HP / perangkat tertaut dihapus (perlu scan QR ulang)',
  403: 'Akses ditolak WhatsApp (akun dibatasi)',
  408: 'Koneksi timeout',
  411: 'Versi multi-device tidak cocok',
  428: 'Koneksi ditutup',
  440: 'Sesi dipakai instance / server lain (conflict)',
  500: 'Data sesi rusak (bad session)',
  515: 'WhatsApp meminta restart koneksi',
};

function sessionState(s) {
  if (s.loggedOut) return 'logged_out';
  if (s.enabled === false) return 'disabled';
  if (s.connected && s.decryptWarned) return 'error'; // konek, tapi pesan tidak terbaca
  if (s.connected) return 'connected';
  if (s.qr) return 'waiting_qr';
  if (s.lastError && Date.now() - (s.lastErrorAt || 0) < 30 * 60 * 1000) return 'error';
  if (s.starting || s.reconnectTimer) return 'connecting';
  return 'disconnected';
}

function sessionPayload(s) {
  return {
    salesId: s.sales.salesId,
    salesName: s.sales.salesName,
    branch: s.sales.branch,
    state: sessionState(s),
    connected: Boolean(s.connected),
    enabled: s.enabled !== false,
    hasQr: Boolean(s.qr),
    phone: s.phone || null,
    hasEverConnected: Boolean(s.hasEverConnected),
    loggedOut: Boolean(s.loggedOut),
    reconnectCount: s.reconnectCount || 0,
    lastConnectedAt: s.lastConnectedAt || null,
    lastDisconnectAt: s.lastDisconnectAt || null,
    lastDisconnectCode: s.lastDisconnectCode ?? null,
    lastDisconnectReason: s.lastDisconnectReason || null,
    lastError: s.lastError || null,
    lastErrorAt: s.lastErrorAt ? new Date(s.lastErrorAt) : null,
  };
}

// Field yang sering berubah tapi tidak mengubah status -- tidak dihitung saat
// membandingkan "apakah isinya sama dengan yang terakhir dikirim", supaya loop
// reconnect tidak membanjiri Firestore.
const VOLATILE_FIELDS = ['reconnectCount', 'lastDisconnectAt', 'lastErrorAt'];

// Tulis ke Firestore paling cepat tiap 5 dtk per sesi (leading + trailing).
function syncSession(s) {
  if (s._syncTimer) { s._syncPending = true; return; }
  s._syncTimer = setTimeout(() => {
    s._syncTimer = null;
    if (s._syncPending) { s._syncPending = false; syncSession(s); }
  }, 5000);
  s._syncTimer.unref?.();
  const payload = sessionPayload(s);
  const stable = { ...payload };
  for (const k of VOLATILE_FIELDS) delete stable[k];
  const sig = JSON.stringify(stable);
  if (sig === s._lastSig) return;
  s._lastSig = sig;
  publishSessionDoc(s.sales.salesId, payload)
    .catch((err) => { s._lastSig = null; logError('MON', 'Gagal publish status sesi', err, label(s)); });
}

function noteError(s, where, err) {
  s.lastError = `${where}: ${String(err?.message || err).slice(0, 300)}`;
  s.lastErrorAt = Date.now();
  syncSession(s);
}

async function heartbeatTick() {
  try {
    const all = [...sessions.values()];
    await publishServerHeartbeat({
      startedAt: SERVER_STARTED_AT,
      sessionsTotal: all.length,
      sessionsConnected: all.filter((x) => x.connected).length,
      pendingDrafts: failedDrafts.length,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  } catch (err) { logError('MON', 'Heartbeat gagal', err); }
}
setTimeout(heartbeatTick, 5000).unref?.();
setInterval(heartbeatTick, Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000)).unref?.();

// ------------------------------------------------------------
// ANTREAN DRAFT GAGAL -- kalau menyimpan ke Firestore gagal (kuota habis,
// jaringan putus), draft ditahan di memori dan dicoba lagi, bukan hilang.
// ------------------------------------------------------------
const failedDrafts = [];
let retryingDrafts = false;

function queueFailedDraft(sales, extracted) {
  failedDrafts.push({ sales, extracted, at: Date.now(), tries: 0 });
  while (failedDrafts.length > DRAFT_MAX_QUEUE) failedDrafts.shift();
}

async function retryFailedDrafts() {
  if (retryingDrafts || !failedDrafts.length) return;
  retryingDrafts = true;
  try {
    const batch = failedDrafts.splice(0, failedDrafts.length);
    for (const item of batch) {
      if (Date.now() - item.at > DRAFT_MAX_AGE_MS) {
        log('DRAFT', 'dibuang (terlalu lama gagal)', `${item.extracted.nomorWa} | ${item.sales.branch}`);
        continue;
      }
      try {
        const r = await upsertLead({ sales: item.sales, extracted: item.extracted });
        log('DRAFT', `${r.action} (ulang) id=${r.id}`, `${item.extracted.nomorWa} | ${item.sales.branch}`);
      } catch (err) {
        item.tries++;
        failedDrafts.push(item); // coba lagi nanti
        logError('DRAFT', 'Ulang simpan draft gagal', err, `${item.extracted.nomorWa} | percobaan ${item.tries}`);
      }
    }
  } finally { retryingDrafts = false; }
}
setInterval(() => retryFailedDrafts().catch(() => {}), DRAFT_RETRY_MS).unref?.();

async function saveDraft(session, extracted) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await upsertLead({ sales: session.sales, extracted }); }
    catch (err) {
      lastErr = err;
      if (/kosong/i.test(String(err?.message))) throw err; // data tidak valid, jangan diulang
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  queueFailedDraft(session.sales, extracted);
  noteError(session, 'Simpan draft (akan dicoba lagi)', lastErr);
  return { action: 'draft_queued', id: '-' };
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------
export function listSessions() { return [...sessions.values()].map(statusOf); }
export function getSession(salesId) { const s = sessions.get(salesId); return s ? statusOf(s) : null; }
export function getQr(salesId) {
  const s = sessions.get(salesId);
  if (!s) return null;
  // SENGAJA tidak touchSession() di sini -- ini dipanggil polling background;
  // jam idle hanya diperpanjang oleh aksi eksplisit (lihat connectSales()).
  return s.qr || null;
}

export function touchSession(salesId) {
  const s = sessions.get(salesId);
  if (s) s.lastRequestedAt = Date.now();
}

// ------------------------------------------------------------
// RECONNECT
// ------------------------------------------------------------
function clearTimers(session) {
  clearTimeout(session.reconnectTimer); session.reconnectTimer = null;
  clearTimeout(session.stableTimer); session.stableTimer = null;
}

// Jeda 3s, 6s, 12s, ... maksimal 2 menit (+ acak <=1s) supaya sesi yang
// bermasalah tidak menghantam WhatsApp/Firestore tiap 3 detik tanpa henti.
function nextDelay(session) {
  session.failStreak = (session.failStreak || 0) + 1;
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (session.failStreak - 1));
  return base + Math.floor(Math.random() * 1000);
}

function scheduleReconnect(session, folder, delayMs) {
  clearTimeout(session.reconnectTimer);
  log('WA', `reconnect dalam ${Math.round(delayMs / 1000)} dtk`, label(session));
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    if (!session.enabled || session.connected) return;
    startSocket(session, folder).catch((err) => {
      logError('WA', 'Reconnect gagal', err, label(session));
      if (session.enabled && !session.connected) scheduleReconnect(session, folder, nextDelay(session));
    });
  }, delayMs);
  session.reconnectTimer.unref?.();
  syncSession(session);
}

// Matikan socket lama dengan bersih: event-nya diabaikan (gen berubah) dan
// koneksinya ditutup, supaya tidak ada dua socket hidup untuk satu sesi.
function teardownSocket(session) {
  session.gen++;
  const sock = session.socket;
  session.socket = null;
  if (!sock) return;
  try { sock.ev.removeAllListeners('connection.update'); } catch { /* abaikan */ }
  try { sock.ev.removeAllListeners('messages.upsert'); } catch { /* abaikan */ }
  try { sock.ev.removeAllListeners('creds.update'); } catch { /* abaikan */ }
  try { sock.end(undefined); } catch { /* sudah tertutup */ }
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
    syncSession(current);
    return statusOf(current);
  }
  if (!current) {
    current = newSession(sales);
    sessions.set(sales.salesId, current);
  } else {
    current.sales = sales;
    current.enabled = true;
    current.lastRequestedAt = Date.now();
    // Dimulai ulang oleh sales: bersihkan penghitung gagal & jadwal lama.
    clearTimers(current);
    current.failStreak = 0;
    current.badSessionCount = 0;
    current.decryptFails = [];
    current.decryptWarned = false;
    current.lastError = null;
  }
  current.loggedOut = false;
  saveMetadata();
  syncSession(current);
  try { await startSocket(current, folder); }
  catch (err) { noteError(current, 'Gagal memulai sesi', err); throw err; }
  return statusOf(current);
}

async function startSocket(session, folder) {
  if (session.starting) return;
  session.starting = true;
  try {
    teardownSocket(session); // pastikan tidak ada socket lama yang tersisa
    const gen = session.gen;
    const stale = () => session.gen !== gen;

    const { state, saveCreds } = await useMultiFileAuthState(folder);

    // `creds.registered` = penanda resmi Baileys bahwa pairing pernah berhasil.
    if (state.creds?.registered) session.hasEverConnected = true;

    const sock = makeWASocket({
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ['Erra Auto Lead', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
    });
    session.socket = sock;

    sock.ev.on('creds.update', () => {
      if (stale()) return;
      Promise.resolve(saveCreds()).catch((err) => { logError('WA', 'Gagal menyimpan kredensial', err, label(session)); noteError(session, 'Simpan kredensial', err); });
    });

    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (stale()) return; // event dari socket lama

      if (qr) {
        try {
          session.qr = await QRCode.toDataURL(qr);
          log('WA', 'QR baru dibuat', label(session));
          syncSession(session);
        } catch (e) { logError('WA', 'Gagal membuat QR', e, label(session)); }
      }

      if (connection === 'open') {
        session.connected = true;
        session.qr = null;
        session.hasEverConnected = true;
        session.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
        session.loggedOut = false;
        session.lastConnectedAt = new Date();
        session.lastError = null;
        session.decryptFails = [];
        session.decryptWarned = false;
        // Baru dianggap stabil (penghitung gagal direset) kalau bertahan lama.
        clearTimeout(session.stableTimer);
        session.stableTimer = setTimeout(() => { session.failStreak = 0; session.badSessionCount = 0; }, STABLE_AFTER_MS);
        session.stableTimer.unref?.();
        log('WA', 'Terhubung', `${label(session)} (${session.phone})`);
        syncSession(session);
      }

      if (connection === 'close') {
        session.connected = false;
        session.qr = null;
        clearTimeout(session.stableTimer);
        const code = lastDisconnect?.error?.output?.statusCode;
        log('WA', `TERPUTUS kode=${code}`, label(session));
        session.lastDisconnectAt = new Date();
        session.lastDisconnectCode = code ?? null;
        session.lastDisconnectReason = DISCONNECT_REASONS[code] || (code ? `Terputus (kode ${code})` : 'Terputus (tanpa kode)');

        const stop = (message) => {
          if (message) { session.lastError = message; session.lastErrorAt = Date.now(); }
          session.socket = null;
          syncSession(session);
        };

        if (code === DisconnectReason.loggedOut) { session.loggedOut = true; return stop(); }
        if (!session.enabled) return stop();

        // Sesi dipakai instance lain: reconnect hanya membuat dua instance
        // saling tendang. Berhenti dan tandai error.
        if (code === DisconnectReason.connectionReplaced) {
          return stop('Sesi dipakai instance / server lain (conflict). Pastikan hanya satu server yang berjalan.');
        }
        // Akun dibatasi WhatsApp -- reconnect tidak akan membantu.
        if (code === DisconnectReason.forbidden) {
          return stop('Akses ditolak WhatsApp (akun dibatasi).');
        }
        // Data sesi rusak berulang -- perlu logout & scan QR ulang.
        if (code === DisconnectReason.badSession) {
          session.badSessionCount = (session.badSessionCount || 0) + 1;
          if (session.badSessionCount >= BAD_SESSION_LIMIT) {
            return stop('Data sesi rusak berulang. Logout lalu scan QR ulang.');
          }
        }
        // WhatsApp sengaja meminta restart (normal setelah scan QR): segera.
        if (code === DisconnectReason.restartRequired) {
          session.reconnectCount = (session.reconnectCount || 0) + 1;
          return scheduleReconnect(session, folder, 500);
        }

        session.reconnectCount = (session.reconnectCount || 0) + 1;

        // Sesi yang SUDAH PERNAH terhubung: reconnect terus dengan jeda bertambah.
        if (session.hasEverConnected) {
          return scheduleReconnect(session, folder, nextDelay(session));
        }

        // Sesi BELUM PERNAH terhubung: lanjut buat QR baru hanya kalau masih
        // ada yang aktif meminta QR dalam QR_IDLE_TIMEOUT_MS terakhir.
        const idleFor = Date.now() - (session.lastRequestedAt || 0);
        if (idleFor < QR_IDLE_TIMEOUT_MS) {
          return scheduleReconnect(session, folder, RECONNECT_BASE_MS);
        }
        log('WA', 'idle, hentikan auto-QR (tekan tombol untuk coba lagi)', label(session));
        stop();
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (stale()) return;
      // Hanya pesan baru ('notify'). 'append' = sinkron riwayat / chat yang
      // diketik dari HP -- tidak dibaca sebagai lead.
      if (type !== 'notify') {
        if (WA_DEBUG) log('MSG', `SKIP type=${type} jumlah=${messages.length}`, label(session));
        return;
      }
      if (WA_DEBUG) log('MSG', `upsert type=notify jumlah=${messages.length}`, label(session));
      // Satu per satu per sesi: tidak ada dua pesan dari nomor yang sama
      // yang menulis draft bersamaan.
      session.queue = session.queue
        .then(() => processBatch(session, messages))
        .catch((err) => logError('MSG', 'Gagal memproses batch pesan', err, label(session)));
    });
  } catch (err) {
    noteError(session, 'startSocket', err);
    throw err;
  } finally {
    session.starting = false;
    syncSession(session);
  }
}

// ------------------------------------------------------------
// MEMBACA PESAN
// ------------------------------------------------------------
async function processBatch(session, messages) {
  for (const msg of messages) {
    try {
      // Pesan gagal didekripsi (SessionError / Bad MAC dari libsignal).
      if (!msg?.message && msg?.messageStubType === STUB_CIPHERTEXT) { noteDecryptFail(session); continue; }
      await handleIncoming(session, msg);
    } catch (err) {
      logError('MSG', 'Gagal memproses chat masuk', err, label(session));
      noteError(session, 'Proses chat masuk', err);
    }
  }
}

// Banyak pesan tidak bisa dibaca dalam waktu singkat = state enkripsi tidak
// sinkron dengan HP. Tandai sebagai error supaya terlihat di halaman Monitor.
function noteDecryptFail(session) {
  const now = Date.now();
  session.decryptFails = session.decryptFails.filter((t) => now - t < DECRYPT_WINDOW_MS);
  session.decryptFails.push(now);
  if (session.decryptFails.length >= DECRYPT_FAIL_LIMIT && !session.decryptWarned) {
    session.decryptWarned = true;
    session.lastError = 'Banyak pesan gagal dibaca (enkripsi tidak sinkron). Logout lalu scan QR ulang.';
    session.lastErrorAt = now;
    log('WA', `${session.decryptFails.length} pesan gagal didekripsi dalam 10 menit`, label(session));
    syncSession(session);
  }
}

// Buka pembungkus pesan (pesan sementara, sekali lihat, dokumen+caption, edit).
function unwrapMessage(message) {
  let cur = message || {};
  for (let i = 0; i < 5; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message ||
      cur.editedMessage?.message?.protocolMessage?.editedMessage ||
      cur.editedMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function getMessageText(msg) {
  const m = unwrapMessage(msg.message);
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.templateButtonReplyMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || m.interactiveResponseMessage?.body?.text
    || '';
}

// WhatsApp "Linked ID" (@lid): angka di depan "@lid" BUKAN nomor telepon asli
// -- harus di-resolve dulu. Nama API berbeda-beda antar versi Baileys, jadi
// dicoba beberapa kemungkinan secara defensif. Gagal semua -> null.
async function resolvePhoneFromLid(sock, msg) {
  const key = msg.key || {};
  const lidJid = key.remoteJid || '';

  const altCandidates = [key.remoteJidAlt, key.senderPn, key.participantAlt, key.participantPn, msg.verifiedBizName];
  for (const candidate of altCandidates) {
    if (typeof candidate === 'string' && candidate.endsWith('@s.whatsapp.net')) {
      const phone = candidate.split('@')[0].replace(/\D/g, '');
      if (phone) return phone;
    }
  }

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

  log('MSG', 'DEBUG @lid: semua cara resolve gagal, isi msg.key', JSON.stringify(key));
  return null;
}

async function handleIncoming(session, msg) {
  if (WA_DEBUG) {
    log('MSG', 'DEBUG diterima',
      `${label(session)} | fromMe=${msg?.key?.fromMe} | remoteJid=${msg?.key?.remoteJid || '-'} | msgTypeKeys=${msg?.message ? Object.keys(msg.message).join(',') : '(tanpa field message)'}`);
  }

  if (!msg?.key || msg.key.fromMe) return;
  const remoteJid = msg.key.remoteJid || '';
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) return;

  const text = getMessageText(msg).trim();

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
  else if (!text) skip = 'tanpa teks/caption (media)';
  else if (msg.key.id && !(await recordMessageOnce(session.sales.salesId, msg.key.id))) skip = 'duplikat, sudah pernah diproses';

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

  log('CHAT', `pesan masuk="${text || '-'}"`, `no wa=${phone || '-'} | ${label(session)} | diextrak=${diextrak}`);

  if (skip || !extracted) return;

  // Hanya menyimpan DRAFT (waLeadDrafts) untuk auto-isi form "Tambah Lead".
  // Lead beneran baru masuk ke "leads" kalau sales menekan Simpan di app.
  const result = await saveDraft(session, extracted);
  log(
    'DRAFT',
    `${result.action} id=${result.id}`,
    `${phone} | ${session.sales.branch} | nama=${extracted.nama || '-'} kebutuhan=${extracted.kebutuhan || '-'} budget=${extracted.budget || '-'} referensi=${extracted.referensiLaptop || '-'}`
  );
}

// ------------------------------------------------------------
// MATIKAN / PULIHKAN
// ------------------------------------------------------------
export async function disconnectSales(salesId, logout = false) {
  const s = sessions.get(salesId);
  if (!s) throw new Error('Sesi sales tidak ditemukan');
  s.enabled = false;
  s.connected = false;
  s.qr = null;
  clearTimers(s);
  const sock = s.socket;
  try {
    if (logout) await sock?.logout();
  } catch (err) { logError('WA', 'Logout sesi', err, salesId); }
  teardownSocket(s); // juga menutup koneksi & mengabaikan event berikutnya
  if (logout) {
    s.loggedOut = true;
    try { fs.rmSync(safeFolder(salesId), { recursive: true, force: true }); }
    catch (err) { logError('WA', 'Gagal menghapus folder sesi', err, salesId); }
  }
  s.lastDisconnectAt = new Date();
  s.lastDisconnectReason = logout ? 'Di-logout dari aplikasi' : 'Dimatikan dari aplikasi';
  syncSession(s);
  if (logout) sessions.delete(salesId);
  saveMetadata();
  return { salesId, disconnected: true, loggedOut: logout };
}

// Dipanggil saat server dimatikan: tutup semua koneksi tanpa logout,
// supaya sesi tetap tersimpan dan pulih saat server hidup lagi.
export async function shutdownSessions() {
  for (const s of sessions.values()) {
    clearTimers(s);
    teardownSocket(s);
  }
}

export async function restoreSessions() {
  if (restoring) return;
  restoring = true;
  try {
    if (!fs.existsSync(metadataPath)) return;
    let entries;
    try { entries = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); }
    catch (err) {
      // File metadata rusak: simpan salinannya, jangan membuat server gagal start.
      logError('WA', 'File metadata sesi rusak, dilewati', err);
      try { fs.copyFileSync(metadataPath, `${metadataPath}.rusak-${Date.now()}`); } catch { /* abaikan */ }
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const item of entries) {
      if (item.enabled === false || !item.salesId) continue;
      const s = newSession({ salesId: item.salesId, salesName: item.salesName, branch: item.branch });
      sessions.set(item.salesId, s);
      syncSession(s);
      // Satu sesi gagal jangan menggagalkan sesi lainnya.
      try { await startSocket(s, safeFolder(item.salesId)); }
      catch (err) {
        logError('WA', 'Gagal memulihkan satu sesi', err, `${item.salesName}/${item.branch}`);
        scheduleReconnect(s, safeFolder(item.salesId), nextDelay(s));
      }
      await sleep(500); // beri jeda antar sesi supaya tidak serentak
    }
  } catch (err) { logError('WA', 'Gagal memulihkan sesi', err); }
  finally { restoring = false; }
}
