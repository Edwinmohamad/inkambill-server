# INKAMNET Control Center v1.9.0

Cumulative upgrade based on v1.8.0.

## Changes

- Dashboard: PSB yearly trend, total/active/inactive/isolated customer summary, customer breakdown per site, and current-week server duty schedule.
- Customer table action menu rebuilt with a reliable fixed-position action panel.
- Invoice table action menu rebuilt with the same reliable action system, including payment modal, PDF, print, payment history, WhatsApp reminder, and delete where allowed.
- Payment transaction reference is now generated automatically as `PAY-YYYYMMDD-XXXXXX`; legacy rows with empty references are backfilled on startup.
- Cash entries can record purchase origin: Online Shop / Marketplace or Offline Shop / physical store, plus optional store/marketplace name.
- Cache/version bumped to v1.9.0.

## Database

Startup automatically runs `ensureV19Schema()`:

- `cash_transactions.purchase_channel`
- `cash_transactions.purchase_shop_name`
- backfill empty `payments.reference`

No existing customer, invoice, payment, or cash data is deleted.
