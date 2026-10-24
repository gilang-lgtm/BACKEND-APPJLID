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

// PENTING: data hasil baca otomatis dari chat WhatsApp TIDAK lagi ditulis
// ke collection "leads" -- itu bikin lead "muncul sendiri" di daftar sales
// walau sales belum pernah input apa-apa, padahal maunya cuma jadi draft
// buat auto-isi form "Tambah Lead". Sekarang ditulis ke collection
// terpisah "waLeadDrafts". Lead BENERAN baru masuk ke "leads" kalau sales
// menekan tombol Simpan di form (lihat add_lead_screen.dart).
export async function upsertLead({ sales, extracted }) {
  const phone = String(extracted.nomorWa || '').replace(/\D/g, '');
  if (!phone) throw new Error('Nomor pelanggan kosong; draft tidak disimpan');

  const drafts = db.collection('waLeadDrafts');
  // Query salesId saja agar tidak membutuhkan composite index baru.
  // Nomor dinormalisasi lalu dicocokkan di backend.
  const candidates = await drafts.where('salesId', '==', sales.salesId).get();
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
    if (!old.createdAt) patch.createdAt = FieldValue.serverTimestamp();
    await doc.ref.set(patch, { merge: true });
    return { id: doc.id, action: 'draft_updated' };
  }

  patch.createdAt = FieldValue.serverTimestamp();
  const ref = await drafts.add(patch);
  return { id: ref.id, action: 'draft_created' };
}
