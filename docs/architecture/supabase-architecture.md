# Supabase Architecture

How the database, edge functions, and application client fit together in Marktone
Platform Control, and the rules that govern every read and write.

This document explains the Supabase layer. For the Next.js application around it,
see [`../ARCHITECTURE.md`](../ARCHITECTURE.md). For the original design intent of the
v2 foundation, see [`clean-foundation-v2.md`](clean-foundation-v2.md).

---

## 1. The short version

One Next.js application. One Supabase project. Two workspaces: `/control` for Marktone
platform staff, and `/tenant/[slug]` for each customer organisation.

Everything else follows from one rule:

> **No table is ever read or written directly by the application. Every operation goes
> through an authenticated RPC that checks the caller's permission and the tenant scope
> first.**

Out of 365 tables, exactly **8** are directly reachable with a client key. The other 357
are reachable only through the ~600 functions in the `public` schema, each of which
re-derives the caller's identity from the JWT and re-checks authorisation inside the
database. A bug in application code cannot widen this, because the database does not
trust the application.

### Shape at a glance

```
┌──────────────────────────────────────────────────────────────────┐
│  Next.js 16 on Vercel                                           │
│                                                                  │
│  Server Components ──► lib/server-auth.js ──► authRpc(name, {})  │
│  Route Handlers   ──► fetch(/rest/v1/rpc/...)                    │
└───────────────┬──────────────────────────────┬───────────────────┘
                │ publishable key + caller JWT │ service key (rare)
                ▼                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Supabase                                                        │
│                                                                  │
│   PostgREST ──► public.v2_tenant_workspace_snapshot(...)        │
│                     │  SECURITY DEFINER                          │
│                     │  set search_path = ''                      │
│                     ├── auth.uid()          → who is calling     │
│                     ├── permission check    → may they do this   │
│                     └── tenant_id scope     → whose data         │
│                              │                                   │
│                              ▼                                   │
│                    core / academy / sales_core / …               │
│                                                                  │
│   private_app.*  454 internal functions, no client grants        │
│   pg_cron        15 jobs, SQL-only or HTTP to Edge Functions     │
│   Vault          provider credentials + dispatcher secrets       │
│   Storage        6 buckets, ticket-gated uploads                │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. The tenancy spine

This is the single most important structural fact. Two tables carry the entire
multi-tenant model:

| Table | Inbound FKs | Answers |
|---|---:|---|
| `core.tenants` | 227 | **Which customer** does this row belong to? |
| `access_control.subjects` | 238 | **Which human** performed this action? |

No other table in the system comes close. The next most-referenced table has 26
inbound references.

Every domain table carries both:

```sql
create table sales_core.lead_status_history (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references core.tenants(id) on delete cascade,
  contact_id            uuid not null references sales_core.contacts(id) on delete cascade,
  changed_by_subject_id uuid      references access_control.subjects(id) on delete set null,
  from_status           text,
  to_status             text not null,
  reason                text,
  changed_at            timestamptz not null default now()
);
```

265 of 365 tables declare a `tenant_id` column. 171 declare some `*_subject_id`.

**The two-column pattern is a standing audit trail.** `tenant_id` is the security
boundary; `*_subject_id` is accountability. Deletion semantics tell you which is which:
`tenant_id` is almost always `on delete cascade` (the row belongs to the customer, it
dies with them), while `*_subject_id` is `on delete set null` (a person may leave, but the
record of what they did must survive).

The 100 tables without a `tenant_id` are deliberate. They are the global spine —
`core.organizations`, `access_control.submissions`, `catalog.plans`, `catalog.features`,
`audit_log.events` — things that must exist before a tenant does.

### Why this matters when you write a feature

You almost never write tenancy logic. You resolve the tenant once, in the RPC, and every
query inherits it. To trace any record:

```
auth.uid()
  → access_control.memberships        (which tenants can this subject see?)
  → core.tenants.id                   (the tenant_id you filter by)
  → domain table
  → *_subject_id                      (who touched it)
