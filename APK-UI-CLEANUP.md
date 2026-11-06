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
