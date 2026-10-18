# UI, API and Android runtime audit — 18 October 2026

Base: 8405adc32d53fe48f1ee4d9ceaab269c784a1296.

## Corrections

- Numbering follows the server pagination offset for customers, invoices, payments, Data Kas and audit logs.
- Filter submissions validate input, reset page=1 and deduplicate requests. Enter searches the server, including cash rows outside the current page; typing still filters locally.
- Local search operates on the owning table instead of every table on a page, clears hidden checked rows, excludes summary rows, and displays an accessible no-results state.
- Confirmation preserves the original submit button, including its name/value and formaction. Separate-window forms do not leave a blocking operation overlay behind.
- APK menu, quick-sheet and modal transitions replace the temporary history entry rather than stacking stale entries. Restoring a cached page disposes stale Bootstrap instances before cleanup so dialogs can reopen.
- API session expiry, permission failures, CSRF errors and 404/500 responses return JSON when requested. Browser errors have an independent responsive recovery screen. Partially-sent responses are forwarded rather than written twice.
- Invalid or absent dates render a placeholder instead of throwing during template rendering. Pagination rejects oversized unsafe integer input.
- Login copy clarifies that the checkbox remembers the username, removes a stale version label, and no longer claims all integrations are healthy without checking them.
- Android 1.3.3 (code 8) distinguishes HTTP server failure from network loss and provides a home action on the recovery screen.
- PR validation runs the web suite and the Android build/lint/emulator workflow. APK publication is limited to main so PR testing cannot publish an unmerged APK.

## Evidence and limits

52/52 local test files pass, including syntax checks, EJS fixture rendering, mocked HTTP contracts, extracted production JS handlers and simulated APK history events. The production login screen was opened and visually inspected. Authenticated production desktop/mobile workflows could not be exercised because the browser is not signed in. No customer financial data was mutated. Android compiler/lint/emulator results are recorded in GitHub Actions; source validation alone does not prove installability or hardware compatibility.
