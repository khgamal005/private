# Paymob automatic tenant availability

## Production policy

Paymob Hosted Redirect is available automatically to every tenant that exists in `core.tenants`, including tenants created after this policy was deployed. No per-tenant enable action or rollout row is required.

The global policy is stored in `marketplace.payment_provider_configs.public_config`:

- `tenantAccessPolicy: all_tenants`
- `autoEnableNewTenants: true`
- `tenantAccessPolicyVersion: 1`

## Fail-closed controls

Automatic tenant availability does not bypass payment readiness. Checkout remains unavailable unless all of the following remain true:

- provider status is `active`;
- provider and credentials environments match the requested environment;
- rollout mode equals the environment (`live` in production);
- checkout mode is `redirect` and the integration path is `quicklink`;
- an active, non-revoked QuickLink credential version matches the configured merchant and integration IDs;
- the required API key and HMAC references are valid in Vault;
- no explicit per-tenant `disabled` override exists.

Provider status or rollout mode remains the global emergency stop. An explicit disabled tenant rollout remains the per-tenant emergency stop.

## Existing and future tenants

`private_app.paymob_tenant_checkout_eligible_v1` derives eligibility from tenant existence and the global provider policy. This avoids fragile backfills and guarantees that a newly created tenant inherits Paymob immediately without a trigger or background task.

## Security invariants unchanged

This policy changes availability only. Server-side price calculation, promotion discounts, VAT, amount binding, idempotency, signed webhook settlement, reconciliation, refunds, Vault isolation, and audit logging remain unchanged.
