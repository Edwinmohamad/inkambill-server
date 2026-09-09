# INKAMNET v1.25.6 — Cash & Approval UI Fix

## Fixed
- Data Kas Vendor detection now supports `VENDOR`, `VDR`, `VENDOR...`, and category names containing the word Vendor.
- Add Data Kas category selector is rebuilt by transaction type instead of hiding/disabling `<option>` elements, preventing stale/invalid category selections when switching type/category.
- Data Kas modal resets cleanly after close so Vendor required fields cannot leak into the next entry.
- Data Kas create/update validation errors return to Data Kas with a readable flash message instead of surfacing as a generic server error.
- Riwayat Pembayaran approval controls are compact: Approve/Reject stay in the row; booking-date options move into an Approve modal.
- Payment history typography/spacing is tightened while remaining readable, with horizontal overflow on smaller screens instead of oversized rows.

## Safety
- Financial approval route and bookkeeping logic are unchanged.
- Transfer/QRIS approval still requires payment proof.
- Manual booking date is only required when `Pilih tanggal manual` is selected.
