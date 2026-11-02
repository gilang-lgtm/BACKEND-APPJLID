
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
  recordChatTime,
  recordMessageOnce,
  upsertLead,
} from './firestore-leads.js';

// ======================================================
// LOGGER
// ======================================================

const baileysLogger = pino({
  level: 'silent',
});

function log(tag, message, detail) {
  const line = detail
    ? `[${tag}] ${message} | ${detail}`
    : `[${tag}] ${message}`;

  console.log(line);
}

function logError(tag, message, err, detail) {
  const errMsg = err?.message || String(err || 'Unknown error');

  const line = detail
    ? `[${tag}] ${message}: ${errMsg} | ${detail}`
    : `[${tag}] ${message}: ${errMsg}`;

  console.error(line);
}

function safeError(err) {
  return String(err?.message || err || 'Unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

// ======================================================
// SESSION STORAGE
// ======================================================

const sessions = new Map();

const metadataPath = path.join(
  config.dataDir,
  'sales-sessions.json'
);

let restoring = false;

const QR_IDLE_TIMEOUT_MS = Number(
  process.env.QR_IDLE_TIMEOUT_MS || 90000
);

const RECONNECT_DELAY_MS = 3000;

fs.mkdirSync(config.sessionsDir, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });

// ======================================================
// SESSION HELPERS
// ======================================================

function safeFolder(salesId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(salesId)) {
    throw new Error(
      'salesId hanya boleh huruf, angka, _ atau -'
    );
  }

  return path.join(config.sessionsDir, salesId);
}

function saveMetadata() {
  const data = [...sessions.values()].map(session => ({
    salesId: session.sales.salesId,
    salesName: session.sales.salesName,
    branch: session.sales.branch,
    enabled: session.enabled !== false,
    lastConnectedAt: session.lastConnectedAt || null,
    lastDisconnectAt: session.lastDisconnectAt || null,
    lastDisconnectCode: session.lastDisconnectCode || null,
    lastError: session.lastError || null,
  }));

  const tempPath = `${metadataPath}.tmp`;

  fs.writeFileSync(
    tempPath,
    JSON.stringify(data, null, 2),
    { mode: 0o600 }
  );

  fs.renameSync(tempPath, metadataPath);
}

function statusOf(session) {
  let status = 'NOT_CONNECTED';

  if (session.connected) {
    status = 'CONNECTED';
  } else if (session.hasQr) {
    status = 'QR_REQUIRED';
  } else if (session.starting) {
    status = 'CONNECTING';
  } else if (session.error || session.lastError) {
    status = 'ERROR';
  } else if (session.enabled === false) {
    status = 'DISCONNECTED';
  } else if (session.enabled) {
    status = 'CONNECTING';
  }

  return {
    salesId: session.sales.salesId,
    salesName: session.sales.salesName,
    branch: session.sales.branch,

    status,

    connected: Boolean(session.connected),
    hasQr: Boolean(session.qr),
    enabled: session.enabled !== false,
    starting: Boolean(session.starting),

    phone: session.phone || null,

    lastConnectedAt: session.lastConnectedAt || null,
    connectedAt: session.lastConnectedAt || null,
    connectingSince: session.connectingSince || null,
    lastDisconnectAt: session.lastDisconnectAt || null,
    lastDisconnectCode: session.lastDisconnectCode || null,

    error: session.error || null,
    lastError: session.lastError || null,

    hasEverConnected: Boolean(session.hasEverConnected),
  };
}

function label(session) {
  return `${session.sales.salesName}/${session.sales.branch}`;
}

function isCurrentSession(session) {
  return sessions.get(session.sales.salesId) === session;
}

