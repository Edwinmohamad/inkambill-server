INKAMBILL PERFORMANCE CENTER V4 — RETENTION & CHURN INTELLIGENCE
================================================================

V4 menambahkan:
- Churn reason analysis
- MRR gained dari PSB
- MRR reactivated
- MRR lost dari off/terminated
- Net MRR growth
- Cohort retention 30/60/90 hari
- Retention risk queue (rule-based, bukan AI)
- Customer lifecycle timeline drawer
- Retention Action Queue
- Churn classification per pelanggan
- Lifecycle history pada edit/archive/restore customer
- MRR snapshot pada status change mulai V4

Risk hanya untuk prioritas retention, bukan auto-isolir atau auto-penalti.

Reason:
payment, service, competitor, relocation, unused, price, device, other.

Install / upgrade:
  node scripts/apply-performance-center-v4-retention-final.js

Validasi:
  node --check routes/performance.js
  node --check routes/customers.js
  node --check services/customerGrowthAnalysisService.js
  node --check services/customerRetentionService.js
  node --check services/operationalPerformanceService.js
  node --check services/performanceExecutionService.js
  node --check public/js/performance-center.js
  npm run check
  npm run validate:final

Akses:
  /performance#retention

Catatan historis:
- Status history + MRR snapshot menjadi paling akurat mulai patch lifecycle terpasang.
- Cohort lama tetap dapat dibaca, tetapi kejadian sebelum tracking lifecycle lengkap memiliki keterbatasan data.
