# INKAMBILL NMS PPPoE Sync Fix — 2026-09-26

Scope: MikroTik NMS / PPP Secret / Smart Sync / Manual Mapping / Dashboard widgets.

## Fixes
- Synced secret can now be overwritten/reassigned from the action menu ("Ganti / timpa pelanggan…").
- Manual overwrite is transactional and verifies both `ppp_secrets` and the customer mirror before commit.
- When a customer is moved from an old secret, the old active PPPoE session is kicked after DB commit.
- When an already-linked target secret is overwritten, its old active session is also kicked.
- Router kick failure no longer rolls back a valid DB mapping; the API/UI reports a warning for follow-up.
- Smart Sync choices made explicitly by the operator (including the Suggestions tab) are treated as manual decisions, so they can safely move/overwrite mappings.
- Prevent duplicate customer/secret assignments inside the same batch.
- Remove stale learned aliases when a customer is moved so Smart Sync cannot silently reattach the old secret.
- Manual map UI is locked to the secret's site; cross-site mapping is no longer offered.
- Stronger overwrite/move confirmation shows what will be replaced and that stale PPP sessions will be disconnected.
- Fixed stale AJAX response race on the PPP Secrets page that could visually revert a just-saved mapping or make the page look stuck.
- Dashboard customer counters and per-router impact now count only linked customers, instead of all PPP secrets.
- Dashboard/widgets caches are invalidated after mapping/refresh/active-state changes.
- Smart Sync Undo now restores a previous valid secret binding and previous target owner when safe, instead of only changing the customer-side username.
- Excel mapping batches are now valid history records (`source=excel`) and use the same overwrite/session-disconnect path.
- Updated stale NMS network regression assertion to the current dashboard section names.

## Validation performed
- `npm run check` — PASS
- `npm run validate` — PASS
- `npm run test:pppoe-smart-sync` — PASS
- `npm run test:network-suite` — PASS
- `npm run test:fasum` — PASS
- Individual `node --check` on every modified JS file — PASS

## Modified files
- services/nms/smartSync.js
- services/nms/secretStore.js
- services/nms/dashboard.js
- services/nms/poller.js
- services/nms/schema.js
- routes/nms.js
- public/js/nms-common.js
- public/js/nms-secrets.js
- views/nms/dashboard.ejs
- scripts/test-powerful-network-suite.js

## Deployment note
`app.js` already calls `ensureNmsV2Schema()` during startup, so the `nms_sync_batches.source` enum migration (`manual|auto|excel`) is applied automatically on a normal app restart.

Recommended production flow:
1. Backup DB and current `/opt/inkambilling`.
2. Replace/update the source.
3. `npm run validate`
4. Rebuild/restart the application using the project's normal Docker/CI-CD flow.
5. Test one overwrite on a non-critical PPPoE account first and verify:
   - new customer binding remains after page refresh,
   - old binding is released,
   - old PPPoE session disappears from `/ppp/active`,
   - dashboard linked/online/offline counts match the Synced list.
