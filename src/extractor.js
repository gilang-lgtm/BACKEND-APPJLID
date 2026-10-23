// ============================================================
// Ekstraksi lead dari chat WhatsApp -- AI (Gemini) sebagai metode
// utama, dengan fallback ke aturan kata kunci kalau API gagal/timeout.
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// Setelah thinkingConfig.thinkingBudget dimatikan (lihat callGeminiOnce),
// respons Gemini seharusnya cuma butuh beberapa detik. Sebelumnya 15000ms
// sering kurang karena model diam-diam "mikir" sampai puluhan detik --
// bukan soal network. 12 detik dikasih sedikit ruang jaga-jaga.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 12000);

// ====================================================================
// METODE LAMA: aturan kata kunci (FALLBACK saja -- dipakai kalau
// Gemini gagal, timeout, atau GEMINI_API_KEY belum di-set)
// ====================================================================

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

function extractLeadRuleBased({ text = '', pushName = '', phone = '' }) {
  const normalized = String(text).replace(/‎|‏/g, ' ').trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const kebutuhan = NEEDS.find(group => group.words.some(w => hasWord(lower, w)))?.value || null;
  const budget = parseBudget(normalized);
  const nama = parseName(normalized) || (pushName.trim() || null);
  const referensiLaptop = parseReference(normalized);

  const leadIntent = /\b(laptop|notebook|komputer|pc|harga|budget|butuh|cari|mau beli|minat|rekomendasi|untuk kuliah|untuk kerja|buat gaming|spek|spesifikasi)\b/i.test(normalized);
  if (!leadIntent && !kebutuhan && !budget && !referensiLaptop) return null;

  return {
    nama: nama || 'Pelanggan WhatsApp',
    nomorWa: phone,
    kebutuhan: kebutuhan || null,
    budget: budget || null,
    referensiLaptop: referensiLaptop || null,
    rawMessage: normalized.slice(0, 1500),
    extractionMethod: 'rule-based',
  };
}

// ====================================================================
// METODE UTAMA: ekstraksi pakai Gemini -- jauh lebih toleran terhadap
// typo, singkatan, dan format bahasa sehari-hari dibanding regex kaku.
// ====================================================================

const SYSTEM_PROMPT = `Kamu membantu toko laptop membaca pesan WhatsApp dari calon pembeli (leads).
Tugasmu: baca SATU pesan WhatsApp -- yang bisa jadi memakai bahasa santai, typo, atau singkatan -- lalu keluarkan JSON terstruktur.

Field yang harus diisi (isi null kalau tidak disebutkan di pesan):
- "nama": nama orangnya, HANYA kalau disebutkan eksplisit di pesan (mis. "nama saya Budi"). Jangan mengarang nama.
- "kebutuhan": salah satu dari ["Gaming", "coding", "Kuliah", "Sekolah", "Kerja", "Personal"], atau null kalau tidak jelas.
- "budget": perkiraan budget customer, dirapikan ke format singkat seperti "3 Jutaan" atau "2-3 Jutaan" kalau disebutkan rentang. Pahami semua variasi penulisan: "2jt", "2 jt", "2juta", "2-3jtan", "dua jutaan", "2.5jt", "2,5 juta", dsb -- semua itu tetap budget yang valid meski ada typo atau format tidak baku. Null kalau benar-benar tidak disebutkan.
- "referensiLaptop": merk/tipe/spesifikasi laptop yang disebutkan customer, atau null kalau tidak ada.
- "isLead": true kalau pesan ini menunjukkan minat membeli/bertanya soal laptop (apapun bahasanya, termasuk bahasa santai/typo/singkatan), false kalau pesan basa-basi yang sama sekali tidak relevan (mis. cuma "halo", "test", emoji saja, dll).

Pesan customer sering mengandung typo atau disingkat -- jangan terlalu kaku, pahami maksudnya secara natural seperti manusia membaca chat, bukan mencocokkan pola persis.

Balas HANYA dengan JSON valid, tanpa markdown code fence, tanpa penjelasan tambahan. Contoh:
{"nama":null,"kebutuhan":"Kuliah","budget":"3 Jutaan","referensiLaptop":null,"isLead":true}`;

