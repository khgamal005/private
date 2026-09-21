# Operational governance release candidate — 21 September 2026

This candidate implements the approved ODEIR operating decisions across customer identity, repeat sales, admissions, training, finance, diploma contracts and tenant readiness. The user explicitly authorized publication after the ODEIR engineering gate on 21 September 2026. The five reviewed migrations are installed on platform-Staging only. Production publication remains pending completion of the gate; no production migration, tenant activation or historical data repair has been performed.

The source baseline is `Marktonesa/marktone-platform-control` main commit `feb9b59e247a12827055f32bccb22f0d3f61220d`. The independent Arabic decision appendix contains the approved ten architecture decisions, six subsequent defaults, seven calendar days of installment grace, and acceptance criteria. Implementation evidence belongs to this release record, separately from policy approval.

## Migration sequence and scope

Apply only the reviewed new forward migrations, in the following order, after checking the target schema. Do not replay historical repository seed, repair or backfill migrations to make the live database resemble a synthetic test fixture.

| Migration | Responsibility | Activation boundary |
| --- | --- | --- |
| `20260921125610_financial_governance_v1.sql` | Canonical payment evidence, allocation conservation, refund effects, customer credits, incentive review, financial redaction and documented sale attribution | Automatic import is opt-in. Financial integrity and permission guards apply when the migration is installed. |
| `20260921125620_sales_identity_governance_v1.sql` | Mandatory unique primary phone, four active additional numbers, opportunity classification/ownership, explicit followup target and one customer sales task | Identity and sales invariants apply when installed. Historical contacts/opportunities are not guessed, merged or bulk rewritten. |
| `20260921125631_admissions_lifecycle_governance_v1.sql` | Admission readiness, full-payment/waiver gate, reservation versus enrollment, late exceptions, waiting SLAs, attendance evidence and eligible batch closure | Tenant admission automation defaults off. Session evidence protection is a schema guard even while automation is disabled. |
| `20260921125642_diploma_contracts_governance_v1.sql` | Explicit program kind, parent contracts, immutable schedules, seven-day grace, collection and cancellation settlement | Diploma feature and collection automation default off. Ordinary catalog classification remains available without buying synchronization. |
| `20260921125653_tenant_operating_foundation_v1.sql` | First branch, free readiness, department memberships, shifts/absences, branch tracking and planning visibility | Staff scheduling defaults off. Enabling it requires reviewed coverage. Existing records are not bulk assigned a historical branch. |

New branch relations cover the appropriate staff, batch, handoff, task, enrollment and accounting records. Contacts and course definitions remain shared tenant-level entities. Existing null historical branch references and issued financial documents are preserved. No branch owned by another tenant may be used.

## Baseline preflight

The repository and live database have differed in the WooCommerce admission/beneficiary baseline. The September 16 training-journey financial links and automatic admission behavior are existing functionality to preserve. Read-only target inspection must establish the exact installed signatures, table/column shapes, grants and migration history before running this candidate.

The combined local fixture must test both ordinary/free admission without optional Woo beneficiary tables and the beneficiary-enabled variant. A fixture that merely adds absent tables cannot prove production compatibility. Capture target `pg_get_functiondef` values for every replaced/wrapped function and compare them with the definitions tested by this release; unexpected drift is a stop condition.

Count-only checks should identify missing primary phones, more than five active distinct customer numbers, duplicate open opportunities for a customer/program, unclassified programs, missing operating owners, unlinked historical verified payments, ambiguous invoice/handoff links, incomplete required documents and pending attendance. Review exceptions explicitly. Do not infer identity, classification, financial source, historical branch or sale attribution to clear a count.

## Approved behavior and acceptance

