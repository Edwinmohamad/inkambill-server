# Changelog

## 3.4.0 — Master Signature Lock + Flexible Add/Remove

### Signature workspace
- Added **Master Page → Locked Pages** workflow.
- User positions/adds/removes signature boxes on one master page, then enters target pages such as `2-5` or `2,4,6-8`.
- **Save & Lock** copies the complete master layout to all compatible target pages and keeps those pages synchronized.
- Any later add/remove/move/resize on the master page is propagated on the next Save / page change.
- Locked target pages are read-only and clearly show `Locked to master page X`.
- Added **Unlock page** to detach one target page while preserving its current signature boxes, after which it can be edited independently.
- One-time Copy remains available as a secondary/advanced action.
- Existing floating controls remain on editable pages: drag, resize, duplicate/add, delete/remove.
- Locked pages cannot accidentally overwrite synchronized placement.
- Pages with different size/rotation are skipped safely.
- Prevents lock chains/cycles by refusing to turn an existing master page into a locked target.

### Data integrity
- Added `signature_page_locks` table with FK cascade and unique target-page constraint.
- Signing clears temporary page-lock records after successful output generation.
- Uploading a fresh revision clears stale page locks.
- Master-page save updates all locked target placements in the same DB transaction.

### UI
- Added Apple-style lock/master status card.
- Added visual lock state to signature boxes.
- More compact responsive signing layout for 1366/1440 widths.
- Existing Add/Remove controls are preserved for flexible editing on the master page.

### Validation
- Python compile: PASS
- JavaScript syntax: PASS
- Jinja compile: PASS
- Master page lock 1 → 2-5: PASS
- Master move/resize synchronization: PASS
- Add second signature box and sync: PASS
- Remove signature box and sync: PASS
- Locked-target edit protection: PASS
- Unlock one target and independent edit: PASS
- Re-sync remaining locked targets: PASS
- Final signed PDF contains placements on all locked pages: PASS
- Lock records cleared after signing: PASS
