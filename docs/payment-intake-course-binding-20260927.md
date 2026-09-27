# Automatic intake payment-course correction

## Confirmed cause

The September 22 fix only allowed course-less legacy_unclassified opportunities.
The opportunity insert guard classifies course-less automatic imports as general.
Automatic intake (metadata.model=lead_intake_v2) and lead-centric followup
(metadata.model=lead_centric) therefore remained blocked despite a selected interest.

## Scope and safeguards

- One private eligibility function is used by the context reader and payment writer.
- Only legacy unclassified or known automatic, course-less opportunities qualify.
  Explicit general opportunities, including creationCommandId-marked records, do not.
- UI receives a computed boolean, not internal metadata. The writer recomputes it.
- Binding happens inside the existing authenticated, tenant/owner-scoped transaction,
  after course, batch, session and phone validation. Existing revision checks,
  advisory locks, duplicate-course guard and command idempotency are retained.
- The same opportunity keeps its owner, value and metadata; audit records the real
  previous kind. No backfill, new table, RLS change or production customer edit.
- Constant-time predicate on already loaded rows; no additional table query.

## Verification and release

Targeted DOM/native form and PGlite database tests reproduce the pre-fix rejection,
exercise automatic general and legacy payments, same-opportunity handoffs,
batch/session preservation, task completion, retries, invalid input rollback,
ownership checks, duplicate opportunities and explicit general isolation.
No real customer payment was submitted.

Production authorization is still required for this corrective release.
Apply the additive function migration before deploying the frontend, then reload
the followup context. Old frontend safely continues to block automatic general
until updated; new frontend without the migration also safely blocks it.
Full repository CI/build must pass before deployment.

Rollback: restore the preceding definitions of sales_followup_details and
record_sales_followup_scoped_v1, then restore the previous frontend. Do not undo
successful employee payment transactions or change already-bound opportunities.
The unused private helper can remain until a separately reviewed cleanup.
