# Unified campaign revenue, phase one

Canonical UI: `/tenant/[slug]/reports/campaigns`. The Social Connect placement,
saved links, pagination, and OAuth completion converge here. The OAuth start
request deliberately retains the existing edge service's allowlisted return
path; the authenticated completion gateway translates it to the canonical page.
No new OAuth scope, ad mutation, or provider access to lead identities is added.

## Data contract

- Existing Excel intake remains responsible for validation, identity resolution,
  queueing and distribution. Optional `campaignId`, `adId`, `receivedAt` and
  `moderator` fields survive in the existing `raw_data` record. Keep Meta IDs as
  text in Excel. Use ISO dates, or timestamps with an explicit offset. An absent,
  ambiguous, invalid or future received date falls back to upload time and is
  labelled; it does not silently become a verified acquisition date.
- The reporting layer reads canonical contact IDs and valid queued rows. It
  never creates a contact or task, normalizes a live phone, or joins phone suffixes.
  Duplicate and invalid imports are reported separately; valid customers later
  marked unqualified/wrong-number stay in the conversion denominator.
- Source review is an explicit, bounded preview (200 rows) followed by a grouped
  command. Tenant/account/campaign/ad binding is checked on the server. Equal
  names in two accounts are ambiguous. A name suggestion never saves itself.
  ID matches remain **reviewed manual evidence**, not automatic tracking proof.
- Reviews append actor, reason, original source/batch/row, predecessor and command
  digest. A stale preview is rejected; retries reuse the same command and cannot
  append twice. No historical backfill runs in the migration. Re-review appends a
  correction while retaining prior evidence. Reporting sources use the last review.
- A conversion requires an existing registration handoff with
  `payment_status='verified'` and `payment_verified_at`. Sales' `paid`, admissions'
  `accepted`, and `completed` are not conversion events. Customers count once per
  acquisition source; registrations count distinct opportunities. Instalments
  contribute amounts without increasing unique customers.
- Verified accounting imports replace their exact registration-handoff cash
  source; they do not add a second payment. Completed accounting refunds subtract
  from net cash. A handoff's established SAR contract is used unless its metadata
  explicitly records currency; imported accounting payments use ledger currency.
- Opportunity `importRowId` is the explicit sale-origin relationship. The first
  opportunity can use the canonical acquisition origin. A later opportunity with
  no documented origin remains outside campaign revenue. An explicitly sourced
  repeat purchase appears separately from new-customer conversion. Unlinked
  accounting payments remain in the reconciliation exception amount.
- Cohort mode selects arrivals, then follows payments to the displayed cutoff.
  Cash mode selects cash movements in the period and does not calculate a lead
  conversion percentage. Dates use the tenant timezone. Interest/quality/owner
  reflect current operational state; this is **not a historical status snapshot**.
  `asOf` limits recorded confirmation/cash timestamps against current verified
  records, not an immutable reconstruction of every past approval state.
- Interest and qualification are independent dimensions. CSV uses the same
  server arguments and permission checks as the screen, exports all matching
  groups independently of detail pagination, and escapes spreadsheet formulas.
- Meta results and cash receipts stay distinct. Missing metric rows are null,
  not measured zero. Daily unique reach is never added into a period unique reach.
  Cost/ROAS require a successful sync covering the period, reviewed sources and
  arrival dates. Currency mismatch or CRM-only filters suppress financial ratios.
  Net collections / ad spend is collection ROAS, **not accounting profit**.

Omnichannel is not implemented in this phase. Its future adapters should supply
verified identity and opportunity-origin evidence to this contract, retaining
event provenance and idempotency; they must not reintroduce name-only automatic
attribution or duplicate the canonical CRM/financial records.

## Authorization and rollout

RPCs independently enforce the tenant membership permission
`tenant.reports.campaigns` and Social Connect entitlement. Reviewing sources also
requires `tenant.meta_connect.manage`. Customer details require leads/CRM read;
amounts require `tenant.accounting.reports.read` through the existing accounting
permission helper. Meta performance requires Meta read/manage. The internal tables
have forced RLS, no direct tenant/service grants, and append-only review triggers.

The migration enables **no tenant**. `marketing_hub.campaign_report_rollouts` is a
database kill switch checked at every enhanced read/review boundary. Until a
tenant is enabled, its existing report and Meta tools remain available on the
canonical page. Once the rollout is enabled, addon activation controls access;
expiry disables the enhancement without deleting source history.

Applying the migration and activating a tenant are separate release operations.
Neither operation seeds or rewrites Reef source data. Do not run the legacy
attribution refresh as a read probe: it writes attribution records with different
rules.

## Verification and deployment gates

Local checks: production Next build; ESLint/typecheck; migration verifier;
executable PGlite fixtures covering permissions, tenant isolation, queue/duplicate
denominators, late payments, refunds, accounting deduplication, review replay and
stale previews; DOM interaction checks for source review failures/retries and RTL.
Local PGlite fixtures are synthetic and never copied to a connected database.
The separate staging SQL check below uses a rollback-only transaction and real
permission helpers; it does not replace helpers or disable triggers.

