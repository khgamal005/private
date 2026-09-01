# Payment provider security

This document defines the production boundary for Tamara, Paymob, and PayPal
payments in the ODEIR marketplace. It is an implementation contract, not a
claim that any provider is currently live.

The Arabic-first operational acceptance and go-live procedure for Paymob is in
[`paymob-operations-runbook.md`](./paymob-operations-runbook.md).

The existing `marktone_hmac` webhook may remain an internal service-to-service
channel. It must not be used as a wrapper that converts Tamara, Paymob, or
PayPal payloads into a generic "verified" payment.

## Security invariants

- The provider is selected by a fixed endpoint/configuration, never by the
  request body.
- Browser redirects never mark an order paid or activate an add-on.
- A provider event is untrusted until its provider-native signature is verified.
- The tenant, order, expected amount, currency, and term come from an immutable
  payment attempt created before checkout, not from the webhook.
- Sandbox credentials and events cannot affect live attempts, and vice versa.
- Only explicitly allowlisted final-payment states can activate an entitlement.
- Money uses integer minor units; provider decimal strings are converted without
  floating-point arithmetic.
- A refund or expiry never deletes tenant data.
- Removing one paid entitlement source must not disable a feature still granted
  by a plan, trial, or platform grant.
- Provider credentials are stored in Supabase Vault and never returned to the
  browser, snapshots, exports, logs, or support bundles.

## Adapter contract

```ts
export type ProviderKey = "tamara" | "paymob" | "paypal";
export type ProviderEnvironment = "sandbox" | "live";

export type NormalizedPaymentEventType =
  | "authorized"
  | "paid"
  | "failed"
  | "cancelled"
  | "partially_refunded"
  | "refunded"
  | "disputed"
  | "ignored";

export type VerifiedProviderEvent = {
  // Set by the endpoint, not copied from the request body.
  providerKey: ProviderKey;
  environment: ProviderEnvironment;
  providerEventId: string;
  providerDeliveryId?: string;
  providerOrderId: string;
  providerPaymentId?: string;
  providerRefundId?: string;
  merchantAccountId?: string;
  type: NormalizedPaymentEventType;
  amountMinor?: bigint;
  currency?: string;
  occurredAt?: string;
  payloadSha256: string;
  verificationMethod: string;
  sanitizedMetadata: Record<string, unknown>;
};

export interface PaymentProviderAdapter {
  verifyAndParse(
    request: Request,
    config: RuntimeProviderConfig,
  ): Promise<VerifiedProviderEvent>;

  createCheckout(
    input: ImmutableCheckoutInput,
    config: RuntimeProviderConfig,
  ): Promise<ProviderCheckout>;

  retrievePayment(
    reference: ProviderReference,
    config: RuntimeProviderConfig,
  ): Promise<AuthoritativeProviderState>;

  refund?(
    input: RefundInput,
    config: RuntimeProviderConfig,
  ): Promise<ProviderRefund>;
}
```

`verifyAndParse` must either return a verified, normalized event or throw a
typed error. It must never return an event with a caller-supplied
`signatureVerified` boolean.

## Checkout and webhook flow

1. An authorized tenant user creates a marketplace order idempotently.
2. The server snapshots item price, tax, currency, term, order, and tenant.
3. The server creates a `payment_attempt` with a stable idempotency key.
4. The adapter creates the provider order/intention and persists its external
   ID before returning the provider checkout URL.
5. The customer completes checkout. The return URL is display-only.
6. The provider-specific endpoint verifies the native signature on the original
   request and records a webhook receipt.
7. The common pipeline resolves the attempt by stored external identifiers.
8. One database transaction locks the receipt, attempt, order, and entitlement
   source; validates all bindings; appends the event; and projects state.
9. The endpoint returns a minimal acknowledgement. It never returns order or
   tenant details.

The database applicator should accept a verified `receipt_id`, not arbitrary
provider fields plus `signature_verified=true`. It must confirm the receipt is
verified, unapplied, and bound to the same provider/environment as the attempt.

## Provider matrix

