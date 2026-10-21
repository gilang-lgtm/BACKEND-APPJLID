import 'dotenv/config';
import path from 'node:path';

const adminKey = process.env.ADMIN_API_KEY?.trim();

if (!adminKey || adminKey.length < 24 || adminKey.startsWith('ganti_')) {
  throw new Error(
    'ADMIN_API_KEY wajib diisi dengan secret acak minimal 24 karakter di environment variables'
  );
}

const storageDir = process.env.STORAGE_DIR || '/app/sessions';

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  adminKey,
  projectId: process.env.FIREBASE_PROJECT_ID || undefined,
  // Isi service account key (JSON) dari Firebase Console -> Project Settings
  // -> Service Accounts -> Generate new private key. Di-paste apa adanya
  // sebagai environment variable FIREBASE_SERVICE_ACCOUNT_JSON.
  serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
  sessionsDir: path.join(storageDir, 'sessions'),
  dataDir: path.join(storageDir, 'data'),
};
