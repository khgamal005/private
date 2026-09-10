# WooCommerce sales task → admissions

Implementation review: 2026-09-10. Repository: `Marktonesa/marktone-platform-control` (ODEIR).

This change is implemented and staged for review. Production migration, deployment, tenant activation and historical writes have not been performed. The implementation approval covers transfer of customer ownership and the order's sale credit, notifications to the previous employee and management, and review of the 59 paid open tasks. It does not authorize changing mismatched historical payment amounts or inventing beneficiaries for group purchases.

## Behavior

1. The sales manager assigns WooCommerce orders. For an enabled tenant, the existing routing endpoint also transfers canonical customer ownership, open opportunities and active follow-up assignments. It preserves assignment history, records an audit event and creates in-app notifications for the old employee, new employee and management.
2. The salesperson opens the WooCommerce task from the calendar and selects the academy course for each purchased line. Existing orders and customers with previous admissions require an explicit manager/admissions review of course and payment linkage first. An approved linkage cannot be changed by the salesperson.
3. Completing the task creates or reuses one verified admission per purchased line in one transaction. The order total is apportioned in integer minor units; the sum equals the actual paid total including discounts, taxes and fees. Each line is credited to the assigned salesperson. Reused admissions keep their identity, prior enrollment, payment report date and completed state; unrelated historical sales remain unchanged.
4. Registration and admissions chooses the batch and attendance schedule using the existing registration process. WooCommerce admissions display the actual Woo payment date in the report field, the source order and the credited salesperson. The submission timestamp remains separately visible.

An order with quantity other than one per line is held until beneficiaries are defined. Partial/full refunds, missing actual payment dates, unsupported currencies, inconsistent source amounts, stale previews and conflicting assignments cannot be submitted. Approved/paid incentives for a previous employee require finance review; they are never silently reassigned or cancelled.

Changes to a submitted order's financial source place its linked admissions on hold and notify registration. Existing enrollments are retained. Automatic refund resolution and financial reconciliation are outside this change; registration cannot bypass the source hold.

## Data and access

Migration: `20260910201255_woocommerce_admissions_v1.sql`.

Five private tenant-scoped tables store the rollout flag, review, order receipt, line-to-admission mapping and idempotency commands. Composite tenant foreign keys prevent cross-tenant links; uniqueness prevents a handoff or purchased line being linked twice. RLS is enabled with no direct client access. Authenticated public RPCs validate membership, permission, assignee, current revision and tenant ownership. Old routing and completion paths are also guarded to prevent bypass from an old browser tab.

Routing/completion/registration use the existing connection, tenant and contact lock order. Repeated commands use a stable command UUID. A payment-specific fingerprint ignores sync heartbeats but invalidates a reviewed order if its financial source changes. Audit records contain the actual actor and linked order.

The migration preserves earlier functions privately and exposes compatible versioned wrappers. The incentive source function uses the frozen Woo sale owner only for mapped orders. All other tenants/orders retain the existing path. No rollout row is seeded or enabled by the migration. Reef receives no activation or historical changes by default.

The Supabase security advisor reports the intended [private-table RLS-without-policies pattern](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) and [authenticated SECURITY DEFINER RPC exposure](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). These are deliberate: direct access is revoked and authorization runs inside the RPC. Do not add permissive table policies merely to suppress these notices. Anonymous execution, non-member calls and direct authenticated table access were tested as denied.

## Historical review (read-only production snapshot)

Run `scripts/releases/woocommerce-admissions-review.sql` with its tenant guard, then reload each task's context before any write. The cohort is not a permanent assumption: production may receive additional payments or registration updates after this review.

| Classification | Orders | Treatment |
| --- | ---: | --- |
| Explicit matching order reference and allocated amount | 30 | Confirm course and reuse the matching admission; no duplicate report |
| Previous payment amount differs | 18 | Hold for finance reconciliation; retain original amounts |
| No previous admission | 7 | Review course and create the required admissions |
| Previous admissions without a matching order reference | 2 | Manually confirm linkage or approve a new report with reason |
| Quantity five | 2 | Orders 7640 and 7840: identify beneficiaries first |
| **Total paid open tasks** | **59** | **No production records changed** |