| Decisions | Required result |
| --- | --- |
| A1, A9, C4 | Free readiness uses basic tenant data, first branch, currency/timezone/tax, team/permissions and a manual, Excel or internal-form intake source. No paid synchronization is required. Scheduling prevents new assignment to unavailable staff while preserving historical ownership. |
| A4, B1, B3 | One customer identity per tenant, primary phone plus four active additional numbers, one default salesperson, separate opportunities and explicit beneficiary data. A prior sale never closes another program's followup. An unscheduled opportunity remains visible for planning without an invented appointment. |
| A2, A3, B2, B6 | Planning reserves; open batches enroll atomically after actual prerequisites; in-progress enrollment requires approval; closed batches reject new placement. Full verified payment is required for short courses and an approved contract/first installment for diplomas, unless a recorded admission exception applies. Waiting has a reason, responsible owner and review deadline. |
| A5, B4, B5 | Finance remains authoritative. Refunds distinguish cancellation, price adjustment and credit transfer. Paid incentives create a reviewable correction; no payroll deduction occurs automatically. Cash, allocations and refunds conserve money and inherit documented sale attribution; unknown remains unknown. |
| A6, A7, C1 | Contracts support up to 30 calendar months and immutable schedule versions. Seven calendar days of grace use tenant-local dates without moving the original due date. Later arrears do not suspend study automatically; academic completion does not clear debt. |
| A8 | Eligible batches close automatically only after 48 hours from the final relevant end time. Missing attendance stays unknown and blocks closure until resolved or covered by a recorded manager exception. Reopening needs authority and a reason. |
| A10 | The existing public `core_*` catalog remains canonical; legacy/private plans remain private. Existing Reef FULL contractual entitlements are preserved. No gratuitous plan migration or entitlement rewrite is included. |
| C2, C3 | Disabling an addon stops new addon operations while preserving prior commitments and trusted payment/refund settlement. Routine validated events operate within their approved contract; exceptional sensitive corrections require preview/confirmation. |

An admission waiver permits study without upfront payment while the debt remains. Debt forgiveness requires its own canonical credit/settlement. Zero-price agreements do not create artificial payments.

Business-day deadlines use the tenant timezone and configured weekend days. This version does not claim a public-holiday calendar or working-hour scheduling engine. Optional documents remain optional unless explicitly required for that program/admission.

## Tenant activation order

1. Use an isolated staging tenant. Configure currency, timezone, tax profile, a first branch, team permissions and a free intake source. Review the operating snapshot. `v1_tenant_operating_action` exposes `save_setup`, staff/absence management and `preview_scheduling`/`set_scheduling`; do not enable scheduling before shift coverage is complete.
2. Explicitly classify relevant programs. Preserve legacy unclassified records until reviewed. Prepare agreed short-course terms and canonical financial links; review any mismatch between agreed price, invoice currency/total and actual verified cash.
3. Use the accounting `preview_governance` action before `set_governance`. The action requires financial settings authority, a command ID, an explicit enabled boolean and the `ENABLE_FINANCIAL_GOVERNANCE` confirmation. Automatic import concerns subsequent verified handoffs. Historical imports are individual reviewed operations, not a bulk backfill.
4. Use admission `preview_policy` then `save_policy`, carrying the current preview token and confirmation. Select finance and placement owners; the defaults are one configured business day each. Review how many existing open requests could become eligible before confirming. The bounded retry worker is installed/scheduled only through the approved activation path.
5. Review a separate tenant-specific diploma feature activation; the migration itself inserts no enabled tenant setting. Once the feature is enabled, collection automation uses a displayed contract-count preview and explicit confirmation. Verify `pg_cron` support before enabling it; the collection worker is bounded and only processes opted-in tenants.
6. Verify the complete customer-to-cash-to-study journey before executing the already authorized production release. Deployment authorization does not automatically activate tenant engines or approve historical imports.

Module details: [sales identity](../sales-identity-governance.md), [admissions](admissions-governance-v1.md), [diploma contracts](diploma-contracts-governance-v1.md). Use the actual RPC definitions and permission checks from the reviewed migration for final payload contracts.

## Verification record

The local suites use isolated synthetic data and executable Postgres/PGlite functions. They can verify SQL behavior, permissions, tenant boundaries, exact monetary arithmetic, idempotent command replay, preserved history, timezone/date logic and UI behavior under JSDOM. They do not model simultaneous PostgreSQL sessions or prove a deployed Supabase/Auth environment.

