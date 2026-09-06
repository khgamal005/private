# Knowledge Intelligence archive and synchronization

Scope: ODEIR, `Marktonesa/marktone-platform-control`, base `0ce5785`.
Production: `gswpbwdactcstkasddta`. User explicitly authorized deployment under the ODEIR engineering gate on 6 September 2026. Application changes from #208 and #210 are merged and live; source corrections are deployed in knowledge worker v16 and tracked in #211.

## Baseline findings before deployment (6 September 2026)

- 23 published posts: 18 news/regulations and five expired tenders. Four archived and five rejected posts remain stored. No 200-post corpus exists yet.
- Feed requests 60 rows, no page controls; expiry hides tenders; global metrics ignore tenant targeting. The REST fallback can bypass the selected tenant scope.
- Six registered sources, five active. TVTC fails TLS validation; Taqeem returns 403. Etimad is a manual connector misreported as successful ingestion. Only HRSD and NeLC currently produce content.
- Daily cron at 03:15 UTC; scheduler ignores hourly/weekly due times. Source runs have no lease and raw/post writes are separate, making interrupted imports unrecoverable.
- Empty image URLs resolve to the article URL. HTML imports read the homepage repeatedly; empty parses can appear successful.

## Verdict

Proceed with additive, reversible development. Difficulty 7/10. Canonical entities remain `knowledge_posts`, `knowledge_sources`, and `knowledge_raw_items`. This is shared editorial knowledge, not tenant business data. No tenant/customer/payment records or integrations are changed. No Reef mutations or production tests.

## Design and controls

- Preserve every post and raw item. Replace delete with reversible archive; block physical deletion. Existing rejected/draft/archived editorial states are never silently published. Published expired materials become accessible through the archive.
- Versioned tenant RPCs for bounded pages, counts, source filters, dates, archive state, bookmarks, and lazy article details. Identical audience checks for list/count/detail/actions; remove unsafe fallback. Stable ordering with ID tie-breaker and creation cutoff.
- Per-source renewable-free 10-minute lease, bounded 75-second work batches, no network under database locks. Atomic idempotent raw/post persistence and run statistics. A failed import can be retried without an orphan or duplicate.
- Fetch only public HTTPS endpoints; validate each redirect and DNS answers; cap body sizes and timeouts. Do not bypass TLS, robots protections, 403s, or Etimad subscription requirements.
- Catalog entries require a successful dry-run before activation. Backfill uses persisted page/link cursors and a 250-material target, manual review for historical material, and bounded runs. The target is not a fabricated count or an automatic quality override.
- Main image, source logo, then accessible source-name fallback. No private image URLs, remote tracking favicon service, or automatic image generation.

## Release and rollback

Deployment was explicitly authorized in the follow-up request. Reviewed SQL remains under `supabase/changes`; the exact versions returned by Supabase are recorded under `supabase/migrations`: `20260906145458_knowledge_archive_v2`, `20260906145505_knowledge_source_catalog_v2`, and `20260906150527_knowledge_schedule_v2`. Schema and catalog were applied before the worker and application; the existing cron was changed only after the new worker was verified. The endpoint and Vault secret remain intact.

NeLC, HRSD and the newly added NIEPD passed real worker checks and ingested official materials. NeLC uses one-based pages and streamed article sections; the parser preserves the real article image and Arabic publication date. Historical collection confirms an empty page twice before ending, after a live page transiently returned an empty listing. HRSD's current public pagination repeats its first page, so historical collection stops safely while regular latest-page sync remains active. TVTC (TLS), Taqeem and DGA (403), and Monshaat (connection timeout) are paused with visible errors. Etimad remains manual until an authorized API integration is supplied. An additional Ministry of Education candidate was examined but not activated because its listing requires a separate integration.

Rollback: pause the knowledge cron, restore application/worker versions, retain additive columns and all imported data. Do not undo by deleting posts. Reverting to the old UI restores its historical display limits; retain the database deletion guard.

## Required evidence before release

Local SQL tests: 260+ records across pages, exact scoped counts, archived/rejected separation, anonymous and cross-tenant denial, role targeting, archive/bookmark/detail consistency, lease contention/recovery, duplicate retry and deletion guard. Parser/network tests: empty images, redirect/private addresses, historical tenders, empty pages and source errors. Lint/typecheck/build and desktop/mobile UI inspection. Production activation must dry-run each source from the deployed worker, then review backfill totals; web search alone is not proof of worker connectivity.

## Validation results

- Production build succeeds on the unchanged project dependency versions (Next.js 16.3.0). Typecheck passes; scoped ESLint has no errors (one intentional standard `img` advisory for external source media).
- 19 targeted tests pass, including real PostgreSQL execution via PGlite and actual React component interactions through JSDOM. Fixture: 267 visible posts; old/new role and tenant scopes checked; list payload about 26 KB for 24 cards with full article bodies deferred.
- Historical collector test reaches 270 unique items through bounded 12-article batches, stops at exhaustion, and detects pagination endpoints that repeat the same page.
- Production mutations are limited to shared knowledge schema, source settings, ingestion, editorial archive review and its schedule. No tenant/customer/financial records or Reef business data were changed. All 32 original material IDs remain in place; the original editorial publication states are preserved.
- Live desktop browser verification in the authenticated Marktone tenant covered the expired-tender card (five materials), historical details, full-text search, source filtering, pagination and real image loading. No horizontal overflow was observed. Mobile behavior has component/CSS coverage; a mobile device visual inspection was not available.
- All 26 NeLC records collected before the streamed-article correction were returned to review, then repaired from their canonical pages. Original raw extraction remains stored. Reviewed additions are published as archived news with source publication dates and historical-use guidance. Source text/date inconsistencies remain in review. The 250 target is a collection target, not a claimed published count; final live counts are recorded in the release PR and completion message.
- Full GitHub quality checks passed on #208 and #210 and the #211 runtime changes. The latest scoped PostgreSQL/parser/network and React/review checks pass (14 combined). Source dates are displayed in Asia/Riyadh with the year visible on cards.
- Post-deployment security advisor differences are the three expected authenticated SECURITY DEFINER RPC advisories for the new permission-checked tenant/admin functions. Anonymous access is revoked; ingestion RPCs remain service-only. No new unexpected advisor finding was observed.
