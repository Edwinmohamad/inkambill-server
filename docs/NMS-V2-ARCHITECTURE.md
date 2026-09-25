# INKAMNET MikroTik NMS v2 + NOC Dashboard

Rebuild total modul **MikroTik NMS** dan penggabungannya dengan **NOC Dashboard**. Menu lama **NOC Terpadu** (`/noc`) dan **Network Map** (`/acs/map`) dihapus total. Monitoring ONT (`/acs`) tetap ada.

| URL | Isi | Permission |
|---|---|---|
| `/nms` | NOC Dashboard: router health, bandwidth WAN, sync donut, counter pelanggan, live log, flapping, banner FO-cut | `network` |
| `/nms/secrets` | PPP Secrets: tab Synced / Unsynced, Smart Sync, Map to Customer, aksi inline, bulk | `network` (lihat), `network_control` atau Admin (aksi) |
| `/network/monitor` | Redirect 301 ke `/nms/secrets` (bookmark lama tetap jalan) | — |

---

## 1. Menu cleanup

| Dihapus | Detail |
|---|---|
| NOC Terpadu | `routes/noc.js`, `views/noc/index.ejs`, `public/js/noc.js`, mount `/noc` di `app.js`, polling `/noc/api/summary` di `performance.js`, link sidebar & menu mobile |
| Network Map | handler `GET /acs/map`, `POST /acs/map/nodes`, `/acs/map/links`, `…/delete`, `views/acs/map.ejs`, tombol "Network Map" di halaman ONT/Rekonsiliasi, label sidebar "Network Map & ONT" → "Monitoring ONT" |
| NMS lama | `views/network/monitor.ejs`, `public/js/nms.js`, blok NMS di `public/js/app.js`, `services/nmsService.js`, `services/mikrotikPppoeService.js` (tidak terpakai), endpoint `/network/api/snapshot`, `/network/secrets*`, `/network/smart-sync`, `/network/api/smart-sync-plan` |

Semua file dipindah ke `_to_delete/v2-nms-rebuild/` (sesi tidak punya izin hapus). Setelah yakin, hapus foldernya lewat File Explorer. Tabel `network_map_nodes` / `network_map_links` **tidak** di-drop (data aman); perintah DROP opsional ada di `docs/nms-v2-schema.sql`.

**RBAC:** tidak ada permission khusus NOC/Map yang harus dicabut (sebelumnya diatur oleh `network`). Ditambah permission baru **`network_control`** ("Kontrol Jaringan (Isolir/Kick/Lock MAC)") di *Pengaturan → Role & Akses*, supaya operator NOC bisa mengisolir tanpa harus berperan Admin. Role Admin/Master Admin selalu boleh.

---

## 2. Struktur kode

```
routes/
  nms.js                  # halaman + REST API + SSE stream (/nms/*)
  n8n.js                  # + POST /api/n8n/nms/ppp-event (webhook RouterOS/n8n)
  network.js              # sisa: Infrastructure Hub, backup, telemetry history, isolate dari halaman pelanggan
services/nms/
  schema.js               # ensureNmsV2Schema() idempotent + purge retensi
  rosApi.js               # gateway RouterOS REST: circuit breaker + maks 2 request paralel/router
  cache.js                # TTL cache in-process (interface siap diganti Redis)
  eventBus.js             # EventEmitter → SSE
  matching.js             # PURE: normalisasi & rencana Smart Sync (unit-tested)
  analytics.js            # PURE: parser RouterOS, diff /ppp/active, FO-cut, flapping (unit-tested)
  secretStore.js          # mirror /ppp/secret → ppp_secrets, query tab, counters
  smartSync.js            # preview (dry-run) → commit, manual map/unmap, autocomplete pelanggan
  control.js              # isolir / un-isolir / kick / ping / lock MAC / ganti profile / bulk + audit
  poller.js               # scheduler polling, state live, alert engine, ingest webhook
  dashboard.js            # agregasi payload NOC Dashboard
services/auditService.js  # audit() + details(JSON) + site_id
services/networkService.js# isolate/unisolate billing kini lewat engine NMS bila secret sudah ter-mirror
views/nms/{_bar,dashboard,secrets}.ejs
public/css/nms-noc.css    # tema NOC dark, di-scope .nms-noc
public/js/nms-common.js   # api(), toast, modal, SSE+fallback polling, Select Site global
public/js/nms-noc.js      # widget dashboard (Chart.js 4.4.7 — sudah dipakai modul lain)
public/js/nms-secrets.js  # tabel, bulk, Smart Sync, Map to Customer
scripts/test-nms-v2.js    # 46 regression checks (tanpa DB)
```

