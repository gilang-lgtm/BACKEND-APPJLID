import admin from 'firebase-admin';
import { config } from './config.js';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...(config.projectId ? { projectId: config.projectId } : {}),
  });
}

export { admin };
export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
