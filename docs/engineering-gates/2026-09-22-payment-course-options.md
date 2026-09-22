# Payment report course options — engineering gate

Status: production publication authorized by the user on 22 September 2026; release in progress.

## Confirmed cause

The followup modal restricts payment choices to the selected opportunity's course. A pre-governance opportunity can have `kind=legacy_unclassified` and a null course, so every selected interest is filtered out. The scoped followup RPC independently rejects the same request as `payment_opportunity_mismatch`.

Read-only production inspection confirmed this shape for the reported case. The live `private_app.record_sales_followup_scoped_v1` definition matches the repository baseline exactly (definition MD5 `f727b53f57d8df444b59350edf6911ee`). No customer names, phone numbers, credentials, or production record IDs are included in this change.

## Scope and behavior

- Show the employee's selected interests for a course-less, unclassified legacy opportunity. Automatically select a single course; require a choice when there are several.
- At payment submission, after permission, ownership, revision, course, batch, attendance and phone validation, bind that same legacy opportunity to the selected course and classify it as training.
- Preserve its ID, owner, value, metadata and historical activity. Record an audit event for the course binding.
- Use the existing payment handoff pipeline: payment remains pending verification, selected attendance reaches admissions, and the existing calendar task lifecycle is retained.
- An explicit general opportunity remains general. A course-bound opportunity cannot be relabeled as another course. Explain empty-choice states in Arabic.
- If another open opportunity already represents the selected course, ask the employee to select it instead of creating or merging opportunities.

## Data, safety and performance

Migration `20260922141735_sales_payment_legacy_course_binding_v1.sql` replaces one private function. It does not backfill, seed, delete, or rewrite customer records during deployment. All production access during this investigation was read-only, including Reef Skills.

Existing tenant and contact transaction locks, permission checks, optimistic revision checks, command idempotency and the empty function search path remain intact. Direct execution by public, anonymous and authenticated roles stays revoked; authenticated public wrappers remain the entry points. The only added query checks same-tenant, same-contact open opportunities using the existing customer/open-opportunity access pattern. No additional network request or list-wide scan is introduced.

Difficulty: 4/10. The key risk is assigning a payment to the wrong opportunity; the bounded legacy-only rule and duplicate-opportunity rejection address it. Actual multi-session PostgreSQL concurrency was not executed locally; existing transaction locks are retained and retries/stale requests are covered by executable database tests.

## Verification

- Reproduced the original server rejection before applying the new migration in an isolated synthetic PostgreSQL fixture.
- 14 UI and governance assertions/tests passed, including native required-field validation, new course selection, multiple courses, explicit general opportunities, wrong-course restrictions, migration without row changes, reuse of the original opportunity, batch/attendance transfer, pending payment status, audit, retry idempotency, tenant and owner isolation, stale edits, transaction rollback and existing-opportunity conflicts.
- 25 related followup, identity, attendance, history and task-lifecycle tests passed.
- Restoring the prior function was tested: successful payment data remains intact.
- Changed-file ESLint, TypeScript, migration verification and `git diff --check` passed.
- The project's default `npm run build` (Next.js Turbopack) passed. An exploratory Webpack build encounters the pre-existing global print selector in `accounting-workspace.module.css`; that unrelated file is unchanged.

## Release and rollback

After authorization, apply only this reviewed migration before deploying the UI. Recheck the live function baseline before replacement to avoid overwriting intervening work. Do not run a blanket migration push or a Reef data backfill. Smoke-check the deployed options without submitting a real payment on the user's behalf.

Rollback: restore the previous private function definition from `20260921125620_sales_identity_governance_v1.sql`, retaining its revoked direct-execution privileges, and revert the UI/API-error-map commit. Do not undo legitimate payments or course bindings created by employees after deployment. No table rollback is required.

## Publication authorization

The user explicitly requested production publication after reviewing PR #261. The exact production function baseline was rechecked and remains `f727b53f57d8df444b59350edf6911ee`. The followup browser workflow and academy concurrency workflow passed on fix commit `5c924951951fbfff1d5df08c0a0619620a74957c`. The release marker is `/releases/payment-course-options-20260922.json`; it identifies the source fix, not a claimed deployment time.
