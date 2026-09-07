# ODEIR pricing landing — engineering gate

Scope: `odeir.com/pricing`, `Marktonesa/marktone-platform-control`, based on upstream `ce03da40e55b58e77f2f6dcebdeb16985dcb482e`. This is the ODEIR public website on Hostinger. No Marktone CRM changes.

## Decision and design

Approved implementation scope is a presentation redesign. Reuse the homepage's navy, teal and yellow tokens, shared header/footer, typography and existing signup/login paths. Lead with operational partnership, concise checked benefits, understandable core editions, categorized independent add-ons and progressively disclosed commercial explanations. No fabricated testimonials, popularity figures, discount timers or guaranteed business outcomes.

The advisor recommends the cheapest published offer that fits the entered number of users, including the owner, for the selected billing period. It uses the public catalog supplied by the server; it never modifies a subscription. Annual pricing remains independently editable and is displayed as the full prepaid 12-month total. Savings appear only when the actual annual offer is lower than twelve actual monthly offers. Invalid or over-capacity input gives a clear message without an invented plan.

## Existing flow and invariants

`app/pricing/page.js` → `getPublicCommercialCatalog()` → `v1_public_independent_commercial_catalog` → published independent commercial catalog entries → public client component. The existing public-safe catalog boundary is unchanged. No production schema dependency, API, RPC, migration, credential, permission, RLS, notification, payment provider or checkout logic changes.

The public catalog remains authoritative for plan names, descriptions, capacities and both prices. Existing public filtering retains the administration-only FULL contract outside this page. No tenant records, subscriptions, pricing configuration or Reef data are written or used as fixtures. Registration and authenticated purchase continue through the existing routes. Add-on provider fees remain disclosed separately. The unknown-key fallback keeps future additions visible under All.

## Risk and verification

Difficulty: 3/10; principal risks are incorrect price/capacity presentation, legacy global CSS collisions, mobile layout and customer interpretation. Scoped CSS, actual catalog-derived calculations, explicit owner inclusion and existing public pricing CI address those risks.

The new rendered-component test covers free/signup routing, admin-edited names and capacities, fractional currency values, annual price inversion, non-discount annual pricing, invalid/over-capacity input, add-on filtering, future keys and catalog immutability. The repository Quality workflow and existing pricing UI workflow remain the release gates, including hidden public FULL, annual amounts, mobile overflow, header geometry and unchanged synthetic checkout totals.

Rollback is a revert of these public presentation files and metadata; there is no data rollback. Production publication is a separate user decision. No deployment or real purchase is performed by this implementation branch.
