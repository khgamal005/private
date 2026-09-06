# Tamara service delivery and payment replacement

User authorization: 2026-09-06, Live for all existing tenants, service capture only after platform-confirmed delivery. The rollout and Paymob credentials remain governed by their existing controls.

## Lifecycle

Service checkout reuses canonical orders, items, briefs and assignments. Native Tamara preparation pins credentials and the commercial snapshot. Verified authorisation starts service execution but does not record payment. A billing administrator supplies a delivery reference in the services console. A single capture can start only after that confirmation; authoritative inquiry then records paid/completed. Delivery evidence remains after refund. No add-on entitlement is created for a service.

The worker cancels an undelivered authorisation after 20 days measured conservatively from checkout creation. Tamara documents automatic capture after 21 days from authorisation: https://docs.tamara.co/docs/direct-online-checkout . A cancel POST is claimed once; uncertain outcomes are reconciled, never replayed. Provider capture without local delivery confirmation enters review. Provider/network outages can prevent timely cancellation and require operator review in Tamara Partners; the integration cannot override provider-side automatic capture.

## Existing Paymob orders

Resume displays bank transfer, Paymob and eligible Tamara with the existing shared brand picker. Choosing an alternative explicitly requests replacement. The database accepts only an unpaid order without an attempt, or attempts conclusively marked `provider_intention_expired_no_payment` and already expired. Active, unknown, paid and other failed outcomes are refused. The old order is cancelled while retaining its Paymob binding and all evidence. A linked replacement is created atomically at the same total; stale prices roll back the entire operation. Repeated requests return the same replacement. No payment is started automatically during replacement.

## Engineering gate

- Difficulty: 8/10; financial fencing, delivery lifecycle, and expired-payment replacement are the critical paths.
- Additive tenant-scoped delivery evidence table with RLS and no direct API grants. Privileged RPCs check current tenant or platform permissions. All new execution grants are explicit.
- Reuses current order/assignment reporting and audit history. Payment status stays pending during authorised service execution.
- Product, Paymob-order and row locks serialize replacement with checkout and settlement. Financial network calls occur only after database transactions return.
- No Reef business rows, Paymob configuration, credentials, functions or cron jobs are rewritten by deployment. Replacement runs only when requested by the signed-in buyer.
- Tests use synthetic data: no live purchase, capture, cancellation, refund, or customer records.

## Release and rollback

Apply `20260906153331_tamara_service_capture_v1.sql`, deploy the updated native Tamara workers with their existing custom-auth configuration, then release the application. Verify both stores and the existing-order chooser through the authenticated UI without submitting payment.

To roll back new exposure, restore the previous service snapshot/API/UI routes and disable new Tamara orders through the existing runtime controls. Keep the new database objects and updated worker running for already-created service attempts; rolling a worker back to automatic add-on provisioning while service attempts exist is unsafe. Never remove delivery/payment history or reset consumed financial-operation timestamps.
