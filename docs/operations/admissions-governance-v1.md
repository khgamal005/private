# Admissions and academic governance v1

This is an opt-in application/database implementation. The migration activates no tenant, repairs no historic records, schedules no job until an administrator confirms a current policy preview, and deploys nothing. Free tenants use the same admission policy without buying sync or LMS.

## Sources of truth

`registration_handoffs`, required documents, canonical finance and `enrollments` retain authority. `admission_readiness` is a recomputable projection: admitted/enrolled academic state is independent of later collection status. One existing `registration-<handoff>` task is reused with a waiting reason, owner and deadline.

Program classification is explicit (`short_course`/`diploma`). Unclassified historic programs wait for classification. Short courses require an issued linked invoice or documented agreement in append-only, course-bound `admission_commercial_terms`, same-currency verified net cash for the entire amount, or an authorized recorded admission waiver. An agreement that differs from a linked invoice's net total waits for an explicit financial correction; a zero-priced agreement cannot erase an existing invoice debt. Legacy opportunity values and list prices are not assumed to be agreed totals: older verification could have overwritten opportunity value with a partial payment. Zero-priced agreements and waivers never manufacture payment events. Waivers allow admission; an invoice debt is cleared only by an explicit financial credit/settlement.

Diplomas consume `private_app.diploma_admission_eligibility_v1(uuid,uuid)` from the adjacent diploma migration: approved parent contract and first installment, or its separately authorized waiver. Subsequent arrears do not revoke academic progress or access. Existing pilot financial restrictions remain unchanged when governance is disabled. With governance enabled, explicit academic deferral, inactive enrollment or a blocked learner still blocks study; debt alone does not. Certificate financial settlement policy remains intact.

## Placement and closure

| Condition | Outcome |
| --- | --- |
| Missing independent beneficiary phone | Wait for beneficiary data |
| Required document incomplete | Wait for review |
| No batch | Confirmed financially, awaiting placement |
| Planning batch | Reservation, no enrollment/capacity consumption |
| Open batch and prerequisites satisfied | Atomic, idempotent enrollment |
| In-progress batch | Require authorized late approval and reason |
| Full batch or closed registration window | Explicit waiting reason |
| Completed/cancelled batch | Reject new placement; retain a resolution task for existing waiting requests |
| Existing withdrawn/cancelled enrollment | Preserve its state; never silently revive it |
| 48 hours after the later of batch end and last non-cancelled lecture end | Automatically close only when lectures are completed and attendance gates pass; otherwise create a review task |
| Missing attendance | Remains unrecorded and blocks closure unless an authorized reasoned exception exists |

Batch editing preserves session IDs and attendance. Recorded sessions cannot be removed, renumbered, moved in time, or cancelled by editing the schedule. A schema-only guard also protects this history when the admission engine is disabled.

An authorized manager can reopen a completed batch with a recorded reason. This creates a review task and pauses automatic closure for that batch until a manual closure decision, so it is not immediately closed again by the next worker run. Academic closure never closes a diploma's financial obligations.

Woo beneficiary tables are optional. Ordinary/free admission works on both the live baseline without them and a beneficiary-enabled database. Beneficiary placement remains in its canonical per-seat workflow; the payer is never auto-enrolled as an extra learner. New seat enrollment enforces the beneficiary's own phone. No historical seat/phone repair is performed.

## Activation, worker and rollback

The admissions screen exposes policy preview and explicit confirmation to `tenant.admissions.governance.manage`. A preview shows open requests, programs needing classification, missing batches, and requests ready to enroll. Changing the previewed payload or relevant counts invalidates confirmation. Finance and placement owners must be selected.

Default SLAs are one business day. Tenant timezone and configurable ISO weekend days (Friday/Saturday by default) determine deadlines, preserving the tenant's local time through DST. Public holidays and business-hour calendars are not modeled by this version. Changing the same waiting record does not reset its deadline. Off-shift/on-leave owners are excluded through the operating foundation helper; an unowned task remains visible with `ownerMissing` instead of disappearing.

Deferred handoff/document events reconcile once the originating transaction is complete. Run changes enqueue affected requests; saving the batch attempts up to 100 immediately. A private `SKIP LOCKED` worker processes up to 100 admission requests and 100 closure candidates per minute after explicit activation, with durable retries and failure counts. Closure checks rotate through waiting candidates so incomplete early batches do not starve later batches. Background audit events identify the worker and the policy approver without impersonating an interactive user. No email/SMS is sent by this engine. Lock contention queues a retry; network calls are never made inside transactions.

Disable the tenant policy to stop new automation and restore the pre-governance admission/pilot entrypoints. Do not delete agreements, exceptions, enrollments, financial documents, attendance, queues or audit records to roll back. Existing financial obligations and historical evidence survive deactivation. Session evidence preservation remains in force.

Public entrypoints:

- Existing `v2_tenant_update_admission`, `v2_tenant_update_admission_document`, `v3_tenant_admissions_snapshot`, `v2_tenant_course_runs_snapshot` retain their signatures.
- `v1_tenant_admission_governance_snapshot(p_tenant_slug)` exposes policy capabilities and queue counts.
- `v1_tenant_admission_governance_action(p_tenant_slug,p_action,p_payload)` supports preview/save policy, reevaluation, queue processing, agreed price, admission waiver, late admission and reasoned batch closure.
- Private worker: `private_app.process_admission_governance_queue_v1(p_limit default 100)`; root readiness may read `academy.admission_governance_settings`, but readiness does not require activating this policy.

## Verification

`node --test tests/admissions-governance-database.test.mjs` executes the migration and functions in isolated Postgres/PGlite against the repository's captured schema and real ACL functions. It covers preview authorization/staleness, foreign tenants, table/RPC grants, full/partial payment, required documents, retry idempotency, reservations/late/closed placement, price/currency uncertainty, missing phones, fee waiver without cash, configured weekends/DST, attendance closure, immutable session evidence, production without beneficiary schema, cancellation/reactivation and enabled/disabled pilot access behavior. Financial and diploma helpers are also exercised together by `tests/operational-governance-integration.test.mjs`, including actual payment allocation, admission and cancellation refund flows. Real multi-connection concurrency and authenticated staging browser checks are release gates, not claimed by the isolated test.
