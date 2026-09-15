# Service hub: release and verification

The tenant store now has service details/package comparison, an independent expert directory, quotation requests, approved fixed offers, and order updates. Public applicants use `/experts/join`; platform billing administrators review them at `/control/services`. Approval creates a **draft** provider. Publication is an explicit administrative action; private contacts never enter the tenant payload.

## Engineering boundaries

- Reuses `marketplace.service_providers`, products, packages and the canonical `marketplace.orders` ledger. An accepted quotation adds one existing-format order, item, brief and assignment; no parallel payments ledger.
- New tenant requests/events/updates use tenant foreign keys, indexes, RLS and permission-checked RPCs. Anonymous access is limited to application submission and a boolean registration-availability RPC. New tables are not directly accessible to API roles.
- Application bodies and text fields are bounded; duplicate emails return the same receipt without overwriting a prior request. A database-backed global quota caps anonymous writes at 100/hour; tenant quote creation is capped at 20/hour. Public submission does not create a login or grant permissions.
- Offers are versioned and locked at acceptance. Repeat acceptance returns the same order. The server controls the approved amount, tax and currency; subsequent catalog changes cannot alter it. Changing payment method/discounts/items on accepted quotation orders is deliberately disallowed. Users may cancel an unpaid order through the existing guarded path and request a new offer.
- The Paymob patch changes only the fixed-package requirement to recognize authoritative accepted quotation snapshots. Existing readiness, tenant eligibility, payment-attempt, reconciliation and signature checks remain. The migration aborts if the expected function contracts have changed.
- Tamara capture and delivery rules are unchanged. Accepting an offer creates a pending order; it does not initiate or confirm a charge.
- No backfill, customer-data mutation, automatic provider publication, Reef fixture, production purchase, or email transmission is part of this release.

## Deployment sequence

1. Require green full-repository `npm run check` and explicit authorization to deploy this feature. Run integration checks against a disposable staging tenant and sandbox providers before production activation. Do not use Reef records.
2. Apply `20260915200707_service_hub_quotes_and_expert_applications_v1.sql` through the normal migration pipeline. The feature starts disabled. No old migration is edited.
3. Deploy the reviewed application commit. Both existing marketplace loaders tolerate the new optional snapshot being absent/unavailable. Existing service orders remain accessible. The public application form displays an unavailable state while registration is disabled.
4. Check RPC presence, grants, RLS and the release flag, then enable after the staging scenarios below pass:

```sql
select to_regprocedure('public.v1_service_hub_snapshot(text,integer)'),
       to_regprocedure('public.v1_public_expert_application(jsonb)'),
       to_regprocedure('public.v1_public_expert_registration_status()');
select enabled from marketplace.service_hub_settings;
select status,count(*) from marketplace.service_requests group by status;
select status,count(*) from marketplace.expert_applications group by status;
-- Activation is a separate, explicitly authorized release step:
update marketplace.service_hub_settings set enabled=true where singleton;
```

5. Publish each approved expert after checking the existing provider profile. Active providers already attached to a published service retain directory visibility unless explicitly hidden. Zero-service providers become visible after the new publication action. This action controls the directory; hiding a provider's existing services still uses the existing service/catalog controls.

## Verification

Automated tests execute the new migration in PGlite against schema-only captures of the current tables and payment RPCs. Fixtures stub identities/eligibility and contain no customer records or credentials. They cover the disabled flag, anonymous/private permissions, duplicate applications, draft approval, independent publication, contact privacy, tenant isolation, offer versions, repeated acceptance, immutable amounts/items, expired offers, unavailable methods, note isolation/idempotency, and retention of the Paymob verified-receipt guard. These do not substitute for an actual provider sandbox checkout.

UI integration tests render both complete service screens and exercise public application errors/retry, zero-service expert discovery, quotation submission, offer acceptance, the three-step service editor, and API origin/body/authentication boundaries. Existing professional-marketplace and Tamara database/payment-picker regressions are included in the release check. Browser verification is still a release gate: the cloud browser blocks local preview URLs and the Vercel preview requires sign-in. Supabase's automatic preview branch also reached its configured concurrent-branch limit. No provider sandbox checkout or full browser flow is claimed by the local tests.

Staging acceptance: public application -> admin approval -> draft profile activation/publication -> two tenants discover the expert without contacts -> tenant A request -> admin offer -> tenant B denied access -> tenant A accepts once -> continue the same bank/Paymob/Tamara order -> assignment/update -> delivery -> eligible review. Confirm a Tamara service cannot be captured before actual confirmed delivery. Review query plans with representative directory/queue sizes, and check phone/tablet/desktop layouts and keyboard dialog navigation.

A local synthetic sizing check with 1,000 published experts and 5,000 tenant requests returned 30 experts and 30 requests in a 25,107-byte payload (73 ms in PGlite). The tenant queue used `service_requests_tenant_idx` with incremental sorting. This is a local sizing observation, not a production latency guarantee.

## Rollback

Disable new submissions/discovery first:

```sql
update marketplace.service_hub_settings set enabled=false where singleton;
```

Keep accepted quotation records, order guards and the amended Paymob snapshot check while any associated orders remain payable or unsettled. Existing payment continuation remains available through the canonical store. Do not drop the new tables or revert the quotation-aware payment function while such orders exist. Frontend-only rollback must preserve quote order payment/discount restrictions. This release has no destructive down migration.
