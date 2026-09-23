# Bot Tiket WhatsApp (WAHA + n8n)

Teknisi/staff bisa membuat, mengambil, meng-update, dan menutup tiket langsung dari WhatsApp. Semua perubahan langsung tersimpan di tabel `tickets` / `ticket_updates` yang sama dengan menu **Ticketing** di web, jadi SLA, KPI tim, dan timeline progress tetap satu sumber data.

## Alur

```
Teknisi kirim "#update 123456 60% ganti konektor"
      │
      ▼
WAHA ──webhook (event: message)──► n8n  (workflow 06-wa-ticket-bot.json)
                                     │  cek token URL + pesan diawali "#"
                                     ▼
                     POST {INKAMBILLING_URL}/api/n8n/wa/command   (X-N8N-TOKEN)
                                     │  backend: cek nomor = karyawan aktif, jalankan perintah
                                     ▼
                     { replies: [{ chatId, text, reply_to }] }
                                     │
n8n ──POST {WAHA_URL}/api/sendText──► WAHA ──► balasan ke chat/grup asal

Notifikasi ke grup teknisi / teknisi yang di-assign dikirim langsung oleh backend ke WAHA,
baik untuk aksi dari WhatsApp maupun dari web (tiket baru, assign, pending, close, buka kembali).
```

## Daftar perintah

| Perintah | Fungsi |
|---|---|
| `#help` | Daftar perintah |
| `#buat <kode_pelanggan\|-> [prioritas] <keluhan>` | Buat tiket. Baris ke-2 dst = deskripsi. Prioritas: `rendah/sedang/tinggi/kritis` (default sedang). Foto dengan caption ini ikut jadi lampiran tiket. |
| `#list [open\|progress\|pending\|semua]` | Daftar tiket (maks 15) |
| `#tiketku` | Tiket aktif yang ditugaskan ke saya |
| `#cek <tiket>` | Detail tiket + 3 update terakhir |
| `#ambil <tiket>` | Assign ke diri sendiri, status Open → Proses |
| `#assign <tiket> <kode_karyawan>` | Tugaskan ke karyawan lain (dia dapat WA pribadi) |
| `#update <tiket> [50%] <catatan>` | Progress harian (status Proses). Persen wajib pakai tanda `%`. |
| `#pending <tiket> <alasan>` | Status Pending |
| `#close <tiket> [catatan]` | Tutup tiket (100%) |
| `#buka <tiket> <alasan>` | Buka kembali tiket yang sudah Closed |
| `#prioritas <tiket> <level>` | Ganti prioritas |
| `#idgrup` | Tampilkan ID grup (untuk setup) |

`<tiket>` boleh kode lengkap `TT-20260923-123456` atau cukup 6 digit terakhir `123456`. Foto yang dikirim dengan caption `#update` / `#pending` / `#close` tersimpan sebagai bukti progress dan tampil di timeline web (dengan label "via WhatsApp").

Contoh:

```
#buat CDS-0012 tinggi Internet mati sejak pagi
Lampu LOS merah, sudah restart ONT
```

## Hak akses

- Pengirim harus **karyawan aktif** dengan nomor HP terisi di **Pengaturan → Karyawan** (format bebas: `0812…`, `+62 812…`).
- Karyawan tanpa akun login tetap bisa; di web tercatat atas nama karyawannya.
- Perintah di grup hanya diproses dari grup di `WA_TICKET_GROUP_IDS`. Di grup, pesan dari nomor tak dikenal dan hashtag biasa (`#semangat`) diabaikan tanpa balasan.
- Pesan yang sama tidak diproses dua kali (idempotent per ID pesan WhatsApp), jadi retry WAHA/n8n aman.

## Setup

### 1. Server INKAMBILLING (`.env`)

```env
N8N_API_TOKEN=<sudah ada, dipakai n8n>
WA_TICKET_GROUP_IDS=            # diisi di langkah 5
WA_TICKET_NOTIFY=true
WAHA_EXTRA_WEBHOOK_URLS=https://<n8n-anda>/webhook/inkambilling/wa-ticket-bot?token=<WA_BOT_WEBHOOK_TOKEN>
```

