INKAMBILL PERFORMANCE CENTER V3 — CUSTOMER GROWTH
=================================================

Tambahan utama:
- Customer Growth Analysis All Site + Per Site
- Opening customer
- PSB
- Reactivation
- Off (inactive/suspended)
- Terminated
- Churn
- Net Growth
- Closing customer
- Gross Growth
- Growth Efficiency
- Churn-to-PSB Ratio
- Net Growth Rate
- Growth Quality
- 6-month PSB / Churn / Net trend
- Site contribution table
- deterministic growth findings
- lifecycle history table untuk perubahan status mulai V3
- data confidence label untuk histori sebelum lifecycle history tersedia

PENTING
-------
All Site dihitung dari agregasi site yang sama, bukan query summary terpisah.
Ini mencegah angka All Site berbeda dengan total KRW + CLM + KBG.

Status lifecycle:
active -> inactive/suspended = OFF
inactive/suspended/terminated -> active = REACTIVATION
-> terminated = TERMINATED

Migration antar-site tidak dihitung sebagai PSB baru oleh engine ini karena PSB dibaca dari customer_source='new_install' + activation_date.

INSTALL / UPGRADE
-----------------
Extract ZIP ke root repo lalu:

node scripts/apply-performance-center-v3-growth-final.js

Validasi:
node --check routes/performance.js
node --check routes/customers.js
node --check services/customerGrowthAnalysisService.js
node --check services/operationalPerformanceService.js
node --check services/performanceExecutionService.js
node --check public/js/performance-center.js
npm run check
npm run validate:final

Akses:
 /performance#customerGrowth

UI
--
Compact Apple-style:
- segmented All Site / site selector
- movement reconciliation strip
- KPI cards
- 6 month chart
- findings
- dense site table
- no oversized decorative cards
