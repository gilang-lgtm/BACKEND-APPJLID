import crypto from 'node:crypto';
import { db, FieldValue } from './firebase.js';

function stableId(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function recordMessageOnce(salesId, messageKey) {
  const ref = db.collection('erraProcessedMessages').doc(stableId(`${salesId}:${messageKey}`));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.create(ref, { salesId, messageKey, processedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

export async function upsertLead({ sales, extracted }) {
  const phone = String(extracted.nomorWa || '').replace(/\D/g, '');
  if (!phone) throw new Error('Nomor pelanggan kosong; lead tidak disimpan');

  const leads = db.collection('leads');
  // Query salesId saja agar tidak membutuhkan composite index baru.
  // Nomor dinormalisasi lalu dicocokkan di backend.
  const candidates = await leads.where('salesId', '==', sales.salesId).get();
  const foundDoc = candidates.docs.find(doc =>
    String(doc.data().nomorWa || '').replace(/\D/g, '') === phone
  ) || null;

  const patch = {
    nama: extracted.nama || 'Pelanggan WhatsApp',
    nomorWa: phone,
    salesId: sales.salesId,
    salesName: sales.salesName,
    branch: sales.branch,
    source: 'whatsapp_auto',
    updatedAt: FieldValue.serverTimestamp(),
    lastMessageAt: FieldValue.serverTimestamp(),
  };
  if (extracted.kebutuhan) patch.kebutuhan = extracted.kebutuhan;
  if (extracted.budget) patch.budget = extracted.budget;
  if (extracted.referensiLaptop) patch.referensiLaptop = extracted.referensiLaptop;
  if (extracted.rawMessage) patch.lastMessagePreview = extracted.rawMessage;

  if (foundDoc) {
    const doc = foundDoc;
    const old = doc.data();
    // Jangan mengubah status yang sudah diatur sales (misalnya Follow Up/Closing).
    if (!old.status) patch.status = 'New';
    if (!old.createdAt) patch.createdAt = FieldValue.serverTimestamp();
    await doc.ref.set(patch, { merge: true });
    return { id: doc.id, action: 'updated' };
  }

  patch.status = 'New';
  patch.createdAt = FieldValue.serverTimestamp();
  patch.createdBy = 'erra_auto_lead';
  const ref = await leads.add(patch);
  return { id: ref.id, action: 'created' };
}
