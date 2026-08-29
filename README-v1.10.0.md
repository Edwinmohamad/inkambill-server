# INKAMNET Control Center v1.10.0

Final action/import reliability revision.

## Changes

- Customer, Invoice, Cash, and Server Duty row actions now use native HTML `dialog` action sheets. Dialogs render in the browser top layer and are not clipped by responsive tables, overflow, transforms, or Popper positioning.
- Customer action button is visibly labeled **Aksi** on desktop and includes Detail, Edit, Payment/Billing, Payment History, Invoice Detail, WhatsApp, and Archive actions.
- Invoice action uses the same top-layer action sheet and keeps Payment, PDF, Print, Payment History, WhatsApp Reminder, and Delete actions.
- Cash action is active for editable/manual cash rows with Edit/Upload Proof, View Proof, and Delete actions.
- Server Duty three-dot action uses the same top-layer action sheet.
- Customer XLSX import template no longer contains `customer_code`.
- Customer import generates Customer ID automatically from Site + due day + sequence (example `KRW-15-001`) under an advisory lock to reduce duplicate-code races.
- Customer list has a dedicated **Harga Paket** column.
- Asset cache/version bumped to v1.10.0.

## Import behavior

The v1.10 customer import is intended for new customer onboarding. Required XLSX columns are:

- `name`
- `site_code`
- `package_name`

Customer ID is generated during the database transaction. Existing export still contains `customer_code` for reporting/reference.
