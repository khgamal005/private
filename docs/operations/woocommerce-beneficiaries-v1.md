# WooCommerce beneficiaries: payment once, one learner per seat

Scope: ODEIR / `Marktonesa/marktone-platform-control`, building on PR #230. No Marktone CRM changes. No tenant flags, source-order quantities, real customers, payments, historical enrollment records or rollout settings are seeded or rewritten by this migration.

## Employee workflow

The WooCommerce task dialog now includes **تحديد المستفيدين**. A group purchase begins with blank seats; the payer is not assumed to attend. Each seat can use **صاحب الطلب**, an existing authorized tenant contact, or a new named beneficiary with a Saudi mobile number. Search is debounced and returns at most 20 authorized contacts. Saving all seats happens in one transaction; the same person cannot occupy two seats of one purchased line. Existing identities are never silently renamed, duplicated or transferred to a different salesperson.

The employee saves beneficiaries, reviews the already-selected course/previous payment report, and completes the existing sales task. Saving seats preserves the current course/link selections and invalidates an earlier approval. The original assignee, ownership-transfer, historical-review, refund, payment-fingerprint and incentive guards remain active.

Registration sees **تسجيل المستفيدين**, an individual batch selection for every pending seat and **دفعة واحدة لجميع غير المسجلين**. Staff may enroll all seats together or a subset now and the remainder later. Already-enrolled learners are displayed read-only. Batch capacity is checked for the entire requested group under row locks, with atomic rollback when insufficient.

## Financial and historical boundary

A purchased line still has exactly one original financial handoff and one sale attribution. `sales_core.commerce_order_beneficiaries` holds the learner entitlements; it does not create additional payment reports, opportunities or incentive sources. Integer seat allocations are informational and sum to the original purchased-line amount. Revenue must continue to aggregate financial handoffs/receipts, not sum a parent's amount once for every joined enrollment.

A prior full-amount payment remains unchanged. Its existing enrollment is linked to the matching selected beneficiary; it is never cloned, moved to a different student or assigned a different batch by this workflow. When that financial handoff was historically completed but has additional purchased seats to enroll, its historical completion timestamp and original enrollment are retained. The admissions snapshot surfaces its remaining learner work as **قيد الاستكمال**, and a separate pending registration task is created without reopening the old enrollment or duplicating the payment.

Ordinary enrollments retain a partial unique index on `handoff_id WHERE commerce_seat_id IS NULL`. Explicit seat enrollments have a unique `commerce_seat_id`, tenant-composite foreign keys and a validation trigger. The legacy ordinary-registration function gets one checked conflict-target compatibility edit; migration execution aborts if the inspected snippet has drifted. Old tabs cannot use ordinary registration to bypass seat selection.

## Security and concurrency

Private table RLS and explicit privilege revocation deny direct public/anon/authenticated/service-role access. Public SECURITY DEFINER RPCs authorize the tenant, actual assignee/reviewer and admissions role. A salesperson's contact search/selection is restricted to their own contacts plus this order's payer; managers/admissions reviewers retain tenant-scoped access. New identities are validated against existing contact/alias records before insertion. Existing beneficiary ownership is never changed.

Save and enrollment requests carry stable command UUIDs plus expected revisions. Commands are replay-safe and actor-bound. Connection, tenant, contact and batch locks protect source changes, reassignment, simultaneous submissions and group capacity. Fingerprints invalidate stale seat definitions/reviews when financial source quantities or payment evidence changes. No automatic source repair, refund settlement or backfill is included.

The dedicated same-site, cookie-authenticated API allowlists three RPCs, limits requests to 64 KiB, uses a timeout, disables response caching and translates errors without leaking SQL, tokens or upstream details. The original Woo admissions endpoint remains compatible.

## Verification and release gate

Tests are supplied for phone normalization, blank group defaults, quantity/duplicate guards, isolation, source-change holds, idempotent save/enrollment, full-amount historical reuse, partial/different-batch enrollment, all-or-nothing capacity and unchanged ordinary registration. PostgreSQL tests run actual legacy/forward functions in isolated PGlite fixtures. Browser tests exercise the real components with strictly local fixture requests at 1440, 390 and 360 pixels and capture artifacts. These are separate DB and UI layers, not a claim of authenticated deployed-app end-to-end coverage.

Before production: require green Quality + both WooCommerce browser checks, inspect the forward migration against current schema drift, complete an authenticated isolated-staging smoke test with real permissions/triggers, obtain production approval, then apply the migration and deploy the application. Test ordinary manual registration, Woo single-seat and a synthetic multi-seat order before any real customer processing. Do not test by completing order #7915 or any Reef customer task. Staff must supply actual beneficiaries themselves.

Rollback: prefer disabling only new beneficiary entry points while retaining all tables, seat associations and enrollment history. The partial enrollment index/legacy conflict-target compatibility edit are a unit and must not be independently reverted. Do not restore a globally unique handoff index after group enrollments exist. Revert UI only with a reviewed read-only/group-hold behavior; the legacy INSERT guard must remain to prevent incorrect buyer-only enrollment. Never delete real learner/payment history or repair migration history as rollback.
