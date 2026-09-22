# Snapshot read load repair — engineering gate

Implementation prepared against main `6d5f92b9a8cd22241664d9b5b150338c05de1302` and inspected live function definitions in the Odeir production project `gswpbwdactcstkasddta`. Production was queried read-only; no migration, record update, seed, or deployment was performed.

## Evidence and scope

The supplied Hostinger logs show `v3_platform_control_snapshot` failing with PostgreSQL 57014, alongside tenant report, lead intake, calendar, dashboard and sales workspace timeouts. The commerce hub 400 is a separate, unexplained response and is not claimed fixed.

`/control/tenants` currently uses the full platform loader: five concurrent snapshots, including task/CRM metrics, commerce history and the addon catalog that this screen does not render. The platform overdue wrapper additionally enumerates `pg_timezone_names` in a correlated query and calls a non-inlined parameter-only SQL predicate repeatedly per task.

A live read-only EXPLAIN ANALYZE of the old overdue aggregation took 2362.306 ms. The equivalent grouped query using precomputed tenant-local day boundaries and an inline predicate took 722.692 ms. These are individual diagnostic samples under changing load, not an end-to-end page benchmark or a capacity guarantee. A single-statement reconciliation over all four current tenants reported zero count differences. No customer fields were exported for testing.

## Changes and architectural fit

- A new permission-checked `v1_platform_tenants_snapshot()` supplies only the tenant metadata, existing provisioning details, invitation count and plan choices consumed by the tenants screen. It reuses the canonical provisioning RPC and matches current plan visibility for billing and tenant admins. There is no new business entity, cache, financial calculation or source of truth.
- The page uses this narrow RPC plus the existing manager snapshot. Optional manager failure is shown as unavailable and disables its controls, while actual tenants remain visible. Missing core data still raises an error; it never becomes a false empty tenant list. Authentication redirects are preserved.
- `v3_platform_control_snapshot()` retains the permission-filtered base response and replaces only `overdueTasks`. It resolves local day boundaries once per visible tenant and aggregates overdue tasks once. Completed/cancelled tasks stay excluded; customer followups retain day-based timing and other tasks retain exact due time. Blank/unrecognized timezones fall back to UTC; native PostgreSQL timezone conversion follows the existing tenant task-day helper's convention.
- Removing the per-call search_path setting from the immutable, SECURITY INVOKER, parameter-only classification helper allows SQL inlining. It has no relation/function references or dynamic SQL; no EXECUTE grants are added. All privileged snapshot functions retain an empty search_path and permission checks. This also reduces predicate overhead in existing dashboard/report callers, without claiming that every observed timeout is eliminated.

## Database impact and risk controls

The migration only changes function definitions/configuration and grants EXECUTE on the new RPC to authenticated/service_role. There are no data writes, backfills, new indexes, RLS changes, entitlement changes, or altered tenant memberships. Reef data is untouched. A 2-second lock timeout bounds migration lock waits; a failed migration rolls back. There are no network operations inside transactions. Difficulty: 4/10; the sensitive points are metric parity, authorization, and deployment ordering.

## Verification

`node --test tests/snapshot-read-load.test.mjs tests/platform-tenants-server-read.test.mjs`

Eight tests execute the migration in isolated PGlite fixtures, compare the old/new snapshot outputs, check hidden-tenant redaction and required permissions, verify anonymous/helper EXECUTE restrictions, preserve record fingerprints, verify repeat application and predicate inlining, and test optional failure/core failure/auth redirects. The fixtures are synthetic. JSX/module syntax was parsed for all four changed/new application files. Complete repository lint/typecheck/test/build is delegated to the existing PR quality workflow; local checkout access was limited to selected files. Authenticated production browser verification remains a release check.

## Release and rollback

Production release is pending explicit publication authorization under the Odeir Engineering Gate skill.

1. Recheck that the production definitions and commercial policy still match this review. Run the full PR quality gate.
2. Apply `supabase/migrations/20260922141649_snapshot_read_load_fix.sql` to the identified Odeir project before deploying the page code. Do not run seeds or unrelated migrations.
3. Deploy the reviewed application change to Hostinger through main.
4. With the authorized platform-admin session, open `/control/tenants`; verify owner/domain/plan/member fields, search, controls, and available manager state. Validate a tenant-only session cannot call the new RPC. Inspect fresh request durations and 57014 errors in affected pages. Do not mutate Reef as a test.
5. Rollback: deploy the previous application revision first. Restore `v3_platform_control_snapshot` from `tests/fixtures/snapshot-read-load/v3_platform_control_snapshot-before.sql`; restore `ALTER FUNCTION private_app.customer_followup_uses_day_policy_v1(uuid,text) SET search_path = '';`. The unused new read RPC may safely remain; remove it only after confirming the previous application is serving all instances. No records need restoration.

Other calendar/lead-intake/sales timeouts require post-release observation and, if persistent, independent query-plan investigation. This patch removes a confirmed administration load path and repeated predicate overhead; it does not diagnose capacity exhaustion or the commerce 400 from logs alone.
