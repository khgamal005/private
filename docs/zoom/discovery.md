# Engineering gate / gap discovery

Base: `dfec0b996597a310de22aa86dce177c5cf59f668`. Verdict: feasible, additive development authorized; release is not authorized. Difficulty 9/10: distributed OAuth rotation, reservation concurrency, identity/evidence reconciliation, compatibility and provider approval.

| Boundary | Existing authority / integration point | Required work |
|---|---|---|
| Person and admission | sales_core.contacts, academy.students, registration_handoffs, enrollments | Reuse canonical identities and payment acceptance; no provider-driven admissions |
| Session | academy.course_runs/course_run_sessions and scheduling RPC | Sidecar external linkage, versions, reservations; leave historical sessions intact |
| Staff/learner | access_control memberships and permissions; training_learner_accounts; training_run_instructors; academy platform memberships | Server checks at every action; independent learner login, no role-preview authority |
| Money | training_journey_financial_access_v1 and existing accounting/governance | Call authority; current governance prevents automatic suspension for later arrears |
| Certificate | training_eligibility and certificate triggers | Additional evidence guard, preserving canonical assessment/content/finance conditions |
| Secrets | Supabase Vault used by Google integrations | Per-account access/refresh bundles; distributed refresh lease and generation fence |
| Automation | academy.training_automation_jobs and training-automation-dispatch | Reuse messages; provider outbox requires explicit lifecycle/uncertainty/fencing contracts absent in the legacy create job |
| UI | learner-operations-workspace; tenant addon settings; authenticated training portal | Native Arabic controls with real RPCs and bounded snapshots |
| Audit/tasks | private_app.write_audit, work_core.tasks/notifications | Deduplicated operational exceptions with real owners; no reassignment of sales contacts |
| Storage | existing protected storage capabilities | Human publication, scoped access, retention/provenance; no automatic provider deletion |
| AI | existing Odeiry server integration; authoring draft publishing | Explicit consent/budget and source-bound drafts; no autonomous attendance or certificate changes |
| Release | main Quality workflow; Supabase default project known | Actual production host/worker rollout still requires separate verified deployment evidence |

## Threats / controls

Cross-tenant forged IDs: composite references and server permission checks. OAuth CSRF/replay: hashed single-use state tied to actor and fixed return path. Duplicate host capacity: provider account/user identity uniqueness. Concurrent booking: transaction locks, deterministic ordering, overlap recheck and instructor locks. Provider timeout: preserve reservation and uncertain operation, never blindly retry create. Revoked rights: recheck membership at callback/join/start/export. Media/SDK secrets: no public snapshots or cache. Unknown capabilities: ineligible, not unlimited. Rollback: disable new commands, retain history and isolate uncertain operations.

## Schema/release policy

No migration published in the main baseline is edited; new schemas have RLS and no direct client grants. All provider functions are service-only and independently validate tenant/entity relationships. Rollout defaults closed and does not activate LMS, change pricing, provision licenses, or touch Reef rows. Live tables/functions were inspected through pg_catalog only. Full production host configuration is not proven by a repository default; record it as an open release gate.

## Provider sources checked

- OAuth and rotating refresh: https://developers.zoom.us/docs/integrations/oauth/
- Signed webhooks, challenge, three-second acknowledgement: https://developers.zoom.us/docs/api/webhooks/
- Meeting SDK external-account review/authorization: https://developers.zoom.us/docs/meeting-sdk/get-credentials/ and https://developers.zoom.us/docs/meeting-sdk/obf-faq/
- Rate limits: https://developers.zoom.us/docs/api/rate-limits/
- Supabase RLS and security-definer permissions: https://supabase.com/docs/guides/database/postgres/row-level-security

An early Z1 retrieval was inconsistent. Reverification on 22 September 2026 resolved the official article correctly: https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0068522. It prohibits overlapping webinars or a webinar plus meeting on one host. The implementation enforces this regardless of meeting slots. Users API settings can prove a Concurrent Meeting add-on; the initial implementation uses a conservative lower bound of two. An unverified base plan remains one slot.
