# Zoom implementation — resumable record

Scope: [the complete supplied specification](scope-ar-v1.md), ZM-01–22 and T01–64. No merge, deployment, live activation, provider purchase, production backfill or live provider test is authorized.

Repository: `Marktonesa/marktone-platform-control`. Branch: `feat/zoom-multi-account`. Verified initial main: `dfec0b996597a310de22aa86dce177c5cf59f668`, tree `c2cfb3751883a17546c4a97780e952ebeb181f42`. The complete tree and signed commit were reconstructed from GitHub's read-only Git API and hash-verified existing local objects; no edits from other workspaces were imported without matching the exact upstream blob hash. There is no AGENTS.md in this tree or workspace ancestry.

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
