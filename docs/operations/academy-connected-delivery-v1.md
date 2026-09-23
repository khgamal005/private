# Academy connected delivery — review candidate

Base: `dfec0b996597a310de22aa86dce177c5cf59f668` (main, PR 264). Branch: `codex/academy-connected-delivery-v1`.
Authorization: implement the accepted recommendations on an isolated branch. Production activation remains a separate release decision. This change does not merge, deploy, enable a tenant, send email, configure an AI provider, create Zoom meetings, or backfill historical data.

## Result

- The canonical course is the product. Its authoring screen selects an existing ODEIR cohort or creates one in the same canonical run table, saves free/one-time/installment prices, assigns instructors, and explicitly shows/hides each cohort offer. Content publication and store visibility remain separate. Existing order terms are immutable snapshots.
- Dates for new cohorts use the tenant timezone, including the existing DST validation helper. Session links come from the selected canonical Admissions run; existing Zoom provider-managed sessions are never rewritten here. Learners keep seeing their enrolled run's existing sessions.
- Lessons accept an HTTPS video URL or private MP4/WebM upload, up to 500 MiB **subject to the release storage preflight below**. TUS uses 6 MiB chunks, an object-scoped signature, pause/resume, progress and explicit finalization. Finalization verifies actual Storage object MIME and byte size. Drafts cannot publish a pending or cross-course managed asset.
- Media is immutable. Playback requires active membership/assignment or an eligible learner's exact pinned curriculum. Download is off by default, with versioned/idempotent per-asset policy changes. Private signed read URLs last 300 seconds. This is access control, not DRM: an authorized player receives video bytes. A changed grant may take up to the existing signed URL lifetime to affect an already-issued URL.
- The people screen reuses canonical contacts/students and staff profiles, includes existing platform instructors, searches/paginates results, and creates confirmed-email invitation links. It does not automatically bind an account from an email match or grant an operational employee role.
- Connected store approval creates the canonical invoice, payment/allocation where money actually exists, financial link, student, enrollment and content pin in one transaction. Existing contact ownership is preserved. Unowned buyers use the established fair/online distribution selector, capacity, shift and absence checks. A manager queue stays visible when no eligible owner exists.
- Operational verified payment/admission completion reaches the same enrollment/content path. Background pinning explicitly records a system actor without impersonating staff. Existing content pins are never replaced automatically. Tasks reuse stable keys; accepting the learner invitation closes the corresponding onboarding task.
- Standalone academies retain their established financial authority. Operational sales assignment/tasks run only in connected mode. An academy-only manager in connected mode cannot confirm operational payment or assign operational ownership without the existing ODEIR permission.

## Financial semantics

A reported transfer is not verified money. Free approval creates a zero-value issued invoice and no payment/allocation. The legacy handoff `paid_at` field is NOT NULL, so a free handoff uses its approval time with `paymentMethod: free`; the order has no received-payment time or payment ID. Existing cash reports still sum zero.

Installments are 2–12 positive amounts with exact total including tax, first due at checkout and strictly increasing offsets up to 730 days. Checkout snapshots absolute due dates in tenant time. Verification accepts exactly the first required amount, using the full canonical invoice and payment schedules. Later amounts flow through existing accounting actions.

ODEIR admission governance deliberately continues study after admission when later installments become overdue; collection warnings and certificate settlement rules remain active. This change preserves that policy and does not add automatic suspension. Cancellation, withdrawal, suspended learner bindings and blocked students still deny access. Disabling the new rollout flag does not reinterpret existing enrolled installment agreements.

## Database and security

Four ordered migrations:

1. `20260923090741_academy_connected_delivery_v1.sql`: disabled tenant setting, private media records/bucket, signed upload/read authorization, restrictive Storage guards, authoring capability.
2. `20260923091646_academy_course_commerce_bridge_v1.sql`: course/run selling, installment order snapshots and canonical free/deposit verification. Read-only production definition hashes stop replacement if another release changed the baseline functions.
3. `20260923092103_academy_people_management_v1.sql`: canonical identity reuse, instructor directory, invitation acceptance linkage and role-conflict protection.
4. `20260923094349_academy_student_operations_bridge_v1.sql`: shared capacity counters, ownership reconciliation, enrollment delivery and stable operational tasks.

Exact pilot: tenant `3d185482-b916-49cc-b868-b6dfdb93eba8`, slug `marktone`, active LMS entitlement and `academy.delivery_settings.enabled=true`. Migration defaults are off. No Reef or other tenant data writes.

