# Registration directory search release

This directory contains a reviewed revision of the existing `marktone-free-trial`
Edge Function, captured from live version 3 on 2026-09-17. Its sole deployment
target is **Marktone Projects / `jultamrxwrgzohoktbgr`**. ODEIR already uses this
public, masked CRM institution directory for registration search/details.

It is deliberately outside `supabase/functions` to avoid deploying it into the
ODEIR tenant database (`gswpbwdactcstkasddta`). Do not change its target, environment,
JWT setting, submission workflow, or database grants as part of this fix.

## After explicit production publication approval

1. Re-read the live `marktone-free-trial` function. If version 3 has changed, rebase
   the lookup patch against the new source before publishing.
2. Keep a rollback copy of that live source and settings.
3. Deploy only `marktone-free-trial/index.ts` as function `marktone-free-trial`
   on project `jultamrxwrgzohoktbgr`, entrypoint `index.ts`, preserving the existing
   `verify_jwt=false` setting. It is an existing public endpoint with unchanged
   rate limits, organization scope, and masked contact fields.
4. Verify live search using `القدرات التدريبية`, `اثر القدرات`, Arabic digits,
   an absent name, and the read-only institution details action. Do not submit
   a registration or modify CRM/tenant records during validation.
5. Publish the ODEIR UI commit through the usual approved main/Hostinger release.
   The Edge fix and UI change are compatible with both old and new counterparts.

Rollback: restore the saved Edge source with the same settings and revert the UI
commit. There is no migration, data backfill, tenant toggle, or record rewrite.
