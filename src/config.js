import 'dotenv/config';
import path from 'node:path';

const adminKey = process.env.ADMIN_API_KEY?.trim();
if (!adminKey || adminKey.length < 24 || adminKey.startsWith('ganti_')) {
  throw new Error('ADMIN_API_KEY wajib diisi dengan secret acak minimal 24 karakter di .env');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  adminKey,
  projectId: process.env.FIREBASE_PROJECT_ID || undefined,
  sessionsDir: path.resolve(process.env.SESSIONS_DIR || 'sessions'),
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
};
