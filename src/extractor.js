// ============================================================
// EXTRACTOR LEAD DARI CHAT WHATSAPP
//
// MODE SEKARANG: MANUAL (aturan kata kunci). Gemini dimatikan.
// Untuk menyalakan Gemini lagi nanti, set di .env:
//   USE_GEMINI=true
//   GEMINI_API_KEY=xxxx
// Kalau Gemini gagal, otomatis jatuh ke aturan manual di bawah.
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 12000);
const USE_GEMINI = String(process.env.USE_GEMINI || 'false').toLowerCase() === 'true';

// ------------------------------------------------------------
// KAMUS KEBUTUHAN
// Nilai `value` HARUS sama dengan pilihan di aplikasi:
// Gaming, coding, Kuliah, Sekolah, Kerja, Personal, Lainnya.
// Kalau ada beberapa kategori yang cocok, dipilih yang PALING BANYAK
// kata kuncinya; kalau seri, urutan di bawah ini yang menang.
// ------------------------------------------------------------
const NEEDS = [
  {
    value: 'Gaming',
    words: [
      'gaming', 'gamer', 'game', 'games', 'main game', 'maen game', 'ngegame', 'nge game', 'gaem',
      'valorant', 'dota', 'dota 2', 'pubg', 'genshin', 'fortnite', 'gta', 'gta 5', 'cs2', 'csgo', 'cs go',
      'mobile legend', 'mobile legends', 'free fire', 'fps', 'esport', 'e-sport', 'e sport', 'streamer',
      'rtx', 'gtx', 'vga', 'nvidia', 'rog', 'tuf', 'legion', 'loq', 'nitro', 'victus', 'omen',
      'alienware', 'predator', 'katana', 'raider', 'cyborg', 'stealth', 'laptop gaming', 'spek gaming',
    ],
  },
  {
    value: 'coding',
    words: [
      'coding', 'ngoding', 'koding', 'programmer', 'programming', 'pemrograman', 'developer', 'dev',
      'software', 'web developer', 'android studio', 'vscode', 'vs code', 'docker',
      'virtual machine', 'virtualbox', 'vmware', 'informatika', 'teknik informatika', 'ilmu komputer',
      'data science', 'machine learning', 'devops', 'backend', 'frontend', 'fullstack', 'full stack',
      'pentest', 'cyber security', 'cybersecurity',
    ],
  },
  {
    value: 'Kuliah',
    words: [
      'kuliah', 'kuliyah', 'kulyah', 'ngampus', 'kampus', 'mahasiswa', 'mahasiswi', 'mhs', 'maba',
      'skripsi', 'tesis', 'thesis', 'semester', 'dosen', 'universitas', 'univ', 'jurusan', 'prodi',
      'tugas kuliah', 'perkuliahan', 's1', 's2', 'd3', 'sarjana',
    ],
  },
  {
    value: 'Sekolah',
    words: [
      'sekolah', 'skolah', 'smk', 'sma', 'smp', 'sd', 'madrasah', 'pelajar', 'siswa', 'siswi',
      'anak sekolah', 'buat anak', 'untuk anak', 'anak saya', 'anaknya', 'tugas sekolah', 'ujian',
      'unbk', 'belajar online', 'belajar daring', 'daring',
    ],
  },
  {
    value: 'Kerja',
    words: [
      'kerja', 'kerjaan', 'pekerjaan', 'bekerja', 'kantor', 'kantoran', 'office', 'administrasi',
      'akuntansi', 'akuntan', 'accounting', 'excel', 'word', 'powerpoint', 'ppt', 'spreadsheet',
      'kasir', 'bisnis', 'usaha', 'wfh', 'freelance', 'freelancer', 'karyawan', 'meeting', 'zoom',
      'online shop', 'olshop', 'jualan', 'buka toko', 'guru', 'perusahaan', 'staff', 'staf',
    ],
  },
  {
    value: 'Personal',
    words: [
      'pribadi', 'personal', 'harian', 'sehari-hari', 'sehari hari', 'nonton', 'youtube', 'netflix',
      'internet', 'browsing', 'browsing doang', 'sosmed', 'medsos', 'santai', 'dirumah', 'di rumah',
      'ortu', 'orang tua', 'buat mama', 'buat papa', 'buat ibu', 'buat bapak', 'buat ayah',
      'buat istri', 'buat suami', 'kado', 'hadiah',
    ],
  },
  {
    value: 'Lainnya',
    words: [
      'desain', 'design', 'desainer', 'desain grafis', 'editing', 'edit video', 'video editing',
      'editor', 'render', 'rendering', 'autocad', 'cad', 'sketchup', 'blender', 'photoshop', 'corel',
      'coreldraw', 'premiere', 'after effects', 'lightroom', 'fotografi', 'animasi', 'arsitek',
      'arsitektur', 'teknik sipil', '3d', 'konten kreator', 'content creator', 'youtuber', 'vlog',
      'multimedia', 'musik', 'produksi musik',
    ],
  },
];

