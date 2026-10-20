const NEEDS = [
  { value: 'Gaming', words: ['gaming', 'main game', 'game', 'valorant', 'dota', 'pubg', 'genshin', 'rtx', 'gtx'] },
  { value: 'coding', words: ['coding', 'ngoding', 'programmer', 'programming', 'developer', 'software', 'program'] },
  { value: 'Kuliah', words: ['kuliah', 'kampus', 'mahasiswa', 'skripsi', 'semester', 'dosen'] },
  { value: 'Sekolah', words: ['sekolah', 'smk', 'sma', 'smp', 'pelajar', 'tugas sekolah'] },
  { value: 'Kerja', words: ['kerja', 'kantor', 'office', 'pekerjaan', 'administrasi', 'akuntansi', 'excel', 'word'] },
  { value: 'Personal', words: ['pribadi', 'personal', 'harian', 'nonton', 'youtube', 'internet'] },
];

function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}

function parseBudget(text) {
  const s = text.toLowerCase().replace(/,/g, '.');
  // Contoh: budget 2 juta, 2jt, 2.5 jutaan, 1500000, 1.500.000
  const million = s.match(/(?:budget|modal|dana|harga|di kisaran|kisaran|sekitar|maksimal|max|kurang lebih|rp\s*)?\s*(\d+(?:\.\d+)?)\s*(juta|jutaan|jt|jtaan)\b/i);
  if (million) {
    const n = Number(million[1]);
    if (Number.isFinite(n) && n > 0 && n < 100) return `${String(n).replace('.', ',')} Jutaan`;
  }
  const rupiah = s.match(/(?:rp\s*)?(\d{1,3}(?:\.\d{3}){1,3}|\d{7,9})\s*(?:rupiah|rp)?\b/i);
  if (rupiah) {
    const amount = Number(rupiah[1].replace(/\./g, ''));
    if (amount >= 300000 && amount <= 100000000) {
      const j = amount / 1000000;
      return `${Number.isInteger(j) ? j : Number(j.toFixed(1)).toString().replace('.', ',')} Jutaan`;
    }
  }
  // Pola bahasa sehari-hari: 2,5jt
  const compact = s.match(/\b(\d+(?:\.\d+)?)\s*jt\b/i);
  if (compact) return `${compact[1].replace('.', ',')} Jutaan`;
  return null;
}

function parseName(text) {
  const patterns = [
    /(?:nama saya|nama aku|nama gue|nama gw|saya bernama|aku bernama|panggil saya|nama)\s*[:=,-]?\s*([\p{L}][\p{L}' .-]{1,45})/iu,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const candidate = m[1].split(/[\n,.!?;]|\b(?:saya|aku|mau|ingin|cari|butuh|budget|untuk|buat)\b/i)[0].trim();
      if (candidate && candidate.length <= 45) return candidate.replace(/\s+/g, ' ');
    }
  }
  return null;
}

function parseReference(text) {
  const m = text.match(/(?:referensi(?: laptop)?|spesifikasi|spek|tipe|model)\s*[:=-]?\s*([^\n,;]{2,80})/i);
  if (!m?.[1]) return null;
  const v = m[1].trim().replace(/[.!?]+$/, '');
  return v.length >= 2 ? v : null;
}

export function extractLead({ text = '', pushName = '', phone = '' }) {
  const normalized = String(text).replace(/\u200e|\u200f/g, ' ').trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const kebutuhan = NEEDS.find(group => group.words.some(w => hasWord(lower, w)))?.value || null;
  const budget = parseBudget(normalized);
  const nama = parseName(normalized) || (pushName.trim() || null);
  const referensiLaptop = parseReference(normalized);

  const leadIntent = /\b(laptop|notebook|komputer|pc|harga|budget|butuh|cari|mau beli|minat|rekomendasi|untuk kuliah|untuk kerja|buat gaming|spek|spesifikasi)\b/i.test(normalized);
  // Jangan membuat lead hanya karena pelanggan mengirim "halo".
  if (!leadIntent && !kebutuhan && !budget && !referensiLaptop) return null;

  return {
    nama: nama || 'Pelanggan WhatsApp',
    nomorWa: phone,
    kebutuhan: kebutuhan || null,
    budget: budget || null,
    referensiLaptop: referensiLaptop || null,
    rawMessage: normalized.slice(0, 1500),
  };
}

// Helper dapat dijalankan tanpa WhatsApp untuk mengecek aturan.
if (process.argv[1]?.endsWith('extractor.js')) {
  const samples = [
    { text: 'Halo kak, saya Budi. Cari laptop buat kuliah budget 3 jutaan', pushName: 'Budi', phone: '628123456789' },
    { text: 'Ada laptop buat gaming budget 2,5jt?', pushName: 'Andi', phone: '628111111111' },
    { text: 'Halo kak', pushName: 'Test', phone: '628222222222' },
  ];
  for (const sample of samples) console.log(JSON.stringify(extractLead(sample), null, 2));
}