**Alur data**

```
RouterOS REST ──(rosApi: breaker, 2 in-flight)──▶ poller ──▶ memori (live) ──▶ eventBus ──▶ SSE /nms/api/stream ──▶ browser
      ▲                                           │  └──▶ nms_router_state (cache offline)
      │ aksi (control.js)                         ├──▶ ppp_secrets (mirror + flag online)
RouterOS on-up/on-down ─▶ /api/n8n/nms/ppp-event ─┴──▶ nms_ppp_events ─▶ FO-cut / flapping ─▶ nms_alerts
```

**Beban ke MikroTik** (default, bisa diatur env): telemetry 15 s = 2 GET ringan (`/system/resource`, counter satu interface WAN), `/system/health` tiap ±60 s, `/ppp/active` tiap 20 s, `/ppp/secret` tiap 5 menit. Bandwidth dihitung dari selisih byte counter (tidak memakai `monitor-traffic` yang lebih berat). Router yang timeout tidak dipanggil ulang selama masa backoff (15 s → maks 5 menit). Tick yang belum selesai tidak ditumpuk. Seluruh browser memakai **satu** poller server — membuka 10 layar NOC tidak menambah beban router.

---

## 3. Skema database

DDL lengkap: **`docs/nms-v2-schema.sql`**. Ringkasan penyesuaian terhadap spesifikasi:

| Spesifikasi | Implementasi | Alasan |
|---|---|---|
| `id UUID` | `BIGINT UNSIGNED AUTO_INCREMENT` | Konsisten dengan `customers/routers/sites`; FK langsung jalan tanpa migrasi |
| `ppp_secrets.username UNIQUE` | `UNIQUE(router_id, username)` | RouterOS menjamin unik per router; dua site boleh punya username sama |
| `ppp_secrets.password` | `password_enc` (AES-256-GCM, `ROUTER_CREDENTIAL_KEY`) | Password PPP tidak disimpan plaintext & tidak pernah dikirim ke browser |
| `customers` (tabel baru) | Tabel existing dipakai; `service_status` VIRTUAL = active/isolated/suspended | Menghindari dua sumber kebenaran; kolom tidak dinamai `status` agar JOIN lama tidak ambigu |
| `audit_logs.target_type/target_id/details` | `entity_type/entity_id` existing + kolom baru `details`, `site_id` | Log lama tetap terbaca di menu Log Aktivitas |
| — | `original_profile`, `is_isolated`, `is_online`, `active_*`, `removed_on_router_at` | Dibutuhkan un-isolir, status online, dan histori saat secret dihapus di router |

Tabel baru pendukung: `nms_ppp_events` (live log/flapping/FO-cut, retensi 30 hari), `nms_router_state` (cache offline), `nms_alerts`. Kolom baru: `routers.wan_interface`.

---

## 4. Smart Sync Engine

1. **Mirror**: `/ppp/secret` tiap router → `ppp_secrets`. Link billing lama (`customers.pppoe_username` + router/site sama) langsung di-import sebagai `synced` (`match_method = pppoe_username`) — itu data existing, bukan tebakan.
2. **Preview (dry-run)** `GET /nms/api/sync/preview?site=&refresh=1` — tidak menulis DB. Pencocokan **case-insensitive**: username PPP = `customer_code` **atau** `name`, hanya di **site yang sama**. Juga cocok bila berbeda spasi/tanda baca (`budi.santoso` = `Budi Santoso`). Rencana disimpan 10 menit dengan `planId`.
3. **Konflik tidak di-auto-link**: 1 secret cocok ke >1 pelanggan, atau 1 pelanggan diklaim >1 secret → masuk daftar konflik untuk *Map to Customer* manual. Secret `[ADMIN]`/`[FREE]` (atau berisi admin/noc/monitor/free/internal) otomatis *exempt*.
4. **Commit** `POST /nms/api/sync/commit {planId, secretIds?}` — tiap pasangan divalidasi ulang di transaksi (`FOR UPDATE`): secret masih unsynced, pelanggan belum terikat, site sama. Menulis `ppp_secrets.customer_id`, `sync_status='synced'`, dan `customers.pppoe_username/router_id` (modul billing & auto-isolir lama tetap bekerja).

---

## 5. Aksi pelanggan

