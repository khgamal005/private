# Academy course, curriculum and path authoring — phase 1

## Scope and engineering decision

Implement the first authoring phase requested by Marwan on 2026-09-22. The reference workflow is course basics → curriculum → review/publication, with ODEIR typography, navy/gold styling and Arabic guidance. This phase creates canonical short courses, ordered topics/activities, and ordered multi-course learning paths. It does not claim complete Tutor LMS Pro parity.

The current production schema was inspected read-only in project `gswpbwdactcstkasddta`: canonical course columns/checks, training version/unit columns/checks, platform settings/commands, and the live academy permission/tenant helper definitions were verified. Main at inspection was `d8f8a87b06dcfe08524d7ba4e377501c1dd2be69`. No production data or schema was mutated during implementation.

Difficulty for this bounded phase: 8/10. The difficult parts are publishing through the existing immutable learning engine, protecting against stale drafts and retries, retaining canonical admission/finance behavior, and keeping learner projections free of answer keys.

## Delivered behavior

- Create a course from its title, or open an existing canonical course. A focused server read is required before editing; list metadata is never saved as content.
- Save incomplete course drafts. Add sections and text, video-link, external-link, single-choice quiz and assignment activities. Reorder sections and activities, preview content, then resolve the publication checklist.
- Keep content in a server-backed revision. A stale save is rejected. Explicit human review publishes a new immutable training version in one transaction. Existing learner enrollment pins remain untouched.
- Show published/draft/changed states and a review-and-publish action on list cards. Route Academy content navigation to the canonical authoring entry; the legacy editor remains the fallback when the new capability is disabled.
- Store an AI generation brief at course or activity level. The UI clearly says that provider configuration is required. No model request, credit purchase, secret entry or fabricated generated content exists in this phase. Future generation must produce a reviewable draft through the same validated authoring contract.
- Create and publish learning paths as ordered collections of existing course IDs. Publication requires published content and active canonical courses. The path is a recommended sequence, not an additional enrollment, payment policy or enforced prerequisite engine.
- Display published curriculum headings in the learner activity list. Show a learner only published paths intersecting that learner's actual registrations, with personal progress. Unenrolled courses remain labeled as requiring registration.

## Data and security

Migration `20260922192706_academy_course_authoring_v1.sql` adds authoring settings, course drafts/releases, path drafts/releases and tenant-composite course links. It creates no activation row and performs no historical backfill. Direct public/authenticated table access is revoked, with RLS defense in depth; privileged RPCs check actual subject permissions and tenant configuration.

The capability is restricted to the exact Marktone tenant UUID and slug and is off by default. Course authoring requires both `manageLearning` and `manageCourses`. Actor identity is never accepted from the browser. The existing admission, payment, enrollment, grading and certificate engines remain authoritative. No Reef records are read for testing, seeded, changed or deleted.

Publication flattens the reviewed topic order into existing units and stores safe topic labels/ranges in `policy.curriculumTopics`. Answers and AI briefs stay outside learner metadata. Published releases are immutable. Command receipts and locks protect retries, duplicate creates and conflicting revisions. A newer publication from the legacy editor is explicitly identified instead of being paired with an unrelated authoring revision.

Lists and searches are server-bounded (50 authoring rows per page, 20 learner paths per page). A focused path includes its selected course summaries even when those courses are outside the current catalog page. Documents, activity counts, links and AI briefs have bounded validation at the HTTP/database boundaries. Content is escaped rather than rendered as arbitrary HTML. Media currently uses HTTPS links; private media upload/delivery is a later phase.

## Verification and remaining release gates

Executable isolated PostgreSQL/PGlite tests cover disabled rollout, tenant/role and direct-table denial, canonical creation, stale revisions, command replay, atomic failed publication, immutable releases, preserved enrollment pins, mixed-editor provenance, path ordering/publication, bounded search and learner-only progress. Mounted React tests cover the actual authoring component, saved revisions, explicit review, uncertain retries, AI brief persistence, preview escaping, unsaved changes and navigation. HTTP tests cover origin, finite actions, request bounds and rejected actor/tenant injection.

The repository suite, ESLint, TypeScript, migration verifier and production build are run locally. ESLint has pre-existing warnings outside this change. PGlite tests are not a multi-connection load test. The managed browser refused the local preview with `ERR_BLOCKED_BY_CLIENT`; no desktop/mobile visual pass is claimed. The reproducible synthetic preview entry is `tests/ui/academy-authoring-browser-entry.jsx`, used with `tests/ui/academy-browser-harness.mjs`.

Release verification now includes representative query plans and payload budgets in `tests/academy-authoring-performance.test.mjs`: 1,001 pilot courses, 9,001 unrelated courses, 3,003 versions and 200 paths with 100 courses each. The list, near-limit focused draft and learner page were respectively 34,761, 987,276 and 316,211 bytes; existing tenant/course/path indexes were used. Synthetic PGlite timings are diagnostic evidence, not a production latency guarantee. The PostgreSQL CI workflow additionally exercises concurrent duplicate creation, stale saves, course publication and path edits/publication with a three-connection lock barrier; its final candidate must pass before activation.

The enabled learner projection preserves the established empty dashboard for inactive or blocked students, while missing/suspended learner bindings remain denied. Desktop/mobile visual review remains unverified: the browser could not reach the local preview. This limitation was disclosed before the user's publication instruction. Verify the served `academy-authoring-v1-20260922` release manifest and protected API after deployment. Future protected uploads, content/question bank, rich document editing, additional quiz types, prerequisites/drip enforcement, instructor-authoring permissions and real AI configuration remain separate phases.

## Release and rollback

Marwan separately authorized production publication with “انشر” after reviewing the implementation summary and its disclosed visual-verification limitation. Publication and activation remain limited to Marktone; there is no authorization to backfill or change another tenant's data.

Release order: apply the additive migration with rollout disabled; deploy the matching application; enable only the exact Marktone row in `academy.authoring_settings` after the release gates; smoke-test manager create/save/publish and learner read access. Validate the tenant UUID against `3d185482-b916-49cc-b868-b6dfdb93eba8` and slug `marktone` before any activation. No bulk conversion or backfill is required.

Rollback: disable the authoring setting and restore the preceding application if needed. Keep drafts, releases, learning evidence, canonical courses and command history. Do not drop the new tables or rewrite enrollments. Published versions remain readable by the established learning engine.
