
import express from 'express';
import crypto from 'node:crypto';

import { config } from './config.js';
import { admin, db } from './firebase.js';

import {
  connectSales,
  disconnectSales,
  getQr,
  getSession,
  listSessions,
  restoreSessions,
} from './session-manager.js';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ======================================================
// LOGGER
// ======================================================

function writeLog(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'erra-auto-lead',
    event,
    ...details,
  };

  const output = JSON.stringify(entry);

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

// ======================================================
// SECURITY
// ======================================================

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));

  return aa.length > 0 &&
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const supplied = req.get('x-erra-admin-key') || '';

  if (!config.adminKey || !safeEqual(supplied, config.adminKey)) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
    });
  }

  next();
}

async function requireFirebaseUser(req, res, next) {
  try {
    const match = (req.get('authorization') || '')
      .match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        ok: false,
        error: 'Token login tidak ditemukan. Silakan login ulang.',
      });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);

    req.authUser = decoded;
    next();
  } catch (err) {
    writeLog('warn', 'auth.firebase.failed', {
      error: err?.message || String(err),
    });

    return res.status(401).json({
      ok: false,
      error: 'Token Firebase tidak valid atau kedaluwarsa. Silakan login ulang.',
    });
  }
}

// ======================================================
// SALES PROFILE
// ======================================================

function reqNameFallback(uid) {
  return `Sales ${uid.slice(0, 6)}`;
}

async function getSalesProfile(uid) {
  const snap = await db.collection('users').doc(uid).get();

  if (!snap.exists) {
    const err = new Error(
      'Profil pengguna tidak ditemukan pada collection users.'
    );
    err.status = 404;
    throw err;
  }

  const data = snap.data() || {};
  const role = String(data.role || '').trim().toLowerCase();

  if (role !== 'sales') {
    const err = new Error(
      'Fitur Erra Auto Lead hanya tersedia untuk akun dengan role Sales.'
    );
    err.status = 403;
    throw err;
  }

  const salesName = String(
    data.name || data.nama || reqNameFallback(uid)
  ).trim();

  const branch = String(
    data.branch || data.cabang || ''
  ).trim();

  if (!branch) {
    const err = new Error(
      'Data cabang belum diisi pada profil sales di Firestore.'
    );
    err.status = 400;
    throw err;
  }

  return {
    salesId: uid,
    salesName,
    branch,
  };
}

function ensureOwnUid(req, res, next) {
  if (req.params.salesId !== req.authUser.uid) {
    writeLog('warn', 'security.session_access_denied', {
      requesterUid: req.authUser.uid,
      requestedSalesId: req.params.salesId,
    });

    return res.status(403).json({
      ok: false,
      error: 'Akses ditolak. Anda hanya boleh mengakses sesi milik sendiri.',
    });
  }

  next();
}

// ======================================================
// PHONE NORMALIZATION
// ======================================================

function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');

  if (phone.startsWith('0')) {
    phone = `62${phone.slice(1)}`;
  } else if (phone.startsWith('8')) {
    phone = `62${phone}`;
  }

  return phone;
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/health', (_req, res) => {
  return res.json({
    ok: true,
    service: 'erra-auto-lead',
    time: new Date().toISOString(),
  });
});

// ======================================================
// ADMIN ENDPOINTS
// ======================================================

app.get('/api/sessions', requireAdmin, (_req, res) => {
  return res.json({
    ok: true,
    sessions: listSessions(),
  });
});

app.get('/api/firestore-check', requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection('users').limit(1).get();

    return res.json({
      ok: true,
      firestore: 'connected',
      usersCollectionReadable: true,
      sampleCount: snap.size,
    });
  } catch (err) {
    writeLog('error', 'firestore.check.failed', {
      error: err?.message || String(err),
    });

    return res.status(500).json({
      ok: false,
      error: 'Firestore check gagal.',
    });
  }
});

// ======================================================
// CREATE WHATSAPP SESSION
// ======================================================

