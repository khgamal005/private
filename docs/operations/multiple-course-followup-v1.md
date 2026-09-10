# ODEIR: multiple course interests and additional phone numbers

Scope: ODEIR only, `Marktonesa/marktone-platform-control`, `odeir.com`.
Reviewed upstream: `bf112813e973c1082b286e902c578ee84041e094`; the local inspection baseline tree was verified to equal upstream tree `7c13481de87ab44be03fbc15ec6349ace2dc3aa8`.
Production inspection was read-only and limited to schema, constraints and function definitions in project `gswpbwdactcstkasddta`. No production data was seeded, edited, normalized, deleted, or used as test fixtures. No production migration or deployment has been performed.

## Product behavior

- In the follow-up dialog, `+ إضافة دورة` adds an independent course, batch and attendance selector. The attendance selector chooses the batch start or a scheduled session in that batch. Changing a course clears only its own batch and attendance; changing a batch clears only its own attendance. Blank added rows are ignored. A course can appear once, with up to 20 interests per contact.
- The user clarified that the date means **course attendance within the batch**. It does not create or reschedule a sales follow-up task per course, alter the batch timetable, mark attendance, or enroll a student automatically.
- `+ إضافة رقم` adds a secondary phone to the existing contact, up to 10 additional numbers. The primary phone retains its existing editing workflow. Equivalent Saudi/international and Arabic-digit representations are checked with the existing canonical normalization contract.
- Additional phones participate in the canonical identity registry, so a new intake cannot create a second contact with an existing additional number. Removing an additional number from the current list retains its identity as a historical alias; it is not reassigned to another customer silently.
- All interests and extra phones reappear after loading the dialog and in customer history. The sales listing displays the interest names and supports exact phone search through canonical identities. Existing cursor, filters and summary definitions are retained.
- A payment report explicitly selects the course to which that report applies. Only that course's existing handoff is submitted for verification, with its batch, attendance session metadata and tenant-local preferred start date. The other selected courses remain saved interests. This does not introduce multi-course payment allocation or confirm payment automatically.

## Engineering gate

Verdict: feasible through additive data and versioned RPCs; complexity **7/10**. The difficult parts are preserving the single-contact/single-follow-up lifecycle, canonical identity ownership, and avoiding accidental payment attribution to every interest.

`sales_core.contact_course_interests` stores current preferences using tenant/contact/course keys and composite foreign keys through courses, runs and sessions. It does not duplicate opportunities, registrations, tasks or contacts. The old scalar `interest_course_id` remains the first interest for existing readers; legacy changes to that scalar are respected when loading the new editor.

Additional numbers reuse `sales_core.contact_identities` with the additive `additional_phone` source slot and `is_alias=true`, compatible with the existing primary-identity synchronization trigger. The tenant/type/value unique index remains authoritative. No existing identities are backfilled.

The V6 write RPC takes the established tenant identity lock, then the contact lifecycle lock and contact row lock, rechecks ownership, validates every course/run/session relationship, and invokes the actual existing V5 → V4 → V3 → V2 pipeline once. Preference writes, phone aliases, activity metadata, handoff metadata, audit history and the idempotency receipt commit atomically. A per-request UUID and request digest prevent retry duplication; a revision token rejects stale edits. The dialog hydrates current contact fields so a stale page snapshot cannot silently revert a newer name or quality.

Both new tables have RLS enabled and no direct grants to public/anon/authenticated. They are accessed through permission-checked RPCs. Definer functions use an empty search path and explicit execution grants; internal helpers are not granted to clients. Read access and contact ownership are checked before returning identities, preferences or options. No service keys are exposed.

The sales read is a separately named V2, preserving the reviewed V1 query and pagination contract while adding indexed identity lookups and per-visible-contact details. Options load only for a selected course, with indexed joins to runs/sessions and a four-second SQL timeout. There are no external calls while locks are held. No payment, Meta, Google Ads, distribution metric or notification contract was replaced.

## Verification

- Database integration tests use PGlite, synthetic records and schema/function fixtures inspected from production definitions. They execute the real V2–V5 sales functions under the new V6 wrapper.
- Covered: permission denial, tenant and owner isolation, composite FK rejection, duplicate courses and phones, atomic rollback on failure, round-trip persistence, canonical alias preservation, idempotent retry, stale revision rejection, task reuse, stable opportunity count, exact additional-phone search, unchanged summary/pagination semantics, history read, and selecting only one payment course with a date crossing midnight in the tenant timezone.
- React interaction tests compile the actual dialog and detail components with the installed Next SWC compiler and run them in JSDOM. Covered: loading/save guard, independent rows, dependent-field reset, removal retaining other row values, duplicate-phone feedback, a failed network request followed by the same idempotency key, and payment course selection.
- Full test run: 1051 passing tests, no failures. Production build succeeded. Final quality command: `TZ=UTC npm run check` (lint, types, all tests, migration verification, production build). The project already has unrelated lint warnings.
- A live browser preview could not be opened because the environment blocked access to local preview origins. Browser screenshot/layout checks and a real staging acceptance test remain release checks; JSDOM does not measure mobile rendering.
- PGlite executes the SQL lifecycle and stale/retry cases, but does not prove simultaneous multi-connection locking. A two-session concurrency test and representative Postgres query plans remain pre-activation checks.

## Rollout and rollback

1. Confirm the live schema still matches the reviewed function/constraint contracts and the branch is current with `main`. Use the installed Supabase CLI to validate migration ordering before deployment; it was unavailable in this workspace, so no CLI migration command or remote migration was run here.
2. Apply only the new migration to an isolated staging environment, then deploy this application version there. Use synthetic records. Exercise course/batch/session selection, reload, phones, a payment report, and the existing admission review, with both an owner and a sales employee. Check two-session races and plans/payloads on representative data.
3. After explicit production authorization and those release checks, apply the additive migration before deploying the application to Hostinger. No seed, tenant update or Reef backfill is required. Old tabs can continue to call V5; new structured submissions route to V6.
4. Application rollback restores the old dialog and original read RPC names. Leave the new tables, source-slot constraint and stored records in place to retain preferences and audit history. Do not drop a source slot or remove identities after use. Old primary-phone editing continues to preserve alias ownership.

This branch prepares the capability for review. It does not authorize changing any Reef record or publishing to production.
