# Google Ads + GA4 + order/payment reconciliation

This extends `google_ads_connect` on the existing Google report page. GA4 is included under `addon.integrations.google_ads_connect`; no second paid Analytics product or Meta entitlement is introduced.

## Engineering gate

Difficulty: 8/10. Identity provenance, payment deduplication, property/store scope and OAuth continuations are the material risks. The implementation reads canonical orders, admission links and the existing cash/refund helper. It never updates customers, assignments, handoffs, payments or prior manual campaign reviews.

The current production schema was inspected read-only on 15 September 2026: Google Ads connections, WooCommerce entities/work items, admission lines and `private_app.campaign_cash_v1` exist. The newer beneficiary table was absent at inspection, so this extension does not depend on it. Counts mean **orders** and **registrations with verified payment**, never inferred new students. This work is only for `Marktonesa/marktone-platform-control` / ODEIR.

## End-to-end flow

1. The manager chooses **ربط GA4 مع جوجل**. The existing PKCE and HttpOnly, state-specific OAuth cookie flow optionally requests `analytics.readonly` alongside the existing Ads scope. The default Ads-only consent stays unchanged; reconnect preserves an already granted Analytics scope.
2. The manager discovers GA4 properties and selects a property plus one existing WooCommerce store. Admin API verifies that a web stream belongs to that store hostname before saving the binding.
3. **مزامنة GA4** reads at most 31 property-calendar days. The Data API request is restricted to the selected hostname and its `www` alias. Purchase transactions and traffic metrics use separate reports.
4. Complete successful windows atomically replace only GA4 cache rows. Partial, inconsistent, malformed or failed pagination preserves the previous window. Empty successful reports replace stale rows with an explicit zero window. A property/currency/timezone change requires review and rebinding.
5. The report reconciles cached transaction identifiers against current ODEIR order/admission/finance records on read. A later verified payment or completed refund appears without a GA4 reimport. The existing WooCommerce sync remains responsible for receiving external order changes.

No outbound conversion uploads, bidding changes, new customer capture or background schedule is enabled by this change. Synchronization is the existing manager-driven model; last successful coverage and missing dates are visible. GA4 late processing can change recent dates, so resync the selected recent window before reviewing final results. The connector requires valid existing purchase / transaction_id tagging; it cannot reconstruct missing historical identifiers.

## Measurement contract

| Figure | Definition |
| --- | --- |
| Sessions / engagement / checkout events | GA4 observations for the selected store, using session source dimensions. They are event/session metrics, not a unique-person funnel. |
| Transactions | Distinct GA4 transaction IDs observed in the selected period. Missing IDs and repeated/conflicting observations remain explicit exceptions. |
| Matched order | Exactly one selected-store order and one unambiguous GA4 transaction; no leading-zero removal, name, phone or amount guesses. |
| Verified order | Matched order with positive canonical verified collections reached through its explicit admission handoff links. WooCommerce `completed`, `date_paid` and GA4 `purchase` alone do not qualify. |
| Verified registrations | Distinct linked handoffs with verified payment by the follow-up cutoff. This is not the number of students or completed enrollments. |
| Collections / refunds / net | Existing canonical cash events, with accounting replacements for registration handoffs and completed refunds. Each payment is counted once, grouped by currency. |
| Campaign link | Exact **session** Google customer/campaign IDs matching the selected Ads account. Campaign names do not establish attribution. Missing or mismatched IDs remain unassigned. |
| Amount diagnostic | GA4 purchase `value` versus the sum of order line totals excluding tax and shipping, only when GA4 reporting/event currency and order currency agree. This diagnostic does not rewrite finance. |

The GA4 order cohort and the existing manually reviewed acquisition cohort remain separately labelled. They can overlap and must not be added. Purchase-session evidence does not establish acquisition date, first-time student status or causality. The new panel therefore does not invent a student CAC or combine same-month spend and payments into an acquisition ROAS. The existing Ads spend and guarded manual-cohort economics remain available in the same page.

Thresholding, `(other)` loss, sampling and metric restrictions are retained with coverage. Affected transaction observations are held outside verified campaign finance. Ambiguous order aliases, reused orders, absent routing and currency conflicts have explicit statuses. The manager sees actionable reconciliation advice, campaign results, currency-separated collection totals, filters, 50-row detail pages and a formula-safe CSV export of the visible page.

## Security and lifecycle

- Private GA4 tables in `google_ads`; forced RLS, no direct table grants, checked authenticated/service RPCs and empty search paths.
- Same Google entitlement, existing report/manage/financial/detail permissions and approved protected-tenant guard. The Reef reporting-only restriction on manual CRM writes is preserved.
- All identifiers are tenant/store scoped; composite foreign keys tie stores and jobs to the same tenant. Refresh tokens remain in the existing Vault credential.
- Service jobs revalidate the saved actor, entitlement, selected configuration, credential version, store URL and expiring lease before secrets and before commit.
- Configuration replacement, disconnect/reconnect and disable fence stale work. Command UUIDs prevent duplicate jobs. No network request is made while holding database locks.
- Explicit fixed API endpoints/queries, bounded response bytes, bounded retries/pages and operation deadlines. No provider error bodies, tokens, user emails or phone numbers are returned to the report.
- Disable retains GA4 observations and audit history; it does not alter original business records or the Ads connector. Configuration changes preserve previous observations under their original config ID.

## Validation and release

80 focused and existing Google tests passed locally, including three DOM component tests for permission redaction, status filters, mobile cell labels and safe error states. Local tests execute PostgreSQL through PGlite with synthetic tenants and mocked Vault primitives. They cover exact matching, cross-tenant attempts, optional consent, service authorization ordering, revoked scope, stale leases, partial failure, malformed data, duplicate transactions, alias collisions, currency diagnostics, registration/accounting deduplication, refunds, permission redaction and report pagination. Existing Google Ads client/handler/route/UI/database tests are run alongside them.

A 1,000-transaction synthetic report returned 50 detail rows and a 20,326-byte response; local EXPLAIN ANALYZE measured about 23 ms. This is a fixture measurement, not a production SLA. The new React component compiles and changed files pass ESLint. The available browser blocked the localhost preview (`ERR_BLOCKED_BY_CLIENT`), so real desktop/mobile visual acceptance remains a release check.

Before production release:

1. Run repository CI on the review branch. Apply the new migration and deploy the changed `google-ads-connect` function in staging; do not replay old migrations or seed production.
2. Enable Analytics Admin API and Analytics Data API in the existing Google Cloud project. Add the optional `analytics.readonly` scope to the consent configuration and complete any Google verification required for that scope. Existing centralized Ads OAuth credentials and callback are reused.
3. Test real consent, property/store selection, sync, matched order, verified handoff, accounting replacement, partial refund, revoked permission and changed property using a disposable staging tenant. Verify hosted Vault behavior and representative query plans.
4. Review desktop/mobile screens, partial/empty states and CSV. Check current source schema and the latest compatible application revision.
5. Deploy only with explicit publication authorization. Tenant GA4 configuration is a separate manager choice; the migration activates no tenant and writes no Reef data.

Rollback: disable only the GA4 configuration and restore the preceding compatible Edge/UI revision. Preserve new tables and audit records. Do not drop schemas, delete original orders, run legacy attribution refresh, or disable Meta/Ads.

## Primary references

- [GA4 Data API report schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
- [Create a GA4 report and pagination](https://developers.google.com/analytics/devguides/reporting/data/v1/basics)
- [Analytics Admin account summaries](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list)
- [Google OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
