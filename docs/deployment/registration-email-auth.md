# Registration email authentication boundaries

The registration-email control path does not require a shared secret in the
Next/Hostinger deployment.

## Administrative operations

`health`, `canary`, and `activation_grant` are called with the signed-in
platform administrator's Supabase access token. The Edge function does not
trust JWT claims by inspection: it calls the permission-gated
`v1_platform_registration_policy_snapshot` RPC using that token. A missing,
invalid, expired, or unauthorized token fails closed. The application never
uses a Supabase secret/service key for these calls.

The durable email worker remains authenticated with its independent worker
credential. Resend webhooks remain authenticated by the signature over the
exact raw request body.

## Public confirmation capability

The email link contains a 256-bit, expiring, one-time capability. GET only
validates its shape, stores it in a `HttpOnly`, `SameSite=Strict` cookie scoped
to the confirmation endpoint, and redirects to the explicit confirmation
screen. POST requires the exact canonical public Origin before it can consume
that cookie.

The canonical origin comes from a validated `ODEIR_PUBLIC_APP_URL`; invalid or
internal values fall back to exactly `https://odeir.com`. Redirects must never
be built from `request.nextUrl.origin`, `Host`, or forwarded-host headers.

Edge accepts the capability without an ingress secret. It rate-limits 64 fixed
hidden shards derived with the independent Edge-only
`ODEIR_REGISTRATION_RATE_SALT`: 30 attempts per minute and 120 attempts per 10
minutes per shard. The two windows use at most 128 rate-limit rows, so random
tokens cannot grow the table without bound. This also avoids a denial of
service caused by treating a shared Next/Hostinger egress IP as all customers.
Forwarded client-IP headers are deliberately ignored. Database locking,
expiry, and consumption remain the authoritative one-time gate.

## Deployment and rollback

- Configure an independent random `ODEIR_REGISTRATION_RATE_SALT` of at least
  32 bytes only as an Edge secret. The function fails closed if it is absent.
- Configure `ODEIR_PUBLIC_APP_URL=https://odeir.com` in both runtimes.
- Do not configure `ODEIR_REGISTRATION_INGRESS_TOKEN` in Next/Hostinger.
- Deploy the Edge function before the matching Next release so administrator
  JWT calls are accepted when the UI switches over.
- Keep the registration policy on `manual_review` until a signed Resend
  `delivered` event proves the isolated production canary.

Rollback is code-only: restore the previous Edge and Next versions. No schema,
tenant, registration-policy, or customer-data change is part of this boundary.
