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
  shutdownSessions,
} from './session-manager.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

// ------------------------------------------------------------
// Helper umum
// ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(httpError(504, message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

// Rate limit sederhana di memori (tanpa library tambahan).
function rateLimit({ windowMs, max, keyFn }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + windowMs }; hits.set(key, h); }
    if (++h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
    }
    next();
  };
}
const ipLimiter = rateLimit({ windowMs: 60_000, max: 300, keyFn: (req) => `ip:${req.ip}` });
const uidLimiter = (max) => rateLimit({ windowMs: 60_000, max, keyFn: (req) => `uid:${req.authUser?.uid || req.ip}` });

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------
function requireAdmin(req, res, next) {
  // Kalau ADMIN KEY belum di-set, endpoint admin DITUTUP (dulu: header kosong
  // sama dengan key kosong -> lolos).
  if (!config.adminKey) return res.status(503).json({ ok: false, error: 'Admin key belum dikonfigurasi di server.' });
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
    req.authUser = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (err) {
    console.warn('Token Firebase tidak valid:', err?.message || err);
    return res.status(401).json({ ok: false, error: 'Token Firebase tidak valid atau kedaluwarsa. Silakan login ulang.' });
  }
}

function ensureOwnUid(req, res, next) {
  if (req.params.salesId !== req.authUser.uid) {
    return res.status(403).json({ ok: false, error: 'Akses ditolak. Anda hanya boleh mengakses sesi milik sendiri.' });
  }
  next();
}

// ------------------------------------------------------------
// Profil sales (di-cache 60 dtk supaya polling dari aplikasi tidak
// membaca dokumen users berulang-ulang -- hemat kuota baca Firestore)
// ------------------------------------------------------------
const PROFILE_TTL_MS = 60_000;
const profileCache = new Map();

function reqNameFallback(uid) { return `Sales ${uid.slice(0, 6)}`; }

async function getSalesProfile(uid, { fresh = false } = {}) {
  const hit = profileCache.get(uid);
  if (!fresh && hit && hit.exp > Date.now()) return hit.value;

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw httpError(404, 'Profil pengguna tidak ditemukan pada collection users.');
  const data = snap.data() || {};
  const role = String(data.role || '').trim().toLowerCase();
  if (role !== 'sales') throw httpError(403, 'Fitur Erra Auto Lead hanya tersedia untuk akun dengan role Sales.');
  const salesName = String(data.name || data.nama || reqNameFallback(uid)).trim();
  const branch = String(data.branch || data.cabang || '').trim();
  if (!branch) throw httpError(400, 'Data cabang belum diisi pada profil sales di Firestore.');

  const value = { salesId: uid, salesName, branch };
  profileCache.set(uid, { value, exp: Date.now() + PROFILE_TTL_MS });
  if (profileCache.size > 1000) profileCache.delete(profileCache.keys().next().value);
  return value;
}

// ------------------------------------------------------------
// Nomor telepon
// ------------------------------------------------------------
function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (phone.startsWith('620')) phone = `62${phone.slice(3)}`;
  if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
  if (phone.startsWith('8')) phone = `62${phone}`;
  return phone;
}
function phoneVariants(phone) {
  const local = phone.startsWith('62') ? phone.slice(2) : phone;
  return [...new Set([phone, `+${phone}`, `0${local}`, local])];
}

// ------------------------------------------------------------
// Request log ringkas (hanya error / lambat, supaya log tidak banjir polling)
// ------------------------------------------------------------
let shuttingDown = false;
app.use((req, res, next) => {
  if (shuttingDown) res.set('Connection', 'close');
  if (req.path === '/health') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (res.statusCode >= 400 || ms > 2000) console.log(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
});

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, service: 'erra-auto-lead', time: new Date().toISOString(), uptime: Math.round(process.uptime()) }));

app.use('/api', ipLimiter);

// Endpoint admin khusus operasional; tidak dipakai oleh aplikasi Flutter sales.
app.get('/api/sessions', requireAdmin, (_req, res) => res.json({ ok: true, sessions: listSessions() }));
app.get('/api/firestore-check', requireAdmin, wrap(async (_req, res) => {
  const snap = await db.collection('users').limit(1).get();
  res.json({ ok: true, firestore: 'connected', usersCollectionReadable: true, sampleCount: snap.size });
}));

// Flutter: POST /api/sessions dengan Firebase ID token; UID/nama/cabang diambil dari token + Firestore.
// Klik ganda / retry dari aplikasi digabung jadi SATU proses (cegah dobel sesi).
const connecting = new Map();
app.post('/api/sessions', requireFirebaseUser, uidLimiter(10), wrap(async (req, res) => {
  const uid = req.authUser.uid;
  let job = connecting.get(uid);
  if (!job) {
    job = (async () => {
      const sales = await getSalesProfile(uid, { fresh: true });
      const session = await connectSales(sales);
      return { sales, session };
    })();
    connecting.set(uid, job);
    const cleanup = () => connecting.delete(uid);
    job.then(cleanup, cleanup);
  }
  const { sales, session } = await withTimeout(job, 45_000, 'Memulai sesi WhatsApp terlalu lama. Coba lagi.');
  return res.status(201).json({ ok: true, session, qrEndpoint: `/api/sessions/${encodeURIComponent(sales.salesId)}/qr` });
}));