```

---

## 3. Schema map

24 schemas. Grouped by what they are for rather than alphabetically.

### Platform spine

| Schema | Tables | Role |
|---|---:|---|
| `core` | 24 | Organisations, tenants, branches, domains, modules, integrations, support desk, Odeiry AI state |
| `access_control` | 9 | Subjects, memberships, roles, permissions, invitations, account activation |
| `people` | 6 | Staff profiles, departments, absences, work shifts |
| `catalog` | 26 | Plans, features, subscriptions, addons, limits, price versions |
| `audit_log` | 2 | Operational audit events |

### Commercial

| Schema | Tables | Role |
|---|---:|---|
| `marketplace` | 46 | Addon orders, payment attempts, Paymob/Tamara credentials, refunds, service hub |
| `sales_core` | 21 | CRM: contacts, activities, opportunities, pipeline stages, lead import |
| `accounting_core` | 18 | Customer accounts, sales documents, payments, allocations, receipts, refunds |
| `accounting_zatca` | 2 | Saudi e-invoicing (ZATCA) addon |
| `incentives_core` | 3 | Goals and incentives plans, assignments, events |
| `commerce_hub` | 5 | Multi-store commerce (Salla, Zid, Shopify) |
| `commerce_sync` | 3 | Store product/order sync checkpoints |

### Delivery

| Schema | Tables | Role |
|---|---:|---|
| `academy` | 63 | Courses, runs, sessions, students, enrollments, diplomas, training journey, store |
| `zoom_core` | 32 | Zoom connections, instances, hosts, meetings, recordings, webinars, reports |
| `work_core` | 3 | Unified tasks and task history |
| `automation_engine` | 3 | Automation rules, runs, events |

### Channels

| Schema | Tables | Role |
|---|---:|---|
| `website` | 15 | Sites, pages, content documents, menus, articles, template packages |
| `marketing_hub` | 15 | Providers, connections, ad accounts, campaigns, ads, attribution |
| `google_ads` | 16 | Google Ads accounts, GA4 properties, daily metrics, sync runs |
| `meta_connect_v2` | 7 | Meta OAuth connections, callback events, deletion requests |
| `communication_hub` | 7 | Message providers, connections, outbox, delivery webhooks |
| `telephony` | 2 | Yeastar P550 CDR sync |

### Internal and platform

| Schema | Objects | Role |
|---|---:|---|
| `private_app` | 1 table, 454 functions | **All real business logic.** No client grants — called only by `public.*` RPCs |
| `platform` | 29 tables | Public registration requests, notification centre, support config |
| `public` | 7 tables | Public knowledge base (categories, posts, sources) and ingestion tables |

> **Naming collision to watch for.** `platform` is *both* a permission namespace
> (`platform.billing.manage`, `platform.tenants.manage`) *and* a schema
> (`platform.registration_requests`). The permission keys came first, in
> `20260726210000_clean_platform_foundation_v2.sql`. The schema was created later, in
> `20260801005000_knowledge_content_foundation_v1.sql`. They are unrelated namespaces that
> happen to share a name.

---

## 4. How a request reaches the database

### The application never uses the Supabase SDK

`@supabase/supabase-js` is not a dependency. The app talks to PostgREST over raw `fetch`
through one helper — `lib/server-auth.js`:

```js
// lib/server-auth.js
export async function authRpc(name, body = {}, options = {}) {
  const token = await accessToken();                       // mt_access cookie
  if (!token) redirect('/login');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,                                 // publishable key
      authorization: `Bearer ${token}`,                    // the caller's JWT
      'content-type': 'application/json',
      cache: 'no-store',
    },
    body: JSON.stringify(body),
    signal: rpcSignal(options.timeoutMs),
  });
  if (response.status === 401) redirect('/login?reason=session');
  if (response.status === 403) redirect('/login?reason=forbidden');
  return response.json();
}
```

Two things are deliberate here.

**The publishable key is not a privilege.** It only identifies the project. The
`Authorization: Bearer` header carries the caller's real JWT, so PostgREST sets
`auth.uid()` from it and the database sees the genuine role. The application could not
escalate by using the publishable key, because the key grants nothing on its own.

**The service key is used sparingly.** It appears in `lib/admin-config.js` and
`lib/odeiry-service-rpc.js` only, for the few operations that genuinely have no
end-user actor. Both handle the modern `sb_secret_…` key format, which authenticates via
the `apikey` header alone, and fall back to a bearer header only for legacy JWT service
keys.

### Session contract

| Cookie | Purpose |
|---|---|
| `mt_access` | Supabase access JWT, `httpOnly`, `secure`, `sameSite=lax` |
| `mt_refresh` | Refresh token; rotated by `proxy.js` middleware before expiry |

`getContext()` wraps `v2_current_user_context` in React `cache()`, so permissions are
fetched once per request even when many components read them.

### The five authorization helpers

| Helper | Fails with |
|---|---|
| `accessToken()` | — |
| `authRpc(name, body)` | redirect to `/login?reason=session` on 401 |
| `getContext()` | — |
| `requirePlatform()` | redirect if the subject has no platform access |
| `requirePlatformPermission(perm)` | redirect if the platform permission is missing |
| `requireTenant(slug)` | redirect if the subject is not a member of the tenant |
| `requireTenantPermission(slug, perm)` | redirect if the tenant permission is missing |
| `requireTenantAddon(slug, keys)` | redirect if the addon is not enabled on the plan |

These are checks in application code. The real enforcement is the RPC.

---

## 5. The security model

### Deny by default, in numbers

| Control | Count | What it means |
|---|---:|---|
| `revoke all … from public` | 387 | Default privileges removed, not merely unused |
| `security definer` functions | 1231 | Privileged functions that do not need table grants |
| `set search_path` pinned | 1442 | No search-path hijacking through untrusted schemas |
| RLS enabled | 272 of 365 tables | Defence in depth where direct access could exist |
| `create policy` | 119 | Documented tenant boundaries |
| `grant execute on function` → `authenticated` | 375 | The entire authenticated API surface |
| `grant execute on function` → `service_role` | 186 | Narrow, individually named |

### The complete direct table surface

This is the whole list of tables a client key can touch without going through an RPC:

| Table | Audience | Gate |
|---|---|---|
| `public.knowledge_categories` | `anon`, `authenticated` | RLS: `is_active` |
| `public.knowledge_posts` | `anon`, `authenticated` | RLS: published and within date window |
| `catalog.independent_commercial_catalog_v1` | `anon`, `authenticated` | RLS: `published` |
| `public.knowledge_sources` | `authenticated` | RLS: `platform.is_platform_content_admin()` |
| `public.knowledge_ingestion_runs` | `authenticated`, `service_role` | — |
| `public.knowledge_raw_items` | `authenticated`, `service_role` | — |
| `public.knowledge_bookmarks` | `authenticated`, `service_role` | — |
| `public.knowledge_read_events` | `authenticated` (insert only) | — |

**8 of 365 tables.** The public knowledge base is the single exception, and it is public
content by design. Everything else — every tenant record, every payment, every academy
record — requires an RPC.

Note the shape of the two defences. `revoke` removes the privilege; RLS constrains it if
the privilege is ever re-granted. The 93 tables without RLS are not exposed by omission —
they have no grants either, so they are unreachable either way.

### The `anon` function surface

Also fully enumerable. These are the only functions `anon` may execute:

| Function | Purpose |
|---|---|
| `v2_public_site_snapshot` | Public website content |
| `v3_cms_public_snapshot` | Public CMS pages |
| `v1_public_independent_commercial_catalog` | Public price list |
| `v1_public_expert_application` / `v1_public_expert_registration_status` | Expert application form |
| `v1_public_expert_photo`, `private_app.expert_file_readable` | Public expert media |
| `v2_platform_invitation_preview` | Platform invitation pre-check |
| `v1_invitation_activation_preflight` | Tenant invitation pre-check |
| `v1_academy_invitation_preview` / `v1_academy_learning_invitation_preview` | Academy invitation pre-checks |
| `v1_academy_public_navigation` | Public academy nav |
| `v1_academy_storefront` / `v1_academy_store_order` | Public course storefront |
| `v1_zoom_invitation_preview` | Zoom session invitation pre-check |
| `private_app.academy_media_allowed_v1` | Media access predicate |
| `v4_yeastar_gateway_claim` | Short-lived gateway grant claim |

Every one is either read-only public content, a token pre-check that performs no write,
or a predicate function.

### Permissions

Permissions are strings, not roles, resolved through three tables:

```
access_control.permissions  (permission_key, module_key)
access_control.roles        (tenant_id nullable, scope = 'platform' | 'tenant')
access_control.role_permissions
access_control.memberships  (subject_id, tenant_id, scope)
access_control.membership_roles
```

A role with `tenant_id = null` and `scope = 'platform'` is a Marktone staff role. One with
a `tenant_id` is a customer role.

**Platform permissions** — `platform.control.read`, `platform.control.write`,
`platform.tenants.read`, `platform.tenants.manage`, `platform.tenants.delete`,
`platform.billing.manage`, `platform.access.manage`, `platform.website.manage`,
`platform.content.manage`, `platform.settings.manage`, `platform.audit.read`,
`platform.support.read`, `platform.support.reply`, `platform.support.manage`.

Six platform roles are seeded as system roles: `platform_owner` (all permissions),
`platform_tenants_manager`, `platform_billing_manager`, `platform_content_manager`,
`platform_access_manager`, `platform_website_manager`, `platform_operations_manager`.

**Tenant permissions** are namespaced by domain, roughly 45 in total:
`tenant.workspace.read`, `tenant.settings.manage`, `tenant.crm.read`, `tenant.crm.write`,
`tenant.leads.read`, `tenant.leads.distribute`, `tenant.leads.reassign`,
`tenant.leads.import`, `tenant.leads.analytics`, `tenant.admissions.read`,
`tenant.admissions.write`, `tenant.academy.read`, `tenant.academy.write`,
`tenant.accounting.read`, `tenant.accounting.payments.approve`,
`tenant.accounting.invoices.write`, `tenant.accounting.settings.manage`,
`tenant.accounting.reports.read`, `tenant.people.read`, `tenant.people.manage`,
`tenant.users.manage`, `tenant.users.reset_password`, `tenant.work.read`,
`tenant.work.write`, `tenant.content.read`, `tenant.website.publish`,
`tenant.marketing.manage`, `tenant.integrations.manage`, `tenant.meta_connect.manage`,
`tenant.incentives.read`, `tenant.reports.analytics`, `tenant.support.create`.

### Vault

170 Vault references. Provider credentials, API keys, and cron dispatcher secrets all
live in `vault.secrets`, never in environment variables and never in a table column.
Edge functions read them through service-role RPCs that return only what the caller's
permission allows — `payment-provider-admin` explicitly keeps `PUBLIC_CONFIG_KEYS` and
the secret sets disjoint so a public-config projection can never leak a credential.

---

## 6. Edge Functions

28 functions plus 17 shared modules in `supabase/functions/_shared/`. All are Deno
entrypoints invoked over HTTPS. `verify_jwt` in `supabase/config.toml` decides whether
Supabase rejects a request before the function runs.

### Three authentication patterns

The reason for each pattern is different, and that is the point.

**A. Gateway-verified JWT — 5 functions.**
`tenant-staff-password-reset`, `payment-provider-admin`, `paymob-checkout`,
`paymob-reconcile`, `odeir-registration-manual-activation`. Supabase validates the
signature before the function starts. The function *still* re-authorises through a
caller-scoped RPC, because a valid JWT only proves identity, not permission.

**B. Self-validated JWT — `verify_jwt = false` with an internal check.**
`tamara-checkout`, `tenant-staff-account`, `google-ads-connect`, `meta-oauth-v2`. The
gateway cannot verify these tokens (asymmetric ES256, non-Supabase issuers, or browser
origins), so the function resolves the session itself:

```ts
// _shared/tamara-edge.ts
async function authenticatedUser(token: string) {
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) { await response.body?.cancel(); return false; }
  const user = await boundedJson(response, 32768, 10000);
  return UUID.test(user?.id || '');
}
```

The alternative — forward the token to PostgREST with the anon key — is the more common
shape and is what `paymob-checkout` does.

**C. No JWT at all — the credential is something else.**
This is where most functions live, and each sub-pattern exists for a specific reason:

| Sub-pattern | Functions | Why no JWT is possible |
|---|---|---|
| Signed webhook | `paymob-webhook`, `tamara-webhook`, `marketplace-payment-webhook`, `meta-oauth-v2` (compliance), `zoom-connect` (`/webhook`), `training-automation-dispatch` (delivery), `odeir-registration-intake` (Resend) | The external provider signs with its own key and cannot issue Supabase JWTs |
| Cron dispatcher secret | `ads-sync`, `commerce-sync`, `knowledge-ingest`, `woocommerce-sync`, `yeastar-sync`, `training-automation-dispatch`, `tamara-reconcile`, `support-attachment-cleanup`, `zoom-connect` (`/dispatch`) | pg_cron holds a Vault secret, not a user session |
| One-time invitation token | `tenant-invitation-activation`, `platform-invitation-activation`, `training-invitation-activation` | The user has no account yet — the token *is* the credential |
| Public ingress | `odeir-registration-intake`, `expert-application-upload` | Anonymous visitors; guarded by rate limits and validation |

The strongest variation is the cron pattern, because the secret is verified *in the
database*, not in the Edge function. The function forwards the secret to an RPC and
receives only a boolean:

```sql
headers := jsonb_build_object(
  'x-marktone-woocommerce-secret',
  (select decrypted_secret from vault.decrypted_secrets where name = 'woocommerce_dispatch_secret')
);
```

Because only a boolean crosses the boundary, the Edge runtime never holds the real secret
long enough to leak it. Only `support-attachment-cleanup` and `zoom-connect` compare
secrets locally, both with constant-time comparison.

Webhook verification is equally explicit. `paymob-webhook` requires exactly one `hmac`
parameter of exactly 128 hex characters, verifies HMAC-SHA512 against up to two candidate
credential versions read from Vault, and rejects the request if more than one matches:

```ts
const results = await Promise.all(runtime.hmacCandidates.map(c =>
  verifyPaymobTransactionHmac(payload.obj, suppliedHmac[0], c.hmacSecret)));
