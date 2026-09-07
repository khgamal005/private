# Core plan editor + tenant controls release

Scope: ODEIR only, repository Marktonesa/marktone-platform-control, production gswpbwdactcstkasddta, host odeir.com. User explicitly authorized publication after engineering review on 7 September 2026.

## Capability

/control/plans edits the four public core definitions: Arabic name/description, monthly and annual SAR amounts independently to two decimals, staff seats, display order and public sale availability. Annual ×10 is an optional suggestion, not a constraint on core plans. Add-on annual policy remains ×10, prices and entitlements are untouched. FULL is read-only/admin-only; the free edition cannot become paid or disappear from new registration. Unsupported customer/cohort/storage limits are not offered in the editor.

The editor requires billing permission and an authenticated session, bounded same-origin JSON, optimistic source fingerprint, explicit before/after confirmation, a reason, a row lock and an audit entry. It never takes arbitrary SQL, feature IDs or a tenant-scope override from the browser.

## Existing contracts

New private metadata snapshots the effective staff capacity of current core subscriptions, including the prior transition floor. Reef/FULL are excluded. New assignments capture the new catalog capacity atomically under the same advisory lock as catalog editing. Existing quoted prices and periods are not rewritten. The effective staff-limit resolver reads the immutable per-contract capacity; editing the offer never removes current staff or raises a current contract's limit implicitly. Assigning the new edition explicitly creates its new terms. The terms table already freezes the assigned monetary quote. Catalog revision history records before/after values and the reason.

Prices are administrative quotes; neither saving a definition nor assigning a plan charges a card or creates a financial payment. There is no new recurring debit or self-service core checkout in this release.

## Integration with PR226

Includes manual tenant plan/state controls and owner-only preview-first deletion as reviewed in tenant-manual-controls-v1.md. A new catalog edit participates in the tenant-action fingerprint so an older open review cannot silently select changed prices. New capacity metadata is a dependent ON DELETE CASCADE child of the core subscription, never a reason to bypass canonical deletion safety. No real customer deletion or suspension is a valid production test.

## Release sequence and rollback

Run local isolated PostgreSQL tests; final CI must pass lint, types, all regression tests, migration validation, build and dependency audit on the exact candidate. Run real Arabic components with wholly synthetic intercepted browser responses and visually inspect desktop/mobile/review screenshots. Verify the actual production source signatures/patch targets before applying the two pending migrations together. Assert unchanged existing tenant-scoped rows and protected Reef contract fingerprints inside a repeatable-read transaction. Do not invoke deletion or fabricate a production session.

Apply database compatibility first, then merge the exact tested head to main; verify live endpoint markers and session denial without tenant writes. A rollback can revert application controls, while retaining additive capacity snapshots/history and the old RPC compatibility. Do not remove frozen snapshots after edits begin, reset catalog values silently, or touch Reef to compensate for a UI issue. Existing data and financial orders must remain intact.

## Evidence to record

Record actual final check run IDs, head/merge SHA, migration versions, production assertions, browser artifacts, live endpoint status and any verification limitation in PR226. Green CI alone is not a successful hosting deployment. Synthetic UI and delegated SQL fixtures are not real-money or authenticated production transaction tests.
