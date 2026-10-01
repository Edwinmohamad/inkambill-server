INKAMBILL — OPERATIONAL PERFORMANCE CENTER FINAL
================================================

Performance Center non-AI untuk membaca progres menyeluruh INKAMNET:
target -> actual -> trend -> exception -> action -> snapshot.

FITUR
-----
- Operational Health Score transparan
- Executive Summary clickable
- KPI target vs actual
- PSB target pace terhadap hari berjalan
- Billing / collection / outstanding / overdue
- PSB / churn / net growth
- Ticket / SLA / MTTR / backlog / breach
- Repeat Problem Detector
- Work Progress teknisi + overdue jobs
- Network Health: Router, OLT, incident
- Finance: revenue, cash held, reconciliation difference, debt overdue
- Warehouse: low stock, empty stock, stock value
- KPI Tim role-aware dengan On Target / Watch / Needs Attention
- Site Comparison KRW / CLM / KBG
- Trend 6 bulan
- Variance vs bulan lalu
- Management by Exception
- Action Queue P1/P2/P3
- Data Freshness
- KPI Targets global dan per-site
- Monthly Snapshot
- seluruh analisis deterministik, tanpa AI

STRUKTUR BARU
-------------
routes/performance.js
services/operationalPerformanceService.js
views/performance/index.ejs
public/css/performance-center.css
public/js/performance-center.js

DATABASE BARU
-------------
performance_kpi_targets
performance_snapshots

Tabel dibuat otomatis dengan CREATE TABLE IF NOT EXISTS saat /performance dibuka.
Tidak ada duplikasi data ticket/billing/NMS/inventory. Snapshot hanya menyimpan hasil review bulanan.

INSTALL
-------
Extract ZIP ke root repo inkambill-server, lalu:

node scripts/apply-performance-center-final.js

Validasi:
node --check routes/performance.js
node --check services/operationalPerformanceService.js
node --check public/js/performance-center.js
npm run check
npm run validate:final

Buka:
/performance

CATATAN KEAMANAN
----------------
- route hanya memerlukan permission dashboard untuk read-only view.
- perubahan KPI target dan snapshot hanya Master Admin.
- audit_logs dipakai saat target/snapshot disimpan.
- query sumber opsional memakai fail-safe agar satu modul kosong tidak menjatuhkan seluruh Performance Center.
- installer backup app.js dan layout sebelum menulis.
- jika anchor repo berubah, installer berhenti sebelum perubahan ditulis.
