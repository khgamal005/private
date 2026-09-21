# Direct institute diploma contracts

This implementation is scoped to ODEIR. It adds a reviewed foundation for direct institute diploma contracts without enabling a tenant, deploying, rewriting historical courses, or touching Reef production data.

## Operating contract

- A program has an explicit `short_course` or `diploma` kind. Historical programs remain unclassified until an academy operator reviews them. Classification is available from the existing course catalog with academy permissions, without accounting rights, LMS, paid synchronization, or diploma rollout activation.
- A diploma parent contract references the existing admission handoff and a canonical accounting payer account. The payer may differ from the beneficiary. It does not create another contact or cash ledger.
- The contract records its original amount, currency, start date, first installment condition and collection owner. All schedule due dates must fall between the start date and 30 calendar months after it. A schedule contains 1–120 obligations; the monthly editor produces at most 30 installments and preserves exact minor-unit totals.
- Schedule versions and their items are immutable. Before approval, a draft can be corrected by appending a new revision with its reason; old terms remain in its creation event and original schedule. An approved reschedule requires a reason, an expected current version and invoice-issuing authority. Linked installment identities and amounts remain intact; their dates may be revised. The first installment identity and amount remain intact. The old schedule stays queryable.
- Each periodic invoice is created/issued in existing accounting and linked once to one installment. Its payer, original amount and currency must match. Concurrent diploma and existing training-pilot linkage cannot reuse an invoice for another flow. Payments, allocations, receipts, refunds and credit notes stay in `accounting_core`.
- Initial admission requires an approved active contract and net verified allocation covering the first installment. An issued linked credit note reduces that effective payment condition through the canonical invoice total; the original contractual first-installment amount remains separately recorded. A separately authorized exception can permit admission without an upfront payment **while retaining the debt**. This exception neither records a fictitious payment nor forgives money. Financial reductions use canonical credit notes and reviewed accounting adjustments.
- Grace is seven calendar days in the tenant timezone. The due date does not move. An obligation due on 1 January is overdue beyond grace at local midnight starting 9 January. Arrears create one contract collection task; no diploma function suspends or withdraws an enrollment.
- Unavailable collection staff do not keep a new task assigned while on leave: the runtime staff availability helper is used if present; otherwise active employment is checked. Missing coverage is explicitly sent to the finance queue (`ownerMissing`), rather than being silently lost.

## Cancellation and settlement

The refund cancellation effect calls `private_app.mark_diploma_settlement_review_v1(tenant,handoff,refund)`. This is idempotent for the same completed refund. The contract enters `settlement_review`; new invoice links and admission eligibility stop. Future unbilled obligations pause. Existing issued invoices and their balances remain authoritative and unchanged.

A finance settings manager reviews the issued outstanding amount and unbilled contract amount before choosing either:

1. `collections_only`: collect existing issued invoices, retaining the paused unbilled obligations and full audit history.
2. `closed`: close only after issued balances are zero, confirming cancellation of the remaining unbilled contract obligations.

Both decisions require a reason, explicit confirmation, the schedule version and a hash of the displayed financial preview. A later accounting event that makes a closed contract owe money again reopens financial review; it does not silently restore training or erase debt.

An ambiguous historical refund whose invoice allocation is unknown produces an explicit financial-review state and task. Paid and outstanding values remain unknown until matched; the system does not label the full installment delinquent or allow closure on an assumed zero balance. An already approved admission waiver remains independent of that financial matching process.

## Security, transactions and integration

All new business tables carry tenant keys, foreign keys, indexes, RLS and revoked direct client grants. Public RPCs check authentication, tenant activity and their specific permissions. Definer functions have an empty search path. Internal helpers are not executable by clients. Command IDs are serialized by advisory lock, bound to actor/action/payload, and replay the stored result. The client retains its command ID after an ambiguous network failure.

The admission handoff is locked before the contract for operator mutations. Existing issued invoice rows are read without taking a reversed document lock; they are already protected by accounting immutability. The unique invoice link and the shared invoice advisory lock serialize the two training linkage paths. Real multi-connection concurrency remains a staging gate; PGlite validates SQL behavior, not simultaneous sessions.

`private_app.diploma_admission_eligibility_v1(tenant,handoff)` returns `eligible`, `reason`, `contractId`, `requiredAmountMinor`, `verifiedAmountMinor` and `waiverApproved`. It uses the finance agent's canonical `accounting_invoice_net_v1` calculator. Diploma mutations invoke the general admission reconciler when installed. Course classification queues related unfinished handoffs when that queue is installed.

`private_app.reconcile_diploma_collection_v1(tenant,contract,asOf)` updates the single canonical work task. Money mutations enqueue `queue_diploma_collection_v1(tenant,contract)` to avoid acquiring a contract lock while holding accounting locks. The bounded worker processes queued closed contracts as well as active obligations and removes only the request timestamp it processed, preserving a concurrent new request. Contract states stay separate from academic enrollment states.

## Activation and rollback

The schema creates no tenant settings rows and performs no backfill. `academy.diploma_settings.enabled` and `collection_automation_enabled` both default to false. Feature activation belongs to the separately reviewed rollout, with an isolated tenant first.

After feature activation, a permitted manager can enable collection automation from the contract screen only after reviewing the affected contract count and confirming. Activation requires `pg_cron` and registers a five-minute job that calls the bounded private worker. The worker processes at most 100 contracts per call, uses `FOR UPDATE SKIP LOCKED`, and selects only explicitly enabled tenants. The service RPC additionally checks a service-role JWT. Disabling the tenant automation flag stops future scheduled processing without deleting existing tasks or financial records. The migration itself schedules no job.

The new page is `/tenant/[slug]/diplomas`; `/api/diplomas` handles snapshots and commands. The existing catalog uses the independent `/api/program-kind` endpoint. No paid feature check is added to either capability. Snapshots bound contracts to the latest 50, selectors/history to 100 and schedules to 120 rows; catalog program-kind reads are requested in batches of 500 visible course IDs. Larger contract/selector catalogs need pagination before broad rollout.

Roll back activation first and then application navigation if needed. Preserve the additive tables, canonical accounting documents, schedule versions, command receipts and audit events. Do not drop data-bearing schema or normalize existing records as a rollback strategy.

## Verification

The isolated PGlite suite executes the actual diploma migration over the repository's synthetic training schema and real permission functions. It executes the canonical finance net-balance function rather than substituting cash arithmetic. Covered cases include default-disabled rollout, free academy-only classification, tenant/permission isolation, immutable histories, 30-month limits, exact totals, command replay, stale updates, invoice currency/ownership, cross-flow invoice exclusivity, refund-adjusted eligibility, timezone grace boundaries, missing staff coverage, settlement preview/closure, reopening after new debt and confirmed automation activation.

React/JSDOM tests exercise disabled controls, explicit debt-retaining admission exceptions, retry command identity, settlement confirmation and automation preview. The month-end test covers leap-year January-to-February clamping and exact currency rounding. These checks do not claim a live browser acceptance run, deployed schema parity, real concurrent Postgres locking, or representative production query plans. Those remain release gates before activation.
