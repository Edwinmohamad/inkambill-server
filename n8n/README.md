# Workflow n8n INKAMBILLING

Workflow di folder ini tidak menyimpan kredensial. Import JSON ke n8n lalu isi environment variable:

- `INKAMBILLING_URL` — contoh `https://billing.example.com`
- `INKAMBILLING_N8N_TOKEN` — harus sama dengan `N8N_API_TOKEN` di server

Endpoint internal memakai token `X-N8N-TOKEN` dan idempotency key, sehingga retry n8n tidak menggandakan transaksi.

Workflow yang tersedia:

1. `01-inventory-movement.json` — webhook pergerakan stock + low-stock notification dari server.
2. `02-piket-photo-proof.json` — webhook foto piket, simpan binary ke volume n8n, lalu catat metadata.
3. `03-ticket-lifecycle.json` — webhook create/update ticket dan notifikasi dapat diteruskan ke node WhatsApp/Telegram.
4. `04-auto-billing-reminder.json` — cron pengingat tagihan melalui queue WA Gateway.
5. `05-auto-isolate.json` — cron isolir billing harian; node sengaja mengirim `apply=true`.
6. `06-wa-ticket-bot.json` — bot tiket WhatsApp untuk teknisi (WAHA → n8n → `/api/n8n/wa/command` → balasan via WAHA). Tidak memakai env: isi node **Config** + 2 credential Header Auth (`X-N8N-TOKEN`, `X-Api-Key`). Panduan lengkap: `docs/WA-TICKET-BOT.md`.

Untuk workflow foto, pasang volume persistent pada n8n agar file di `/data/piket` tidak hilang saat container dibuat ulang.