// The signed account identifiers must select exactly one cryptographically
// valid credential version; ambiguity is rejected.
```

### Service role discipline

The recurring pattern is *caller-scoped RPC authorises, then service role acts*:

```ts
// paymob-checkout — step 1: the caller's own JWT, so the DB sees the real role
const prepared = await postRpc(supabaseUrl, anonKey, authorization,
  'v2_tenant_paymob_prepare_checkout', { p_slug, p_order_id, p_idempotency_key });

// step 2: only now, with the service key, to reach Paymob credentials
const runtime = await postRpc(supabaseUrl, serviceRoleKey, null,
  'v1_service_paymob_runtime_config',
  { p_attempt_id: prepared.attemptId, p_purpose: 'create_intention' });
if (runtime.createAllowed !== true) { /* resume, never create a second intention */ }
```

The first call enforces tenant, permission, order ownership, and idempotency. The second
is a narrow, purpose-tagged, atomic claim. If the first is bypassed, the second returns
`createAllowed !== true` and nothing is created.

The same shape appears in `ads-sync` → `v2_marketing_hub_authorize` then service config
reads, `commerce-sync` → `v2_commerce_hub_authorize`, `tenant-staff-account` →
`v1_tenant_prepare_staff_account` then `POST /auth/v1/admin/users`, `google-ads-connect`
→ `v1_tenant_google_ads_*` versus `v1_service_google_ads_*`, and `yeastar-sync` →
`v3_tenant_yeastar_authorize`.

### Scheduled work

15 distinct pg_cron jobs. Four run pure SQL with no network hop:

| Job | Cadence | Action |
|---|---|---|
| `odeir-paymob-runtime-v2` | `* * * * *` | `private_app.paymob_reconciliation_tick_v2(10)` |
| `admission-governance-v1` | `* * * * *` | `private_app.process_admission_governance_queue_v1(100)` |
| `odeir-marktone-training-journey` | `*/5 * * * *` | `private_app.training_journey_sweep_v1()` |
| `diploma-collections-v1` | `*/5 * * * *` | `private_app.diploma_collections_tick_v1(100)` |

The rest dispatch over HTTP via `net.http_post`:

| Job | Cadence | Target | Vault secret |
|---|---|---|---|
| `marktone-marketing-sync` | `*/5 * * * *` | `ads-sync` | `marketing_dispatch_secret` |
| `marktone-training-automation-dispatch` | `*/5 * * * *` | `training-automation-dispatch` | `training_automation_secret` |
| `marktone-woocommerce-sync` | `*/5 * * * *` | `woocommerce-sync` | `woocommerce_dispatch_secret` |
| `marktone-yeastar-cdr-sync` | `*/15 * * * *` | `yeastar-sync` | `yeastar_dispatch_secret` |
| `marktone-knowledge-ingestion` | `*/15 * * * *` | `knowledge-ingest` | `knowledge_ingestion_secret` |
| `odeir-tamara-runtime-v1` | `* * * * *` | `tamara-reconcile` | `odeir_tamara_worker_v1` |
| `odeir-registration-email-outbox-v1` | `* * * * *` | `odeir-registration-intake` | worker token |
| `odeir-support-attachment-cleanup-v1` | `*/15 * * * *` | `support-attachment-cleanup` | `cleanup_secret_vault_id` |
| `marketplace-promotion-reservation-cleanup-v1` | `*/5 * * * *` | SQL | — |
| `odeir-notification-operational-probe` | `*/5 * * * *` | SQL | — |

Cron jobs are scheduled with a URL pinned by regex and gated on `service_role`, and the
config tables carry a `cron_job_id` column that is nulled on reconfigure so the previous
job can be unscheduled cleanly.

`odeir-paymob-reconcile-v1` is a good example of why this design exists. It dispatched
over HTTP to a `verify_jwt = true` function, so every call returned 401 — but pg_cron
still recorded a successful SQL invocation, so the failure was invisible. It was replaced
by the database-owned `odeir-paymob-runtime-v2` job above, and
`20260906130000_paymob_retire_legacy_dispatcher_v1.sql` refuses to apply while the old job
is still active.

### Storage

Six buckets. Sensitive content is private and uploaded through a ticket, never with a
raw key.

| Bucket | Access | Size cap | Notes |
|---|---|---|---|
| `academy-course-media` | private | 500 MB | Video, via tus resumable upload |
| `cms-template-assets` | public | 20 MB | Imported template media |
| `cms-assets` | public | 8 MB | Site images |
| `cms-template-staging` | private | 20 MB | ZIP staging, never served |
| `support-attachments` | private | 10 MB | Scanned before use |
| `expert-application-files` | private | 5 MB | CV and photo uploads |

Uploads always follow: obtain a signed ticket from an RPC (`v3_cms_media_upload_ticket`,
`v3_support_attachment_upload_ticket`), upload directly to Storage with that token, then
register the asset through a separate action RPC.

There is **no realtime** in this system — no publication changes, no `.channel()`
subscriptions. All refresh is request-driven through snapshot RPCs.

---

## 7. RPC versioning

The application calls **325 distinct RPCs**. The `vN_` prefix is the real versioning
mechanism, and it is worth understanding because versions coexist:

| Prefix | Defined in `public` | Called by the app | Meaning |
|---|---:|---:|---|
| `v1_` | 324 | 167 | Domain snapshots and actions — the bulk of the API |
| `v2_` | 188 | 91 | Rebuilt on the v2 foundation: workspace, control, context |
| `v3_` | 81 | 54 | Further refinements, mostly snapshot v3 |
| `v4_` | 19 | 9 | Narrower v4 rewrites |
| `v5_` | 5 | 3 | Reports and calendar day |
| `v6_` | 1 | 1 | `v6_tenant_calendar_day_snapshot` |

The prefix is **not** a deprecation marker. `v1_` still carries the majority of calls,
and coexisting versions of the same capability are normal — `v1/v2/v3/v4_tenant_sales_pipeline_snapshot`
all exist. To find the current version of a capability, search the migration filenames
for the capability name and take the latest by migration date, not by prefix.

Names follow a small grammar:

```
v<N>_<scope>_<capability>[_<qualifier>]
       │        │              └── v2, v3 … a shape variant, not a version bump
       │        └── snapshot | action | authorize | preview | accept | accept_…
       └── tenant | platform | cms | public | support | training | zoom | …
