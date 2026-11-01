
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
// KONFIGURASI
// ============================================================

const baileysLogger = pino({ level: 'silent' });

const QR_IDLE_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.QR_IDLE_TIMEOUT_MS || 90000)
);

const RECONNECT_DELAY_MS = Math.max(
  1000,
  Number(process.env.WA_RECONNECT_DELAY_MS || 3000)
);

const MAX_CHAT_LOG_LENGTH = 2000;

const sessions = new Map();

const metadataPath = path.join(
  config.dataDir,
  'sales-sessions.json'
);

let restoring = false;
let metadataWriteQueue = Promise.resolve();

fs.mkdirSync(config.sessionsDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

// ============================================================
// LOGGER
// ============================================================

function safeError(err) {
  return String(err?.message || err || 'Unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

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

function logError(tag, message, err, detail = '') {
  console.error(
    `[${tag}] ${message}: ${safeError(err)}` +
    `${detail ? ` | ${detail}` : ''}`
  );
}

function label(session) {
  return `${session.sales.salesName}/${session.sales.branch}`;
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

// ============================================================
// LOG CHAT MASUK
// ============================================================

function cleanChatText(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_CHAT_LOG_LENGTH);
}

function logChat({
  session,
  phone,
  text,
  extracted = null,
  masuk = false,
  hasil = '',
}) {
  const pesan = cleanChatText(text) || '(tanpa teks)';

  const head =
    `[CHAT] ${label(session)} | ${phone || '-'} | "${pesan}"`;

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
// UTILITAS SESI
// ============================================================

function safeFolder(salesId) {
  const id = String(salesId || '');

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('salesId tidak valid');
  }

  return path.join(config.sessionsDir, id);
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
    starting: Boolean(session.starting),
  };
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

    lidMap: new Map(),
  };
}

function clearReconnectTimer(session) {
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function clearQrIdleTimer(session) {
  if (session.qrIdleTimer) {
    clearTimeout(session.qrIdleTimer);
    session.qrIdleTimer = null;
  }
}

function clearSessionTimers(session) {
  clearReconnectTimer(session);
  clearQrIdleTimer(session);
}

function isCurrentSocket(session, socket, generation) {
  return (
    session.socket === socket &&
    session.socketGeneration === generation
  );
}

// ============================================================
// METADATA
// ============================================================

function writeMetadataAtomic() {
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
  metadataWriteQueue = metadataWriteQueue
    .then(() => writeMetadataAtomic())
    .catch(err => {
      logError('META', 'Gagal menyimpan metadata', err);
    });

  return metadataWriteQueue;
}

// ============================================================
// PUBLIC SESSION API
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

export function touchSession(salesId) {
  const session = sessions.get(String(salesId));

  if (session && session.enabled) {
    session.lastRequestedAt = Date.now();
  }
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
// START SOCKET
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
  clearQrIdleTimer(session);

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

    registerLidListeners(session, sock);

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
      'Gagal memulai socket',
      err,
      label(session)
    );

    scheduleReconnect(session, folder);

  } finally {
    session.starting = false;
  }
}

// ============================================================
// CONNECTION LISTENER
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

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);

          if (
            !isCurrentSocket(session, sock, generation) ||
            !session.enabled
          ) {
            return;
          }

          session.qr = dataUrl;

          logInfo(
            'WA',
            'QR WhatsApp berhasil dibuat',
            label(session)
          );

          scheduleQrIdleCheck(session, folder);

        } catch (err) {
          logError(
            'WA',
            'Gagal membuat QR',
            err,
            label(session)
          );
        }
      }

      if (connection === 'open') {
        clearQrIdleTimer(session);
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

          clearSessionTimers(session);

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
            'QR dihentikan karena idle',
            label(session)
          );
        }
      }
    }
  );
}

// ============================================================
// RECONNECT
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
// QR IDLE
// ============================================================

function scheduleQrIdleCheck(session, folder) {
  clearQrIdleTimer(session);

  if (
    session.hasEverConnected ||
    !session.enabled
  ) {
    return;
  }

  const remaining =
    QR_IDLE_TIMEOUT_MS -
    (Date.now() - (session.lastRequestedAt || 0));

  if (remaining <= 0) {
    stopIdleQrSession(session);
    return;
  }

  session.qrIdleTimer = setTimeout(() => {
    session.qrIdleTimer = null;

    if (
      session.connected ||
      session.hasEverConnected ||
      !session.enabled
    ) {
      return;
    }

    const idleFor =
      Date.now() - (session.lastRequestedAt || 0);

    if (idleFor >= QR_IDLE_TIMEOUT_MS) {
      stopIdleQrSession(session);
    } else {
      scheduleQrIdleCheck(session, folder);
    }

  }, remaining);

  session.qrIdleTimer.unref?.();
}

function stopIdleQrSession(session) {
  if (
    session.hasEverConnected ||
    session.connected ||
    !session.enabled
  ) {
    return;
  }

  logInfo(
    'WA',
    'Menghentikan sesi QR idle',
    label(session)
  );

  clearSessionTimers(session);

  session.qr = null;

  const sock = session.socket;

  session.socket = null;
  session.connected = false;

  session.socketGeneration++;

  try {
    sock?.end(undefined);
  } catch (err) {
    logError(
      'WA',
      'Gagal menghentikan socket idle',
      err,
      label(session)
    );
  }
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

          // Isi pesan sengaja tidak ditambahkan ke log error.
          // Isi chat ditampilkan melalui logChat() jika berhasil
          // mencapai tahap pemrosesan pesan.
        }
      }
    }
  );
}