// Kata yang menandakan orang ini MINAT / TANYA laptop.
const LAPTOP_WORDS = [
  'laptop', 'laptob', 'leptop', 'lepi', 'lap top', 'notebook', 'netbook', 'chromebook', 'macbook',
  'komputer', 'pc', 'ultrabook', '2in1', '2 in 1',
];
const INTENT_WORDS = [
  'harga', 'hrg', 'price', 'budget', 'bdget', 'bujet', 'butuh', 'perlu', 'cari', 'nyari', 'mencari',
  'mau beli', 'pengen beli', 'pingin beli', 'ingin beli', 'mau order', 'minat', 'tertarik',
  'rekomendasi', 'rekomen', 'rekomendasiin', 'saran', 'sarankan', 'spek', 'spesifikasi', 'ready',
  'stok', 'stock', 'tersedia', 'ada ga', 'ada gak', 'ada nggak', 'ada ngga', 'ada gk', 'cicil',
  'cicilan', 'kredit', 'dp', 'nego', 'promo', 'diskon', 'pricelist', 'price list', 'katalog',
  'second', 'seken', 'bekas', 'order', 'pesan unit', 'merk', 'merek', 'tipe', 'processor', 'prosesor',
  'ram', 'ssd', 'hdd', 'cod', 'bisa kirim', 'ongkir',
];
// Chat purna jual / bukan calon pembeli.
const AFTER_SALES_WORDS = [
  'terima kasih', 'makasih', 'thanks', 'thx', 'trims', 'tq', 'sudah sampai', 'udah sampai', 'sdh sampai',
  'sudah diterima', 'udah diterima', 'sudah terima', 'resi', 'klaim', 'komplain', 'keluhan', 'rusak',
  'error', 'blank', 'mati total', 'servis', 'service', 'retur', 'refund', 'tukar', 'lemot', 'bermasalah',
  'layar pecah', 'baterai drop',
];
// Kata yang menandakan benar-benar mau beli (menang atas kata purna jual).
const BUY_INTENT_WORDS = [
  'harga', 'budget', 'cari', 'nyari', 'mencari', 'butuh', 'mau beli', 'pengen beli', 'ingin beli',
  'minat', 'tertarik', 'order', 'ready', 'stok', 'stock', 'rekomendasi', 'rekomen', 'cicil', 'kredit',
];

