# Knowledge Intelligence archive and synchronization

Scope: ODEIR, `Marktonesa/marktone-platform-control`, base `0ce5785`.
Production inspected read-only: `gswpbwdactcstkasddta`; deployed knowledge worker v11 matches the repository.

## Findings (6 September 2026)

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

Implementation is authorized; production deployment is not requested in this turn. Keep schema SQL under `supabase/changes` for review, and record it through the deployment migration tool when releasing (CLI unavailable in this workspace). Apply `knowledge-archive-v2.sql`, then `knowledge-source-catalog-v2.sql`, then worker, then application; only afterward change the existing knowledge cron to every 15 minutes and activate verified sources. Preserve the current cron command and secret. Never enable the faster schedule against the old worker.

The source catalog adds NIEPD and DGA as paused candidates without overwriting existing sources. The admin catalog also supplies corrected NeLC, HRSD and Monshaat settings, each requiring runtime verification before activation. TVTC TLS errors and Taqeem HTTP 403 still require provider-side resolution. Etimad remains manual until an authorized API integration is supplied.

Rollback: pause the knowledge cron, restore application/worker versions, retain additive columns and all imported data. Do not undo by deleting posts. Reverting to the old UI restores its historical display limits; retain the database deletion guard.

## Required evidence before release

Local SQL tests: 260+ records across pages, exact scoped counts, archived/rejected separation, anonymous and cross-tenant denial, role targeting, archive/bookmark/detail consistency, lease contention/recovery, duplicate retry and deletion guard. Parser/network tests: empty images, redirect/private addresses, historical tenders, empty pages and source errors. Lint/typecheck/build and desktop/mobile UI inspection. Production activation must dry-run each source from the deployed worker, then review backfill totals; web search alone is not proof of worker connectivity.

## Validation results

- Production build succeeds on the unchanged project dependency versions (Next.js 16.3.0). Typecheck passes; scoped ESLint has no errors (one intentional standard `img` advisory for external source media).
- 19 targeted tests pass, including real PostgreSQL execution via PGlite and actual React component interactions through JSDOM. Fixture: 267 visible posts; old/new role and tenant scopes checked; list payload about 26 KB for 24 cards with full article bodies deferred.
- Historical collector test reaches 270 unique items through bounded 12-article batches, stops at exhaustion, and detects pagination endpoints that repeat the same page.
- No production mutation was performed. Source runtime dry-runs and actual 250-material backfill are release checks, not completed imports.
- Cloud browser rejected both local preview hostnames (`ERR_BLOCKED_BY_CLIENT`). Visual approval remains required; no desktop/mobile screenshot verification is claimed. Local component interaction tests provide behavioral coverage separately.
