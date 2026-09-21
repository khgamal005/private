-- Financial governance: additive, no tenant backfill; automatic import is opt-in.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

create table accounting_core.governance_settings (
 tenant_id uuid primary key references core.tenants(id),
 enabled boolean not null default false,
 updated_by_subject_id uuid not null references access_control.subjects(id),
 updated_at timestamptz not null default now()
);
alter table accounting_core.refunds
 add column operational_effect text check(operational_effect in ('cancel_registration','price_adjustment','credit_transfer')),
 add column settlement_kind text not null default 'cash' check(settlement_kind in ('cash','credit')),
 add column handoff_id uuid,
 add constraint refund_handoff_tenant_fk foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id);
create index refunds_handoff_idx on accounting_core.refunds(tenant_id,handoff_id) where handoff_id is not null;

-- Append-only evidence supplements, rather than replaces, canonical payments.
create table accounting_core.payment_evidence_events (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),
 payment_id uuid not null, event_type text not null, actor_subject_id uuid references access_control.subjects(id),
 before_data jsonb, after_data jsonb not null, occurred_at timestamptz not null default now(),
 foreign key(tenant_id,payment_id) references accounting_core.payments(tenant_id,id)
);
create index payment_evidence_timeline_idx on accounting_core.payment_evidence_events(tenant_id,payment_id,occurred_at,id);
create table accounting_core.customer_credits (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),
 customer_account_id uuid not null, source_refund_id uuid not null,
 amount_minor bigint not null check(amount_minor>0), currency text not null check(currency~'^[A-Z]{3}$'),
 created_at timestamptz not null default now(), unique(tenant_id,id), unique(tenant_id,source_refund_id),
 foreign key(tenant_id,customer_account_id) references accounting_core.customer_accounts(tenant_id,id),
 foreign key(tenant_id,source_refund_id) references accounting_core.refunds(tenant_id,id)
);
create table accounting_core.customer_credit_applications (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),
 credit_id uuid not null, invoice_id uuid not null, amount_minor bigint not null check(amount_minor>0),
 actor_subject_id uuid not null references access_control.subjects(id), created_at timestamptz not null default now(),
 foreign key(tenant_id,credit_id) references accounting_core.customer_credits(tenant_id,id),
 foreign key(tenant_id,invoice_id) references accounting_core.sales_documents(tenant_id,id)
);
create index customer_credits_account_idx on accounting_core.customer_credits(tenant_id,customer_account_id);
create index credit_applications_credit_idx on accounting_core.customer_credit_applications(tenant_id,credit_id);
create index credit_applications_invoice_idx on accounting_core.customer_credit_applications(tenant_id,invoice_id);
create unique index incentive_events_tenant_id_unique on incentives_core.events(tenant_id,id);
create table accounting_core.incentive_adjustment_reviews (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),
 refund_id uuid not null, incentive_event_id uuid not null,
 original_amount numeric not null, proposed_reduction numeric not null check(proposed_reduction>=0),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 reviewed_by_subject_id uuid references access_control.subjects(id), reviewed_at timestamptz, reason text,
 created_at timestamptz not null default now(), unique(tenant_id,refund_id,incentive_event_id),
 foreign key(tenant_id,refund_id) references accounting_core.refunds(tenant_id,id),
 foreign key(tenant_id,incentive_event_id) references incentives_core.events(tenant_id,id)
);
create index incentive_adjustment_queue_idx on accounting_core.incentive_adjustment_reviews(tenant_id,status,created_at,id);
create index incentive_adjustment_event_idx on accounting_core.incentive_adjustment_reviews(incentive_event_id);
do $$ declare n text; begin
 foreach n in array array['governance_settings','payment_evidence_events','customer_credits','customer_credit_applications','incentive_adjustment_reviews'] loop
  execute format('alter table accounting_core.%I enable row level security',n);
  execute format('alter table accounting_core.%I force row level security',n);
  execute format('revoke all on accounting_core.%I from public,anon,authenticated',n);
 end loop;
end $$;
create trigger payment_evidence_append_only before update or delete on accounting_core.payment_evidence_events
 for each row execute function private_app.accounting_append_only();
create trigger customer_credit_append_only before update or delete on accounting_core.customer_credits
 for each row execute function private_app.accounting_append_only();
create trigger customer_credit_application_append_only before update or delete on accounting_core.customer_credit_applications
 for each row execute function private_app.accounting_append_only();