app.post('/api/sessions', requireFirebaseUser, async (req, res) => {
  let sales;

  try {
    sales = await getSalesProfile(req.authUser.uid);

    writeLog('info', 'whatsapp.connection.requested', {
      salesId: sales.salesId,
      salesName: sales.salesName,
      branch: sales.branch,
    });

    const session = await connectSales(sales);

    writeLog('info', 'whatsapp.connection.initialized', {
      salesId: sales.salesId,
      salesName: sales.salesName,
      branch: sales.branch,
    });

    return res.status(201).json({
      ok: true,
      session,
      qrEndpoint: `/api/sessions/${encodeURIComponent(sales.salesId)}/qr`,
    });
  } catch (err) {
    writeLog('error', 'whatsapp.connection.failed', {
      salesId: sales?.salesId || req.authUser.uid,
      salesName: sales?.salesName || '',
      branch: sales?.branch || '',
      error: err?.message || String(err),
    });

    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || 'Gagal memulai sesi WhatsApp.',
    });
  }
});

// ======================================================
// GET SESSION STATUS
// ======================================================

app.get(
  '/api/sessions/:salesId',
  requireFirebaseUser,
  ensureOwnUid,
  async (req, res) => {
    try {
      const salesId = req.params.salesId;
      let session = getSession(salesId);

      if (!session) {
        const sales = await getSalesProfile(req.authUser.uid);

        session = {
          salesId: req.authUser.uid,
          salesName: sales.salesName,
          branch: sales.branch,
          connected: false,
          hasQr: false,
          phone: null,
          enabled: false,
        };
      }

      return res.json({
        ok: true,
        session,
      });
    } catch (err) {
      writeLog('error', 'whatsapp.session.status_failed', {
        salesId: req.params.salesId,
        error: err?.message || String(err),
      });

      return res.status(err.status || 500).json({
        ok: false,
        error: err.message || 'Gagal mengambil status sesi.',
      });
    }
  }
);

// ======================================================
// GET WHATSAPP QR
// ======================================================

app.get(
  '/api/sessions/:salesId/qr',
  requireFirebaseUser,
  ensureOwnUid,
  async (req, res) => {
    const salesId = req.params.salesId;

    try {
      const session = getSession(salesId);

      if (!session) {
        writeLog('warn', 'whatsapp.qr.request_failed', {
          salesId,
          reason: 'session_not_found',
        });

        return res.status(404).json({
          ok: false,
          error: 'Sesi belum dibuat. Tekan Hubungkan WhatsApp terlebih dahulu.',
        });
      }

      if (session.connected) {
        writeLog('info', 'whatsapp.qr.not_needed', {
          salesId,
          reason: 'already_connected',
        });

        return res.status(409).json({
          ok: false,
          error: 'WhatsApp sudah terhubung; QR tidak diperlukan.',
        });
      }

      const qr = getQr(salesId);

      if (!qr) {
        writeLog('warn', 'whatsapp.qr.not_ready', {
          salesId,
        });

        return res.status(404).json({
          ok: false,
          error: 'QR belum tersedia. Tunggu beberapa detik lalu coba lagi.',
        });
      }

      writeLog('info', 'whatsapp.qr.served', {
        salesId,
      });

      return res.json({
        ok: true,
        qrDataUrl: qr,
      });
    } catch (err) {
      writeLog('error', 'whatsapp.qr.failed', {
        salesId,
        error: err?.message || String(err),
      });

      return res.status(500).json({
        ok: false,
        error: 'Gagal mengambil QR WhatsApp.',
      });
    }
  }
);

// ======================================================
// DISCONNECT / LOGOUT WHATSAPP
// ======================================================

