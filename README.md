# Erra Auto Lead — backend yang diselaraskan dengan Flutter

Backend Node.js/Express + Baileys + Firebase Admin untuk sesi WhatsApp terpisah per UID sales.

## Persyaratan
- Node.js 20 atau lebih baru
- Project Firebase aktif dengan Authentication dan Cloud Firestore
- Service account Firebase Admin tersedia di hosting (gunakan secret/file rahasia; jangan commit)
- Collection `users/{uid}` memiliki `role: "Sales"` (case-insensitive), `name` atau `nama`, serta `branch` atau `cabang`

## Menjalankan lokal
1. Salin `.env.example` menjadi `.env`.
2. Isi `ADMIN_API_KEY` dengan secret acak minimal 24 karakter.
3. Isi `FIREBASE_PROJECT_ID` dengan project ID Firebase yang benar.
4. Set `GOOGLE_APPLICATION_CREDENTIALS` ke path service-account JSON yang aman, atau gunakan kredensial environment yang disediakan hosting.
5. Jalankan `npm install`, lalu `npm start`.
6. Tes `GET /health`; hasil yang diharapkan `{ "ok": true, ... }`.

## API yang dipakai Flutter
- `POST /api/sessions` — Firebase ID token; membuat/mengaktifkan sesi milik pengguna login.
- `GET /api/sessions/:salesId` — status sesi, hanya untuk UID sendiri.
- `GET /api/sessions/:salesId/qr` — QR, hanya untuk UID sendiri.
- `DELETE /api/sessions/:salesId` — putuskan koneksi tetapi simpan sesi.
- `DELETE /api/sessions/:salesId?logout=true` — logout dan hapus kredensial sesi.
- `GET /api/sessions/:salesId/leads/lookup?phone=...` — cari data lead milik sales yang sedang login.
- `GET /health` — health check publik.

Setiap endpoint sesi untuk aplikasi memverifikasi Firebase ID token dan membatasi akses ke UID token. Endpoint admin `GET /api/sessions` dan `/api/firestore-check` memakai header `x-erra-admin-key`.

## Deployment
- Pastikan hosting menjalankan `npm start` dari root folder proyek.
- Folder `sessions/` dan `data/` harus persisten bila hosting mendukung persistent storage. Jika filesystem ephemeral, sesi Baileys dapat hilang saat restart/deploy.
- Set URL HTTPS backend di `erra_auto_lead_page.dart` Flutter. Jangan menyimpan admin key di aplikasi Flutter.
- Baileys merupakan integrasi tidak resmi; penggunaan dapat menyebabkan sesi terputus atau nomor dibatasi WhatsApp. Gunakan sesuai ketentuan WhatsApp.