`WAHA_EXTRA_WEBHOOK_URLS` penting: saat app menyalakan sesi WAHA, app **menimpa** daftar webhook sesi. Tanpa baris ini, webhook n8n hilang setiap app restart.

Deploy. Kolom baru (`tickets.source`, `ticket_updates.source`, `ticket_updates.actor_employee_id`) dibuat otomatis oleh `ensureV52Schema()` saat startup.

### 2. Nomor HP karyawan

Isi nomor WhatsApp setiap teknisi di **Pengaturan → Karyawan**.

### 3. Environment variable n8n

| Variabel | Contoh |
|---|---|
| `INKAMBILLING_URL` | `http://192.168.x.x:3301` (alamat lokal jika n8n satu server/jaringan) |
| `INKAMBILLING_N8N_TOKEN` | sama dengan `N8N_API_TOKEN` di server |
| `WAHA_URL` | `http://192.168.x.x:3000` |
| `WAHA_API_KEY` | API key WAHA |
| `WAHA_SESSION` | `default` |
| `WA_BOT_WEBHOOK_TOKEN` | string acak, buat dengan `openssl rand -hex 24` |

Workflow memakai `$env`. Di n8n versi baru akses `$env` dari node bisa diblokir; set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` di container n8n, atau ganti nilainya langsung di node.

### 4. Import workflow

Import `n8n/06-wa-ticket-bot.json` → **Activate** → salin **Production URL** webhook-nya, lalu tambahkan `?token=<WA_BOT_WEBHOOK_TOKEN>`. URL inilah yang dipakai di `WAHA_EXTRA_WEBHOOK_URLS`.

Token di URL wajib: webhook n8n bisa diakses publik, dan tanpa token siapa pun bisa mengirim payload palsu seolah-olah dari nomor teknisi.

Pastikan WAHA mengirim event **`message`** saja ke webhook ini (bukan `message.any`), supaya pesan bot sendiri tidak ikut masuk.

### 5. Grup teknisi

1. Masukkan nomor WA bot ke grup teknisi.
2. Dari nomor karyawan terdaftar, kirim `#idgrup` di grup itu → bot membalas `ID grup ini: 1203…@g.us`.
3. Isi ke `WA_TICKET_GROUP_IDS` (pisahkan koma untuk >1 grup), lalu restart app (`docker compose up -d`).

### 6. Tes

Chat pribadi ke nomor bot: `#help`, lalu `#buat - tinggi tes bot`, cek tiket muncul di menu Ticketing.

## Troubleshooting

| Gejala | Cek |
|---|---|
| Tidak ada balasan sama sekali | Execution di n8n masuk? Jika tidak: webhook WAHA belum mengarah ke n8n / event bukan `message`. Jika masuk tapi berhenti di IF: token URL salah atau `$env` diblokir. |
| "Nomor … belum terdaftar" | Nomor HP karyawan belum diisi / karyawan nonaktif. |
| "Nomor pengirim tidak dapat dibaca (ID: …@lid)" | WhatsApp memakai LID dan versi WAHA belum punya endpoint `/api/{session}/lids`. Update WAHA. |
| Di grup tidak dibalas | Grup belum ada di `WA_TICKET_GROUP_IDS`, atau app belum di-restart setelah `.env` diubah. |
| Foto tidak tersimpan | Backend download foto dari `WAHA_BASE_URL` + path media; pastikan `WAHA_API_KEY` benar dan WAHA menyimpan file media (Core: `WHATSAPP_DOWNLOAD_MEDIA=true`). |
| Webhook n8n hilang setelah app restart | `WAHA_EXTRA_WEBHOOK_URLS` belum diisi. |

## File terkait

- `services/waTicketParser.js`: parser perintah (tanpa DB, mudah dites)
- `services/waTicketCommandService.js`: eksekusi perintah, cek hak akses, foto
- `services/ticketWaNotifyService.js`: notifikasi ke grup/teknisi (dipakai web & bot)
- `services/wahaClient.js`: `sendToChat`, `downloadMedia`, `resolveLidToPhone`, webhook tambahan
- `routes/n8n.js`: endpoint `POST /api/n8n/wa/command`
- `n8n/06-wa-ticket-bot.json`: workflow n8n
- `scripts/test-wa-ticket-bot.js`: `npm run test:wa-ticket-bot`