```

Three recurring shapes:

- **Snapshot** — one call returns everything a page needs. `v2_tenant_workspace_snapshot`,
  `v3_cms_workspace_snapshot`, `v1_academy_workspace_snapshot`. This is why the app has
  58 API routes rather than hundreds: a page is usually one RPC.
- **Action** — a command with a payload and usually a `command_id` for idempotency.
- **Authorize** — the permission check the Edge functions call before escalating.

### private_app versus public

```
public.v2_tenant_paymob_prepare_checkout(...)   -- thin: auth, scope, shape validation
  └─> private_app.<implementation>(...)        -- the actual logic
```

454 functions live in `private_app` with no client grants. `public` is a thin
authenticated façade of 621 functions. When you trace a behaviour, the answer is almost
always in `private_app`.

---

## 8. Table relationships

808 foreign key edges across 365 tables. Deletion semantics are the design signal:

| Rule | Count | Applied to |
|---|---:|---|
| `on delete cascade` | 234 | `tenant_id` and owned children — the row dies with its parent |
| `on delete set null` | 178 | `*_subject_id` and `*_staff_id` — the record of an action outlives the actor |
| `on delete restrict` | 189 | Commercial history — orders, payments, documents cannot be orphaned |
| no action / unspecified | 207 | Defaults, mostly in `academy` and `zoom_core` |

The split is consistent: **cascade for ownership, set null for attribution, restrict for
money and history.**

### Identity and access

```
auth.users
  │ 1:1  on delete cascade
  ▼
