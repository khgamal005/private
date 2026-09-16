# Integrated training journey — engineering gate

Implementation scope approved by Marwan on 2026-09-16. Production publication and activation of this new backend are separate release steps. Base: `166c9d4a53ebdafaa4310c8d582c9bd575b97bf6` in `Marktonesa/marktone-platform-control`.

## Verdict and architecture

Feasible as an additive extension of ODEIR, difficulty **9/10**. The hard boundaries are canonical payment/admission reconciliation, independent learner identity, and protecting old certificate entrypoints. Existing contacts, accounting records, students, enrollments, runs, attendance and certificates remain the sources of truth. No new contact/payment/enrollment ledger is introduced. Implementation stages: live/source inspection; additive policy and learning RPCs; authentic learner/instructor access; native staff/learner UI; isolated executable DB/HTTP checks; exact-commit repository Quality; staging end-to-end and deployment review.

Pilot identity is the immutable tenant UUID `3d185482-b916-49cc-b868-b6dfdb93eba8` AND slug `marktone`. Every new authenticated API requires the active LMS entitlement and the server rollout setting. Migrations do not enable the rollout or add training fixtures to production. Reef and all other tenants retain existing behavior. Existing Marktone enrollments are not backfilled: financial guard effects begin only when their handoff is explicitly linked to the new policy.

## Approved operating decisions

| Decision | Implementation boundary |
| --- | --- |
| One person, all intake channels | Existing `sales_core.contacts` identity integrity → `academy.students` → registration handoff/enrollment. Existing employee/site/commerce intake keeps its canonical entrypoint. The new journey attaches to its handoff; it does not reinterpret an imported contact as a new identity. |
| Accounts or permissioned admissions confirms payment | Existing `accounting_core.payments` and verified allocations to an issued invoice. Narrow admissions permission and canonical admission projection preserve sales/activity attribution. |
| First installment and seven-day grace | Versioned financial policy reads existing payment schedules and refunds. Local tenant calendar dates determine the grace boundary. New-content/session access is evaluated on every request; historical progress remains. |
| Companies sponsor multiple learners | Multiple handoffs can link one company payer/invoice, with explicit sponsor/credit authorization and expiry. Learners and instructors do not receive shared company invoice amounts. |
| Multiple delivery modes and repeat cohorts | A preselected eligible cohort is assigned automatically after verified payment. A failed assignment preserves the canonical receipt and routes follow-up to admissions; no arbitrary cohort is chosen by an accountant. Canonical runs/sessions reused; self-paced delivery has an internal run to satisfy existing enrollment invariants without inventing live sessions. Each learner pins a published course-content version. |
| Secure learner account | Separate student↔subject binding and single-use hashed invitation; no employee membership. Assigned instructors are checked against current active tenant membership on every request. |
| Completion and certificate | Versioned attendance/content/quiz/assignment policy plus financial clearance. Human review before course publication. Existing certificate RPC/trigger paths enforce the combined eligibility for enrolled pilot learning. |
| Transfers, deferment, withdrawal and management | Audited requests with responsibility and deadlines; canonical task/notification integration. Same-course cohort transfers preserve original lineage and only carry compatible evidence. Changing the commercial course requires its own invoice/admission; this release does not silently repurpose an existing course invoice. Financial settlement remains in canonical accounting. |

## Impact and controls