| Check | Evidence/status at preparation |
| --- | --- |
| Exact source/assets | Recovered against the pinned main tree. All 46 public assets match their upstream Git blob hashes. |
| Arabic approved-policy appendix | Seven pages rendered and visually reviewed; saved independently without changing discovery v3. |
| Paymob UI regression | Targeted suite passes 9/9 after restoring its missing upstream payment-brand SVGs. No checkout code change was needed. |
| Module database and UI suites | Final local `TZ=UTC npm run check`: 1,475 passed, 0 failed, 2 skipped (1,477 total). Both skipped suites explicitly require a disposable PostgreSQL URL. Timezone-specific cases explicitly use tenant/browser zones. |
| Combined five-migration journey | Passed 4/4: default-disabled installation, free short-course payment/documents/enrollment/refund, diploma first-installment and cancellation settlement, and dedicated financial-verifier authority without academic editing or cross-tenant access. |
| Default production build | Final frozen application passed `TZ=UTC npm run build`, including Next.js 16.3.0 Turbopack compilation, TypeScript and 68 static pages. |
| Lint/typecheck | `npm run lint`: 0 errors, 19 existing warnings. `npm run typecheck`: passed. |
| Migration verification | Passed: 261 forward migrations including the five additions. All five reviewed additions installed successfully on platform-Staging; no historical migrations replayed. |
| Real PostgreSQL concurrency | Separate PostgreSQL 17 CI job exercises eight actual multi-connection races. Its first run exposed missing test-fixture category values and bigint driver representation; corrected fixtures require a passing rerun before release. |
| Authenticated staging | Workflow 35610367911 stopped at authorization because the GitHub staging management credential was absent. No synthetic Auth users or business fixtures were created by that run. A real Supabase login session was also unavailable. Configure repository Actions secret `ODEIR_STAGING_MANAGEMENT_TOKEN`, then rerun the workflow on this review branch. Never put its value in source, logs, PR text or chat. |
| Production deployment/tenant activation | Not performed. |

The first local Turbopack attempt rejected an environment-provided `node_modules` symlink outside the project root. An identical local dependency copy resolved that environmental issue without editing package manifests or application configuration; the subsequent default build completed successfully.

## Gates before production publication

- Require the repository Quality workflow on the reviewable commit. Local checks above include the combined finance/admission/diploma journey and module coverage of both optional-schema variants.
- Apply the five migrations to real PostgreSQL staging using target-equivalent schema and roles. Verify tenant isolation through authenticated user sessions and direct RPC attempts, including finance redaction and older callable API wrappers.
- Run real concurrent sessions for phone/opportunity creation, same-command replay, seat capacity, payment allocation/refund reservation, cross-flow invoice linkage, contract rescheduling and background reconciliation. Check deadlock handling, retries and bounded task creation.
- Use an authenticated staging browser to complete free intake, repeat sales, missing beneficiary phone, payment verification, waiver, reservations/late admission, diploma first installment and grace, refunds/credits, academic completion and overdue-debt continuity. Verify staff absence/coverage and task navigation.
- Verify eligible 48-hour batch closure, blocked closure with unknown attendance, authorized exception and recorded reopening. Check that existing debt and required followup survive academic closure.
- Exercise addon downgrade and subsequent trusted payment/refund callbacks against a previously created operation. Confirm ordinary manual teaching/attendance remains usable.
- Inspect representative query plans and queue bounds; confirm retries are visible and configuration cannot strand tasks without an explicit waiting/owner-missing state.
- Retain backups, prior function definitions, prior application version and a tenant-specific impact preview. Preserve Reef data and FULL entitlements. Publication is authorized after the gate; tenant activation remains explicit and scoped.

## Staging installation record

Target: `pzflscqwfkixclmjyran` (platform-Staging, PostgreSQL 17.6). The migration API assigns installation versions; the source filenames retain their CLI-generated versions. Record this mapping instead of replaying files or repairing unrelated history.

| Source suffix | Installed version | Source SHA-256 |
| --- | --- | --- |
| `financial_governance_v1` | `20260921140601` | `00e76e6a9a5aa3a7e77739dc3b8048868b5828f014ff901cc4a2b06df77435ab` |
| `sales_identity_governance_v1` | `20260921140611` | `c901d0cdf8fce1d7fd933fc778df7720fda1e54857ebe702c64de8465c0a2b09` |
| `admissions_lifecycle_governance_v1` | `20260921140613` | `3d2e9af0dde8fa92c5d513a7050db510cfbbfb1512f5b9eff30c8c67ee0f0e3b` |
| `diploma_contracts_governance_v1` | `20260921140614` | `872749947c4ff88f20d38aed38fb39bd2d6c64a2292548ec10a771c4a4b577ff` |
| `tenant_operating_foundation_v1` | `20260921140616` | `b94a6593c54d1c73c1e81e7e8434017223b47fba60906d6af68117e39e2bd8f5` |

