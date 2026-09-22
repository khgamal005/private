# Zoom implementation — resumable record

Scope: [the complete supplied specification](scope-ar-v1.md), ZM-01–22 and T01–64. No merge, deployment, live activation, provider purchase, production backfill or live provider test is authorized.

Repository: `Marktonesa/marktone-platform-control`. Branch: `feat/zoom-multi-account`. Verified initial main: `dfec0b996597a310de22aa86dce177c5cf59f668`, tree `c2cfb3751883a17546c4a97780e952ebeb181f42`. The complete tree and signed commit were reconstructed from GitHub's read-only Git API and hash-verified existing local objects; no edits from other workspaces were imported without matching the exact upstream blob hash. There is no AGENTS.md in this tree or workspace ancestry.

## Latest checkpoint — 2026-09-22 23:25 UTC

Implementation branch only; **nothing merged, deployed, activated, or tested with live Zoom**. Main rechecked and remains `dfec0b996597a310de22aa86dce177c5cf59f668`. Previous saved checkpoint `c5a678d2662c29054d93acde2125044aa4163ce3` passed PostgreSQL CI run 35793145534.

Current code contains **20 additive, unpublished Zoom migrations**. Since c5: historical attendance after withdrawal/transfer, atomic recurring series with DST validation and occurrence mapping, background streamed CSV exports with fresh owner authorization, CRM webinar notification delivery through the existing queue, human certificate review tasks, uncertain individual registration recovery, provider evidence-change tasks, and UUID-less external update reconciliation. Account permissions now require actual tenant membership and tenant ACL; a platform control role alone cannot read tenant Zoom content.

Validation on this checkpoint's source code:
- `npm test`: **1635 passed, 4 skipped, 0 failed** (1639 total). Local genuine PostgreSQL concurrency test is deliberately skipped without `ZOOM_TEST_DATABASE_URL`; it runs in isolated branch CI.
- `npm run lint`: 0 errors / 19 existing warnings; `npm run typecheck`: passed; `npm run migration:verify`: 288 forward migrations verified; `npm run build`: passed with loopback synthetic Supabase configuration.
- Targeted real SQL tests exercise both canonical certificate paths and direct-insert guard, complete a real authoring draft apply with separately enabled synthetic LMS/authoring gates, reject copied export tickets, recover a lost approved individual registration, and distinguish a provider echo from external schedule drift without UUID.
- UI/HTTP/SQL evidence in `evidence/ui-http-sql.json`: passed at 360/390/768px, keyboard, creation through real Next API/SQL/worker, background CSV stream and copied learner URL denial. Provider and JWT boundaries are explicit test seams. Rerun after final UI changes.
- Earlier real PostgreSQL 17 load/race evidence remains in `evidence/load-a1d47d2.json`; it is not evidence of simultaneous live lecture capacity.

Next work, in order:
1. Finish individual T01–64 evidence matrix, scope/capability manifest, architecture, setup/operator runbook, retention and rollback documents. `coverage.md` still contains superseded gaps until refreshed.
2. Close remaining acceptance gaps: multiple hosts, known external busy/partial coverage, partial batch, overlapping student evidence, >100-row export, queue fairness and time boundaries. Review portal states, configurable notification origin, and periodic future drift observation.
3. Rerun final changed paths, UI and engineering gate; verify exact main and feature SHA, inspect real PostgreSQL CI and save a reviewable draft.
4. Keep actual OAuth/accounts/SDK audio-video, provider licensing, live messages/AI, approved derivative deletion policy and any release authorization explicitly pending.

## Phase status

P0 complete. P1–P5 have executable database/provider/application paths; local acceptance and gap closure continue. P6 is in progress (documentation, final exact-SHA evidence and review). Do not report all requirements complete merely because the build or local suite passes. Follow the detailed matrix and its provider-live limitations.

## Confirmed architecture / decisions