// ============================================================
// EXTRACT MESSAGE TEXT
// ============================================================

function getMessageText(msg) {
  const message = msg?.message || {};

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  );
}

// ============================================================
// RESOLVE JID / PHONE
// ============================================================

function jidUser(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0];
}

function phoneFromJid(jid) {
  const value = String(jid || '');

  if (!value) return null;

  if (
    value.includes('@') &&
    !value.endsWith('@s.whatsapp.net')
  ) {
    return null;
  }

  const digits = jidUser(value).replace(/\D/g, '');

  return digits.length >= 8 ? digits : null;
}

function rememberLid(session, lidJid, pnJid) {
  try {
    const phone = phoneFromJid(pnJid);
    const lidKey = jidUser(lidJid);

    if (!session.lidMap) {
      session.lidMap = new Map();
    }

    if (
      phone &&
      lidKey &&
      String(lidJid).includes('@lid')
    ) {
      session.lidMap.set(lidKey, phone);
    }
  } catch {
    // Mapping hanya bersifat best-effort.
  }
}

function registerLidListeners(session, sock) {
  if (!session.lidMap) {
    session.lidMap = new Map();
  }

  try {
    sock.ev.on('lid-mapping.update', update => {
      for (const item of [].concat(update || [])) {
        rememberLid(
          session,
          item?.lid,
          item?.pn
        );
      }
    });

    const onContacts = contacts => {
      for (const contact of contacts || []) {
        if (String(contact?.id || '').endsWith('@lid')) {
          rememberLid(
            session,
            contact.id,
            contact.phoneNumber
          );
        } else if (contact?.lid) {
          rememberLid(
            session,
            contact.lid,
            contact.id
          );
        }
      }
    };

    sock.ev.on('contacts.upsert', onContacts);
    sock.ev.on('contacts.update', onContacts);

  } catch (err) {
    logError(
      'WA',
      'Gagal memasang listener LID',
      err,
      label(session)
    );
  }
}

async function resolvePhoneFromLid(
  session,
  msg,
  lidJid
) {
  const key = msg?.key || {};

  const candidates = [
    key.remoteJidAlt,
    key.senderPn,
    key.participantPn,
    key.participantAlt,
    msg?.senderPn,
  ];

  for (const candidate of candidates) {
    const phone = phoneFromJid(candidate);

    if (phone) {
      rememberLid(session, lidJid, candidate);
      return phone;
    }
  }

  const cached = session.lidMap?.get(
    jidUser(lidJid)
  );

  if (cached) return cached;

  try {
    const mapping =
      session.socket?.signalRepository?.lidMapping;

    const resolved =
      (await mapping?.getPNForLID?.(lidJid)) ||
      (await mapping?.getPNForLid?.(lidJid)) ||
      null;

    const phone =
      phoneFromJid(resolved) ||
      (
        resolved
          ? String(resolved).replace(/\D/g, '')
          : null
      );

    if (phone && phone.length >= 8) {
      rememberLid(
        session,
        lidJid,
        `${phone}@s.whatsapp.net`
      );

      return phone;
    }

  } catch (err) {
    logError(
      'MSG',
      'Gagal resolve LID',
      err,
      label(session)
    );
  }

  return null;
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

  const pushName = msg.pushName || '';
  const text = String(getMessageText(msg)).trim();

  let phone = null;

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    phone = remoteJid
      .split('@')[0]
      .replace(/\D/g, '');

    if (
      String(msg.key.remoteJidAlt || '').endsWith('@lid')
    ) {
      rememberLid(
        session,
        msg.key.remoteJidAlt,
        remoteJid
      );
    }

  } else if (remoteJid.endsWith('@lid')) {
    phone = await resolvePhoneFromLid(
      session,
      msg,
      remoteJid
    );

    if (!phone) {
      logChat({
        session,
        phone: remoteJid,
        text,
        masuk: false,
        hasil: 'Nomor asli tidak tersedia dari WhatsApp (@lid)',
      });

      return;
    }

  } else {
    return;
  }

  if (!phone || phone === session.phone) {
    return;
  }

  // Deduplikasi pesan.
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

  // Media tanpa caption tidak dapat diekstrak sebagai teks.
  if (!text) return;

  const extractedResult = await extractLead({
    text,
    pushName,
    phone,
  });

  const extracted =
    extractedResult?.lead ?? extractedResult;

  const skipReason =
    extractedResult?.lead
      ? extractedResult.skipReason
      : null;

  if (!extracted) {
    logChat({
      session,
      phone,
      text,
      masuk: false,
      hasil:
        skipReason ||
        'Chat tidak dikenali sebagai calon pembeli',
    });

    return;
  }

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

  clearSessionTimers(session);

  session.enabled = false;
  session.connected = false;
  session.qr = null;

  const sock = session.socket;

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
  if (restoring) return;

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
        'Format metadata tidak valid'
      );

      return;
    }

    logInfo(
      'RESTORE',
      `Memulai pemulihan ${entries.length} sesi`
    );

    for (const item of entries) {
      try {
        if (!item || item.enabled === false) continue;

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

        if (existing?.socket || existing?.starting) {
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
          'Gagal memulihkan sesi, lanjut sesi berikutnya',
          err,
          String(item?.salesId || 'unknown')
        );
      }
    }

    logInfo(
      'RESTORE',
      'Pemulihan seluruh sesi selesai'
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
