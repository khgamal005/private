-- Direct-institute diploma contracts. Additive; no tenant activation or course backfill.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

alter table academy.courses add column if not exists program_kind text;
alter table academy.courses add constraint courses_program_kind_check check(program_kind in ('short_course','diploma'));

create table academy.diploma_settings (
 tenant_id uuid primary key references core.tenants(id),
 enabled boolean not null default false,
 collection_automation_enabled boolean not null default false,
 updated_by_subject_id uuid references access_control.subjects(id),
 updated_at timestamptz not null default now()
);
create table academy.diploma_contracts (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),
 handoff_id uuid not null, payer_account_id uuid not null, collection_owner_id uuid not null,
 status text not null default 'draft' check(status in ('draft','active','settlement_review','collections_only','closed')),
 currency text not null check(currency ~ '^[A-Z]{3}$'), total_minor bigint not null check(total_minor>0),
 starts_on date not null, current_version integer not null default 1 check(current_version>0),
 first_installment_id uuid not null, first_installment_minor bigint not null check(first_installment_minor>0),
 approved_by_subject_id uuid references access_control.subjects(id), approved_at timestamptz,
 created_by_subject_id uuid not null references access_control.subjects(id), created_at timestamptz not null default now(),
 collection_checked_at timestamptz,
 unique(tenant_id,id), unique(tenant_id,handoff_id),
 foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
 foreign key(tenant_id,payer_account_id) references accounting_core.customer_accounts(tenant_id,id),
 foreign key(tenant_id,collection_owner_id) references people.staff_profiles(tenant_id,id),
 check(first_installment_minor<=total_minor),
 check((status='draft' and approved_at is null) or (status<>'draft' and approved_at is not null and approved_by_subject_id is not null))
);
create index diploma_contracts_queue_idx on academy.diploma_contracts(tenant_id,status,collection_checked_at,id);
create table academy.diploma_schedule_versions (
 tenant_id uuid not null, contract_id uuid not null, version integer not null check(version>0),
 reason text not null check(length(btrim(reason)) between 3 and 1000),
 created_by_subject_id uuid not null references access_control.subjects(id), created_at timestamptz not null default now(),
 primary key(tenant_id,contract_id,version),
 foreign key(tenant_id,contract_id) references academy.diploma_contracts(tenant_id,id)
);
create table academy.diploma_installments (
 tenant_id uuid not null, contract_id uuid not null, version integer not null, id uuid not null,
 position integer not null check(position>0), due_on date not null, amount_minor bigint not null check(amount_minor>0),
 primary key(tenant_id,contract_id,version,id), unique(tenant_id,contract_id,version,position),
 foreign key(tenant_id,contract_id,version) references academy.diploma_schedule_versions(tenant_id,contract_id,version)
);
create index diploma_installments_due_idx on academy.diploma_installments(tenant_id,due_on,contract_id,version);
create table academy.diploma_invoice_links (
 tenant_id uuid not null, contract_id uuid not null, installment_id uuid not null, invoice_id uuid not null,
 linked_by_subject_id uuid not null references access_control.subjects(id), linked_at timestamptz not null default now(),
 primary key(tenant_id,contract_id,installment_id), unique(tenant_id,invoice_id),
 foreign key(tenant_id,contract_id) references academy.diploma_contracts(tenant_id,id),
 foreign key(tenant_id,invoice_id) references accounting_core.sales_documents(tenant_id,id)
);
create table academy.diploma_events (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id), contract_id uuid,
 kind text not null, reason text, payload jsonb not null default '{}'::jsonb,
 actor_subject_id uuid references access_control.subjects(id), created_at timestamptz not null default now(),
 foreign key(tenant_id,contract_id) references academy.diploma_contracts(tenant_id,id)
);
create index diploma_events_contract_idx on academy.diploma_events(tenant_id,contract_id,created_at desc,id);
create unique index diploma_first_waiver_once_idx on academy.diploma_events(tenant_id,contract_id) where kind='first_installment_waived';
create unique index diploma_refund_review_once_idx on academy.diploma_events(tenant_id,contract_id,(payload->>'refundId')) where kind='settlement_review_requested';
create table academy.diploma_commands (
 tenant_id uuid not null references core.tenants(id), command_id uuid not null,
 actor_subject_id uuid not null references access_control.subjects(id), action text not null,
 request_hash text not null, response jsonb, created_at timestamptz not null default now(), primary key(tenant_id,command_id)
);
create table academy.diploma_reconciliation_queue (
 tenant_id uuid not null, contract_id uuid not null, requested_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,contract_id), foreign key(tenant_id,contract_id) references academy.diploma_contracts(tenant_id,id)
);

do $$ declare item text; begin
 foreach item in array array['diploma_settings','diploma_contracts','diploma_schedule_versions','diploma_installments','diploma_invoice_links','diploma_events','diploma_commands','diploma_reconciliation_queue'] loop
  execute format('alter table academy.%I enable row level security',item);
  execute format('alter table academy.%I force row level security',item);
  execute format('revoke all on academy.%I from public,anon,authenticated',item);
 end loop;
end $$;

create function private_app.diploma_immutable_v1() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'diploma_history_immutable'; end $$;
create trigger diploma_versions_immutable before update or delete on academy.diploma_schedule_versions for each row execute function private_app.diploma_immutable_v1();
create trigger diploma_installments_immutable before update or delete on academy.diploma_installments for each row execute function private_app.diploma_immutable_v1();
create trigger diploma_links_immutable before update or delete on academy.diploma_invoice_links for each row execute function private_app.diploma_immutable_v1();
create trigger diploma_events_immutable before update or delete on academy.diploma_events for each row execute function private_app.diploma_immutable_v1();