access_control.subjects ──────────────► 238 inbound refs (the "who" spine)
  │ 1:N
  ▼
access_control.memberships ──► core.tenants        (which tenants this subject sees)
  │      ▲
  │      └── people.staff_profiles (membership_id, set null)
  │              ▲
  │              └── supervisor_staff_id (self-reference, set null)
  ▼
access_control.membership_roles ──► roles ──► role_permissions ──► permissions
```

`people.staff_profiles` is the tenant-scoped view of a subject: the HR record, department,
employee code, reporting line. A subject is a login; a staff profile is an employee.

### Tenancy

```
core.organizations
  │ on delete restrict
  ▼
core.tenants ◄────────────── 227 inbound refs (the "which customer" spine)
  ├── core.branches          (multi-branch tenants)
  ├── core.domains           (verified hostnames)
  ├── core.tenant_modules ──► core.modules
  ├── core.integrations
  ├── catalog.subscriptions ──► catalog.plans
  ├── catalog.tenant_addon_subscriptions ──► catalog.addon_products
  └── core.support_requests ──► core.support_messages
```

`core.tenants.organization_id` is `restrict`, not cascade: an organisation with
subscriptions cannot be deleted out from under them.

### CRM and work

```
sales_core.contacts ◄────────────── 14 inbound
  ├── sales_core.activities ──────► opportunities ──► pipeline_stages
  ├── sales_core.lead_status_history
  ├── sales_core.opportunities ───► academy.courses      (course interest)
  ├── work_core.tasks ───────────► work_core.task_history
  └── academy.students           (a student is a contact, restrict)
