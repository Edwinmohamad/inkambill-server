# INKAMNET Control Center v1.25.8 — Cash Approval Visibility Fix

## Fix
- Pending Data Kas (`PENDING_APPROVAL`) is now loaded for every user who can open Approval & Transaksi.
- Non-Master Admin users see the queue in read-only mode with **Menunggu Master Admin**.
- Approve/Reject remain restricted to Master Admin at the backend routes.
- This fixes the case where Data Kas was successfully stored but appeared to disappear from the Approval menu for Admin/custom roles.

## Security
Visibility and mutation authorization are separated. Making the queue visible does not grant approval rights.
