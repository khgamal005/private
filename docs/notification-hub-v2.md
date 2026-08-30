# Odeir notification hub v2

This release adds a private, durable notification plane for registration,
add-ons, purchases and operational failures. It is additive and cannot send
mail or schedule monitoring merely because the migration was applied.

## Safety boundary

- `capture_enabled`, tenant email, platform email and the operational monitor
  all default to `false`.
- Event and delivery tables use forced RLS and have no direct grants, including
  to `authenticated` and `service_role`. Access is only through the documented
  security-definer contracts.
- Tenant recipients are limited to the requesting subject or an active tenant
  owner at capture time and again when the worker claims a delivery.
- Platform recipients must still hold the exact permission stored with the
  event when a delivery is claimed.
- The outbox stores a subject reference, immutable locale and idempotency key.
  It does not store a recipient address, rendered body or bearer capability.
- Database transactions only enqueue. Resend calls remain in the isolated
  registration Edge worker after a short, bounded lease is acquired.

## Event coverage

| Area | Events |
| --- | --- |
| Registration | request received; confirmation/review/owner email terminal failure, bounce, complaint or suppression |
| Add-ons | activation requested, accepted, rejected, trial, pause, resume, renewal, scheduled cancellation, cancellation and expiry |
| Purchases | order created, paid, payment failed, payment reminder, refund, cancellation and activation failure/stall |
| Services and transfers | in progress, completed, bank transfer submitted/reviewing/approved/rejected/cancelled/overdue |
| Operations | registration worker stale, lifecycle worker stale and lifecycle email failure/bounce |

Arabic and English registration templates cover confirmation, manual-review
receipt and owner invitation. Commerce messages select the tenant locale;
platform action mail uses the configured platform locale.

## Staged activation

1. Apply the migration while all flags remain off.
2. Deploy the web application and Edge worker, then confirm the notification
   center loads and both workers report healthy.
3. Enable event capture only. Verify event idempotency, permission fan-out and
   tenant isolation in staging.
4. Enable platform email for a controlled operator group and verify Resend
   delivery/webhook reconciliation.
5. Enable tenant email and verify one Arabic and one English tenant.
6. Enable the operational monitor. If `pg_cron` is unavailable, the UI reports
   that the independent monitor was not scheduled and the flag can be disabled
   without affecting capture.

## Rollback

Use the notification-center settings to disable, in order: operational monitor,
tenant email, platform email and event capture. Disabling the monitor also
unschedules its known cron job. The additive tables can remain in place while
the previous web and Edge versions are restored; no tenant, order,
subscription, registration request or Reef data must be rewritten or deleted.

Queued deliveries are cancelled at claim time while their channel is disabled.
Re-enabling a channel does not replay cancelled rows; a deliberate new domain
transition or an explicitly reviewed requeue is required.
