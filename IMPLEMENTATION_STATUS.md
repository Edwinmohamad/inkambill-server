# FMT Operations Dashboard — Implementation Status

Current version: **3.4.0**

## Signature placement workflow
Implemented and tested:

1. Open PDF and choose a master page.
2. Add one or more signature boxes.
3. Drag / resize / duplicate / remove boxes freely on the master page.
4. Enter target pages (`2-5`, `2,4,6-8`, etc.).
5. Click **Save & Lock**.
6. Compatible target pages receive the exact master placement and become linked/read-only.
7. Editing the master and saving again automatically synchronizes all linked pages.
8. A target page can be **Unlocked** at any time; its current boxes remain and become independently editable.
9. Final Preview and signing use the actual saved placements.
10. Successful signing removes temporary placement-lock workspace data.

## Safety rules
- A locked target cannot be directly edited until unlocked.
- A page already acting as a master cannot be made a child target, preventing chained/cyclic locks.
- Size/rotation mismatch is skipped rather than forced.
- Add/remove remains supported on master and independent pages.
- Original PDF remains preserved by the signed-version workflow.
