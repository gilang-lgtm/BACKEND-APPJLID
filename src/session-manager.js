
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { config } from './config.js';
import { extractLead } from './extractor.js';
import {
  recordMessageOnce,
  upsertLead,
} from './firestore-leads.js';

// ============================================================
// CONFIGURATION
// ============================================================

// Logger khusus Baileys.
// Menekan log internal library, termasuk spam Bad MAC.
// Log aplikasi tetap menggunakan console di bawah.
const baileysLogger = pino({
  level: 'silent',
});

// Pengaturan reconnect dan QR.
const RECONNECT_DELAY_MS = Math.max(
  3000,
  Number(process.env.WA_RECONNECT_DELAY_MS || 5000)
);

const QR_IDLE_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.QR_IDLE_TIMEOUT_MS || 90000)
);

const MAX_CHAT_LOG_LENGTH = 2000;

// ============================================================
// GLOBAL STATE
// ============================================================

const sessions = new Map();

const metadataPath = path.join(
  config.dataDir,
  'sales-sessions.json'
);

let restoring = false;
let metadataQueue = Promise.resolve();

fs.mkdirSync(config.sessionsDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

// ============================================================
// APPLICATION LOGGER
// ============================================================

function logInfo(tag, message, detail = '') {
  console.log(
    `[${tag}] ${message}${detail ? ` | ${detail}` : ''}`
  );
}

function logWarn(tag, message, detail = '') {
  console.warn(
    `[${tag}] ${message}${detail ? ` | ${detail}` : ''}`
  );
}

function safeError(err) {
  return String(err?.message || err || 'Unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function logError(tag, message, err, detail = '') {
  console.error(
    `[${tag}] ${message}: ${safeError(err)}` +
    `${detail ? ` | ${detail}` : ''}`
  );
}

function label(session) {
  return `${session.sales.salesName}/${session.sales.branch}`;
}

// ============================================================
// CHAT LOGGER
// ============================================================

function cleanChatText(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_CHAT_LOG_LENGTH);
}

function actionLabel(action) {
  const value = String(action || '').toLowerCase();

  if (/creat|baru|new|insert|add/.test(value)) {
    return 'lead BARU dibuat';
  }

  if (/updat|merge|perbarui|exist/.test(value)) {
    return 'lead lama DIPERBARUI';
  }

  return action || 'tersimpan';
}

function logChat({
  session,
  phone,
  text,
  extracted = null,
  masuk = false,
  hasil = '',
}) {
  const message = cleanChatText(text) || '(tanpa teks)';

  const head =
    `[CHAT] ${label(session)} | ${phone} | "${message}"`;

  if (masuk && extracted) {
    const detail = [
      `nama=${extracted.nama || '-'}`,
      `kebutuhan=${extracted.kebutuhan || '-'}`,
      `budget=${extracted.budget || '-'}`,
      `referensi=${extracted.referensiLaptop || '-'}`,
    ].join(' ');

    logInfo(
      'CHAT',
      `${head} | MASUK LEADS (${hasil})`,
      detail
    );

    return;
  }

  logInfo(
    'CHAT',
    `${head} | TIDAK MASUK LEADS`,
    `alasan=${hasil || 'Tidak memenuhi kriteria lead'}`
  );
}

// ============================================================
// SESSION UTILITIES
// ============================================================

function safeFolder(salesId) {
  const id = String(salesId || '');

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('salesId tidak valid');
  }

  return path.join(config.sessionsDir, id);
}

function createSession(sales) {
  return {
    sales,

    connected: false,
    qr: null,
    phone: null,

    enabled: true,
    starting: false,

    socket: null,
    socketGeneration: 0,

    reconnectTimer: null,
    qrIdleTimer: null,

    hasEverConnected: false,
    lastRequestedAt: Date.now(),
  };
}

function statusOf(session) {
  return {
    salesId: session.sales.salesId,
    salesName: session.sales.salesName,
    branch: session.sales.branch,
    connected: Boolean(session.connected),
    hasQr: Boolean(session.qr),
    phone: session.phone || null,
    enabled: session.enabled !== false,
  };
}