All 59 have an actual source payment date. Shared customer/phone alone is not proof that a previous admission represents this order. Multiple paid lines are separately allocated and reviewed. Completed registrations are reused only when course and allocated amount match exactly.

After activation, the manager uses **مراجعة التسجيل** in the Woo order queue. The review RPC persists the selected course and admission per line, expected revision and reason. The salesperson then uses **إتمام وإرسال للتسجيل**. Run the preview again afterward and reconcile source order totals against the unique receipts. Do not bulk insert handoffs, mark tasks completed directly, or rewrite old payment amounts to make the cohort pass.

## Verification

- Full test suite: `TZ=UTC npm test` — **1066 passed**, no failures. UTC matches CI; an existing unrelated date assertion depends on the runtime timezone.
- Lint, typecheck, production build and migration verification passed (242 forward migrations).
- Actual PostgreSQL functions in PGlite: 14 database cases, including tenant/permission isolation, stale requests, old endpoints, exact allocations, real legacy enrollment, refunds, handoff reuse, ownership history, notification recipients, frozen attribution and approved/paid incentive holds.
- React DOM test: prior admission suggestion, review gate, stable retry UUID, changed-course invalidation and approved submission.
- Staging: migration applied under Supabase history version `20260910201255`. The canonical file uses that returned version. CLI installation was unavailable in the session; no migration-history repair was used.
- `tests/staging/woocommerce-admissions-rollback.sql` passed with the real permission helpers, roles and existing triggers. It checked ownership, three recipient notifications, two verified admissions totalling 15001 minor units, idempotent retry and one actual enrollment. All its rows rolled back. Context payload was 2128 bytes; the sampled EXPLAIN ANALYZE execution was 7.192 ms (synthetic small fixture, not a production load benchmark).
- Separate concurrent staging transactions used one isolated synthetic tenant and two distinct command IDs for the same revision. Exactly one succeeded, one returned `woocommerce_order_changed`; result: one receipt, two handoffs, total 15001, one completed task. The synthetic tenant/organization and all its data were deleted and absence verified. Its store was disabled with an `.invalid` URL and no outbound rules.
- Chromium UI workflow: `.github/workflows/woocommerce-admissions-ui.yml` checks the actual dialog at 1440/390/360 px, review/retry/completion and no horizontal overflow. It blocks all non-fixture network traffic and uploads screenshots plus assertions. Check the PR run for its final result; a local connected-browser attempt was blocked by the environment and is not counted as a pass.

Database and UI checks are separate layers. No authenticated HTTP/browser session against a deployed staging app has been verified yet. That end-to-end deployment check is required before production activation, using isolated test records and verifying there are no unintended external notifications.

## Release and rollback

1. Review the PR and CI evidence. Recheck production main and migration history for drift. Obtain current production deployment approval under the ODEIR engineering gate.
2. Apply the additive migration once, with every tenant flag off. Deploy the application version containing the compatible wrappers and new UI.
3. Verify login, manager order queue, sales calendar, manual payment reporting and registration on the deployed build. Complete the authenticated staging application test described above. Capture the release identifier and prior deploy for rollback.
4. Enable only the intended tenant in `sales_core.commerce_admission_rollouts`, with `enabled_at` set to the activation time. Audit who enabled it. Do not enable Reef or other tenants implicitly. Re-run the historical dry run because all pre-activation tasks require review.
5. Process a reviewed small pilot before the eligible remainder. Reconcile receipts, handoffs, order totals, ownership, notifications, staff sale credit and enrollment. Leave the 18 amount mismatches and two group purchases held until their facts are resolved.
6. If a problem occurs, disable the tenant flag and revert the application deploy if needed. Retain the additive schema, unique receipts, audit and completed registrations; never delete real handoffs or migration history as rollback. Existing submitted-order integrity guards and frozen attribution remain to protect records already created. Restore/alter wrappers only with a separately reviewed forward migration.

Production status for this review: unchanged. No marketing messages, emails or WhatsApp messages were sent by the implementation session.
