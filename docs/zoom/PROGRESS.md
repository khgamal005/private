# Zoom implementation — resumable record

Scope: [the complete supplied specification](scope-ar-v1.md), ZM-01–22 and T01–64. No merge, deployment, live activation, provider purchase, production backfill or live provider test is authorized.

Repository: `Marktonesa/marktone-platform-control`. Branch: `feat/zoom-multi-account`. Verified initial main: `dfec0b996597a310de22aa86dce177c5cf59f668`, tree `c2cfb3751883a17546c4a97780e952ebeb181f42`. The complete tree and signed commit were reconstructed from GitHub's read-only Git API and hash-verified existing local objects; no edits from other workspaces were imported without matching the exact upstream blob hash. There is no AGENTS.md in this tree or workspace ancestry.

## Latest checkpoint (2026-09-22, still under implementation)

- Remote review branch exists: `feat/zoom-multi-account`, first checkpoint `68b65fe48041182ebe981d7b24444038af89f2b8`.
- Real PostgreSQL 17 two-connection reservation and refresh races passed in [run 35787333617](https://github.com/Marktonesa/marktone-platform-control/actions/runs/35787333617), job 106947207450. Main stayed `dfec0b996597a310de22aa86dce177c5cf59f668`.
- Current local Zoom suite: **22 passed, 1 skipped** (explicit real PostgreSQL URL required locally). Advanced SQL now covers canonical CRM dedupe, no academic/finance creation from webinars, restart attendance union, source-bound Odeiry draft finalization/cleanup, paginated resource synchronization and cross-account replacement retaining the old reservation until provider cancellation.
- Full regression on first checkpoint: **1620 passed, 4 skipped, 0 failed**. Later changes need another regression run.
- Build encountered local Turbopack symlink-root limitation before compilation. Dependencies were copied into this workspace with no changes to the other workspace. Re-run with a loopback Supabase endpoint.
- New isolated CI load scenario creates 3,000 synthetic tenants/operators/accounts/hosts, bounded account reads and durable event receipt with duplicate delivery. Its results are pending, not a capacity claim.
- Next actions: execute UI and gateway/SQL acceptance tests; run latest CI including load; finish coverage/evidence/Zoom setup and rollback documents; verify latest main and save a final review checkpoint. Never merge/deploy/activate.

## State

- P0: complete specification and current main/live schema discovery completed; no live data written.
- P1: additive OAuth/resources/Vault/refresh implementation and Arabic account UI; 4 isolated database tests pass.
- P2: reservations, provider outbox, fencing, import/update/cancel, same-account host changes and existing message queue bridge; 4 isolated scheduling tests pass. Recovery and batch/occurrence operations need expanded testing.
- P3: canonical learner/instructor identity, financial authority, individual registration, signed events, report reconciliation, interval evidence and certificate guard; 3 evidence tests pass. Standalone Zoom portal reuses existing authentication and invitation tables.
- P4: recording publication/access and bounded reports; lifecycle/retention SQL installs into isolated fixture. Expanded recording/retention acceptance tests pending.
- P5: SDK identity/review decision, source-bound Odeiry generation and draft-authoring bridge implemented but not fully tested; webinar CRM workflow and advanced operator controls still under implementation.
- P6: lint/typecheck/migration-history verification pass on current draft; full regression, browser, real Postgres races/load, review and final matrix pending. No live Zoom/OAI calls, no production mutations, no deployment.
- External prerequisites: separate test Zoom General OAuth app/accounts, provider scopes and licenses, Meeting SDK review/identity authorization, approved AI/data and retention configuration, isolated real PostgreSQL concurrency runner. No live provider test authorization.

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
