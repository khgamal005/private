# Tamara Live credential onboarding

Scope: `Marktonesa/marktone-platform-control`, ODEIR platform billing controls
at `odeir.com`. This change does not target the separate Marktone CRM or Reef.

## Evidence from production, 2026-09-05

Read-only queries against the repository-bound Platform Control project found:

- Tamara is `draft`, `sandbox`, `observe_only`, with no credential environment.
- No Tamara secret references, payment attempts or provider-specific RPCs exist.
- The platform snapshot explicitly reports no Tamara native adapter.
- Main has no Tamara checkout, return, webhook or reconciliation endpoint.
- The central config expects API Token, Notification Token, merchant ID and
  webhook ID. A visible partner-store ID is not assumed to be the API merchant ID.

The operator confirmed that the supplied account keys are **Live**. This
selects the intended environment; it is not evidence of a working ODEIR payment
integration. The masked token cannot authenticate a request. No real keys have
been supplied or stored during development.

## Engineering decision

Reuse the existing platform configuration and Vault save boundary. Add a
dedicated Tamara setup form and a read-only credential probe before attempting
any payment activation. Do not duplicate the platform or reuse Paymob's
provider-specific settlement semantics for Tamara.

Difficulty: onboarding 3/10; the remaining complete payment lifecycle 7/10.
The main remaining risk is correct authorisation/capture/refund projection,
credential rotation and idempotency while preserving tenant entitlement sources.
The inspected shared-looking `payment_attempts` and `entitlement_sources`
tables have Paymob-only constraints and credential-version references. The
existing verified settlement function is also Paymob-specific. Reusing those
contracts for Tamara would require a separately reviewed payment-engine change.
The older generic payment-recording helper is not an acceptable shortcut: it
does not provide the same immutable attempt and source-ledger protections.

## Implemented in this change

- Tamara-only Arabic form with labels matching the partner portal; fixed
  redirect checkout and SAR. A new, unconfigured account defaults to Live.
  A saved account keeps its existing environment. Selection alone never writes
  to the database, and environment changes still require both secret keys.
- `POST /api/platform/tamara-preflight` checks the existing authenticated
  `v3_platform_payment_provider_admin_snapshot` permission boundary, then calls
  only `GET /checkout/payment-types?country=SA&currency=SAR` on the fixed
  environment-specific Tamara API host. No order or monetary transaction.
- No service-role key, Vault read, configuration mutation or provider-state
  promotion in the probe. Notification Token is never sent to the probe.
- Requests/responses have byte limits, outbound calls have deadlines including
  response bodies, redirects are rejected, and responses are not cached.
- Raw upstream text and credentials never appear in responses or logs.
- Changing API Token or environment invalidates the displayed test result;
  closing the form cancels pending probes. Successful probe is not saved evidence.
- Existing credential save route remains the only configuration write path.
  A guarded migration removes the central Tamara config's two required public
  fields. API Token and Notification key are sufficient to store the bundle;
  merchant identity is authenticated by the API token, while a Webhook ID is
  obtained when registering the receiver later. The form requires the updated
  snapshot contract before allowing save, so a partial deployment fails closed.
  Existing public config values are preserved; no identifiers are fabricated.

The new UI does not claim that a successful probe verifies the Notification
Token, approves a payment, registers a webhook, or enables tenant checkout.

## Database and tenant impact

The migration `20260905205608_tamara_onboarding_credentials_v1.sql` is committed
for review and **has not been applied**. It locks only the Tamara config row,
validates the expected inactive contract, changes `required_public_config_keys`
to an empty array and appends a migration audit event. The existing timestamp
trigger also updates that config row's `updated_at`. It is repeatable and
aborts on an unexpected contract. It preserves environment, status, rollout,
readiness, existing public config and secret references.

No production database writes, tenant route changes, rollout toggles or real
checkouts were performed. After release, the probe only reads the permission
snapshot; a user-initiated save uses existing audited platform credential
storage. Orders, subscriptions, grants, CRM records and tenant integrations
remain outside this change. The existing database guard still rejects any
attempt to mark Tamara active without a native adapter.

## Remaining work before enabling payment

