# MikroTik NMS v2 + NOC Dashboard

Modul NMS lama (`/network/monitor`) dan NOC Terpadu (`/noc`) sudah digantikan oleh:

- **`/nms`** — NOC Dashboard (router health, bandwidth WAN real-time, sync progress, live PPP log, FO-cut & flapping alert)
- **`/nms/secrets`** — PPP Secrets (Synced / Unsynced, Smart Sync preview → commit, Map to Customer, Isolir / Un-isolir / Kick / Ping / Lock MAC, bulk per site)

Dokumentasi lengkap: [`docs/NMS-V2-ARCHITECTURE.md`](docs/NMS-V2-ARCHITECTURE.md) · DDL: [`docs/nms-v2-schema.sql`](docs/nms-v2-schema.sql)
