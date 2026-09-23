# Zoom discovery correction — 2026-09-23

Baseline: main `961f6b256ad474e94b7a4513906cc690e99bbe25`, reported deployed by user on Hostinger. This is a navigation correction, not production activation or completion of Zoom acceptance.

## Findings

- IntegrationHub had no Zoom entry; the product registry resolved Zoom to the legacy generic settings page.
- Read-only metadata on the configured Supabase project confirmed no zoom_core schema and no public.v1_zoom_snapshot(text). The 24 Zoom migrations are not deployed there.
- Catalog Zoom product exists: beta, marketplace-visible, activation_mode=entitlement. No Zoom-named surface rows were returned. No tenant operational rows, Reef data, or secrets were queried or changed.
- Existing main Quality run 35865852964 completed successfully. Build success does not install database migrations.

## Implemented and verified

| Requirement | Code | Evidence |
|---|---|---|
| Existing catalog links resolve to accounts | lib/addons/placement-registry.js | fallback, explicit legacy action/surface, encoded tenant paths and unrelated products tested |
| Visible entry in integration settings | components/integration-hub.js | rendered licensed account link and unlicensed store link; no fake provider status |
| Zoom-only settings navigation | components/tenant-settings.js | rendered Zoom-only tenant settings |
| Direct route entitlement | app/tenant/[slug]/addons/zoom/page.js | rejected guard prevents snapshot; tenant and view passed unchanged |
| Honest missing-backend state | same route | missing function rendered as pending setup; forbidden remains forbidden; raw error not exposed |

Test: `node --test tests/zoom-discovery.test.mjs`: 5 passed, 0 failed, 0 skipped. Actual React server rendering and actual route module with dependency doubles; synthetic tenants only. This is not browser/Hostinger or live Zoom proof. Files restored from exact baseline for focused testing; no full local rebuild claimed.

## Still required

- Full deployment gate for 24 SQL migrations, Edge Functions, worker schedule and secrets, with staging/canary/rollback evidence under docs/addon-development-standard.md. None applied in this correction.
- Explicit operational authorization for live activation; existing authorization covers publishing main, not enabling provider actions or changing Reef entitlements.
- Actual Zoom OAuth/scopes/licensing and provider acceptance remain open (see PROGRESS.md and acceptance.md).
- After Hostinger deploys this correction, manually verify Settings → Integrations → Zoom card, installed-addon open link and correct licensed/unlicensed state. A licensed tenant with the current missing schema should see the pending setup message.

Resume from remote main; preserve Vercel main/feature deployment guards. Do not solve missing visibility by granting all tenants Zoom or seeding fake accounts.