```

The CRM and academy domains are joined through `sales_core.contacts`: a student is a
contact with an `academy.students` row. The FK is `restrict` — a contact that became a
student cannot be deleted out from under the enrollment.

`work_core.task_history` is worth knowing about: it denormalises
`contact_id`, `opportunity_id`, and both the previous and next `assigned_staff_id`, so
reassignment history survives the staff record it refers to.

### Academy

```
academy.courses
  └── academy.course_runs ──► academy.course_run_sessions
        └── academy.enrollments ◄── academy.registration_handoffs
                                    (from sales_core.contacts)
              └── academy.students
academy.learning_paths ──► training_units
academy.diploma_contracts ◄── registration_handoffs
```

`registration_handoffs` is the bridge object. It is created by sales, points at both the
CRM contact and the academy course, and is what an enrollment and a diploma contract both
reference. It has 12 inbound references — the most-connected academy table.

All enrollment-side FKs are `restrict`: once a student is enrolled, the course, run, and
handoff cannot be removed.

### Commerce and payments

```
catalog.addon_products ──► marketplace.order_items
catalog.plans ──► catalog.subscriptions
marketplace.orders ◄────── 22 inbound
  ├── marketplace.order_items
  ├── marketplace.payment_attempts ──► payment_provider_configs
  │                                     └── paymob_credential_versions
  └── marketplace.payment_events