function isCurrentSocket(session, socket, generation) {
  return (
    session.socket === socket &&
    session.socketGeneration === generation
  );
}

function clearReconnectTimer(session) {
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function clearQrTimer(session) {
  if (session.qrIdleTimer) {
    clearTimeout(session.qrIdleTimer);
    session.qrIdleTimer = null;
  }
}

function clearTimers(session) {
  clearReconnectTimer(session);
  clearQrTimer(session);
}

// ============================================================
// SAFE METADATA STORAGE
// ============================================================

function writeMetadata() {
  const data = [...sessions.values()].map(session => ({
    salesId: session.sales.salesId,
    salesName: session.sales.salesName,
    branch: session.sales.branch,
    enabled: session.enabled !== false,
  }));

  const tempPath = `${metadataPath}.tmp`;

  fs.writeFileSync(
    tempPath,
    JSON.stringify(data, null, 2),
    {
      encoding: 'utf8',
      mode: 0o600,
    }
  );

  fs.renameSync(tempPath, metadataPath);
}

function saveMetadata() {
  metadataQueue = metadataQueue
    .then(() => writeMetadata())
    .catch(err => {
      logError('META', 'Gagal menyimpan metadata sesi', err);
    });

  return metadataQueue;
}

// ============================================================
// PUBLIC SESSION FUNCTIONS
// ============================================================

export function listSessions() {
  return [...sessions.values()].map(statusOf);
}

export function getSession(salesId) {
  const session = sessions.get(String(salesId));

  return session ? statusOf(session) : null;
}

export function getQr(salesId) {
  const session = sessions.get(String(salesId));

  if (!session || !session.enabled) {
    return null;
  }

  return session.qr || null;
}

// ============================================================
// CONNECT SALES
// ============================================================

export async function connectSales({
  salesId,
  salesName,
  branch,
}) {
  const id = String(salesId || '');
  const folder = safeFolder(id);

  if (!salesName?.trim() || !branch?.trim()) {
    throw new Error('salesName dan branch wajib diisi');
  }

  const sales = {
    salesId: id,
    salesName: salesName.trim(),
    branch: branch.trim(),
  };

  let session = sessions.get(id);

  if (session) {
    session.sales = sales;
    session.enabled = true;
    session.lastRequestedAt = Date.now();

    if (
      session.connected ||
      session.starting ||
      session.socket
    ) {
      await saveMetadata();
      return statusOf(session);
    }
  } else {
    session = createSession(sales);
    sessions.set(id, session);
  }

  session.enabled = true;
  session.lastRequestedAt = Date.now();

  await saveMetadata();

  await startSocket(session, folder);

  return statusOf(session);
}

// ============================================================
// START WHATSAPP SOCKET
// ============================================================

async function startSocket(session, folder) {
  if (
    !session.enabled ||
    session.starting ||
    session.connected ||
    session.socket
  ) {
    return;
  }

  clearReconnectTimer(session);
  clearQrTimer(session);

  session.starting = true;

  const generation = ++session.socketGeneration;

  let sock = null;

  try {
    fs.mkdirSync(folder, { recursive: true });

    const {
      state,
      saveCreds,
    } = await useMultiFileAuthState(folder);

    if (!session.enabled) return;

    if (state.creds?.registered) {
      session.hasEverConnected = true;
    }

    sock = makeWASocket({
      auth: state,

      // Penting: logger Baileys silent untuk mencegah
      // error internal Bad MAC membanjiri log hosting.
      logger: baileysLogger,

      printQRInTerminal: false,

      browser: [
        'Erra Auto Lead',
        'Chrome',
        '1.0.0',
      ],

      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    session.socket = sock;

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        logError(
          'WA',
          'Gagal menyimpan kredensial',
          err,
          label(session)
        );
      }
    });

    registerConnectionListener(
      session,
      sock,
      folder,
      generation
    );

    registerMessageListener(
      session,
      sock,
      generation
    );

    logInfo(
      'WA',
      'Socket WhatsApp dimulai',
      label(session)
    );

  } catch (err) {
    if (!sock || session.socket === sock) {
      session.socket = null;
      session.connected = false;
      session.qr = null;
    }

    logError(
      'WA',
      'Gagal memulai socket WhatsApp',
      err,
      label(session)
    );

    scheduleReconnect(session, folder);

  } finally {
    session.starting = false;
  }
}