- New academy tables have tenant foreign keys, composite tenant/entity references, indexes, RLS, revoked direct client grants, and permission-checked RPC projections. Private helpers are not executable by unprivileged callers.
- New finance links reuse issued invoices, verified payments, allocations, schedules and refunds; no historical money is rewritten. Explicitly linked registrations project canonical admission verification. Existing permission logic remains unchanged outside the scoped pilot.
- Commands use UUID receipts and payload fingerprints; repeated identical actions reuse results, changed payloads are rejected. Row/advisory locks serialize conflicting enrollment, submission, invitation and capacity changes.
- Published versions and enrollment pins are immutable. Learning attempts, grades, events and transfer lineage preserve evidence. Completed-content review is retained during financial suspension while new content and upcoming session URLs remain gated.
- Browser role preview never grants actual authority. The real portal uses authenticated roles and queries. The historical prototype remains isolated until the real rollout is explicitly enabled.
- HTTP boundaries use same-origin validation, bounded streamed JSON, finite action routing, no-store responses, user JWTs, and generic localized errors. No service key is sent to the browser. Activation uses one service-only invitation claim and accepts using the actual learner JWT.
- Default snapshots are bounded; large content is loaded for a focused course/unit. Financial information is projected per role. Automated task scans are bounded, opt-in and deduplicated.

## Verification and release sequence

1. Apply migrations in timestamp order to an isolated database matching the inspected schema; deploy the new invitation function there. Do not use production contacts for testing.
2. Run executable fixture tests for real new SQL, cross-tenant/role denials, current membership revocation, command retry, canonical finance/grace/refunds, student invitations, immutable content, server quiz scoring, instructor grading, old certificate bypass prevention and operational tasks.
3. Repository Quality must pass on the exact proposed head: lint, TypeScript, tests, migration validator and production build. The local fixture preserves real schema/constraints/permission functions, but external delivery/commerce provider behavior is outside that fixture.
4. Review the full UI flow on desktop and mobile against isolated data and inspect representative query plans/payload sizes. FutureX contract validation and accreditation evidence are separate from software checks.
5. After explicit publication authorization: additive schema first (rollout disabled), invitation function, application deployment to the production host, then separately reviewed pilot activation. Verify target IDs and no unintended other-tenant changes. Set policy/owners before enabling automation.

## Rollback

Disable automation and the pilot setting; existing history remains. Restore the previous application commit if required. Do not drop new tables or remove existing contacts, payments, enrollments, certificates, grades or audit events. Staff canonical operations remain authoritative. A rollback to the historical prototype must be clearly identified as the prototype; it must not report live training outcomes from local sample state.

## Regulatory and delivery limits

See `training-journey-nelc-requirements.md` for dated primary sources and applicability. Attendance and pass thresholds are program policy, not hardcoded claims of a universal regulatory minimum. Recorded elapsed-open time plus learner acknowledgement is evidence of the application interaction, not proof of video watch time. Public/external resource URLs already disclosed to an authorized learner cannot be recalled; protected media hosting requires its own short-lived delivery enforcement.

Learning events persist with external delivery disabled. This change does not claim a tested FutureX connector, regulator acceptance, platform accreditation or program licensing. Real AI generation is also separate from the previously delivered simulated authoring prototype. These limitations belong to the release/readiness record, without adding lengthy warnings to the learner flow.

## Implemented verification evidence

- Executable Postgres fixtures preserve 50 inspected canonical tables, 442 constraints and 30 integrity triggers, together with the actual financial/admission permission functions. Tests execute the three new migrations rather than matching SQL text alone.
- HTTP tests cover cross-origin rejection, streamed size limits, finite actions, role/tenant overrides, hashed invitations, cookies and fixed login destinations. Mounted component tests cover real learner actions, uncertain retries, suspension, pagination, content editing and instructor feedback.
- A synthetic catalog of 2,002 courses across two tenants returned a 50-course metadata page of 14,302 bytes without private content or other-tenant data. Actual EXPLAIN plans were inspected; this is bounded-query evidence, not a production throughput benchmark.
- Embedded Postgres tests do not establish concurrent multi-session behavior. Isolated real-Postgres concurrency and live desktop/mobile end-to-end checks remain release gates, along with FutureX contract validation if external reporting is enabled.
- The operational sidebar reflects real capabilities. Supplemental historical prototype screens remain accessible through a clearly labeled development-preview link; their sample state is never used as operational training evidence.
