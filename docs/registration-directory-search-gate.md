# Registration directory search repair — engineering gate

Base: ODEIR `c1cd6ca21dd08b2d3b32ba846122125af534e01a`; directory Edge v3.
Implementation authorized by the reported broken search. Production deployment
has not been requested in this task and remains pending explicit approval.

## Confirmed diagnosis

Live browser reproduction: `القدرات التدريبية` returns no matches; `القدرات`
returns eight institution cards. The existing directory contains official names
such as `معهد القدرات للتدريب`. The backend searches one contiguous literal
phrase, normalizes Arabic letters on only the query side, and treats any digit
in a name as a registration-number search. The UI also retains an earlier empty
state during retries and has no request deadline or stale-response guard.

## Scoped changes and architecture

Keep UI -> existing public directory Edge -> organization-scoped CRM accounts.
Match every search token within the same Arabic or English name, irrespective
of token order. Generate bounded regex patterns for Arabic letter/diacritic
variants and common training suffixes. Remove user-supplied regex/filter syntax.
Convert Arabic/Persian digits; select exact identifier lookup only for wholly
numeric input. Existing organization, archive, merged-record filters, lookup
limits and contact masking are unchanged. No auto-selection or automatic claim.

The UI clears obsolete results, ignores superseded responses, bounds request
waiting, and distinguishes service errors from a genuine empty result.
Submission, legal consent and ODEIR tenant creation logic are unchanged.

## Database and risk

No schema, RLS, grants, migration, or stored data changes. No Reef records touched.
No new directory source or cross-tenant path. Existing external directory project
is a confirmed dependency, not a new integration. The source is kept under `ops`
to prevent accidental deployment into the ODEIR tenant project. Difficulty: 3/10;
main risk is deploying this external function to the wrong project.

## Verification

- 21 passing focused Node tests (19 cases plus 2 parent tests) using real PostgreSQL
  regex semantics through PGlite, synthetic multi-organization fixtures, and a
  rendered React UI in JSDOM.
- Cases cover the reported query, Arabic variants/diacritics, word order, English,
  mixed names/numbers, exact Arabic/Persian identifiers, masked contact output,
  organization isolation, archived/merged exclusion, filter injection, service
  errors, malformed payloads, stale responses, retries, and moving to registration.
- ESLint passes for the changed UI and tests; diff whitespace validation passes.
- Read-only production SELECT using the exact generated patterns returned eight
  cards for the reported phrase. EXPLAIN ANALYZE: 11.449 ms execution on the
  existing ~3,038 active accounts, using a bitmap index/heap scan with name filters.
  This measures the database query only, not complete browser/Edge latency.
- Full application CI/build is left to the PR's normal Quality workflow; this
  local checkout contains the scoped files rather than a complete repository.
- The modified Edge has not been deployed. PostgREST URL transport and live UI
  after deployment still require the short smoke check in the release runbook.

## Reference

PostgREST `imatch` and quoted logical filters:
https://docs.postgrest.org/en/stable/references/api/tables_views.html
