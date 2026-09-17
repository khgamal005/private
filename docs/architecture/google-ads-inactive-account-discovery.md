# Google Ads discovery with inactive accounts

## Finding

The adapter read every directly accessible customer sequentially and aborted OAuth completion on any failed identity request. A Google user with one available advertiser and two cancelled accounts could therefore receive `google_access_denied` without seeing the available account. A regression fixture reproduced this failure on main `d1e16ea0f7a146c45257ff8abe5c6dad51f1e454` before the fix. The discovery loop was also present before the recent callback recovery and GA4 changes; the exact provider enum from the historical user attempt was not retained.

## Engineering gate

Bounded server adapter correction with one safe error message, no schema migration or operational data repair. Moderate integration risk: preserve OAuth/PKCE, single-use state, validated tenant context, service authorization, discovery limits, manager routing, complete report reads and atomic metric writes. No Meta source changes or Reef data/credential operations. Existing GA4 behavior remains compatible.

- During individual customer identity and manager-hierarchy reads, skip only a typed `CUSTOMER_NOT_ENABLED` failure. It is classified only from an HTTP 403 with exclusively that exact Google Ads error enum. Mixed errors, generic access denial, missing scopes, Cloud-project approval, timeouts, rate limits and malformed results still abort completion.
- Request `customer.status` and `customer_client.status`. Exclude explicit `CANCELED`/`CLOSED` accounts before requiring metadata that closed accounts can omit. Validate identity matching first. Readable `SUSPENDED` accounts keep the existing reporting eligibility rules.
- Directly verified access still takes precedence over manager listings. Inactive accounts count towards the existing unique-account traversal bound. Return an unavailable account count separately; no account or campaign identifiers are logged.
- No eligible accounts still reaches the existing transactional database guard, which rejects completion before saving a refresh token or connection. Revalidating/syncing an inactive selected account fails with a safe Arabic explanation; failed syncs preserve stored metrics.

## Verification and release

The previously failing fixture now discovers the available advertiser regardless of root order. Additional tests cover inactive roots and manager branches, absent inactive metadata, direct-access precedence, all-inactive discovery, skipped-account bounds, mixed/real permission failures, identity mismatch, unchanged tenant finalization and failed-sync preservation. The handler integration uses the real Ads adapter with synthetic Google/RPC responses. Existing callback, Reef isolation, GA4 and database tests are required along with full repository CI.

Deploy the complete five-file Edge bundle to staging first, verify unauthenticated/invalid-session rejection, then release production and merge the UI through the existing production pipeline. The Edge error code and UI copy are compatible in either release order. A fresh user OAuth attempt is needed for final live account connection verification; no old OAuth code is replayed.

## Rollback

Revert this commit and redeploy the inspected production version 9 five-file Edge bundle. No database or tenant-data rollback. Keep existing credentials and selections intact.

## References

- https://developers.google.com/google-ads/api/docs/get-started/common-errors
- https://developers.google.com/google-ads/api/fields/v25/customer
- https://developers.google.com/google-ads/api/fields/v25/customer_client