- Production project's repository default and live metadata match `gswpbwdactcstkasddta`; other projects (including staging and Reef HS) are not development targets. Only pg_catalog definitions were read.
- Existing learner accounts, instructor assignments, financial access, attendance and certificate eligibility are canonical; LMS activation is separate from Zoom activation.
- Current financial governance deliberately allows admitted students to continue after later arrears. Zoom must call `private_app.training_journey_financial_access_v1` and preserve this decision. The seven-day assumption in the supplied spec is not a replacement for the installed policy.
- Current `training_is_instructor_v1` also honors explicitly enabled academy platform memberships; reuse it, do not regress to staff-only authorization.
- Existing training automation handles messages. Its legacy Zoom path has global S2S token cache and no multi-account reservation/fencing. New account operations must never fall back to that global account.
- Training attendance currently counts present/late sessions. Additive Zoom evidence must feed the canonical record and protect canonical certificate paths from incomplete evidence; no second final attendance ledger.
- Reuse Supabase Vault for server-only secrets and existing audit/permission helpers. Default rollout remains absent/disabled.

## Resume procedure

1. Read this file, discovery.md and coverage.md; inspect git status/diff and latest main.
2. Current targeted tests: node --test tests/zoom-*.test.mjs. Local logs /tmp/odeir-zoom-{core,evidence,schedule,lint,types,migration}.log. New SQL migration timestamps start 20260922201432. Only new/unpublished migrations have been edited.
3. Run existing verification commands and targeted executable tests; record failures honestly.
3. Continue P1 → P2 → P3 → P4 → P5 → P6; preserve Reef and every unrelated change.
4. Before any release, obtain separate explicit user authorization after a passed engineering gate.

## Checkpoint update — 2026-09-22 22:35 UTC (continue work, do not treat as final)

Remote checkpoint a1d47d2a9f1c1e6def4a4839796db21f6bb71eb0 passed CI run 35790160139, **23/23**, including genuine PostgreSQL 17 races and 3,000-tenant synthetic load. Structured load evidence is in evidence/load-a1d47d2.json. Latest local changes: **24 pass, 1 deliberate local PostgreSQL skip**; two new additive migrations (weighted completion, insights/followup), 13 migrations total.

Completed since previous checkpoint: old occurrence end ordering; unknown exit remains incomplete after manual identity match; weighted canonical eligibility; manual credit separated from status; genuine provider capacity lower-bound from Concurrent add-on; webinar/meeting overlap prohibition; provider cooldown and resource retry state; periodic resource refresh and existing host binding validation; prevention of new shared-S2S adoption while preserving pre-project legacy evidence; legacy token expiry; canonical task followups; aggregate usage and honest cost reports; read-only Odeiry Zoom tool guarded by active paid run and tenant permissions.

UI/HTTP/SQL verification passed on synthetic data: Arabic account/session views, allocation preview and creation through the real Next API, SQL reservation and edge worker, CSV authorization, forged learner host role refusal, standalone learner page, 390px mobile and keyboard. Provider and JWT transport are explicit fixture seams. agent-browser daemon failed in this environment; Chromium via Playwright worked. A visual defect in mobile tab wrapping was fixed. **Latest insights UI needs rerun.** Screenshots and JSON evidence are in evidence/. Standard build passed on prior checkpoint with loopback Supabase. Latest lint: 0 errors / 19 existing warnings; typecheck passed.

Runtime caveat: Next dev generates AGENTS.md / CLAUDE.md / next-env changes. Read generated AGENTS guidance and relevant installed Next docs; do not commit these incidental generated files. Temporary app/zoom-validation-fixture route must be removed before staging/building. scripts/zoom-ui-fixture.mjs and verify-zoom-ui.mjs recreate it only for verification. Browser path locally /tmp/odeir-zoom-browser/chromium; Playwright from CODEX_PRIMARY_RUNTIME_NODE_MODULES; no project dependency changes. Stop/clean synthetic servers after tests. The temporary route may persist after environment process cleanup; remove only its guarded ZOOM_UI_FIXTURE page.

Remaining internal work is itemized in coverage.md, especially recurring-series creation, historical attendance transfer, advanced settings, long exports, stronger acceptance scenarios, complete operating/setup/retention/rollback documents and final verification. External limitations remain actual Zoom app/SDK authorization, licenses, test account credentials, real media/provider/AI/message tests, and explicit release authorization. No merge, deploy, activation or Reef mutation is authorized.
