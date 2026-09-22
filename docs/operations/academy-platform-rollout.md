# Academy platform rollout and rollback

This change is implemented for review. It does not authorize a production deployment or activate any tenant.

## Apply in order after release approval

1. Recheck schema drift against the approved commit, especially current CMS authorization, admission/payment guards and the legacy invitation activation function. Save prior function definitions and grants for reviewed rollback. Do not edit old migration files or execute a generated destructive down migration.
2. Require green Quality and academy concurrency checks. In an isolated staging environment, apply the three forward migrations in timestamp order: `20260922123824_academy_platform_separation.sql`, `20260922123859_academy_native_course_store.sql`, `20260922125855_academy_training_schedule.sql`. Confirm the new settings table has no activation seeded by migration.
3. Verify the trusted public Auth redirect origin and allowlist for `/academy/confirmed`, context-bearing `/reset-password`, and existing flows. Confirm real confirmation/recovery email delivery using synthetic test users. Do not create a production learner or staff account to test this change.
4. Exercise new-account and existing-account invitations, unconfirmed email denial, wrong-tenant denial, instructor assignment and removal, suspension, expired entitlement, password recovery and session refresh. An academy-only account must still fail every unrelated Odeir workspace/API check.
5. Configure the staging pilot explicitly from tenant controls. Test standalone mode with the old LMS entitlement and legacy journey settings disabled; complete a published short-course purchase, report transfer, verify payment, accept a learner invitation, study, submit an assessment and issue a certificate. Test the connected variant with separate learning/admissions/financial roles.
6. Verify the bank destination cannot be changed by a content author. Reconcile order, handoff, invoice, payment, allocation and enrollment counts and amounts. Test duplicate reference, network retry, final-seat concurrency, mismatched identity, stale offer, no content version, unclassified course and diploma rejection. No step should mint a second payment or overwrite an existing customer's owner.
7. Exercise session creation, stale update rejection, attendance preservation, explicit completion and cohort closure. Exercise defer/resume/transfer/withdraw, including two requests for the last seat. Verify original progress remains, transfer reuses money and withdrawal only marks a financial review.
8. Inspect the tenant-filtered query plans and snapshot payloads with representative volume. Page sizes are bounded; synthetic functional tests are not a production load benchmark. Review business calendars in the tenant timezone.
9. Deploy application code and migrations with the academy still disabled. Smoke-test existing Odeir, external WooCommerce import, existing CMS and licensed LMS routes. Compare pre/post Reef and subscription counts read-only; do not seed or normalize Reef data.
10. Activate only the verified Marktone tenant from the platform dialog with a reason, component selection, operating mode and existing entitlements or explicit trial expiry. Add named academy roles deliberately. Configure real bank/public course information only through authorized controls. No automatic invitation messages are sent by this change.

## Rollback

Disable the academy through the versioned tenant control command first. This closes new management/learner/store actions while retaining all academy settings, invitations, orders, canonical enrollments, financial records and history. Restore the prior application version if necessary; existing tenant navigation falls back to its licensed legacy paths.

Do not drop academy tables or delete canonical contacts, students, invoices, payments, sessions, certificates or learning progress. Disabling access does not cancel a paid obligation or refund money. Resolve paid orders manually through authorized financial operations.

If a replaced shared SQL function is the cause, compare the captured definition/grants with current dependencies and restore only the reviewed function in a forward fix. New storefront payment/transfer guard exceptions are narrowly tied to academy authority and explicit source lineage. Removing those helpers without assessing canonical records could block subsequent legitimate operations.

## Explicit release limits

- Only the existing Marktone pilot UUID/slug may be activated in this release. General tenant rollout needs its own reviewed change.
- Native checkout is short-course/full-bank-transfer only. Existing gateway credentials and paid add-on checkout are not reused for customer course payments.
- Existing catalog prices are the source of subscription pricing; these migrations do not change them.
- External WordPress/WooCommerce import remains the existing Odeir integration, independent of native academy activation.
- Local/UI fixtures and disposable PostgreSQL checks must be reported separately from authenticated staging evidence. A successful build is not proof of production mail delivery or staging compatibility.