-- Both finance linking paths serialize on the canonical invoice, so it cannot
-- qualify two independent training contracts even when requests race.
create function private_app.guard_diploma_invoice_link_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare c academy.diploma_contracts%rowtype; amount bigint;
begin
 if tg_op='UPDATE' and new.tenant_id=old.tenant_id and new.invoice_id=old.invoice_id then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text||':'||new.invoice_id::text,92622));
 if tg_table_name='training_financial_links' then
  if exists(select 1 from academy.diploma_invoice_links where tenant_id=new.tenant_id and invoice_id=new.invoice_id) then raise exception 'diploma_invoice_invalid'; end if;
 else
  select * into c from academy.diploma_contracts where tenant_id=new.tenant_id and id=new.contract_id;
  select i.amount_minor into amount from academy.diploma_installments i
   where i.tenant_id=new.tenant_id and i.contract_id=c.id and i.version=c.current_version and i.id=new.installment_id;
  if c.status<>'active' or amount is null or not exists(select 1 from accounting_core.sales_documents
   where tenant_id=new.tenant_id and id=new.invoice_id and status='issued' and document_type='invoice'
    and currency=c.currency and customer_account_id=c.payer_account_id and total_minor=amount)
   or exists(select 1 from academy.training_financial_links where tenant_id=new.tenant_id and invoice_id=new.invoice_id)
  then raise exception 'diploma_invoice_invalid'; end if;
 end if;
 return new;
end $$;
create trigger diploma_invoice_link_guard before insert on academy.diploma_invoice_links for each row execute function private_app.guard_diploma_invoice_link_v1();
create trigger training_diploma_invoice_exclusivity before insert or update on academy.training_financial_links for each row execute function private_app.guard_diploma_invoice_link_v1();

create function private_app.diploma_tenant_v1(p_slug text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 if auth.uid() is null or private_app.current_subject_id() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select id into t from core.tenants where slug=p_slug and status in ('trial','active');
 if t is null or not private_app.has_accounting_permission(t,'tenant.accounting.read') then raise exception 'forbidden' using errcode='42501'; end if;
 return t;
end $$;

create function private_app.set_program_kind_v1(p_tenant_id uuid,p_course_id uuid,p_kind text,p_expected_kind text) returns void
language plpgsql security definer set search_path='' as $$
declare current_kind text; affected_handoff uuid;
begin
 if not private_app.has_tenant_permission(p_tenant_id,'tenant.academy.write') then raise exception 'forbidden' using errcode='42501'; end if;
 if p_kind is null or p_kind not in ('short_course','diploma') then raise exception 'diploma_program_required'; end if;
 select program_kind into current_kind from academy.courses where tenant_id=p_tenant_id and id=p_course_id for update;
 if not found then raise exception 'diploma_program_required'; end if;
 if current_kind is distinct from p_expected_kind then raise exception 'diploma_changed'; end if;
 if p_kind<>'diploma' and exists(select 1 from academy.diploma_contracts dc join academy.registration_handoffs rh on rh.tenant_id=p_tenant_id and rh.id=dc.handoff_id where dc.tenant_id=p_tenant_id and rh.course_id=p_course_id) then raise exception 'diploma_program_in_use'; end if;
 update academy.courses set program_kind=p_kind where tenant_id=p_tenant_id and id=p_course_id;
 if to_regprocedure('private_app.queue_admission_governance_v1(uuid,uuid)') is not null then
  for affected_handoff in select id from academy.registration_handoffs where tenant_id=p_tenant_id and course_id=p_course_id and status not in ('completed','rejected','cancelled') loop
   execute 'select private_app.queue_admission_governance_v1($1,$2)' using p_tenant_id,affected_handoff;
  end loop;
 end if;
end $$;

-- Program classification is a core academy capability, independent of diploma
-- rollout, accounting permissions, paid synchronization and LMS entitlements.
create function public.v1_tenant_program_kinds(p_slug text,p_course_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 if auth.uid() is null or private_app.current_subject_id() is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select id into t from core.tenants where slug=p_slug and status in ('trial','active');
 if t is null or not private_app.has_tenant_permission(t,'tenant.academy.read') then raise exception 'forbidden' using errcode='42501'; end if;
 if coalesce(cardinality(p_course_ids),0)>500 then raise exception 'program_lookup_limit'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'programKind',program_kind)) from academy.courses where tenant_id=t and id=any(p_course_ids)),'[]');
end $$;

create function public.v1_tenant_classify_program(p_slug text,p_course_id uuid,p_kind text,p_expected_kind text,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid; actor uuid:=private_app.current_subject_id(); cmd academy.diploma_commands%rowtype; response_value jsonb;
 payload jsonb:=jsonb_build_object('courseId',p_course_id,'kind',p_kind,'previousKind',p_expected_kind); request_hash_value text;
begin
 if auth.uid() is null or actor is null then raise exception 'authentication_required' using errcode='42501'; end if;
 select id into t from core.tenants where slug=p_slug and status in ('trial','active');
 if t is null or not private_app.has_tenant_permission(t,'tenant.academy.write') then raise exception 'forbidden' using errcode='42501'; end if;
 if p_command_id is null then raise exception 'diploma_payload_invalid'; end if;
 request_hash_value:=md5(payload::text);
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||p_command_id::text,92621));
 select * into cmd from academy.diploma_commands where tenant_id=t and command_id=p_command_id;
 if cmd.command_id is not null then
  if cmd.actor_subject_id<>actor or cmd.action<>'program_classify' or cmd.request_hash<>request_hash_value then raise exception 'command_id_reused_with_different_payload'; end if;
  return cmd.response;
 end if;
 perform private_app.set_program_kind_v1(t,p_course_id,p_kind,p_expected_kind);
 response_value:=jsonb_build_object('id',p_course_id,'programKind',p_kind);
 insert into academy.diploma_commands(tenant_id,command_id,actor_subject_id,action,request_hash,response)
  values(t,p_command_id,actor,'program_classify',request_hash_value,response_value);
 insert into academy.diploma_events(tenant_id,kind,payload,actor_subject_id) values(t,'classify_program',payload,actor);
 return response_value;