New tables have RLS, no direct application grants, tenant-qualified FKs and lookup/FK indexes. Authorization runs before command replay. Functions use fixed search paths. HTTP mutations use same-origin checks, bounded bodies and the server session. Neither a service-role key nor the user's session JWT reaches upload code. File names never become storage paths. Storage restrictive guards survive unrelated future permissive policies. The existing live Storage policies were inspected read-only on 2026-09-23; none grants unscoped academy access.

The shared routing lock uses the existing `woocommerce-order-routing:<tenant>` seed 2401. Native verification already holds contact/run locks, so routing uses try-lock: contention goes to a visible queue rather than deadlocking payment verification. Queue reconciliation never replays a financial write. Daily capacity includes both existing and native workload.

Read bounds: people 50/page, instructor candidates 100, course runs/offers 100, sessions 100/run. Use the existing paginated schedule screen for older runs. No history traversal or network call executes under a database lock.

## Verification

- Database suites: free/full/installment financial chains, immutable order terms, rollout rollback, course/run idempotency, staff/student reuse, verified-email acceptance, instructor assignment, role/tenant isolation, system admission delivery, stable tasks, owner preservation, daily capacity, no-current-shift queue fallback, pinned private media and restricted Storage writes.
- HTTP/upload tests: foreign origin/tenant rejection, byte/type limits, object-scoped TUS signing, session secrecy, URL origin validation, exact 300-second read signing, download denial, resume-origin filtering, invitation hashing and input whitelists.
- Rendered React DOM tests: publication states, free/cohort selection, repeated write identity after connection loss, tenant-time cohort creation, staff reuse, invitation links, video pause/resume and failed-finalization recovery.
- Existing PostgreSQL 16 concurrency CI is extended with simultaneous media policy/upload, canonical person creation and purchases of different courses sharing one daily assignment slot. CI must pass on the final PR SHA.
- The synthetic browser harness is `tests/ui/academy-delivery-browser-entry.jsx`. On this workstation the cloud browser's `terminal.local:4173` opened a different application/404 instead of the isolated harness. **No successful pixel-level or authenticated production browser check is claimed.** Run the release browser acceptance below before activation.

## Release preflight and acceptance

1. Check the final reviewed PR SHA and both Quality and Academy concurrency checks. Re-read current `main`; resolve any concurrent changes, especially Admissions/Zoom, instead of replacing their functions. Run `scripts/academy-connected-delivery-preflight.sql` read-only; migration baseline checks must match.
2. Verify project Storage global file limit is at least 524288000 bytes, plan/quota headroom, private bucket constraints and resumable endpoint/CORS support. The connector in this work session does not expose global Storage settings; do not claim the 500 MiB limit was configured. Keep activation off until verified; do not silently raise a paid plan or global quota.
3. Apply only the four migrations in timestamp order through the approved Supabase migration workflow. Their default-disabled state allows application deployment before pilot activation. Do not replay older migration history or run a data backfill.
4. Deploy the reviewed application, then verify manager/instructor/learner roles at desktop and 390px. In an isolated acceptance environment: create a course/cohort, add linked instructors, upload/pause/resume/finalize video, publish, check free/full/installment checkout and identity conflict, verify owner assignment and task closure, compare the learner's Zoom session to Admissions, and confirm foreign-tenant denial. Test an actual signed Storage upload and seeking/playback, including >50 MiB, before asserting production readiness.
5. Only after release authorization, enable the exact Marktone row and record the real approving actor. No bulk enable. If historical accepted students need a content pin, use the existing explicit version assignment; do not silently alter their history. Reconcile individual historical store orders through the scoped order action only after reviewing their canonical records.
6. Monitor upload/finalization errors, denied playback, identity conflicts, unassigned queue items, admissions worker failures and financial command retries. No invitation email is sent automatically in this release; staff share the generated link through their approved channel.

## Rollback

Disable only Marktone's delivery setting to stop new advanced writes and automatic bridges. Preserve the new code's playback route for already-published media and keep existing installment eligibility semantics. Existing signed reads expire within 300 seconds. Revert UI entry points selectively if needed; a wholesale pre-media application rollback would break existing video URLs and is not safe after adoption.

Do not delete students, contacts, invoices, payments, enrollments, content pins, invitations or media as a rollback. Uploaded objects referenced by immutable versions must remain. Pending/cancelled objects require a separately reviewed, bounded Storage API cleanup after their ticket lifetime; never delete Storage metadata directly. The current release has no automatic destructive storage cleanup and caps active pending uploads at five per course.
