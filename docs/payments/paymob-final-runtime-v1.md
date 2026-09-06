# Paymob final runtime v1

## Purpose

ODEIR uses **Paymob QuickLink Hosted Redirect** for card, mada and Apple Pay checkout in Saudi riyals. ODEIR calculates the immutable order total on the server, stores the provider link before returning it to the browser, and accepts financial settlement only from a verified signed webhook or an authenticated read-only provider inquiry applied through the same database ledger checks.

This release removes the unnecessary database-to-Edge scheduler hop. The production minute scheduler calls a bounded database-owned reconciliation tick directly, so an HTTP `401` can no longer be hidden behind a successful pg_cron SQL invocation. The `paymob-reconcile` Edge Function is now only a JWT-protected manual administrator wrapper and is not part of scheduled processing.

## Recovery order

1. A signed Paymob webhook remains the primary settlement source.
2. When a durable provider transaction id exists, reconciliation performs the documented transaction-id inquiry.
3. For QuickLink attempts with a durable Paymob order id, reconciliation performs Paymob's documented `order_id` transaction inquiry.
4. Merchant-order/reference inquiry remains a compatibility fallback only when no Paymob order id is available.
5. A `404` never closes a fresh attempt. It can close an attempt only after the provider link has expired plus a 30-minute safety window and only when the order has no payment event, no webhook delivery, no provider transaction id and no active sibling attempt.

## Financial invariants

- Reconciliation does not create a payment, QuickLink, Intention, capture or refund.
- The worker never trusts browser amounts or return-page query parameters.
- The existing SQL applicator remains the only component that can classify an authenticated inquiry as paid, failed, pending, refunded or review-required.
- A missing transaction can only set an expired pending order to failed so the customer can retry safely. It cannot set `paid`, activate an add-on, start a service or issue an entitlement.
- Late signed evidence is still handled by the authoritative webhook/applicator path and never by the return page.
- Promotion reservations and expired checkout-link secrets are cleaned by the same bounded minute tick after reconciliation.

## Scheduler

The single active job is:

```sql
select private_app.paymob_reconciliation_tick_v2(10);
```

It runs once per minute and processes at most ten jobs. The function is private and execution is revoked from browser, anonymous, authenticated and service-role API callers; pg_cron invokes it as the database owner.

## Customer experience

- Issuer declines resolve to a terminal failed attempt and leave the order available for another card.
- A pending provider result remains under automatic review without creating a second charge.
- An expired QuickLink with no transaction is closed automatically after the safety window.
- The customer sees Arabic status text in ODEIR and does not need to create a new order.

## Release evidence boundary

The software path can be verified without charging a card: scheduler registration, order-id inquiry routing, HMAC rejection, idempotency, amount binding, promotion binding, cleanup and retry availability.

The following readiness evidence must never be fabricated and can only be recorded after the corresponding real provider event:

- a live paid transaction and signed callback;
- duplicate delivery of that callback;
- a live issuer-declined or failed transaction callback;
- credential-rotation callback verification;
- refund inquiry and refund initiation.

Until those commercial events occur, ODEIR keeps the provider readiness record truthful even though controlled tenant checkout is operational.