Post-installation checks: 24 new tables have RLS enabled and no direct anon/authenticated DML privileges. The eleven added public SECURITY DEFINER entry points are the intended permission-checked RPC interface; anonymous executable-function count did not increase. Existing leaked-password and legacy-function advisor findings predate this release. Admission, diploma and staff-scheduling enabled counts were zero; no governance cron jobs, contracts or historical branches were created. The bounded planning query used the existing tenant/next-action index; this is a current-size query-plan observation, not a load-test claim.

Production preflight captured the exact 27 previously existing replaced/wrapped function definitions and grants in `operational-governance-production-functions-before-20260921.json`. Production remains at migration `20260919123916`, with 4,396 contacts, 230 verified handoffs and no canonical accounting payments at the count-only check. One legacy contact lacks a primary phone; no guessed repair or automatic import is included.

## Rollback and history preservation

Disable the relevant tenant automation first. Keep canonical payments, issued documents, refund evidence, credits, contract schedule versions, contacts, phone aliases, attendance and audit history. Do not roll back by deleting data-bearing additive tables or re-running old seed/backfill migrations.

Once new credits, refunds or other governance financial records exist, retain the new financial calculators, integrity guards and history. Recovery means disabling optional automation, serving an application compatible with those records and applying a reviewed forward fix. Restoring old financial functions can misstate balances or bypass protection and is not a recovery option after that boundary. Restore prior function definitions only before tenant activation and before any new governed records, with an explicit compatibility review; installed guards can create this boundary even while automation flags are off.

Disabling admission or collection automation does not cancel existing financial obligations. Trusted payment/refund settlement, pending review and operational visibility must continue. Never activate a tenant, remove financial/session protections or erase evidence merely to simplify rollback.

## Deployment marker and public verification

`public/release.json` identifies this candidate with `releaseId: operational-governance-20260921`. The existing package version remains `2.0.0-beta.30`; `releaseStage: publication-candidate` and `preparedAt` describe the built artifact. `releasedAt` is null because publication has not happened when the manifest is prepared. Record the observed deployment time and the GitHub merge/review SHA separately; the manifest does not claim its own commit SHA. No repository code, tests or scripts consume the previous manifest fields.

After the approved Hostinger publication, fetch `/release.json` with cache revalidation and confirm the unique release ID. Also verify `/` and `/login` return 200, `/api/diplomas?tenantSlug=marktone` returns 401 without authentication, and a GET to the POST-only `/api/program-kind` returns 405. These checks identify the served candidate and basic route protection; they do not replace authenticated or database verification. A successful Vercel preview alone does not establish what Hostinger serves.

Read-only production evidence captured at `2026-09-21T14:08:58Z`, before this publication, identifies the prior public assets. All four responses below returned 200 from `Server: hcdn`.

| Resource on `https://odeir.com` | Prior response metadata |
| --- | --- |
| `/login` | `Content-Type: text/html; charset=utf-8`; `ETag: W/"tireb0fkmt99r"`; `Cache-Control: public, max-age=0, s-maxage=300, must-revalidate, stale-if-error=86400` |
| `/release.json` | `Content-Type: application/json`; `Last-Modified: Sat, 19 Sep 2026 12:39:59 GMT`; version `2.0.0-beta.30`, no release ID, releasedAt `2026-08-23T23:48:15.734Z` |
| `/_next/static/chunks/0j04tdp9xlz1_.js` | `Content-Type: application/javascript; charset=UTF-8`; `ETag: W/"7cad-1a0b9aefa2d"`; `Last-Modified: Sat, 19 Sep 2026 12:40:47 GMT`; `Cache-Control: public, max-age=31536000, immutable` |
| `/_next/static/chunks/41_a-ig973vqe.css` | `Content-Type: text/css; charset=UTF-8`; `ETag: W/"1c836-1a0b9aefa0d"`; `Last-Modified: Sat, 19 Sep 2026 12:40:47 GMT`; `Cache-Control: public, max-age=31536000, immutable` |

The prior release manifest body SHA-256 is `c53d55233be271a32e2d9dc7225a746d6b322e1147e19712022c6e3aebf07d0e`. These public fingerprints help distinguish the previous application; they are not a deployable backup or proof of its exact source commit. Retain the actual prior Hostinger deployment artifact separately and assess its compatibility with records created since this release before restoring it.