create function private_app.accounting_payment_evidence_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and old.status in ('verified','refunded') and (
  new.amount_minor is distinct from old.amount_minor or new.currency is distinct from old.currency
  or new.customer_account_id is distinct from old.customer_account_id or new.tenant_id is distinct from old.tenant_id
  or new.received_at is distinct from old.received_at or new.verified_at is distinct from old.verified_at
  or new.verified_by_subject_id is distinct from old.verified_by_subject_id or new.method is distinct from old.method
  or new.external_reference is distinct from old.external_reference or new.source_type is distinct from old.source_type
  or new.source_id is distinct from old.source_id or new.status not in ('verified','refunded')
  or new.metadata->'attribution' is distinct from old.metadata->'attribution'
  or new.metadata->'opportunityId' is distinct from old.metadata->'opportunityId'
  or (old.status='refunded' and new.status<>'refunded'))
 then raise exception 'verified_payment_immutable'; end if;
 if tg_op='INSERT' or row(new.status,new.amount_minor,new.currency,new.verified_at) is distinct from row(old.status,old.amount_minor,old.currency,old.verified_at) then
  insert into accounting_core.payment_evidence_events(tenant_id,payment_id,event_type,actor_subject_id,before_data,after_data)
  values(new.tenant_id,new.id,case when tg_op='INSERT' then 'recorded' else 'status_changed' end,
   private_app.current_subject_id(),case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
 end if;
 if new.source_type='registration_handoff' and new.status in ('verified','refunded')
  and to_regprocedure('private_app.queue_admission_governance_v1(uuid,uuid)') is not null then
  execute 'select private_app.queue_admission_governance_v1($1,$2)' using new.tenant_id,new.source_id::uuid;
 end if;
 return new;
end $$;
-- AFTER ensures the canonical payment exists for the evidence foreign key.
create trigger accounting_payment_evidence_guard after insert or update on accounting_core.payments
 for each row execute function private_app.accounting_payment_evidence_guard_v1();

create function private_app.accounting_payment_available_v1(p_tenant uuid,p_payment uuid) returns bigint
language sql stable set search_path='' as $$
 select greatest(0,p.amount_minor
  -coalesce((select sum(r.amount_minor) from accounting_core.refunds r where r.tenant_id=p_tenant and r.payment_id=p.id and r.status in ('requested','approved','completed')),0)
  -coalesce((select sum(greatest(0,a.amount_minor-coalesce((select sum(r.amount_minor) from accounting_core.refunds r
    where r.tenant_id=p_tenant and r.payment_id=p.id and r.status='completed' and r.invoice_id=a.invoice_id),0)))
    from accounting_core.payment_allocations a where a.tenant_id=p_tenant and a.payment_id=p.id),0))::bigint
 from accounting_core.payments p where p.tenant_id=p_tenant and p.id=p_payment
$$;

create function private_app.accounting_invoice_net_v1(p_tenant_id uuid,p_invoice_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d accounting_core.sales_documents%rowtype; total bigint; paid bigint;
begin
 select * into d from accounting_core.sales_documents where tenant_id=p_tenant_id and id=p_invoice_id
  and document_type in ('invoice','debit_note') and status='issued';
 if d.id is null then return jsonb_build_object('invoiceId',p_invoice_id,'totalMinor',null,'paidMinor',0,'outstandingMinor',null); end if;
 select greatest(0,d.total_minor-coalesce(sum(total_minor),0)) into total from accounting_core.sales_documents
  where tenant_id=p_tenant_id and parent_document_id=d.id and document_type='credit_note' and status='issued' and currency=d.currency;
 if exists(select 1 from accounting_core.refunds r join accounting_core.payment_allocations a
  on a.tenant_id=r.tenant_id and a.payment_id=r.payment_id where r.tenant_id=p_tenant_id and a.invoice_id=d.id
   and r.status='completed' and r.invoice_id is null) then
  return jsonb_build_object('invoiceId',d.id,'currency',d.currency,'totalMinor',total,'paidMinor',null,'outstandingMinor',null,'requiresReview',true,'reason','refund_invoice_allocation_required');
 end if;
 select coalesce(sum(greatest(0,a.amount_minor-coalesce((select sum(r.amount_minor) from accounting_core.refunds r
  where r.tenant_id=p_tenant_id and r.payment_id=p.id and r.status='completed' and r.invoice_id=d.id),0))),0)
 into paid from accounting_core.payment_allocations a join accounting_core.payments p on p.tenant_id=a.tenant_id and p.id=a.payment_id
 where a.tenant_id=p_tenant_id and a.invoice_id=d.id and p.status in ('verified','refunded') and p.currency=d.currency
  and (p.status='verified' or exists(select 1 from accounting_core.refunds r where r.tenant_id=p_tenant_id and r.payment_id=p.id and r.status='completed'));
 select paid+coalesce(sum(a.amount_minor),0) into paid from accounting_core.customer_credit_applications a
  join accounting_core.customer_credits c on c.tenant_id=a.tenant_id and c.id=a.credit_id
  where a.tenant_id=p_tenant_id and a.invoice_id=d.id and c.currency=d.currency and c.customer_account_id=d.customer_account_id;
 return jsonb_build_object('invoiceId',d.id,'currency',d.currency,'totalMinor',total,'paidMinor',paid,'outstandingMinor',greatest(0,total-paid));
end $$;

create function private_app.admission_cash_currency_v1(p_tenant uuid,p_handoff uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare cur text; n integer;
begin
 select d.currency into cur from academy.training_financial_links l join accounting_core.sales_documents d on d.tenant_id=l.tenant_id and d.id=l.invoice_id where l.tenant_id=p_tenant and l.handoff_id=p_handoff;
 if cur is not null then return cur; end if;
 select count(distinct currency),min(currency) into n,cur from accounting_core.payments where tenant_id=p_tenant and source_type='registration_handoff' and source_id=p_handoff::text and status in ('verified','refunded');
 if n=1 then return cur; elsif n>1 then return null; end if;
 select nullif(metadata->>'currency','') into cur from academy.registration_handoffs where tenant_id=p_tenant and id=p_handoff and payment_status='verified';
 return cur;
end $$;

create function private_app.admission_verified_cash_v1(p_tenant uuid,p_handoff uuid) returns bigint
language plpgsql stable security definer set search_path='' as $$
declare invoice uuid; amount bigint; found_payment boolean;
begin
 select invoice_id into invoice from academy.training_financial_links where tenant_id=p_tenant and handoff_id=p_handoff;
 if invoice is not null then return coalesce((private_app.accounting_invoice_net_v1(p_tenant,invoice)->>'paidMinor')::bigint,0); end if;
 select count(*)>0,coalesce(sum(case when p.status in ('verified','refunded') then greatest(0,p.amount_minor-coalesce((select sum(r.amount_minor)
  from accounting_core.refunds r where r.tenant_id=p_tenant and r.payment_id=p.id and r.status='completed'),0)) else 0 end),0)
 into found_payment,amount from accounting_core.payments p where p.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=p_handoff::text;
 if found_payment then return amount; end if;
 select payment_amount_minor into amount from academy.registration_handoffs where tenant_id=p_tenant and id=p_handoff and payment_status='verified';
 return coalesce(amount,0);
end $$;

-- Used by every writer, including training pilot code that inserts allocations directly.
create function private_app.accounting_allocation_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare p accounting_core.payments%rowtype; d accounting_core.sales_documents%rowtype; delta bigint; f jsonb;
begin
 if tg_op='UPDATE' and (new.tenant_id<>old.tenant_id or new.payment_id<>old.payment_id or new.invoice_id<>old.invoice_id or new.amount_minor<old.amount_minor)
 then raise exception 'allocation_history_immutable'; end if;
 select * into p from accounting_core.payments where tenant_id=new.tenant_id and id=new.payment_id for update;
 select * into d from accounting_core.sales_documents where tenant_id=new.tenant_id and id=new.invoice_id for update;
 if p.id is null or d.id is null or p.status<>'verified' or d.status<>'issued' or d.document_type not in ('invoice','debit_note') then raise exception 'allocation_target_invalid'; end if;
 if p.customer_account_id<>d.customer_account_id then raise exception 'allocation_customer_mismatch'; end if;
 if p.currency<>d.currency then raise exception 'allocation_currency_mismatch'; end if;
 delta:=new.amount_minor-case when tg_op='UPDATE' then old.amount_minor else 0 end;
 if delta>private_app.accounting_payment_available_v1(new.tenant_id,p.id) then raise exception 'payment_allocation_exceeds_available'; end if;
 f:=private_app.accounting_invoice_net_v1(new.tenant_id,d.id);
 if delta>coalesce((f->>'outstandingMinor')::bigint,0) then raise exception 'payment_allocation_exceeds_invoice'; end if;
 return new;
end $$;
create trigger accounting_allocation_guard before insert or update on accounting_core.payment_allocations
 for each row execute function private_app.accounting_allocation_guard_v1();

create function private_app.import_verified_handoff_v1(p_tenant uuid,p_handoff uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h academy.registration_handoffs%rowtype; c sales_core.contacts%rowtype; a accounting_core.customer_accounts%rowtype;
 p accounting_core.payments%rowtype; cur text; method text; received timestamptz; tz text;
begin
 select * into h from academy.registration_handoffs where tenant_id=p_tenant and id=p_handoff for update;
 if h.id is null then raise exception 'admission_not_found'; end if;
 if exists(select 1 from academy.training_financial_links where tenant_id=p_tenant and handoff_id=p_handoff) then
  return jsonb_build_object('success',true,'handoffId',p_handoff,'linkedInvoice',true);
 end if;
 select * into p from accounting_core.payments where tenant_id=p_tenant and source_type='registration_handoff' and source_id=p_handoff::text;
 if p.id is not null then return jsonb_build_object('success',true,'paymentId',p.id,'paymentNumber',p.payment_number,'status',p.status,'replayed',true); end if;
 if h.payment_status<>'verified' or h.payment_verified_at is null or coalesce(h.payment_amount_minor,0)<=0 then raise exception 'verified_handoff_not_found'; end if;
 select * into c from sales_core.contacts where tenant_id=p_tenant and id=h.contact_id for update;
 select * into a from accounting_core.customer_accounts where tenant_id=p_tenant and contact_id=c.id;
 select timezone into tz from core.tenants where id=p_tenant;
 if a.id is null then
  insert into accounting_core.customer_accounts(tenant_id,contact_id,account_number,display_name,organization_name,billing_email,billing_phone,created_by_subject_id,updated_by_subject_id)
  values(p_tenant,c.id,private_app.accounting_next_number(p_tenant,'customer',(now() at time zone tz)::date,'CUS'),c.full_name,c.organization_name,c.email,c.phone,private_app.current_subject_id(),private_app.current_subject_id()) returning * into a;
 end if;
 select coalesce(nullif(h.metadata->>'currency',''),o.currency,pr.base_currency,'SAR') into cur
 from (select 1) seed left join sales_core.opportunities o on o.tenant_id=p_tenant and o.id=h.opportunity_id
 left join accounting_core.tenant_profiles pr on pr.tenant_id=p_tenant;
 method:=coalesce(nullif(h.metadata->>'paymentMethod',''),case when h.metadata->>'source'='woocommerce_order' then 'store' else 'other' end);
 if method not in ('bank_transfer','cash','mada','tamara','paymob','paypal','store','other') then method:='other'; end if;
 received:=coalesce(h.paid_at,h.payment_verified_at);
 insert into accounting_core.payments(tenant_id,customer_account_id,payment_number,amount_minor,currency,method,status,
  external_reference,source_type,source_id,received_at,verified_at,verified_by_subject_id,created_by_subject_id,metadata)
 values(p_tenant,a.id,private_app.accounting_next_number(p_tenant,'payment',(received at time zone tz)::date,'PAY'),
  h.payment_amount_minor,upper(cur),method,'verified',h.payment_reference,'registration_handoff',h.id::text,received,h.payment_verified_at,
  coalesce(h.payment_verified_by_subject_id,private_app.current_subject_id()),private_app.current_subject_id(),
  jsonb_build_object('handoffId',h.id,'opportunityId',h.opportunity_id,'attribution',(select metadata->'attribution' from sales_core.opportunities where tenant_id=p_tenant and id=h.opportunity_id),
   'sourceMetadata',h.metadata,'importedAt',now(),'originalVerifierMissing',h.payment_verified_by_subject_id is null)) returning * into p;
 return jsonb_build_object('success',true,'paymentId',p.id,'paymentNumber',p.payment_number,'status',p.status);
end $$;

alter function private_app.update_admission_before_commerce_v1(text,uuid,text,uuid,uuid,text,text)
 rename to update_admission_before_financial_governance_v1;
-- Preserve the legacy workflow while permitting only the explicit payment
-- capability to cross its old general-admissions-write boundary. Fail on drift.
do $guard$
declare definition text; needle text:=$needle$private_app.has_tenant_permission(v_tenant_id, 'tenant.admissions.write')$needle$;
begin
 definition:=pg_get_functiondef('private_app.update_admission_before_financial_governance_v1(text,uuid,text,uuid,uuid,text,text)'::regprocedure);
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'admission_payment_permission_baseline_changed'; end if;
 execute replace(definition,needle,needle||$replacement$
    or (p_action in ('verify_payment','reject_payment') and
     (private_app.has_tenant_permission(v_tenant_id,'tenant.admissions.payment.verify')
      or private_app.has_accounting_permission(v_tenant_id,'tenant.accounting.payments.approve')))$replacement$);
end $guard$;
create function private_app.update_admission_before_commerce_v1(p_tenant_slug text,p_handoff_id uuid,p_action text,p_course_id uuid default null,p_course_run_id uuid default null,p_notes text default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; h academy.registration_handoffs%rowtype; result jsonb; original_value bigint;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if auth.uid() is null or t is null then raise exception 'forbidden' using errcode='42501'; end if;
 select * into h from academy.registration_handoffs where tenant_id=t and id=p_handoff_id for update;
 if h.id is null then raise exception 'admission_not_found'; end if;
 if p_action in ('verify_payment','reject_payment') then
  if not private_app.has_tenant_permission(t,'tenant.admissions.write')
   and (p_course_id is not null or p_course_run_id is not null or p_notes is not null) then raise exception 'forbidden' using errcode='42501'; end if;
  if not (private_app.has_accounting_permission(t,'tenant.accounting.payments.approve')
   or private_app.has_tenant_permission(t,'tenant.admissions.payment.verify')
   or (exists(select 1 from academy.training_financial_links where tenant_id=t and handoff_id=h.id)
     and private_app.training_journey_payment_authorized_v1(t))) then raise exception 'payment_approval_permission_required' using errcode='42501'; end if;
  if p_action='reject_payment' and h.payment_status in ('verified','refunded') then raise exception 'verified_payment_requires_adjustment'; end if;
  if p_action='verify_payment' and h.payment_status='verified' then
   return jsonb_build_object('id',h.id,'action',p_action,'status',h.status,'paymentStatus',h.payment_status,'replayed',true);
  end if;
  if p_action='verify_payment' and coalesce(h.payment_amount_minor,0)<=0 and not exists(
   select 1 from academy.training_financial_links where tenant_id=t and handoff_id=h.id)
  then raise exception 'positive_payment_evidence_required'; end if;
 end if;
 select value_minor into original_value from sales_core.opportunities where tenant_id=t and id=h.opportunity_id;
 result:=private_app.update_admission_before_financial_governance_v1(p_tenant_slug,p_handoff_id,p_action,p_course_id,p_course_run_id,p_notes,p_reason);
 if p_action='verify_payment' then
  update sales_core.opportunities set value_minor=original_value where tenant_id=t and id=h.opportunity_id;
 end if;
 if to_regprocedure('private_app.sync_customer_sales_task_v1(uuid,uuid)') is not null then
  execute 'select private_app.sync_customer_sales_task_v1($1,$2)' using t,h.contact_id;
 end if;
 return result;
end $$;

create function private_app.accounting_handoff_import_trigger_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.payment_status='verified' and (tg_op='INSERT' or old.payment_status is distinct from 'verified')
  and exists(select 1 from accounting_core.governance_settings where tenant_id=new.tenant_id and enabled)
  and coalesce(new.payment_amount_minor,0)>0 then
  perform private_app.import_verified_handoff_v1(new.tenant_id,new.id);
 end if;
 return new;
end $$;
create trigger accounting_verified_handoff_import after insert or update of payment_status on academy.registration_handoffs
 for each row execute function private_app.accounting_handoff_import_trigger_v1();

-- Preserve the existing public API, move the prior implementation out of reach.
alter function public.v1_tenant_accounting_action(text,text,jsonb) set schema private_app;
alter function private_app.v1_tenant_accounting_action(text,text,jsonb) rename to accounting_action_before_governance_v1;
create function public.v1_tenant_accounting_action(p_slug text,p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid; actor uuid:=private_app.current_subject_id(); cmd uuid; oldcmd accounting_core.commands%rowtype;
 r accounting_core.refunds%rowtype; p accounting_core.payments%rowtype; d accounting_core.sales_documents%rowtype;
 credit accounting_core.customer_credits%rowtype; result jsonb; amount bigint; used bigint; hid uuid; invoice_hid uuid; locked_hid uuid; effect text; f jsonb;
begin
 select id into t from core.tenants where slug=p_slug and status in ('trial','active');
 if auth.uid() is null or actor is null or t is null or not private_app.has_accounting_permission(t,'tenant.accounting.read') then raise exception 'forbidden' using errcode='42501'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'accounting_payload_invalid'; end if;
 cmd:=nullif(p_payload->>'commandId','')::uuid;
 if cmd is null then raise exception 'command_id_required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||cmd::text,92121));
 select * into oldcmd from accounting_core.commands where tenant_id=t and command_id=cmd;
 if oldcmd.command_id is not null then
  if oldcmd.actor_subject_id is distinct from actor or oldcmd.action<>p_action or oldcmd.request_hash<>md5(p_payload::text) then raise exception 'command_id_reused_with_different_payload'; end if;
  return oldcmd.response;
 end if;
 if p_action in ('preview_governance','set_governance') then
  if not private_app.has_accounting_permission(t,'tenant.accounting.settings.manage') then raise exception 'forbidden' using errcode='42501'; end if;
  result:=jsonb_build_object('enabled',coalesce((select enabled from accounting_core.governance_settings where tenant_id=t),false),
   'futureVerifiedPaymentsOnly',true,'historicalRowsModified',0,
   'legacyVerifiedUnimported',(select count(*) from academy.registration_handoffs h where h.tenant_id=t and h.payment_status='verified'
    and not exists(select 1 from accounting_core.payments pay where pay.tenant_id=t and pay.source_type='registration_handoff' and pay.source_id=h.id::text)
    and not exists(select 1 from academy.training_financial_links l where l.tenant_id=t and l.handoff_id=h.id)));
  if p_action='set_governance' then
   if p_payload->>'confirmation' is distinct from 'ENABLE_FINANCIAL_GOVERNANCE' or jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' then raise exception 'governance_confirmation_required'; end if;
   insert into accounting_core.governance_settings(tenant_id,enabled,updated_by_subject_id) values(t,(p_payload->>'enabled')::boolean,actor)
   on conflict(tenant_id) do update set enabled=excluded.enabled,updated_by_subject_id=actor,updated_at=now();
   result:=result||jsonb_build_object('enabled',(p_payload->>'enabled')::boolean);
  end if;
 elsif p_action='import_handoff_payment' then
  if not private_app.has_accounting_permission(t,'tenant.accounting.payments.approve') then raise exception 'forbidden' using errcode='42501'; end if;
  result:=private_app.import_verified_handoff_v1(t,(p_payload->>'handoffId')::uuid);
 elsif p_action='review_incentive_adjustment' then
  if not private_app.has_accounting_permission(t,'tenant.accounting.incentives.approve') then raise exception 'forbidden' using errcode='42501'; end if;
  if coalesce(p_payload->>'decision','') not in ('approved','rejected') or length(btrim(coalesce(p_payload->>'reason','')))<3 then raise exception 'adjustment_review_required'; end if;
  update accounting_core.incentive_adjustment_reviews set status=p_payload->>'decision',reason=p_payload->>'reason',reviewed_by_subject_id=actor,reviewed_at=now()
   where tenant_id=t and id=(p_payload->>'reviewId')::uuid and status='pending';
  if not found then raise exception 'adjustment_not_pending'; end if;
 result:=jsonb_build_object('success',true,'reviewId',p_payload->>'reviewId','status',p_payload->>'decision','payrollChanged',false);
 elsif p_action='classify_refund' then
  if not private_app.has_accounting_permission(t,'tenant.accounting.refunds.approve') then raise exception 'forbidden' using errcode='42501'; end if;
  select * into r from accounting_core.refunds where tenant_id=t and id=(p_payload->>'refundId')::uuid;
  select * into p from accounting_core.payments where tenant_id=t and id=r.payment_id for update;
  select * into r from accounting_core.refunds where tenant_id=t and id=r.id for update;
  if r.id is null or r.status not in ('requested','approved') then raise exception 'refund_not_classifiable'; end if;
  effect:=p_payload->>'effect';
  if coalesce(effect,'') not in ('cancel_registration','price_adjustment','credit_transfer') or length(btrim(coalesce(p_payload->>'reason','')))<3 then raise exception 'refund_effect_required'; end if;
  select * into d from accounting_core.sales_documents where tenant_id=t and id=nullif(p_payload->>'invoiceId','')::uuid;
  invoice_hid:=private_app.accounting_invoice_handoff_v1(t,d.id);
  hid:=coalesce(nullif(p_payload->>'handoffId','')::uuid,invoice_hid,case when p.source_type='registration_handoff' then p.source_id::uuid end);
  if invoice_hid is not null and hid is distinct from invoice_hid then raise exception 'refund_handoff_mismatch'; end if;
  if exists(select 1 from accounting_core.payment_allocations where tenant_id=t and payment_id=p.id) and d.id is null then raise exception 'refund_invoice_required'; end if;
  if d.id is not null then
   select a.amount_minor-coalesce((select sum(rr.amount_minor) from accounting_core.refunds rr where rr.tenant_id=t and rr.payment_id=p.id and rr.invoice_id=a.invoice_id and rr.id<>r.id and rr.status in ('requested','approved','completed')),0)
    into amount from accounting_core.payment_allocations a where a.tenant_id=t and a.payment_id=p.id and a.invoice_id=d.id;
   if amount is null or r.amount_minor>amount then raise exception 'refund_exceeds_invoice_allocation'; end if;
  end if;
  if hid is not null and not exists(select 1 from academy.registration_handoffs h where h.tenant_id=t and h.id=hid
   and ((p.source_type='registration_handoff' and p.source_id=h.id::text) or private_app.accounting_invoice_handoff_v1(t,d.id)=h.id)) then raise exception 'refund_handoff_mismatch'; end if;
  if effect='cancel_registration' and hid is null then raise exception 'refund_handoff_required'; end if;
  result:=jsonb_build_object('success',true,'refundId',r.id,'previousEffect',r.operational_effect,'previousStatus',r.status,'previousInvoiceId',r.invoice_id,'status','requested');
  update accounting_core.refunds set operational_effect=effect,settlement_kind=case when effect='credit_transfer' then 'credit' else 'cash' end,
   handoff_id=hid,invoice_id=d.id,credit_note_id=nullif(p_payload->>'creditNoteId','')::uuid,reason=p_payload->>'reason',
   status='requested',requested_by_subject_id=actor,approved_by_subject_id=null,approved_at=null,updated_at=now() where tenant_id=t and id=r.id;
 elsif p_action='apply_customer_credit' then
  if not private_app.has_accounting_permission(t,'tenant.accounting.payments.approve') then raise exception 'forbidden' using errcode='42501'; end if;
  select * into credit from accounting_core.customer_credits where tenant_id=t and id=(p_payload->>'creditId')::uuid for update;
  select * into d from accounting_core.sales_documents where tenant_id=t and id=(p_payload->>'invoiceId')::uuid for update;
  if credit.id is null or d.id is null or d.status<>'issued' or d.document_type<>'invoice' or d.customer_account_id<>credit.customer_account_id or d.currency<>credit.currency then raise exception 'credit_target_invalid'; end if;
  amount:=(p_payload->>'amountMinor')::bigint;
  select coalesce(sum(amount_minor),0) into used from accounting_core.customer_credit_applications where tenant_id=t and credit_id=credit.id;
  f:=private_app.accounting_invoice_net_v1(t,d.id);
  if amount is null or amount<=0 or amount>credit.amount_minor-used or amount>coalesce((f->>'outstandingMinor')::bigint,0) then raise exception 'credit_exceeds_available'; end if;
  insert into accounting_core.customer_credit_applications(tenant_id,credit_id,invoice_id,amount_minor,actor_subject_id) values(t,credit.id,d.id,amount,actor);
  result:=jsonb_build_object('success',true,'creditId',credit.id,'invoiceId',d.id,'amountMinor',amount);
  perform private_app.accounting_reconcile_invoice_v1(t,d.id);
 else
  if p_action in ('record_payment','create_document') and coalesce(nullif(p_payload->>'currency',''),coalesce((select base_currency from accounting_core.tenant_profiles where tenant_id=t),'SAR'))
   <>coalesce((select base_currency from accounting_core.tenant_profiles where tenant_id=t),'SAR') then raise exception 'tenant_currency_mismatch'; end if;
  if p_action='verify_payment' then
   select * into p from accounting_core.payments where tenant_id=t and id=(p_payload->>'paymentId')::uuid for update;
   if not private_app.has_accounting_permission(t,'tenant.accounting.payments.approve') then raise exception 'forbidden' using errcode='42501'; end if;
   if p.status='verified' then result:=jsonb_build_object('success',true,'paymentId',p.id,'status',p.status,'replayed',true); end if;
  end if;
  if p_action in ('approve_refund','complete_refund','reject_refund') then
   -- Existing pilot verification holds handoff before payment. Completion can
   -- change that handoff, so use the same order; classification races retry.
   select * into r from accounting_core.refunds where tenant_id=t and id=(p_payload->>'refundId')::uuid;
   if p_action='complete_refund' then
    locked_hid:=r.handoff_id;
    perform 1 from academy.registration_handoffs where tenant_id=t and id=locked_hid for update;
   end if;
   select * into p from accounting_core.payments where tenant_id=t and id=r.payment_id for update;
   select * into r from accounting_core.refunds where tenant_id=t and id=r.id for update;
   if r.id is null then raise exception 'refund_not_found'; end if;
   if p_action='complete_refund' and r.handoff_id is distinct from locked_hid then raise exception 'refund_changed_retry'; end if;
   if p_action='approve_refund' and r.requested_by_subject_id=actor then raise exception 'refund_self_approval_forbidden'; end if;
   if p_action='complete_refund' then
    -- Two payments may use one issued credit note. Serialize consumption of the
    -- note independently of payment locks before checking its remaining cover.
    if r.credit_note_id is not null then perform pg_advisory_xact_lock(hashtextextended(t::text||':'||r.credit_note_id::text,92623)); end if;
    if r.operational_effect is null then raise exception 'refund_effect_required'; end if;
    if r.operational_effect='cancel_registration' and exists(select 1 from academy.enrollments e where e.tenant_id=t and e.handoff_id=r.handoff_id
     and (e.status='completed' or exists(select 1 from academy.certificates c where c.tenant_id=t and c.enrollment_id=e.id and c.status='issued')))
     then raise exception 'completed_training_requires_reversal_review'; end if;
    if r.settlement_kind='cash' and length(btrim(coalesce(p_payload->>'externalReference','')))<3 then raise exception 'refund_execution_reference_required'; end if;
    if r.invoice_id is not null and (r.credit_note_id is null or not exists(select 1 from accounting_core.sales_documents cn
     where cn.tenant_id=t and cn.id=r.credit_note_id and cn.parent_document_id=r.invoice_id and cn.document_type='credit_note'
      and cn.status='issued' and cn.currency=p.currency and cn.customer_account_id=p.customer_account_id
      and cn.total_minor>=r.amount_minor+coalesce((select sum(rr.amount_minor) from accounting_core.refunds rr where rr.tenant_id=t and rr.credit_note_id=cn.id and rr.id<>r.id and rr.status='completed'),0)))
    then raise exception 'refund_linked_credit_note_required'; end if;
   end if;
  end if;
  if p_action='request_refund' then
   effect:=p_payload->>'effect'; hid:=nullif(p_payload->>'handoffId','')::uuid;
   if effect is null or effect not in ('cancel_registration','price_adjustment','credit_transfer') then raise exception 'refund_effect_required'; end if;
   select * into p from accounting_core.payments where tenant_id=t and id=(p_payload->>'paymentId')::uuid for update;
   if p.id is null then raise exception 'payment_not_refundable'; end if;
   invoice_hid:=private_app.accounting_invoice_handoff_v1(t,nullif(p_payload->>'invoiceId','')::uuid);
   hid:=coalesce(hid,invoice_hid,case when p.source_type='registration_handoff' then p.source_id::uuid end);
   if invoice_hid is not null and hid is distinct from invoice_hid then raise exception 'refund_handoff_mismatch'; end if;
   if hid is not null and not exists(select 1 from academy.registration_handoffs h where h.tenant_id=t and h.id=hid
    and ((p.source_type='registration_handoff' and p.source_id=h.id::text) or invoice_hid=h.id)) then raise exception 'refund_handoff_mismatch'; end if;
   if effect='cancel_registration' and hid is null then raise exception 'refund_handoff_required'; end if;
   if exists(select 1 from accounting_core.payment_allocations where tenant_id=t and payment_id=p.id) and nullif(p_payload->>'invoiceId','') is null then raise exception 'refund_invoice_required'; end if;
   if nullif(p_payload->>'invoiceId','') is not null and not exists(select 1 from accounting_core.payment_allocations where tenant_id=t and payment_id=p.id and invoice_id=(p_payload->>'invoiceId')::uuid) then raise exception 'refund_invoice_allocation_required'; end if;
   if nullif(p_payload->>'invoiceId','') is not null then
    select a.amount_minor-coalesce((select sum(rr.amount_minor) from accounting_core.refunds rr where rr.tenant_id=t and rr.payment_id=p.id and rr.invoice_id=a.invoice_id and rr.status in ('requested','approved','completed')),0)
      into amount from accounting_core.payment_allocations a where a.tenant_id=t and a.payment_id=p.id and a.invoice_id=(p_payload->>'invoiceId')::uuid;
    if (p_payload->>'amountMinor')::bigint>amount then raise exception 'refund_exceeds_invoice_allocation'; end if;
   end if;
  end if;
  if result is null then
   result:=private_app.accounting_action_before_governance_v1(p_slug,p_action,p_payload);
   -- Legacy writes its command row itself; the wrapper only appends guarded effects.
   if p_action='request_refund' then
    update accounting_core.refunds set operational_effect=effect,settlement_kind=case when effect='credit_transfer' then 'credit' else 'cash' end,handoff_id=hid
     where tenant_id=t and id=(result->>'refundId')::uuid;
   elsif p_action='complete_refund' then
    perform private_app.accounting_apply_refund_effect_v1(t,r.id);
    if r.invoice_id is not null then perform private_app.accounting_reconcile_invoice_v1(t,r.invoice_id); end if;
   end if;
  end if;
 end if;
 perform private_app.write_audit('accounting.governance.'||p_action,'tenant_accounting',coalesce(result->>'paymentId',result->>'refundId',result->>'reviewId'),t,jsonb_build_object('commandId',cmd,'result',result));
 insert into accounting_core.commands(tenant_id,command_id,action,request_hash,response,actor_subject_id)
 values(t,cmd,p_action,md5(p_payload::text),result,actor) on conflict(tenant_id,command_id) do nothing;
 return result;
end $$;

create function private_app.accounting_reconcile_invoice_v1(p_tenant uuid,p_invoice uuid) returns void
language plpgsql security definer set search_path='' as $$
declare hid uuid; contract uuid;
begin
 if to_regprocedure('private_app.queue_admission_governance_v1(uuid,uuid)') is not null then
  for hid in select handoff_id from academy.training_financial_links where tenant_id=p_tenant and invoice_id=p_invoice loop
   execute 'select private_app.queue_admission_governance_v1($1,$2)' using p_tenant,hid;
  end loop;
 end if;
 if to_regclass('academy.diploma_invoice_links') is not null and to_regprocedure('private_app.queue_diploma_collection_v1(uuid,uuid)') is not null then
  for contract in execute 'select distinct contract_id from academy.diploma_invoice_links where tenant_id=$1 and invoice_id=$2' using p_tenant,p_invoice loop
   execute 'select private_app.queue_diploma_collection_v1($1,$2)' using p_tenant,contract;
   if to_regprocedure('private_app.queue_admission_governance_v1(uuid,uuid)') is not null then
    execute 'select handoff_id from academy.diploma_contracts where tenant_id=$1 and id=$2' into hid using p_tenant,contract;
    execute 'select private_app.queue_admission_governance_v1($1,$2)' using p_tenant,hid;
   end if;
  end loop;
 end if;
end $$;
create function private_app.accounting_allocation_reconcile_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform private_app.accounting_reconcile_invoice_v1(new.tenant_id,new.invoice_id);
 return new;
end $$;
create trigger accounting_allocation_reconcile after insert or update on accounting_core.payment_allocations
 for each row execute function private_app.accounting_allocation_reconcile_v1();

-- A credit note changes the invoice's authoritative total even before a refund.
create function private_app.accounting_credit_note_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare parent accounting_core.sales_documents%rowtype; prior bigint;
begin
 if new.document_type='credit_note' and new.status='issued' and (tg_op='INSERT' or old.status is distinct from 'issued') then
  select * into parent from accounting_core.sales_documents where tenant_id=new.tenant_id and id=new.parent_document_id for update;
  if parent.id is null or parent.status<>'issued' or parent.document_type not in ('invoice','debit_note')
   or parent.currency<>new.currency or parent.customer_account_id<>new.customer_account_id then raise exception 'credit_note_parent_invalid'; end if;
  select coalesce(sum(total_minor),0) into prior from accounting_core.sales_documents where tenant_id=new.tenant_id and parent_document_id=parent.id and document_type='credit_note' and status='issued' and id<>new.id;
  if new.total_minor+prior>parent.total_minor then raise exception 'credit_note_exceeds_invoice'; end if;
 end if;
 return new;
end $$;
create trigger accounting_credit_note_guard before insert or update on accounting_core.sales_documents
 for each row execute function private_app.accounting_credit_note_guard_v1();
create function private_app.accounting_document_reconcile_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.status='issued' then perform private_app.accounting_reconcile_invoice_v1(new.tenant_id,coalesce(new.parent_document_id,new.id)); end if;
 return new;
end $$;
create trigger accounting_document_reconcile after insert or update on accounting_core.sales_documents
 for each row execute function private_app.accounting_document_reconcile_v1();

create function private_app.accounting_apply_refund_effect_v1(p_tenant uuid,p_refund uuid) returns void
language plpgsql security definer set search_path='' as $$
declare r accounting_core.refunds%rowtype; p accounting_core.payments%rowtype; h academy.registration_handoffs%rowtype; deadline timestamptz:=now()+interval '1 day';
begin
 select * into r from accounting_core.refunds where tenant_id=p_tenant and id=p_refund and status='completed';
 if r.id is null then raise exception 'refund_not_completed'; end if;
 select * into p from accounting_core.payments where tenant_id=p_tenant and id=r.payment_id;
 if r.settlement_kind='credit' then
  insert into accounting_core.customer_credits(tenant_id,customer_account_id,source_refund_id,amount_minor,currency)
  values(p_tenant,r.customer_account_id,r.id,r.amount_minor,p.currency) on conflict(tenant_id,source_refund_id) do nothing;
 end if;
 select * into h from academy.registration_handoffs where tenant_id=p_tenant and id=r.handoff_id for update;
 if h.id is not null then
  if r.operational_effect='cancel_registration' then
   perform 1 from academy.course_runs run where run.tenant_id=p_tenant and run.id in(select e.course_run_id from academy.enrollments e where e.tenant_id=p_tenant and e.handoff_id=h.id) order by run.id for update;
   update academy.enrollments set status='cancelled',metadata=metadata||jsonb_build_object('cancelledByRefundId',r.id) where tenant_id=p_tenant and handoff_id=h.id and status in ('confirmed','active');
   update academy.registration_handoffs set status='cancelled',metadata=metadata||jsonb_build_object('cancelledByRefundId',r.id) where tenant_id=p_tenant and id=h.id;
   update work_core.tasks set status='cancelled',metadata=metadata||jsonb_build_object('cancelledByRefundId',r.id) where tenant_id=p_tenant
    and task_key='registration-'||h.id::text and status in ('todo','in_progress');
   update academy.course_runs run set enrolled_count=(select count(*) from academy.enrollments e where e.tenant_id=p_tenant and e.course_run_id=run.id and e.status in ('confirmed','active','completed'))
    where run.tenant_id=p_tenant and run.id in(select course_run_id from academy.enrollments where tenant_id=p_tenant and handoff_id=h.id);
   if to_regprocedure('private_app.mark_diploma_settlement_review_v1(uuid,uuid,uuid)') is not null then
    execute 'select private_app.mark_diploma_settlement_review_v1($1,$2,$3)' using p_tenant,h.id,r.id;
   end if;
  end if;
  -- Preserve won-sale and paid-commission history; append a reviewable correction.
  insert into accounting_core.incentive_adjustment_reviews(tenant_id,refund_id,incentive_event_id,original_amount,proposed_reduction)
  select p_tenant,r.id,e.id,e.incentive_amount,
   least(greatest(0,e.incentive_amount-coalesce((select sum(pr.proposed_reduction) from accounting_core.incentive_adjustment_reviews pr where pr.tenant_id=p_tenant and pr.incentive_event_id=e.id and pr.refund_id<>r.id),0)),
    round(e.incentive_amount*r.amount_minor/greatest(p.amount_minor,1),2))
   from incentives_core.events e where e.tenant_id=p_tenant and e.source_type='registration_handoff' and e.source_id=h.id
    and e.state in ('due','approved','paid') on conflict(tenant_id,refund_id,incentive_event_id) do nothing;
  if to_regprocedure('private_app.admission_business_deadline_v1(uuid,timestamp with time zone,integer)') is not null then
   execute 'select private_app.admission_business_deadline_v1($1,$2,1)' into deadline using p_tenant,now();
  end if;
  insert into work_core.tasks(tenant_id,task_key,title,description,contact_id,opportunity_id,assigned_staff_id,created_by_subject_id,due_at,metadata)
  values(p_tenant,'refund-review-'||r.id,'متابعة أثر الاسترداد','مراجعة التسجيل والتسوية والحافز حسب سبب الاسترداد',h.contact_id,h.opportunity_id,h.assigned_staff_id,
   private_app.current_subject_id(),deadline,jsonb_build_object('source','refund_review','refundId',r.id,'effect',r.operational_effect))
  on conflict(tenant_id,task_key) do nothing;
  if to_regprocedure('private_app.sync_customer_sales_task_v1(uuid,uuid)') is not null then
   execute 'select private_app.sync_customer_sales_task_v1($1,$2)' using p_tenant,h.contact_id;
  end if;
  if to_regprocedure('private_app.queue_admission_governance_v1(uuid,uuid)') is not null then
   execute 'select private_app.queue_admission_governance_v1($1,$2)' using p_tenant,h.id;
  end if;
 end if;
end $$;

-- Redact at the oldest callable read API, so newer snapshot wrappers inherit it.
alter function public.v2_tenant_admissions_snapshot(text) set schema private_app;
alter function private_app.v2_tenant_admissions_snapshot(text) rename to admissions_snapshot_before_finance_v1;
create function public.v2_tenant_admissions_snapshot(p_slug text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; t uuid; financial boolean; verify boolean;
begin
 result:=private_app.admissions_snapshot_before_finance_v1(p_slug);
 select id into t from core.tenants where slug=p_slug;
 financial:=private_app.has_accounting_permission(t,'tenant.accounting.read')
  or private_app.has_tenant_permission(t,'tenant.admissions.payment.verify');
 verify:=private_app.has_accounting_permission(t,'tenant.accounting.payments.approve')
  or private_app.has_tenant_permission(t,'tenant.admissions.payment.verify');
 result:=jsonb_set(result,'{viewer}',coalesce(result->'viewer','{}')||jsonb_build_object('canViewFinancialDetails',financial,'canVerifyPayment',verify));
 if not financial then
  result:=jsonb_set(result,'{cases}',coalesce((select jsonb_agg((x.value-'paymentAmountMinor'-'paymentReference'-'paymentRejectionReason')||
   jsonb_build_object('documents',coalesce((select jsonb_agg(doc) from jsonb_array_elements(x.value->'documents') doc where doc->>'type'<>'payment_receipt'),'[]')) order by x.ordinality)
   from jsonb_array_elements(result->'cases') with ordinality x(value,ordinality)),'[]'));
 end if;
 return result;
end $$;

-- Resolve a beneficiary only from a unique, explicit financial link.
create function private_app.accounting_invoice_handoff_v1(p_tenant uuid,p_invoice uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[]; diploma_ids uuid[];
begin
 select array_agg(distinct handoff_id) into ids from academy.training_financial_links where tenant_id=p_tenant and invoice_id=p_invoice;
 if to_regclass('academy.diploma_invoice_links') is not null then
  execute 'select array_agg(distinct c.handoff_id) from academy.diploma_invoice_links l join academy.diploma_contracts c on c.tenant_id=l.tenant_id and c.id=l.contract_id where l.tenant_id=$1 and l.invoice_id=$2'
   into diploma_ids using p_tenant,p_invoice;
  ids:=coalesce(ids,'{}'::uuid[])||coalesce(diploma_ids,'{}'::uuid[]);
 end if;
 select array_agg(distinct x) into ids from unnest(ids) x where x is not null;
 if cardinality(ids)=1 then return ids[1]; end if;
 return null;
end $$;

-- Accounting import never moves the receipt date. Shared payer cash is split by
-- explicit invoice allocations; ambiguous/unallocated cash stays unattributed.
create or replace function private_app.campaign_cash_v1(p_tenant uuid)
returns table(event_key text,contact_id uuid,opportunity_id uuid,occurred_at timestamptz,amount_minor bigint,currency text,kind text,handoff_id uuid)
language sql stable set search_path='' as $$
 with verified as (
  select p.*,a.contact_id payer_contact_id,h.id direct_handoff_id,h.contact_id beneficiary_contact_id,h.opportunity_id direct_opportunity_id
   from accounting_core.payments p join accounting_core.customer_accounts a on a.tenant_id=p_tenant and a.id=p.customer_account_id
   left join academy.registration_handoffs h on h.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text
   where p.tenant_id=p_tenant and p.status in ('verified','refunded') and p.verified_at is not null
 ), allocated as (
  select p.id payment_id,a.id allocation_id,a.invoice_id,
   least(a.amount_minor,greatest(0,p.amount_minor-coalesce(sum(a.amount_minor) over(partition by p.id order by a.created_at,a.id rows between unbounded preceding and 1 preceding),0)))::bigint amount_minor
  from verified p join accounting_core.payment_allocations a on a.tenant_id=p_tenant and a.payment_id=p.id where p.direct_handoff_id is null
 )
 select 'handoff:'||h.id,h.contact_id,h.opportunity_id,coalesce(h.paid_at,h.payment_verified_at),h.payment_amount_minor,
  coalesce(nullif(h.metadata->>'currency',''),'SAR'),'collection',h.id
 from academy.registration_handoffs h where h.tenant_id=p_tenant and h.payment_status='verified' and h.payment_verified_at is not null
 and h.payment_amount_minor>0 and not exists(select 1 from accounting_core.payments p where p.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text)
 and not exists(select 1 from academy.training_financial_links l where l.tenant_id=p_tenant and l.handoff_id=h.id)
 union all
 select 'payment:'||p.id,coalesce(p.beneficiary_contact_id,p.payer_contact_id),p.direct_opportunity_id,p.received_at,
  case when p.direct_handoff_id is not null then p.amount_minor else greatest(0,p.amount_minor-coalesce((select sum(a.amount_minor) from allocated a where a.payment_id=p.id),0))::bigint end,
  p.currency,'collection',p.direct_handoff_id from verified p
 where p.direct_handoff_id is not null or p.amount_minor>coalesce((select sum(a.amount_minor) from allocated a where a.payment_id=p.id),0)
 union all
 select 'payment:'||p.id||':allocation:'||a.allocation_id,coalesce(h.contact_id,p.payer_contact_id),h.opportunity_id,p.received_at,a.amount_minor,p.currency,'collection',h.id
 from allocated a join verified p on p.id=a.payment_id
 left join academy.registration_handoffs h on h.tenant_id=p_tenant and h.id=private_app.accounting_invoice_handoff_v1(p_tenant,a.invoice_id)
 where a.amount_minor>0
 union all
 select 'refund:'||r.id,coalesce(h.contact_id,a.contact_id),h.opportunity_id,r.completed_at,-r.amount_minor,p.currency,'refund',h.id
 from accounting_core.refunds r join accounting_core.payments p on p.tenant_id=p_tenant and p.id=r.payment_id
 join accounting_core.customer_accounts a on a.tenant_id=p_tenant and a.id=p.customer_account_id
 left join academy.registration_handoffs h on h.tenant_id=p_tenant and h.id=coalesce(r.handoff_id,
  case when p.source_type='registration_handoff' then nullif(p.source_id,'')::uuid end,
  private_app.accounting_invoice_handoff_v1(p_tenant,r.invoice_id))
 where r.tenant_id=p_tenant and r.status='completed' and r.settlement_kind='cash' and r.completed_at is not null
$$;

-- Compatible snapshot: every balance uses the same net helper and local dates.
alter function public.v1_tenant_accounting_snapshot(text,date,date) set schema private_app;
alter function private_app.v1_tenant_accounting_snapshot(text,date,date) rename to accounting_snapshot_before_governance_v1;
create function public.v1_tenant_accounting_snapshot(p_slug text,p_from date default null,p_to date default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid; tz text; cur text; today date; first_day date; last_day date; result jsonb; balances jsonb; multi boolean; cash bigint; refunded bigint; unresolved integer;
begin
 select id,timezone into t,tz from core.tenants where slug=p_slug;
 today:=(now() at time zone tz)::date; first_day:=coalesce(p_from,date_trunc('month',today)::date); last_day:=coalesce(p_to,today);
 result:=private_app.accounting_snapshot_before_governance_v1(p_slug,first_day,last_day);
 result:=jsonb_set(result,'{viewer}',result->'viewer'||jsonb_build_object('canApproveIncentives',private_app.has_accounting_permission(t,'tenant.accounting.incentives.approve')));
 cur:=coalesce(result->'profile'->>'baseCurrency','SAR');
 select count(distinct currency)>1 into multi from (
  select currency from accounting_core.payments where tenant_id=t union select currency from accounting_core.sales_documents where tenant_id=t) currencies;
 select coalesce(sum(amount_minor),0) into cash from accounting_core.payments where tenant_id=t and currency=cur and status in ('verified','refunded') and verified_at is not null and (received_at at time zone tz)::date between first_day and last_day;
 select coalesce(sum(r.amount_minor),0) into refunded from accounting_core.refunds r join accounting_core.payments p on p.tenant_id=r.tenant_id and p.id=r.payment_id
  where r.tenant_id=t and r.status='completed' and r.settlement_kind='cash' and p.currency=cur and (r.completed_at at time zone tz)::date between first_day and last_day;
 select coalesce(jsonb_agg(private_app.accounting_invoice_net_v1(t,d.id)||jsonb_build_object('dueDate',d.due_date,'accountId',d.customer_account_id)),'[]') into balances
 from accounting_core.sales_documents d where d.tenant_id=t and d.status='issued' and d.document_type in ('invoice','debit_note');
 select count(*) into unresolved from jsonb_array_elements(balances) v where v->>'currency'=cur and (v->>'requiresReview')::boolean;
 result:=jsonb_set(result,'{summary}',coalesce(result->'summary','{}')||jsonb_build_object('currency',cur,'mixedCurrencies',multi,'collectedMinor',cash-refunded,'refundedMinor',refunded,
  'reviewRequiredInvoices',unresolved,
  'knownOutstandingMinor',(select coalesce(sum((v->>'outstandingMinor')::bigint),0) from jsonb_array_elements(balances) v where v->>'currency'=cur),
  'outstandingMinor',case when unresolved=0 then (select coalesce(sum((v->>'outstandingMinor')::bigint),0) from jsonb_array_elements(balances) v where v->>'currency'=cur) end,
 'overdueMinor',case when unresolved=0 then (select coalesce(sum((v->>'outstandingMinor')::bigint),0) from jsonb_array_elements(balances) v where v->>'currency'=cur and (v->>'dueDate')::date<today) end));
 result:=jsonb_set(result,'{summary}',result->'summary'||jsonb_build_object(
  'methodCollections',(select coalesce(jsonb_agg(jsonb_build_object('method',m.method,'amountMinor',m.amount_minor) order by m.method),'[]') from (
   select movement.method,sum(movement.amount_minor) amount_minor from (
    select p.method,p.amount_minor from accounting_core.payments p where p.tenant_id=t and p.currency=cur and p.status in ('verified','refunded') and p.verified_at is not null and (p.received_at at time zone tz)::date between first_day and last_day
    union all select p.method,-r.amount_minor from accounting_core.refunds r join accounting_core.payments p on p.tenant_id=t and p.id=r.payment_id
     where r.tenant_id=t and r.status='completed' and r.settlement_kind='cash' and p.currency=cur and (r.completed_at at time zone tz)::date between first_day and last_day
   ) movement group by movement.method) m),
  'issuedDocumentCounts',(select jsonb_build_object('invoice',count(*) filter(where document_type='invoice'),'credit_note',count(*) filter(where document_type='credit_note'),'debit_note',count(*) filter(where document_type='debit_note'))
   from accounting_core.sales_documents where tenant_id=t and status='issued' and issue_date between first_day and last_day)));
 result:=jsonb_set(result,'{aging}',(select jsonb_build_object(
  'current',coalesce(sum((v->>'outstandingMinor')::bigint) filter(where (v->>'dueDate')::date>=today or v->>'dueDate' is null),0),
  'days1to30',coalesce(sum((v->>'outstandingMinor')::bigint) filter(where today-(v->>'dueDate')::date between 1 and 30),0),
  'days31to60',coalesce(sum((v->>'outstandingMinor')::bigint) filter(where today-(v->>'dueDate')::date between 31 and 60),0),
  'days61to90',coalesce(sum((v->>'outstandingMinor')::bigint) filter(where today-(v->>'dueDate')::date between 61 and 90),0),
  'over90',coalesce(sum((v->>'outstandingMinor')::bigint) filter(where today-(v->>'dueDate')::date>90),0)) from jsonb_array_elements(balances) v where v->>'currency'=cur));
 result:=jsonb_set(result,'{documents}',coalesce((select jsonb_agg(v||case when v->>'status'='issued' and v->>'type' in ('invoice','debit_note')
  then jsonb_build_object('netFinancial',f,'outstandingMinor',f->'outstandingMinor','paidMinor',f->'paidMinor',
   'paymentStatus',case when (f->>'requiresReview')::boolean then 'review_required' when (f->>'outstandingMinor')::bigint=0 then 'paid'
    when (v->>'dueDate')::date<today then 'overdue' when (f->>'paidMinor')::bigint>0 then 'partially_paid' else 'unpaid' end) else '{}' end)
  from jsonb_array_elements(result->'documents') v cross join lateral private_app.accounting_invoice_net_v1(t,(v->>'id')::uuid) f),'[]'));
 result:=jsonb_set(result,'{accounts}',coalesce((select jsonb_agg(a||jsonb_build_object('currency',cur,
  'balanceMinor',case when not exists(select 1 from jsonb_array_elements(balances) b where b->>'accountId'=a->>'id' and (b->>'requiresReview')::boolean)
   then (select coalesce(sum((b->>'outstandingMinor')::bigint),0) from jsonb_array_elements(balances) b where b->>'accountId'=a->>'id' and b->>'currency'=cur) end,
  'invoicedMinor',(select coalesce(sum((b->>'totalMinor')::bigint),0) from jsonb_array_elements(balances) b where b->>'accountId'=a->>'id' and b->>'currency'=cur),
  'collectedMinor',case when not exists(select 1 from jsonb_array_elements(balances) b where b->>'accountId'=a->>'id' and (b->>'requiresReview')::boolean)
   then (select coalesce(sum((b->>'paidMinor')::bigint),0) from jsonb_array_elements(balances) b where b->>'accountId'=a->>'id' and b->>'currency'=cur) end)) from jsonb_array_elements(result->'accounts') a),'[]'));
 result:=jsonb_set(result,'{payments}',coalesce((select jsonb_agg(v||jsonb_build_object('unallocatedMinor',private_app.accounting_payment_available_v1(t,(v->>'id')::uuid),
  'invoiceAllocations',coalesce((select jsonb_agg(jsonb_build_object('invoiceId',a.invoice_id,'amountMinor',a.amount_minor,'handoffId',private_app.accounting_invoice_handoff_v1(t,a.invoice_id)))
   from accounting_core.payment_allocations a where a.tenant_id=t and a.payment_id=(v->>'id')::uuid),'[]'))) from jsonb_array_elements(result->'payments') v),'[]'));
 result:=jsonb_set(result,'{refunds}',coalesce((select jsonb_agg(v||jsonb_build_object('effect',r.operational_effect,'settlementKind',r.settlement_kind,'handoffId',r.handoff_id,
  'canApprove',r.requested_by_subject_id is distinct from private_app.current_subject_id(),'currency',p.currency,
  'payment',jsonb_build_object('id',p.id,'customerAccountId',p.customer_account_id,'number',p.payment_number,'amountMinor',p.amount_minor,'currency',p.currency,'sourceType',p.source_type,'sourceId',p.source_id,
   'invoiceAllocations',coalesce((select jsonb_agg(jsonb_build_object('invoiceId',a.invoice_id,'handoffId',private_app.accounting_invoice_handoff_v1(t,a.invoice_id))) from accounting_core.payment_allocations a where a.tenant_id=t and a.payment_id=p.id),'[]'))))
  from jsonb_array_elements(result->'refunds') v join accounting_core.refunds r on r.tenant_id=t and r.id=(v->>'id')::uuid
  join accounting_core.payments p on p.tenant_id=t and p.id=r.payment_id),'[]'));
 result:=result||jsonb_build_object('governance',jsonb_build_object('enabled',coalesce((select enabled from accounting_core.governance_settings where tenant_id=t),false)),
  'customerCredits',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'customerAccountId',c.customer_account_id,'currency',c.currency,'amountMinor',c.amount_minor,
   'availableMinor',greatest(0,c.amount_minor-coalesce((select sum(a.amount_minor) from accounting_core.customer_credit_applications a where a.tenant_id=t and a.credit_id=c.id),0))))
   from accounting_core.customer_credits c where c.tenant_id=t),'[]'),
  'incentiveAdjustmentReviews',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'refundId',r.refund_id,'originalAmount',r.original_amount,'proposedReduction',r.proposed_reduction,'status',r.status,'createdAt',r.created_at))
   from accounting_core.incentive_adjustment_reviews r where r.tenant_id=t),'[]'));
 -- Historical currencies remain available per document, never silently summed.
 if multi then result:=jsonb_set(result,'{summary}',result->'summary'||jsonb_build_object('netInvoicedMinor',null,'taxInvoicedMinor',null)); end if;
 if unresolved>0 then result:=jsonb_set(result,'{aging}','{"current":null,"days1to30":null,"days31to60":null,"days61to90":null,"over90":null}'::jsonb); end if;
 return result;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private_app' and p.proname in ('accounting_payment_evidence_guard_v1','accounting_payment_available_v1','accounting_invoice_net_v1','admission_verified_cash_v1','admission_cash_currency_v1','accounting_allocation_guard_v1','import_verified_handoff_v1','update_admission_before_financial_governance_v1','update_admission_before_commerce_v1','accounting_handoff_import_trigger_v1','accounting_action_before_governance_v1','accounting_apply_refund_effect_v1','accounting_reconcile_invoice_v1','accounting_allocation_reconcile_v1','admissions_snapshot_before_finance_v1','accounting_snapshot_before_governance_v1','accounting_invoice_handoff_v1','accounting_credit_note_guard_v1','accounting_document_reconcile_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;
revoke all on function public.v1_tenant_accounting_action(text,text,jsonb),public.v2_tenant_admissions_snapshot(text),public.v1_tenant_accounting_snapshot(text,date,date) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_accounting_action(text,text,jsonb),public.v2_tenant_admissions_snapshot(text),public.v1_tenant_accounting_snapshot(text,date,date) to authenticated;
-- Sale-source collections are independent of customer-acquisition cohorts.
-- No inferred source, exchange conversion, customer denominator, or unreviewed ROAS.
create or replace function public.v1_tenant_opportunity_collections(p_slug text,p_from date,p_to date,
 p_staff_id uuid default null,p_course_id uuid default null,p_search text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_tenant uuid:=private_app.campaign_report_tenant_v1(p_slug); v_timezone text; v_today date;
 v_start timestamptz; v_end timestamptz; v_result jsonb;
begin
 if private_app.current_subject_id() is null or private_app.has_accounting_permission(v_tenant,'tenant.accounting.reports.read') is not true then raise exception 'forbidden'; end if;
 if not exists(select 1 from marketing_hub.campaign_report_rollouts where tenant_id=v_tenant and enabled) then raise exception 'campaign_report_not_enabled'; end if;
 select timezone into v_timezone from core.tenants where id=v_tenant;
 v_today:=(now() at time zone v_timezone)::date;
 if p_from is null or p_to is null or p_from>p_to or p_to>v_today or p_to-p_from>365 or length(coalesce(p_search,''))>80 then raise exception 'campaign_report_filter_invalid'; end if;
 v_start:=p_from::timestamp at time zone v_timezone;
 v_end:=(p_to+1)::timestamp at time zone v_timezone;
 with cash as materialized (
  select e.*,o.owner_staff_id,o.course_id,
   case when pay.metadata->>'opportunityId'=e.opportunity_id::text and jsonb_typeof(pay.metadata->'attribution')='object'
     then pay.metadata->'attribution' else o.metadata->'attribution' end attribution
  from private_app.campaign_cash_v1(v_tenant) e
  left join sales_core.opportunities o on o.tenant_id=v_tenant and o.id=e.opportunity_id
  left join accounting_core.refunds refund on refund.tenant_id=v_tenant and split_part(e.event_key,':',1)='refund' and refund.id::text=split_part(e.event_key,':',2)
  left join accounting_core.payments pay on pay.tenant_id=v_tenant and
   ((split_part(e.event_key,':',1)='payment' and pay.id::text=split_part(e.event_key,':',2)) or pay.id=refund.payment_id)
  where e.occurred_at>=v_start and e.occurred_at<v_end
   and (p_staff_id is null or o.owner_staff_id=p_staff_id)
   and (p_course_id is null or o.course_id=p_course_id)
 ), labels as (
  select c.*,coalesce(attribution->>'origin'='documented_sale_source',false) and
    nullif(trim(concat_ws('',attribution->>'source',attribution->>'campaignName',attribution->>'adName')),'') is not null documented,
   nullif(trim(attribution->>'source'),'') source,
   nullif(trim(attribution->>'campaignName'),'') campaign_name,
   nullif(trim(attribution->>'adName'),'') ad_name
  from cash c
 ), selected as materialized (
  select l.*,case when documented then jsonb_build_array(source,campaign_name,ad_name)::text else 'unattributed' end group_key
  from labels l where coalesce(trim(p_search),'')='' or
   lower(case when documented then concat_ws(' ',source,campaign_name,ad_name) else 'مصدر فرصة البيع غير موثق' end) like '%'||lower(trim(p_search))||'%'
 ), money as (
  select group_key,currency,coalesce(sum(amount_minor) filter(where kind='collection'),0) gross,
   -coalesce(sum(amount_minor) filter(where kind='refund'),0) refunds,sum(amount_minor) net
  from selected group by group_key,currency
 ), grouped as (
  select group_key,bool_or(documented) documented,
   max(source) filter(where documented) source,max(campaign_name) filter(where documented) campaign_name,
   max(ad_name) filter(where documented) ad_name,count(distinct opportunity_id) opportunities,count(*) events,
   count(*) filter(where opportunity_id is null) unlinked_events
  from selected group by group_key
 ), totals as (
  select currency,coalesce(sum(amount_minor) filter(where kind='collection'),0) gross,
   -coalesce(sum(amount_minor) filter(where kind='refund'),0) refunds,sum(amount_minor) net
  from selected group by currency
 )
 select jsonb_build_object('enabled',true,'generatedAt',now(),
  'range',jsonb_build_object('from',p_from,'to',p_to,'timezone',v_timezone,'mode','cash'),
  'opportunities',(select count(distinct opportunity_id) from selected),
  'unlinkedEvents',(select count(*) from selected where opportunity_id is null),
  'totals',coalesce((select jsonb_agg(jsonb_build_object('currency',currency,'grossMinor',gross,'refundMinor',refunds,'netMinor',net) order by currency) from totals),'[]'::jsonb),
  'groups',coalesce((select jsonb_agg(jsonb_build_object('key',md5(g.group_key),'documented',g.documented,'source',g.source,
   'campaignName',g.campaign_name,'adName',g.ad_name,'opportunities',g.opportunities,'events',g.events,'unlinkedEvents',g.unlinked_events,
   'money',(select jsonb_agg(jsonb_build_object('currency',m.currency,'grossMinor',m.gross,'refundMinor',m.refunds,'netMinor',m.net) order by m.currency)
    from money m where m.group_key=g.group_key)) order by g.documented desc,g.campaign_name nulls last,g.group_key) from grouped g),'[]'::jsonb),
  'attributionPolicy','documented_sale_source_only','spendMapping','not_reconciled','roas',null) into v_result;
 return v_result;
end;
$$;
revoke all on function public.v1_tenant_opportunity_collections(text,date,date,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_opportunity_collections(text,date,date,uuid,uuid,text) to authenticated;
-- Governed sales have their own source; acquisition history stays unchanged.
alter function private_app.campaign_cash_origin_v1(uuid,uuid,uuid) rename to campaign_cash_origin_before_sale_governance_v1;
create function private_app.campaign_cash_origin_v1(p_tenant uuid,p_contact uuid,p_opportunity uuid)
returns text language sql stable set search_path='' as $$
 select case when exists(select 1 from sales_core.opportunities o
  where o.tenant_id=p_tenant and o.contact_id=p_contact and o.id=p_opportunity
   and jsonb_typeof(o.metadata->'attribution')='object') then null
  else private_app.campaign_cash_origin_before_sale_governance_v1(p_tenant,p_contact,p_opportunity) end;
$$;
revoke all on function private_app.campaign_cash_origin_v1(uuid,uuid,uuid),
 private_app.campaign_cash_origin_before_sale_governance_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;
commit;