| Aksi | RouterOS | Database |
|---|---|---|
| **Isolir** | `profile=ISOLIR`, tetap enable, simpan profile asal di comment `[inkam:orig=10M]`, drop `/ppp/active` | `is_isolated=1`, `original_profile`, `customers.network_status='isolated'` |
| **Un-isolir** | kembalikan profile asal, `disabled=false`, bersihkan address-list `ISOLIR`, drop sesi (paksa redial) | `is_isolated=0`, `network_status='offline'` (jadi online saat redial) |
| **Kick** | hapus `/ppp/active` saja | flag online di-reset |
| **Ping** | `POST /ping {count:5}` **dari router** (vantage point benar untuk IP PPPoE privat) | badge `avg ms · loss %` inline, diaudit |
| **Lock MAC** | ambil `caller-id` dari sesi aktif → set `caller-id` di secret (bisa dilepas lagi) | `ppp_secrets.caller_id` |
| **Ganti profile** | `profile=X` + drop sesi; bila sedang isolir, hanya "paket asal" yang diganti | `profile` / `original_profile` |

> **Catatan desain isolir:** spesifikasi menyebut ganti profile **dan** `disabled=true`. Kalau secret di-disable, pelanggan tidak bisa redial sama sekali sehingga tidak pernah mendapat IP isolir (halaman pemberitahuan tidak tampil). Karena itu default-nya `NMS_ISOLIR_MODE=profile` (enable + profile ISOLIR). Bila router belum punya profile `ISOLIR`, engine otomatis fallback ke mode `disable`. Set `NMS_ISOLIR_MODE=disable` kalau memang ingin memutus total.

**Bulk:** `POST /nms/api/bulk` — `isolate | unisolate | profile | kick`, berdasarkan checkbox (`secretIds`) atau filter `{siteId, overdueOnly}` (pelanggan dengan invoice lewat jatuh tempo). Selalu ada dry-run penghitung target sebelum eksekusi. Maks 500 per aksi, paralel terbatas 3.

Isolir/buka isolir dari billing (cron auto-isolate, pembayaran, halaman pelanggan) memakai engine yang sama bila secret sudah ter-mirror, jadi semua jalur tercatat di audit & live log.

---

## 6. Alerting & anomaly detection

* **Mass Disconnect / FO Cut** — >`NMS_MASS_THRESHOLD` (10) pelanggan berbeda di satu site logout dalam `NMS_MASS_WINDOW_MS` (120 s) dan belum login kembali → banner merah berkedip: `CRITICAL ALERT: Potential FO Cut / Power Outage at Site [Nama Site] - X Customers Disconnected!`. Auto-resolve ketika ≥80% pelanggan terdampak kembali online dan router site online. Bisa di-ACK (berhenti berkedip).
* **Router down** — 2 polling gagal berturut-turut → banner kritis; resolve otomatis saat router kembali.
* **Flapping** — >`NMS_FLAP_THRESHOLD` (5) login dalam 1 jam per username.
* **Sumber event**: diff `/ppp/active` (default), webhook RouterOS/n8n (real-time), dan opsional poll `/log` untuk *authentication failed* (`NMS_LOG_POLL=1`).

## 7. Keamanan, audit, ketahanan

* Semua aksi (`nms_isolate`, `nms_unisolate`, `nms_kick`, `nms_ping`, `nms_lock_mac`, `nms_unlock_mac`, `nms_profile_change`, `nms_bulk_*`, `nms_smart_sync`, `nms_manual_map`, `nms_unmap`, `nms_secret_refresh`, `nms_set_wan`, `nms_alert_ack`) masuk `audit_logs` dengan user, IP admin, site, target, dan `details` JSON.
* CSRF: fetch mengirim header `X-CSRF-Token` (middleware existing).
* **Router offline**: tidak pernah blank. Badge top-bar `ROUTER UNREACHABLE / OFFLINE (SHOWING CACHED DATA)`, kartu router ditandai *CACHED* + "Last Updated: X mins ago", data diambil dari `nms_router_state` dan `ppp_secrets`. Router lain tetap live.
* **Select Site** global di top-bar NMS memfilter widget, tabel, log, dan stream SSE (disimpan per browser).

---

## 8. Contoh payload API

**`GET /nms/api/sync/preview?site=1`**
```json
{
  "ok": true,
  "plan": {
    "planId": "4d50c8db-2f0e-4c47-9d6b-6f1d6a3b9a10",
    "siteId": 1,
    "createdAt": "2026-09-25T06:25:40.112Z",
    "expiresAt": "2026-09-25T06:35:40.112Z",
    "summary": { "scanned": 4, "matched": 2, "conflicts": 1, "unmatched": 1 },
    "pairs": [
      { "secretId": 1, "username": "BUDI SANTOSO", "siteId": 1, "siteCode": "CLM", "customerId": 1, "customerCode": "CLM-001", "customerName": "Budi Santoso", "matchedOn": "customer_name" },
      { "secretId": 2, "username": "clm-002", "siteId": 1, "siteCode": "CLM", "customerId": 2, "customerCode": "CLM-002", "customerName": "Siti Aminah", "matchedOn": "customer_code" }
    ],
    "conflicts": [
      { "secretId": 7, "username": "andi", "siteId": 1, "siteCode": "CLM", "reason": "multiple_customers",
        "customers": [ { "id": 4, "code": "CLM-004", "name": "Andi" }, { "id": 5, "code": "CLM-005", "name": "Andi" } ] }
    ]
  }
}
```