marketplace.service_providers ──► service_orders ──► service_packages
```

`marketplace.orders` has 22 inbound references and every one of its own FKs is `restrict`.
It is a financial record: it must not disappear, and the tenant it belongs to must not be
deletable while it exists.

The split between `payment_provider_configs` and `paymob_credential_versions` /
`tamara_credential_versions` is deliberate — rotating a credential creates a new version
row rather than editing the config, so a payment started under an old credential can
always be resolved.

### Accounting

```
accounting_core.customer_accounts ◄── sales_documents
                                        ├── sales_document_lines
                                        └── payments ──► payment_allocations ──► invoices
accounting_core.refunds ◄── payments, invoices, credit_notes
```

Separate from `marketplace` on purpose. An addon purchase and a customer invoice are
different ledgers, joined only at the tenant.

### Website and CMS

```
website.sites
  ├── website.pages ──────────► website.page_documents    (draft + published JSONB)
  ├── website.content_documents ──► website.content_document_versions
  ├── website.menus ──► website.menu_items
  └── website.articles ──► website.article_categories
```

Both document tables store `draft_document` and `published_document` side by side, with
versions in a child table. Publication is therefore a copy, not a mutation, and the last
published state survives an edit.

`website.sites` has no `tenant_id` — the public marketing site is platform-level, separate
from tenant workspaces.

### Marketing and ads

```
marketing_hub.providers
  └── marketing_hub.connections
        └── marketing_hub.ad_accounts
              ├── marketing_hub.campaigns ──► ads
              └── (Google) google_ads.accounts ──► google_ads.campaigns
(Meta) meta_connect_v2.connections
```

Two parallel ad integrations, one abstracted shape. `providers` is a small reference
table with no tenant; `connections` is the tenant-scoped OAuth binding.

### Zoom

```
zoom_core.connections ──► instances ──► recordings
                     ├── hosts
                     └── links ──► webinars
