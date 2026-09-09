# Google Ads reader v1 — implementation and release boundary

This change adds a separate, simple Google Ads reporting connector to ODEIR.
Tenant experience: connect Google, choose one advertiser account, and view its
campaigns, spend, clicks and Google conversions. Selecting an account starts the
first sync. The manager can subsequently refresh a period of at most 31 days.
Manual CRM source groups can be previewed and explicitly matched to a campaign.

## Product contract

- Product: `google_ads_connect`; feature: `addon.integrations.google_ads_connect`.
- Surface: `tenant.google_ads`; page: `/tenant/[slug]/reports/google-ads`.
- Catalog and manifest are drafts, marketplace visibility is off, and there is
  no pricing decision, tenant license, plan grant, rollout seed or backfill.
- Reads require existing `tenant.reports.campaigns`; connection and source
  changes additionally require `tenant.marketing.manage` or
  `tenant.settings.manage`. Financial values and personal details use their
  existing separate permissions.
- Every operation requires the Google entitlement and a Google rollout record.
  Disabled snapshots reveal no stored operational data. Disconnect may remove
  the Google credential after entitlement expiry; operational history remains.

## Engineering gate

Complexity is medium/high because OAuth, tenant authorization and revenue
provenance cross security boundaries. The implementation is additive and isolated:

| Area | Change and invariant |
| --- | --- |
| Database | New `google_ads` schema, composite tenant/account foreign keys, forced RLS, no direct table grants. Only narrow authenticated/service RPCs. |
| OAuth | Fixed Google callback, state-specific secure HttpOnly cookie, PKCE S256, one-time DB claim tied to the initiating actor and tenant. |
| Credentials | Refresh tokens in Vault; developer token/client secret in Edge secrets. No token or Vault ID in user snapshots, reports or logs. |
| Continuations | Service RPCs recheck saved actor permissions, current entitlement, protected tenant, credential generation and sync lease. |
| Concurrency | OAuth generation is separate from credential generation. Cancelled reauthorization preserves the current connection. Disconnect, account change and credential replacement fence stale work. |
| Provider reads | Fixed SELECT queries only; bounded hierarchy, pagination, retry, request timeout and whole-operation deadline. |
| Sync | At most 31 account-calendar days; complete success atomically replaces that account/date window and records coverage. Failure preserves prior data. |
| CRM | Read existing canonical contacts, intake origins, verified registrar handoffs and cash/refund helpers. Store only Google manual matching evidence; no contact or import rewrite. |
| Review | Max 200 source rows per preview, optimistic preview tokens, idempotent command UUID and append-only reviewer evidence. |
| Existing integrations | No edits to Meta OAuth, Meta UI/report, `ads-sync`, legacy attribution, existing migrations or reviewer configuration. |
| Protected tenant | `reef-skills` (and defensive alias `reefskills`) rejected by page/API/Edge/DB paths. No live tenant data operations. |

Shared edits are limited to adding a Google placement in the existing registry
and a new Supabase function configuration block. The old Meta flow is unchanged.

## What the numbers mean

Google conversions follow the advertiser's conversion settings and may be
fractional. They are never added to or substituted for ODEIR registrations.
Campaign spend is aggregated from exact cost micros before currency rounding.
Missing coverage is unknown, not a fabricated zero; a complete empty provider
window is a real zero. Reports show the last successful synchronization time.

ODEIR results use manually reviewed origins and the first-acquisition cohort
received in the selected period. Verified registrations and unique verified
payers are separate. Collection figures use recorded verified cash, matching
accounting replacements and refunds through the chosen follow-up date.
Repeat purchases outside that first acquisition are excluded in v1.

`manualCostPerPayerMinor` is advertising spend divided by attributed verified
payers. `manualCollectionRoas` is net recorded collections divided by advertising
spend. Neither is full business CAC, incremental attribution or profit ROI.
Ratios are withheld when spend coverage, origin dates, currencies or calendar
bases do not support the comparison. Canonical CRM cash currently assumes two
minor digits, so other currency scales suppress cross-system financial ratios.
Historical follow-up dates use current review evidence; this is not a frozen
historical audit snapshot. Personal details are a clearly labelled bounded sample.

## Central setup before a controlled release

Google OAuth uses the `https://www.googleapis.com/auth/adwords` scope. Google
does not offer a narrower reporting-only OAuth scope for Ads; our backend limits
its capabilities to reading reports. Do not describe the consent itself as a
read-only Google permission.

Configure centrally in the Supabase Edge secret store:

| Secret | Purpose |
| --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | Google Cloud web OAuth client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Developer token with suitable Google Ads access |
| `GOOGLE_ADS_REDIRECT_URI` | Exactly `https://odeir.com/api/tenant/google-ads/callback`, or the matching staging host in staging |
| `GOOGLE_ADS_API_VERSION` | Optional; defaults to `v25` |

The function also uses Supabase's built-in URL, anon key and service-role key.
No new service-role secret is required in the Next.js host. Staging and
production use separate OAuth configuration and callback registrations.
Customers enter no API keys. Google consent/app verification and developer-token
access must be completed centrally before production onboarding.

Official references checked for this implementation:

- [Google OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Ads OAuth](https://developers.google.com/google-ads/api/docs/oauth/overview)
- [Developer token access levels](https://developers.google.com/google-ads/api/docs/access-levels)
- [Google Ads release notes](https://developers.google.com/google-ads/api/docs/release-notes)
- [Google Ads reporting](https://developers.google.com/google-ads/api/docs/reporting/overview)

## Verification and release procedure

Local automated checks cover OAuth/browser binding, tenant and protected-tenant
rejection, service fencing, pagination/partial failure, money scaling, manual
preview/idempotency, report provenance and UI states. Database tests use local
PGlite fixtures with synthetic tenants and mocked Vault primitives, not live
Supabase data. They do not prove hosted Vault behavior or live Google access.

Implementation-branch evidence: 1,035 tests passed with bounded local test
concurrency, the production Next.js build passed, TypeScript checking passed,
and 240 forward migrations passed the repository verifier. Existing ESLint
warnings remain outside the Google changes; changed Google files lint cleanly.
The preview browser rejected the local preview under its URL security policy;
visual desktop/mobile acceptance remains a staging release check. A synthetic
SSR fixture was generated, but is not represented as completed visual QA.

Before release, apply the additive migration and deploy only the new function
to a non-production environment, configure its separate secrets, and run a
real consent → account selection → sync → manual preview → verified-payment
report check using a synthetic non-Reef tenant. Check account switching,
cancelled reconnect, revoked access, repeated callbacks and failed page reads.
Publish the catalog/manifest and reviewed real screenshots through the normal
add-on release workflow; enable only an explicitly selected canary tenant.

No production migration, tenant activation, pricing change or live OAuth test
is performed by this implementation branch. Production deployment remains a
separate reviewed action after staging evidence exists.

Rollback disables only Google rollouts, stops new Google requests and returns
the application to the preceding compatible version. Preserve operational and
review tables. Do not drop schemas, run legacy attribution refreshes, disable
Meta or change any Reef record as part of rollout or rollback.

## Future tracking boundary

WordPress/Salla/store events, first-party visitor identity, GA4, conversion
uploads, cross-channel attribution and background scheduling are separate
extensions. The current source evidence remains explicitly manual so later
tracking can add provenance without rewriting old imports or presenting
estimated matches as verified acquisition.