**`POST /nms/api/sync/commit`** — body `{"planId":"4d50c8db-…","secretIds":[1,2]}`
```json
{
  "ok": true,
  "planId": "4d50c8db-2f0e-4c47-9d6b-6f1d6a3b9a10",
  "siteId": 1,
  "summary": { "planned": 2, "linked": 2, "failed": 0 },
  "results": [
    { "ok": true, "secretId": 1, "username": "BUDI SANTOSO", "customerId": 1, "customerName": "Budi Santoso", "siteId": 1 },
    { "ok": true, "secretId": 2, "username": "clm-002", "customerId": 2, "customerName": "Siti Aminah", "siteId": 1 }
  ]
}
```

**`GET /nms/api/dashboard?site=1`** (dipotong)
```json
{
  "ok": true,
  "data": {
    "generatedAt": "2026-09-25T06:29:43.051Z",
    "siteId": 1,
    "degraded": false,
    "allOffline": false,
    "routers": [{
      "routerId": 1, "name": "CLM-CORE", "siteId": 1, "siteCode": "CLM", "status": "online", "stale": false,
      "lastOkAt": "2026-09-25T06:29:40.004Z", "lastError": null, "activeSessions": 412,
      "telemetry": {
        "uptimeSeconds": 1047600, "cpuPct": 36,
        "memory": { "total": 1000000000, "used": 700000000, "pct": 70 },
        "disk": { "total": 128000000, "free": 60000000, "freePct": 46.9 },
        "health": { "temperature": 47, "voltage": 24.1 },
        "board": "CCR2004-1G-12S+2XS", "version": "7.15.3", "sampledAt": "2026-09-25T06:29:40.004Z"
      },
      "wan": { "interface": "sfp-wan1", "rxBps": 107700000, "txBps": 11900000, "peakRxBps": 117600000, "peakTxBps": 19200000, "running": true,
               "history": [ { "t": 1790317780004, "rx": 107700000, "tx": 11900000 } ] }
    }],
    "customers": { "online": 412, "offline": 23, "isolated": 17, "total": 455 },
    "sync": { "synced": 431, "unsynced": 21, "exempt": 3, "syncedPct": 95.4 },
    "alerts": [{ "id": 9, "type": "mass_disconnect", "severity": "critical", "site_id": 1, "site_code": "CLM",
                 "title": "CRITICAL ALERT: Potential FO Cut / Power Outage at Site Cilame - 12 Customers Disconnected!",
                 "details": { "count": 12, "stillOffline": 12 }, "opened_at": "2026-09-25T06:26:40.000Z", "acknowledged_by": null }],
    "flapping": [{ "site_id": 1, "site_code": "CLM", "username": "clm-002", "reconnects": 6, "secret_id": 2, "customer_name": "Siti Aminah" }],
    "events": [{ "id": 881, "site_code": "CLM", "username": "cust12", "type": "logout", "address": "10.10.0.14", "source": "poll", "at": "2026-09-25T06:28:16.000Z" }]
  }
}
```

**SSE `GET /nms/api/stream?site=1`** (text/event-stream)
```
event: telemetry
data: {"routerId":1,"siteId":1,"status":"online","telemetry":{"cpuPct":41,...},"wan":{"rxBps":98200000,"txBps":12100000,...}}

event: ppp
data: {"routerId":1,"siteId":1,"username":"andi.w","type":"login","address":"10.10.0.9","callerId":"AA:BB:CC:DD:EE:03","at":"2026-09-25T06:30:02.118Z","source":"poll"}

event: alert
data: {"id":9,"type":"mass_disconnect","severity":"critical","siteId":1,"title":"CRITICAL ALERT: Potential FO Cut / Power Outage at Site Cilame - 12 Customers Disconnected!"}
```

**`POST /nms/api/secrets/2/ping`**
```json
{ "ok": true, "result": { "secretId": 2, "username": "clm-002", "address": "10.10.0.3", "sent": 5, "received": 5, "lossPct": 0, "avgMs": 4.12, "minMs": 3, "maxMs": 5, "testedAt": "2026-09-25T06:25:47.367Z" } }
```

