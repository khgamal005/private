# ODEIR LMS operational journey — application audit

Pinned repository main: `166c9d4a53ebdafaa4310c8d582c9bd575b97bf6`. Scope: read-only code/migration audit, no production reads/writes or deployment. Pilot UUID `3d185482-b916-49cc-b868-b6dfdb93eba8`, slug `marktone`. The engineering gate applies. Live schema verification belongs to parent/database audit; these findings are source-confirmed only.

## Architecture verdict

Fit is good if new training functionality extends existing tenant contacts, admissions, course runs, enrollment, accounting and task records instead of duplicating them. Existing pilot UI is local sample data and must stay clearly separated from any real-data journey. It must not silently substitute demo people when a real snapshot fails.

## Canonical application contracts

| Flow | Current source/API | Safe reuse / constraint |
|---|---|---|
| Admissions | `getTenantAdmissions` in `lib/api.js`, combines `v3_tenant_admissions_snapshot` (v2 fallback), `v2_tenant_course_runs_snapshot`, training operations, automation | Broad employee data; never expose whole snapshot to students. |
| Admission commands | `POST /api/tenant/update-admission` -> `v2_tenant_update_admission`, arguments `p_tenant_slug,p_handoff_id,p_action,p_course_id,p_course_run_id,p_notes,p_reason` | `save_details,start_review,verify_payment,reject_payment,accept,complete`; requires appropriate canonical permissions and transitions. Current UI `complete` requires a cohort. |
| Course runs | `POST /api/tenant/save-course-run` -> `v2_tenant_save_course_run`; `CourseRunsWorkspace` | Reuse canonical course/run IDs, schedules, capacity. Self-paced must be separate delivery policy, not fake sessions. |
| Existing native LMS | `getTenantLms` + `LmsWorkspace` -> course runs/training operations | Existing functionality is useful and must remain reachable in pilot. Prototype currently replaces this at `/tenant/marktone/lms`. |
| Training operations | `POST /api/tenant/update-training-operation` -> `v2_tenant_update_training_operation` | Actions include `set_attendance,save_assessment,update_rules,issue_certificate,revoke_certificate`; broad `tenant.training.write` is not instructor assignment restriction. |
| Finance | `/api/accounting/{record-payment,verify-payment,allocate-payment,create-schedule,request-refund,...}` -> `v1_tenant_accounting_action` | Canonical ledger, permission `tenant.accounting.payments.approve` for confirmation. Command dedupe exists in ledger. Do not create second payment ledger. |
| Admission→finance bridge | Accounting action `import_handoff_payment` | Requires verified handoff with amount >0 and accounting approval permission. Imports a payment once using `source_type=registration_handoff,source_id=handoffId`. Currently manual/one-way; finance verify does not close admission loop. |
| Certificate read | `getTenantCertificate` -> `v2_tenant_certificate_snapshot`, `/tenant/[slug]/certificates/[certificateId]` | Requires staff `tenant.training.read`. Need own-certificate snapshot/route for students, not broad staff permission. |
| Communications | `/api/tenant/training-automation` -> `v2_tenant_training_automation_action` | `queue_joining`, manual send markers, retries/settings; outbox `academy.training_automation_jobs` unique `(tenant_id,dedupe_key)` and existing dispatch. Reuse after finance/session access checks. |
| Notifications | `/api/tenant/notifications` -> `v1_tenant_notification_center` | Tenant staff center; no proven existing learner audience. Separate own-scope learner notification projection is needed. |
| Staff tasks | `/api/tenant/{create-task,update-task-status,transition-task}` and task calendar | Link learner operational obligations to canonical `work_core.tasks`; avoid separate invisible queue and preserve one active sales follow-up task/contact. |
| Beneficiary admissions | `/api/tenant/woocommerce-beneficiaries` -> search/save/enroll RPCs | Existing payer vs learner distinctions should be retained; don't infer sponsor from learner contact. |

## Auth / security

- `lib/server-auth.js` reads `mt_access` via HttpOnly cookie and makes Supabase RPC with the user's bearer token. `requireTenant` authorizes employee membership; `requireTenantPermission` checks membership permissions (platform owner supported).
- Prototype `interactiveTrainingAccess` is exact UUID+slug+entitlement and requires academy read **and write**; this is a staff/demo access check, not real learner access.
- `resolvePostLoginPath` currently permits only platform-control or staff `/tenant/<slug>` destinations and falls back to `/` if no memberships. Learner portal needs an explicit validated server-issued destination and separate shell. Do not create staff membership simply to make learner login work.
- Existing `/api/auth/register-invitation` and tenant invitation activation create employee access. Do not reuse token acceptance without a separate learner invitation audience/claim. Link authenticated subject to canonical student; use one-use expiring hash token, safe existing-account confirmation and revocation.
- `course_runs.instructor_name` is free text. Actual instructor authorization needs tenant-scoped subject↔run/content assignment, filtered by server snapshots and mutation checks. Client role switches never authorize operations.
- New dedicated `/api/training/[action]` should adopt `lib/service-hub-http.js` practices: trusted same origin guard (`support-request-origin.mjs`), exact JSON content type, streaming size bound, action allowlist, slug/UUID and payload allowlists, no-store/nosniff, timeout, generic Arabic errors. Existing generic tenant action endpoint has weaker origin/body/error handling and should not be copied wholesale.
- Every mutating command uses a stable command UUID retained across unknown-result retries; reject same command with changed payload. Backend should also validate row revision, owner assignment, entity links and tenant isolation. Do not send subject or role supplied by UI as authority.

## Confirmed backend gaps / risks

1. Admission payment confirmation and accounting verification are distinct sources today; the bridge must reconcile without duplicating cash, allocations or refunds. Credit corporate admission needs explicit authorized exception; first installment alone should not be inferred from any unallocated payment.
2. `private_app.training_eligibility` only checks cohort completion, noncancelled sessions, all recorded attendance, attendance threshold and final score. It rejects zero sessions and has no LMS content/assignment/finance gate. A shared authoritative combined gate must also protect legacy issue-certificate entrypoint for pilot enrollments, or old UI can bypass new policy.
3. Canonical learner identity currently requires proving exact student/contact/subject relationship. Staff tenant permission is insufficient as learner authorization.
4. Grace is tenant calendar days, not elapsed UTC hours. It is a read-time access decision plus idempotent alerts/tasks; UI badge alone cannot suspend content/session links.
5. Transfer/defer/withdraw must preserve original enrollment and history; old attendance references enforce matching run. Blindly changing course_run_id can corrupt relationship semantics. Use new enrollment lineage and explicit compatible-content progress carryover.
6. Existing meeting/join URLs and content must not appear in locked learner snapshots. Metadata of locked course can remain accessible, but access enforcement must cover subsequent requests and supplied URLs/resources.
7. Snapshot queries should paginate scoped enrollments/requests; manager aggregates separate from details, instructor only assigned, student only own. Do not compose all staff snapshots for student pages.
8. Keep route/API/database pilot gate UUID+slug+LMS entitlement+new disabled-by-default rollout. Schema, application, activation and optional backfill are separate reversible steps. No changes to Reef data.

## Implementation difficulty / gates

Overall 9/10: financial reconciliation, independent learner identity and preserving canonical enrollment/certificate behavior are the difficult parts. Sequence: additive backend and scoped snapshots; server API/auth; native manager/instructor/student UI; executable tenant/permission/idempotency and payment-gate tests; staging full flow and query plans; explicit production release approval. No production activation is authorized by current implement-only instruction.
