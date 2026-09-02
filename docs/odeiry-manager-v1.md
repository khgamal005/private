# Odeiry Manager v1

Odeiry Manager is an additive, default-off mode of the existing single Odeiry
agent. It is a personal, tenant-bound assistant for reviewed memory and
allowlisted read-only analysis. It cannot execute platform actions, create
ticket drafts, query arbitrary database objects, or read customer rows. An
authorized manager may ask for a bounded employee-performance comparison; only
the display name, business label, metric evidence, and sample strength selected
by the dedicated tenant RPC may reach the model.

## Feature gates

All gates must be open before any model analysis, thread read, memory-context
read, analytics read, or memory approval:

1. `ODEIRY_AI_ENABLED=true` and the existing database Odeiry runtime are
   enabled.
2. `ODEIRY_MANAGER_ENABLED=true` (manager-only application kill switch).
3. `platform.odeiry_runtime_settings.manager_enabled=true` (independent
   database kill switch, added with `NOT NULL DEFAULT false`). It can change
   only through the audited, version-checked platform runtime RPC.
4. The tenant manager setting is enabled and the authenticated, real tenant
   member has `tenant.odeiry_manager.use`.

Platform operators are explicitly ineligible for Manager mode even though the
operations assistant can provide them an observe-only product guide. A request
without `assistantMode` remains `operations_v2` for backward compatibility.

There is one narrow lifecycle exception: while the base Odeiry application is
still reachable, an authorized tenant owner who already has personal Manager
memory may open the review workspace and reject a pending proposal or archive
an approved memory even when the Manager application, database, or tenant gate
is off. This path cannot open a thread, analyze data, or approve new memory.

## Read-only flow

1. The authenticated route validates same-origin, rate, tenant snapshot,
   manager capability, and the independent feature flags.
2. `start_run` receives `assistantMode=manager_v1`; the database prevents a
   manager thread from being resumed through operations mode or vice versa.
3. The route loads at most eight approved, active memories for the current
   tenant and current subject. Pending, rejected, archived, expired, and other
   users' memories never enter model context.
4. The single agent can call either `read_odeir_manager_analytics` for aggregate
   indicators or `read_odeir_manager_team_performance` for employee-performance
   evidence. Both tools accept only `last_7_days` or `last_30_days`, and the
   team tool also accepts one fixed dimension: `overview`, `sales`,
   `follow_up`, `tasks`, or `calls`. They share the same limit of
   two analytics reads per run. Neither tool accepts tenant IDs, slugs, SQL,
   free-form filters, or record identifiers.
5. The team RPC derives the tenant from the authenticated run and requires the
   current real tenant role to hold both `tenant.people.read` and
   `tenant.reports.analytics`. Platform privileges do not satisfy these domain
   permissions. `overview` returns a leader per category rather than an
   unreviewed composite winner; a specific dimension returns at most five
   employees and includes numerator, denominator, sample size, and sample
   strength.
6. One narrowly scoped v4 service dispatcher finalizes every run. For a
   completed manager run it atomically finalizes the answer and writes at most
   two pending, catalog-backed memory proposals in the same database
   transaction. A failure rolls back both, so a process interruption cannot
   leave a completed answer whose proposals were silently lost. During a
   staged rollout only, a precise PostgREST `PGRST202` miss for v4 may fall
   back to v3 for proposal-free runs; a completed manager run never uses that
   fallback.
7. Memory evidence quotes are transient validation inputs only: they are
   removed from `responseData`, never stored as raw text, and represented in
   memory storage only by a one-way evidence hash.

## Memory review contract

The model can select a candidate from a small, version-controlled catalog, but
cannot author arbitrary memory text, approve memory, or silently change it.
Each catalog candidate has a server-owned `memoryKey`, category, and canonical
Arabic statement. The model output must include that exact tuple plus:

- `evidenceBasis=current_user_explicit`;
- a short `evidenceQuote` copied verbatim from the current user message; and
- an optional validity of 30, 90, 180, or 365 days.

Runtime filters accept evidence only when both the literal quote and the whole
current message normalize to the same complete, reviewed assertion. The only
removable wrappers are closed save directives such as `احفظ أن ...` and
`Remember that ...`; substring matches, questions, negation, attribution,
role-play, and wider meaning expansions are rejected. Manager v1 therefore
requires a short, single-purpose memory declaration rather than extracting a
memory from a broader discussion. Credentials, contact/payment identifiers, any text
containing eight or more Arabic/Latin digits regardless of separators, names
or facts about customers/employees/other managers, and prompt-injection
instructions are rejected. The service canonicalizes the key, category, and
statement from the catalog instead of trusting the model's wording. The
database independently repeats the exact-assertion check against the stored
current user message before creating a pending revision.