app.delete(
  '/api/sessions/:salesId',
  requireFirebaseUser,
  ensureOwnUid,
  async (req, res) => {
    const salesId = req.params.salesId;
    const logout =
      String(req.query.logout || 'false').toLowerCase() === 'true';

    let sales = null;

    try {
      sales = await getSalesProfile(salesId);
    } catch {
      // Logging tetap dilakukan meskipun profil tidak dapat dibaca.
    }

    writeLog('info', 'whatsapp.disconnect.requested', {
      salesId,
      salesName: sales?.salesName || '',
      branch: sales?.branch || '',
      action: logout ? 'logout' : 'disconnect',
    });

    try {
      const result = await disconnectSales(salesId, logout);

      writeLog('info', 'whatsapp.disconnect.completed', {
        salesId,
        salesName: sales?.salesName || '',
        branch: sales?.branch || '',
        action: logout ? 'logout' : 'disconnect',
        success: true,
      });

      return res.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      writeLog('error', 'whatsapp.disconnect.failed', {
        salesId,
        salesName: sales?.salesName || '',
        branch: sales?.branch || '',
        action: logout ? 'logout' : 'disconnect',
        error: err?.message || String(err),
      });

      return res.status(err.status || 404).json({
        ok: false,
        error: err.message || 'Sesi tidak ditemukan.',
      });
    }
  }
);

// ======================================================
// LEAD LOOKUP
// ======================================================

app.get(
  '/api/sessions/:salesId/leads/lookup',
  requireFirebaseUser,
  ensureOwnUid,
  async (req, res) => {
    try {
      const phone = normalizePhone(req.query.phone);

      if (!phone || phone.length < 9 || phone.length > 15) {
        return res.status(400).json({
          ok: false,
          error: 'Nomor WhatsApp tidak valid.',
        });
      }

      const matches = await db
        .collection('leads')
        .where('salesId', '==', req.authUser.uid)
        .get();

      const found = matches.docs.find((doc) => {
        const data = doc.data();

        return normalizePhone(
          data.nomorWa || data.wa
        ) === phone;
      });

      if (!found) {
        return res.json({
          ok: true,
          lead: null,
        });
      }

      const data = found.data();

      return res.json({
        ok: true,
        lead: {
          id: found.id,
          name: data.nama || data.name || '',
          need: data.kebutuhan || data.need || '',
          budget: data.budget || '',
          laptopReference:
            data.referensiLaptop || data.laptopReference || '',
        },
      });
    } catch (err) {
      writeLog('error', 'lead.lookup.failed', {
        salesId: req.authUser.uid,
        error: err?.message || String(err),
      });

      return res.status(500).json({
        ok: false,
        error: 'Gagal mencari data lead.',
      });
    }
  }
);

// ======================================================
// NOT FOUND
// ======================================================

app.use((_req, res) => {
  return res.status(404).json({
    ok: false,
    error: 'Not found',
  });
});

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use((err, req, res, _next) => {
  writeLog('error', 'http.unhandled_error', {
    method: req.method,
    path: req.path,
    error: err?.message || String(err),
  });

  if (res.headersSent) {
    return;
  }

  return res.status(500).json({
    ok: false,
    error: 'Terjadi kesalahan internal server.',
  });
});

// ======================================================
// SERVER START
// ======================================================

let shuttingDown = false;

const server = app.listen(config.port, config.host, async () => {
  writeLog('info', 'server.started', {
    host: config.host,
    port: config.port,
  });

  try {
    await restoreSessions();

    writeLog('info', 'whatsapp.sessions.restored');
  } catch (err) {
    writeLog('error', 'whatsapp.sessions.restore_failed', {
      error: err?.message || String(err),
    });
  }
});

// ======================================================
// PROCESS ERROR HANDLERS
// ======================================================

process.on('unhandledRejection', (reason) => {
  writeLog('error', 'process.unhandled_rejection', {
    error: reason?.message || String(reason),
  });
});

process.on('uncaughtException', (err) => {
  writeLog('error', 'process.uncaught_exception', {
    error: err?.message || String(err),
  });

  shutdown('uncaughtException');
});

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  writeLog('warn', 'server.shutdown_started', {
    signal,
  });

  server.close((err) => {
    if (err) {
      writeLog('error', 'server.shutdown_failed', {
        error: err.message,
      });

      process.exit(1);
    }

    writeLog('info', 'server.shutdown_completed');

    process.exit(0);
  });

  setTimeout(() => {
    writeLog('error', 'server.shutdown_timeout');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
