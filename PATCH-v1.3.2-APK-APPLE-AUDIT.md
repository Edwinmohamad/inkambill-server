# INKAMNET GO 1.3.2 — APK Apple UI + Bug Audit

## Tujuan

Patch ini mengembalikan action **Lunasi** di layar Tagihan APK, merapikan UI mobile agar konsisten dengan web Apple-minimal, dan memperbaiki bug WebView/Android yang ditemukan saat audit source.

## Perbaikan utama

1. **Lunasi terlihat lagi di APK**
   - Akar masalah: tabel invoice desktop memiliki min-width besar (hingga 1200px), sehingga kolom Bayar/Tindakan terdorong jauh ke kanan pada WebView HP.
   - Di APK, daftar Tagihan sekarang dirender visual sebagai card mobile tanpa horizontal scroll.
   - Tombol **Lunasi** dan **Tindakan** selalu berada di bagian bawah card.
   - Permission bisnis tidak diubah: input pembayaran tetap hanya tersedia untuk Admin/Master Admin sesuai route server.

2. **Tindakan invoice stabil di layar kecil**
   - Action popover di APK menjadi bottom-sheet fixed yang tidak terpotong table overflow.
   - Stale popover dibersihkan pada orientation change dan bfcache restore.

3. **Quick action pembayaran lebih langsung**
   - Menu + sekarang memiliki **Lunasi Tagihan** yang langsung membuka `status=open`.

4. **Link target=_blank tidak lagi tampak mati di WebView**
   - PDF invoice, receipt, dan link lain yang memakai target blank diarahkan melalui current WebView.
   - MainActivity tetap menentukan apakah URL trusted dibuka internal atau external.

5. **Multi-file chooser Android diperbaiki**
   - `ClipData` diprioritaskan sebelum `getData()` sehingga multiple selection tidak diam-diam menjadi satu file.

6. **Native shell konsisten Apple light**
   - Splash, offline, app-lock, WebView background, status bar, dan navigation bar memakai light Apple-style untuk menghilangkan dark flash.

7. **Bottom action tidak lagi ketutup navbar APK**
   - Bulk action pelanggan/tagihan, Closing sticky action, dan operation loader dipindahkan di atas bottom navigation.

8. **Mobile UI disamakan dengan web**
   - Background `#f5f5f7`, card putih, border `#e5e5ea`, tipografi rapat, shadow minimal.
   - Topbar translucent light, accent ungu hanya untuk state/action penting.
   - Dashboard hero, menu, quick sheet, modal, bottom nav, form, dan filter dipadatkan tanpa dekorasi berlebihan.
   - Generic table tidak lagi dipaksa minimum 760px secara global.

## Version

- Android versionCode: `7`
- Android versionName: `1.3.2`
- Workflow build/publish dan `/api/mobile/version` fallback ikut diperbarui.

## File berubah

- `.env.example`
- `.github/workflows/build-android.yml`
- `android/app/build.gradle`
- `android/app/src/main/java/id/my/edwinpxmx/inkamnetgo/MainActivity.java`
- `public/css/mobile-app.css`
- `public/js/mobile-app.js`
- `routes/mobile.js`
- `scripts/android-emulator-smoke.sh`
- `scripts/test-android-app.js`
- `scripts/test-mobile-api.js`
- `scripts/test-mobile-ui.js`
- `views/invoices/index.ejs`
- `views/partials/layout.ejs`

## Validasi yang dijalankan

- `node --check public/js/mobile-app.js`
- `node scripts/test-mobile-ui.js`
- `node scripts/test-android-app.js`
- `node scripts/test-mobile-api.js`
- `node scripts/test-responsive-css.js`
- `node scripts/validate-static.js`
- `npm run check`
- `npm run validate:final`
- `git diff --check`

Semua validasi di atas lulus pada source audit. Build Gradle native tetap dijalankan oleh workflow GitHub Android karena environment audit lokal tidak menyediakan executable Gradle.
