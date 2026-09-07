# ODEIR commerce release — evidence, 7 September 2026

User authorized a hidden administration-only FULL contract, Reef unchanged, every other currently existing tenant on BASIC, future public signups on FREE, and simple staff-only core differentiation. All previous add-on prices/independence remain unchanged.

Validated source before final cleanup: c6ee58b9a51e5c065fe2f9bccbf6500b3f9eb0dc. GitHub final pricing verification run 34116343631 passed 935 tests, TypeScript, ESLint (pre-existing warnings), 236 migration checks, optimized build and synthetic-data browser tests. Dependency audit reported zero known vulnerabilities. Browser verifies four public editions, hidden public FULL, visible administrative FULL, monthly/yearly checkout amounts and taxes, no horizontal mobile overflow and no browser errors. Human screenshot review led to composing shared/edition CSS classes on admin cards; the permanent pricing UI workflow verifies the final candidate again.

Production compatibility preview: connected Supabase project gswpbwdactcstkasddta, a single REPEATABLE READ transaction, actual M1 plus corrected M2, full rollback. Result: previewCompleted=true, rolledBack=true, catalogAbsent=true, reefFull=full. The GitHub runner had no production credential; its failed preview step made no database call. The connected Supabase preview supersedes that environmental failure.

Before/after assertions inside the same production transaction verified the Reef tenant record, FULL row/features/limits, core and add-on subscriptions, modules, overrides and effective add-on rights. In addition, every existing table with UUID tenant_id was checked for identical Reef row counts and sorted row digests. No customer rows or credentials were exported.

The preview transitioned exactly the current non-Reef cohort (modaar-training-center, marktone, test). It retained their subscription IDs and periods, preserved previous effective rights, and preserved Marktone's seven existing staff seats. Transition is not a charge or new payment: zero quoted transition consideration and no orders or payment attempts. No new lifetime or monthly customer/cohort/storage limit was imposed.

Release must still be applied and checked, then the exact application candidate merged and verified live. A green gate and a rollback preview do not mean published. Keep all existing payment-provider configurations and hidden add-on readiness states unchanged. No new self-service core-edition payment or recurring debit is claimed.
