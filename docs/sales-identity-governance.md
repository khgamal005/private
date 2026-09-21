# Sales and customer identity governance

Implementation is prepared locally; neither this document nor migration creation implies deployment.

## Boundaries

- `sales_core.contacts` is the canonical customer. The existing tenant/type/value unique identity index protects primary, WhatsApp, additional and historical phone identities. No duplicate customer represents a new sale.
- New customers require a primary phone. Legacy missing-phone records remain untouched; their identity is corrected explicitly. Four active additional numbers are allowed, including a WhatsApp number different from the primary. Historical aliases remain reserved to the same person and do not consume active slots.
- New opportunities are `training` with a course, or `general`. Existing opportunities remain `legacy_unclassified`; there is no guessed backfill.
- Open opportunities share the contact owner. Existing authorized lead reassignment preserves assignment/audit history and propagates open/pending opportunities. Closed opportunities retain their historical seller attribution.
- A contact has one open sales calendar task. It represents the earliest scheduled open opportunity. Additional opportunities can be created without a next action; when provided, action type and tenant-timezone timestamp are a pair.
- Unscheduled opportunities show an explicit count on the customer's sales row/card and remain available in the followup selector. The operating planning queue provides the owner and review deadline; optional scheduling does not create a second calendar task.
- `lead_status` remains the compatibility summary of current sales work. A new open sale can restore `follow_up`; prior verification stays on its original opportunity/handoff and status history is appended.
- Opportunity amount is the contract value. Followup payment submission does not replace that amount with an installment.
- Each new opportunity records its explicitly entered sale source in `metadata.attribution`. Missing evidence stays `unattributed`; acquisition campaign on the customer is not copied to a new purchase.

## API and concurrency

`v3_tenant_create_opportunity` uses `p_command_id`, an actor/request digest, contact advisory lock, contact row lock and existing unique calendar-task index. `v2_tenant_create_opportunity` remains a compatibility adapter. Duplicate active opportunities for the same program are rejected; legacy ambiguity requires explicit review.

Structured followup uses `v2_tenant_record_sales_followup_v7` with `p_opportunity_id`. V6 delegates to the same private implementation. A single open opportunity is inferred for old clients; multiple open opportunities require a selected target. General inquiry followup does not overwrite stored course interests. Payment-course mismatch is rejected.

`private_app.sync_customer_sales_task_v1(tenant_id,contact_id)` must run after all admission/payment changes that affect an opportunity. It reuses the canonical task, restores remaining work and preserves earlier task history through the existing task-history trigger. It makes no network calls.

Legacy stage movement now takes the contact lock before the opportunity lock and synchronizes the task afterward. Sales cannot reopen a won/pending-verification opportunity or mark one won without verified payment evidence; corrections belong to admission/finance flows.

Generic task status/transition APIs reject canonical sales-followup tasks, including older authenticated API versions. The calendar routes these actions to the CRM followup form and shows a link when its contact is outside the loaded page. Work-only permissions cannot edit the sales projection. A genuine generic operational task can still reference a contact and follows its separate work lifecycle; creating it does not replace or modify the sales task.

## Validation and release

Behavioral PGlite tests load the real V2–V5 followup definitions with synthetic data and apply the full new migration. They cover primary-phone requirement, tenant/alias uniqueness, combined WhatsApp capacity, permissions, idempotence, optional schedule, one task across repeat programs, explicit followup target, general inquiry and payment handoff preserving another active program. The new opportunity dialog is exercised with an actual DOM and mocked API, including retry identity and optional schedule validation.

Before staging, compare the migration's replaced functions with the captured production definitions. Do not apply historical repository backfills to production. Apply the new forward migration transactionally, then deploy matching API/UI in the authorized release window. Authenticated browser tests and real PostgreSQL contention tests remain release gates; PGlite does not model concurrent backend sessions.

Count-only preflight (run against the intended tenant; never repair by this query):

```sql
select count(*) filter(where private_app.normalize_lead_phone(phone) is null) as missing_primary,
       count(*) as contacts
from sales_core.contacts where tenant_id = :tenant_id;

select count(*) as ambiguous_open_programs from (
  select contact_id,course_id from sales_core.opportunities
  where tenant_id = :tenant_id and status = 'open'
  group by contact_id,course_id having count(*) > 1
) review;

select count(*) as customers_over_active_phone_limit from (
  select contact_id from sales_core.contact_identities
  where tenant_id = :tenant_id and identity_type = 'phone'
    and source_slot in ('phone','whatsapp','additional_phone')
  group by contact_id having count(distinct identity_value) > 5
) review;
```

No destructive down migration is provided. Before activating, retain previous function definitions and application SHA. An emergency rollback restores previous routines/UI while retaining the additive kind column and newly captured audit/identity history; do not drop customer data, opportunities or phone aliases. Reconcile new opportunity records before a rollback to an application that lacks opportunity selection.
