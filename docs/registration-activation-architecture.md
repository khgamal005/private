# Registration activation architecture

## Scope

This flow owns a registration request until it is atomically bound to exactly
one `core.tenants` row. A review status is never treated as proof that a
workspace exists. Existing tenants remain outside the write set unless an
administrator deliberately chooses `link_existing`, in which case the tenant
is locked and read, but not modified.

## Source of truth

- `platform.registration_requests` is the workflow record.
- `core.tenants` is the only source of truth for an active workspace.
- `platform.registration_external_account_claims` binds one verified external
  directory account to one current-stack tenant.
- `platform.registration_email_deliveries` records provider acceptance for
  email-verification messages without storing recipients, message bodies,
  confirmation URLs, or raw confirmation tokens.

The invariant `status <> 'converted' OR provisioned_tenant_id IS NOT NULL`
prevents the workflow from claiming conversion without a real tenant.

## Manual activation state machine

```text
pending_review -> under_review -> approve_and_activate -> converted
                                         |                 |
                                         |                 +-- linked active tenant
                                         +-- create_new -------- newly active tenant
```

`approve_and_activate` is a single database transaction. It locks the request,
checks authorization and the expected version, serializes claims for an
external directory account, creates or links the tenant, records the claim,
updates the request, appends an event, and writes an audit record. A retry after
success returns the same tenant as a replay and performs no new writes.

### `create_new`

This resolution requires an explicit assertion that no current ODEIR workspace
already represents the institution. Provisioning uses the verified-email owner
policy, attaches request provenance to the new tenant, and changes only the
exact tenant returned by the provisioning function from `trial` to `active`.

### `link_existing`

This resolution requires the slug of an existing active tenant. It records the
verified external-account claim and links the request. It does not update the
tenant, subscription, modules, membership, domains, integrations, or settings.

## Directory verification boundary

The browser supplies only the requested resolution and operator-entered tenant
or provisioning fields. For an existing institution, the Next.js server route
reloads the request using the authenticated platform session, calls the fixed
HTTPS directory endpoint with the request's stored external account ID,
normalizes and compares the official name, extracts an allowlisted set of
official identifiers, and computes a SHA-256 evidence hash over a canonical
minimal snapshot. The database accepts activation only when this server-created
evidence matches the request.

## Email delivery guarantees

The email path distinguishes provider acceptance from inbox delivery:

1. `v1_registration_email_delivery_begin` locks the request and returns a
   stable idempotency key and attempt number.
2. Resend receives that key in `Idempotency-Key`.
3. A 2xx response is accepted only when it contains a valid provider message
   ID.
4. `v1_registration_email_delivery_finish` records accepted or sanitized failed
   state. Accepted is monotonic and cannot be downgraded by a stale retry.
5. Only after provider acceptance does the request record
   `email_confirmation_sent_at`.

This phase proves transport acceptance. Delivered, bounced, complained, and
opened states require a separately authenticated Resend webhook consumer.

## Isolation and rollout

- The change is additive and contains no tenant-specific IDs or names.
- Existing active tenants are not backfilled or modified.
- The only data correction resets impossible `trusted` labels on unprovisioned
  manual requests to `pending_review`.
- Database migration, Edge function, and application deployment should be
  released together. The email-verified policy can be switched temporarily to
  `manual_review` as the operational kill switch during rollback.

## Operational signals

Alert on:

- registrations that remain `approved` without a tenant;
- email deliveries in `sending` beyond the retry lease;
- rising `failed` transport attempts by sanitized error code;
- external account claim conflicts;
- converted requests whose tenant is not active.