// ============================================================
// CONNECTION UPDATE
// ============================================================

function registerConnectionListener(
  session,
  sock,
  folder,
  generation
) {
  sock.ev.on(
    'connection.update',
    async update => {
      if (!isCurrentSocket(session, sock, generation)) {
        return;
      }

      const {
        connection,
        qr,
        lastDisconnect,
      } = update;

      // QR CREATED
      if (qr) {
        try {
          const qrData = await QRCode.toDataURL(qr);

          if (
            !isCurrentSocket(session, sock, generation) ||
            !session.enabled
          ) {
            return;
          }

          session.qr = qrData;

          logInfo(
            'WA',
            'QR berhasil dibuat',
            label(session)
          );

          scheduleQrIdle(session, folder);

        } catch (err) {
          logError(
            'WA',
            'Gagal membuat QR',
            err,
            label(session)
          );
        }
      }

      // CONNECTED
      if (connection === 'open') {
        clearQrTimer(session);
        clearReconnectTimer(session);

        session.connected = true;
        session.qr = null;
        session.hasEverConnected = true;

        session.phone =
          sock.user?.id
            ?.split(':')[0]
            ?.split('@')[0] || null;

        logInfo(
          'WA',
          'WhatsApp berhasil terhubung',
          label(session)
        );

        await saveMetadata();
        return;
      }

      // DISCONNECTED
      if (connection === 'close') {
        session.connected = false;
        session.qr = null;

        const code =
          lastDisconnect?.error?.output?.statusCode;

        logWarn(
          'WA',
          'Koneksi WhatsApp terputus',
          `${label(session)} | code=${code ?? 'unknown'}`
        );

        if (!session.enabled) {
          session.socket = null;
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          session.socket = null;
          session.enabled = false;
          session.phone = null;

          clearTimers(session);

          logWarn(
            'WA',
            'WhatsApp logout, pairing ulang diperlukan',
            label(session)
          );

          await saveMetadata();
          return;
        }

        if (session.socket === sock) {
          session.socket = null;
        }

        if (session.hasEverConnected) {
          scheduleReconnect(session, folder);
          return;
        }

        const idleFor =
          Date.now() - (session.lastRequestedAt || 0);

        if (idleFor < QR_IDLE_TIMEOUT_MS) {
          scheduleReconnect(session, folder);
        } else {
          logInfo(
            'WA',
            'QR dihentikan karena tidak aktif',
            label(session)
          );
        }
      }
    }
  );
}

// ============================================================
// RECONNECT WITH SINGLE TIMER
// ============================================================

function scheduleReconnect(session, folder) {
  if (
    !session.enabled ||
    session.connected ||
    session.starting ||
    session.reconnectTimer
  ) {
    return;
  }

  if (
    !session.hasEverConnected &&
    Date.now() - (session.lastRequestedAt || 0) >=
      QR_IDLE_TIMEOUT_MS
  ) {
    return;
  }

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;

    if (
      !session.enabled ||
      session.connected ||
      session.socket ||
      session.starting
    ) {
      return;
    }

    startSocket(session, folder).catch(err => {
      logError(
        'WA',
        'Reconnect gagal',
        err,
        label(session)
      );
    });

  }, RECONNECT_DELAY_MS);

  session.reconnectTimer.unref?.();
}

// ============================================================
// QR IDLE TIMEOUT
// ============================================================

