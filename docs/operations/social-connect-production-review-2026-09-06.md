# Social Connect production readiness — 6 September 2026

Scope: ODEIR (`Marktonesa/marktone-platform-control`, `odeir.com`), production
Supabase `gswpbwdactcstkasddta`. This does not concern Marktone CRM.

## Verdict

The original PR #126 is an OAuth control plane, not an advertising reporting
integration. Its isolated design is reusable, but it must not be advertised or
enabled as a working campaign/analytics add-on. The old branch is 133 main
commits behind as of this review; these changes are based on current main.

## Corrected before any rollout

- Same-origin callback with an HttpOnly browser state cookie and authenticated
  subject comparison before exchanging a Meta authorization code.
- Least-privilege reporting contract: `ads_read`; implicit `public_profile` is
  allowed. `business_management`, page scopes and advertising write grants are
  rejected. Configure a new Meta Login for Business configuration accordingly.
- Explicit terminal OAuth state, final authorization checks, revocation ordering
  and serialized credential changes with executable database regression tests.
- Documented server-side long-lived token exchange, bounded network calls, safe
  errors and no provider credentials in browser responses.
- Working retry, accurate expiry/notice states, product navigation, verified data
  deletion status and reuse of the published CMS privacy/terms pages.

## Still required for campaign analytics

1. Discover authorized accounts via `/me/adaccounts` with `appsecret_proof`.
2. Select an account and verify membership before binding it to the tenant.
3. Persist account currency/timezone and paginated campaign/Insights snapshots.
4. Queue bounded first sync and scheduled refresh with retry/backoff and usage
   headers, without querying Meta on every dashboard render.
5. Display campaign results and attribution settings with last successful sync;
   avoid mixed-currency totals and adding reach across days.
6. Run an end-to-end authorization and reporting test with a permitted Meta user.

## Production configuration (never paste secrets into chat)

Set these in production Supabase Edge Function Secrets using the **parent
production app**, not Test App `2376813156460060`:

```
META_CONNECT_V2_APP_ID=<production app ID>
META_CONNECT_V2_APP_SECRET=<production app secret>
META_CONNECT_V2_LOGIN_CONFIG_ID=<new ads_read configuration ID>
META_CONNECT_V2_GRAPH_VERSION=v26.0
META_CONNECT_V2_RETURN_ORIGIN=https://odeir.com
```

Exact OAuth redirect after this version is deployed:
`https://odeir.com/api/tenant/social-connect/callback`

Deauthorization:
`https://gswpbwdactcstkasddta.supabase.co/functions/v1/meta-oauth-v2/deauthorize`

Data deletion:
`https://gswpbwdactcstkasddta.supabase.co/functions/v1/meta-oauth-v2/data-deletion`

Privacy: `https://odeir.com/p/privacy-policy`

Terms: `https://odeir.com/p/terms-of-use`

The public function `/health` reports only configuration readiness and explicitly
reports `analyticsReady:false`. It does not prove app review or valid credentials.

## Engineering gate and release boundary

The migration is additive, private and disabled by default. It creates no tenant
subscription or rollout grant, changes no legacy marketing connections and
performs no backfill. Reef remains protected by the existing-connection check.
Database prerequisites were inspected on production. Do not enable OAuth until
compliance callbacks and the production app configuration have been verified.

Preserve data on rollback: disable OAuth and the affected rollout target; retain
compliance callbacks and history. No destructive down migration is required.

Difficulty: secure OAuth foundation 7/10; complete reporting integration 8/10.
The bounded global V2 transaction lock is acceptable for initial rollout and
must be measured before broad scaling; network calls happen outside SQL locks.

## Evidence

- [Meta v26 release](https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/)
- [Meta permissions](https://developers.facebook.com/docs/permissions/)
- [Meta manual OAuth](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow)
- [Long-lived user tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived)
- [Marketing API Access Tier update](https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/)

Some Meta docs were rate limited; detailed request behavior was corroborated
with the official SDK and indexed official documentation. A real provider
authorization has not been performed in this review.
