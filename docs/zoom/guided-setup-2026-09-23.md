# Zoom guided setup — engineering gate and progress

Baseline: `ebdfc5e4ffc5e96ae1fab95bdb8c82e7e6cb8dd9`, only `Marktonesa/marktone-platform-control`. User requested completion and simpler integration with ODEIR after reporting a disabled first-account button. Earlier authorization covers main / Hostinger and direct production backend preparation; On September 24 the user additionally authorized activation for Marktone only. This does not authorize other tenants, real test communications, paid AI, or bypassing runtime readiness; Zoom consent must be granted by its account owner.

## Confirmed gap

The production Marktone tenant has no Zoom settings, connections or hosts. No deployed function initializes settings. Existing integration fixtures insert enabled settings directly. The UI exposes filters, retention deletion and AI policy before the first connection, provides an unresolvable disabled button, and loses the accounts view after OAuth. Deployment success did not establish first-use acceptance.

## Architecture and scope

- Reuse `zoom_core.settings`, canonical addon entitlement, actual tenant memberships, permissions, staff, instructor assignments, academic sessions, worker queues, Vault and audit history.
- Add explicit, idempotent initialization with `enabled=false`. Activation is an explicit authorized user operation through the provider gateway after checking runtime configuration; deployment never initializes or activates a tenant.
- Read-only setup inspection remains available while provider execution is closed. It authenticates and authorizes before returning boolean readiness. No secret values, customer records or provider calls are exposed by inspection.
- Add a platform setup page under the existing addon admin, with current configuration checks and exact setup ownership. Configuration is not advertised as a completed live Zoom test.
- Separate initial setup, connected resources and advanced policies. Keep per-session operations in the existing learner operations flow and preserve attendance/finance/certificate authorities.

## Data, safety and rollback

Additive RPC migration; no backfill, new customer entities, new tenant activation, legacy S2S changes, or Reef operational mutations. Keep direct table grants closed, empty search paths and service-only activation with rechecked actor membership. Initialization is tenant locked and command-idempotent; policy edits keep revision checks. No network calls inside SQL transactions. Readiness is bounded aggregate metadata, not whole-tenant row downloads.

Rollback: close existing runtime flags, retain tables/history, restore compatible application/Edge code. Do not undo published migrations or edit migration history. Existing production migration versions differ from repository timestamps, so apply only the new reviewed migration, never blanket CLI push.

Difficulty: 6/10, chiefly authenticating readiness while execution is closed and closing the initial setup gap without weakening rollout gates. Phases: migration + gateway; UI + canonical navigation; synthetic SQL/HTTP/UI tests; current-SHA CI and authorized closed deployment. Live Zoom acceptance depends on app configuration, permitted accounts and licenses.

## Acceptance to prove

Uninitialized -> initialized but disabled -> permitted explicit activation -> OAuth return to accounts -> resource configuration -> existing lecture scheduling. Cover replay, simultaneous initialization, permissions revoked during setup, foreign-tenant access, closed runtime, unavailable readiness, callback cancellation, empty UI, tab filters and mobile layout. Distinguish real SQL/provider-contract/browser evidence from external live Zoom acceptance.

## September 24 continuation and review

Rebased onto main `8a68441a40867f1cf152b890a39bd38741e3e968` (connected academy delivery). Preserve its canonical media/people/commerce integration and merge `applyZoomMigrations` into the existing fixture. No package or lockfile changes are part of this Zoom release.

| Requirement | Code | Evidence / remaining limit |
|---|---|---|
| First visit, no pre-seeded settings | SQL25; `lib/zoom-snapshot.js`; `ZoomSetup` | Actual Next handler → Edge → PGlite SQL passes; initialization stays disabled |
| Explicit authorized activation | service-only SQL RPC + Edge runtime checks | Replay, revoked membership, entitlement, environment, owner and consent tested |
| Account return / errors | callback + `zoom-setup-boundaries` | Connected/cancelled/failed return to accounts; mismatched state never calls provider |
| Simple accounts / advanced settings | `ZoomAccounts`, scoped filters | Real React DOM form tests; empty lists omit date filters, pagination and deletion tools |
| Existing admissions lectures | admissions initial tab + learner operations | Existing session identity retained; old create controls excluded from new/managed sessions |
| Academy coexistence | merged fixture | New academy and all Zoom migrations execute in both installation orders |
| Concurrent first setup | `zoom-concurrency` | Independent PostgreSQL lock barrier added; local test skipped without isolated PG URL |
| Visual / live acceptance | production page / Zoom | Browser reaches login; no authenticated visual or live-provider acceptance claimed |

Focused current run: 76 tests, 75 pass, 0 fail, 1 explicit independent-PG skip. Lint: 0 errors, 19 pre-existing warnings. 297 forward migrations verified. Production build succeeded with isolated loopback build configuration. Full regression: 1718 tests, 1713 pass, 0 fail, 5 explicit environment-dependent skips. TypeScript passes after the completed build. Independent PostgreSQL and hosted storage checks remain conditional locally; exact published commit CI is verified separately.

