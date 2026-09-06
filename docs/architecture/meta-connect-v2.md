# ADR: ODEIR Meta Connect V2

- Status: Accepted for implementation
- Date: 2026-08-24
- Scope: private pilot only
- Production release: not authorized by this ADR

## Context

ODEIR already has a tenant-scoped, read-only Marketing Hub with a manual Meta access-token connector. It also has an outbound communication hub for WhatsApp, email, and API delivery. The current repository does not contain a multi-tenant Meta OAuth callback, Lead Ads webhook ingestion, or a Facebook/Instagram unified inbox.

The existing Meta save action upserts the single `(tenant_id, provider_key)` connection and resets connection state. It must never be called as part of the V2 rollout for a tenant with a legacy Meta connection.

## Decision

Build Meta Connect V2 as a parallel, fail-closed control plane. Reuse canonical downstream domains through narrow, idempotent projections:

- `marketing_hub` remains authoritative for ad accounts, campaigns, ads, daily metrics, and attribution.
- `sales_core` remains authoritative for contacts, identities, assignments, and follow-up lifecycle.
- A new provider-neutral omnichannel domain becomes authoritative for inbound conversations and messages.
- `communication_hub` remains the existing outbound provider/template domain and is not overloaded as the inbox.

V2 is enabled only when both the commercial entitlement and a private rollout allowlist are true. Missing rollout state always means disabled.

## Meta application topology

- One production Business app owned by Marktone's verified Business Portfolio.
- One child Meta Test App for development, QA, and staging.
- One ODEIR-owned app serves future tenants; no app is created per tenant.
- Reef stays on its existing connection, tokens, assets, webhook paths, and runtime until a separately authorized cutover.

## Runtime boundaries

### Browser and Next.js

- Render connection status, asset selection, and health.
- Start OAuth only after authentication, tenant membership, permission, entitlement, and rollout checks.
- Never receive, store, log, or return a Meta App Secret or tenant token.

### Supabase Edge Functions

- `meta-oauth-v2`: server-side code exchange, token inspection, asset discovery, disconnect, and deauthorization.
- `meta-webhook-v2`: GET challenge, raw-body signature verification, immutable receipt, enqueue, and fast acknowledgement.
- `meta-worker-v2`: queue consumption, Graph calls, retries, lead retrieval, ads synchronization, and message normalization.

### Postgres

- Short, tenant-scoped transactions only.
- No external network call while holding a database lock.
- Vault references only in operational tables.
- Durable webhook journal plus queue delivery; business effects remain idempotent.

## Additive data model

Create a private `meta_connect_v2` schema with:

- `oauth_transactions`: hashed single-use state, tenant, actor, exact return target, expiry, and consumption timestamp.
- `connections`: Meta identity, granted scopes, token/data-access expiry, status, and health timestamps.
- `credential_refs`: Vault UUID references only.
- `assets`: Business, Page, Instagram, ad account, and lead-form identities.
- `asset_bindings`: selected assets and the unique tenant routing boundary.
- `webhook_subscriptions`: requested and verified subscriptions.
- `webhook_events`: immutable signature-verified receipt journal, payload hash, attempts, correlation ID, and redacted error.
- `lead_receipts`: unique Page plus `leadgen_id`, retrieval state, and canonical CRM publication outcome.
- `sync_runs`: V2 ads and reconciliation jobs.
- `rollout_targets`: explicit pilot allowlist; no wildcard in pilot.
- `kill_switches`: OAuth, subscriptions, ads, leads, inbound messages, and outbound replies.
- `operation_attempts`: redacted technical audit outcomes.

Create a private `omnichannel` schema with:

- `channels`, `participants`, `conversations`, `messages`, `message_events`, `assignments`, `attachments`, and `outbox`.
- Unique conversation identity per tenant, channel, and external thread.
- Unique message identity per tenant, channel, and external message ID.
- Keyset pagination by tenant, last message time, and ID.
- Social participants are not automatically converted into CRM contacts.

All business tables require `tenant_id`, foreign keys, covering indexes, RLS plus Force RLS, revoked browser grants, narrow RPCs, and append-only audit where applicable.

## OAuth and credential security

- Global Meta App Secret lives only in Edge Function Secrets.
- Tenant and Page tokens live only in Supabase Vault under a V2 namespace.
- Validate single-use OAuth state, exact redirect URI, app ID, token identity, scopes, expiry, data-access expiry, and selected asset ownership.
- Use `appsecret_proof` on server Graph calls.
- Never place tokens or Vault UUIDs in browser responses, logs, exports, snapshots, or support views.
- Disconnect removes or revokes credentials while preserving operational history.
- Deauthorization and data-deletion callbacks are required before App Review.

