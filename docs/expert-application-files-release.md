# Expert application files

The application now offers searchable, multi-select specialties and presentation languages (up to ten each), optional PDF CVs (5 MiB), and JPEG/PNG/WebP portraits (2 MiB). CVs are available only to platform users with `platform.billing.manage`. Portraits become visible when an approved application's provider is active and published. No existing applicants, tenants, orders, payments or Reef records are backfilled.

## Data and security

- Existing JSON intake remains compatible, including its generic response for duplicate emails. A private helper returns an application ID only when its insert succeeds; a duplicate email can never claim an earlier applicant's attachments.
- Multipart requests have bounded streamed bodies, explicit allowlists, signature checks, consent validation, and an idempotency key. The main site normalizes portraits, limits decoding to 16 million pixels, strips metadata and bounds dimensions. Display endpoints re-encode images and send `no-store`; PDF downloads use attachment disposition, `nosniff` and a sandbox CSP. Signature validation does not constitute malware scanning.
- Files use the private `expert-application-files` bucket. Direct client writes are denied. SELECT policies expose CVs only to billing administrators; an approved, published portrait is public. Unpublishing revokes portrait access, without a signed URL lifetime or CDN caching delay.
- The Edge function validates the project's public API key. Its service credential comes from the Edge environment, never Next.js or the browser. Reserve, finalize and cleanup RPCs are executable only by `service_role`. Private tables have RLS and no API grants. They are platform-level intake records, matching the existing platform expert applications, not tenant records.
- Reservations are immutable and bounded to 20 new sessions/hour and 200/day. Retries reuse verified stored bytes. Finalization and file association commit atomically. Ambiguous failures never delete potentially committed attachments.
- Expired uncommitted/duplicate reservations are cleaned through the Storage API in background work after a successful intake, ten at a time. No storage metadata is directly deleted in SQL. Cleanup is opportunistic: when intake is idle, expired files remain private until the next success or an operator runs cleanup. Completed files are never selected. The `cleaned` acknowledgement scrubs abandoned payloads; timestamps remain for quota accounting.

## Release order

1. Review and merge only after publication authorization and green quality checks. Do not point a preview at production for write tests.
2. Apply `20260917203359_expert_application_files_v1.sql` to the intended database. It creates the bucket, private tables, permission-scoped RPCs and policies, preserving legacy JSON behavior. `expert_uploads_enabled` starts false.
3. Deploy `expert-application-upload` with its two shared `.mjs` dependencies. `supabase/config.toml` sets `verify_jwt=false` because the handler checks project publishable keys itself. Verify `SUPABASE_PUBLISHABLE_KEYS` (or the legacy anon key) matches the site's configured key; ensure the Edge runtime exposes a server secret (`SUPABASE_SECRET_KEYS` or legacy service-role key). Never put that secret in the client or Next public environment.
4. Deploy the reviewed Next.js revision, including the explicitly pinned `sharp` dependency. Confirm `/experts/join` loads; it tolerates a pre-migration status response and keeps upload inputs disabled until activation.
5. On an isolated staging applicant, verify CV/photo upload, retry, admin review/download, approval, publication, tenant directory portrait and revocation after unpublishing. Verify unauthorized users cannot read the CV, including direct Storage requests. Run Supabase security/performance advisors after the migration.
6. After the same release is verified in production and activation is authorized: `update marketplace.service_hub_settings set expert_uploads_enabled=true where singleton;`. Confirm `/experts/join` reports uploads available. Do not use a real customer applicant or Reef tenant as a test fixture.

## Rollback

Set `expert_uploads_enabled=false` immediately to stop new reservations and finalization while preserving the legacy JSON form. The form reloads with attachments disabled and the optional portfolio link available. Completed CVs and published portraits remain accessible to their authorized audiences. If needed, restore the prior Next.js revision and disable the new Edge function. Retain additive tables and stored objects so existing applicants' files are not lost. Do not delete the bucket or rewrite reviewed applications as part of rollback.

## Verification

Behavioral tests cover dropdown selections and retry retention; streamed limits/types/signatures; origin and key checks; byte-verifying retries after uncertain finalization; quota and incomplete-upload failures; duplicate-email ownership; private-table/RPC permissions; CV versus published-photo access and revocation; expired cleanup; admin download headers and normalized portrait output. Existing Service Hub database/UI tests run alongside these cases to protect catalog, quote and payment behavior.

The key handling follows Supabase's [API key migration guidance](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys): modern secret keys are sent only in `apikey`; legacy JWT service-role keys also use Bearer authentication.
