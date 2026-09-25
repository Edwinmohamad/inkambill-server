# WhatsApp CRM — Web Inbox 2-Arah, Broadcast & Engine Anti-Ban (v1.30)

Modul ini dibangun di atas WA Gateway (WAHA) yang sudah ada. **Tidak ada tabel/kolom lama yang dihapus**;
seluruh perubahan skema bersifat aditif (`services/waCrmSchema.js`, dijalankan otomatis saat boot).

## Menu baru

| Menu | URL | Akses |
|---|---|---|
| WA Inbox (3 kolom, realtime) | `/wa-inbox` | izin Billing / Support / Pelanggan / Settings |
| Broadcast selektif & terjadwal | `/wa-gateway/broadcast` | Admin + izin Billing/Support/Pelanggan, fitur *WA Blast Massal* harus aktif |
| Anti-Ban & Antrean, Balasan Cepat, Template Resmi | `/wa-gateway#antiban`, `#quickreply`, `#template` | lihat semua; ubah = Master Admin |

## 1. Template resmi

Tersimpan di tabel `wa_templates` (dapat diedit, tombol *Pakai naskah resmi* mengembalikan teks standar):
`reminder` (H-3/H-1), `isolation`, `outage`, `receipt`.

Variabel: `{nama_pelanggan} {id_pelanggan} {paket_layanan} {nominal_tagihan} {tanggal_jatuh_tempo} {nama_bank}
{nomor_rekening} {nama_pemilik_rekening} {detail_gangguan} {estimasi_selesai} {nomor_invoice}`.
Variabel lama (`{nama} {kode} {nominal} {no_faktur} {jatuh_tempo} {periode} {metode} {referensi} {sisa}`) tetap jalan.

Rekening untuk `{nama_bank}` dkk. dipilih di **WA Gateway → Template → Rekening Tujuan Transfer**
(default: rekening *bank_transfer* aktif pertama di Pengaturan → Bank).

**Spintax**: `{Yth.|Kepada Yth.} Bapak/Ibu {nama_pelanggan}` → satu pilihan acak per pesan (mendukung nested).
Variabel diganti lebih dulu, jadi nilai data pelanggan tidak pernah ikut di-*spin*.

## 2. Broadcast

* Filter: status tagihan (Aktif, H-3, H-1, Menunggak, Terisolir), Site, Cluster, Router POP, OLT, VLAN, Paket, pencarian.
* Pilih manual per baris / *Pilih semua hasil* / *Batalkan pilihan*; mode target "semua hasil filter" atau "hanya dipilih".
* **Direct Send** atau **Scheduled** (tanggal & jam WIB). Pesan terjadwal disimpan dengan `next_attempt_at` = jadwal,
  cron tiap menit mengubah status kampanye (`scheduled → running → completed`).
* Kampanye bisa dijeda / dilanjutkan / dibatalkan. Maksimal 1000 penerima per broadcast.
* OLT & VLAN pelanggan memakai kolom baru opsional `customers.olt_id` dan `customers.vlan`.

## 3. Engine Anti-Ban (`services/waAntiBanService.js`)

| Lapisan | Default | Catatan |
|---|---|---|
| Jeda acak antar pesan | 5–15 dtk | berlaku untuk semua pesan |
| Long pause | 60–120 dtk tiap 20 pesan massal | |
| Typing simulation | 2–4 dtk (`/api/startTyping`) | dilewati otomatis bila engine WAHA tidak mendukung |
| Read simulation | `sendSeen` sebelum membalas | |
| Jam operasional | 08.00–17.00 WIB | **hanya pesan massal**; di luar jam tetap `queued` dan jalan esok hari |
| Kuota | 80 pesan massal / jam (atur 50–100) | |
| Auto-pause | rate limit (429/spam/banned), unauthorized (401/403), sesi terputus | pesan dikembalikan ke antrean, alert ke Admin (notifikasi + banner). Pause karena *terputus* lanjut otomatis saat WA tersambung; lainnya dilanjutkan manual di tab Anti-Ban |
| Opt-out | balasan `STOP`, `BERHENTI`, `UNSUBSCRIBE`, `UNREG` | masuk `wa_blacklist`, pesan massal yang masih antre dibatalkan; balasan `MULAI` membuka kembali |