```

`zoom_core` tables are unusually `no action` on tenant deletion — an external meeting
archive outliving the tenant is a legal requirement, not an oversight.

---

## 9. Migration history

299 migrations, 7.4 MB, `20260726` → `20260927`. Applied in filename order; order is
asserted monotonic by CI.

| Phase | Files | Window | What it established |
|---|---:|---|---|
| P1 | 14 | 07-26 → 07-27 | Clean v2 foundation: `core`, `access_control`, `catalog`, `audit_log`; read-isolation policies; tenant provisioning |
| P2 | 15 | 07-28 | CRM and sales pipeline, academy and learner operations, automation engine |
| P3 | 19 | 07-29 → 07-31 | Integration hub, WooCommerce, multi-store commerce, knowledge, Yeastar |
| P4 | 40 | 08-01 → 08-04 | Knowledge intelligence, marketing hub, public site CMS, visual builder |
| P5 | 25 | 08-05 → 08-08 | Marketplace and addons, accounting core, ZATCA, brand isolation |
| P6 | 44 | 08-09 → 08-16 | Dashboards, reporting, calendar, resilience and load fixes |
| P7 | 47 | 08-20 → 08-31 | Odeiry AI, public registration, technical support, notification hub, manager |
| P8 | 39 | 09-01 → 09-12 | Paymob, Tamara, Google Ads and GA4, independent commerce |
| P9 | 54 | 09-14 → 09-23 | Training journey, academy platform separation, Zoom rebuild |
| P10 | 2 | 09-27 | Governance, sales identity, payment intake corrections |

Load-bearing migrations worth reading first:

| Migration | Why it matters |
|---|---|
| `20260726210000_clean_platform_foundation_v2.sql` | Creates the v2 spine and the permission namespace. Everything else descends from it. |
| `20260726211500_add_v2_read_isolation_policies.sql` | The first defence-in-depth read policies. |
| `20260802005000_enforce_settings_and_commerce_permissions_at_rpc_boundary.sql` | Moves permission enforcement from the app into the RPC — the point of no return for the security model. |
| `20260808000722_marktone_marketplace_v1.sql` | 46-table `marketplace` schema in one migration. The largest single domain. |
| `20260922123824_academy_platform_separation.sql` | Splits the academy from tenant workspaces and re-grants the public surface. |
| `20260906123000_paymob_final_runtime_v1.sql` | Replaces an HTTP cron hop with a database-owned job after a silent 401. |
| `20260906130000_paymob_retire_legacy_dispatcher_v1.sql` | Fails fast if the old scheduler is still active. |
| `20260916165601_training_learning_v1.sql` | Academy training domain at its largest. |

Filenames follow `<timestamp>_<topic>[_v<N>][_fix|hardening|indexes|reconciliation].sql`.
`fk_indexes`, `hardening`, and `fix` migrations are performance and security corrections
layered on an earlier domain migration, not new domains.

### Verification

`scripts/verify-migrations.mjs` runs inside `npm run check`. It asserts that 121
reviewed migrations are present, that ordering is monotonic, and that ~120 named schemas,
RPCs, permission keys, buckets, and security patterns still exist:

```js
assert.match(builder, /revoke all on table website\.page_documents from public,anon,authenticated/);
assert.match(builder, /grant execute on function public\.v2_platform_page_builder_action/);
assert.doesNotMatch(allSql, /grant\s+all[\s\S]+to\s+anon/i);
```

That last assertion is the deny-by-default rule expressed as a test.

---

## 10. Things that will surprise you

**`v1_` is not deprecated.** It holds 167 of the 325 RPCs the app calls. Find the current
version of a capability by latest migration date, not by prefix.

**`platform` is two unrelated things.** A permission namespace from P1 and a schema from
P4. See the note in §3.

**`private_app` is where the logic lives.** `public` is a thin façade. 454 internal
functions versus 621 exposed ones.

**RLS is not on every table.** 272 of 365. The other 93 are still unreachable because
they have no client grant. `revoke` is the real control; RLS is the second layer.

**Business logic runs in SQL, not in the app.** Snapshot and action RPCs mean most
features have no application-side orchestration. Look in `private_app` before writing
JavaScript.

**The browser has no Supabase client.** No SDK, no realtime, no direct table access. Keys
exposed to the client are publishable only.

**Audit trails are structural.** 171 tables carry a `*_subject_id` with
`on delete set null`, so attribution is durable by construction rather than by convention.

**No Deno version is pinned.** There is no `deno.json`, `import_map.json`, or runtime
version anywhere in `supabase/functions/`. Thirteen entrypoints import an unversioned
`jsr:@supabase/functions-js/edge-runtime.d.ts`. Runtime upgrades are an untested change
surface.

---

## 11. Observations

Read-only notes from reviewing the migrations and functions. Nothing here has been
changed, and no fix is proposed — these are flagged so the next reader is not surprised.

**A public CMS route calls an RPC that does not exist.**
`app/api/cms/public-contact/route.js:26` requests
`/rest/v1/rpc/v3_cms_submit_contact`. No such function is defined in any migration, and
the name appears nowhere else in the repository. The implemented path is
`public.v2_public_site_submit_contact` at
`20260803141411_marktone_public_site_cms_v1.sql:640`, which writes to
`website.contact_submissions`. Two details also differ: the route sends a `p_site_key`
argument the v2 signature does not accept, and it derives multi-tenant keys of the form
`tenant:<slug>` while the v2 function hardcodes `s.site_key = 'marktone-main'`. A PostgREST
call to an unknown function returns `PGRST202`, which the route's error translator does
not match, so the failure surfaces as a generic 400.

**Two functions have no `verify_jwt` entry in `supabase/config.toml`.**
`odeir-contact-intake` and `yeastar-sync`. Where no `[functions.*]` block exists the
platform default applies, which is `verify_jwt = true`. `yeastar-sync` is reached by
`marktone-yeastar-cdr-sync` (`*/15 * * * *`) with a `x-marktone-yeastar-secret` header and
no bearer token, so a deployed default of `true` would reject the job before
`v2_yeastar_schedule_authorize` ever runs — and, per the Paymob precedent above, pg_cron
would record the invocation as successful regardless. Its user-facing paths carry a real
bearer token and are unaffected either way. The actual deployed values could not be
verified from the repository; they are one dashboard read.

**A config comment describes a design the code does not use.**
`supabase/config.toml:94` states that public registration "uses a server-to-server ingress
token" that the browser never receives. The implementation instead issues an HMAC-signed,
TTL-bounded challenge and rate-limits by IP hash; the `x-odeir-worker-token` ingress token
is used only for worker, admin, and health actions.

**An unconfigured endpoint in the browser.**
`components/free-trial-landing.js:4` targets
`https://jultamrxwrgzohoktbgr.supabase.co/functions/v1/marktone-free-trial` — a different
project from this one, and a function that does not exist in this repository.

---

## 12. Where to look next

| Question | File |
|---|---|
| How the app is organised overall | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Why the v2 boundary exists | [`clean-foundation-v2.md`](clean-foundation-v2.md) |
| Workspace isolation rules | [`workspace-boundaries.md`](workspace-boundaries.md) |
| Payment provider security model | [`../payment-provider-security.md`](../payment-provider-security.md) |
| Paymob operational runbook | [`../paymob-operations-runbook.md`](../paymob-operations-runbook.md) |
| Invitation and activation flow | [`../registration-activation-architecture.md`](../registration-activation-architecture.md) |
| CI assertions on migrations | `../../scripts/verify-migrations.mjs` |
| Original database note | `../../supabase/README.md` |
