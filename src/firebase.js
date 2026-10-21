import admin from 'firebase-admin';
import { config } from './config.js';

if (!admin.apps.length) {
  let credential;

  if (config.serviceAccountJson) {
    // Ambil service account key dari environment variable, bukan file --
    // lebih aman & cocok untuk hosting non-GCP (filesystem sering tidak permanen).
    let raw = config.serviceAccountJson.trim();
    // Jaga-jaga kalau value-nya di-encode base64 (berguna kalau platform hosting
    // tidak suka env var multiline / karakter JSON mentah).
    if (!raw.startsWith('{')) {
      raw = Buffer.from(raw, 'base64').toString('utf8');
    }
    const serviceAccount = JSON.parse(raw);
    credential = admin.credential.cert(serviceAccount);
  } else {
    // Fallback: Application Default Credentials.
    // Ini HANYA jalan otomatis di lingkungan Google Cloud (Cloud Run, GCE, dll),
    // atau kalau GOOGLE_APPLICATION_CREDENTIALS sudah di-set ke file key di server.
    // Kalau kode sampai ke sini di hosting non-GCP tanpa file key,
    // admin.initializeApp akan gagal dengan error "Could not load the default credentials".
    console.warn(
      'FIREBASE_SERVICE_ACCOUNT_JSON tidak di-set, fallback ke Application Default Credentials. ' +
      'Kalau server tidak jalan di Google Cloud, ini kemungkinan besar akan gagal.'
    );
    credential = admin.credential.applicationDefault();
  }

  admin.initializeApp({
    credential,
    ...(config.projectId ? { projectId: config.projectId } : {}),
  });
}

export { admin };
export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
