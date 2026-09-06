# ODEIR Social Connect V2 — Staging Runbook

> Historical plan from PR #126. The 6 September production review supersedes
> the OAuth callback, scope configuration and readiness claims below. Use
> `social-connect-production-review-2026-09-06.md` for the current release.

Status: implementation only. Nothing in this document authorizes a staging or
production deployment.

## Immutable boundaries

- Staging uses the child Test App only.
- Production app credentials never enter staging.
- Reef receives no `social_connect` subscription or V2 rollout row.
- The legacy `marketing_hub.connections` row is read only as a protection gate.
- No App Review, Publish, or production rollout is part of this phase.

## Staging Edge secrets

Store values through Supabase Edge Function Secrets. Never commit a value and
never send the App Secret through chat, screenshots, browser code, or logs.

```text
META_CONNECT_V2_APP_ID
META_CONNECT_V2_APP_SECRET
META_CONNECT_V2_LOGIN_CONFIG_ID
META_CONNECT_V2_GRAPH_VERSION=v26.0
META_CONNECT_V2_RETURN_ORIGIN=https://staging.odeir.com
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are provided
to the Edge runtime by Supabase. The function fails closed when any required
value is absent or malformed.

## Test App callback URLs

These URLs become valid only after the migration and Edge Function are deployed
to the staging project.

```text
Valid OAuth Redirect URI
https://pzflscqwfkixclmjyran.supabase.co/functions/v1/meta-oauth-v2/oauth/callback

Deauthorize callback URL
https://pzflscqwfkixclmjyran.supabase.co/functions/v1/meta-oauth-v2/deauthorize

Data Deletion Request URL
https://pzflscqwfkixclmjyran.supabase.co/functions/v1/meta-oauth-v2/data-deletion

Public deletion instructions/status page
https://staging.odeir.com/data-deletion
```

OAuth strict mode and HTTPS remain enabled. No wildcard redirect is permitted.

## Deployment order after explicit approval

1. Capture a read-only Reef baseline: the legacy Meta connection, Vault-reference
   count, campaign/metric counts, and last sync timestamps.
2. Apply `20260825190000_meta_connect_v2_oauth_control_plane.sql` to staging.
3. Deploy `meta-oauth-v2` with `verify_jwt=false`; the function performs its own
   JWT and HMAC checks because provider callbacks cannot carry an ODEIR JWT.
4. Deploy the Next.js branch to `https://staging.odeir.com` and verify `/privacy`,
   `/terms`, and `/data-deletion` over HTTPS.
5. Configure the three Test App callback URLs above.
6. Create an active `social_connect` subscription for one empty non-Reef sandbox
   tenant only.
7. Add one explicit `rollout_targets` row for that tenant with `pilot` status and
   the required capability. There is no wildcard rollout.
8. Enable `deauthorization` and `data_deletion`, exercise signed callback tests,
   then enable `oauth` last.
9. Run the end-to-end test matrix and compare the Reef baseline byte-for-byte at
   the contract level before considering any additional pilot tenant.

## Required staging test matrix

- Missing, expired, reused, and tampered OAuth state.
- User cancellation and code replay.
- Exact redirect URI and blocked open redirects.
- Token debug response with wrong app ID, missing scope, or invalid token.
- Cross-tenant start attempt and user without `tenant.meta_connect.manage`.
- Tenant with a legacy Meta row returns `legacy_meta_connection_present`.
- Reauthorization rotates the Vault secret and removes the prior secret.
- Disconnect is idempotent and removes credentials without deleting history.
- Invalid, stale, tampered, and duplicate signed callbacks.
- Data deletion retry returns the same confirmation code and no raw identifier is
  retained in the callback journal.
- No token, App Secret, signed request, or Vault UUID appears in browser payloads,
  application logs, snapshots, or audit context.

## Kill switch rollback

Rollback is operational and non-destructive:

1. Set `oauth`, `deauthorization`, and `data_deletion` kill switches to `false`
   as appropriate for the incident. Keep legal callbacks available whenever it
   is safe to do so.
2. Set the affected rollout row to `disabled`.
3. Stop new OAuth starts and callbacks before changing code.
4. Preserve V2 connection and callback history for investigation; do not run a
   down migration or delete Reef/current Marketing Hub data.
5. Re-deploy the previously verified Edge/Next version if the fault is code.

Database rollback is forward-fix only because credential and compliance history
must remain auditable.