1. Release the reviewed onboarding migration and UI, then enter the confirmed
   Live API Token and Notification key in the secure platform form. Do not put
   secrets in chat, source control or issue descriptions. This saves a configured
   connection and does not activate collection.
2. Implement an immutable, tenant-bound attempt and Tamara hosted checkout with
   authoritative price/currency, retries and recovery for ambiguous creates.
3. Add a dedicated ODEIR webhook endpoint. Validate HS256 and temporal claims;
   retrieve the authoritative Tamara order and compare all financial bindings.
   Approved orders require authorisation; capture reflects actual fulfilment.
   An approved or authorised notification must not be treated as a full capture.
4. Register a separate ODEIR webhook, preserving other stores' subscriptions.
   Derive merchant/webhook identifiers from Tamara's response when possible.
   Do not point Tamara at the currently configured, unimplemented URL.
5. Verify success, rejection, cancellation, duplicate/concurrent deliveries,
   missed notifications, full/partial refunds, rotation and reconciliation.
6. Enable only an explicitly selected non-Reef test scope. A real payment test
   requires known amount, account and approval; never use Reef as a test tenant.
7. Release and activate after review. Main and production are unchanged by
   this draft. No activation evidence is manufactured to bypass readiness.

Release order: apply the reviewed metadata migration, deploy the UI/route,
refresh the platform snapshot, enter the keys and perform the read-only probe.
The CLI-generated migration timestamp precedes an unrelated, future-dated
Paymob migration already present on main; the release operator must account
for that pending version explicitly in migration history. Do not run an
unreviewed bulk migration push to work around ordering.

Rollback: revert the UI/route. Existing secret references and public config must
be retained. If restoring the old required-field metadata, keep Tamara inactive
and set it to draft when the old fields are incomplete. Never delete credentials,
tenant records or payment history as a rollback. No rollback has been executed.

## Validation

`node --test tests/tamara-preflight.test.mjs` covers authorization, origin
rejection, environment binding, fixed outbound hosts, absence of provider
writes, masked/invalid inputs, absence of reflected secrets, response shape,
byte limits, timeout through the response body and truthful readiness flags.
These are offline contract tests, not evidence of a live payment.

Additional offline validation used PGlite 0.3.15 with the inspected production
bundle/guard function definitions, minimal fixture tables and a Vault reference
test double. It exercised the real PL/pgSQL metadata migration and bundle core:

- Reapplication produces one migration audit event and no credential writes.
- Saving exactly the two Live keys reaches configured/observe_only, with no
  fabricated readiness and no secrets in the audit response.
- Missing the second key on environment rotation, unknown secret keys,
  user-role access, an unexpected metadata contract and forced activation fail.
- Other provider rows and fictitious tenant/grant sentinels remain unchanged.

This validates the scoped SQL contract; it does not validate Supabase Vault,
the complete production schema, live account access or a financial lifecycle.
Static React rendering also verified the Live default, preservation of a saved
Sandbox environment, two password fields and the old-contract save guard.

## Official contracts inspected

- [Quick Start Guide](https://docs.tamara.co/docs/direct-quick-start-guide)
- [Webhook Registration](https://docs.tamara.co/docs/webhook-subscription)
- [Retrieve Webhook](https://docs.tamara.co/reference/retrievewebhookurlusingwebhookid)
- [Official SDK payment-types request](https://github.com/Tamara-Technology/php-sdk/blob/master/src/Tamara/Request/Checkout/GetPaymentTypesRequestHandler.php)
- [Official SDK response envelopes](https://github.com/Tamara-Technology/php-sdk/blob/master/src/Tamara/Response/Checkout/GetPaymentTypesResponse.php)

The SDK endpoint can be deprecated or account-restricted. An unsupported or
unexpected response fails closed and is not interpreted as a valid connection.

The initial head `e89706f8d76dc87258628200546261a9d91d5386` passed the complete
GitHub Quality workflow, including lint, typecheck, tests, migration verification
and Next.js build. The PR carries the results for each subsequent head.

JSX syntax parsing and an isolated component bundle compilation passed. The
cloud browser could not open the local preview (`ERR_BLOCKED_BY_CLIENT`), so no
visual browser verification is claimed. Live Tamara account verification and
end-to-end payment validation remain pending.