function scheduleQrIdle(session, folder) {
  clearQrTimer(session);

  if (
    !session.enabled ||
    session.connected ||
    session.hasEverConnected
  ) {
    return;
  }

  const remaining =
    QR_IDLE_TIMEOUT_MS -
    (Date.now() - (session.lastRequestedAt || 0));

  if (remaining <= 0) {
    stopIdleQr(session);
    return;
  }

  session.qrIdleTimer = setTimeout(() => {
    session.qrIdleTimer = null;

    if (
      !session.enabled ||
      session.connected ||
      session.hasEverConnected
    ) {
      return;
    }

    const idleFor =
      Date.now() - (session.lastRequestedAt || 0);

    if (idleFor >= QR_IDLE_TIMEOUT_MS) {
      stopIdleQr(session);
    } else {
      scheduleQrIdle(session, folder);
    }

  }, remaining);

  session.qrIdleTimer.unref?.();
}

function stopIdleQr(session) {
  if (
    !session.enabled ||
    session.connected ||
    session.hasEverConnected
  ) {
    return;
  }

  clearTimers(session);

  const sock = session.socket;

  session.socket = null;
  session.connected = false;
  session.qr = null;

  // Invalidasi event dari socket lama.
  session.socketGeneration++;

  try {
    sock?.end(undefined);
  } catch (err) {
    logError(
      'WA',
      'Gagal menghentikan QR idle',
      err,
      label(session)
    );
  }

  logInfo(
    'WA',
    'Sesi QR dihentikan karena idle',
    label(session)
  );
}

// ============================================================
// MESSAGE TEXT EXTRACTOR
// ============================================================

