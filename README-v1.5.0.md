# INKAMNET Control Center v1.5.0

Upgrade fokus pada profile, people management, sales assignment, settings center, dan bilingual shell.

## Fitur
- Foto profil user (JPG/PNG/WEBP max 4 MB) + halaman Profil Saya.
- Settings Center: Perusahaan, Aplikasi, Karyawan, Departemen, Posisi, Bank, Payment Gateway, Roles & Permissions.
- Direktori karyawan terintegrasi ke Sales pelanggan, PIC Ticket, Jadwal Teknisi, dan pilihan Piket Server.
- Customer memiliki Sales; template/import/export XLSX mendukung `sales_employee_code`.
- Halaman Tagihan dibersihkan menjadi Bahasa Indonesia dan faktur memakai rekening bank aktif bila tersedia.
- Pilihan bahasa ID / EN pada topbar; default bahasa dapat dipilih di Pengaturan → Aplikasi. Shell/menu/topbar dan label umum modul lama mengikuti bahasa terpilih melalui lapisan bilingual ringan, sementara Tagihan sengaja tetap Bahasa Indonesia.
- GitHub deploy workflow menjaga `storage/profile-photos/` agar foto tidak terhapus saat rsync deploy.
- `.dockerignore` mencegah bukti pembayaran/foto profil ikut masuk Docker build context.

## Database
Schema v1.5 dibuat otomatis saat aplikasi start melalui `ensureV15Schema()` dan aman untuk database existing (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).

Tabel baru: `departments`, `positions`, `employees`, `banks`, `payment_gateways`, `role_permissions`.
Kolom baru: `settings.default_language`, `users.profile_photo`, `customers.sales_id`, `tickets.assigned_employee_id`, `technician_schedules.technician_employee_id`.

## Setelah deploy
1. Login ulang bila ingin default language langsung mengikuti setting terbaru.
2. Buka Pengaturan → Karyawan, lalu lengkapi Departemen dan Posisi untuk akun yang sudah ada.
3. Set kategori posisi Sales untuk karyawan sales agar muncul di form Pelanggan.
4. Set kategori Technical Support/NOC untuk teknisi agar dipakai pada Ticket dan Jadwal Teknisi.
5. Tambahkan rekening aktif di Pengaturan → Bank agar tampil pada faktur.
