# INKAMNET Control Center v1.11.0

## Revision highlights
- Compact professional action popovers replace large native action dialogs for customer, invoice, cash, and server-duty actions.
- Dedicated `/team-kpi` page with role-aware KPI scoring for technical, staff/admin/finance, sales, management, and other roles.
- Invoice rows include a small payment checkbox beside the customer name and a `Bayar Dipilih` bulk action.
- Invoice action column includes a direct `Bayar` button plus compact `Aksi` menu.
- Invoice metadata can be corrected without changing nominal values: invoice date, due date, and monthly/prorata flag only.
- Ticketing KPI card moved out of Ticketing into the dedicated KPI page.

## Invoice edit safety
The invoice metadata edit endpoint does not update subtotal, total, paid amount, outstanding, customer, period, or invoice number.

## KPI scoring
Scores only use metrics that actually have assignments/activity in the selected month. Missing assignments are not automatically treated as perfect scores.