app.get('/api/sessions/:salesId', requireFirebaseUser, ensureOwnUid, wrap(async (req, res) => {
  const session = getSession(req.params.salesId);
  if (session) return res.json({ ok: true, session });
  const sales = await getSalesProfile(req.authUser.uid).catch(() => null);
  return res.json({ ok: true, session: { salesId: req.authUser.uid, salesName: sales?.salesName || '', branch: sales?.branch || '', connected: false, hasQr: false, phone: null, enabled: false } });
}));

app.get('/api/sessions/:salesId/qr', requireFirebaseUser, ensureOwnUid, uidLimiter(120), (req, res) => {
  const session = getSession(req.params.salesId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesi belum dibuat. Tekan Hubungkan WhatsApp terlebih dahulu.' });
  if (session.connected) return res.status(409).json({ ok: false, error: 'WhatsApp sudah terhubung; QR tidak diperlukan.' });
  const qr = getQr(req.params.salesId);
  if (!qr) return res.status(404).json({ ok: false, error: 'QR belum tersedia. Tunggu beberapa detik lalu coba lagi.' });
  return res.json({ ok: true, qrDataUrl: qr });
});

app.delete('/api/sessions/:salesId', requireFirebaseUser, ensureOwnUid, wrap(async (req, res) => {
  const logout = String(req.query.logout || 'false').toLowerCase() === 'true';
  try {
    const result = await disconnectSales(req.params.salesId, logout);
    return res.json({ ok: true, ...result });
  } catch (err) {
    const notFound = /tidak ditemukan|not found/i.test(err?.message || '');
    throw httpError(notFound ? 404 : 500, err?.message || 'Gagal memutus sesi.');
  }
}));

// Dipakai Flutter untuk mengambil data lead yang telah diekstrak berdasarkan nomor pelanggan.
// HEMAT KUOTA: query langsung ke nomor (equality), TIDAK lagi membaca semua leads milik sales.
// Aplikasi menyimpan nomorWa dalam format 62xxxx, jadi varian format sudah cukup.
app.get('/api/sessions/:salesId/leads/lookup', requireFirebaseUser, ensureOwnUid, uidLimiter(60), wrap(async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone || phone.length < 9 || phone.length > 15) throw httpError(400, 'Nomor WhatsApp tidak valid.');

  const variants = phoneVariants(phone);
  const snap = await db.collection('leads')
    .where('salesId', '==', req.authUser.uid)
    .where('nomorWa', 'in', variants)
    .limit(5)
    .get();

  if (snap.empty) return res.json({ ok: true, lead: null });

  // Kalau ada beberapa lead dengan nomor yang sama, ambil yang terbaru.
  const ms = (d) => d.data().updatedAt?.toMillis?.() ?? d.data().createdAt?.toMillis?.() ?? 0;
  const found = snap.docs.sort((a, b) => ms(b) - ms(a))[0];
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
}));

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Penanganan error terpusat: aplikasi selalu menerima JSON, server tidak crash.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (res.headersSent) return;
  let status = err?.status || err?.statusCode || 500;
  let message = err?.message || 'Terjadi kesalahan pada server.';
  if (err?.type === 'entity.parse.failed') { status = 400; message = 'Format JSON tidak valid.'; }
  else if (err?.type === 'entity.too.large') { status = 413; message = 'Data terlalu besar.'; }
  else if (err?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(message)) {
    status = 503; message = 'Kuota database harian habis. Coba lagi nanti.';
  }
  if (status >= 500) {
    console.error(`${req.method} ${req.path}:`, err);
    if (status === 500) message = 'Terjadi kesalahan pada server.';
  }
  res.status(status).json({ ok: false, error: message });
});

// ------------------------------------------------------------
// Start, anti-crash & shutdown
// ------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  console.log(`Erra Auto Lead listening on ${config.host}:${config.port}`);
  restoreWithRetry();
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

// Pulihkan sesi saat start. Dicoba ulang hanya kalau belum ada sesi yang berhasil dipulihkan,
// supaya tidak membuat sesi dobel.
async function restoreWithRetry() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await restoreSessions(); return; }
    catch (err) {
      console.error(`Gagal memulihkan sesi (percobaan ${attempt}/5):`, err);
      if (listSessions().length > 0) return;
      await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} diterima, menutup server...`);
  const force = setTimeout(() => { console.error('Shutdown paksa (timeout).'); process.exit(1); }, 10_000);
  force.unref();
  server.close(async () => {
    await shutdownSessions().catch(() => {});
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Library WhatsApp sering melempar error asinkron; cukup dicatat agar proses tidak mati.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : reason);
});
// Error tak terduga: dicatat. Kalau terjadi berulang (>5x dalam 1 menit) proses dihentikan
// supaya dimulai ulang bersih oleh hosting.
const crashTimes = [];
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
  const now = Date.now();
  crashTimes.push(now);
  while (crashTimes.length && now - crashTimes[0] > 60_000) crashTimes.shift();
  if (crashTimes.length > 5) {
    console.error('Terlalu banyak error beruntun, proses dihentikan untuk restart.');
    process.exit(1);
  }
});