Before production activation:

1. Apply this additive migration to staging and deploy the matching app preview.
2. Enable only a synthetic staging tenant. Reconcile report and export against
   registrar handoffs/accounting payments, including an explicitly sourced repeat
   purchase and an unlinked payment. Check grants/RLS with real JWT roles.
3. Run EXPLAIN ANALYZE with staging tenant volumes. Review group JSON size and
   origin-resolution cost; detail/source pages are bounded, aggregation is tenant
   scoped. Set the release threshold from staging volume, not fixture timings.
4. Visually verify desktop/mobile RTL, keyboard controls, OAuth completion,
   upload, review, export and a full payment flow in a staging browser. DOM tests
   and a successful build do not substitute for this deployment check.
5. Capture a backup/baseline, run Supabase advisors and read-only Reef regression
   probes, and verify explicit production deployment authorization. Canary a non-Reef tenant
   before wider rollout. Do not infer FX or upgrade manually linked evidence.

Rollback: disable the tenant's campaign-report rollout, then restore the previous
application if needed. Keep reviews and operational records. No destructive down
migration. Existing import, admissions, accounting and legacy report contracts
have not been replaced, and OAuth's original allowlist remains compatible.

## Release evidence, 2026-09-07

Production publication was explicitly authorized by the user after the Odeir
engineering gate. Authorization does not imply that an incomplete check passed.
The application source at `b063ee69f0f0f741d4bfe354236582191d124977` passed
GitHub Quality CI run `34061098313`. Local verification included 936 passing
tests, production build, typecheck, lint without errors, and migration validation.

The current production main was `6798fe59539d0b8d34be9b33bb3bc935adbc4feb`
when inspected. The feature PR had no merge conflict. Production schema checks
confirmed that all 171 verified registrar handoffs then present had both an
opportunity and a confirmation timestamp. These were aggregate read-only probes.
No production migration, rollout, merge or business-data mutation has been made
for this release at this checkpoint.

Applied to platform-Staging (`pzflscqwfkixclmjyran`) only:

| Migration | Staging history version |
| --- | --- |
| `meta_connect_v2_oauth_control_plane` | `20260907101301` |
| `meta_connect_v2_ads_reporting` | `20260907101335` |
| `meta_connect_v2_account_selection_audit_context_fix` | `20260907101355` |
| `meta_connect_v2_ad_analytics` | `20260907101415` |
| `unified_campaign_revenue_v1` | `20260907101455` |

The four published Meta migrations were missing from staging. The production
pilot migration was deliberately not applied to staging; temporary entitlement
and rollout rows existed only inside the QA rollback scope.

`tests/staging/campaign-revenue-rollback.sql` passed on PostgreSQL using the
existing model tenant's active subject and the `authenticated` database role.
It exercised the actual permission functions, private grants, nonmember denial,
queued/invalid/duplicate counts, late payment confirmation, source-review retry
and stale-preview rejection, imported-payment deduplication, partial refund,
unlinked cash, explicitly sourced repeat sale, bounded pages and kill switch.
This tests database JWT-claim context; it is **not** a signed JWT/HTTP or browser
test. No permission helper was mocked and no trigger was disabled.

The 3,003-lead, 31-group staging case returned 33,607 bytes. PostgreSQL
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` measured 497.854 ms for the report,
with no temporary reads/writes and no shared dirtied/written blocks. This is one
staging measurement, not a production service-level guarantee. A subsequent
independent read confirmed zero model contacts/imports, zero new reviews and
rollouts, and the model addon still disabled after rollback.

Staging advisors returned no ERROR notices. The new tables'
[no-policy INFO notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
are intentional because all direct grants are revoked and access goes through
checked RPCs. [Authenticated SECURITY DEFINER RPC notices](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) require review;
the checked permission boundary is covered above, with HTTP verification still
pending. New unused-index INFO notices are expected before rollout. Do not add
direct RLS policies or broaden grants merely to silence these notices.

Unfinished gates at this checkpoint:

- Signed-in desktop/mobile, import/review/export, OAuth completion and payment
  flow in the staging application, followed by live canary verification.
- Production backup/baseline immediately before migration, then additive schema
  application, app publication and model-only rollout.

A Vercel preview creation request returned deployment
`dpl_D4LSGfZRazh8i1Xy2rhrn57ANRHu` for project
`odeir-campaign-revenue-staging`, but deployment inspection/build logs returned
404, the connected team listed no projects, and the authenticated URL fetch
could not create access. Build success and preview availability are unverified.
The submitted artifact contained the unchanged application sources and a
staging-only `.env.production` with a publishable key, no service credential.
Source files were transported in a tar archive and extracted before `npm ci` to
fit the connector's file-count limit. Do not create another preview project until
the outcome/access scope of this returned deployment has been resolved.
The previously documented `https://staging.odeir.com` also rendered a 502
connection-refused page when checked directly; it is not a verified alternative.

The current Odeir browser session is at the login form. Restore access using
the secure browser authentication flow; never extract or request credentials in
chat. Keep this PR unmerged and the enhancement disabled until the outstanding
release gates can actually be verified.
