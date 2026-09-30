# FMT Operations Dashboard — Apple UI v3.0 Audit

## Design direction

The UI layer was rebuilt around an Apple-inspired visual system while preserving the existing FastAPI routes, database schema, permissions, upload/signing logic, and operational workflows.

### Global system
- System-first font stack: `-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`, `SF Pro Display`, `Helvetica Neue`, then platform fallbacks.
- Light background based on soft neutral gray (`#f5f5f7`) with white translucent surfaces.
- Dark mode based on true black / graphite surfaces with `#0a84ff` blue accent.
- Thin neutral borders, restrained shadows, larger corner radii, and reduced visual noise.
- Controls use consistent 42–46 px heights and focus rings.
- Reduced typography weight and improved hierarchy.

### App shell
- Sidebar changed from dark NOC-style navigation to translucent macOS-style navigation.
- Active navigation uses a soft blue selection instead of a bright gradient.
- Topbar uses translucent glass, compact search, profile menu, theme control and notification indicator.
- Logo receives a clean white presentation surface so BDX branding remains strong in both modes.

### Login
- Marketing split-screen removed from the visual presentation.
- Login is now a centered, minimal translucent panel.
- BDX logo is the primary identity element.
- Background uses only subtle ambient blue/purple light rather than decorative animation.

### Dashboard
- Hero and KPI cards use softer surfaces and Apple-style typography.
- Operational health and status remain available but no longer dominate the page.
- Action queue, signing pipeline, inventory, quick actions and activity timeline share the same card language.

### Tables / forms
- Tables use rounded container surfaces, restrained separators and gentle row hover.
- Inputs/selects/textareas use consistent radii, focus ring and spacing.
- Toolbars/tabs are simplified and no longer look like nested admin panels.

### Signing workspace
- Document queue, PDF viewer and control steps now use the same neutral surface system.
- Selected queue item uses a subtle blue tint.
- Signature box remains clearly visible with Apple blue outline.
- Functional signing behavior is unchanged.

### Responsive
- Desktop tuned for 1366 / 1440 / 1920 widths.
- Tablet/mobile preserve the existing functional responsive layout while applying the new design system.

## Validation
- Python compile: PASS
- Jinja templates: PASS
- JavaScript syntax: PASS
- Clean database startup: PASS
- Login route: PASS
- Dashboard: PASS
- Attendance/list/upload/signing: PASS
- Signatures: PASS
- Asset/Tools/Consumables: PASS
- Tickets: PASS
- Reports/Audit: PASS
- Users/Roles/Settings/Profile: PASS
