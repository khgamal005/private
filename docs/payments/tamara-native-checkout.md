# Native Tamara add-on checkout

Status: implementation candidate; production activation is a separate release.

## Engineering gate

Difficulty: 8/10. The sensitive boundaries are ambiguous provider mutations, capture after digital delivery, concurrent entitlements, credential rotation, and refunds. Canonical `marketplace.orders`, pricing, taxes, promotions, payment events and subscription history remain authoritative. No duplicate sales ledger is introduced.

This migration creates five isolated Tamara tables and no tenant/credential/rollout rows. Existing Paymob attempts and credential versions are not altered. Two narrow canonical-table triggers protect only orders with a Tamara attempt. The promotion active-attempt helper retains its Paymob predicate and adds a Tamara predicate. The add-on storefront reads a versioned snapshot that appends eligible Tamara; service checkout remains on its existing contract.

## Lifecycle

1. A caller with `tenant.settings.manage` creates a canonical add-on order using the existing catalog helper. Bank-transfer and Paymob orders cannot be adopted. Promotions are calculated by the existing server function.
2. Preparation locks that order, creates one immutable attempt, and pins its amount, tax, discount, product, feature, billing interval and Vault credential version. The browser cannot supply amounts, tenant IDs, integration IDs, or entitlement grants.
3. The worker durably consumes a create claim before POST `/checkout`. The customer supplies their real contact and billing information; card details stay with Tamara. Contact/address fields are removed from the persisted capture payload.
4. Returns are display-only. Native HS256 notifications schedule a durable inquiry; the notification body itself never settles an order. GET by provider ID or ODEIR attempt reference binds identity, amount, currency, captured/refunded totals and state.
5. Approved orders are authorised once. Authorised digital add-ons are provisioned once with an explicit source record, while the canonical order remains payment-pending. Capture is sent only after persisted digital delivery. Fully captured evidence marks the canonical order paid and completed.
6. A full refund observed from Tamara reverses only an unchanged grant from that source. Later administrator/subscription/module changes cause review and are preserved. Partial captures/refunds and capture-without-delivery require review. Refund initiation remains in Tamara Business; this release does not add a second refund UI.

Ambiguous POSTs are never automatically reissued. A leased worker recovers by GET. A lost checkout link can remain pending until authoritative provider expiry or operator resolution; it must not be replaced by a second charge. Disabling a rollout stops new attempts while old versions continue reconciling existing payments.

## Credentials and operations

The existing two secret fields remain the entry point. Runtime preparation copies API and notification values into immutable Vault secrets; rotating the editable source keys cannot break an in-flight attempt's key binding. A revoked version is not used by workers. Source rotation makes new-checkout eligibility fail until a fresh runtime version is prepared.

The platform billing administrator prepares a new, dedicated ODEIR webhook subscription. Existing merchant subscriptions are never updated or deleted. Ambiguous registration is held for inspection in Tamara Business; do not repeatedly register new subscriptions. Setup also schedules `odeir-tamara-runtime-v1` with its own Vault dispatcher token. It never changes `odeir-paymob-runtime-v2` or its credentials.

New business tables have tenant FKs, indexes, RLS, and no direct anon/authenticated/service-role table access. Public RPC privileges are explicit; privileged helpers use an empty search path. Queue claims use `FOR UPDATE SKIP LOCKED`, a lease and a fencing token. Provider HTTP calls happen after transactions finish. Safe error codes replace upstream response bodies.

## Release sequence (requires explicit deployment authorization)

- Run the repository Quality workflow on the exact candidate commit. Review the live schema drift, payment-provider flags, existing cron jobs and untouched Paymob assets/functions.
- Apply `20260906133000_tamara_native_addon_checkout_v1.sql` first. This does not enable any tenant.
- Deploy `tamara-checkout`, `tamara-webhook`, `tamara-reconcile`, and `tamara-setup` with the JWT settings in `supabase/config.toml`, then the Next application.
- In Tamara settings, use **عرض حالة التشغيل** then **تجهيز تأكيد الدفع والمطابقة**. Keys are read server-side from Vault. Check the dedicated webhook URL and scheduler execution before any rollout.
- Select a designated non-Reef test tenant for provider testing. Sandbox requires separate sandbox keys. Do not run financial probes or create test records in Reef. Production purchases require a named buyer and explicit approved amount.
- Verify checkout link, approved→authorised→digital delivery→capture→paid, duplicate notifications, timed-out create recovery, decline/expiry, full refund and changed-entitlement review with provider evidence. Read-only preflight alone does not prove this cycle.
- Enable the specifically approved Live tenant(s). Verify desktop/mobile RTL layout and payment status on the deployed candidate. No promise of zero impact substitutes for these release checks.

## Rollback

Disable the new Tamara tenant rollouts first. Keep native webhook/reconciliation and pinned versions running until open attempts and refund obligations resolve. Revert the new storefront entry if necessary; do not delete orders, evidence, source records, Vault versions or migrations. Never disable Paymob as part of this rollback. The old v2 marketplace snapshot remains callable.

## Verification

Local tests execute the migration and lifecycle against PGlite using a minimal fixture derived from live column/check constraints, with deterministic permission/Vault stubs and synthetic tenants. They cover isolation, duplicate preparation, fenced claims, financial immutability, provisional delivery, capture, stale evidence, refund and later-manual-grant preservation. The fixture is not a substitute for all live triggers, extensions or a real provider acceptance test.

Protocol tests cover decimal precision, currency/reference binding, redirect allowlists, exp/nbf/algorithm verification, body bounds, ambiguous POST recovery, capture claims, and secret-free gateway responses. Existing Paymob checkout/QuickLink tests are also rerun. The cloud browser blocked local preview URLs; final visual verification remains a deployment gate.

## Brand sources

Tamara Arabic badge: https://cdn.tamara.co/assets/svg/tamara-logo-badge-ar.svg (original official artwork, self-hosted). Visa, Mastercard, mada, Amex and Apple Pay reuse existing local assets. The Apple Pay compound path uses even-odd fill so its lettering is not a solid black rectangle. Apple Pay is advertised in the provider card only when the server exposes that option. No fixed instalment count, fee or guaranteed approval is advertised.

Provider contract references: https://docs.tamara.co/reference/createcheckoutsession ; https://docs.tamara.co/reference/captureorder ; https://github.com/Tamara-Technology/php-sdk .