No arbitrary free-form model statement is stored, even with `proposed` status.
If the current explicit request does not match one of the reviewed catalog
entries, no memory proposal is written. Expanding memory coverage therefore
requires a reviewed code-and-migration change to the catalog, not a looser
prompt. Approval/rejection/archive happens through the authenticated review API
with optimistic version checking.
Disabling Manager blocks approval but deliberately preserves owner-only reject
and archive so a kill switch never traps previously stored personal memory.
Expired approved memories are excluded from both context and the review
workspace, then archived under the owner's review lock before the next memory
action. This frees both their key and approval quota and writes an aggregate
audit event without memory content.

Version 1 deliberately exposes archive rather than destructive per-memory
deletion. Tenant deletion remains fail-closed while manager history or memory
exists so that retention/deletion is always an explicit reviewed operation.

## Analysis boundary

The aggregate analytics RPC derives tenant and subject from the authenticated
run and returns only allowlisted metrics and bounded daily totals. The team RPC
also derives tenant and subject from that run, verifies its manager-thread owner
marker, and performs tenant-only permission checks before reading anything.
Its final JSON contains no tenant, subject, staff, or customer identifier and no
phone, email, task title, note, or URL. Employee names and business labels pass
through database and application sanitizers before they can reach the model.

The comparison is evidence-based rather than a universal employee score.
`sales` is the count of verified sales and is `initial` from five sales and
`strong` from ten. `follow_up` is recomputed from its numerator and denominator
and is `initial` from 20 assignments and `strong` from 50. Task completion is
recomputed the same way and uses 10/30 due-task thresholds; call answering uses
20/50 call thresholds. A smaller sample is `insufficient`, and the assistant
must not describe it as decisive. Activity volume alone is never an overall
performance measure.
The report data remains subject to its operational attribution limitations,
including reassignment, current-owner verified-sales attribution, and telephony
mapping completeness.

SQL accepts only numeric metric scalars and fixed enums. Each direct analytics
RPC is capped at 32 KB; the application applies a second 8 KB tool-result cap
and reconstructs every leader from an explicit field allowlist. It does not
trust a tool payload's `metricValue` or `sampleStatus`: sales counts are derived
from the verified numerator, rates are recomputed from numerator/denominator,
and sample strength is derived again from the category thresholds.

When the team tool is used, a server-owned renderer replaces the model's
`reply`, `steps`, `suggestions`, and `confidence` with the normalized facts and
always attaches the fixed `manager.team_performance.live` source. This makes
employee names, values, sample warnings, and attribution deterministic even if
the model omits, changes, or invents them. The model still selects the bounded
tool and dimension, but cannot author the final system facts. Tool results and
approved memories remain untrusted data, not instructions.

In `manager_v1`, the server always enforces:

- `needsEscalation=false`;
- `escalationReason=null`;
- `ticketDraft=null`;
- no write or execution tool; and
- no platform-operator access.

## Context and cost bounds

- Current message: existing 4,000-character / 12 KB limit.
- Manager history: last eight bounded messages.
- Approved memory: eight items and 4 KB total.
- Analytics: two shared calls, 8 KB per tool result, fixed metric/dimension keys;
  team results contain one leader per category or at most five for one category.
- Agent: four turns, 2,200 output tokens, 30-second route timeout.
- Memory extraction uses the same structured model response; it does not invoke
  a second model.

## Deployment order

1. Deploy the application first while `ODEIRY_MANAGER_ENABLED=false`. If v4 is
   not installed yet, the exact `PGRST202` bridge keeps proposal-free
   operations/failure finalization on v3; manager completion remains closed.
2. Apply the migration. The database manager kill switch is created as
   `manager_enabled=false`, so installing the schema cannot activate Manager.
3. Verify the v4 dispatcher, its grants/revocations, migration tests, and the
   operations regression suite before opening any manager gate.
4. Enable the application flag, database global flag, and tenant setting in
   that order, one approved tenant cohort at a time.

The migration and every gate change are separate reviewed rollout events; this
document does not turn any gate on.

## Rollback

Set `ODEIRY_MANAGER_ENABLED=false` for an immediate application rollback. The
database can independently stop all Manager analysis and approval by setting
`platform.odeiry_runtime_settings.manager_enabled=false` through the audited,
version-checked platform runtime RPC, or one tenant can be stopped through its
manager setting. All three manager gates default to off. Existing operations
mode is unchanged. Owner-only workspace, reject, and archive remain available
for existing personal memory; pending memories are otherwise inert and no
historical backfill is performed.