function clearReconnectTimer(session) {
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function setSessionError(session, err) {
  const message = safeError(err);

  session.error = message;
  session.lastError = message;
  session.updatedAt = new Date().toISOString();

  try {
    saveMetadata();
  } catch (saveErr) {
    logError('WA', 'Gagal menyimpan metadata error', saveErr, label(session));
  }
}

// ======================================================
// PUBLIC SESSION FUNCTIONS
// ======================================================

export function listSessions() {
  return [...sessions.values()].map(statusOf);
}

export function getSession(salesId) {
  const session = sessions.get(salesId);

  return session ? statusOf(session) : null;
}

export function getQr(salesId) {
  const session = sessions.get(salesId);

  if (!session) return null;

  return session.qr || null;
}

// Dipanggil hanya saat Sales melakukan aksi eksplisit.
export function touchSession(salesId) {
  const session = sessions.get(salesId);

  if (session) {
    session.lastRequestedAt = Date.now();
  }
}

// ======================================================
// CREATE / CONNECT SESSION
// ======================================================

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

  let current = sessions.get(id);

  if (current?.starting || current?.connected) {
    current.sales = sales;
    current.enabled = true;
    current.lastRequestedAt = Date.now();

    saveMetadata();

    return statusOf(current);
  }

  if (!current) {
    current = {
      sales,

      connected: false,
      qr: null,
      phone: null,

      enabled: true,
      starting: false,
      socket: null,

      hasEverConnected: false,

      lastRequestedAt: Date.now(),

      lastConnectedAt: null,
      connectingSince: null,
      lastDisconnectAt: null,
      lastDisconnectCode: null,

      error: null,
      lastError: null,

      reconnectTimer: null,
    };

    sessions.set(id, current);
  } else {
    current.sales = sales;
    current.enabled = true;
    current.lastRequestedAt = Date.now();

    current.error = null;

    clearReconnectTimer(current);
  }

  saveMetadata();

  await startSocket(current, folder);

  return statusOf(current);
}

// ======================================================
// RECONNECT SCHEDULER
// ======================================================

function scheduleReconnect(session, folder, delay = RECONNECT_DELAY_MS) {
  if (!isCurrentSession(session)) return;
  if (!session.enabled) return;
  if (session.reconnectTimer) return;

  session.reconnectTimer = setTimeout(async () => {
    session.reconnectTimer = null;

    if (!isCurrentSession(session) || !session.enabled) {
      return;
    }

    if (session.starting || session.connected) {
      return;
    }

    log('WA', 'Menjalankan reconnect', label(session));

    try {
      await startSocket(session, folder);
    } catch (err) {
      setSessionError(session, err);

      logError(
        'WA',
        'Reconnect gagal',
        err,
        label(session)
      );

      scheduleReconnect(session, folder);
    }
  }, delay);

  session.reconnectTimer.unref?.();
}

// ======================================================
// START SOCKET
// ======================================================

