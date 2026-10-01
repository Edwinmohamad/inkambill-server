# SPV Operations — WAHA + n8n + INKAMBILL

Modul ini menjadikan grup WhatsApp operasional sebagai antarmuka ringan untuk teknisi/admin, sedangkan INKAMBILL tetap menjadi source of truth untuk tiket, aktivitas, timeline, dan KPI.

## Arsitektur

WA Group → WAHA → n8n `06-wa-ticket-bot.json` → `/api/n8n/wa/command` → parser command + natural language → Ticket/Activity/KPI.

Workflow `08-spv-operations-supervisor.json` berjalan terjadwal untuk reminder, escalation, morning check, midday check, dan daily report.

## Cara kerja pesan natural

Bot hanya memproses grup yang terdaftar di `WA_TICKET_GROUP_IDS` dan hanya menerima pengirim yang cocok dengan nomor HP karyawan aktif.

Contoh yang dipahami:

- `rumah evi KBG los merah dari tadi` → deteksi gangguan, resolve pelanggan, cek tiket aktif, buat/konfirmasi tiket.
- `jon otw ke rumah asep sekarang` → update stage tiket aktif Asep ke OTW dan assign ke Jon bila jelas.
- `sudah sampai lokasi` → ON_SITE untuk tiket yang sedang menjadi konteks grup/PIC.
- `lagi proses ganti konektor` → WORKING + catatan.
- `udah normal` → RESOLVED.
- `hujan tunggu reda` → catatan blocker + hold reminder sementara.
- `besok ada PSB di KBG` → tawarkan pencatatan aktivitas PSB.
- `maintenance ODP KRW 04 malam ini` → tawarkan pencatatan maintenance.

Jika confidence rendah atau nama pelanggan ambigu, bot tidak melakukan perubahan otomatis. Bot meminta penegasan atau diam.

Command lama `#buat`, `#update`, `#close`, dan seterusnya tetap didukung sebagai fallback deterministik.

## Workflow stage tiket

`OPEN → ASSIGNED → OTW → ON_SITE → WORKING → RESOLVED → VERIFIED → CLOSED`

Tiket yang belum `CLOSED` tetap dipantau supervisor. Status lama `open/progress/pending/closed` tetap dipertahankan agar UI lama dan laporan tidak rusak.

## Reminder supervisor

Default rule:

- OPEN 15 menit
- ASSIGNED 30 menit
- OTW 60 menit
- ON_SITE 90 menit
- WORKING 120 menit
- RESOLVED 60 menit
- VERIFIED 60 menit

Reminder tidak dikirim terus-menerus. Cooldown default: 30 menit, lalu 60 menit, lalu 120 menit. Tiket yang sudah CLOSED langsung keluar dari queue.

Semua threshold dapat diubah dari `.env` menggunakan variabel `SPV_*_REMINDER_MIN`.

## Daily SPV

Workflow n8n mengirim:

- 08:00 Morning Check + pertanyaan aktivitas hari ini
- 13:00 Midday Check
- 18:00 Daily Ops Report
- setiap 15 menit menjalankan supervisor cycle; backend hanya mengirim reminder bila rule terpenuhi

## Operations Center

Menu `/operations` menyediakan:

- tiket belum close
- tiket over SLA
- tiket tanpa update >= 1 jam
- filter periode, site, PIC, activity type, status, stage
- ringkasan per site
- aktivitas PSB / installation / maintenance / migration / survey / follow-up
- timeline detail per activity
- manual activity create/update

## KPI

KPI teknisi sekarang menggunakan metrik operasional tambahan:

- tiket closed
- disiplin update
- pencapaian SLA
- aktivitas Operations Center selesai
- job teknisi
- piket

Perubahan stage tiket dan status activity menulis event ke `team_kpi_events` agar audit dan KPI berasal dari event nyata.

## Setup

1. Deploy overlay dan restart INKAMBILL agar schema V59/V60 dibuat otomatis.
2. Pastikan nomor WhatsApp setiap teknisi/admin terisi di Pengaturan → Karyawan.
3. Set `WA_TICKET_GROUP_IDS` ke group id operasional (`...@g.us`).
4. Import `n8n/06-wa-ticket-bot.json` dan `n8n/08-spv-operations-supervisor.json`.
5. Pada kedua workflow, isi alamat INKAMBILL/WAHA di node Config.
6. Gunakan credential Header Auth yang sama seperti bot lama:
   - `INKAMBILLING n8n Token` → header `X-N8N-TOKEN`
   - `WAHA API Key` → header `X-Api-Key`
7. Aktifkan workflow.

## Safety

- `message_id` WA dipakai sebagai idempotency key.
- Pesan dari nomor non-karyawan di grup diabaikan.
- Grup yang tidak di-whitelist diabaikan.
- Customer ambigu tidak di-auto-link.
- Tiket duplikat pelanggan aktif dicegah.
- Chat biasa tanpa intent operasional tidak dibalas.
- AI/parser tidak menjadi source of truth; perubahan final selalu divalidasi ke database INKAMBILL.
