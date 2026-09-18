# GA4 independent site synchronization

## Evidence and engineering gate

The Marktone configuration has an enabled GA4 web stream and no reconciliation source. Its latest two syncs returned HTTP 400 while requesting transaction details (`ga4_transactions_invalid`), so the site-activity report was never requested. The report's specific rejected field combination remains unconfirmed; no permission or Google Cloud change is indicated by this diagnostic.

A confirmed architectural defect is that transaction details are fetched even when optional financial reconciliation is disabled. Independent analytics should not depend on that unused report.

Difficulty: 4/10. Reuse the existing settings, server-authorized sync lease, snapshots, coverage and reporting RPCs. No new source of truth, OAuth scope, endpoint, grants, tenant activation, order import or backfill. No operational data changes to Reef or other tenants.

## Behavior

- Decide whether to request transaction details from the leased server `storeUrl`, never a browser flag. The default client behavior remains both reports, preserving reconciliation integrations.
- Without a source, fetch only the existing site-activity query with all hostname/stream filters, metrics, ordering, pagination, quality checks and limits unchanged.
- Mark transaction quality explicitly `status: not_requested`; the empty internal array is a transport placeholder, not a measured zero.
- The database rejects this status for a source-bound lease or a nonempty transaction array. Persist the status inside existing coverage JSON, requiring no table change.
- Return null for unavailable transaction counts and a separate availability flag. Genuine zero site activity remains zero after a successful complete Google response.
- A failed requested report still fails the run and preserves the prior snapshot. There is no fallback that discards a provider error or silently drops fields.

This fixes the unnecessary transaction dependency for independent analytics. It does not claim to repair the unknown transaction-report HTTP 400 when reconciliation is enabled.

## Validation and release

Tests cover the real orchestration with a transaction-rejecting provider fixture, ignored client flags, domain/stream boundaries, explicit unavailable counts, genuine zero traffic, rejected source-bound omissions, preserved failure snapshots and unchanged function privileges. Existing reconciliation and tenant-isolation tests remain active.

Apply the additive forward function replacement to isolated staging; deploy the complete six-file Edge bundle and verify source/auth rejection. Full Quality CI is required before production schema, Edge and UI publication. The local execution environment is offline; GitHub CI is the execution authority for this change. Live Google acceptance still needs an authenticated manager sync; secure browser sign-in was interrupted and must not be assumed successful.

Rollback restores the prior Edge/UI and the two previous function definitions; no row deletion or data rollback. Reapplying the forward migration is idempotent and does not alter saved configurations or observations.