**`POST /nms/api/bulk`** — body `{"action":"isolate","filter":{"siteId":1,"overdueOnly":true},"dryRun":true}` → `{"ok":true,"dryRun":true,"action":"isolate","count":14,"secretIds":[...]}`; tanpa `dryRun` → `{"summary":{"action":"isolate","bulkId":"bulk-mugkucmw","total":14,"succeeded":14,"failed":0},"results":[...]}`

**Webhook `POST /api/n8n/nms/ppp-event`** (header `X-N8N-Token`)
```json
{ "router_name": "CLM-CORE", "username": "budi", "event": "logout", "address": "10.10.0.2", "caller_id": "AA:BB:CC:DD:EE:01", "occurred_at": "2026-09-25T13:30:00+07:00" }
```

---

## 9. Setup RouterOS (sekali per router)

1. **User API khusus** (bukan admin):
   ```
   /user group add name=inkam-nms policy=read,write,api,rest-api,test,sensitive,!ftp,!reboot,!policy,!password,!sniff,!romon
   /user add name=inkam-nms group=inkam-nms password=<random> address=<IP server billing>
   ```
   `test` dibutuhkan untuk Ping, `sensitive` untuk membaca password secret (opsional).
2. **Profile isolir**: `/ppp profile add name=ISOLIR local-address=… remote-address=pool-isolir rate-limit=256k/256k` + NAT/redirect ke halaman pemberitahuan.
3. **Event real-time (opsional, disarankan)** — tambahkan di `on-up` / `on-down` setiap PPP profile (termasuk ISOLIR):
   ```
   # on-up
   /tool fetch url="https://billing.inkamnet.id/api/n8n/nms/ppp-event" http-method=post output=none \
     http-header-field="Content-Type: application/json,X-N8N-Token: <N8N_API_TOKEN>" \
     http-data=("{\"router_name\":\"CLM-CORE\",\"username\":\"$user\",\"event\":\"login\",\"address\":\"$\"remote-address\"\",\"caller_id\":\"$\"caller-id\"\"}")
   # on-down: sama, event=logout
   ```
   Tanpa webhook, login/logout tetap terdeteksi lewat diff `/ppp/active` (resolusi 20 detik).
4. Atur interface WAN di Dashboard (ikon ⚙ pada kartu bandwidth) bila auto-detect (comment/nama berisi `wan|uplink|isp|internet`) kurang tepat.

## 10. Environment

| Variabel | Default | Keterangan |
|---|---|---|
| `NMS_POLLER_ENABLED` | `1` | `0` mematikan poller (mis. instance kedua) |
| `NMS_TELEMETRY_MS` / `NMS_ACTIVE_MS` / `NMS_SECRETS_MS` | 15000 / 20000 / 300000 | Interval polling (minimum 10 s / 10 s / 60 s) |
| `NMS_ROUTER_MAX_INFLIGHT` | 2 | Request paralel maksimum per router |
| `NMS_ISOLIR_PROFILE` | `ISOLIR` | Nama profile isolir |
| `NMS_ISOLIR_MODE` | `profile` | `profile` atau `disable` |
| `NMS_DEFAULT_PROFILE` | `default` | Fallback un-isolir bila profile asal tidak diketahui |
| `NMS_MASS_THRESHOLD` / `NMS_MASS_WINDOW_MS` | 10 / 120000 | Deteksi FO cut |
| `NMS_FLAP_THRESHOLD` | 5 | Deteksi flapping (per jam) |
| `NMS_LOG_POLL` | `0` | `1` = baca `/log` untuk auth failed |
| `MIKROTIK_ISOLIR_LIST` | `ISOLIR` | Address-list yang dibersihkan saat un-isolir |

## 11. Verifikasi

* `node scripts/test-nms-v2.js` — 46 checks (matching, parser, anomaly engine, wiring). Sudah masuk `npm run validate:final`.
* Integration test (dijalankan saat pengembangan, tidak di-commit): MariaDB 10.11 + RouterOS REST palsu — mirror secret, import link lama, preview tidak menulis DB, commit + plan kedaluwarsa, guard beda site / pelanggan sudah terikat, isolir→un-isolir (profile & comment), ping, lock MAC, kick, bulk dry-run by site+jatuh tempo, bulk ganti profile, audit trail, jalur auto-isolate billing, webhook dedup, alert FO-cut, flapping, render halaman, SSE, RBAC 403, poller telemetry & diff login/logout, router offline → alert ROUTER DOWN + cache.