// ------------------------------------------------------------
// UTIL
// ------------------------------------------------------------
const wordCache = new Map();
function wordRegex(word) {
  let re = wordCache.get(word);
  if (!re) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // Boleh diikuti akhiran umum: kuliahnya, gamingnya, pcnya, dst.
    re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?:nya|lah|kah|pun|ku)?(?=[^\\p{L}\\p{N}]|$)`, 'iu');
    wordCache.set(word, re);
  }
  return re;
}
function hasWord(text, word) {
  return wordRegex(word).test(text);
}
function findWords(text, words) {
  return words.filter(w => hasWord(text, w));
}

function cleanText(t) {
  return String(t || '')
    .replace(/[\u200e\u200f]/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .map(w => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ------------------------------------------------------------
// KEBUTUHAN: pilih kategori dengan kata kunci terbanyak
// ------------------------------------------------------------
function detectNeed(lower) {
  let best = null;
  for (const group of NEEDS) {
    const hits = findWords(lower, group.words);
    if (group.value === 'Gaming' && /\b(?:rtx|gtx)\s*\d{3,4}/i.test(lower)) {
      hits.push('rtx/gtx');
    }
    if (hits.length && (!best || hits.length > best.hits.length)) {
      best = { value: group.value, hits };
    }
  }
  return best;
}

// ------------------------------------------------------------
// BUDGET
// Paham: 3jt, 3 jt, 3juta, 3jutaan, 3,5jt, 3.5 juta, 2-3jt, 2 sampai 3 juta,
// "dua jutaan", "setengah juta", 500rb, 3500rb, 3.000.000, 3000000, rp 3jt
// ------------------------------------------------------------
const UNIT = '(?:juta|jutaan|jt|jtan|jtaan|jeti)';
const NUM_WORDS = {
  'satu': 1, 'dua': 2, 'tiga': 3, 'empat': 4, 'lima': 5, 'enam': 6, 'tujuh': 7, 'delapan': 8,
  'sembilan': 9, 'sepuluh': 10, 'sebelas': 11, 'dua belas': 12, 'tiga belas': 13, 'empat belas': 14,
  'lima belas': 15, 'enam belas': 16, 'tujuh belas': 17, 'delapan belas': 18, 'sembilan belas': 19,
  'dua puluh': 20, 'tiga puluh': 30,
};

function convertNumberWords(s) {
  // "satu setengah juta" -> "1.5 juta", "setengah juta" -> "0.5 juta"
  let out = s.replace(
    new RegExp(`\\b(satu|dua|tiga|empat|lima)\\s+setengah\\s*(?=${UNIT}\\b)`, 'g'),
    (_, w) => `${NUM_WORDS[w] + 0.5} `
  );
  out = out.replace(new RegExp(`\\bsetengah\\s*(?=${UNIT}\\b)`, 'g'), '0.5 ');
  const keys = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length);
  out = out.replace(
    new RegExp(`\\b(${keys.join('|')})\\s*(?=${UNIT}\\b)`, 'g'),
    (_, w) => `${NUM_WORDS[w]} `
  );
  return out;
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))).replace('.', ',');
}
function validJuta(n) {
  return Number.isFinite(n) && n >= 0.3 && n < 100;
}

function parseBudget(text) {
  let s = String(text).toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  s = convertNumberWords(s);

  // 1) Rentang: "2-3jt", "2 jt - 3 jt", "2 sampai 3 juta", "2 s/d 3jt"
  const rangeRe = new RegExp(
    `(?<![\\p{L}\\d.])(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\s*(?:-|–|—|sampai|sd|s/d|s\\.d|hingga|to)\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}(?![\\p{L}])`,
    'iu'
  );
  const r = s.match(rangeRe);
  if (r) {
    const a = Number(r[1]);
    const b = Number(r[2]);
    if (validJuta(a) && validJuta(b) && a < b) {
      return { value: `${fmtNum(a)}-${fmtNum(b)} Jutaan`, raw: r[0].trim() };
    }
  }

  // 2) Satu angka + satuan juta: "3jt", "3,5 juta", "3jutaan"
  const singleRe = new RegExp(`(?<![\\p{L}\\d.\\-])(\\d+(?:\\.\\d+)?)\\s*${UNIT}(?![\\p{L}])`, 'iu');
  const m = s.match(singleRe);
  if (m) {
    const n = Number(m[1]);
    if (validJuta(n)) return { value: `${fmtNum(n)} Jutaan`, raw: m[0].trim() };
  }

  // 3) Satuan ribu: "500rb", "3500 ribu"
  const ribuRe = /(?<![\p{L}\d.\-])(\d{3,5})\s*(?:rb|ribu)(?![\p{L}])/iu;
  const rb = s.match(ribuRe);
  if (rb) {
    const amount = Number(rb[1]) * 1000;
    if (amount >= 300000 && amount <= 100000000) {
      return { value: `${fmtNum(amount / 1000000)} Jutaan`, raw: rb[0].trim() };
    }
  }

  // 4) Angka rupiah penuh: "3.000.000", "3000000", "rp 3.500.000"
  const rpRe = /(?<![\p{L}\d.\-])(?:rp\.?\s*)?(\d{1,3}(?:\.\d{3}){1,3}|\d{6,9})(?![\d])/giu;
  for (const hit of s.matchAll(rpRe)) {
    const amount = Number(hit[1].replace(/\./g, ''));
    if (amount >= 300000 && amount <= 100000000) {
      return { value: `${fmtNum(amount / 1000000)} Jutaan`, raw: hit[0].trim() };
    }
  }

  return null;
}

// ------------------------------------------------------------
// NAMA
// ------------------------------------------------------------
const NAME_STOP = new Set([
  'mau', 'ingin', 'pengen', 'pingin', 'cari', 'mencari', 'nyari', 'butuh', 'tanya', 'nanya', 'minat',
  'beli', 'lagi', 'dari', 'untuk', 'buat', 'ada', 'budget', 'laptop', 'yang', 'dan', 'di', 'ke',
  'sedang', 'bisa', 'boleh', 'tolong', 'kak', 'min', 'admin', 'gan', 'bang', 'mas', 'mbak', 'pak',
  'bu', 'ibu', 'bapak', 'om', 'tante', 'kakak', 'sis', 'bro', 'domisili', 'asal', 'nomor', 'no', 'wa',
  'hp', 'tinggal', 'ini', 'itu', 'dengan', 'sama', 'pengin', 'mo', 'lg', 'pgn', 'seorang', 'sebagai',
  'kerja', 'kuliah', 'sekolah',
]);

function cutAtStopword(candidate) {
  const out = [];
  for (const token of candidate.split(/\s+/)) {
    const bare = token.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (!bare || NAME_STOP.has(bare)) break;
    out.push(token.replace(/[.,!?;:]+$/g, ''));
  }
  return out.join(' ').trim();
}

function parseName(text) {
  // A) Penanda eksplisit: "nama saya Budi", "nama: Budi", "perkenalkan saya Budi", "atas nama Budi"
  const explicit = [
    /(?:nama(?:ku| saya| aku| gue| gw| lengkap saya)|saya bernama|aku bernama|panggil(?:an)?(?: saya| aku| gue)|dipanggil|perkenalkan(?: nama)?(?: saya| aku)?|kenalin(?: nama)?(?: saya| aku| gue)?|atas nama)\s*[:=,-]?\s*([\p{L}][\p{L}'.-]*(?:\s+[\p{L}][\p{L}'.-]*){0,2})/iu,
    /\bnama\s*[:=-]\s*([\p{L}][\p{L}'.-]*(?:\s+[\p{L}][\p{L}'.-]*){0,2})/iu,
  ];
  for (const re of explicit) {
    const m = text.match(re);
    if (m?.[1]) {
      const name = cutAtStopword(m[1]);
      if (name && name.length >= 2 && name.length <= 45) return titleCase(name);
    }
  }

  // B) "saya Budi", "aku Rina", "ini Dedi" (nama harus diawali huruf kapital)
  const pron = /(?:^|[^\p{L}])(?:[Ss]aya|[Aa]ku|[Gg]ue|[Gg]w|[Gg]ua|[Ii]ni)\s+(\p{Lu}[\p{L}']{1,20}(?:\s+\p{Lu}[\p{L}']{1,20}){0,2})/u;
  const p = text.match(pron);
  if (p?.[1]) {
    const name = cutAtStopword(p[1]);
    if (name && name.length >= 2 && name.length <= 45) return name;
  }
  return null;
}

// ------------------------------------------------------------
// REFERENSI / SPESIFIKASI LAPTOP
// 1) Kalau ada "referensi: xxx" / "spek: xxx" -> pakai itu.
// 2) Kalau tidak, rakit dari merk/tipe + spek yang disebut
//    (prosesor, RAM, penyimpanan, VGA).
// ------------------------------------------------------------
const STRONG_BRANDS = [
  'asus', 'acer', 'lenovo', 'dell', 'msi', 'apple', 'macbook', 'axioo', 'advan', 'zyrex', 'infinix',
  'huawei', 'samsung', 'toshiba', 'xiaomi', 'redmi', 'thinkpad', 'ideapad', 'thinkbook', 'legion',
  'loq', 'vivobook', 'zenbook', 'expertbook', 'aspire', 'travelmate', 'pavilion', 'probook',
  'elitebook', 'zbook', 'victus', 'omen', 'latitude', 'inspiron', 'vostro', 'alienware', 'chromebook',
  'surface', 'vaio', 'gigabyte', 'aorus', 'razer', 'chuwi', 'tuf', 'rog', 'predator',
];
const NEEDS_NUMBER_BRANDS = /\b(?:swift|nitro|modern|thin|prestige|stealth|raider|cyborg|katana|bravo|xps|envy|spectre|gram)\s*(?:go\s*)?\d{1,3}[a-z]?\b/i;
const HP_MODEL = /\bhp\s+(?:laptop\s+)?(?:\d{2,3}[a-z]?\b|pavilion|probook|elitebook|omen|victus|envy|spectre|stream|zbook|notebook)/i;

const REF_STOP = new Set([
  'untuk', 'buat', 'yang', 'dengan', 'dg', 'dgn', 'harga', 'budget', 'ada', 'ga', 'gak', 'nggak', 'ngga',
  'kak', 'min', 'ya', 'dong', 'kah', 'apa', 'berapa', 'bisa', 'ready', 'stok', 'kalau', 'kalo', 'atau',
  'dan', 'di', 'ke', 'dari', 'sama', 'seharga', 'sekitar', 'kisaran', 'rp', 'maksimal', 'max', 'sih',
  'nih', 'tuh', 'gan', 'sis', 'bang', 'mas', 'mbak', 'pak', 'bu', 'tersedia', 'ram', 'ssd', 'hdd',
  'core', 'intel', 'amd', 'ryzen', 'celeron', 'pentium', 'athlon', 'gen', 'layar', 'nvidia', 'rtx',
  'gtx', 'processor', 'prosesor', 'kuliah', 'kerja', 'sekolah', 'gaming', 'ngoding', 'coding', 'jt',
  'juta', 'jutaan', 'seken', 'second', 'bekas', 'baru', 'masih', 'tipe', 'model', 'seri', 'series',
]);

function parseUnit(text) {
  const scrubbed = text.replace(/\b(?:no|nomor|nomer|nmr|nope)\.?\s*(?:hp|wa|whatsapp)\b/gi, ' ');
  let startIdx = -1;

  const brandRe = new RegExp(`(^|[^\\p{L}\\p{N}])(${STRONG_BRANDS.join('|')})(?=[^\\p{L}\\p{N}]|$)`, 'iu');
  const bm = scrubbed.match(brandRe);
  if (bm) startIdx = bm.index + bm[1].length;

  for (const re of [NEEDS_NUMBER_BRANDS, HP_MODEL]) {
    const hm = scrubbed.match(re);
    if (hm && (startIdx === -1 || hm.index < startIdx)) startIdx = hm.index;
  }
  if (startIdx === -1) return null;

  const tail = scrubbed.slice(startIdx).split(/[\n,;?!]/)[0];
  const tokens = tail.split(/\s+/).filter(Boolean);
  const picked = [];
  for (let i = 0; i < tokens.length && picked.length < 5; i++) {
    const tok = tokens[i].replace(/[.]+$/g, '');
    const bare = tok.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!bare) break;
    if (i > 0 && REF_STOP.has(bare)) break;
    if (i > 0 && new RegExp(`^\\d+(?:[.,]\\d+)?${UNIT}$`, 'i').test(bare)) break;
    if (i > 0 && /^(?:i[3579]|\d+gb|\d+tb|\d+rb)$/i.test(bare)) break;
    if (i > 0 && /^\d{1,2}\/\d/.test(tok)) break; // singkatan RAM/storage: 8/256
    picked.push(tok);
  }
  const unit = picked.join(' ').trim();
  return unit.length >= 2 ? unit : null;
}

function parseSpecs(text) {
  const specs = {};

  // Prosesor
  const cpuPatterns = [
    /\bcore\s*ultra\s*[3579]\b/i,
    /\bryzen\s*[3579](?:\s*\d{4}[a-z]{0,2})?\b/i,
    /\b(?:core\s*)?i[3579][-\s]?\d{4,5}[a-z]{0,2}\d?\b/i,
    /\b(?:core\s*)?i[3579](?:[-\s]*(?:gen(?:erasi)?\s*)?\d{1,2}(?:th)?\b(?!\s*(?:gb|tb|inch|"|jt|juta)))/i,
    /\b(?:core\s*)?i[3579]\b/i,
    /\bceleron(?:\s*n?\d{3,4})?\b/i,
    /\bpentium\b/i,
    /\bathlon\b/i,
  ];
  for (const re of cpuPatterns) {
    const m = text.match(re);
    if (m) {
      specs.cpu = m[0].replace(/\s+/g, ' ').trim();
      break;
    }
  }

  // RAM / penyimpanan -- singkatan "8/256", "16/512", "8/1tb"
  const RAM_SET = new Set([2, 3, 4, 6, 8, 12, 16, 20, 24, 32, 64]);
  const short = text.match(/(?<![\d/])(\d{1,2})\s*\/\s*(\d{3,4}|\d\s*tb)\s*(?:gb)?(?![\d/])/i);
  if (short && RAM_SET.has(Number(short[1]))) {
    specs.ram = `${short[1]}GB`;
    const st = short[2].replace(/\s+/g, '');
    specs.storage = /tb/i.test(st) ? st.toUpperCase() : `${st}GB`;
  }

  if (!specs.ram) {
    const explicit = text.match(/\bram\s*(\d{1,2})\s*(?:gb|g)?\b/i) || text.match(/\b(\d{1,2})\s*gb\s*ram\b/i);
    if (explicit && RAM_SET.has(Number(explicit[1]))) {
      specs.ram = `${explicit[1]}GB`;
    } else {
      for (const hit of text.matchAll(/(?<![\d/])(\d{1,2})\s*gb\b/gi)) {
        if (RAM_SET.has(Number(hit[1]))) {
          specs.ram = `${hit[1]}GB`;
          break;
        }
      }
    }
  }

  if (!specs.storage) {
    const typeMatch = text.match(/\b(ssd|hdd|nvme)\b/i);
    const type = typeMatch ? typeMatch[1].toUpperCase() : '';
    const explicit = text.match(/\b(?:ssd|hdd|nvme|storage|penyimpanan|rom)\s*(\d{3,4}|\d)\s*(gb|tb|g|t)?\b/i);
    let size = null;
    if (explicit) {
      const n = Number(explicit[1]);
      const unit = (explicit[2] || '').toLowerCase();
      if (unit.startsWith('t') || (n <= 4 && !unit)) size = `${n}TB`;
      else if (n >= 120) size = `${n}GB`;
    }
    if (!size) {
      const big = text.match(/(?<![\d/])(120|128|240|256|480|500|512|1000|1024|2048)\s*gb\b/i);
      const tb = text.match(/(?<![\d/])([1-4])\s*tb\b/i);
      if (big) size = `${big[1]}GB`;
      else if (tb) size = `${tb[1]}TB`;
    }
    if (size) specs.storage = `${type ? type + ' ' : ''}${size}`;
  }

  // VGA
  const vga = text.match(/\b(?:rtx|gtx)\s*\d{3,4}(?:\s*ti)?\b/i) || text.match(/\bmx\s*\d{3}\b/i);
  if (vga) specs.vga = vga[0].replace(/\s+/g, ' ').toUpperCase();

  return specs;
}

function parseReference(text) {
  // Penanda eksplisit
  const m = text.match(/(?:referensi(?: laptop)?|spesifikasi|spek|tipe|model)\s*[:=-]\s*([^\n,;]{2,80})/i);
  if (m?.[1]) {
    const v = m[1].trim().replace(/[.!?]+$/, '');
    if (v.length >= 2) return { value: v, source: 'penanda "referensi/spek:"' };
  }

  const unit = parseUnit(text);
  const specs = parseSpecs(text);
  const parts = [unit, specs.cpu, specs.ram && `RAM ${specs.ram}`, specs.storage, specs.vga].filter(Boolean);
  if (!parts.length) return null;
  return { value: parts.join(', '), source: 'merk/tipe & spek yang disebut' };
}

function extractLeadRuleBased({ text = '', pushName = '', phone = '' }) {
  const normalized = cleanText(text);
  if (!normalized) return { lead: null, skipReason: 'pesan kosong', detail: '' };
  const lower = normalized.toLowerCase();

  const need = detectNeed(lower);
  const budget = parseBudget(normalized);
  const ref = parseReference(normalized);
  const laptopHits = findWords(lower, LAPTOP_WORDS);
  const intentHits = findWords(lower, INTENT_WORDS);
  const afterSalesHits = findWords(lower, AFTER_SALES_WORDS);
  const buyIntentHits = findWords(lower, BUY_INTENT_WORDS);

  // Pesan purna jual / terima kasih saja -> bukan calon pembeli,
  // kecuali di pesan itu juga ada budget / kebutuhan / kata minat beli.
  if (afterSalesHits.length && !budget && !need && !buyIntentHits.length) {
    return {
      lead: null,
      skipReason: `terdeteksi chat purna jual / ucapan terima kasih (kata: ${afterSalesHits.join(', ')})`,
      detail: '',
    };
  }

  const hasSignal = Boolean(need || budget || ref || laptopHits.length || intentHits.length);
  if (!hasSignal) {
    return {
      lead: null,
      skipReason: 'tidak ada kata terkait laptop / harga / budget / kebutuhan / spek',
      detail: '',
    };
  }

  const nama = parseName(normalized) || pushName.trim() || null;

  const detailParts = [];
  if (need) detailParts.push(`Kebutuhan=${need.value} dari kata: ${need.hits.join(', ')}`);
  if (budget) detailParts.push(`Budget dari: "${budget.raw}"`);
  if (ref) detailParts.push(`Referensi dari ${ref.source}`);
  if (laptopHits.length) detailParts.push(`Kata laptop: ${laptopHits.join(', ')}`);
  if (intentHits.length) detailParts.push(`Kata minat: ${intentHits.join(', ')}`);

  return {
    lead: {
      nama: nama || 'Pelanggan WhatsApp',
      nomorWa: phone,
      kebutuhan: need?.value || null,
      budget: budget?.value || null,
      referensiLaptop: ref?.value || null,
      rawMessage: normalized.slice(0, 1500),
      extractionMethod: 'rule-based',
    },
    skipReason: null,
    detail: detailParts.join(' | '),
  };
}

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
    if (!parsed.isLead) return { ok: true, lead: null };

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
  let last = await callGeminiOnce({ text, pushName, phone, timeoutMs: GEMINI_TIMEOUT_MS });
  if (!last.ok) {
    last = await callGeminiOnce({ text, pushName, phone, timeoutMs: GEMINI_TIMEOUT_MS });
  }
  return last;
}

// ------------------------------------------------------------
// PINTU MASUK
// Return: { lead, method, fallbackReason, skipReason, detail }
// ------------------------------------------------------------
export async function extractLead({ text = '', pushName = '', phone = '' }) {
  const normalized = cleanText(text);
  if (!normalized) {
    return { lead: null, method: null, fallbackReason: null, skipReason: 'pesan kosong', detail: '' };
  }

  let fallbackReason = null;

  if (USE_GEMINI) {
    const g = await extractLeadWithGemini({ text: normalized, pushName, phone });
    if (g.ok) {
      return {
        lead: g.lead,
        method: 'gemini',
        fallbackReason: null,
        skipReason: g.lead ? null : 'dinilai bukan calon pembeli oleh AI',
        detail: '',
      };
    }
    fallbackReason = g.reason;
  }

  const rule = extractLeadRuleBased({ text: normalized, pushName, phone });
  return {
    lead: rule.lead,
    method: 'rule-based',
    fallbackReason,
    skipReason: rule.skipReason,
    detail: rule.detail,
  };
}

// Tes manual dari terminal: node extractor.js
if (process.argv[1]?.endsWith('extractor.js')) {
  const samples = [
    { text: 'Halo kak, saya Budi. Cari laptop buat kuliah budget 3 jutaan', pushName: 'Budi', phone: '628123456789' },
    { text: 'kak budget nya 2-3jtan ada ga buat kerjaan kantoran', pushName: 'Rina', phone: '628333333333' },
    { text: 'bdget 2jt an min ada yg bgus ga buat ngoding', pushName: 'Dedi', phone: '628444444444' },
    { text: 'Pagi kak, ready asus vivobook 14 core i5 ram 8gb ssd 512gb? harga berapa', pushName: 'Ani', phone: '628555555555' },
    { text: 'makasih kak laptopnya sudah sampai', pushName: 'Eko', phone: '628666666666' },
    { text: 'halo', pushName: 'Tes', phone: '628777777777' },
  ];
  (async () => {
    for (const sample of samples) {
      const result = await extractLead(sample);
      console.log(JSON.stringify({ input: sample.text, result }, null, 2));
    }
  })();
}
