import crypto from 'node:crypto';
import { db, FieldValue } from './firebase.js';

function stableId(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Dedupe pesan CUKUP di memori. Dulu tiap pesan = 1 transaksi Firestore
// (1 baca + 1 tulis + dokumen yang menumpuk selamanya) -- boros kuota.
// Kalau server restart lalu WhatsApp mengirim ulang pesan lama, hasilnya
// tetap aman karena upsertLead() bersifat idempoten (merge).
const seenMessages = new Set();
export async function recordMessageOnce(salesId, messageKey) {
  const k = `${salesId}:${messageKey}`;
  if (seenMessages.has(k)) return false;
  seenMessages.add(k);
  if (seenMessages.size > 20000) {
    let n = 0;
    for (const old of seenMessages) { seenMessages.delete(old); if (++n >= 5000) break; }
  }
  return true;
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
  // ID dokumen dibuat tetap (salesId_nomor) -> cukup 1 baca per pesan, tidak
  // lagi membaca SEMUA draft milik sales tiap ada chat masuk.
  const ref = drafts.doc(`${sales.salesId}_${phone}`);
  let doc = await ref.get();
  if (!doc.exists) {
    // Draft lama (ID acak) dicari sekali saja lewat nomor.
    const legacy = await drafts.where('salesId', '==', sales.salesId).where('nomorWa', '==', phone).limit(1).get();
    doc = legacy.empty ? null : legacy.docs[0];
  }
  const old = doc?.exists ? doc.data() : null;

  const realName = extracted.nama && extracted.nama !== 'Pelanggan WhatsApp' ? extracted.nama : null;
  const patch = {
    nomorWa: phone,
    salesId: sales.salesId,
    salesName: sales.salesName,
    branch: sales.branch,
    source: 'whatsapp_auto',
    updatedAt: FieldValue.serverTimestamp(),
    lastMessageAt: FieldValue.serverTimestamp(),
  };
  if (realName) patch.nama = realName;
  else if (!old?.nama) patch.nama = 'Pelanggan WhatsApp';
  if (extracted.kebutuhan) patch.kebutuhan = extracted.kebutuhan;
  if (extracted.budget) patch.budget = extracted.budget;
  if (extracted.referensiLaptop) patch.referensiLaptop = extracted.referensiLaptop;
  if (extracted.rawMessage) patch.lastMessagePreview = extracted.rawMessage;

  if (old) {
    // Tidak ada info baru & baru saja diperbarui -> lewati, hemat 1 tulis.
    const same = ['nama', 'kebutuhan', 'budget', 'referensiLaptop'].every((k) => patch[k] === undefined || patch[k] === old[k]);
    const last = old.lastMessageAt?.toMillis?.() ?? 0;
    if (same && Date.now() - last < 5 * 60 * 1000) return { id: doc.id, action: 'draft_unchanged' };
    if (!old.createdAt) patch.createdAt = FieldValue.serverTimestamp();
    await doc.ref.set(patch, { merge: true });
    return { id: doc.id, action: 'draft_updated' };
  }

  patch.createdAt = FieldValue.serverTimestamp();
  await ref.set(patch, { merge: true });
  return { id: ref.id, action: 'draft_created' };
}

// ------------------------------------------------------------
// MONITORING AKUN WA (dibaca halaman "Monitoring akun" di dashboard)
//   waSessions/{salesId}  = status koneksi WhatsApp tiap sales
//   waServer/status       = detak jantung (heartbeat) server VPS
// ------------------------------------------------------------
export async function publishSessionDoc(salesId, data) {
  await db.collection('waSessions').doc(salesId).set(
    { ...data, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

export async function publishServerHeartbeat(data) {
  await db.collection('waServer').doc('status').set(
    { ...data, heartbeatAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}
