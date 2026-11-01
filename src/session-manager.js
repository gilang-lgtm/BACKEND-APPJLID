
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

const MAX_LOG_TEXT_LENGTH = 300;

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
  const message = err?.message || String(err || 'Unknown error');

  return String(message)
    .replace(/\b\d{8,16}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_LOG_TEXT_LENGTH);
}

function logInfo(tag, message, detail = '') {
  const suffix = detail ? ` | ${detail}` : '';
  console.log(`[${tag}] ${message}${suffix}`);
}

function logWarn(tag, message, detail = '') {
  const suffix = detail ? ` | ${detail}` : '';
  console.warn(`[${tag}] ${message}${suffix}`);
}

function logError(tag, message, err, detail = '') {
  const errorText = safeError(err);
  const suffix = detail ? ` | ${detail}` : '';

  console.error(
    `[${tag}] ${message}: ${errorText}${suffix}`
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

  return action ? String(action) : 'tersimpan';
}

// Log tidak menyimpan isi chat atau nomor pelanggan.
// Ini mengurangi risiko data pribadi masuk ke terminal/log.
function logChat({
  session,
  extracted,
  masuk,
  hasil,
}) {
  if (masuk && extracted) {
    const detail = [
      `nama=${extracted.nama || '-'}`,
      `kebutuhan=${extracted.kebutuhan || '-'}`,
      `budget=${extracted.budget || '-'}`,
      `referensi=${extracted.referensiLaptop || '-'}`,
    ].join(' ');

    logInfo(
      'CHAT',
      `${label(session)} | MASUK LEADS (${hasil})`,
      detail
    );

    return;
  }

  logInfo(
    'CHAT',
    `${label(session)} | TIDAK MASUK LEADS`,
    hasil || 'Tidak memenuhi kriteria lead'
  );
}

// ============================================================
// UTILITAS SESI
// ============================================================

function safeFolder(salesId) {
  const id = String(salesId || '');

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error(
      'salesId hanya boleh huruf, angka, underscore, atau tanda minus'
    );
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

// Menulis ke file sementara terlebih dahulu.
// Setelah selesai, file sementara menggantikan file metadata lama.
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
    .then(() => {
      writeMetadataAtomic();
    })
    .catch(err => {
      logError('META', 'Gagal menyimpan metadata sesi', err);
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

  // Polling QR tidak memperpanjang waktu idle.
  return session.qr || null;
}

export function touchSession(salesId) {
  const session = sessions.get(String(salesId));

  if (!session || !session.enabled) {
    return;
  }

  session.lastRequestedAt = Date.now();

  // Jika sesi belum pernah berhasil pairing dan socket berhenti,
  // aksi eksplisit dari pengguna boleh memulai kembali koneksi.
  if (
    !session.connected &&
    !session.starting &&
    !session.socket &&
    !session.hasEverConnected
  ) {
    startSocket(
      session,
      safeFolder(session.sales.salesId)
    ).catch(err => {
      logError(
        'WA',
        'Gagal memulai sesi setelah permintaan QR',
        err,
        label(session)
      );
    });
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

    await saveMetadata();

    if (
      session.connected ||
      session.starting ||
      session.socket
    ) {
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
  if (!session.enabled) {
    return;
  }

  if (session.starting || session.connected) {
    return;
  }

  // Jangan membuat socket kedua ketika socket lama masih aktif.
  if (session.socket) {
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

    if (!session.enabled) {
      return;
    }

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
          'Gagal menyimpan kredensial WhatsApp',
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
    if (session.socket === sock || !sock) {
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
            'Gagal membuat QR WhatsApp',
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
          `${label(session)} | status=connected`
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
            'WhatsApp logout. Pairing ulang diperlukan',
            label(session)
          );

          await saveMetadata();

          return;
        }

        // Socket sudah close. Lepaskan referensinya agar
        // reconnect berikutnya dapat membuat socket baru.
        if (session.socket === sock) {
          session.socket = null;
        }

        // Sesi yang sudah pernah pairing boleh reconnect otomatis.
        if (session.hasEverConnected) {
          scheduleReconnect(session, folder);
          return;
        }

        // Sesi yang belum pernah pairing hanya membuat QR
        // jika masih ada permintaan aktif dari pengguna.
        const idleFor =
          Date.now() - (session.lastRequestedAt || 0);

        if (idleFor < QR_IDLE_TIMEOUT_MS) {
          scheduleReconnect(session, folder);
        } else {
          logInfo(
            'WA',
            'QR dihentikan karena tidak ada aktivitas',
            label(session)
          );
        }
      }
    }
  );
}

// ============================================================
// RECONNECT MANAGEMENT
// ============================================================

function scheduleReconnect(session, folder) {
  if (!session.enabled) {
    return;
  }

  if (session.connected || session.starting) {
    return;
  }

  if (session.reconnectTimer) {
    return;
  }

  if (
    !session.hasEverConnected &&
    Date.now() - (session.lastRequestedAt || 0) >= QR_IDLE_TIMEOUT_MS
  ) {
    return;
  }

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;

    if (!session.enabled || session.connected) {
      return;
    }

    if (session.socket || session.starting) {
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
// QR IDLE MANAGEMENT
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
      return;
    }

    scheduleQrIdleCheck(session, folder);

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
    'Menghentikan sesi QR yang idle',
    label(session)
  );

  clearSessionTimers(session);

  session.qr = null;

  const sock = session.socket;

  session.socket = null;
  session.connected = false;

  // Naikkan generation agar event dari socket lama diabaikan.
  session.socketGeneration++;

  try {
    sock?.end(undefined);
  } catch (err) {
    logError(
      'WA',
      'Gagal menghentikan socket QR idle',
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
      if (type !== 'notify') {
        return;
      }

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
            'Gagal memproses pesan masuk',
            err,
            label(session)
          );
        }
      }
    }
  );
}

