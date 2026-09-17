# GA4 analytics without a commerce prerequisite

## Engineering gate

The user authorized the independent Analytics connection and optional order matching after the live setup was blocked by an empty WooCommerce list. Publication follows the existing authorization in this task. Difficulty: 6/10. The hard boundaries are the exact measured site, legacy bindings, authorization before remote calls, and avoiding false financial conclusions.

The production GA4 function bodies and constraint definitions were inspected and compared with the shipped migration on 17 September 2026. All eight existing function bodies matched. Existing `commerce_sync.connections` is the WooCommerce boundary, not a generic Salla/Zid adapter. No unsupported connector is presented as operational.

## Behavior and source of truth

1. Discover properties with the existing Google grant. Fetch a selected property's web streams only when needed, using an authorized, leased `ga4-streams` request. Auto-select a sole website; require an explicit choice for multiple sites.
2. Save the property and exact web stream without a store. The server resolves and verifies the hostname from Google; browser-supplied domains/URLs are ignored. All new Data API reports filter both hostname and stream ID. A shared property must have an appropriate dedicated stream for the institution's site.
3. Show sessions, engagement, views, purchase events and the top 20 source/medium groups from the same bounded report cache. Totals include all cached sources. Expose coverage, Google data limitations and missing synchronization; a missing snapshot is not a zero observation.
4. Offer order/payment matching separately after Analytics is configured. Only an existing same-tenant WooCommerce source can currently be attached. Salla, Zid, custom sites and ODEIR websites can use Analytics when GA4 is already configured there; this release does not install website tags or implement their order-ingestion adapters.
5. Without a matching source, do not execute the order/finance matching function. Return explicit reconciliation-disabled metadata, null verified outcomes and empty finances/issues/details. GA4 purchase events are not confirmed students, collected revenue or acquisition ROI.
6. With a source, retain the existing exact-ID matching, authoritative admissions/cash/refunds, financial/detail permission redaction and pagination. The measured cohort remains separate from manually mapped campaign cohorts.

## Schema, safety and performance

Add nullable `stream_id` to GA4 settings/runs and bounded stream-discovery results to runs. Expand the configuration constraint to allow a stream without a store and the run-kind constraint to allow stream discovery. No backfill, credential change, tenant activation, operational write, Meta change or Reef production data operation.

The new `ga4_begin_v2` RPC keeps the existing permission/entitlement/consent checks, short serialized claims, actor checks, command idempotency, expiring leases and tenant-scoped store FK. The previous begin signature remains a compatibility wrapper, avoiding PostgREST overload ambiguity. Stored discovery results contain only validated IDs, display names and hostnames, and are safe for command retries.

Existing store-bound settings with no stream ID continue using their prior verified-host contract. A manager's explicit change to the property, stream or optional source rotates the observation configuration; prior observations remain stored under the old configuration. Repeating the identical standalone selection keeps its configuration through null-safe comparison. Existing run/credential/config fencing remains in force.

The summary uses the `(tenant_id, config_id, kind, metric_date)` cache access pattern and bounded source results; no additional reporting network request is required. Internal helpers have an empty search path and no direct execution grants. Existing forced RLS and RPC ACLs remain intact; only authenticated users receive the checked begin-v2 RPC.

## Verification and release

Tests execute PostgreSQL using isolated synthetic tenants, the legacy migration and the forward migration together. They exercise old reconciliation/refunds, standalone configuration, multiple streams, wrong-property/tenant selection, duplicate commands, concurrent claims, stale scopes, snapshot preservation, null-versus-zero results, optional source attach/detach, source bounds, permission redaction and migration replay without row changes. DOM tests perform actual selection/save actions and verify that no-store setup is usable and financial UI stays hidden in Analytics-only mode. Adapter tests check stream/host filters and reject stream-resource mismatches; route tests ensure browser URLs/secrets cannot enter trusted context.

Apply the forward migration to isolated staging, check grants and advisors, deploy the complete five-file Edge bundle and probe unauthorized requests. Run full repository CI before production. Apply schema before Edge and UI so previous clients remain supported. Production acceptance includes checking the published Arabic UI assets and function source; a real tenant selection and Google data sync still require the manager's authorized session.

Rollback keeps the forward schema and preserved observations. Restore the previous Edge/UI bundle to stop new standalone setup, or roll forward a focused correction; do not revert the constraint in production after standalone settings exist. The old UI cannot operate standalone configurations fully, so it is a temporary containment option, not a compatible long-term rollback. Do not disconnect tenant integrations or delete their observations to roll back.
