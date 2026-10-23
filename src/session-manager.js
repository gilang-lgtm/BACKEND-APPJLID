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

// ============================================================
// LOG CHAT DETAIL
// Satu blok log per chat masuk, berisi: waktu, sales/cabang,
// pengirim, ISI PESAN, kategori hasil ekstraksi, metode yang dipakai,
// dan hasil akhirnya (MASUK LEADS atau TIDAK + alasannya).
//
// Contoh keluaran:
// ┌── CHAT MASUK ── 22/10/2026 14.03.11
// │ Sales    : Budi / Bekasi
// │ Pengirim : 6281234567890 (Rina)
// │ Pesan    : halo kak, ada laptop asus buat kuliah budget 5jt?
// │ Kategori : Nama: Rina | Kebutuhan: Kuliah | Budget: 5 Jutaan | Referensi: Asus
// │ Metode   : AI Gemini
// │ Hasil    : ✅ MASUK LEADS — lead BARU dibuat (id=abc123)
// └────────────────────────────────────────
//
// Pesan yang tidak relevan (grup, status, pesan keluar, duplikat, dll)
// dicatat satu baris saja supaya log tidak penuh.
// ============================================================
const LOG_PAD = '│' + ' '.repeat(12); // rata dengan "│ Pesan    : "

function nowWib() {
  return new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function indentBlock(text) {
  return String(text).split(/\r?\n/).join('\n' + LOG_PAD);
}

function logChat(e) {
  const sender = e.sender || '-';

  // Mode ringkas: satu baris untuk pesan yang memang tidak diproses.
  if (e.compact) {
    const teks = e.text ? `"${String(e.text).replace(/\s+/g, ' ')}"` : '(tanpa teks)';
    console.log(`[CHAT] ⛔ SKIP (${e.kategori}) | ${label(e.session)} | ${sender} | ${teks}`);
    return;
  }

  const verdict = e.masuk
    ? `✅ MASUK LEADS${e.hasil ? ` — ${e.hasil}` : ''}`
    : `⛔ TIDAK MASUK LEADS${e.hasil ? ` — ${e.hasil}` : ''}`;

  const lines = [
    `┌── CHAT MASUK ── ${nowWib()}`,
    `│ Sales    : ${e.session.sales.salesName} / ${e.session.sales.branch}`,
    `│ Pengirim : ${sender}${e.pushName ? ` (${e.pushName})` : ''}`,
    `│ Pesan    : ${e.text ? indentBlock(e.text) : '(tanpa teks)'}`,
    `│ Kategori : ${e.kategori}`,
  ];
  if (e.method) lines.push(`│ Metode   : ${e.method}`);
  if (e.deteksi) lines.push(`│ Deteksi  : ${indentBlock(e.deteksi)}`);
  if (e.fallbackReason) lines.push(`│ Catatan  : Gemini gagal (${e.fallbackReason}), memakai fallback kata kunci`);
  lines.push(`│ Hasil    : ${verdict}`);
  lines.push('└' + '─'.repeat(40));
  console.log(lines.join('\n'));
}

// Ringkasan kategori dari hasil ekstraksi lead.
function kategoriLead(ex) {
  return [
    `Nama: ${ex.nama || '-'}`,
    `Kebutuhan: ${ex.kebutuhan || '-'}`,
    `Budget: ${ex.budget || '-'}`,
    `Referensi: ${ex.referensiLaptop || '-'}`,
  ].join(' | ');
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

// WhatsApp "Linked ID" (@lid): format JID baru untuk kontak yang belum
// tersimpan di address book pengirim (atau akun bisnis). Angka di depan
// "@lid" BUKAN nomor telepon asli -- harus di-resolve dulu lewat mapping
// internal Baileys. Nama API persis berbeda-beda antar versi Baileys
// (fitur ini masih terus berubah di WhatsApp/Baileys), jadi dicoba
// beberapa kemungkinan secara defensif. Kalau semua gagal, fungsi ini
// mengembalikan null dan pesan akan di-skip dengan log yang jelas.
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

  const remoteJid = msg.key.remoteJid || '';
  const pushName = msg.pushName || '';
  // Teks diambil di awal supaya SEMUA jenis log (termasuk yang di-skip)
  // bisa menampilkan isi pesannya.
  const text = getMessageText(msg).trim();
  const base = { session, pushName, text, sender: remoteJid };

  if (msg.key.fromMe) {
    logChat({ ...base, compact: true, kategori: 'Pesan keluar dari akun toko' });
    return;
  }
  if (remoteJid.endsWith('@g.us')) {
    logChat({ ...base, compact: true, kategori: 'Grup WhatsApp' });
    return;
  }
  if (remoteJid.endsWith('@broadcast') || remoteJid === 'status@broadcast') {
    logChat({ ...base, compact: true, kategori: 'Status / Broadcast' });
    return;
  }
  if (remoteJid.endsWith('@newsletter')) {
    logChat({ ...base, compact: true, kategori: 'Channel / Newsletter' });
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
      // Ini chat pelanggan sungguhan yang TIDAK bisa diproses -- dicatat
      // dalam blok lengkap supaya jelas pesan apa yang terlewat.
      logChat({
        ...base,
        kategori: 'Nomor tidak dikenali (format @lid)',
        masuk: false,
        hasil: 'Alasan: ID WhatsApp tidak bisa diubah ke nomor telepon asli',
      });
      return;
    }
  } else {
    logChat({ ...base, compact: true, kategori: 'Format JID tidak dikenali' });
    return;
  }

  if (!phone) {
    logChat({ ...base, compact: true, kategori: 'Nomor kosong setelah parsing' });
    return;
  }
  base.sender = phone;

  if (phone === session.phone) {
    logChat({ ...base, compact: true, kategori: 'Nomor sama dengan nomor toko sendiri' });
    return;
  }
  const messageKey = msg.key.id;
  if (messageKey && !(await recordMessageOnce(session.sales.salesId, messageKey))) {
    logChat({ ...base, compact: true, kategori: `Duplikat, sudah pernah diproses (id=${messageKey})` });
    return;
  }

  if (!text) {
    logChat({
      ...base,
      kategori: 'Media tanpa teks (gambar / voice note / stiker, dll)',
      masuk: false,
      hasil: 'Alasan: tidak ada teks atau caption untuk dianalisis',
    });
    return;
  }

  const { lead: extracted, method, fallbackReason, skipReason, detail } = await extractLead({ text, pushName, phone });
  const methodLabel = method === 'gemini'
    ? 'AI Gemini'
    : (fallbackReason ? 'Aturan kata kunci (fallback)' : 'Aturan kata kunci (manual)');

  if (!extracted) {
    logChat({
      ...base,
      kategori: 'Bukan lead',
      method: methodLabel,
      fallbackReason,
      masuk: false,
      hasil: `Alasan: ${skipReason || 'chat tidak dikenali sebagai calon pembeli'}`,
    });
    return;
  }

  const result = await upsertLead({ sales: session.sales, extracted });
  logChat({
    ...base,
    kategori: kategoriLead(extracted),
    method: methodLabel,
    deteksi: detail,
    fallbackReason,
    masuk: true,
    hasil: `${actionLabel(result.action)} (id=${result.id})`,
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
        hasEverConnected: false,
        lastRequestedAt: Date.now(),
      };
      sessions.set(item.salesId, s);
      await startSocket(s, safeFolder(item.salesId));
    }
  } catch (err) { logError('WA', 'Gagal memulihkan sesi', err); }
  finally { restoring = false; }
}
