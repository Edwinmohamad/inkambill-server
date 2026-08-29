# INKAMNET Control Center v1.12.0

Cumulative release built on the previous verified source.

## Final revision focus

### Financially safe invoice correction
- Admin can correct a paid/partial invoice back to an open state from the invoice action menu.
- Active payment rows are retained for audit but changed to `failed`.
- Automatic cash transactions linked to those payments are removed in the same database transaction.
- Invoice `paid_amount` is reset to zero and `outstanding` is recalculated from the unchanged invoice total.
- A corrected invoice with payment history can be cancelled (audit-safe delete). A never-paid invoice can still be physically deleted.

### Cluster filters
Cluster / ODP filtering is available in customer-related operational views including Customers, Invoices, Payments, Reconciliation, Reports, Tickets, Technician Schedules, and Custom Invoices.

### Customer Excel import
- Customer ID is not part of the import template; it is generated automatically.
- The template follows the instruction-first format used by the supplied reference workbook.
- Required fields are visually marked: Nama, Site, Paket Internet, Alamat, Whatsapp, Tanggal Instalasi, Tanggal Jatuh Tempo.
- Site may be entered by code or exact site name.
- Package must already exist and must be valid for the selected site (or be a global package).
- Optional cluster/router must belong to the same site.
- A visible `REFERENSI` worksheet lists current Site, Package, Cluster, Router, and Sales data.
- Imports are validated atomically before any row is inserted.

### Dashboard technology layer
The existing operational KPIs remain the source of truth. v1.12 adds a non-blocking telemetry rail, scan mesh, subtle cursor-reactive glow/tilt, and reduced-motion fallback.
