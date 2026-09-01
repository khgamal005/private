# Paymob reconciliation worker

This server-only Edge function reconciles queued Paymob payment attempts. It
does not create Intention requests and cannot update orders, refunds, or
entitlements directly. Every provider result is normalized and applied through
the leased database applicator.

Provider refund/void initiation is intentionally not exposed by this release.
It remains a hard live-rollout blocker until a separate database-governed
maker/checker approval, irreversible dispatch claim, sandbox exercise, and
inquiry-confirmed result contract are implemented. A callback refund flag or a
successful mutation HTTP response is never sufficient refund proof.

## Authentication

- Scheduled calls send `x-odeir-paymob-reconcile-secret` with the dedicated
  `PAYMOB_RECONCILE_DISPATCHER_SECRET` value. Generate at least 32 random bytes
  and store it only as an Edge/scheduler secret.
- An authenticated platform billing administrator may run the same endpoint
  manually with their Supabase JWT in `Authorization: Bearer ...`.
- Never use the anon key, service-role key, a Paymob credential, or a browser
  environment variable as the dispatcher credential.

## Scheduler

Run once per minute after the migration, function, and dispatcher secret are
installed. Send `POST` with `Content-Type: application/json` and a small bounded
body such as `{ "maxJobs": 3 }`. The function caps each invocation at 10 jobs;
the database claim RPC owns leases, retry limits, and exponential backoff.

The expected response contains counts only: `claimed`, `processed`,
`rescheduled`, `reviewRequired`, and checkout-secret cleanup counts. Alert when
rescheduled/review counts rise, `cleanupUnavailable` is true,
`checkoutSecretsFailed` is non-zero, or the endpoint is not returning HTTP 200.
Cleanup failure is isolated from payment reconciliation: the response preserves
the queue result and never attempts a direct Vault fallback.
An RPC timeout is an unknown cleanup outcome, not proof that its database
transaction failed; do not retry it inside the same invocation. The next
one-minute run may safely invoke the idempotent bounded cleanup again.
Do not log the dispatcher header.
`processed` means the SQL applicator classified the evidence; it does not mean
that a payment or refund was accepted. `reviewRequired` and `rescheduled`
include the database applicator's allowlisted disposition as well as worker-side
failures, so scheduler alerts see binding/refund reviews and pending evidence.

At the start of each invocation, the worker calls the service-role-only bounded
`v1_service_paymob_cleanup_checkout_secrets` RPC once with a fixed limit of 25.
The database removes only expired/terminal per-attempt checkout client secrets;
provider credentials are explicitly excluded. The database claim path separately
seeds expired checkouts for authenticated inquiry without stealing an active
reconciliation lease. No secret value or attempt identifier is returned to the
worker.

## Provider behavior

- Known transactions use the fixed KSA `GET
  /api/acceptance/transactions/{transaction_id}` endpoint.
- Ambiguous Intention creation uses the fixed KSA `POST
  /api/ecommerce/orders/transaction_inquiry` endpoint with the immutable
  attempt UUID as `merchant_order_id` (the original `special_reference`).
- The reference endpoint returns only the order's most recent transaction.
  Therefore the worker also requires and passes the authoritative aggregate
  `order.paid_amount_cents`. A positive aggregate with a non-final latest
  transaction is review-only: it cannot close the attempt, free the order for
  another checkout, or pin that non-paid child as the settled transaction.
- The Paymob auth token and full provider response exist only in request memory.
  Storage receives normalized fields plus the SHA-256 response digest.
- Credential rotation never reuses an expired API key. The runtime may use the
  current active credential only when its environment, integration ID, and
  owner exactly match the attempt's immutable credential account; both attempt
  and inquiry credential-version IDs are contract-validated by the worker. The
  inquiry version is sent to the applicator and stored on the reconciliation
  evidence separately from the attempt's immutable credential version.
- Each job performs only one inquiry per invocation. Ambiguous failures return
  to the database's bounded backoff queue; the worker never blindly retries an
  Intention mutation.

Contract sources: [Paymob API integration paths](https://developers.paymob.com/paymob-docs/integration-paths/apis)
and PaymobAccept's official
[Transaction Inquiry API collection](https://github.com/PaymobAccept/API-Postman-Collections/blob/main/Transaction%20Inquiry%20API.postman_collection.json).