function getMessageText(msg) {
  const m = msg?.message || {};

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

// ============================================================
// MESSAGE LISTENER
// ============================================================

function registerMessageListener(
  session,
  sock,
  generation
) {
  sock.ev.on(
    'messages.upsert',
    async ({ messages, type }) => {
      if (type !== 'notify') return;

      if (!isCurrentSocket(session, sock, generation)) {
        return;
      }

      for (const msg of messages || []) {
        try {
          if (!isCurrentSocket(session, sock, generation)) {
            break;
          }

          await handleIncoming(session, msg);

        } catch (err) {
          logError(
            'MSG',
            'Gagal memproses chat masuk',
            err,
            label(session)
          );
        }
      }
    }
  );
}

// ============================================================
// HANDLE INCOMING CHAT
// ============================================================

async function handleIncoming(session, msg) {
  if (!msg?.key || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid || '';

  // Abaikan grup, status, broadcast, dan channel.
  if (
    remoteJid.endsWith('@g.us') ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@newsletter')
  ) {
    return;
  }

  // Versi file saat ini hanya memproses chat pribadi
  // yang JID-nya berupa nomor WhatsApp.
  if (!remoteJid.endsWith('@s.whatsapp.net')) {
    return;
  }

  const phone = remoteJid
    .split('@')[0]
    .replace(/\D/g, '');

  if (!phone || phone === session.phone) {
    return;
  }

  const text = String(getMessageText(msg)).trim();

  // Deduplikasi pesan agar tidak tercatat dua kali.
  const messageKey = msg.key.id;

  if (!messageKey) {
    logWarn(
      'MSG',
      'Pesan dilewati karena tidak memiliki ID',
      label(session)
    );

    return;
  }

  const isNewMessage = await recordMessageOnce(
    session.sales.salesId,
    messageKey
  );

  if (!isNewMessage) return;

  // Media tanpa caption.
  if (!text) {
    return;
  }

  // Ekstraksi calon lead.
  const extracted = extractLead({
    text,
    pushName: msg.pushName || '',
    phone,
  });

  if (!extracted) {
    logChat({
      session,
      phone,
      text,
      masuk: false,
      hasil: 'Chat tidak dikenali sebagai calon pembeli',
    });

    return;
  }

  // Simpan atau perbarui lead.
  const result = await upsertLead({
    sales: session.sales,
    extracted,
  });

  logChat({
    session,
    phone,
    text,
    extracted,
    masuk: true,
    hasil: actionLabel(result?.action),
  });
}

// ============================================================
// DISCONNECT / LOGOUT
// ============================================================

export async function disconnectSales(
  salesId,
  logout = false
) {
  const id = String(salesId || '');
  const session = sessions.get(id);

  if (!session) {
    throw new Error('Sesi sales tidak ditemukan');
  }

  clearTimers(session);

  session.enabled = false;
  session.connected = false;
  session.qr = null;

  const sock = session.socket;

  // Cegah event dari socket lama memengaruhi sesi.
  session.socketGeneration++;
  session.socket = null;

  try {
    if (logout) {
      if (sock) {
        await sock.logout();
      }
    } else {
      sock?.end(undefined);
    }
  } catch (err) {
    logError(
      'WA',
      'Gagal menutup sesi',
      err,
      label(session)
    );
  }

  if (logout) {
    try {
      fs.rmSync(
        safeFolder(id),
        {
          recursive: true,
          force: true,
        }
      );
    } catch (err) {
      logError(
        'WA',
        'Gagal menghapus folder autentikasi',
        err,
        label(session)
      );
    }

    sessions.delete(id);

    logInfo(
      'WA',
      'WhatsApp berhasil logout',
      label(session)
    );

  } else {
    logInfo(
      'WA',
      'WhatsApp berhasil disconnect',
      label(session)
    );
  }

  await saveMetadata();

  return {
    salesId: id,
    disconnected: true,
    loggedOut: Boolean(logout),
  };
}

// ============================================================
// RESTORE SESSIONS
// ============================================================

export async function restoreSessions() {
  if (restoring) {
    logWarn(
      'RESTORE',
      'Proses restore sedang berjalan'
    );

    return;
  }

  restoring = true;

  try {
    if (!fs.existsSync(metadataPath)) {
      logInfo(
        'RESTORE',
        'Metadata sesi belum tersedia'
      );

      return;
    }

    let entries;

    try {
      entries = JSON.parse(
        fs.readFileSync(metadataPath, 'utf8')
      );
    } catch (err) {
      logError(
        'RESTORE',
        'Metadata sesi tidak valid',
        err
      );

      return;
    }

    if (!Array.isArray(entries)) {
      logWarn(
        'RESTORE',
        'Format metadata bukan array'
      );

      return;
    }

    logInfo(
      'RESTORE',
      `Memulai pemulihan ${entries.length} sesi`
    );

    for (const item of entries) {
      try {
        if (!item || item.enabled === false) {
          continue;
        }

        const salesId = String(item.salesId || '');

        if (
          !salesId ||
          !item.salesName?.trim() ||
          !item.branch?.trim()
        ) {
          continue;
        }

        const folder = safeFolder(salesId);

        if (!fs.existsSync(folder)) {
          logWarn(
            'RESTORE',
            'Folder autentikasi tidak ditemukan',
            salesId
          );

          continue;
        }

        const existing = sessions.get(salesId);

        if (
          existing?.socket ||
          existing?.starting
        ) {
          continue;
        }

        const session = createSession({
          salesId,
          salesName: item.salesName.trim(),
          branch: item.branch.trim(),
        });

        session.hasEverConnected = false;
        session.lastRequestedAt = Date.now();

        sessions.set(salesId, session);

        await startSocket(session, folder);

        logInfo(
          'RESTORE',
          'Sesi dipulihkan',
          `${salesId} | ${label(session)}`
        );

      } catch (err) {
        logError(
          'RESTORE',
          'Gagal memulihkan satu sesi',
          err,
          String(item?.salesId || 'unknown')
        );
      }
    }

    logInfo(
      'RESTORE',
      'Proses pemulihan selesai'
    );

  } catch (err) {
    logError(
      'RESTORE',
      'Terjadi kesalahan pemulihan',
      err
    );

  } finally {
    restoring = false;
  }
}
