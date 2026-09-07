# ODEIR independent editions and flat add-ons — release gate

## Authority and scope

Marwan explicitly authorized publication on ODEIR of the approved four core editions and independent, flat monthly/yearly add-ons. The Reef Skills legacy FULL contract and operational data must not be changed. Scope is `Marktonesa/marktone-platform-control`, production `gswpbwdactcstkasddta`, `odeir.com`; not Marktone CRM or the standalone REEF HS project.

## Commercial contract

Core monthly SAR: 0 / 79 / 199 / 499. Annual: 0 / 790 / 1990 / 4990. Sixteen individual add-on offers, including free templates. Annual is ten monthly fees for twelve months. No tiers, bundles, promotional coupling, or commercial add-on quotas. Provider consumption and optional human services remain separate. The catalog and frozen order metadata are server-authoritative; a browser cannot supply its own price, tax, plan entitlement or paid state.

The latest explicit user decision supersedes the original transition hold: the legacy `full` row and every Reef contract remain unchanged; all other existing tenants transition to `core_basic`, retaining their exact prior periods and already-live add-on rights. No real charge is made. New core editions have separate IDs and no add-on feature entries. Reef's resolver deliberately uses its unchanged legacy rights. Historical annual price-version rows remain in place; new orders have a separate immutable quotation and license-terms ledger. A legacy order never silently changes price or duration.

## Implemented and not implemented

This release updates the sale catalog, monthly/annual add-on checkout, core administration, public price page, and protected contract assignment. The current core subscription assignment remains an administrative operation; this release does not create automatic recurring card debits or a new self-service core-edition payment flow.

The user authorized simplifying the launch rather than introducing unsafe resource gates. The current commercial differentiation is staff capacity only: 3 / 5 / 10 / 20. Current core operations/reporting remain available across editions; monthly lead quotas, open-cohort quotas, differentiated report/routing gates and commercial storage quotas are intentionally deferred and removed from sale copy. Normal security/provider/file-size controls remain; there is no unlimited-hosting promise.

The internal FULL edition is available only to authorized platform billing administrators, never in the public catalog. Its original database row is not edited. The old `v2_platform_set_subscription` endpoint delegates to the protected path. Trigger guards also reject core-contract and shared-FULL changes affecting Reef. Public/verified signups always start `core_free`; administrators may deliberately assign internal FULL to other tenants. Existing teams above five retain their current-seat floor on the migrated Basic contract. This is not a new bundled offer.

Two reviewed migrations apply atomically. The release runner fingerprints every pre-existing table's Reef-scoped rows plus the nine protected commercial fingerprints before and after the exact transaction, including all ordinary business records. A preview executes the real production schema checks and rolls back; the apply phase is separately authorized only after successful checks. No payment/customer/notification fixture is created in production.

## Gate and release sequence

1. Verify repository/production identity and current base SHA; inspect concurrent changes.
2. Run `npm run check` on the exact candidate: ESLint, typecheck, all tests, migration validation and production build. Run dependency security review without arbitrary dependency upgrades.
3. New SQL tests execute the additive migration in an isolated PostgreSQL runtime with synthetic data only. They cover pricing, tax, all provider duration projections, authorization, immutable idempotency, legacy entrypoints, no core/add-on coupling, disabled-sale bypass prevention, Reef protection and Tamara existing-license conflict prevention. Existing payment suites remain required; projection tests alone are not full gateway verification.
4. Recheck production routine signatures/patch needles and Reef protected hashes immediately before applying the exact reviewed SQL. A missing routine, source drift or changed Reef metadata aborts the entire transaction. No trial payment, message or business fixture is created in production.
5. Apply database compatibility layer, then merge/deploy matching application code through authorized tools. The old read and order entrypoints delegate to the new contract during the rollout; no intermediate annual/monthly price mismatch is permitted.
6. Inspect live page/store totals, unauthorized endpoints and deployment identity. Compare Reef plan, features, limits, modules, subscription rows, add-on rows and effective rights to the preflight fingerprint. Record actual checks and any limitations; do not equate a merged PR with a verified production deployment.

## Rollback / stop-sale

Before the migration commits, a failed assertion or error rolls the transaction back. After commit, prefer stopping new sales, not reversing completed financial state. With approved operational access, set `published=false` on the release's catalog rows and keep the quote-aware payment/fulfillment routines and license ledger installed. Every known offer routes through the new quote function even when unpublished, so it cannot fall back to obsolete annual pricing. Pending paid attempts must be reconciled from their frozen quotation; do not delete or recalculate them.

The original add-on catalog rows and patched routine definitions are retained in the private, RLS-protected `catalog.independent_commerce_rollback_v1`. Original wrapped routines remain private and revoked. Do not restore old duration logic while any new monthly quotation or payment attempt exists. Do not run a destructive down migration, delete new subscriptions, reset customer records, or change Reef to compensate for a UI issue. A forward fix is safer once new contracts exist.

Application rollback must preserve the new database quotation logic and keep monthly sales disabled until the matching UI is restored. Neither an old UI nor administrative price editing may reactivate obsolete pricing. Source availability, deployment status, and full smoke-test evidence must be recorded in the PR at release time.
