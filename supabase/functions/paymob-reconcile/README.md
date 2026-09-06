# Paymob reconciliation runtime

Production scheduling is database-owned. `pg_cron` invokes the bounded private
`paymob_reconciliation_tick_v2` function once per minute, so scheduler health
does not depend on an HTTP hop, an Edge dispatcher secret, or a service-role key
inside an Edge Function.

## Manual gateway

`paymob-reconcile` is an optional administrator gateway only. Supabase verifies
the caller JWT, then the function forwards that same JWT with the public anon key
to `v2_platform_paymob_reconcile_now`. The RPC independently requires
`platform.billing.manage`.

The gateway:

- accepts only `POST` and an optional integer `maxJobs` from 1 to 10;
- has bounded request, response and timeout limits;
- never reads a Paymob API key, Vault secret or service-role credential;
- never calls Paymob directly;
- never creates checkout, capture, refund or entitlement mutations.

## Scheduled reconciliation

The database worker uses immutable attempt bindings and the active credential
version to perform read-only Paymob inquiries:

1. known provider transaction ID;
2. durable QuickLink Paymob `order_id`;
3. merchant-order reference only as a compatibility fallback.

A response is normalized and applied only by the existing leased SQL applicator.
A missing transaction can close an expired QuickLink only after a 30-minute
safety window and only when payment events, webhook deliveries, provider
transaction IDs and active sibling attempts are all absent.

Signed HMAC webhook processing remains the primary settlement path. Neither the
return page nor the manual gateway can mark an order paid.

## Operations

The minute tick also releases expired promotion reservations and removes only
terminal or expired per-attempt checkout-link secrets. Provider credentials are
excluded from that cleanup.

Contract source: PaymobAccept's official Transaction Inquiry collection, which
documents `POST /api/ecommerce/orders/transaction_inquiry` with either
`order_id` or `merchant_order_id`.
