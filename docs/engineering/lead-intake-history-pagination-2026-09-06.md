# Lead intake history pagination

The queue and distribution log filtered an initial snapshot containing only the latest 750 import rows and 500 assignments. Older records remained in the database but could not appear when employees selected August. Batch cards had the same problem at 50 batches.

## Implemented behavior

- A versioned, permission-checked read RPC applies tenant, date, source, campaign, quality and search filters before selecting a page.
- Pages contain at most 100 records, ordered by timestamp and UUID. An anchor excludes later creations during traversal; it is not a frozen snapshot of mutable customer statuses. The first page calculates the matching total; subsequent pages reuse it.
- The existing Arabic controls now operate on the complete history, including empty search queries and date-only filters. Previous/next controls display the range and total. Old batch cards link to their import rows.
- Bulk selection belongs to the currently returned page. Changing filters, pages, tabs, retrying or refreshing invalidates previous selections. Delayed requests cannot overwrite newer results.
- Loading and failed reads are distinct from an empty result. The global DOM paginator is disabled only for the two server-paged tables.

## Engineering gate

Difficulty: 5/10. The main risks are preserving the existing date/attribution definitions, tenant isolation, asynchronous UI state and query cost.

The migration adds one read function and four indexes. It does not insert, update, delete, normalize or backfill customer, assignment, import, task, audit or integration records. Existing mutation APIs, export functions and the ancillary analytics/team snapshot remain in place. There are no production schema or data changes in this implementation session.

The function is `STABLE`, uses an empty `search_path`, checks the authenticated subject and `tenant.leads.read`, qualifies joins by tenant, revokes execution from PUBLIC/anon and grants it only to authenticated. The API forwards the user's bearer token and uses no service-role credential. It is uncached, validates requests and responses, and returns localized errors. Assignment filters use `assigned_at` in the tenant timezone and original import attribution where present. Queue and batch date semantics retain the existing UI contract.

Latest assignment evidence is read once per filtered queue/batch query. Live, read-only `EXPLAIN (ANALYZE, BUFFERS)` measurements of the August count queries on 2026-09-06 were about 202 ms for assignments and 179 ms for the optimized queue. The earlier per-row assignment lookup took about 6,310 ms. These are individual query observations on existing indexes, not end-to-end latency guarantees or a controlled benchmark; the new indexes have not been applied to production.

## Verification

33 focused tests passed across the new SQL/UI suites and the existing intake, reassignment, metric, distribution-mode and pagination suites. The exact migration was executed in isolated PGlite PostgreSQL with synthetic data, including 2,106 August assignments, 3,213 August import rows, 120 batches and a second tenant. All August records were reached without duplicate IDs. Tests cover tied timestamps, old batches, exact totals, Arabic-number search, attribution, Riyadh midnight boundaries, permission failures, late inserts and unchanged business-table fingerprints after reads.

The actual React components were exercised in an isolated DOM with synthetic responses, including the global paginator, date-only filtering, forward/backward navigation, selection invalidation on a revisited page, out-of-order responses, errors/retry, refresh and old-batch navigation. The DOM test denies any request outside the read endpoint. Browser rendering verification was unavailable because the cloud browser blocked access to the local preview; no authenticated production UI smoke test has been claimed.

Changed-file ESLint, TypeScript and the production Next.js build passed. Existing dependency versions remain unchanged; PGlite and jsdom are pinned development-only test dependencies. The full repository test suite and full historical migration verifier were not run in the partial local checkout.

## Rollout and rollback

Implementation is authorized; deployment requires separate explicit approval under the Odeir engineering gate.

1. Apply the additive migration to staging and verify the real authenticated RPC, source/campaign filters, totals and page latency. Use staging fixtures only.
2. After production approval, apply this migration before releasing the web change. Index creation has a 2-second lock acquisition limit and a 60-second statement limit; if busy, leave the prior release active and retry in a quieter window. No backfill is required.
3. Smoke-test the authorized tenant's August log and queue by reading only. Confirm employee permissions, counts, previous/next, search, batch navigation and absence of duplicate controls.
4. Roll back the web release if required. The additive function and indexes can remain; the previous UI and RPCs remain compatible. Optional schema cleanup is a separate change. No customer-data restoration is needed because this change does not rewrite customer records.
