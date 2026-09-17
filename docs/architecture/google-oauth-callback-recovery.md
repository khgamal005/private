# Google OAuth callback recovery — engineering gate

## Evidence and scope
The reported MarkTone attempt on 2026-09-17 reached `claimed` after the tenant/user/PKCE checks. It never reached `finalized`. The production Edge source matched main. The existing Next callback discarded every Edge failure and redirected to `/?google_ads=error`; no safe completion-stage diagnostic was recorded. Historical evidence therefore does not distinguish a token exchange failure, Ads account discovery failure, or connection-save failure. This change must not be represented as a verified successful live Google connection.

Risk: medium because OAuth completion crosses trust boundaries. No database migration, entitlement change, token rotation, tenant-data repair, Meta change, or Reef data operation is included. The existing Reef pilot return path and all tenant permission checks remain in place.

## Behavior and boundaries
- Successful and cancelled callbacks finish in the tenant's Google Kit settings. The database's existing legacy report return path remains compatible; the web route translates it.
- After a valid transaction claim, Edge includes only its validated return path and an allowlisted error code on failure. A fixed stage and internal transaction UUID are logged for correlation; raw errors, state, codes, tokens and provider bodies are never logged.
- A second state-specific Secure/HttpOnly/SameSite=Lax cookie remembers only the local recovery destination for ten minutes. It is never sent to the exchange endpoint or used to choose a tenant for authorization. A mismatched completion cannot display success in another tenant. Each callback deletes only its own transaction cookies.
- Legacy attempts without the new cookie still use the claimed Edge context. If both trusted recovery sources are unavailable, a public, non-indexed recovery screen gives a safe Arabic explanation and a login link instead of the home page.
- Error messages distinguish missing eligible Ads accounts, Cloud project production access, a disabled API, and the stage at which an otherwise unknown failure occurred. Google `invalid_client` is classified before the generic HTTP 401 branch so a server configuration error is not misreported as an expired user connection.
- Provider classification reads only bounded, exact documented enums. Existing fixed read-only Ads queries, discovery completeness, timeouts, retries, PKCE, single-use state, session checks and RLS/service RPC authorization are unchanged.

## Verification and release
Focused route, adapter, Edge and UI tests exercise success, cancellation, missing/stale/replayed state, older cookies, simultaneous tenant attempts, network outages, unsafe/cross-tenant return paths, provider error redaction, failure-stage diagnostics and inherited-property query values. Existing Reef pilot tests remain unchanged. Run full repository CI before merging. Deploy the complete backward-compatible Edge bundle to staging first and verify unauthorized calls fail before provider access, then deploy production and merge the application through the existing production pipeline. The route and Edge additions are backward compatible in either rollout order.

A fresh owner-authorized OAuth attempt is needed to identify the historical failure's actual cause and verify a live connection. An old claimed authorization code must never be replayed for diagnosis.

## Rollback
Revert the application commit and redeploy the previously inspected five-file Edge bundle (production version 8). No schema or data rollback is necessary. Valid connections and credentials remain intact. New recovery cookies expire automatically and do not alter the prior verifier cookie format.

## References
- Google Ads developer token sunset and Cloud-project authorization errors: https://developers.google.com/google-ads/api/docs/api-policy/developer-token
- Google OAuth web-server flow: https://developers.google.com/identity/protocols/oauth2/web-server
- Supabase server auth and session caching: https://supabase.com/docs/guides/auth/server-side/advanced-guide