| Provider | Native verification | Required binding | Activating event | Never activates |
|---|---|---|---|---|
| Tamara | `tamaraToken` JWT, HS256 with the Vault Notification Token; retrieve authoritative state for financial transitions | environment, Tamara order ID, merchant reference, amount, currency | fully captured `order_captured` only | approved, authorised, partial capture, declined, expired, cancelled, unknown |
| Paymob | callback-profile-specific HMAC SHA-512 using the documented ordered fields and Vault HMAC secret | credential version, environment, integration/owner, Paymob order and transaction IDs, amount, currency | successful, non-pending standalone charge with no parent | pending, auth-only, capture-child, failed, error, void, refund, unknown |
| PayPal | official verify-webhook-signature postback returning `SUCCESS`; hardened self-verification may replace it later | environment, webhook ID, payee merchant ID, PayPal order/capture IDs, amount, currency | `PAYMENT.CAPTURE.COMPLETED` only | order approved, capture pending/denied, unknown |

### Tamara adapter

- Store API Token and Notification Token separately for sandbox and live.
- Parse exactly three JWT segments and strictly require `alg=HS256`; reject
  `none`, algorithm substitution, an empty secret, malformed base64/JSON, and
  invalid `exp`/`nbf` claims when present.
- Use a timing-safe HMAC comparison.
- Prefer a header token when the merchant contract supports it. If Tamara
  requires `tamaraToken` in the query string, redact it from access logs.
- Do not assume the JWT cryptographically binds every body field unless the
  current Tamara contract confirms this. Retrieve the order before applying
  capture/refund events.
- Match Tamara `order_id` and `order_reference_id` to the stored attempt.
- A partial capture does not activate an indivisible annual add-on.
- A full refund removes only the entitlement source created by that order;
  partial refunds enter review.

### Paymob adapter

- Store API/secret material and HMAC secret in Vault, per environment.
- Version the HMAC recipe, for example `transaction_processed_v1`. Do not reuse
  a transaction recipe for card-token or subscription callbacks.
- For the classic Transaction Processed callback, confirm the current account
  contract and official fixture before implementing the documented ordered
  fields: `amount_cents`, `created_at`, `currency`, `error_occured`,
  `has_parent_transaction`, `id`, `integration_id`, `is_3d_secure`, `is_auth`,
  `is_capture`, `is_refunded`, `is_standalone_payment`, `is_voided`, `order.id`,
  `owner`, `pending`, `source_data.pan`, `source_data.sub_type`,
  `source_data.type`, `success`.
- Extract values using Paymob's exact string/boolean/null rules, hash with
  SHA-512, and use a timing-safe comparison.
- Validate `integration_id` and merchant owner against the configured account.
- Resolve a callback from its signed provider order/transaction binding. Treat
  `special_reference` as an additional comparison only because it is not in the
  published 20-field Transaction HMAC recipe; ambiguous creates are recovered
  through authenticated transaction inquiry by `merchant_order_id`.
- Treat auth-only, pending, voided, failed, and errored transactions as
  non-activating. Confirm ambiguous paid/refund state through Paymob's API.
- Fields such as `source_data.pan` may be needed temporarily for HMAC but are
  discarded after verification and never logged or stored.

### PayPal adapter

- Store the client secret in Vault and bind client ID, webhook ID, merchant ID,
  and environment in provider configuration.
- Require the official transmission headers: auth algorithm, certificate URL,
  transmission ID, signature, and transmission time.
- Post the unchanged webhook event plus these values to PayPal's fixed
  environment-specific `v1/notifications/verify-webhook-signature` endpoint.
  Accept only `verification_status=SUCCESS`.
- Use `event.id` as the event idempotency key and the transmission ID as the
  delivery identifier.
- Match `resource.payee.merchant_id`, related order ID, capture ID, amount, and
  currency to the attempt.
- Do not apply the internal five-minute HMAC window to PayPal retries. Signature
  verification and event uniqueness provide replay protection.
- If self-verification is introduced, compute CRC32 from the original raw body,
  restrict certificate URLs to HTTPS PayPal hosts for the selected environment,
  reject redirects/private addresses, and cache certificates safely to avoid
  SSRF and excessive downloads.

## Persistence and constraints

Additive tables are preferred during migration:

| Table | Purpose and essential constraints |
|---|---|
| `marketplace.payment_provider_configs` | one operational row per provider, with explicit `environment` and `credentials_environment`; non-secret merchant binding and readiness state |
| `marketplace.payment_provider_secret_refs` | Vault references bound to the credential environment; changing environment requires a complete required-secret rotation |
| `marketplace.payment_attempts` | immutable order/tenant/amount/currency snapshot and external IDs; unique provider order/payment IDs and idempotency key |
| `marketplace.webhook_deliveries` | event/delivery keys, payload hash, verification and processing state, redacted reason codes |
| `marketplace.payment_refunds` | external refund ID, capture/payment ID, amount, currency, and pending/succeeded/failed state |
| `marketplace.payment_reconciliations` | authoritative provider checks, differences, retry schedule, and review state |
| entitlement source ledger | independent plan, platform-grant, trial, and paid-order sources |

The applicator must verify `attempt.tenant_id == order.tenant_id`; tenant IDs
from a webhook are ignored. Use advisory/row locks and unique constraints for:

- `(provider, environment, provider_order_id)`;
- `(provider, environment, provider_payment_id)` when present;
- `(provider, environment, provider_event_id)`;
- `(provider, environment, provider_refund_id)`;
- an attempt idempotency key that survives provider/API timeouts.

For providers without a stable event ID, derive a deterministic semantic key
from verified order/payment/action identifiers and normalized state. Never use a
fresh UUID per delivery.

## Replay, retries, and responses

- Insert or resolve the webhook receipt before state mutation.
- A duplicate verified event returns success without another event,
  subscription extension, or audit transition.
- A crash after receipt but before application resumes the pending receipt.
- A crash after application but before HTTP response returns duplicate success
  on retry.
- Different event IDs claiming the same capture are quarantined, not silently
  treated as another payment.
- Unknown but validly signed event types are recorded as `ignored` and
  acknowledged without activation.
- A valid event with order, merchant, amount, or currency mismatch is recorded
  as `quarantined`, acknowledged to avoid a retry storm, and alerts billing.
- Signature failure returns 400/401. Temporary provider-verification or database
  failure returns 503. Duplicate/ignored/applied returns a minimal 2xx response.

## Refunds, reversals, and reconciliation

- Record every external refund idempotently and sum successful refunds against
  the original capture.
- A full refund marks the order refunded and revokes only the paid-order
  entitlement source.
- A partial refund for an indivisible add-on is `partially_refunded` and enters
  review; it does not disable the feature automatically.
- Disputes/reversals follow an explicit pause/grace policy and never delete
  tenant content, CRM data, integrations, or audit history.
- A scheduled reconciler retrieves authoritative state for stale attempts,
  missed webhooks, refunds, and mismatches. Reconciled final events pass through
  the same receipt and applicator pipeline.

## Vault and administrative access

- Provider config rows contain Vault IDs/references, never plaintext secrets.
- A narrowly authorized platform RPC creates or updates Vault entries.
- No API offers "show secret" after saving. The UI may show `configured`, a
  non-reversible fingerprint/last-four indicator, updater, and rotation time.
- Logs and audit context use centralized redaction for authorization headers,
  query tokens, signatures, raw payloads, PAN, and payer information.
- Paymob rotation versions the complete API/Secret/Public/HMAC bundle with its
  merchant bindings. One previous version may remain `retiring` for seven days;
  emergency revocation ends that overlap immediately. Attempts stay bound to
  the version that created them.
- Each Paymob credential version also owns a generated, Vault-only internal key
  for billing-contact digests. It is never sent to Paymob or returned by an RPC,
  and the external callback HMAC secret is not reused for pseudonymization.
- Tenant roles cannot read or update platform payment configuration.

## Configured is not active

Saving credentials or passing an API ping must not display "connected" or make
the provider available to tenants. Use an explicit readiness state machine:

```text
unconfigured
  -> credentials_saved
  -> api_verified
  -> webhook_pending
  -> sandbox_verified
  -> live_verification_pending
  -> live
  -> degraded | disabled
```

`live` requires a real low-value checkout, native verified webhook, state
binding, reconciliation, duplicate delivery test, and refund test. Tenant
checkout lists only providers in `live` state for the applicable currency and
country.

