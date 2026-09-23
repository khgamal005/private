# Academy connected delivery — implementation checkpoint

Base: `dfec0b996597a310de22aa86dce177c5cf59f668` (main, PR 264).
Authorization: implement the accepted recommendations on an isolated branch; production activation is a separate release decision.

## Scope

- One canonical course, with store offers for existing canonical delivery runs. Clear content/store publication states.
- Private resumable video upload or HTTPS URL, playback restricted to authorized course staff or eligible enrolled learners. Download off by default, configurable per asset. This is access control, not DRM.
- Show and inherit Admissions session/Zoom links from the selected run; do not create another meeting provider integration.
- Tenant-scoped student and instructor management using canonical contacts, students, subjects and safe invitation acceptance.
- Keep existing contact owner. Assign eligible new store contacts using ODEIR operating rules; surface unassigned cases to managers. Idempotent operational follow-up.
- Free and one-time course purchases; installment access must follow existing invoice, schedule, verified-payment and grace policies. No recurring subscription/membership system in this change.

## Invariants

Exact Marktone pilot gate, disabled by default. No historical backfill, no Reef writes, no bulk activation. A reported transfer is not a verified payment. Enrollment and learner authentication binding are separate: do not auto-bind by email alone. Existing enrollment content-version pins and attribution are preserved. No browser service-role secret. No network I/O under database locks.

## Validation plan

Synthetic database cases for tenant/role isolation, identity conflicts, repeat commands, payment and installment eligibility, refunds, enrollment/version pins and task deduplication. HTTP/client upload tests include resume, cancellation, failure and private playback. Verify grouped store/cohort and people UI states. Run the repository quality and concurrency gates before marking the candidate ready.

## Status

Implementation in progress. No production migration, rollout flag, merge or deployment performed for this phase.
