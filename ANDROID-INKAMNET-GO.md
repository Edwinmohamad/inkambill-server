# INKAMNET GO 1.1.0

INKAMNET GO adalah aplikasi Android resmi untuk INKAMNET Control Center pada:

`https://inkambill.edwinpxmx.my.id`

## Fitur yang sudah disiapkan

- Sesi login tetap mengikuti cookie dan masa berlaku session server.
- Kunci biometrik/sandi perangkat saat aplikasi dibuka kembali atau ditinggalkan lebih dari dua menit.
- Upload melalui kamera, galeri, atau dokumen.
- Download PDF/Excel ke folder Downloads dengan cookie login.
- Notifikasi operasional berkala sebagai fallback tanpa layanan eksternal.
- Firebase Cloud Messaging untuk push real-time ketika kredensial Firebase tersedia.
- Update checker dan endpoint unduhan APK dari server INKAMNET.
- Android App Links untuk membuka halaman INKAMNET langsung dari tautan.
- Crash report disimpan lokal lebih dahulu lalu dikirim setelah session login tersedia.
- HTTP, mixed content, SSL invalid, JavaScript bridge, dan navigasi internal ke domain lain diblokir.
- PIN, password, session secret, dan kredensial MikroTik tidak disimpan di APK.

## Build dan pengujian otomatis

Workflow `Build INKAMNET GO APK` menjalankan:

1. Validasi sumber dan Android lint.
2. Build release jika signing secrets lengkap; fallback ke APK debug installable jika belum.
3. Verifikasi ZIP APK, package, label, versionCode, dan tanda tangan melalui `apksigner`.
4. Instal serta membuka aplikasi pada emulator Android 10, 12, 14, dan 15.
5. Menyimpan screenshot dan log pembukaan masing-masing emulator.
6. Setelah seluruh emulator lulus, menyalin APK secara atomik ke server pada `storage/mobile-releases/INKAMNET-GO.apk`.

Artifact utama pada GitHub Actions bernama `INKAMNET-GO-APK`. File installernya adalah `INKAMNET-GO-v1.1.0.apk`.

## Signing release permanen

Jalankan satu kali pada komputer/server privat yang memiliki Java, OpenSSL, dan Bash:

```bash
./android/generate-release-signing.sh
```

Script menghasilkan keystore PKCS12 4096-bit serta `inkamnet-go-github-secrets.txt`. Keduanya sudah diabaikan Git dan tidak boleh di-commit.

Masukkan empat nilai dari file tersebut ke **GitHub repository → Settings → Secrets and variables → Actions**:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Masukkan `MOBILE_ANDROID_CERT_SHA256` dari file yang sama ke `.env` server agar App Links terverifikasi. Backup keystore dan kredensial ke lokasi privat; tanpa kunci tersebut, APK release lama tidak dapat diperbarui.

## Firebase push real-time

Build APK membaca empat GitHub Actions secrets berikut:

- `FIREBASE_ANDROID_APPLICATION_ID`
- `FIREBASE_ANDROID_API_KEY`
- `FIREBASE_ANDROID_PROJECT_ID`
- `FIREBASE_ANDROID_SENDER_ID`

Server membaca:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_SERVICE_ACCOUNT_JSON`

Gunakan service-account JSON dalam format base64 untuk `.env` satu baris. Jika Firebase belum dikonfigurasi, build tetap aman dan aplikasi menggunakan sinkronisasi notifikasi berkala setiap 15 menit.

## Update aplikasi

Versi saat ini:

- Nama: INKAMNET GO
- Version name: `1.1.0`
- Version code: `2`
- Application ID release: `id.my.edwinpxmx.inkamnetgo`
- Application ID internal/debug: `id.my.edwinpxmx.inkamnetgo.debug`
- Minimum: Android 8.0 / API 26

Nilai server:

```env
MOBILE_ANDROID_VERSION_CODE=2
MOBILE_ANDROID_VERSION_NAME=1.1.0
MOBILE_ANDROID_APK_PATH=storage/mobile-releases/INKAMNET-GO.apk
MOBILE_ANDROID_FORCE_UPDATE=false
```

Naikkan version code dan version name setiap menerbitkan APK baru. Aktifkan `MOBILE_ANDROID_FORCE_UPDATE=true` hanya jika versi lama memiliki masalah keamanan atau tidak lagi kompatibel.
