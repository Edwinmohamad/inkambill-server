# APK layout and lightweight rendering

The Android WebView receives these changes from the server after deployment.
No native package/version change is needed for this patch.

- Wrap page actions; use bounded filter columns and 44px input/button targets.
- Use system fonts, 12px metadata and 14px body copy in the APK shell.
- Keep narrow invoice cards, long customer names, action buttons and modal bodies within the viewport.
- Disable APK CSS motion, KPI count-up, chart animation, reveal observers and NMS layout motion; retain loading/status text.
- Convert only tables affected by newly inserted rows, and preserve hidden rows used by filtering.

Validation:

```sh
npm ci --ignore-scripts
node scripts/validate-static.js
node scripts/run-audit-tests.js
npx playwright install chromium
npm run test:mobile-layout
```

The browser check renders the production invoice filter with sample data, shell components,
invoice/table cards and a Bootstrap modal at 320, 360, 390, 412 and 768px in both themes.
It checks overflow, touch target sizes, zero active animations, menu/quick-sheet actions,
modal bounds, hidden rows and AJAX card conversion. It requires access to the same Bootstrap
CDN as the application. Set `MOBILE_SCREENSHOT_DIR` to an existing directory to save previews.

Local result: 71/71 audit scripts and 10/10 browser viewport/theme combinations passed.
This is not a physical Android performance benchmark or an authenticated production-data test.
After deployment, verify the busy billing/cash/dashboard screens on the target phones,
including the keyboard, larger Android text settings and production data volumes.

## Operational revision

- Removes Cash Saya and Ticketing entries from web/APK navigation and ticket shortcuts from the dashboard. Historical routes/data are retained.
- PPPoE synchronization shows mapping status, customer, username and profile with direct Ganti pelanggan/Lepas actions. It reuses the existing authorized, audited unmap endpoint; traffic/status streaming and monitoring controls are removed from this page.
- Customer names in the customer list open a right-side detail panel; phones use the available viewport. The existing authorized detail route renders an escaped partial and the client cancels stale requests.
- Approval and cash proof dialogs have bounded image/PDF previews and scrollable metadata. Repetitive subtitles are removed while warnings and transaction identifiers remain.
- A separate daily receipt card uses `payments.paid_at`, all invoice periods, and the selected site. Confirmed transfer, cash and QRIS are separate; pending totals and cash still held by staff are explicitly separate. Existing ledger recognition and closing calculations are unchanged. The payment-date input defaults to the Jakarta calendar date.

`npm run test:operations-layout` uses local Bootstrap assets and mocked data/APIs to test customer details, proof viewing and unmapping on 360/390/1366px screens in both themes (18 page/viewport/theme checks). `node scripts/test-customer-receipts.js` checks payment-date query bounds, site scope and method/pending aggregation. All 72 audit scripts passed locally. These checks do not replace production database or physical Android validation.
