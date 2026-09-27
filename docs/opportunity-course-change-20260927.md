# Explicit pre-payment opportunity course change

## Cause and behavior

Interest rows and a sale's bound course are separate. Replacing an interest from
an in-person course to an online course previously left the sale bound to the old
course, making the payment selector empty. Earlier fixes only bound course-less
intake opportunities.

The followup modal now offers an explicit replacement selector for an eligible
open opportunity. The employee chooses a course from the current interest rows;
the payment selector then uses that new course. Saving the followup or reporting
payment changes the same opportunity atomically. Merely editing interests remains
non-destructive. Changing a row clears its batch/session through the existing
details component. Replacement intent is scoped to the selected opportunity;
removing the chosen interest blocks submission until reviewed.

## Engineering gate

- New V8 RPC and private V2 writer retain existing V5/V6/V7 contracts. Only a
  request carrying the explicit replacement field selects V8.
- Tenant/CRM permission and canonical owner checks, tenant/contact advisory lock
  order, row lock, revision check and command replay are preserved. The replacement
  course participates in the idempotency hash.
- Only an open training or bound legacy opportunity with no registration handoff
  history is eligible. Any prior handoff (including rejected) blocks replacement.
  Paid, pending-verification, closed, general and course-less opportunities cannot
  use this operation. Existing course-less payment binding still uses V7.
- Target course, batch and session must belong to the same tenant and match the
  selected interest. An existing open sale for the target course rejects the
  operation; it is not merged, overwritten or duplicated.
- The same opportunity retains owner, value, title and source metadata. Course
  changes get an audit event and old/new course names and IDs in the activity
  metadata, plus a readable note in the existing customer activity history.
- Downstream validation failures roll back course, activity, task, audit, handoff
  and command together. No backfill or production customer test writes.
- UI eligibility is advisory only; the writer rechecks under existing locks.
  Helpers are private, empty-search-path and revoked from public/anon/authenticated.
- Live EXPLAIN of the eligibility predicate used opportunities_pkey and
  registration_handoffs_opportunity_reference_idx. No new table/index/RLS required;
  context adds one boolean and course name per existing open opportunity.

## Validation

Synthetic PGlite tests exercise the exact bound-legacy rejection, explicit course
replacement plus payment, ordinary followup, audit/history, batch/session and task
lifecycle, replay/conflicting command, stale revision, tenant/owner permissions,
invalid course/batch/session, duplicate sale, prior handoff and atomic rollback.
DOM/native form tests exercise deliberate replacement, cleared attendance fields,
removed targets, changed opportunities, and old payment behavior.
Actual route-handler tests verify V5/V6/V7 compatibility, V8 forwarding, session
authorization and actionable errors.

## Release and rollback

Implementation only; this corrective release has not been deployed.
Production publication requires explicit authorization under the ODEIR gate.
Apply the additive function migration before the frontend/API deployment.
Old callers keep their contracts. Roll back frontend/API first and restore the
previous sales_followup_details function; unused private/new RPC functions may
remain until reviewed cleanup. Never reverse successful employee transactions.
No direct data fix is needed for any individual customer.
