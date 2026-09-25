# Operasional WhatsApp Personal — SPV, Billing, dan NOC

Workflow ini mengirim pesan **pribadi**, bukan grup. n8n hanya menjadi penjadwal; aplikasi INKAMBILL tetap mengirim melalui antrean WA Gateway agar semua pesan tercatat dan dapat dicoba ulang.

## Routing awal

| Kejadian | Penerima |
| --- | --- |
| Tugas follow-up tagihan | Admin Keuangan |
| Briefing pagi/sore dan eskalasi kritis | SPV |
| Alert KRW/CLM | Jon, Bopung, Agung |
| Alert KBG/Kubang | Jon, Bopung, Ali |
| Alert kritis | Teknisi sesuai Site + SPV |

## Konfigurasi server

Tambahkan ke `.env` aplikasi. Jangan menaruh API key atau token di workflow JSON.

```env
WA_OP_SPV_PHONE=6289664729589
WA_OP_FINANCE_PHONE=6283874092236
WA_OP_TECH_JON_PHONE=6289521469866
WA_OP_TECH_BOPUNG_PHONE=6289519098896
WA_OP_TECH_AGUNG_PHONE=62895400935590
WA_OP_TECH_ALI_PHONE=6282111068115
```

Pastikan konfigurasi WA Gateway di web menunjuk ke WAHA yang aktif. Setelah `.env` diubah, restart aplikasi.

## Import workflow n8n

1. Di n8n, import `n8n/07-operations-private-alerts.json`.
2. Isi environment n8n:
   - `INKAMBILLING_URL=https://inkambill.edwinpxmx.my.id`
   - `INKAMBILLING_N8N_TOKEN=` nilai yang sama dengan `N8N_API_TOKEN` pada aplikasi.
3. Atur timezone workflow/instance menjadi `Asia/Jakarta`.
4. Jalankan tiap node HTTP satu kali untuk tes, lalu aktifkan workflow.

Jadwal bawaan: briefing SPV 08.00 dan 17.30, tugas follow-up billing 08.15 WIB. Alert NOC tidak dijadwalkan; sistem atau workflow NMS memanggil endpoint saat kejadian terjadi.

## Endpoint alert NOC dari n8n

Gunakan HTTP Request dengan `POST` ke:

```text
https://inkambill.edwinpxmx.my.id/api/n8n/operations/noc-alert
```

Header wajib: `X-N8N-TOKEN` dan `X-Idempotency-Key` unik. Contoh JSON:

```json
{
  "event_key": "router-down:KRW:router-01:2026-09-25T08:00",
  "site": "KRW",
  "title": "Router KRW-01 tidak merespons",
  "detail": "Tidak ada respons ping selama 8 menit.",
  "priority": "critical",
  "ticketCode": "INC-20260925-001"
}
```

Panggilan dapat diulang aman dengan `event_key`/`X-Idempotency-Key` yang sama.