async function startSocket(session, folder) {
  if (!isCurrentSession(session)) return;
  if (!session.enabled) return;
  if (session.starting || session.connected) return;

  session.starting = true;
  session.connectingSince = new Date().toISOString();
  session.error = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(folder);

    if (!isCurrentSession(session) || !session.enabled) {
      return;
    }

    if (state.creds?.registered) {
      session.hasEverConnected = true;
    }

    const sock = makeWASocket({
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

    sock.ev.on('creds.update', saveCreds);

    // ==================================================
    // CONNECTION UPDATE
    // ==================================================

    sock.ev.on(
      'connection.update',
      async ({ connection, qr, lastDisconnect }) => {
        if (!isCurrentSession(session) || session.socket !== sock) {
          return;
        }

        // ------------------------------
        // QR GENERATED
        // ------------------------------

        if (qr) {
          try {
            session.qr = await QRCode.toDataURL(qr);

            session.error = null;

            log(
              'WA',
              'QR baru dibuat',
              label(session)
            );
          } catch (err) {
            setSessionError(session, err);

            logError(
              'WA',
              'Gagal membuat QR',
              err,
              label(session)
            );
          }
        }

        // ------------------------------
        // CONNECTED
        // ------------------------------

        if (connection === 'open') {
          session.connected = true;
          session.qr = null;

          session.hasEverConnected = true;

          session.phone =
            sock.user?.id
              ?.split(':')[0]
              ?.split('@')[0] || null;

          session.lastConnectedAt = new Date().toISOString();

          session.connectingSince = null;

          session.error = null;
          session.lastError = null;

          session.lastDisconnectCode = null;

          clearReconnectTimer(session);

          try {
            saveMetadata();
          } catch (err) {
            logError(
              'WA',
              'Gagal menyimpan metadata koneksi',
              err,
              label(session)
            );
          }

          log(
            'WA',
            'Terhubung',
            `${label(session)} (${session.phone || 'nomor tidak tersedia'})`
          );
        }

        // ------------------------------
        // DISCONNECTED
        // ------------------------------

        if (connection === 'close') {
          session.connected = false;
          session.qr = null;
          session.connectingSince = null;

          session.lastDisconnectAt = new Date().toISOString();

          const code =
            lastDisconnect?.error?.output?.statusCode ?? null;

          session.lastDisconnectCode = code;

          const disconnectMessage = safeError(
            lastDisconnect?.error || `Connection closed (${code})`
          );

          session.error = disconnectMessage;
          session.lastError = disconnectMessage;

          session.socket = null;

          try {
            saveMetadata();
          } catch (err) {
            logError(
              'WA',
              'Gagal menyimpan metadata disconnect',
              err,
              label(session)
            );
          }

          log(
            'WA',
            `TERPUTUS kode=${code}`,
            label(session)
          );

          if (
            !session.enabled ||
            code === DisconnectReason.loggedOut
          ) {
            if (code === DisconnectReason.loggedOut) {
              session.error = 'WhatsApp logout. Perlu scan QR ulang.';
              session.lastError = session.error;

              try {
                saveMetadata();
              } catch {}
            }

            log(
              'WA',
              'Reconnect dihentikan',
              `${label(session)} | ${!session.enabled ? 'sesi dinonaktifkan' : 'loggedOut'}`
            );

            return;
          }

          // ------------------------------
          // SESSION ALREADY PAIRED
          // ------------------------------

          if (session.hasEverConnected) {
            log(
              'WA',
              'Reconnect dijadwalkan',
              label(session)
            );

            scheduleReconnect(session, folder);
            return;
          }

          // ------------------------------
          // SESSION NOT PAIRED YET
          // ------------------------------

          const idleFor =
            Date.now() - (session.lastRequestedAt || 0);

          if (idleFor < QR_IDLE_TIMEOUT_MS) {
            log(
              'WA',
              'Reconnect QR dijadwalkan',
              label(session)
            );

            scheduleReconnect(session, folder);
          } else {
            log(
              'WA',
              'Idle, auto-QR dihentikan',
              label(session)
            );

            session.socket = null;

            try {
              saveMetadata();
            } catch {}
          }
        }
      }
    );

    // ==================================================
    // INCOMING MESSAGES
    // ==================================================

    sock.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        if (!isCurrentSession(session) || session.socket !== sock) {
          return;
        }

        if (type !== 'notify') {
          if (type === 'append') {
            for (const msg of messages) {
              if (
                msg?.key?.fromMe &&
                isRecentMessage(msg)
              ) {
                await trackChatTime(session, msg);
              }
            }
          }

          log(
            'MSG',
            `SKIP type=${type}`,
            label(session)
          );

          return;
        }

        log(
          'MSG',
          `upsert type=notify jumlah=${messages.length}`,
          label(session)
        );

        for (const msg of messages) {
          if (!isCurrentSession(session) || session.socket !== sock) {
            return;
          }

          await trackChatTime(session, msg);

          try {
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

  } catch (err) {
    setSessionError(session, err);

    logError(
      'WA',
      'Gagal memulai socket',
      err,
      label(session)
    );

    if (session.hasEverConnected && session.enabled) {
      scheduleReconnect(session, folder);
    }

    throw err;

  } finally {
    session.starting = false;

    if (!session.connected) {
      session.connectingSince = null;
    }
  }
}

// ======================================================
// MESSAGE TEXT
// ======================================================

function getMessageText(msg) {
  const m = msg.message || {};

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

// ======================================================
// WHATSAPP LID RESOLVER
// ======================================================

async function resolvePhoneFromLid(sock, msg) {
  const key = msg.key || {};

  const lidJid = key.remoteJid || '';

  const altCandidates = [
    key.remoteJidAlt,
    key.senderPn,
    key.participantAlt,
    key.participantPn,
    msg.verifiedBizName,
  ];

  for (const candidate of altCandidates) {
    if (
      typeof candidate === 'string' &&
      candidate.endsWith('@s.whatsapp.net')
    ) {
      const phone = candidate
        .split('@')[0]
        .replace(/\D/g, '');

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
      const phone = String(resolved)
        .split('@')[0]
        .replace(/\D/g, '');

      if (phone) return phone;
    }
  } catch (err) {
    logError(
      'MSG',
      'Gagal resolve @lid lewat lidMapping',
      err,
      lidJid
    );
  }

  log(
    'MSG',
    'DEBUG @lid: resolve gagal',
    JSON.stringify(key)
  );

  return null;
}

// ======================================================
// MESSAGE DATE
// ======================================================

function messageDate(msg) {
  const n = Number(
    msg?.messageTimestamp?.toString?.() ??
    msg?.messageTimestamp
  );

  if (!Number.isFinite(n) || n <= 0) {
    return new Date();
  }

  const date = new Date(n * 1000);

  return date.getTime() > Date.now() + 5 * 60 * 1000
    ? new Date()
    : date;
}

function isRecentMessage(
  msg,
  maxAgeMs = 10 * 60 * 1000
) {
  return (
    Date.now() - messageDate(msg).getTime() <= maxAgeMs
  );
}

// ======================================================
// TRACK CHAT TIME
// ======================================================

async function trackChatTime(session, msg) {
  try {
    if (!msg?.key) return;

    const jid = msg.key.remoteJid || '';

    if (
      jid.endsWith('@g.us') ||
      jid.endsWith('@broadcast') ||
      jid.endsWith('@newsletter')
    ) {
      return;
    }

    const kinds = Object.keys(msg.message || {});

    const systemMessages = [
      'protocolMessage',
      'senderKeyDistributionMessage',
      'messageContextInfo',
    ];

    if (
      !kinds.length ||
      kinds.every(kind => systemMessages.includes(kind))
    ) {
      return;
    }

    let phone = null;

    if (jid.endsWith('@s.whatsapp.net')) {
      phone = jid.split('@')[0].replace(/\D/g, '');
    } else if (jid.endsWith('@lid')) {
      phone = await resolvePhoneFromLid(session.socket, msg);
    }

    if (!phone || phone === session.phone) return;

    await recordChatTime({
      sales: session.sales,
      phone,
      fromMe: Boolean(msg.key.fromMe),
      at: messageDate(msg),
    });

  } catch (err) {
    logError(
      'CHAT',
      'Gagal mencatat jam chat',
      err,
      label(session)
    );
  }
}

// ======================================================
// HANDLE INCOMING MESSAGE
// ======================================================

async function handleIncoming(session, msg) {
  log(
    'MSG',
    'DEBUG diterima',
    `${label(session)} | hasKey=${Boolean(msg?.key)} | fromMe=${msg?.key?.fromMe} | remoteJid=${msg?.key?.remoteJid || '-'} | msgTypeKeys=${msg?.message ? Object.keys(msg.message).join(',') : '(tanpa field message)'}`
  );

  if (!msg?.key || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid || '';

  if (
    remoteJid.endsWith('@g.us') ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@newsletter')
  ) {
    return;
  }

  const messageText = getMessageText(msg).trim();

  let phone = null;
  let phoneIssue = null;

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    phone = remoteJid
      .split('@')[0]
      .replace(/\D/g, '');

  } else if (remoteJid.endsWith('@lid')) {
    phone = await resolvePhoneFromLid(session.socket, msg);

    if (!phone) {
      phoneIssue = 'gagal resolve @lid';
    }

  } else {
    phoneIssue = `jid tidak dikenali (${remoteJid})`;
  }

  let skip = null;

  if (!phone) {
    skip = phoneIssue || 'nomor tidak diketahui';

  } else if (phone === session.phone) {
    skip = 'nomor sama dengan nomor toko sendiri';

  } else if (
    msg.key.id &&
    !(await recordMessageOnce(
      session.sales.salesId,
      msg.key.id
    ))
  ) {
    skip = 'duplikat, sudah pernah diproses';

  } else if (!messageText) {
    skip = 'tanpa teks/caption (media)';
  }

  let extracted = null;
  let method = null;
  let fallbackReason = null;

  if (!skip) {
    ({
      lead: extracted,
      method,
      fallbackReason,
    } = await extractLead({
      text: messageText,
      pushName: msg.pushName || '',
      phone,
    }));
  }

  const methodLabel =
    method === 'gemini' ? 'gemini' : 'manual';

  const extractionResult = skip
    ? `tidak diproses (${skip})`
    : !extracted
      ? `diabaikan, bukan lead (${methodLabel}${fallbackReason ? `, gemini gagal: ${fallbackReason}` : ''})`
      : `${methodLabel}${fallbackReason ? ` (gemini gagal: ${fallbackReason})` : ''}`;

  // Log chat masuk tetap menampilkan isi pesan.
  // Hati-hati: log ini berisi data percakapan pelanggan.
  log(
    'CHAT',
    `pesan masuk="${messageText || '-'}"`,
    `no wa=${phone || '-'} | ${label(session)} | diextrak=${extractionResult}`
  );

  if (skip || !extracted) return;

  // Simpan draft untuk form Tambah Lead.
  const result = await upsertLead({
    sales: session.sales,
    extracted,
  });

  log(
    'DRAFT',
    `${result.action} id=${result.id}`,
    `${phone} | ${session.sales.branch} | nama=${extracted.nama || '-'} kebutuhan=${extracted.kebutuhan || '-'} budget=${extracted.budget || '-'} referensi=${extracted.referensiLaptop || '-'}`
  );
}

// ======================================================
// DISCONNECT / LOGOUT
// ======================================================

export async function disconnectSales(
  salesId,
  logout = false
) {
  const session = sessions.get(salesId);

  if (!session) {
    throw new Error('Sesi sales tidak ditemukan');
  }

  session.enabled = false;
  session.connected = false;
  session.qr = null;
  session.connectingSince = null;

  clearReconnectTimer(session);

  try {
    if (logout) {
      await session.socket?.logout();
    } else {
      session.socket?.end(undefined);
    }
  } catch (err) {
    logError(
      'WA',
      'Penutupan sesi',
      err,
      salesId
    );
  }

  session.socket = null;

  if (logout) {
    fs.rmSync(
      safeFolder(salesId),
      {
        recursive: true,
        force: true,
      }
    );

    sessions.delete(salesId);

  } else {
    session.lastDisconnectAt = new Date().toISOString();
    session.error = null;

    try {
      saveMetadata();
    } catch (err) {
      logError(
        'WA',
        'Gagal menyimpan metadata disconnect',
        err,
        salesId
      );
    }
  }

  if (logout) {
    saveMetadata();
  }

  log(
    'WA',
    logout ? 'Logout berhasil' : 'Disconnect berhasil',
    salesId
  );

  return {
    salesId,
    disconnected: true,
    loggedOut: logout,
  };
}

// ======================================================
// RESTORE SESSIONS
// ======================================================

export async function restoreSessions() {
  if (restoring) return;

  restoring = true;

  try {
    if (!fs.existsSync(metadataPath)) {
      log('WA', 'Metadata sesi belum tersedia');
      return;
    }

    const entries = JSON.parse(
      fs.readFileSync(metadataPath, 'utf8')
    );

    if (!Array.isArray(entries)) {
      throw new Error('Format metadata sesi tidak valid');
    }

    for (const item of entries) {
      try {
        if (item.enabled === false) continue;

        if (!item.salesId) {
          log(
            'WA',
            'Metadata dilewati karena salesId kosong'
          );
          continue;
        }

        const id = String(item.salesId);

        if (sessions.has(id)) continue;

        const session = {
          sales: {
            salesId: id,
            salesName: item.salesName || `Sales ${id.slice(0, 6)}`,
            branch: item.branch || 'Belum diatur',
          },

          connected: false,
          qr: null,
          phone: null,

          enabled: true,
          starting: false,
          socket: null,

          hasEverConnected: false,
          lastRequestedAt: Date.now(),

          lastConnectedAt: item.lastConnectedAt || null,
          connectingSince: null,
          lastDisconnectAt: item.lastDisconnectAt || null,
          lastDisconnectCode: item.lastDisconnectCode || null,

          error: null,
          lastError: item.lastError || null,

          reconnectTimer: null,
        };

        sessions.set(id, session);

        log(
          'WA',
          'Memulihkan sesi',
          label(session)
        );

        try {
          await startSocket(
            session,
            safeFolder(id)
          );
        } catch (err) {
          setSessionError(session, err);

          logError(
            'WA',
            'Gagal memulihkan sesi',
            err,
            label(session)
          );
        }

      } catch (err) {
        logError(
          'WA',
          'Gagal memulihkan salah satu akun',
          err,
          item?.salesId || '-'
        );
      }
    }

    log(
      'WA',
      'Proses restore selesai',
      `total metadata=${entries.length}`
    );

  } catch (err) {
    logError(
      'WA',
      'Gagal membaca metadata sesi',
      err
    );

  } finally {
    restoring = false;
  }
}
