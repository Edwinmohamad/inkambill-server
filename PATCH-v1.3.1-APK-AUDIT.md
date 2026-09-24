# INKAMNET GO 1.3.1 — Audit APK & Perbaikan Bug

Versi APK naik ke `1.3.1` / versionCode `6` (build.gradle, workflow, smoke test, fallback `/api/mobile/version`).

## Bug yang diperbaiki

| # | Area | Bug | Perbaikan |
|---|------|-----|-----------|
| 1 | UI (Android 15) | targetSdk 35 memaksa edge-to-edge: topbar web tertutup status bar, bottom nav tertutup gesture bar, keyboard menutupi input form. | Insets system bar + IME diterapkan ke root view (API 35+), `adjustResize` di manifest. |
| 2 | UI | Tema default `dark` + shell GO yang light-only: judul halaman putih di atas latar terang (tidak terlihat), tombol & input hitam. | APK selalu light mode (layout + app.js); tombol "Mode Tampilan" di menu GO dihapus. |
| 3 | Fitur | Sidebar disembunyikan di APK, tetapi menu GO tidak memuat Biaya Tambahan, Rekonsiliasi, Kategori Kas, Infrastructure Hub, Piket Server, Pergerakan Stok, Pemakaian Material, Supplier, WA Gateway, Log Aktivitas — halaman tersebut tidak bisa dibuka dari APK. | Ditambahkan ke menu GO dengan permission yang sama seperti sidebar. |
| 4 | Navigasi | Setelah buka halaman dari Menu/Aksi Cepat atau submit form di modal, tombol Back harus ditekan dua kali (entri history overlay tertinggal). | Link menu memakai `location.replace`; entri history overlay/modal yang tertinggal dilewati otomatis. |
| 5 | Crash (Android 8/9) | Upload → kamera memakai `MediaStore.insert` tanpa izin storage → `SecurityException` → aplikasi crash. Foto pelanggan juga tersimpan permanen di galeri. | Kamera memakai `FileProvider` di cache privat aplikasi. |
| 6 | Upload | Sebagian aplikasi kamera mengembalikan URI output sebagai `data` → foto yang baru diambil malah dihapus, upload kosong. | Hasil kamera diprioritaskan bila file terisi. |
| 7 | Upload | Opsi kamera tetap muncul untuk input Excel/dokumen. | Kamera hanya ditawarkan jika input menerima gambar. |
| 8 | Keamanan / UX | Kembali dari pemilih file/kamera selalu memunculkan kunci biometrik (backgroundAt = 0 dianggap "lama"). | State `locked` eksplisit; kunci hanya setelah >2 menit di background. |
| 9 | Keamanan | Android 8–10 tanpa sidik jari (hanya PIN/pola) melewati kunci sepenuhnya. | `BIOMETRIC_WEAK | DEVICE_CREDENTIAL` untuk API < 30. |
| 10 | Keamanan | Membatalkan layar PIN perangkat bisa menutup kunci (onStart menganggap baru saja keluar). | Kunci tetap aktif sampai autentikasi berhasil. |
| 11 | Notifikasi | Semua notifikasi memakai ID 6201: notifikasi baru menimpa yang lama dan tap notifikasi lama membuka href terbaru. | ID unik per `notificationId` (FCM) / id notifikasi (fallback). |
| 12 | Notifikasi | Fallback berkala menampilkan notifikasi yang sudah dibaca dan counter dinamis ("12 tagihan…") setiap angka berubah. | Hanya notifikasi persisten yang belum dibaca. |
| 13 | Keamanan | Setelah logout, push FCM user sebelumnya tetap dikirim ke HP (termasuk HP bersama). | Token perangkat disimpan di session dan dinonaktifkan saat logout. |
| 14 | Update | Force update bisa dilewati: dialog tertutup setelah tap "Update sekarang". Juga bisa crash jika tidak ada aplikasi pembuka. | Dialog forced tidak tertutup; unduhan APK lewat WebView/DownloadManager; try/catch. |
| 15 | Fitur | `window.print()` tidak berfungsi di WebView: tombol Cetak di Analitik & Cetak/Simpan PDF faktur mati. | Diarahkan ke dialog Print/Save-as-PDF Android tanpa JavaScript bridge. |
| 16 | Navigasi | Intent tanpa URL (mis. dari launcher) bisa memuat ulang Beranda dan membuang form yang sedang diisi. | Diabaikan bila tidak ada URL. |

## Verifikasi

- `node scripts/test-android-app.js`, `test-mobile-api.js`, `test-mobile-ui.js`, `test-responsive-css.js`, `validate-static.js`, `npm run check` — lulus.
- Render layout APK (Chromium, UA `INKAMNET-GO/`) — sebelum: judul hilang di tema dark; sesudah: light, menu lengkap; alur Back satu kali terverifikasi.
- Kompilasi Java/lint Android dijalankan oleh workflow **Build INKAMNET GO APK** (emulator API 29/31/34/35) saat push ke `main`.

## Catatan (belum diubah)

- `.env.example` masih `MOBILE_ANDROID_VERSION_CODE=2 / 1.1.0`; `version.json` dari CI tetap menjadi sumber utama.
- Jika Firebase aktif, fallback 15 menit tetap berjalan (notifikasi sama bisa muncul dua kali dengan ID yang sama → hanya diperbarui).
- Belum ada `FLAG_SECURE`: isi aplikasi masih terlihat di screenshot/recents.
