# Google Ads — user-authorized Reef reporting pilot

Scope: ODEIR only (`Marktonesa/marktone-platform-control`, `odeir.com`).
User explicitly requested live activation for `reef-skills` on 2026-09-14.
This supersedes the initial reader-v1 blanket Reef exclusion only for the
canonical tenant with an explicit, reporting-only approval record.

## Release boundary

The migration is additive and activates no tenant. Existing permissions,
entitlement checks, forced RLS, OAuth state/PKCE, actor fencing and sync leases
remain mandatory. The defensive `reefskills` alias remains rejected.
The first default period is seven complete days; no automatic scheduling is added.
No Google campaign/budget writes or conversion uploads are introduced.
Manual source review is hidden for Reef and blocked in Edge and database triggers.
No client/import/registration/payment/plan/Meta/WooCommerce data is rewritten.

A separate operator action must enable exactly the canonical Reef rollout with
`protected_tenant_approved=true`, `reporting_only=true`, and the single Google
feature entitlement. Do not change its existing plan or other entitlements.
Catalog marketplace publication and pricing are deliberately outside this pilot.
The direct tenant report route is `/tenant/reef-skills/reports/google-ads`.

## Verification and rollback

Run the complete quality suite and the added isolated synthetic DB/API tests.
Validate the additive migration in staging before applying it to production.
Deploy only the Google Edge function and the reviewed application version.
Code merge is not evidence of Hostinger deployment, OAuth consent or Google sync.

Rollback sets only the Reef Google rollout `enabled=false`; retain its approval
so disconnect remains available. This fences service continuations. Preserve
Google reporting history, CRM data and every unrelated integration.

## Google Cloud compatibility

Google sunset developer tokens on 2026-09-09; access follows the OAuth Cloud
project. This change removes the obsolete local requirement and request header,
without introducing fake tokens. Client ID, secret and exact callback are still
required. Credentials must be configured in the existing secure Edge store,
not committed, printed, or copied into reports.
Official reference: https://developers.google.com/google-ads/api/docs/api-policy/developer-token

Live activation, current secret readiness and a successful real Google consent
and sync must each be verified separately; automated fixture tests prove none
of those external conditions.