end $$;

-- This helper calculates eligibility only. Later arrears never suspend an enrollment.
create function private_app.diploma_admission_eligibility_v1(p_tenant_id uuid,p_handoff_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c academy.diploma_contracts%rowtype; paid bigint:=0; required bigint; waived boolean:=false; invoice uuid; net jsonb;
begin
 if not exists(select 1 from academy.diploma_settings where tenant_id=p_tenant_id and enabled) then
  return jsonb_build_object('eligible',false,'reason','diploma_disabled','waiverApproved',false); end if;
 select * into c from academy.diploma_contracts where tenant_id=p_tenant_id and handoff_id=p_handoff_id;
 if c.id is null or c.status<>'active' then return jsonb_build_object('eligible',false,'reason','approved_diploma_contract_required','waiverApproved',false); end if;
 select exists(select 1 from academy.diploma_events where tenant_id=p_tenant_id and contract_id=c.id and kind='first_installment_waived') into waived;
 required:=c.first_installment_minor;
 select invoice_id into invoice from academy.diploma_invoice_links where tenant_id=p_tenant_id and contract_id=c.id and installment_id=c.first_installment_id;
 if invoice is not null then
  net:=private_app.accounting_invoice_net_v1(p_tenant_id,invoice);
  if coalesce((net->>'requiresReview')::boolean,false) then
   return jsonb_build_object('eligible',waived,'reason',case when waived then 'eligible' else 'financial_review_required' end,
    'contractId',c.id,'requiredAmountMinor',null,'originalRequiredAmountMinor',c.first_installment_minor,'verifiedAmountMinor',null,'requiresReview',true,'waiverApproved',waived);
  end if;
  paid:=coalesce((net->>'paidMinor')::bigint,0);
  required:=least(c.first_installment_minor,coalesce((net->>'totalMinor')::bigint,c.first_installment_minor));
 end if;
 return jsonb_build_object('eligible',waived or paid>=required,
  'reason',case when waived or paid>=required then 'eligible' else 'first_installment_required' end,
  'contractId',c.id,'requiredAmountMinor',required,'originalRequiredAmountMinor',c.first_installment_minor,'verifiedAmountMinor',paid,'waiverApproved',waived);
end $$;

create function private_app.diploma_installment_state_v1(p_tenant_id uuid,p_contract_id uuid,p_as_of timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c academy.diploma_contracts%rowtype; i record; today date; result jsonb:='[]'; net jsonb; paid bigint; total bigint; uncertain boolean;
begin
 select * into c from academy.diploma_contracts where tenant_id=p_tenant_id and id=p_contract_id;
 select (p_as_of at time zone timezone)::date into today from core.tenants where id=p_tenant_id;
 for i in select s.*,l.invoice_id,d.document_number from academy.diploma_installments s
  left join academy.diploma_invoice_links l on l.tenant_id=s.tenant_id and l.contract_id=s.contract_id and l.installment_id=s.id
  left join accounting_core.sales_documents d on d.tenant_id=l.tenant_id and d.id=l.invoice_id
  where s.tenant_id=p_tenant_id and s.contract_id=c.id and s.version=c.current_version order by s.position loop
  net:=case when i.invoice_id is not null then private_app.accounting_invoice_net_v1(p_tenant_id,i.invoice_id) else '{}'::jsonb end;
  uncertain:=coalesce((net->>'requiresReview')::boolean,false);
  paid:=case when uncertain then null else coalesce((net->>'paidMinor')::bigint,0) end; total:=coalesce((net->>'totalMinor')::bigint,i.amount_minor);
  result:=result||jsonb_build_array(jsonb_build_object('id',i.id,'position',i.position,'dueOn',i.due_on,'amountMinor',i.amount_minor,
   'netAmountMinor',total,'paidMinor',paid,'outstandingMinor',case when uncertain then null else greatest(0,total-paid) end,'requiresReview',uncertain,'invoiceId',i.invoice_id,'invoiceNumber',i.document_number,
   'state',case when uncertain then 'financial_review' when c.status<>'active' and c.status<>'draft' and i.invoice_id is null then 'paused'
    when paid>=total then 'settled' when today>i.due_on+7 then 'overdue' when today>i.due_on then 'grace' when today=i.due_on then 'due' else 'scheduled' end));
 end loop;
 return result;
end $$;

-- One collection task per contract. This source is separate from the customer's sales follow-up.
create function private_app.reconcile_diploma_collection_v1(p_tenant_id uuid,p_contract_id uuid,p_as_of timestamptz default now()) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c academy.diploma_contracts%rowtype; overdue date; outstanding bigint; contact uuid; tz text; task_key_value text;
 issued_outstanding bigint; uncertain boolean;
 owner uuid; available boolean:=false; task_due timestamptz;
begin
 if not exists(select 1 from academy.diploma_settings where tenant_id=p_tenant_id and enabled) then return jsonb_build_object('enabled',false); end if;
 select * into c from academy.diploma_contracts where tenant_id=p_tenant_id and id=p_contract_id and status<>'draft' for update;
 if c.id is null then return jsonb_build_object('active',false); end if;
 select exists(select 1 from jsonb_array_elements(private_app.diploma_installment_state_v1(p_tenant_id,p_contract_id,p_as_of)) x where x->>'state'='financial_review') into uncertain;
 if c.status='closed' then
  select coalesce(sum((x->>'outstandingMinor')::bigint),0) into issued_outstanding
   from jsonb_array_elements(private_app.diploma_installment_state_v1(p_tenant_id,p_contract_id,p_as_of)) x where x->>'invoiceId' is not null;
  if issued_outstanding>0 or uncertain then
   update academy.diploma_contracts set status='settlement_review' where tenant_id=p_tenant_id and id=c.id;
   insert into academy.diploma_events(tenant_id,contract_id,kind,reason,payload,actor_subject_id)
    values(p_tenant_id,c.id,'financial_balance_reopened','issued_balance_changed_after_closure',jsonb_build_object('outstandingMinor',case when uncertain then null else issued_outstanding end,'requiresReview',uncertain,'source','financial_reconciliation'),private_app.current_subject_id());
   c.status:='settlement_review';
  end if;
 end if;
 select min((x->>'dueOn')::date),sum((x->>'outstandingMinor')::bigint) into overdue,outstanding
 from jsonb_array_elements(private_app.diploma_installment_state_v1(p_tenant_id,p_contract_id,p_as_of)) x where x->>'state'='overdue';
 task_key_value:='diploma-collection-'||c.id;
 select timezone into tz from core.tenants where id=p_tenant_id;
 select contact_id into contact from academy.registration_handoffs where tenant_id=p_tenant_id and id=c.handoff_id;
 select exists(select 1 from people.staff_profiles where tenant_id=p_tenant_id and id=c.collection_owner_id and employment_status='active') into available;
 if available and to_regprocedure('private_app.staff_operationally_available_v1(uuid,uuid,timestamptz)') is not null then
  execute 'select private_app.staff_operationally_available_v1($1,$2,$3)' into available using p_tenant_id,c.collection_owner_id,p_as_of;
 end if;
 owner:=case when available then c.collection_owner_id end;
 task_due:=case when c.status='settlement_review' or uncertain then p_as_of else (overdue+8)::timestamp at time zone tz end;
 if c.status='settlement_review' or uncertain or (overdue is not null and c.status in ('active','collections_only')) then
  insert into work_core.tasks(tenant_id,task_key,title,description,status,assigned_staff_id,contact_id,due_at,metadata)
  values(p_tenant_id,task_key_value,case when c.status='settlement_review' or uncertain then 'مراجعة التسوية المالية لعقد دبلوم' else 'متابعة قسط دبلوم تجاوز مهلة السداد' end,
   'متابعة التحصيل والتسوية المالية؛ قرار استمرار الدراسة مستقل.','todo',owner,contact,
   task_due,jsonb_build_object('source','diploma_collection','contractId',c.id,'outstandingMinor',case when uncertain then null else coalesce(outstanding,0) end,'currency',c.currency,'dueOn',overdue,'graceDays',7,
    'queueDepartment','finance','ownerMissing',owner is null,'financialReview',uncertain,'settlementReview',c.status='settlement_review' or uncertain))
  on conflict(tenant_id,task_key) do update set assigned_staff_id=excluded.assigned_staff_id,
   due_at=case when work_core.tasks.metadata->>'settlementReview'='true' and excluded.metadata->>'settlementReview'='true' then work_core.tasks.due_at else excluded.due_at end,
   title=excluded.title,
   status=case when work_core.tasks.status='in_progress' then 'in_progress' else 'todo' end,completed_at=null,
   metadata=work_core.tasks.metadata||excluded.metadata,updated_at=now();
 else
  update work_core.tasks set status='completed',completed_at=now(),updated_at=now(),
   metadata=metadata||jsonb_build_object('resolution','no_installment_beyond_grace')
  where tenant_id=p_tenant_id and task_key=task_key_value and status in ('todo','in_progress');
 end if;
 update academy.diploma_contracts set collection_checked_at=p_as_of where tenant_id=p_tenant_id and id=c.id;
 return jsonb_build_object('overdue',overdue is not null,'requiresReview',uncertain,'outstandingMinor',case when uncertain then null else coalesce(outstanding,0) end);
end $$;

create function private_app.queue_diploma_collection_v1(p_tenant_id uuid,p_contract_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from academy.diploma_settings where tenant_id=p_tenant_id and enabled) then return; end if;
 insert into academy.diploma_reconciliation_queue(tenant_id,contract_id) values(p_tenant_id,p_contract_id)
 on conflict(tenant_id,contract_id) do update set requested_at=clock_timestamp();
end $$;

create function private_app.diploma_collections_tick_v1(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c record; n integer:=0;
begin
 for c in select dc.tenant_id,dc.id,q.requested_at from academy.diploma_contracts dc join academy.diploma_settings s on s.tenant_id=dc.tenant_id and s.enabled and s.collection_automation_enabled
  left join academy.diploma_reconciliation_queue q on q.tenant_id=dc.tenant_id and q.contract_id=dc.id
  where dc.status in ('active','settlement_review','collections_only') or q.contract_id is not null
  order by q.requested_at nulls last,dc.collection_checked_at nulls first,dc.id limit least(100,greatest(1,coalesce(p_limit,100))) for update of dc skip locked loop
  perform private_app.reconcile_diploma_collection_v1(c.tenant_id,c.id); n:=n+1;
  delete from academy.diploma_reconciliation_queue where tenant_id=c.tenant_id and contract_id=c.id and requested_at=c.requested_at;
 end loop;
 return jsonb_build_object('processed',n);
end $$;

create function public.v1_diploma_collections_tick(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden' using errcode='42501'; end if;
 return private_app.diploma_collections_tick_v1(p_limit);
end $$;

create function private_app.diploma_settlement_preview_v1(p_tenant_id uuid,p_contract_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare data jsonb; outstanding bigint; paused bigint; issued integer; state text; revision integer; uncertain boolean;
begin
 data:=private_app.diploma_installment_state_v1(p_tenant_id,p_contract_id);
 select exists(select 1 from jsonb_array_elements(data) x where coalesce((x->>'requiresReview')::boolean,false)) into uncertain;
 select coalesce(sum((x->>'outstandingMinor')::bigint) filter(where x->>'invoiceId' is not null),0),
  coalesce(sum((x->>'amountMinor')::bigint) filter(where x->>'invoiceId' is null),0),count(*) filter(where x->>'invoiceId' is not null)
  into outstanding,paused,issued from jsonb_array_elements(data) x;
 select status,current_version into state,revision from academy.diploma_contracts where tenant_id=p_tenant_id and id=p_contract_id;
 return jsonb_build_object('issuedOutstandingMinor',case when uncertain then null else outstanding end,'unbilledMinor',paused,'issuedInvoiceCount',issued,
  'requiresReview',uncertain,'canClose',not uncertain and outstanding=0,'revision',md5(p_contract_id::text||coalesce(state,'')||coalesce(revision,0)::text||data::text));
end $$;

create function private_app.mark_diploma_settlement_review_v1(p_tenant_id uuid,p_handoff_id uuid,p_refund_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c academy.diploma_contracts%rowtype; actor uuid;
begin
 select * into c from academy.diploma_contracts where tenant_id=p_tenant_id and handoff_id=p_handoff_id for update;
 if c.id is null or c.status='draft' then return jsonb_build_object('affected',false); end if;
 select coalesce(completed_by_subject_id,approved_by_subject_id,requested_by_subject_id) into actor
  from accounting_core.refunds where tenant_id=p_tenant_id and id=p_refund_id and status='completed';
 if actor is null then raise exception 'diploma_completed_refund_required'; end if;
 if exists(select 1 from academy.diploma_events where tenant_id=p_tenant_id and contract_id=c.id and kind='settlement_review_requested' and payload->>'refundId'=p_refund_id::text)
 then return jsonb_build_object('affected',true,'contractId',c.id,'replayed',true); end if;
 update academy.diploma_contracts set status='settlement_review' where tenant_id=p_tenant_id and id=c.id;
 insert into academy.diploma_events(tenant_id,contract_id,kind,reason,payload,actor_subject_id)
 values(p_tenant_id,c.id,'settlement_review_requested','registration_cancelled_after_refund',jsonb_build_object('refundId',p_refund_id,'previousStatus',c.status),actor);
 perform private_app.reconcile_diploma_collection_v1(p_tenant_id,c.id);
 return jsonb_build_object('affected',true,'contractId',c.id);
end $$;

create function public.v1_tenant_diploma_snapshot(p_slug text,p_contract_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid:=private_app.diploma_tenant_v1(p_slug); result jsonb; c academy.diploma_contracts%rowtype; detail jsonb;
begin
 if not exists(select 1 from academy.diploma_settings where tenant_id=t and enabled) then return jsonb_build_object('enabled',false); end if;
 result:=jsonb_build_object('enabled',true,'timezone',(select timezone from core.tenants where id=t),'graceDays',7,
  'currency',coalesce((select base_currency from accounting_core.tenant_profiles where tenant_id=t),'SAR'),
  'collectionAutomationEnabled',coalesce((select collection_automation_enabled from academy.diploma_settings where tenant_id=t),false),
  'schedulerAvailable',to_regnamespace('cron') is not null,
  'automationContractCount',(select count(*) from academy.diploma_contracts where tenant_id=t and status in ('active','settlement_review','collections_only')),
  'viewer',jsonb_build_object('canWrite',private_app.has_accounting_permission(t,'tenant.accounting.invoices.write'),
   'canApprove',private_app.has_accounting_permission(t,'tenant.accounting.invoices.issue'),
   'canWaive',private_app.has_accounting_permission(t,'tenant.accounting.settings.manage'),
   'canClassify',private_app.has_tenant_permission(t,'tenant.academy.write')),
  'contracts',coalesce((select jsonb_agg(x.j) from (select jsonb_build_object('id',dc.id,'status',dc.status,'learnerName',p.full_name,'courseTitle',q.title_ar) j
    from academy.diploma_contracts dc join academy.registration_handoffs h on h.tenant_id=t and h.id=dc.handoff_id
    join sales_core.contacts p on p.tenant_id=t and p.id=h.contact_id join academy.courses q on q.tenant_id=t and q.id=h.course_id
    where dc.tenant_id=t order by dc.created_at desc,dc.id limit 50) x),'[]'),
  'handoffs',coalesce((select jsonb_agg(x.j) from (select jsonb_build_object('id',h.id,'learnerName',p.full_name,'courseTitle',q.title_ar) j
    from academy.registration_handoffs h join sales_core.contacts p on p.tenant_id=t and p.id=h.contact_id
    join academy.courses q on q.tenant_id=t and q.id=h.course_id and q.program_kind='diploma'
    where h.tenant_id=t and h.status not in ('completed','rejected','cancelled') and not exists(select 1 from academy.diploma_contracts dc where dc.tenant_id=t and dc.handoff_id=h.id)
    order by h.created_at desc,h.id limit 100) x),'[]'),
  'courses',coalesce((select jsonb_agg(x.j) from (select jsonb_build_object('id',id,'title',title_ar,'kind',program_kind) j from academy.courses where tenant_id=t order by title_ar,id limit 100) x),'[]'),
  'accounts',coalesce((select jsonb_agg(x.j) from (select jsonb_build_object('id',id,'name',display_name) j from accounting_core.customer_accounts where tenant_id=t and status='active' order by display_name,id limit 100) x),'[]'),
  'staff',coalesce((select jsonb_agg(x.j) from (select jsonb_build_object('id',id,'name',full_name) j from people.staff_profiles where tenant_id=t and employment_status='active' order by full_name,id limit 100) x),'[]'));
 if p_contract_id is not null then
  select * into c from academy.diploma_contracts where tenant_id=t and id=p_contract_id;
  if c.id is null then raise exception 'diploma_contract_not_found'; end if;
  select jsonb_build_object('id',c.id,'status',c.status,'currentVersion',c.current_version,'totalMinor',c.total_minor,'currency',c.currency,
   'payerAccountId',c.payer_account_id,'collectionOwnerId',c.collection_owner_id,
   'learnerName',p.full_name,'courseTitle',q.title_ar,'startsOn',c.starts_on,
   'eligibility',private_app.diploma_admission_eligibility_v1(t,c.handoff_id),'installments',private_app.diploma_installment_state_v1(t,c.id),
   'settlementPreview',private_app.diploma_settlement_preview_v1(t,c.id),
   'history',coalesce((select jsonb_agg(x.j) from (select jsonb_build_object('id',id,'kind',kind,'reason',reason,'createdAt',created_at) j
    from academy.diploma_events where tenant_id=t and contract_id=c.id order by created_at desc,id limit 100) x),'[]')) into detail
   from academy.registration_handoffs h join sales_core.contacts p on p.tenant_id=t and p.id=h.contact_id
   join academy.courses q on q.tenant_id=t and q.id=h.course_id where h.tenant_id=t and h.id=c.handoff_id;
  result:=result||jsonb_build_object('selected',detail,'invoices',coalesce((select jsonb_agg(x.j) from (select jsonb_build_object('id',d.id,'number',d.document_number,'totalMinor',d.total_minor) j
   from accounting_core.sales_documents d where d.tenant_id=t and d.customer_account_id=c.payer_account_id and d.currency=c.currency and d.document_type='invoice' and d.status='issued'
   and not exists(select 1 from academy.diploma_invoice_links l where l.tenant_id=t and l.invoice_id=d.id)
   and not exists(select 1 from academy.training_financial_links l where l.tenant_id=t and l.invoice_id=d.id)
   order by d.issue_date desc,d.id limit 100) x),'[]'));
 end if;
 return result;
end $$;

create function public.v1_tenant_diploma_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid:=private_app.diploma_tenant_v1(p_slug); actor uuid:=private_app.current_subject_id(); cmd academy.diploma_commands%rowtype;
 c academy.diploma_contracts%rowtype; h academy.registration_handoffs%rowtype; d accounting_core.sales_documents%rowtype;
 hash text:=md5(coalesce(p_payload,'{}')::text); permission text; contract uuid; item jsonb; plan jsonb;
 position integer:=0; version integer; total bigint:=0; due date; previous_due date; item_id uuid; required_first bigint;
 reason text:=nullif(btrim(p_payload->>'reason'),''); result_value jsonb; kind text; preview jsonb; activate boolean; affected integer;
begin
 permission:=case p_action when 'approve' then 'tenant.accounting.invoices.issue' when 'waive_first_installment' then 'tenant.accounting.settings.manage'
  when 'resolve_settlement' then 'tenant.accounting.settings.manage' when 'set_collection_automation' then 'tenant.accounting.settings.manage'
  when 'classify_program' then 'tenant.accounting.read' when 'create' then 'tenant.accounting.invoices.write' when 'revise_draft' then 'tenant.accounting.invoices.write' when 'reschedule' then 'tenant.accounting.invoices.issue'
  when 'link_invoice' then 'tenant.accounting.invoices.write' when 'refresh_collection' then 'tenant.accounting.invoices.write' else null end;
 if permission is null or not private_app.has_accounting_permission(t,permission) then raise exception 'forbidden' using errcode='42501'; end if;
 if not exists(select 1 from academy.diploma_settings where tenant_id=t and enabled) then raise exception 'diploma_disabled'; end if;
 if p_command_id is null or jsonb_typeof(p_payload)<>'object' then raise exception 'diploma_payload_invalid'; end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||p_command_id::text,92621));
 select * into cmd from academy.diploma_commands where tenant_id=t and command_id=p_command_id;
 if cmd.command_id is not null then
  if cmd.actor_subject_id<>actor or cmd.action<>p_action or cmd.request_hash<>hash then raise exception 'command_id_reused_with_different_payload'; end if;
  return cmd.response;
 end if;
 insert into academy.diploma_commands(tenant_id,command_id,actor_subject_id,action,request_hash) values(t,p_command_id,actor,p_action,hash);
 if p_action='classify_program' then
  perform private_app.set_program_kind_v1(t,(p_payload->>'courseId')::uuid,p_payload->>'kind',p_payload->>'expectedKind');
 elsif p_action='set_collection_automation' then
  activate:=(p_payload->>'enabled')::boolean;
  select count(*) into affected from academy.diploma_contracts where tenant_id=t and status in ('active','settlement_review','collections_only');
  if activate is null or (p_payload->>'confirmed')::boolean is distinct from true or affected is distinct from (p_payload->>'expectedContractCount')::integer then raise exception 'diploma_changed'; end if;
  if activate and to_regnamespace('cron') is null then raise exception 'diploma_scheduler_unavailable'; end if;
  update academy.diploma_settings set collection_automation_enabled=activate,updated_by_subject_id=actor,updated_at=now() where tenant_id=t;
  if activate then
   execute $cron$select cron.schedule('diploma-collections-v1','*/5 * * * *','select private_app.diploma_collections_tick_v1(100)')$cron$;
  end if;
 else
  if p_action='create' then
   select * into h from academy.registration_handoffs where tenant_id=t and id=(p_payload->>'handoffId')::uuid for update;
   if h.id is null or h.status in ('completed','rejected','cancelled') or not exists(select 1 from academy.courses where tenant_id=t and id=h.course_id and program_kind='diploma') then raise exception 'diploma_program_required'; end if;
   if exists(select 1 from academy.diploma_contracts where tenant_id=t and handoff_id=h.id) then raise exception 'diploma_handoff_in_use'; end if;
   if not exists(select 1 from accounting_core.customer_accounts where tenant_id=t and id=(p_payload->>'payerAccountId')::uuid and status='active')
    or not exists(select 1 from people.staff_profiles where tenant_id=t and id=(p_payload->>'collectionOwnerId')::uuid and employment_status='active') then raise exception 'diploma_owner_or_payer_invalid'; end if;
   c.id:=gen_random_uuid(); c.tenant_id:=t; c.handoff_id:=h.id; c.total_minor:=(p_payload->>'totalMinor')::bigint; c.starts_on:=(p_payload->>'startsOn')::date;
   c.currency:=p_payload->>'currency'; c.first_installment_id:=(p_payload->'installments'->0->>'id')::uuid;
   c.first_installment_minor:=(p_payload->'installments'->0->>'amountMinor')::bigint; version:=1; reason:='initial_contract';
  else
   -- Serialize against the same handoff before locking the contract (admissions uses this order).
   select handoff_id into contract from academy.diploma_contracts where tenant_id=t and id=(p_payload->>'contractId')::uuid;
   perform 1 from academy.registration_handoffs where tenant_id=t and id=contract for update;
   select * into c from academy.diploma_contracts where tenant_id=t and id=(p_payload->>'contractId')::uuid for update;
   if c.id is null then raise exception 'diploma_contract_not_found'; end if;
   if c.current_version is distinct from (p_payload->>'expectedVersion')::integer then raise exception 'diploma_changed'; end if;
   version:=c.current_version+1;
  end if;
  contract:=c.id;
  if p_action='revise_draft' then
   if c.status<>'draft' then raise exception 'diploma_changed'; end if;
   if reason is null or length(reason)<3 then raise exception 'diploma_reason_required'; end if;
   if not exists(select 1 from accounting_core.customer_accounts where tenant_id=t and id=(p_payload->>'payerAccountId')::uuid and status='active')
    or not exists(select 1 from people.staff_profiles where tenant_id=t and id=(p_payload->>'collectionOwnerId')::uuid and employment_status='active') then raise exception 'diploma_owner_or_payer_invalid'; end if;
   c.total_minor:=(p_payload->>'totalMinor')::bigint;c.starts_on:=(p_payload->>'startsOn')::date;c.currency:=p_payload->>'currency';
   c.first_installment_id:=(p_payload->'installments'->0->>'id')::uuid;c.first_installment_minor:=(p_payload->'installments'->0->>'amountMinor')::bigint;
   update academy.diploma_contracts set total_minor=c.total_minor,starts_on=c.starts_on,currency=c.currency,
    payer_account_id=(p_payload->>'payerAccountId')::uuid,collection_owner_id=(p_payload->>'collectionOwnerId')::uuid,
    first_installment_id=c.first_installment_id,first_installment_minor=c.first_installment_minor where tenant_id=t and id=c.id;
  end if;
  if p_action in ('create','reschedule','revise_draft') then
   if p_action='reschedule' and (c.status<>'active' or reason is null or length(reason)<3) then raise exception 'diploma_reason_required'; end if;
   plan:=p_payload->'installments';
   if jsonb_typeof(plan) is distinct from 'array' or jsonb_array_length(plan) not between 1 and 120 or c.starts_on is null or c.total_minor is null or c.total_minor<=0 then raise exception 'diploma_schedule_invalid'; end if;
   for item in select value from jsonb_array_elements(plan) loop
    due:=(item->>'dueOn')::date; item_id:=(item->>'id')::uuid;
    if due is null or item_id is null or due<c.starts_on or due>(c.starts_on+interval '30 months')::date
     or (previous_due is not null and due<previous_due) or (item->>'amountMinor')::bigint is null or (item->>'amountMinor')::bigint<=0 then raise exception 'diploma_schedule_invalid'; end if;
    total:=total+(item->>'amountMinor')::bigint; previous_due:=due;
   end loop;
   if total<>c.total_minor or (select count(distinct value->>'id') from jsonb_array_elements(plan))<>jsonb_array_length(plan) then raise exception 'diploma_schedule_invalid'; end if;
   if p_action='reschedule' then
    if plan->0->>'id'<>c.first_installment_id::text or (plan->0->>'amountMinor')::bigint<>c.first_installment_minor then raise exception 'diploma_first_installment_immutable'; end if;
    if exists(select 1 from academy.diploma_invoice_links l join academy.diploma_installments i on i.tenant_id=t and i.contract_id=c.id and i.version=c.current_version and i.id=l.installment_id
     where l.tenant_id=t and l.contract_id=c.id and not exists(select 1 from jsonb_array_elements(plan) x where x->>'id'=i.id::text and (x->>'amountMinor')::bigint=i.amount_minor)) then raise exception 'diploma_linked_installment_required'; end if;
   elsif p_action='create' then
    insert into academy.diploma_contracts(id,tenant_id,handoff_id,payer_account_id,collection_owner_id,currency,total_minor,starts_on,first_installment_id,first_installment_minor,created_by_subject_id)
     values(c.id,t,c.handoff_id,(p_payload->>'payerAccountId')::uuid,(p_payload->>'collectionOwnerId')::uuid,c.currency,c.total_minor,c.starts_on,c.first_installment_id,c.first_installment_minor,actor);
   end if;
   insert into academy.diploma_schedule_versions(tenant_id,contract_id,version,reason,created_by_subject_id) values(t,c.id,version,reason,actor);
   for item in select value from jsonb_array_elements(plan) loop
    position:=position+1;
    insert into academy.diploma_installments(tenant_id,contract_id,version,id,position,due_on,amount_minor) values(t,c.id,version,(item->>'id')::uuid,position,(item->>'dueOn')::date,(item->>'amountMinor')::bigint);
   end loop;
   update academy.diploma_contracts set current_version=version where tenant_id=t and id=c.id;
  elsif p_action='approve' then
   if c.status<>'draft' then raise exception 'diploma_changed'; end if;
   update academy.diploma_contracts set status='active',approved_by_subject_id=actor,approved_at=now() where tenant_id=t and id=c.id;
  elsif p_action='link_invoice' then
   if c.status<>'active' then raise exception 'diploma_approval_required'; end if;
   select i.amount_minor into required_first from academy.diploma_installments i where i.tenant_id=t and i.contract_id=c.id and i.version=c.current_version and i.id=(p_payload->>'installmentId')::uuid;
   select * into d from accounting_core.sales_documents where tenant_id=t and id=(p_payload->>'invoiceId')::uuid;
   if required_first is null or d.id is null or d.document_type<>'invoice' or d.status<>'issued' or d.customer_account_id<>c.payer_account_id or d.currency<>c.currency or d.total_minor<>required_first
    or exists(select 1 from academy.diploma_invoice_links where tenant_id=t and invoice_id=d.id)
    or exists(select 1 from academy.training_financial_links where tenant_id=t and invoice_id=d.id) then raise exception 'diploma_invoice_invalid'; end if;
   insert into academy.diploma_invoice_links(tenant_id,contract_id,installment_id,invoice_id,linked_by_subject_id) values(t,c.id,(p_payload->>'installmentId')::uuid,d.id,actor);
  elsif p_action='waive_first_installment' then
   if c.status<>'active' then raise exception 'diploma_approval_required'; end if;
   if reason is null or length(reason)<3 then raise exception 'diploma_reason_required'; end if;
  elsif p_action='resolve_settlement' then
   if c.status not in ('settlement_review','collections_only') then raise exception 'diploma_settlement_review_required'; end if;
   if reason is null or length(reason)<3 then raise exception 'diploma_reason_required'; end if;
   preview:=private_app.diploma_settlement_preview_v1(t,c.id);
   if (p_payload->>'confirmed')::boolean is distinct from true or p_payload->>'previewRevision' is distinct from preview->>'revision' then raise exception 'diploma_changed'; end if;
   kind:=p_payload->>'resolution';
   if kind is null or kind not in ('collections_only','closed') then raise exception 'diploma_settlement_resolution_invalid'; end if;
   if kind='closed' and (preview->>'canClose')::boolean is distinct from true then raise exception 'diploma_outstanding_balance'; end if;
   update academy.diploma_contracts set status=kind where tenant_id=t and id=c.id;
  end if;
 end if;
 insert into academy.diploma_events(tenant_id,contract_id,kind,reason,payload,actor_subject_id)
 values(t,contract,case when p_action='waive_first_installment' then 'first_installment_waived' else p_action end,reason,p_payload,actor);
 if contract is not null then
  perform private_app.reconcile_diploma_collection_v1(t,contract);
  if to_regprocedure('private_app.reconcile_admission_governance_v1(uuid,uuid)') is not null then
   execute 'select private_app.reconcile_admission_governance_v1($1,$2)' using t,c.handoff_id;
  end if;
 end if;
 result_value:=jsonb_build_object('ok',true,'contractId',contract);
 update academy.diploma_commands set response=result_value where tenant_id=t and command_id=p_command_id;
 return result_value;
end $$;

revoke all on function private_app.diploma_immutable_v1(),private_app.guard_diploma_invoice_link_v1(),private_app.diploma_tenant_v1(text),
 private_app.set_program_kind_v1(uuid,uuid,text,text),
 private_app.queue_diploma_collection_v1(uuid,uuid),
 private_app.diploma_settlement_preview_v1(uuid,uuid),private_app.mark_diploma_settlement_review_v1(uuid,uuid,uuid),private_app.diploma_collections_tick_v1(integer),
 private_app.diploma_admission_eligibility_v1(uuid,uuid),private_app.diploma_installment_state_v1(uuid,uuid,timestamptz),
 private_app.reconcile_diploma_collection_v1(uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.v1_tenant_diploma_snapshot(text,uuid),public.v1_tenant_diploma_action(text,text,uuid,jsonb),
 public.v1_tenant_program_kinds(text,uuid[]),public.v1_tenant_classify_program(text,uuid,text,text,uuid),
 public.v1_diploma_collections_tick(integer) from public,anon,authenticated;
grant execute on function public.v1_tenant_diploma_snapshot(text,uuid),public.v1_tenant_diploma_action(text,text,uuid,jsonb) to authenticated;
grant execute on function public.v1_tenant_program_kinds(text,uuid[]),public.v1_tenant_classify_program(text,uuid,text,text,uuid) to authenticated;
grant execute on function public.v1_diploma_collections_tick(integer) to service_role;
commit;
