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

// Hanya log error yang dipertahankan. Log lain sudah dihapus.
function logError(tag, message, err, detail) {
  const errMsg = err?.message || err;
  const line = detail ? `[${tag}] ${message}: ${errMsg} | ${detail}` : `[${tag}] ${message}: ${errMsg}`;
  console.error(line);
}

// ============================================================
// LOG CHAT MASUK (satu baris per chat)
//
// Chat yang masuk leads:
// [CHAT] Budi/Bekasi | 6281234567890 | "cari laptop buat kuliah budget 3jt" | ✅ MASUK LEADS (lead BARU dibuat) | nama=Rina kebutuhan=Kuliah budget=3 Jutaan referensi=-
//
// Chat yang tidak masuk leads:
// [CHAT] Budi/Bekasi | 6281234567890 | "halo" | ⛔ TIDAK MASUK LEADS | alasan=...
//
// Grup, status, pesan keluar, duplikat, dan media tanpa teks
// tidak dicatat sama sekali.
// ============================================================
function logChat({ session, phone, text, extracted, masuk, hasil }) {
  const pesan = String(text || '').replace(/\s+/g, ' ').trim() || '(tanpa teks)';
  const head = `[CHAT] ${label(session)} | ${phone} | "${pesan}"`;

  if (masuk && extracted) {
    const detail = [
      `nama=${extracted.nama || '-'}`,
      `kebutuhan=${extracted.kebutuhan || '-'}`,
      `budget=${extracted.budget || '-'}`,
      `referensi=${extracted.referensiLaptop || '-'}`,
    ].join(' ');
    console.log(`${head} | ✅ MASUK LEADS (${hasil}) | ${detail}`);
  } else {
    console.log(`${head} | ⛔ TIDAK MASUK LEADS | ${hasil}`);
  }
}