// ============================================================
// MESSAGE TEXT
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
// JID AND PHONE RESOLUTION
// ============================================================

function jidUser(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0];
}

function phoneFromJid(jid) {
  const value = String(jid || '');

  if (!value) {
    return null;
  }

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
    // Mapping bersifat best-effort.
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
        if (
          String(contact?.id || '').endsWith('@lid')
        ) {
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

  // 1. Coba field alternatif dari pesan.
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

  // 2. Coba cache mapping yang pernah dipelajari.
  const cached = session.lidMap?.get(
    jidUser(lidJid)
  );

  if (cached) {
    return cached;
  }

  // 3. Coba mapping bawaan Baileys jika tersedia.
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
// HANDLE INCOMING MESSAGE
// ============================================================

async function handleIncoming(session, msg) {
  if (!msg?.key || msg.key.fromMe) {
    return;
  }

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
        masuk: false,
        hasil: 'Nomor pelanggan tidak tersedia dari WhatsApp (@lid)',
      });

      return;
    }

  } else {
    return;
  }

  if (!phone || phone === session.phone) {
    return;
  }

  // Pesan tanpa ID tidak dapat dideduplikasi dengan aman.
  const messageKey = msg.key.id;

  if (!messageKey) {
    logWarn(
      'MSG',
      'Pesan dilewati karena tidak memiliki ID',
      label(session)
    );

    return;
  }

  // Deduplikasi pesan.
  const isNewMessage = await recordMessageOnce(
    session.sales.salesId,
    messageKey
  );

  if (!isNewMessage) {
    return;
  }

  // Media tanpa caption tidak diproses sebagai lead.
  if (!text) {
    return;
  }

  const {
    lead: extracted,
    skipReason,
  } = await extractLead({
    text,
    pushName,
    phone,
  });

  if (!extracted) {
    logChat({
      session,
      masuk: false,
      hasil: skipReason ||
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

  // Invalidate seluruh event dari socket yang lama.
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
      logout
        ? 'Gagal logout WhatsApp'
        : 'Gagal memutuskan koneksi WhatsApp',
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
      'Sesi WhatsApp berhasil logout',
      label(session)
    );

  } else {
    logInfo(
      'WA',
      'Sesi WhatsApp berhasil diputus',
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
      'Pemulihan sesi sedang berjalan'
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
        'Format metadata sesi bukan array'
      );

      return;
    }

    logInfo(
      'RESTORE',
      `Memulai pemulihan ${entries.length} data sesi`
    );

    for (const item of entries) {
      try {
        if (!item || item.enabled === false) {
          continue;
        }

        const salesId = String(item.salesId || '');

        if (!salesId) {
          continue;
        }

        const folder = safeFolder(salesId);

        if (
          !item.salesName?.trim() ||
          !item.branch?.trim()
        ) {
          logWarn(
            'RESTORE',
            'Data sales tidak lengkap, sesi dilewati',
            salesId
          );

          continue;
        }

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

        // Sesi yang direstore belum tentu pernah pairing.
        // startSocket akan memeriksa creds.registered.
        session.hasEverConnected = false;

        session.lastRequestedAt = Date.now();

        sessions.set(salesId, session);

        await startSocket(session, folder);

        logInfo(
          'RESTORE',
          'Pemulihan sesi diproses',
          `${salesId} | ${label(session)}`
        );

      } catch (err) {
        logError(
          'RESTORE',
          'Gagal memulihkan satu sesi, lanjut ke sesi berikutnya',
          err,
          String(item?.salesId || 'unknown')
        );
      }
    }

    logInfo(
      'RESTORE',
      'Proses pemulihan seluruh sesi selesai'
    );

  } catch (err) {
    logError(
      'RESTORE',
      'Terjadi kesalahan pemulihan sesi',
      err
    );

  } finally {
    restoring = false;
  }
}