The public Paymob callback must also sit behind a WAF and rate limit before
live activation. Structural validation and HMAC verification do not by
themselves prevent resource-exhaustion traffic against a public endpoint.

The v3 foundation intentionally blocks every transition to `active` until a
provider-native adapter ships with checkout, signed-webhook, merchant-binding,
reconciliation, duplicate-delivery, and refund evidence. Provider-admin saves
are actor-attributed; the old unattributed bundle and one-secret RPCs remain
present only so stale callers fail closed with a stable upgrade error.

The platform UI should show API health, webhook health, last verified delivery,
last successful payment, quarantined count, reconciliation differences,
refunds awaiting review, credential fingerprint/rotation date, and a kill
switch. No secret value is rendered.

Manual settlement is a separate provider key and workflow. It must not claim to
be Tamara, Paymob, or PayPal; it requires a reference, amount, currency, reason,
evidence, audit trail, and preferably different maker/checker subjects.

## Reef-safe rollout

1. Capture pre-change counts/snapshots for orders, subscriptions, entitlement
   sources, modules, and Reef operational records.
2. Deploy only additive schema and read-only provider health UI first.
3. Run each adapter in sandbox and then `observe_only`; verify and store events
   without mutating orders or entitlements.
4. Exercise success, failure, cancellation, replay, amount mismatch, and full
   refund on a dedicated training tenant.
5. Give Reef its 2026-08-01 to 2027-08-01 add-ons as independent
   `platform_grant` sources. Do not create fake paid orders or provider events.
6. Verify Reef customer, task, call, CMS, and integration records are unchanged;
   only the intended grants and derived visibility may change.
7. Enable one provider for one canary tenant, then expand gradually after live
   payment and refund reconciliation succeeds.

## Rollback

Rollback is operational and non-destructive:

1. Activate the provider kill switch to stop new checkout attempts.
2. Change webhook handling to `observe_only`; continue verification and receipt
   storage so no provider events are lost.
3. Stop reconciliation mutations while continuing discrepancy reports.
4. Quarantine the affected provider/environment/time range and compare the
   provider ledger to attempts and entitlement sources.
5. Reverse any incorrect entitlement by removing only its specific source in an
   audited, reviewed transaction. Do not restore a database backup over newer
   tenant data and do not delete migrations or payment history.
6. Re-run the failing case in sandbox/canary before re-enabling live checkout.

Reef platform grants are independent of payment adapters and remain active when
a provider is disabled or rolled back.

## Minimum acceptance tests

- Official valid and invalid signature fixtures for every adapter.
- Tamara algorithm substitution, expired/not-yet-valid JWT, and partial capture.
- Paymob mutation of every signed field, wrong integration, pending/auth/void,
  and callback-profile mismatch.
- PayPal verification failure/timeout, wrong webhook/merchant/environment,
  approved/pending versus completed capture, and duplicate event delivery.
- One-minor-unit amount mismatch, currency mismatch, external ID reuse, and
  cross-tenant/order binding attempts.
- At least 50 concurrent deliveries of one event yield one payment transition
  and one entitlement source.
- Crash/retry before and after event application remains idempotent.
- Full and partial refunds, out-of-order events, missed-webhook reconciliation,
  and preservation of tenant data.
- No secret in UI, responses, logs, snapshots, exports, audit context, or tenant
  access paths.
- API verification alone does not promote a provider to `live`.
- Reef isolation check confirms no operational row changes outside the intended
  platform grants.

## Official references

- Tamara webhook registration:
  https://docs.tamara.co/docs/webhook-subscription
- Tamara webhook events:
  https://docs.tamara.co/reference/getting-started-with-webhooks
- Tamara API reference:
  https://docs.tamara.co/reference/tamara-api-reference-documentation
- Paymob webhooks and HMAC:
  https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac
- Paymob transaction callbacks:
  https://developers.paymob.com/paymob-docs/manage-callback/transaction-callbacks
- PayPal webhook verification guide:
  https://developer.paypal.com/api/rest/webhooks/rest
- PayPal verify-webhook-signature endpoint:
  https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post

Provider documentation and merchant contracts can change. Pin the API version,
signature profile, fixtures, account identifiers, and verification date in code
and tests before promoting an adapter to `live`.
