# Registration and activation architecture

## Invariants

- `core.tenants` is the only source of truth for an active workspace.
- A request cannot be `converted` without `provisioned_tenant_id`.
- Registration never updates, links, or reuses an existing tenant. Manual
  activation supports `create_new` only.
- One external-directory account and one canonical official identifier can be
  claimed by at most one registration-created tenant.
- Provider acceptance and inbox delivery are separate, durable states.
- Confirmation URLs and owner invitation tokens are returned once; raw tokens,
  recipients, subjects, bodies, and URLs are never stored in the delivery
  ledger.

## Manual activation

```text
pending_review -> under_review -> approve_and_activate -> converted
                                             |
                                             +-- newly created active tenant
```

`approve_and_activate` is one database transaction. It locks the request,
checks the reviewer and optimistic version, serializes identity claims, creates
one isolated tenant, activates only that returned tenant, records claims,
updates the request, and appends event and audit rows. Any failure rolls the
whole transaction back.

For an institution selected from the external directory, the browser cannot
assert that verification occurred. The authenticated reviewer first prepares a
five-minute attestation bound to reviewer, request, and row version. A dedicated
JWT-protected Supabase Edge gateway reloads the stored account ID with the
reviewer's own authorization, calls the fixed HTTPS directory endpoint, and
completes the attestation through a service-role-only RPC available only inside
the Supabase runtime. Activation consumes that exact attestation once. The
Hostinger application never needs a privileged Supabase key for this flow.
Masked identifier suffixes are discarded, never promoted to official identity
claims.

A retry after a committed activation verifies tenant provenance and returns the
same tenant. If the original response containing a pending owner invitation was
lost, the retry rotates only that exact pending invitation and audits the
rotation; it never creates a second tenant.

The Edge gateway is an orchestration boundary, not a second source of truth. It
does not write tenant rows itself. It performs user-scoped detail, prepare, and
activation RPCs; only attestation completion uses the Supabase-provided service
credential. Request bodies and upstream responses are bounded, every response is
`no-store`, directory URLs are allowlisted, and logs contain error codes only.

## Email-verified trial

Only a request declared as a new institution can enter this path. Existing
directory institutions always remain manual. Commercial registration must be
ten digits; a national unified number must be ten digits beginning with `7`.
Malformed or lossy identifiers are rejected. A TVTC value is retained for human
review but is not, by itself, treated as machine-verifiable proof or as an
automatic-activation identity claim.

Submission commits the request, identity reservations, and an email outbox row
in one transaction. The response means “queued”, not “delivered”. A background
attempt is started immediately, and a Supabase Cron worker drains the same
durable queue every minute for crash recovery.

```text
queued -> leased -> accepted
   |         |
   |         +-> retryable -> leased
   +------------> terminal_failed / cancelled

accepted -> sent / delayed / delivered / bounced / suppressed / failed / complained
```

Each generation has a stable Resend `Idempotency-Key`, template version, nonce,
expiry, and HMAC key version. The raw confirmation token is derived only inside
the Edge worker and only its SHA-256 hash is bound to the delivery. Network
timeouts and ambiguous 2xx responses retry the same generation and idempotency
key. A lease-aware finish function makes provider acceptance monotonic, so a
late failure cannot downgrade a successful attempt.

The runtime Resend key is `Sending access` restricted to `odeir.com`; it is never
used to list or administer domains. Deployment records the independently checked
domain name and a strict UTC verification timestamp. Health fails closed when
that attestation is missing, names another domain, is in the future, or is older
than 30 days.

Every issued, unexpired generation is represented by a hashed token alias.
Confirmation locks request and delivery in the same order as the worker, accepts
one valid unused alias, rechecks the live kill switch, and provisions at most
one tenant. Old HMAC secrets remain installed until health reports no pending
generation requiring them.

Resend webhook requests are verified against their exact raw bytes with the
Svix signature and replay window before a service-role-only RPC stores the
event. Events are idempotent by provider event ID and tolerate arrival before
the provider message ID is committed or arrival out of order. Webhook telemetry
is mandatory for automatic activation: provider acceptance alone never proves
delivery.

Before `email_verified_trial` can be saved, an authorized operator sends an
isolated production canary. It creates neither a registration request nor a
tenant and persists only a salted recipient hash. A signed `delivered` webhook
must reconcile the latest canary for the exact current configuration
fingerprint. Edge then issues a hashed, single-use, 90-second database grant
bound to that canary and the current policy version. The legacy policy RPC can
only select `manual_review`; the guarded email RPC atomically consumes the
grant. A policy change, a newer canary, secret rotation, or grant expiry closes
the gate.

Every genuinely new, unlinked submission rechecks live readiness. The runtime
guard and durable request insert share one database transaction. Healthy
submissions use a shared advisory lock and can run concurrently; policy and
canary transitions use the matching exclusive lock. If sender, webhook,
worker, key, attestation, or current canary readiness degrades, the policy is
atomically returned to manual review before the request is created. Existing
or linked institutions bypass this email dependency and always use their
isolated manual path.

## Isolation boundary

The normal write set is limited to the registration request, registration
events, identity reservations/claims, email ledger, audit rows, the newly
created tenant, its new modules/subscription, and its new owner invitation.
There are no tenant-specific IDs or names in migrations. Existing tenant rows,
memberships, modules, subscriptions, domains, integrations, and message queues
are outside the write set.

## Read model and operations

Inbox status, search, composite filters, total, and pagination are computed on
the server. `approved` without a tenant is displayed as waiting for activation,
not as active or trusted. Active-institution views continue to read
`core.tenants.status = 'active'`.

The authorized email health action reports:

- sender configuration and the recent `odeir.com` domain attestation;
- outbox and cron configuration;
- worker heartbeat;
- active and pending HMAC key versions and missing secrets;
- queued, retryable, stale-lease, terminal-failure, accepted, and delivered
  counts;
- webhook-secret configuration.
- a recent signed `delivered` canary matching the current configuration.

Alert on a stale worker heartbeat, missing HMAC versions, stale leases,
terminal failures, approved requests without a tenant, external-claim
conflicts, and any converted request whose tenant is not active.

## Release and rollback

Production release is deliberately gated and ordered:

1. switch new registrations to `manual_review`;
2. verify there are no in-flight legacy confirmation links;
3. apply additive database migrations;
4. configure the Vault-backed cron worker and versioned HMAC secrets;
5. create a domain-restricted Resend `Sending access` key, independently verify
   `odeir.com`, and record the name and UTC attestation timestamp;
6. deploy and verify the manual-activation Edge gateway, then deploy the
   application route that delegates existing-directory verification to it;
7. register the signed Resend webhook and verify its signing secret;
8. require a healthy worker heartbeat, then run the isolated production canary;
9. wait for the signed `delivered` event and use its one-time activation grant
   to enable `email_verified_trial`.

Rollback first switches to `manual_review`, unschedules the worker if needed,
and rolls back application/Edge versions. Additive tables remain in place so
delivery evidence and audit history are not destroyed. No rollback step edits
an existing tenant.
