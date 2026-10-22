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
    touchSession,
  } from './session-manager.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const supplied = req.get('x-erra-admin-key') || '';
  if (!safeEqual(supplied, config.adminKey)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

async function requireFirebaseUser(req, res, next) {
  try {
    const match = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ ok: false, error: 'Token login tidak ditemukan. Silakan login ulang.' });
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.authUser = decoded;
    next();
  } catch (err) {
    console.warn('Token Firebase tidak valid:', err?.message || err);
    return res.status(401).json({ ok: false, error: 'Token Firebase tidak valid atau kedaluwarsa. Silakan login ulang.' });
  }
}

async function getSalesProfile(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) {
    const err = new Error('Profil pengguna tidak ditemukan pada collection users.');
    err.status = 404;
    throw err;
  }
  const data = snap.data() || {};
  const role = String(data.role || '').trim().toLowerCase();
  if (role !== 'sales') {
    const err = new Error('Fitur Erra Auto Lead hanya tersedia untuk akun dengan role Sales.');
    err.status = 403;
    throw err;
  }
  const salesName = String(data.name || data.nama || reqNameFallback(uid)).trim();
  const branch = String(data.branch || data.cabang || '').trim();
  if (!branch) {
    const err = new Error('Data cabang belum diisi pada profil sales di Firestore.');
    err.status = 400;
    throw err;
  }
  return { salesId: uid, salesName, branch };
}
function reqNameFallback(uid) { return `Sales ${uid.slice(0, 6)}`; }
function ensureOwnUid(req, res, next) {
  if (req.params.salesId !== req.authUser.uid) {
    return res.status(403).json({ ok: false, error: 'Akses ditolak. Anda hanya boleh mengakses sesi milik sendiri.' });
  }
  next();
}
function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
  if (phone.startsWith('8')) phone = `62${phone}`;
  return phone;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'erra-auto-lead', time: new Date().toISOString() }));

// Endpoint admin khusus operasional; tidak dipakai oleh aplikasi Flutter sales.
app.get('/api/sessions', requireAdmin, (_req, res) => res.json({ ok: true, sessions: listSessions() }));
app.get('/api/firestore-check', requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection('users').limit(1).get();
    res.json({ ok: true, firestore: 'connected', usersCollectionReadable: true, sampleCount: snap.size });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Firestore check gagal' });
  }
});

// Flutter: POST /api/sessions dengan Firebase ID token; UID/nama/cabang diambil dari token + Firestore.
app.post('/api/sessions', requireFirebaseUser, async (req, res) => {
  try {
    const sales = await getSalesProfile(req.authUser.uid);
    const session = await connectSales(sales);
    return res.status(201).json({ ok: true, session, qrEndpoint: `/api/sessions/${encodeURIComponent(sales.salesId)}/qr` });
  } catch (err) {
    console.error('POST /api/sessions:', err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Gagal memulai sesi WhatsApp.' });
  }
});

app.get('/api/sessions/:salesId', requireFirebaseUser, ensureOwnUid, async (req, res) => {
  touchSession(req.params.salesId);
  const session = getSession(req.params.salesId);
  if (!session) {
    const sales = await getSalesProfile(req.authUser.uid).catch(() => null);
    return res.json({ ok: true, session: { salesId: req.authUser.uid, salesName: sales?.salesName || '', branch: sales?.branch || '', connected: false, hasQr: false, phone: null, enabled: false } });
  }
  return res.json({ ok: true, session });
});

app.get('/api/sessions/:salesId/qr', requireFirebaseUser, ensureOwnUid, (req, res) => {
  const session = getSession(req.params.salesId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesi belum dibuat. Tekan Hubungkan WhatsApp terlebih dahulu.' });
  if (session.connected) return res.status(409).json({ ok: false, error: 'WhatsApp sudah terhubung; QR tidak diperlukan.' });
  const qr = getQr(req.params.salesId);
  if (!qr) return res.status(404).json({ ok: false, error: 'QR belum tersedia. Tunggu beberapa detik lalu coba lagi.' });
  return res.json({ ok: true, qrDataUrl: qr });
});

app.delete('/api/sessions/:salesId', requireFirebaseUser, ensureOwnUid, async (req, res) => {
  try {
    const logout = String(req.query.logout || 'false').toLowerCase() === 'true';
    const result = await disconnectSales(req.params.salesId, logout);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(404).json({ ok: false, error: err.message || 'Sesi tidak ditemukan.' });
  }
});

// Dipakai Flutter untuk mengambil data lead yang telah diekstrak berdasarkan nomor pelanggan.
app.get('/api/sessions/:salesId/leads/lookup', requireFirebaseUser, ensureOwnUid, async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone || phone.length < 9 || phone.length > 15) {
      return res.status(400).json({ ok: false, error: 'Nomor WhatsApp tidak valid.' });
    }
    const matches = await db.collection('leads').where('salesId', '==', req.authUser.uid).get();
    const found = matches.docs.find((doc) => normalizePhone(doc.data().nomorWa || doc.data().wa) === phone);
    if (!found) return res.json({ ok: true, lead: null });
    const data = found.data();
    return res.json({
      ok: true,
      lead: {
        id: found.id,
        name: data.nama || data.name || '',
        need: data.kebutuhan || data.need || '',
        budget: data.budget || '',
        laptopReference: data.referensiLaptop || data.laptopReference || '',
      },
    });
  } catch (err) {
    console.error('GET lead lookup:', err);
    return res.status(500).json({ ok: false, error: 'Gagal mencari data lead.' });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

const server = app.listen(config.port, config.host, async () => {
  console.log(`Erra Auto Lead listening on ${config.host}:${config.port}`);
  try { await restoreSessions(); }
  catch (err) { console.error('Gagal memulihkan sesi:', err); }
});

function shutdown(signal) {
  console.log(`${signal} diterima, menutup server...`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
