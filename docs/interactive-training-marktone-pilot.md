# Interactive training: Marktone native pilot

## Scope and engineering decision

Add the interactive training prototype inside ODEIR's existing `lms` product and tenant shell. This phase is UI development with local sample data; it does not introduce a second operational enrollment, grading, payment, or certificate system. Existing admissions/training RPCs remain authoritative and unchanged. No migration, backfill, seed, catalog change, or production data mutation is included.

The pilot is bound to the verified tenant UUID `3d185482-b916-49cc-b868-b6dfdb93eba8` **and** slug `marktone` (مركز ماركتون لادارة المنشأت). The server also requires an authenticated subject, authoritative tenant identity from `v3_tenant_addon_navigation_snapshot`, active LMS entitlement, and academy read/write permissions (or platform access). Other tenants retain their existing `/lms` experience; the new child routes return 404 for them. Reef data and workflows are outside scope.

## Native UI and data boundary

- One ODEIR sidebar group with 13 registered child views; no duplicate LMS shell or dependency on the standalone prototype site.
- Native theme variables, inherited typography, scoped CSS, responsive layouts, keyboard-operable tabs and dialogs.
- Manager/instructor/student view switching is allowed only for platform operators or tenant owner/admin/training manager roles with write permission. It changes local preview state, never authentication or backend privileges.
- Local demo state is versioned and scoped by tenant UUID and authenticated subject UUID. Roles are stored in the same identity scope in session storage. Identity or preview capability changes remount the component.
- Sample learner journey includes sequential lessons, quiz, submitted assignment, instructor grade, and a clearly marked sample certificate. Completion requires all lessons, a passed quiz, a submission and a passing grade.
- AI course authoring previews an editable generated-outline workflow with human review. No external AI API or real generation is connected in this phase.
- Long accreditation warnings are removed from the product UI. The readiness screen retains task/evidence status and official references; it does not assert accreditation.

The implementation deliberately has no privileged write endpoint. Production persistence, program licensing, identity verification, SCORM/xAPI, live classroom and regulatory integrations remain subsequent implementation work after UI review.

## Release and activation

Implementation and a draft PR are authorized. Production deployment is a separate step under `odeir-engineering-gate`; neither production publishing nor entitlement activation is performed by this change.

Read-only production verification on 2026-09-16 confirmed the tenant UUID/slug above, existing product `lms` / feature `addon.training.lms`, and **no effective LMS entitlement for Marktone**. Do not bypass that entitlement in code or expose a public rollout flag.

After PR checks, staging review, and explicit production release authorization:

1. Release the reviewed commit through the existing ODEIR deployment process.
2. In platform control, use متجر الإضافات → تراخيص المنشآت → منح ترخيص for the verified Marktone tenant and product `lms`. Use a bounded approved trial period and a reason identifying this pilot.
3. The existing audited `grant_subscription` action accepts `tenantId`, `productKey`, `startsAt`, `endsAt`, `reason`; the console uses Riyadh time (`+03:00`). Do not write entitlement tables directly or change a shared plan.
4. Confirm the tenant snapshot reports the same UUID/slug and includes `lms`, then open `/tenant/marktone/lms`. Verify all 13 menus, permitted role views and the learner journey.
5. With another tenant account, confirm the legacy LMS remains unchanged and `/lms/courses` and other new child routes remain unavailable. Verify unlicensed and unauthorized Marktone users cannot access the pilot.

For later expansion, replace the reviewed pilot allowlist with a separately reviewed tenant-scoped rollout mechanism. Licensing other tenants alone must not activate this new UI.

## Risk and rollback

Difficulty for this bounded UI integration: 4/10; production LMS persistence and external regulatory integrations are separate, larger phases. Main risks are navigation/permission drift, browser storage identity leakage, and confusion between sample and live training records. Shared access metadata, server guards, scoped storage and accurate short UI labels address these risks.

Rollback the application commit to restore the previous native LMS screen. If a new trial license was granted solely for this pilot, use the existing audited subscription status action on **that subscription only**, or let the bounded period expire. Preserve all historical rows and other licenses. No database rollback or data deletion is required. Local demo reset affects only the current tenant/subject storage key.

## Verification

Targeted checks cover tenant identity spoofing, missing entitlement, inactive/missing membership, conflicting UUIDs, route whitelist, permissions and role-preview revocation; mounted React tests cover the learner-to-instructor completion flow and storage isolation. Existing add-on navigation and admissions/LMS boundary tests are retained. Full repository lint/typecheck/test/migration/build gates run on the PR before release.
# Historical prototype scope

This document records the initial interactive preview release. The subsequent persistent operating journey is specified in [training-journey-engineering-gate.md](training-journey-engineering-gate.md); its database and authorization behavior differs from the local-only prototype described below.

