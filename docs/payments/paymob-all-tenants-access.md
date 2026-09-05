# Paymob automatic tenant availability

## Production policy

Paymob Hosted Redirect is available automatically to every current tenant through an explicit `payment_tenant_rollouts` row. A database trigger creates the same enabled rollout for every tenant created later:

- policy: `automatic_all_tenants`
- environment: `live`
- trigger: `zz_tenants_paymob_auto_enroll_after_insert`

The authoritative implementation is:

`supabase/migrations/20260905171951_paymob_automatic_all_tenants_v1.sql`

The timestamp in the filename matches the migration version recorded by the production database.

## Controlled Live gate

Automatic enrollment does not bypass payment readiness. Checkout remains fail-closed unless the provider and its active credential version continue to satisfy the governed KSA QuickLink contract, including:

- Live provider and credential environments;
- redirect checkout using `quicklink`;
- SAR as the supported currency;
- matching merchant account and integration bindings;
- valid API-key and HMAC references in Vault;
- successful credential and checkout-creation readiness evidence;
- exactly one active, non-revoked credential version.

The provider can remain in the governed `configured / observe_only` state while the structural Controlled Live gate is healthy. Full operational evidence is still collected independently and is not fabricated by tenant enrollment.

## Existing and future tenants

The rollout migration backfills every existing tenant and verifies that the enabled rollout count equals the tenant count. The trigger enrolls future tenants in the same transaction that creates the tenant, so no background task or manual enable action is required.

An authorized platform operator can still disable Paymob for one tenant as an explicit operational exception without affecting other tenants.

## Security invariants unchanged

This policy changes availability only. Server-side price calculation, promotions, VAT, amount binding, idempotency, signed webhook settlement, reconciliation, refunds, credential rotation, Vault isolation, and audit logging remain unchanged.