// Terjemahkan action dari upsertLead ke bahasa yang mudah dibaca.
function actionLabel(action) {
  const a = String(action || '').toLowerCase();
  if (/creat|baru|new|insert|add/.test(a)) return 'lead BARU dibuat';
  if (/updat|merge|perbarui|exist/.test(a)) return 'lead lama DIPERBARUI';
  return action ? String(action) : 'tersimpan';
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

    // Belajar pasangan lid -> nomor dari event WhatsApp (best-effort).
    if (!session.lidMap) session.lidMap = new Map();
    try {
      sock.ev.on('lid-mapping.update', (u) => {
        for (const m of [].concat(u || [])) rememberLid(session, m?.lid, m?.pn);
      });
      const onContacts = (contacts) => {
        for (const c of contacts || []) {
          if (String(c?.id || '').endsWith('@lid')) rememberLid(session, c.id, c.phoneNumber);
          else if (c?.lid) rememberLid(session, c.lid, c.id);
        }
      };
      sock.ev.on('contacts.upsert', onContacts);
      sock.ev.on('contacts.update', onContacts);
    } catch (err) {
      logError('WA', 'Gagal memasang listener lid-mapping', err);
    }

    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr) {
        try {
          session.qr = await QRCode.toDataURL(qr);
        } catch (e) {
          logError('WA', 'Gagal membuat QR', e, label(session));
        }
      }
      if (connection === 'open') {
        session.connected = true;
        session.qr = null;
        session.hasEverConnected = true;
        session.phone = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      }
      if (connection === 'close') {
        session.connected = false;
        session.qr = null;
        const code = lastDisconnect?.error?.output?.statusCode;

        if (!session.enabled || code === DisconnectReason.loggedOut) {
          return; // sesi memang dimatikan / logout -- jangan reconnect
        }

        // Sesi yang SUDAH PERNAH terhubung tetap direconnect otomatis
        // seperti biasa -- wajar dipulihkan kalau cuma putus jaringan.
        if (session.hasEverConnected) {
          setTimeout(() => startSocket(session, folder).catch(err => logError('WA', 'Reconnect gagal', err, label(session))), 3000);
          return;
        }

        // Sesi BELUM PERNAH terhubung -- hanya lanjut buat QR baru kalau
        // masih ada yang aktif minta/lihat QR dalam QR_IDLE_TIMEOUT_MS
        // terakhir. Kalau tidak, berhenti sampai sales buka lagi
        // halamannya / tekan tombol "Tampilkan QR".
        const idleFor = Date.now() - (session.lastRequestedAt || 0);
        if (idleFor < QR_IDLE_TIMEOUT_MS) {
          setTimeout(() => startSocket(session, folder).catch(err => logError('WA', 'Reconnect gagal', err, label(session))), 3000);
        } else {
          session.socket = null;
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleIncoming(session, msg); }
        catch (err) {
          logError('MSG', 'Gagal memproses chat masuk', err, `${label(session)} | jid=${msg?.key?.remoteJid || '-'} | "${String(getMessageText(msg)).replace(/\s+/g, ' ')}"`);
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

// ------------------------------------------------------------
// RESOLVE @lid -> NOMOR WA ASLI
// WhatsApp kadang mengirim chat dari "ID tersembunyi" (@lid), bukan nomor.
// Nomor asli dicari dari beberapa sumber, berurutan:
//  1) field bawaan di key pesan (Baileys v7: remoteJidAlt, Baileys 6.x: senderPn/participantPn)
//  2) cache pasangan lid -> nomor yang dipelajari dari event (lid-mapping.update, contacts)
//  3) lidMapping bawaan Baileys (getPNForLID, hanya ada di Baileys v7)
// Kalau semua gagal, WhatsApp memang belum/tidak mengirim nomornya.
// ------------------------------------------------------------
function jidUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function phoneFromJid(jid) {
  const j = String(jid || '');
  if (!j) return null;
  if (j.includes('@') && !j.endsWith('@s.whatsapp.net')) return null;
  const digits = jidUser(j).replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

function rememberLid(session, lidJid, pnJid) {
  try {
    const phone = phoneFromJid(pnJid);
    const lidKey = jidUser(lidJid);
    if (!session.lidMap) session.lidMap = new Map();
    if (phone && lidKey && String(lidJid).includes('@lid')) session.lidMap.set(lidKey, phone);
  } catch { /* abaikan */ }
}

async function resolvePhoneFromLid(session, msg, lidJid) {
  const key = msg?.key || {};

  // 1) Field bawaan di pesan
  for (const candidate of [key.remoteJidAlt, key.senderPn, key.participantPn, key.participantAlt, msg?.senderPn]) {
    const p = phoneFromJid(candidate);
    if (p) {
      rememberLid(session, lidJid, candidate);
      return p;
    }
  }

  // 2) Cache dari event sebelumnya
  const cached = session.lidMap?.get(jidUser(lidJid));
  if (cached) return cached;

  // 3) Mapping bawaan Baileys v7
  try {
    const mapping = session.socket?.signalRepository?.lidMapping;
    const resolved =
      (await mapping?.getPNForLID?.(lidJid)) ||
      (await mapping?.getPNForLid?.(lidJid)) ||
      null;
    const p = phoneFromJid(resolved) || (resolved ? String(resolved).replace(/\D/g, '') : null);
    if (p) {
      rememberLid(session, lidJid, `${p}@s.whatsapp.net`);
      return p;
    }
  } catch (err) {
    logError('MSG', 'Gagal resolve @lid ke nomor asli', err, lidJid);
  }
  return null;
}

async function handleIncoming(session, msg) {
  if (!msg?.key || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid || '';
  // Abaikan grup, status, broadcast, dan channel.
  if (
    remoteJid.endsWith('@g.us') ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@newsletter')
  ) return;

  const pushName = msg.pushName || '';
  const text = getMessageText(msg).trim();

  let phone = null;
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    phone = remoteJid.split('@')[0].replace(/\D/g, '');
    if (String(msg.key.remoteJidAlt || '').endsWith('@lid')) {
      rememberLid(session, msg.key.remoteJidAlt, remoteJid);
    }
  } else if (remoteJid.endsWith('@lid')) {
    phone = await resolvePhoneFromLid(session, msg, remoteJid);
    if (!phone) {
      // Chat pelanggan asli yang tidak bisa diproses -- tetap dicatat,
      // lengkap dengan isi key pesan untuk bantu diagnosa.
      logChat({
        session,
        phone: remoteJid,
        text,
        masuk: false,
        hasil: `alasan=nomor asli tidak dikirim WhatsApp (ID @lid) | key=${JSON.stringify(msg.key)}`,
      });
      return;
    }
  } else {
    return;
  }

  if (!phone || phone === session.phone) return;

  const messageKey = msg.key.id;
  if (messageKey && !(await recordMessageOnce(session.sales.salesId, messageKey))) return; // duplikat

  if (!text) return; // media tanpa teks

  const { lead: extracted, skipReason } = await extractLead({ text, pushName, phone });

  if (!extracted) {
    logChat({
      session,
      phone,
      text,
      masuk: false,
      hasil: `alasan=${skipReason || 'chat tidak dikenali sebagai calon pembeli'}`,
    });
    return;
  }

  const result = await upsertLead({ sales: session.sales, extracted });
  logChat({
    session,
    phone,
    text,
    extracted,
    masuk: true,
    hasil: actionLabel(result.action),
  });
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
