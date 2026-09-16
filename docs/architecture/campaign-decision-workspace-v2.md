# Campaign decision workspace v2 — engineering gate

## Problem and behavior
Marketplace entitlement was active for MarkTone while the Google runtime row was absent. Reports also mixed OAuth, account selection and reconciliation settings with metrics. This release fills missing runtime records only after entitlement succeeds, separates integration settings from reports, and prioritizes executive results before campaign/customer drilldowns.

- Google settings: `/tenant/{slug}/addons/google-kit`; Ads and GA4 have independent sections. Analytics remains available without selecting an Ads account. Report: `/reports/google-ads`.
- Meta settings: `/tenant/{slug}/addons/social-connect`. Report: `/reports/campaigns?platform=meta`; filters and pagination retain the platform.
- Overview: compact platform navigation, period controls, provider spend separately by currency/coverage, CRM conversion summary, priorities, campaign economics and optional detail. Provider conversions, CRM verified payers and GA4 matched orders remain distinct.
- AI: opt-in report analysis through the existing Odeiry chat gate, manager permission, tenant-bound reads, rate limiter, quota reservation, finalization and kill switches. The server pins report dates and filters; the model receives only whitelisted aggregates. Pinned read-only report mode in the existing single agent, no external identifiers or customer rows, no automatic budget actions, no memory proposals. Unavailable reports yield an explicit unavailable result. Existing manager reports/team tools are unchanged.

## Data and tenancy
Risk: medium (additive activation helper and trigger; isolated UI + metered AI extension).
The deployed `catalog.tenant_addon_subscriptions`, `google_ads.rollouts`, entitlement gateway, marketplace wrapper and `audit_log.events` definitions were inspected before writing the migration. No account credentials were retrieved.

`google_ads.enable_entitled_tenant_v1` is private and security-definer with empty search path and all client roles revoked. It requires a currently active/trial tenant and the existing Google entitlement decision. It inserts only absent rollout rows and audits an actual insertion once. An explicit disabled rollout is preserved. Subscription and marketplace calls cover free, paid, administrative and already-active paths. The existing marketplace function is preserved behind a wrapper; its permission/payment checks run first.

The only historical repair is scoped to the already-entitled `marktone` tenant. No backfill sweep. `reef-skills` and `reefskills` are excluded; their rollout, integrations, business records and OAuth paths are unchanged. No migrations alter Meta, customers, admissions, payments, prices or subscriptions.

## Performance and limitations
No new provider API calls on report GET. Reads use existing RPCs with bounded timeouts; synchronization is explicit. Google summaries are loaded only for supported ranges; longer overview periods show unavailable rather than silently substituting a shorter month. Settings avoid loading campaign reports. GA4 report requests wait for a configured property; changing filters aborts stale requests. AI is on demand and uses aggregate facts with bounded tool output.

Meta reports retain existing coverage semantics; they do not claim a fully synchronized range from minimum/maximum dates alone. Missing values remain unavailable. This release does not create cross-channel attribution, claim customer acquisition is new-customer-only, or merge GA4 with manual attribution.

## Verification and rollout
PGlite tests cover the entitlement transition, duplicate activation, old missing state, explicit operational disable, protected tenant, gateway authorization, revoked entitlement and direct helper privilege denial. Report tests render separate settings/report modes and ensure GA4 exists without Ads selection. AI tests pin periods, fail on authorization errors and strip private fields. Existing Google/Meta/reconciliation and full CI checks run before merge.

Apply the additive migration, then publish the reviewed application commit via the existing main deployment. Verify MarkTone runtime enabled, settings links, summary/detail ordering and report quick-sync controls in the existing authenticated browser. Do not connect new Google or Meta accounts for this verification.

## Rollback
Revert the application commit to restore the prior presentation; the additive migration remains backward compatible with prior Google readers. For activation rollback, disable the `google_kit_subscription_activation_v1` trigger and restore the preserved marketplace gateway in a new reviewed migration. Keep audit events and valid entitled runtime rows; use the existing explicit disabled rollout for a tenant-level emergency stop. Do not reset subscription or business data.