Repository reconstruction initially truncated large baseline files; restored exact blob bytes and checked hashes, including binary assets. A first full-suite launch overlapped dependency installation and hit a transient TypeScript import error; all affected files were rerun as part of the final 1718-test run after installation, with zero failures. Do not count the earlier environment result as a successful full gate.

Read-only production preflight: Marktone entitlement=true; no Zoom settings/connections, zero Zoom cron jobs. No business/financial/academic records or Reef rows changed. Publishing and activation results are recorded separately after verification.


## Publication checkpoint

Published main `99e5f8f17fd4b8e6afb8a696d47981c7c52951c4`. Hostinger serves the new guided setup asset at `/_next/static/chunks/0iq_4gcz2_e8-.js` with HTTP200 and SHA256 `48a887153bb976d4af3db813fa4551f4c381135a35e6fcbf2d97a8b094a83a58`, identical to the local production build. This proves deployment of the client code, not authenticated first-use or live Zoom acceptance. Quality36050519698 and Zoom36050519767 are checked separately before backend rollout.

## Verified deployment and scoped preparation

- Quality [36050519698](https://github.com/Marktonesa/marktone-platform-control/actions/runs/36050519698): success on `99e5f8f17fd4b8e6afb8a696d47981c7c52951c4`, 1713 pass / 0 fail / 5 conditional skips. Lint, types, 297 migrations and build passed.
- Isolated PostgreSQL [36050519767](https://github.com/Marktonesa/marktone-platform-control/actions/runs/36050519767): success on the same SHA, 1714 pass / 0 fail / 4 unrelated environment skips. Concurrent initialization commits one disabled settings row; explicit activation is separate. Scheduling and rotating-token races also passed. Synthetic PG17.11 load: 3000 tenants, 6750 requests, 2 workers, 0 errors; read p95=75.4ms and database receipt p95=1.6ms. Not live Zoom or 3000 concurrent lectures.
- Applied only SQL25, actual production version `20260924200408`; ledger474→475. The earlier24 migrations were not reapplied. No anonymous grants on the new RPCs; activation remains service-only. Security advisors returned no new cache keys in the follow-up inspection; direct ACL verification is separate evidence.
- Deployed zoom-connect v3, all6 source files retrieved and matched exactly. Bundle SHA256 `bff8d183cff59475013fa141dafe2a971a451754fdb54d46a01115c167201f9f`. Existing training worker unchanged.
- Prepared **Marktone only** through the canonical initialization RPC with the existing active Marwan Khaled staff profile and checked membership/permissions. Environment=production, recording=off, revision1, enabled=false. Verified authorized setup snapshot: entitlement=true, ownerReady=true, canConfigure=true.
- Other tenant settings=0, accounts=0, OAuth attempts=0, links=0, operations=0, Zoom cron=0. No Reef operational mutations, real messages, Zoom authorization or paid generation.
- Production HTTP: unauthenticated setup/platform_setup401; provider start/webhook/dispatch503 `zoom_not_enabled`. This confirms the execution gate remains closed; Edge deployment status ACTIVE is not tenant activation.

### Remaining blocker — configuration, not authorization

The user has authorized Marktone activation. It has **not** been completed: global runtime is closed and no Zoom worker is scheduled. OAuth-secret presence has not been verified through an authenticated runtime session; do not describe those secrets as confirmed missing. The browser reaches ODEIR login, so authenticated visual acceptance also remains pending. Do not bypass the gateway by setting `enabled=true` directly or reusing legacy S2S credentials.

Next: establish whether ODEIR's General OAuth application is already prepared, complete its secure server configuration and scheduler, inspect `/control/addons/zoom`, then perform the already-authorized Marktone activation through the validated gateway and let its account owner grant Zoom consent. No new activation permission is required for Marktone; other tenants remain outside scope. Account licenses, webinar/cloud-recording capabilities and any Zoom app/SDK review require their own actual evidence.

| Delivered | Verified | Remaining |
|---|---|---|
| Guided interface + admissions/academy continuity | Current-SHA Quality, PostgreSQL, matching Hostinger asset | Authenticated production visual walkthrough |
| Schema + Edge readiness/initialization/activation paths | Applied migration, matched v3 sources, SQL and HTTP permissions | Secure runtime configuration and scheduler |
| Marktone provisioning | Licensed, owner configured, recording off, one own settings row | Runtime readiness and actual activation; still disabled |
| Live Zoom integration | Synthetic provider contract and real isolated SQL | Owner OAuth consent, licensed hosts and end-to-end live lecture |

Machine-readable evidence: [guided-setup-2026-09-24.json](evidence/guided-setup-2026-09-24.json). Migration mapping: [backend-migration-manifest.json](backend-migration-manifest.json).
