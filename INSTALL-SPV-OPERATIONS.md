# INKAMBILL SPV Operations — Install & Smoke Test

Overlay ini mencakup Phase 1–5: foundation, Operations Center, WA natural-language ops bot, SPV reminder/escalation, dan KPI event integration.

## 1. Pasang overlay
1. Backup repo/database.
2. Extract ZIP ke root repository `inkambill-server` lalu replace file yang sama.
3. Review Changes di GitHub Desktop, commit, push/pull ke server.
4. Jalankan `npm install` bila diperlukan (patch ini tidak menambah dependency baru).
5. Restart aplikasi INKAMBILL. Schema V59/V60 dibuat otomatis secara additive.

## 2. Environment penting
Gunakan konfigurasi WA ticket yang sudah ada dan pastikan `WA_TICKET_GROUP_IDS` berisi ID grup operasional yang benar.

Optional tuning SPV tersedia di `.env.example`:
- `SPV_OPEN_REMINDER_MIN`
- `SPV_ASSIGNED_REMINDER_MIN`
- `SPV_OTW_REMINDER_MIN`
- `SPV_ONSITE_REMINDER_MIN`
- `SPV_WORKING_REMINDER_MIN`
- `SPV_RESOLVED_REMINDER_MIN`
- `SPV_VERIFIED_REMINDER_MIN`
- `SPV_REMINDER_COOLDOWN_1_MIN`
- `SPV_REMINDER_COOLDOWN_2_MIN`
- `SPV_REMINDER_COOLDOWN_3_MIN`
- `SPV_SLA_CRITICAL_MIN`
- `SPV_SLA_HIGH_MIN`
- `SPV_SLA_MEDIUM_MIN`
- `SPV_SLA_LOW_MIN`

## 3. Operations Center
Buka `/operations` menggunakan user yang punya permission `support`.
- Atur PIC utama/backup per site.
- Uji create aktivitas manual.
- Uji ubah status aktivitas dan ticket stage.

## 4. n8n
Import/update:
- `n8n/06-wa-ticket-bot.json`
- `n8n/08-spv-operations-supervisor.json`

Di setiap Config node, isi base URL INKAMBILL/WAHA sesuai server Anda. Gunakan credential Header Auth yang sudah digunakan workflow WAHA existing. Aktifkan workflow setelah test manual sukses.

## 5. Smoke test grup WhatsApp
Dari nomor teknisi/admin yang terdaftar dan grup yang diizinkan:
1. Kirim pesan natural contoh: `rumah evi los merah`.
2. Jika bot meminta konfirmasi, balas `iya`.
3. Pastikan ticket muncul di INKAMBILL dan Operations Center.
4. Kirim/reply: `otw`, `sudah sampai`, `lagi proses`, `sudah normal`.
5. Pastikan timeline/stage berubah dan event KPI tercatat.
6. Uji blocker: `hujan, tunggu reda` dan pastikan note/hold tersimpan.
7. Jalankan endpoint SPV cycle dari n8n dan pastikan hanya ticket belum CLOSED yang diremind.
8. Jalankan morning/midday/evening summary dari workflow 08.

## 6. Validasi lokal yang sudah dijalankan
- `npm run validate`
- `npm run test:wa-ticket-bot`
- `npm run test:spv-foundation`
- `npm run test:spv-ops`
- JSON validation workflow 06 dan 08

Semua validasi tersebut lolos pada source patch. Live WAHA/n8n/DB tetap perlu smoke test setelah deploy karena credential, group ID, URL dan data produksi hanya tersedia di server Anda.