Pesan massal = `broadcast, blast, auto_reminder, isolation_notice, outage_notice`.
Balasan inbox, bot, kirim manual, tanda terima, dan alert jaringan ke staf tidak dibatasi jam kerja/kuota
(tetap kena jeda acak) dan diprioritaskan di depan pesan massal.

Status antrean `wa_messages.status`: `pending_approval → queued (pending) → processing → sent | failed | cancelled | rejected`.
Pesan yang tertinggal `processing` saat app restart ditandai `failed` (status tidak pasti) agar tidak terkirim dobel.

## 4. Web Inbox

* Pesan masuk diterima lewat webhook WAHA yang sudah ada (`/api/waha/webhook`, event `message` & `message.ack`).
  Pesan grup/status diabaikan; nomor dicocokkan ke `customers.whatsapp_normalized`, atau ditautkan manual dari sidebar.
* Media (foto bukti transfer, PDF) disimpan di `storage/wa-media/` dan hanya bisa dibuka user yang login.
* Kategori otomatis: *Pembayaran* (foto/PDF, kata "bukti/transfer/bayar"), *Gangguan* (kata "lemot/mati/los/…").
* Bot auto-responder (per percakapan): konfirmasi bukti diterima, info rekening, info tagihan, laporan gangguan,
  balasan di luar jam kerja. Cooldown 2 menit. Balasan manual admin → mode *Human Intervened* 30 menit.
* Catatan internal (latar kuning) tidak pernah dikirim ke WhatsApp.
* Penugasan ke admin / Divisi Keuangan, Helpdesk, Teknis (admin tujuan mendapat notifikasi).
* **Collision detection**: indikator "X juga membuka / sedang mengetik" via WebSocket `/ws/wa-inbox`
  (paket `ws`; autentikasi memakai cookie sesi login). Bila WebSocket putus, halaman otomatis memakai polling 12 dtk.
* Slash command: ketik `/` → `/rekening`, `/proses`, `/isolir`, `/tagihan` (kelola di tab Balasan Cepat).

### Power action "Verifikasi & Buka Isolir"
1. Bukti dari chat → pembayaran transfer `pending` (atau memakai pengajuan pending yang sudah ada).
2. **Master Admin**: approval langsung dengan guard yang sama persis dengan menu Pembayaran
   (`services/paymentVerificationService.js` — dipakai juga oleh `POST /payments/:id/verify`), tagihan → LUNAS, jurnal kas.
   Non-Master-Admin: berhenti di pengajuan *menunggu approval* (kebijakan keuangan tidak dilewati).
3. Bila tidak ada tagihan terbuka lagi: buka isolir MikroTik — REST equivalent dari
   `/ppp secret set [find name=X] disabled=no` dan `/ip firewall address-list remove [find address=X list=ISOLIR]`
   (`networkService.unisolateCustomer`, nama list: env `MIKROTIK_ISOLIR_LIST`).
4. Template *receipt* dikirim ke pelanggan.

Chat-to-Ticket membuat tiket `source='whatsapp'` (5 pesan terakhir jadi deskripsi bila kosong) dan memicu notifikasi grup teknisi yang sudah ada.

## Catatan deploy

1. `npm install` (dependency baru: `ws`) lalu restart app — skema dibuat otomatis.
2. **Reverse proxy** (Nginx/CasaOS/Cloudflare Tunnel) harus meneruskan WebSocket untuk path `/ws/wa-inbox`
   (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`). Tanpa itu inbox tetap jalan via polling.
3. Agar WAHA mengirim event `message.ack` (status centang), sesi perlu dinyalakan ulang sekali dari app
   (Logout/Connect, atau biarkan watchdog saat sesi berikutnya restart) supaya daftar webhook diperbarui.
4. Kirim gambar/dokumen dari inbox memakai `/api/sendImage` & `/api/sendFile` — di WAHA Core sebagian engine
   hanya mendukung teks; bila gagal, pesan ditandai gagal dengan pesan error dari WAHA.
5. Pemberitahuan isolir otomatis dibuat sebagai batch *menunggu konfirmasi Admin* (bisa dimatikan di tab Anti-Ban).

## Uji

`npm run test:wa-crm` — template/Spintax, jam kerja, klasifikasi auto-pause, prioritas inbox, blacklist,
rate-limit pause/resume, ingest inbox + opt-out, serta skenario auto-reconnect.