## Webhook and queue contract

1. Verify the GET challenge or POST `X-Hub-Signature-256` against the raw body using timing-safe comparison.
2. Resolve the tenant from server-owned asset bindings, never from a tenant ID supplied in the payload.
3. Insert the immutable receipt and enqueue its ID atomically.
4. Acknowledge immediately.
5. Process asynchronously with bounded retry, exponential backoff, visibility timeout, quarantine, and dead-letter handling.

Use Supabase Queues/PGMQ as transport and `webhook_events` as the durable audit source. Delivery may repeat; unique constraints and idempotency keys provide exactly-once business effects.

## Module behavior

### Ads

- Request `ads_read` only in the first release.
- Discover and explicitly select ad accounts.
- Pin the Graph/Marketing API version and test upgrades before changing it.
- Reuse the existing read-only Meta adapter and canonical marketing tables through a V2 projection binding.
- For pilot tenants, hard fail with `legacy_meta_connection_present` when any Meta connection already exists.

### Lead Ads

- Deduplicate by Page and `leadgen_id`.
- Fetch the full lead asynchronously after receiving the webhook.
- Normalize phone and email through existing tenant identity rules.
- Publish through a service-only canonical intake RPC with a stable idempotency key.
- Existing identity: append source/touchpoint/history and do not create a duplicate contact or active task.
- New identity: add a provider/form/day intake row; distribution is manual in the first pilot.

### Messenger and Instagram

- Phase one is inbound inbox, assignment, attachments, unread state, and delivery/read events.
- Outbound reply is an independent kill switch after permission review and messaging-window enforcement.
- Handle echoes, retries, out-of-order events, revoked assets, and attachment authorization.
- WhatsApp onboarding remains a separate project and approval path.

## Access contract

Every entry point evaluates:

`authenticate -> membership -> permission -> entitlement -> V2 rollout -> asset ownership -> action -> audit`

Initial permissions:

- `tenant.meta_connect.read`
- `tenant.meta_connect.manage`
- `tenant.inbox.read`
- `tenant.inbox.reply`
- `tenant.inbox.assign`

## Reef protection contract

- No V2 rollout or subscription row for `reef-skills`.
- No V2 OAuth transaction, asset binding, webhook subscription, event projection, seed, trigger side effect, or token import for Reef.
- No migration backfill or update to Reef's current `marketing_hub.connections`, secret references, `core.integrations`, metrics, attribution, or communication connection rows.
- Baseline connection state and row counts are captured read-only before every staging and production release.
- Post-release probes assert the Reef baseline is unchanged.
- Any future Reef cutover is a separate project with explicit approval, backup, dry run, reauthorization, shadow reconciliation, and rollback.

## Required tests

- OAuth state mismatch, expiry, reuse, code replay, and open redirect.
- Invalid webhook signature, oversized payload, duplicate delivery, and out-of-order events.
- Cross-tenant asset collision and unauthorized asset actions.
- Queue redelivery, worker crash, rate limits, token expiry, revoked scopes, and App Secret rotation.
- Lead/contact concurrency, canonical identity reuse, and one-active-follow-up invariant.
- Inbox keyset pagination, unread counts, assignment authorization, attachment authorization, and messaging windows.
- No secrets or Vault UUIDs in any snapshot or log.
- Ads reconciliation against the existing Marketing Hub.
- Reef before/after invariants.

## Rollout

1. Reconcile the diverged staging branch with current main.
2. Create the production Meta app and child Test App.
3. Apply additive schema and functions to `platform-Staging` only.
4. Run automated security, tenancy, concurrency, replay, and recovery tests.
5. Enable observe-only mode for an empty sandbox tenant.
6. Canary on one to three non-Reef centers.
7. Prepare and submit Meta App Review and Access Verification evidence.
8. Expand the allowlist gradually after operational review.

Rollback disables capabilities and workers while preserving valid webhook receipts and all operational history. Schema rollback is forward-fix only; no destructive cleanup.

## Non-goals for the first release

- Creating, editing, pausing, or changing budgets for ad campaigns.
- Automatic outreach outside Meta messaging-policy windows.
- Automatic CRM contact creation for every social participant.
- WhatsApp Embedded Signup.
- Migrating Reef.

## Difficulty and estimate

Engineering difficulty: 9/10. Expected focused implementation: four to six engineering weeks, plus Meta's independent review time.
# Implementation status — 6 September 2026

This document includes future account discovery, reporting and messaging design.
The implemented release remains an OAuth control plane only. See
`../operations/social-connect-production-review-2026-09-06.md` for current scope,
security corrections, production setup and the outstanding analytics work.

