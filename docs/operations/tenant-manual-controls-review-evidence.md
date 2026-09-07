# Tenant manual controls — verified review evidence

Date: 7 September 2026. ODEIR only: Marktonesa/marktone-platform-control, odeir.com. Baseline main c03ae38640dfbf3b433be8314849d0ce4c134551. Application source saved as 284cb2457bb3127cf55900fc4f490b3505610972, followed only by removal of temporary review transport, the permanent browser workflow, and this evidence document.

## Exact code verification

GitHub Actions run 34122802309 / job 101744484917 applied the exact reviewed patch, SHA-256 55b1f2e6254a6779728083036ffd5e4ab847ef038fc8e5e17ef6be44a3cde52f.

- npm audit: zero reported package vulnerabilities.
- ESLint: zero errors, 18 pre-existing warnings outside the new implementation.
- TypeScript: passed.
- Automated tests: 953 passed, zero failed, zero skipped.
- Forward migration verification: 237 checked.
- Optimized Next.js build: passed.
- Actual Arabic browser verification: passed, using real management and deletion components, synthetic intercepted API responses, agent-browser 0.36.0 and Playwright 1.55.0.

The initial job's final source-push step failed because its Actions token cannot add the permanent workflow. This was not a code/test failure. A separate narrow source-save job committed only the 12 application/test/document/migration files, without changing workflow permissions or production. Permanent workflow creation and temporary-file removal were handled through the authorized GitHub connector. Final pull-request checks independently verify the resulting candidate.

## Browser artifact

Artifact 10019000158, tenant-controls-reviewed-evidence, ZIP SHA-256 01260d26b0d2f57212c2e932838846f9b15d29d73a8837acdffb16f5e4c3a213. Includes quality.log, dependency-audit.json, browser.json, agent-browser snapshot and five screenshots. Browser JSON reports: syntheticOnly=true, realTenantMutations=0, planChoices=5, confirmationBeforeWrite=true, suspendAndResume=true, typedDeletion=true, reefProtected=true, mobileOverflow=false, pageErrors=[]. Screenshots inspected visually.

## Controls and boundaries

/control/tenants -> إدارة المنشأة. The modal shows current plan/status/staff/expiry. It separates manual plan assignment, activation/suspension, and preview-first permanent deletion. Four public plans plus internal FULL, monthly/yearly terms, explicit before/after confirmation. Suspension preserves data and subscription dates; changing a plan does not reactivate a suspended tenant. Administrative assignment does not collect money. Existing users are not deleted when downgrading; normal seat limits restrict future additions. Existing add-on subscriptions are not changed.

Deletion is available only with the existing platform-owner deletion permission and still requires server preview, unexpired/current digest, a reason, typed حذف followed by the tenant slug, and explicit checkbox confirmation. Financial, integration, storage, support, AI-memory and unknown-dependency blockers remain. A narrow compatibility patch reviews only pricing-transition metadata and cleans it only after the canonical deletion checks. Reef remains protected.

## Publication status

NOT applied to production. NOT merged to main. No existing tenant was stopped, reactivated, reassigned, or deleted. No real payment or customer message was generated. New SQL procedures were tested using isolated PostgreSQL/PGlite with synthetic delegate fixtures; browser tests used intercepted synthetic responses. Neither constitutes an authenticated production transaction test. A production read-only deletion-preview invocation was blocked by the tool safety check and was not retried or bypassed. Release still requires approval, source-drift validation, forward migration application, application merge, and live verification without deleting customer data.
