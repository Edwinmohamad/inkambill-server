# INKAMNET SPV Operations — Roadmap Implementasi

## Tahap 1 — Foundation data & API (SELESAI pada patch ini)
- Menambah state supervisor tiket tanpa merusak status tiket lama.
- Menambah event timeline supervisor tiket.
- Menambah activity ledger terstruktur untuk Gangguan, PSB, Instalasi, Maintenance, Migrasi, Survey, Follow-up, dan aktivitas lain.
- Menambah anggota/PIC per aktivitas.
- Menambah append-only KPI event ledger. KPI disimpan sebagai fakta/event, bukan ranking otomatis.
- Menambah endpoint internal n8n untuk create/update aktivitas, update stage tiket, catatan supervisor, dan snapshot tiket aktif.
- Semua endpoint n8n tetap dilindungi middleware `X-N8N-TOKEN` yang sudah ada.
- Idempotency tetap memakai `n8n_webhook_events` / `source_message_id` agar retry tidak menggandakan data.

## Tahap 2 — Operations Center Web
- Menu Operations/Activity Center.
- Timeline semua aktivitas dari WA dan Web.
- Filter tanggal, bulan, Site, PIC, jenis aktivitas, status, sumber.
- Detail tiket dengan stage: OPEN → ASSIGNED → OTW → ON_SITE → WORKING → RESOLVED → VERIFIED → CLOSED.
- Dashboard backlog dan tiket tanpa update.

## Tahap 3 — WAHA + n8n Natural Language Bot
- Dengarkan hanya grup WA operasional yang diizinkan.
- Validasi sender ke tabel employees.
- Intent: gangguan, PSB, instalasi, maintenance, migrasi, survey, update pekerjaan, kendala, obrolan biasa.
- AI hanya mengekstrak maksud/entity. Rule engine + database yang memutuskan aksi final.
- Confidence gate: high → usulkan tindakan; medium → tanya klarifikasi; low → diam.
- Context window pendek untuk memahami beberapa pesan berurutan.

## Tahap 4 — Digital SPV Supervisor
- Supervisor scan berkala terhadap tiket belum CLOSED.
- Reminder kondisional berdasarkan stage + last activity, bukan spam interval buta.
- Cooldown, hold/snooze saat ada kendala, dan escalation jika tidak ada update / SLA lewat.
- Briefing pagi, midday check, dan daily report ke grup/SPV.

## Tahap 5 — KPI Team Integration
- KPI dihitung dari event faktual: response time, accept, OTW, onsite, working, resolved, closed, PSB selesai, maintenance, reopen, SLA breach, update discipline.
- Filter per periode, Site, PIC, dan jenis aktivitas.
- Tidak ada ranking otomatis; dashboard menampilkan metrik faktual agar workload antar-Site tetap bisa dinilai dengan konteks.

## Kompatibilitas Tahap 1
Tahap 1 sengaja tidak mengganti enum `tickets.status` lama. `ticket_supervisor_state` menjadi layer tambahan dan memetakan stage baru ke status lama:
- OPEN / ASSIGNED → `open`
- OTW / ON_SITE / WORKING → `progress`
- RESOLVED / VERIFIED → `pending`
- CLOSED → `closed`

Dengan cara ini halaman Ticketing, WA bot lama, notifikasi, dan KPI lama tetap berjalan selama transisi.