async function callGeminiOnce({ text, pushName, phone, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: `Nama kontak WhatsApp (bisa jadi bukan nama asli): "${pushName || '(tidak ada)'}"\nPesan: "${text}"` }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        // Matikan "extended thinking" -- tugas ekstraksi ini sederhana dan
        // butuh respons cepat. Tanpa ini, model bisa mikir puluhan detik
        // (terbukti: 1 panggilan tes memakan ~36 detik, jauh di atas
        // timeout kita) padahal hasilnya sama saja untuk tugas sesimpel ini.
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, reason: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return { ok: false, reason: 'respons Gemini kosong/tidak ada teks' };

    const parsed = JSON.parse(raw);
    if (!parsed.isLead) return { ok: true, lead: null }; // berhasil diproses, tapi memang bukan lead

    return {
      ok: true,
      lead: {
        nama: (parsed.nama && String(parsed.nama).trim()) || pushName?.trim() || 'Pelanggan WhatsApp',
        nomorWa: phone,
        kebutuhan: parsed.kebutuhan || null,
        budget: parsed.budget || null,
        referensiLaptop: parsed.referensiLaptop || null,
        rawMessage: String(text).slice(0, 1500),
        extractionMethod: 'gemini',
      },
    };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timeout setelah ${timeoutMs}ms` : (err?.message || String(err));
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function extractLeadWithGemini({ text, pushName, phone }) {
  if (!GEMINI_API_KEY) {
    return { ok: false, reason: 'GEMINI_API_KEY belum di-set' };
  }

  // Coba 2x: percobaan pertama bisa gagal karena koneksi lambat/sesaat,
  // jadi jangan langsung nyerah ke fallback kata kunci yang lebih kaku.
  let last = await callGeminiOnce({ text, pushName, phone, timeoutMs: GEMINI_TIMEOUT_MS });
  if (!last.ok) {
    last = await callGeminiOnce({ text, pushName, phone, timeoutMs: GEMINI_TIMEOUT_MS });
  }
  return last;
}

// ====================================================================
// FUNGSI UTAMA yang dipanggil dari session-manager.js (WAJIB pakai await)
// Mengembalikan: { lead: {...} | null, method: 'gemini' | 'rule-based',
//                   fallbackReason: string | null }
// ====================================================================

export async function extractLead({ text = '', pushName = '', phone = '' }) {
  const normalized = String(text).replace(/‎|‏/g, ' ').trim();
  if (!normalized) return { lead: null, method: null, fallbackReason: null };

  const geminiResult = await extractLeadWithGemini({ text: normalized, pushName, phone });

  if (geminiResult.ok) {
    // Gemini berhasil dipanggil (entah hasilnya lead atau memang bukan lead)
    return { lead: geminiResult.lead, method: 'gemini', fallbackReason: null };
  }

  // Gemini gagal/timeout -> fallback ke aturan kata kunci, DAN catat alasannya
  const ruleLead = extractLeadRuleBased({ text: normalized, pushName, phone });
  return { lead: ruleLead, method: 'rule-based', fallbackReason: geminiResult.reason };
}

// Helper untuk tes manual dari terminal: node extractor.js
if (process.argv[1]?.endsWith('extractor.js')) {
  const samples = [
    { text: 'Halo kak, saya Budi. Cari laptop buat kuliah budget 3 jutaan', pushName: 'Budi', phone: '628123456789' },
    { text: 'kak budget nya 2-3jtan ada ga buat kerjaan kantoran', pushName: 'Rina', phone: '628333333333' },
    { text: 'bdget 2jt an min ada yg bgus ga buat ngoding', pushName: 'Dedi', phone: '628444444444' },
  ];
  (async () => {
    for (const sample of samples) {
      const result = await extractLead(sample);
      console.log(JSON.stringify({ input: sample.text, result }, null, 2));
    }
  })();
}
