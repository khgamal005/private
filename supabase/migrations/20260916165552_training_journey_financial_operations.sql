-- Marktone training journey: additive, disabled by default, no data backfill.
-- Financial truth remains accounting_core; learners never receive staff memberships.
begin;

create table academy.training_journey_settings (
  tenant_id uuid primary key references core.tenants(id) on delete cascade,
  enabled boolean not null default false,
  grace_days integer not null default 7 check (grace_days between 0 and 90),
  policy_version integer not null default 1 check (policy_version > 0),
  policy_source text not null default 'tenant_approved_operating_policy',
  updated_by_subject_id uuid references access_control.subjects(id),
  updated_at timestamptz not null default now(),
  check (tenant_id = '3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid)
);

create table academy.training_financial_links (
  tenant_id uuid not null references core.tenants(id),
  handoff_id uuid not null,
  invoice_id uuid not null,
  payer_account_id uuid not null,
  policy text not null check (policy in ('full','installments','company_credit')),
  sponsor boolean not null default false,
  credit_limit_minor bigint check (credit_limit_minor >= 0),
  credit_expires_on date,
  credit_approved_by_subject_id uuid references access_control.subjects(id),
  credit_approved_at timestamptz,
  credit_reason text,
  exception_until timestamptz,
  exception_by_subject_id uuid references access_control.subjects(id),
  exception_reason text,
  certificate_requires_settlement boolean not null default true,
  policy_version integer not null default 1,
  created_by_subject_id uuid not null references access_control.subjects(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,handoff_id),
  foreign key (tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
  foreign key (tenant_id,invoice_id) references accounting_core.sales_documents(tenant_id,id),
  foreign key (tenant_id,payer_account_id) references accounting_core.customer_accounts(tenant_id,id),
  check (policy <> 'company_credit' or sponsor),
  check ((credit_approved_at is null and credit_approved_by_subject_id is null) or
    (credit_approved_at is not null and credit_approved_by_subject_id is not null
     and credit_limit_minor is not null and credit_expires_on is not null and length(btrim(credit_reason)) >= 3)),
  check (exception_until is null or (exception_by_subject_id is not null and length(btrim(exception_reason)) >= 3))
);
create index training_financial_invoice_idx on academy.training_financial_links(tenant_id,invoice_id);

create table academy.training_journey_commands (
  tenant_id uuid not null references core.tenants(id),
  command_id uuid not null,
  actor_subject_id uuid not null references access_control.subjects(id),
  action text not null,
  request_hash text not null,
  response jsonb,
  transaction_id bigint not null default txid_current(),
  auto_handoff_id uuid references academy.registration_handoffs(id),
  auto_run_id uuid references academy.course_runs(id),
  created_at timestamptz not null default now(),
  primary key (tenant_id,command_id)
);
create index training_journey_auto_claim_idx on academy.training_journey_commands(tenant_id,auto_handoff_id,transaction_id) where auto_handoff_id is not null;

create table academy.training_journey_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id),
  enrollment_id uuid not null references academy.enrollments(id),
  kind text not null check (kind in ('transfer','defer','resume','withdraw','access_exception')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reason text not null check (length(btrim(reason)) between 3 and 2000),
  target_run_id uuid references academy.course_runs(id),
  assigned_staff_id uuid not null references people.staff_profiles(id),
  due_at timestamptz not null,
  requested_by_subject_id uuid not null references access_control.subjects(id),
  decided_by_subject_id uuid references access_control.subjects(id),
  decided_at timestamptz,
  decision_reason text,
  result jsonb,
  created_at timestamptz not null default now(),
  unique(tenant_id,id)
);
create index training_journey_requests_queue_idx on academy.training_journey_requests(tenant_id,status,due_at,id);
create unique index training_journey_one_pending_request_idx on academy.training_journey_requests(tenant_id,enrollment_id,kind) where status='pending';

create table academy.training_journey_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id),
  actor_subject_id uuid references access_control.subjects(id),
  event_type text not null,
  resource_id uuid,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index training_journey_events_timeline_idx on academy.training_journey_events(tenant_id,resource_id,occurred_at desc,id);

alter table academy.training_journey_settings enable row level security;
alter table academy.training_journey_settings force row level security;
alter table academy.training_financial_links enable row level security;
alter table academy.training_financial_links force row level security;
alter table academy.training_journey_commands enable row level security;
alter table academy.training_journey_commands force row level security;
alter table academy.training_journey_requests enable row level security;
alter table academy.training_journey_requests force row level security;
alter table academy.training_journey_events enable row level security;
alter table academy.training_journey_events force row level security;
revoke all on academy.training_journey_settings,academy.training_financial_links,
 academy.training_journey_commands,academy.training_journey_requests,academy.training_journey_events from public,anon,authenticated;

insert into access_control.permissions(permission_key,module_key,name_ar,description) values
 ('tenant.admissions.payment.verify','admissions','تأكيد دفع المتدرب','تأكيد التحصيل المرتبط بفاتورة تسجيل محددة دون منح قراءة مالية شاملة')
on conflict(permission_key) do nothing;

create function private_app.training_journey_tenant_v1(p_slug text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 if auth.uid() is null or not exists(select 1 from access_control.subjects s
   where s.auth_user_id=auth.uid() and s.status='active' and not s.must_change_password)
 then raise exception 'authentication_required' using errcode='42501'; end if;
 select id into t from core.tenants where slug=p_slug and slug='marktone'
   and id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and status in ('trial','active');
 if t is null then raise exception 'training_journey_not_available' using errcode='42501'; end if;
 if not exists(select 1 from academy.training_journey_settings where tenant_id=t and enabled)
 then raise exception 'training_journey_disabled'; end if;
 if not private_app.tenant_addon_enabled(t,'lms') then raise exception 'training_addon_required' using errcode='42501'; end if;
 return t;
end $$;

create function private_app.training_journey_payment_authorized_v1(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_tenant_id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid
 and exists(select 1 from core.tenants t join academy.training_journey_settings s on s.tenant_id=t.id
  where t.id=p_tenant_id and t.slug='marktone' and t.status in ('trial','active') and s.enabled)
 and private_app.tenant_addon_enabled(p_tenant_id,'lms')
 and (private_app.has_accounting_permission(p_tenant_id,'tenant.accounting.payments.approve')
  or private_app.has_tenant_permission(p_tenant_id,'tenant.admissions.payment.verify'))
$$;

create function private_app.training_journey_command_v1(p_tenant_id uuid,p_command_id uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c academy.training_journey_commands%rowtype; actor uuid:=private_app.current_subject_id();
 hash text:=md5(coalesce(p_payload,'{}'::jsonb)::text);
begin
 if p_command_id is null or actor is null then raise exception 'training_command_required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_command_id::text,91216));
 select * into c from academy.training_journey_commands where tenant_id=p_tenant_id and command_id=p_command_id;
 if c.command_id is not null then
  if c.actor_subject_id<>actor or c.action<>p_action or c.request_hash<>hash then raise exception 'command_id_reused_with_different_payload'; end if;
  if c.response is null then raise exception 'training_command_incomplete'; end if;
  return c.response;
 end if;
 insert into academy.training_journey_commands(tenant_id,command_id,actor_subject_id,action,request_hash)
 values(p_tenant_id,p_command_id,actor,p_action,hash);
 return null;
end $$;

create function private_app.training_journey_complete_command_v1(p_tenant_id uuid,p_command_id uuid,p_response jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 update academy.training_journey_commands set response=p_response where tenant_id=p_tenant_id and command_id=p_command_id
 and actor_subject_id=private_app.current_subject_id() and response is null;
 if not found then raise exception 'training_command_not_claimed'; end if;
 return p_response;
end $$;

create function private_app.training_journey_handoff_finance_v1(p_handoff_id uuid,p_as_of timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare l academy.training_financial_links%rowtype; d accounting_core.sales_documents%rowtype;
 t core.tenants%rowtype; paid bigint:=0; first_due bigint; schedule_total bigint:=0; required bigint:=0; overdue date;
 days integer:=7; today date; reasons jsonb:='[]'; allowed boolean:=false; cert boolean:=false;
 state text:='unlinked'; credit boolean:=false; exception_active boolean:=false; payer_cap bigint; payer_outstanding bigint;
begin
 select * into l from academy.training_financial_links where handoff_id=p_handoff_id;
 if l.handoff_id is null then return jsonb_build_object('trainingAllowed',false,'certificationAllowed',false,'financialStatus','unlinked','reasonCodes',jsonb_build_array('invoice_link_required'),'paidMinor',0,'totalMinor',null,'outstandingMinor',null); end if;
 select * into t from core.tenants where id=l.tenant_id;
 select * into d from accounting_core.sales_documents where tenant_id=l.tenant_id and id=l.invoice_id
   and customer_account_id=l.payer_account_id and document_type='invoice' and status='issued';
 if d.id is null then return jsonb_build_object('trainingAllowed',false,'certificationAllowed',false,'financialStatus','invalid_invoice','reasonCodes',jsonb_build_array('issued_invoice_required')); end if;
 today:=(p_as_of at time zone t.timezone)::date;
 select grace_days into days from academy.training_journey_settings where tenant_id=t.id;
 -- A refund without invoice allocation is conservatively deducted from each affected invoice;
 -- this never grants access using refunded money. No financial records are created here.
 select coalesce(sum(greatest(0,a.amount_minor-coalesce((select sum(r.amount_minor)
   from accounting_core.refunds r where r.tenant_id=l.tenant_id and r.payment_id=p.id
   and r.status='completed' and (r.invoice_id=d.id or r.invoice_id is null)),0))),0)
 into paid from accounting_core.payment_allocations a join accounting_core.payments p
 on p.tenant_id=a.tenant_id and p.id=a.payment_id and p.status='verified' and p.currency=d.currency and p.customer_account_id=l.payer_account_id
 where a.tenant_id=l.tenant_id and a.invoice_id=d.id;
 paid:=least(paid,d.total_minor);
 select amount_minor into first_due from accounting_core.payment_schedules
 where tenant_id=l.tenant_id and invoice_id=d.id order by installment_number limit 1;
 select coalesce(sum(amount_minor),0) into schedule_total from accounting_core.payment_schedules where tenant_id=l.tenant_id and invoice_id=d.id;
 select min(q.due_date) into overdue from (select due_date,
 sum(amount_minor) over(order by due_date,installment_number rows unbounded preceding) due_total
 from accounting_core.payment_schedules where tenant_id=l.tenant_id and invoice_id=d.id) q
 where q.due_date<today and q.due_total>paid;
 if first_due is null and d.due_date<today and paid<d.total_minor then overdue:=d.due_date; end if;
 credit:=l.policy='company_credit' and l.sponsor and l.credit_approved_by_subject_id is not null
  and l.credit_expires_on>=today and l.credit_limit_minor>=d.total_minor-paid;
 select credit_limit_minor into payer_cap from accounting_core.customer_accounts where tenant_id=l.tenant_id and id=l.payer_account_id;
 if credit and payer_cap is not null then
  select coalesce(sum(greatest(0,doc.total_minor-coalesce((select sum(greatest(0,al.amount_minor-coalesce((
    select sum(rf.amount_minor) from accounting_core.refunds rf where rf.tenant_id=l.tenant_id and rf.payment_id=pay.id
     and rf.status='completed' and (rf.invoice_id=doc.id or rf.invoice_id is null)),0)))
    from accounting_core.payment_allocations al join accounting_core.payments pay on pay.tenant_id=al.tenant_id and pay.id=al.payment_id
     and pay.status='verified' and pay.customer_account_id=l.payer_account_id and pay.currency=doc.currency
    where al.tenant_id=l.tenant_id and al.invoice_id=doc.id),0))),0)
   into payer_outstanding from accounting_core.sales_documents doc where doc.tenant_id=l.tenant_id
    and doc.customer_account_id=l.payer_account_id and doc.document_type='invoice' and doc.status='issued';
  if payer_outstanding>payer_cap then credit:=false; reasons:=reasons||jsonb_build_array('company_credit_limit_exceeded'); end if;
 end if;
 exception_active:=l.exception_until>p_as_of and l.exception_by_subject_id is not null;
 if paid>=d.total_minor then allowed:=true; state:='settled';
 elsif credit then allowed:=true; state:='approved_credit';
 elsif l.policy='installments' then
  if first_due is null or schedule_total<>d.total_minor then reasons:=reasons||jsonb_build_array('complete_installment_plan_required');
  elsif paid<first_due then reasons:=reasons||jsonb_build_array('first_installment_required');
  elsif overdue is not null and today>overdue+coalesce(days,7) then reasons:=reasons||jsonb_build_array('installment_grace_expired'); state:='overdue';
  else allowed:=true; state:=case when overdue is null then 'installments_current' else 'grace_period' end; end if;
 else reasons:=reasons||jsonb_build_array(case when l.policy='company_credit' then 'credit_approval_required' else 'full_payment_required' end);
 end if;
 if not allowed and exception_active then allowed:=true; state:='temporary_exception'; end if;
 if state='unlinked' then state:='awaiting_payment'; end if;
 cert:=paid>=d.total_minor or (not l.certificate_requires_settlement and credit);
 return jsonb_build_object('trainingAllowed',allowed,'certificationAllowed',cert,'financialStatus',state,
  'reasonCodes',reasons,'paidMinor',paid,'totalMinor',d.total_minor,'outstandingMinor',greatest(d.total_minor-paid,0),
  'overdueSince',overdue,'graceEndsOn',case when overdue is not null then overdue+coalesce(days,7) end,
  'invoiceId',d.id,'currency',d.currency,'policy',l.policy,'policyVersion',l.policy_version);
end $$;

create function private_app.training_journey_credit_authorized_v1(p_handoff_id uuid,p_as_of timestamptz default now()) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from academy.training_financial_links l
  join academy.training_journey_settings s on s.tenant_id=l.tenant_id and s.enabled
  join core.tenants t on t.id=l.tenant_id and t.slug='marktone' and t.status in ('trial','active')
  where l.handoff_id=p_handoff_id and l.tenant_id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid
  and l.policy='company_credit' and l.sponsor and l.credit_approved_by_subject_id is not null
  and private_app.tenant_addon_enabled(l.tenant_id,'lms')
  and private_app.training_journey_handoff_finance_v1(l.handoff_id,p_as_of)->>'financialStatus' in ('approved_credit','settled'))
$$;

create function private_app.training_journey_financial_access_v1(p_enrollment_id uuid,p_as_of timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e academy.enrollments%rowtype; f jsonb;
begin
 select * into e from academy.enrollments where id=p_enrollment_id;
 if e.id is null then raise exception 'enrollment_not_found'; end if;
 f:=private_app.training_journey_handoff_finance_v1(e.handoff_id,p_as_of);
 if not exists(select 1 from academy.registration_handoffs h where h.tenant_id=e.tenant_id and h.id=e.handoff_id and h.status='completed'
  and (h.payment_status='verified' or private_app.training_journey_credit_authorized_v1(h.id,p_as_of))) then
  f:=f||jsonb_build_object('trainingAllowed',false,'certificationAllowed',false,
   'reasonCodes',coalesce(f->'reasonCodes','[]')||jsonb_build_array('admission_confirmation_required'));
 end if;
 if e.status not in ('confirmed','active','completed') then
  f:=f||jsonb_build_object('trainingAllowed',false,'certificationAllowed',false,
   'reasonCodes',coalesce(f->'reasonCodes','[]')||jsonb_build_array('enrollment_inactive'));
 end if;
 if e.metadata->>'trainingJourneyDeferred'='true' then
  f:=f||jsonb_build_object('trainingAllowed',false,'certificationAllowed',false,
   'reasonCodes',coalesce(f->'reasonCodes','[]')||jsonb_build_array('enrollment_deferred'));
 end if;
 return f;
end $$;

create function private_app.training_journey_append_event_v1(p_tenant_id uuid,p_event text,p_resource uuid,p_payload jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into academy.training_journey_events(tenant_id,actor_subject_id,event_type,resource_id,payload)
 values(p_tenant_id,private_app.current_subject_id(),p_event,p_resource,coalesce(p_payload,'{}'));
 perform private_app.write_audit('training_journey.'||p_event,'training_journey',p_resource::text,p_tenant_id,coalesce(p_payload,'{}'));
end $$;

create function private_app.training_journey_guard_finance_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare f jsonb;
begin
 if new.tenant_id<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid or not exists(
 select 1 from academy.training_journey_settings where tenant_id=new.tenant_id and enabled) then return new; end if;
 if tg_table_name='registration_handoffs' then
  if not exists(select 1 from academy.training_financial_links where tenant_id=new.tenant_id and handoff_id=new.id) then return new; end if;
  if new.payment_status='verified' and (tg_op='INSERT' or old.payment_status is distinct from 'verified') then
   if not private_app.training_journey_payment_authorized_v1(new.tenant_id) then raise exception 'training_payment_verification_forbidden' using errcode='42501'; end if;
   f:=private_app.training_journey_handoff_finance_v1(new.id);
   if not coalesce((f->>'trainingAllowed')::boolean,false) then raise exception 'training_financial_clearance_required'; end if;
   if coalesce((f->>'paidMinor')::bigint,0)<=0 and coalesce((f->>'totalMinor')::bigint,1)>0 then raise exception 'training_payment_evidence_required'; end if;
  end if;
 elsif tg_table_name='enrollments' and new.status in ('confirmed','active','completed') then
  if not exists(select 1 from academy.training_financial_links where tenant_id=new.tenant_id and handoff_id=new.handoff_id) then return new; end if;
  f:=private_app.training_journey_handoff_finance_v1(new.handoff_id);
  if not coalesce((f->>'trainingAllowed')::boolean,false) then raise exception 'training_financial_clearance_required'; end if;
 elsif tg_table_name='certificates' and new.status='issued' then
  if not exists(select 1 from academy.training_financial_links l join academy.enrollments e on e.tenant_id=l.tenant_id and e.handoff_id=l.handoff_id where e.tenant_id=new.tenant_id and e.id=new.enrollment_id) then return new; end if;
  f:=private_app.training_journey_financial_access_v1(new.enrollment_id);
  if not coalesce((f->>'certificationAllowed')::boolean,false) then raise exception 'training_certificate_financial_clearance_required'; end if;
 end if;
 return new;
end $$;
create trigger training_journey_admission_finance_guard before update of payment_status on academy.registration_handoffs
 for each row execute function private_app.training_journey_guard_finance_v1();
create trigger training_journey_enrollment_finance_guard before insert or update of status,course_run_id on academy.enrollments
 for each row execute function private_app.training_journey_guard_finance_v1();
create trigger training_journey_certificate_finance_guard before insert or update of status on academy.certificates
 for each row execute function private_app.training_journey_guard_finance_v1();

-- RPC definitions follow below. Their authorization runs before idempotency lookup.
create function private_app.training_journey_lock_handoff_v1(p_tenant_id uuid,p_handoff_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare contact uuid;
begin
 select contact_id into contact from academy.registration_handoffs where tenant_id=p_tenant_id and id=p_handoff_id;
 if contact is null then raise exception 'admission_not_found'; end if;
 -- Match v2_tenant_update_admission commerce -> contact -> handoff order before finance locks.
 perform 1 from commerce_sync.connections where tenant_id=p_tenant_id and id in (
  select w.connection_id from sales_core.commerce_admission_lines l join sales_core.commerce_order_work_items w
  on w.tenant_id=p_tenant_id and w.id=l.work_item_id where l.tenant_id=p_tenant_id and l.handoff_id=p_handoff_id) order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||contact::text,31603));
 perform 1 from sales_core.contacts where tenant_id=p_tenant_id and id=contact for update;
 perform 1 from academy.registration_handoffs where tenant_id=p_tenant_id and id=p_handoff_id for update;
end $$;

create function private_app.training_journey_auto_admission_authorized_v1(p_tenant_id uuid,p_handoff_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private_app.training_journey_payment_authorized_v1(p_tenant_id) and exists(
  select 1 from academy.training_journey_commands cmd join academy.registration_handoffs h
   on h.tenant_id=cmd.tenant_id and h.id=cmd.auto_handoff_id and h.course_run_id=cmd.auto_run_id
  where cmd.tenant_id=p_tenant_id and cmd.auto_handoff_id=p_handoff_id and cmd.transaction_id=txid_current()
   and cmd.actor_subject_id=private_app.current_subject_id() and cmd.action='operations.verify_payment'
   and cmd.response is null and h.payment_status='verified')
$$;

create function private_app.training_journey_request_v1(p_tenant_id uuid,p_enrollment_id uuid,p_kind text,p_reason text,
 p_target_run_id uuid default null,p_staff_id uuid default null,p_due_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e academy.enrollments%rowtype; h academy.registration_handoffs%rowtype; req uuid; task uuid;
 staff uuid:=p_staff_id; deadline timestamptz:=p_due_at; tz text;
begin
 select * into e from academy.enrollments where tenant_id=p_tenant_id and id=p_enrollment_id for update;
 if e.id is null or e.status in ('withdrawn','cancelled') then raise exception 'enrollment_not_active'; end if;
 if e.status='completed' or exists(select 1 from academy.certificates where tenant_id=p_tenant_id and enrollment_id=e.id and status='issued')
 then raise exception 'training_completed_enrollment_change_requires_review'; end if;
 if p_kind not in ('transfer','defer','resume','withdraw','access_exception') then raise exception 'training_request_kind_invalid'; end if;
 if p_kind='resume' and coalesce(e.metadata->>'trainingJourneyDeferred','false')<>'true' then raise exception 'training_enrollment_not_deferred'; end if;
 if length(btrim(coalesce(p_reason,''))) not between 3 and 2000 then raise exception 'training_reason_required'; end if;
 select * into h from academy.registration_handoffs where tenant_id=p_tenant_id and id=e.handoff_id;
 if p_kind='transfer' and not exists(select 1 from academy.course_runs where tenant_id=p_tenant_id and id=p_target_run_id and status='open') then raise exception 'training_target_run_invalid'; end if;
 if staff is null then
  select id into staff from people.staff_profiles where tenant_id=p_tenant_id and employment_status='active'
   and (id=h.assigned_staff_id or role_key in ('admissions','registrar','registration_officer','training_manager','tenant_admin','tenant_owner'))
  order by (id=h.assigned_staff_id) desc nulls last,created_at,id limit 1;
 end if;
 if not exists(select 1 from people.staff_profiles where tenant_id=p_tenant_id and id=staff and employment_status='active') then raise exception 'training_responsible_staff_required'; end if;
 select timezone into tz from core.tenants where id=p_tenant_id;
 deadline:=coalesce(deadline,(((now() at time zone tz)::date+1)+time '17:00') at time zone tz);
 if deadline<=now() then raise exception 'training_due_date_invalid'; end if;
 insert into academy.training_journey_requests(tenant_id,enrollment_id,kind,reason,target_run_id,assigned_staff_id,due_at,requested_by_subject_id)
 values(p_tenant_id,e.id,p_kind,btrim(p_reason),p_target_run_id,staff,deadline,private_app.current_subject_id()) returning id into req;
 insert into work_core.tasks(tenant_id,task_key,title,description,status,priority,assigned_staff_id,created_by_subject_id,contact_id,due_at,metadata)
 values(p_tenant_id,'training-request-'||req::text,'مراجعة طلب المتدرب',btrim(p_reason),'todo','normal',staff,
 private_app.current_subject_id(),h.contact_id,deadline,jsonb_build_object('source','training_journey','requestId',req,'enrollmentId',e.id,'kind',p_kind)) returning id into task;
 insert into work_core.notifications(tenant_id,notification_key,recipient_staff_id,notification_type,title,message,severity,action_path,contact_id,handoff_id,metadata)
 values(p_tenant_id,'training-request-'||req::text,staff,'training_journey_request','طلب متدرب ينتظر المراجعة',btrim(p_reason),'info','lms',h.contact_id,h.id,
 jsonb_build_object('source','training_journey','requestId',req,'taskId',task)) on conflict do nothing;
 perform private_app.training_journey_append_event_v1(p_tenant_id,'request.created',req,jsonb_build_object('enrollmentId',e.id,'kind',p_kind,'assignedStaffId',staff));
 return jsonb_build_object('requestId',req,'status','pending','taskId',task);
end $$;

create function public.v1_tenant_training_journey_action(p_slug text,p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid; actor uuid:=private_app.current_subject_id(); command uuid; result jsonb; cached jsonb; f jsonb;
 h academy.registration_handoffs%rowtype; e academy.enrollments%rowtype; d accounting_core.sales_documents%rowtype;
 p accounting_core.payments%rowtype; l academy.training_financial_links%rowtype; req academy.training_journey_requests%rowtype;
 run academy.course_runs%rowtype; new_h uuid; new_e uuid; amount bigint; allocated bigint; remaining bigint; staff uuid;
 can_manage boolean; can_verify boolean; learner boolean:=false; row_record record; affected integer:=0; tz text; assignment_issue text; auto_result jsonb;
begin
 if auth.uid() is null or actor is null then raise exception 'authentication_required' using errcode='42501'; end if;
 if jsonb_typeof(p_payload)<>'object' then raise exception 'training_payload_invalid'; end if;
 if p_action='set_enabled' then
  select id into t from core.tenants where slug=p_slug and slug='marktone' and id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and status in ('trial','active');
  if t is null or not private_app.has_tenant_permission(t,'tenant.settings.manage') or not private_app.has_tenant_permission(t,'tenant.academy.write')
   then raise exception 'forbidden' using errcode='42501'; end if;
  if not private_app.tenant_addon_enabled(t,'lms') then raise exception 'training_addon_required'; end if;
 else t:=private_app.training_journey_tenant_v1(p_slug); end if;
 can_manage:=private_app.has_tenant_permission(t,'tenant.academy.write') and private_app.has_tenant_permission(t,'tenant.admissions.write');
 can_verify:=private_app.training_journey_payment_authorized_v1(t);
 if p_action not in ('set_enabled','configure_finance','approve_credit','verify_payment','confirm_admission','create_request','decide_request','reconcile') then raise exception 'training_action_invalid'; end if;
 if p_action='create_request' and not can_manage then
  -- The learning migration installs this authorization helper; never infer ownership from email.
  if to_regprocedure('private_app.training_learning_owns_enrollment_v1(uuid,uuid)') is not null then
   execute 'select private_app.training_learning_owns_enrollment_v1($1,$2)' into learner using t,(p_payload->>'enrollmentId')::uuid;
  end if;
  if not coalesce(learner,false) or p_payload->>'kind' not in ('transfer','defer','resume','withdraw') then raise exception 'forbidden' using errcode='42501'; end if;
 elsif p_action in ('configure_finance','approve_credit','verify_payment') then
  if not can_verify then raise exception 'training_payment_verification_forbidden' using errcode='42501'; end if;
  if p_action='approve_credit' and not private_app.has_accounting_permission(t,'tenant.accounting.payments.approve') then raise exception 'forbidden' using errcode='42501'; end if;
 elsif p_action<>'set_enabled' and not can_manage then raise exception 'forbidden' using errcode='42501'; end if;
 command:=(p_payload->>'commandId')::uuid;
 cached:=private_app.training_journey_command_v1(t,command,'operations.'||p_action,p_payload);
 if cached is not null then return cached; end if;

 if p_action='set_enabled' then
  if jsonb_typeof(p_payload->'enabled')<>'boolean' then raise exception 'training_enabled_required'; end if;
  insert into academy.training_journey_settings(tenant_id,enabled,updated_by_subject_id)
  values(t,(p_payload->>'enabled')::boolean,actor) on conflict(tenant_id) do update
  set enabled=excluded.enabled,updated_by_subject_id=actor,updated_at=now();
  result:=jsonb_build_object('enabled',(p_payload->>'enabled')::boolean);

 elsif p_action='configure_finance' then
  perform private_app.training_journey_lock_handoff_v1(t,(p_payload->>'handoffId')::uuid);
  select * into h from academy.registration_handoffs where tenant_id=t and id=(p_payload->>'handoffId')::uuid for update;
  select * into d from accounting_core.sales_documents where tenant_id=t and id=(p_payload->>'invoiceId')::uuid
   and document_type='invoice' and status='issued' for update;
  if h.id is null or d.id is null then raise exception 'training_invoice_link_invalid'; end if;
  if not coalesce((p_payload->>'sponsor')::boolean,false) and not exists(select 1 from accounting_core.customer_accounts
   where tenant_id=t and id=d.customer_account_id and contact_id=h.contact_id) then raise exception 'training_invoice_beneficiary_mismatch'; end if;
  if coalesce((p_payload->>'sponsor')::boolean,false) and not private_app.has_accounting_permission(t,'tenant.accounting.payments.approve') then raise exception 'training_sponsor_link_forbidden'; end if;
  if exists(select 1 from academy.enrollments where tenant_id=t and handoff_id=h.id and status='completed') then raise exception 'training_completed_finance_immutable'; end if;
  insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,sponsor,created_by_subject_id)
  values(t,h.id,d.id,d.customer_account_id,p_payload->>'policy',coalesce((p_payload->>'sponsor')::boolean,false),actor)
  on conflict(tenant_id,handoff_id) do update set invoice_id=excluded.invoice_id,payer_account_id=excluded.payer_account_id,
   policy=excluded.policy,sponsor=excluded.sponsor,credit_limit_minor=null,credit_expires_on=null,credit_approved_by_subject_id=null,
   credit_approved_at=null,credit_reason=null,exception_until=null,exception_by_subject_id=null,exception_reason=null,
   policy_version=academy.training_financial_links.policy_version+1,updated_at=now();
  result:=jsonb_build_object('handoffId',h.id,'financial',private_app.training_journey_handoff_finance_v1(h.id));

 elsif p_action='approve_credit' then
  perform private_app.training_journey_lock_handoff_v1(t,(p_payload->>'handoffId')::uuid);
  if length(btrim(coalesce(p_payload->>'reason','')))<3 then raise exception 'training_reason_required'; end if;
  select * into l from academy.training_financial_links where tenant_id=t and handoff_id=(p_payload->>'handoffId')::uuid for update;
  if l.handoff_id is null or not l.sponsor or l.policy<>'company_credit' then raise exception 'training_credit_target_invalid'; end if;
  select timezone into tz from core.tenants where id=t;
  if nullif(p_payload->>'expiresOn','') is null or (p_payload->>'expiresOn')::date<(now() at time zone tz)::date then raise exception 'training_credit_expired'; end if;
  update academy.training_financial_links set credit_limit_minor=(p_payload->>'limitMinor')::bigint,
   credit_expires_on=(p_payload->>'expiresOn')::date,credit_approved_by_subject_id=actor,credit_approved_at=now(),
   credit_reason=btrim(p_payload->>'reason'),policy_version=policy_version+1,updated_at=now()
   where tenant_id=t and handoff_id=l.handoff_id;
  result:=jsonb_build_object('handoffId',l.handoff_id,'financial',private_app.training_journey_handoff_finance_v1(l.handoff_id));

 elsif p_action='verify_payment' then
  perform private_app.training_journey_lock_handoff_v1(t,(p_payload->>'handoffId')::uuid);
  select * into l from academy.training_financial_links where tenant_id=t and handoff_id=(p_payload->>'handoffId')::uuid;
  if l.handoff_id is null then raise exception 'training_invoice_link_required'; end if;
  -- Same lock order as the accounting allocation action: payment, then invoice.
  if nullif(p_payload->>'paymentId','') is not null then
   select * into p from accounting_core.payments where tenant_id=t and id=(p_payload->>'paymentId')::uuid
    and customer_account_id=l.payer_account_id and status in ('pending_verification','verified') for update;
   if p.id is null then raise exception 'training_payment_invalid'; end if;
  end if;
  select * into d from accounting_core.sales_documents where tenant_id=t and id=l.invoice_id and status='issued' and document_type='invoice' for update;
  if d.id is null then raise exception 'training_invoice_invalid'; end if;
  if p.id is not null then
   if p.currency<>d.currency then raise exception 'training_payment_currency_mismatch'; end if;
   update accounting_core.payments set status='verified',verified_at=coalesce(verified_at,now()),
    verified_by_subject_id=coalesce(verified_by_subject_id,actor),rejection_reason=null where tenant_id=t and id=p.id;
   select coalesce(sum(amount_minor),0) into allocated from accounting_core.payment_allocations where tenant_id=t and payment_id=p.id;
   select d.total_minor-coalesce(sum(amount_minor),0) into remaining from accounting_core.payment_allocations where tenant_id=t and invoice_id=d.id;
   amount:=least(p.amount_minor-allocated,remaining);
   if amount>0 then
    insert into accounting_core.payment_allocations(tenant_id,payment_id,invoice_id,amount_minor,created_by_subject_id)
    values(t,p.id,d.id,amount,actor) on conflict(tenant_id,payment_id,invoice_id) do update
    set amount_minor=accounting_core.payment_allocations.amount_minor+excluded.amount_minor;
   end if;
  end if;
  f:=private_app.training_journey_handoff_finance_v1(l.handoff_id);
  select * into h from academy.registration_handoffs where tenant_id=t and id=l.handoff_id;
  if coalesce((f->>'trainingAllowed')::boolean,false) and h.payment_status<>'verified'
   and (coalesce((f->>'paidMinor')::bigint,0)>0 or (f->>'totalMinor')::bigint=0) then
   perform public.v2_tenant_update_admission(p_slug,h.id,'verify_payment');
   h.payment_status:='verified';
  end if;
  result:=jsonb_build_object('handoffId',h.id,'paymentId',p.id,'financial',f,'paymentStatus',h.payment_status,
   'paymentVerified',p.id is not null,'admissionReady',coalesce((f->>'trainingAllowed')::boolean,false));
  if p.id is not null and h.payment_status='verified' and h.course_run_id is not null and h.status<>'completed'
    and coalesce((f->>'trainingAllowed')::boolean,false) then
   -- A persisted command receipt authorizes exactly this actor, transaction, handoff and already
   -- selected run. No session flag or impersonated role can manufacture this capability.
   update academy.training_journey_commands set auto_handoff_id=h.id,auto_run_id=h.course_run_id where tenant_id=t and command_id=command;
   begin
    auto_result:=public.v2_tenant_update_admission(p_slug,h.id,'complete');
    select id into new_e from academy.enrollments where tenant_id=t and handoff_id=h.id;
    if new_e is not null and to_regprocedure('private_app.training_learning_pin_latest_v1(uuid,uuid)') is not null then
     execute 'select private_app.training_learning_pin_latest_v1($1,$2)' into new_h using t,new_e;
    end if;
    result:=result||jsonb_build_object('autoAssigned',true,'enrollmentId',new_e,'learningReady',new_h is not null,'contentVersionId',new_h);
    h.status:='completed';
   exception when others then
    assignment_issue:=case when sqlstate='23505' then 'already_registered'
     when sqlerrm in ('course_run_full','course_run_not_open','course_run_registration_not_started','course_run_registration_closed',
      'invalid_course_run','documents_incomplete','payment_not_verified','training_financial_clearance_required') then sqlerrm
     else 'admission_review_required' end;
    result:=result||jsonb_build_object('autoAssigned',false,'assignmentIssue',assignment_issue);
   end;
   update academy.training_journey_commands set auto_handoff_id=null,auto_run_id=null where tenant_id=t and command_id=command;
  end if;
  if coalesce((f->>'trainingAllowed')::boolean,false) and h.status='completed' then
   update work_core.tasks set status='completed',completed_at=now() where tenant_id=t and task_key='training-clearance-'||h.id::text and status in ('todo','in_progress');
  end if;

 elsif p_action='confirm_admission' then
  select * into h from academy.registration_handoffs where tenant_id=t and id=(p_payload->>'handoffId')::uuid;
  if h.id is null then raise exception 'admission_not_found'; end if;
  if h.status='completed' then
   select id into new_e from academy.enrollments where tenant_id=t and handoff_id=h.id;
   result:=jsonb_build_object('handoffId',h.id,'enrollmentId',new_e,'status','completed');
  else
   if p_payload->>'deliveryMode'='selfpaced' then
    perform pg_advisory_xact_lock(hashtextextended(t::text||':selfpaced:'||h.course_id::text,91217));
    select * into run from academy.course_runs where tenant_id=t and course_id=h.course_id and metadata->>'trainingJourneySelfpaced'='true' order by created_at,id limit 1;
    if run.id is null then
     insert into academy.course_runs(tenant_id,course_id,run_code,title,delivery_mode,status,metadata)
     values(t,h.course_id,'LMS-SELF-'||replace(h.course_id::text,'-',''),'تعلم ذاتي مستمر','online','open',
     jsonb_build_object('trainingJourneySelfpaced',true,'hiddenDeliveryRun',true)) returning * into run;
    end if;
   else select * into run from academy.course_runs where tenant_id=t and id=coalesce(nullif(p_payload->>'courseRunId','')::uuid,h.course_run_id) and course_id=h.course_id; end if;
   if run.id is null then raise exception 'course_run_required'; end if;
   result:=public.v2_tenant_update_admission(p_slug,h.id,'complete',h.course_id,run.id);
   select id into new_e from academy.enrollments where tenant_id=t and handoff_id=h.id;
   result:=result||jsonb_build_object('enrollmentId',new_e);
  end if;
  if new_e is not null and to_regprocedure('private_app.training_learning_pin_latest_v1(uuid,uuid)') is not null then
   execute 'select private_app.training_learning_pin_latest_v1($1,$2)' into new_h using t,new_e;
   result:=result||jsonb_build_object('learningReady',new_h is not null,'contentVersionId',new_h);
  end if;
  update work_core.tasks set status='completed',completed_at=now() where tenant_id=t and task_key='training-clearance-'||h.id::text and status in ('todo','in_progress');

 elsif p_action='create_request' then
  result:=private_app.training_journey_request_v1(t,(p_payload->>'enrollmentId')::uuid,p_payload->>'kind',p_payload->>'reason',
   nullif(p_payload->>'targetRunId','')::uuid,case when not learner then nullif(p_payload->>'assignedStaffId','')::uuid end,
   case when not learner then nullif(p_payload->>'dueAt','')::timestamptz end);

 elsif p_action='decide_request' then
  select * into req from academy.training_journey_requests where tenant_id=t and id=(p_payload->>'requestId')::uuid for update;
  if req.id is null or req.status<>'pending' then raise exception 'training_request_not_pending'; end if;
  if coalesce(p_payload->>'decision','') not in ('approve','reject') or length(btrim(coalesce(p_payload->>'reason','')))<3 then raise exception 'training_decision_invalid'; end if;
  select * into e from academy.enrollments where tenant_id=t and id=req.enrollment_id for update;
  if p_payload->>'decision'='approve' then
   if e.status not in ('confirmed','active') or exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued')
   then raise exception 'training_completed_enrollment_change_requires_review'; end if;
   if req.kind='access_exception' then
    if not private_app.has_accounting_permission(t,'tenant.accounting.payments.approve') then raise exception 'training_access_exception_forbidden'; end if;
    if nullif(p_payload->>'exceptionUntil','') is null or (p_payload->>'exceptionUntil')::timestamptz<=now() or (p_payload->>'exceptionUntil')::timestamptz>now()+interval '90 days' then raise exception 'training_exception_expiry_invalid'; end if;
    update academy.training_financial_links set exception_until=(p_payload->>'exceptionUntil')::timestamptz,
     exception_by_subject_id=actor,exception_reason=p_payload->>'reason',updated_at=now() where tenant_id=t and handoff_id=e.handoff_id;
    if not found then raise exception 'training_invoice_link_required'; end if;
   elsif req.kind='defer' then
    update academy.enrollments set metadata=metadata||jsonb_build_object('trainingJourneyDeferred',true,'deferredByRequestId',req.id) where id=e.id and tenant_id=t;
   elsif req.kind='resume' then
    f:=private_app.training_journey_handoff_finance_v1(e.handoff_id);
    if not coalesce((f->>'trainingAllowed')::boolean,false) then raise exception 'training_financial_clearance_required'; end if;
    update academy.enrollments set metadata=metadata||jsonb_build_object('trainingJourneyDeferred',false,'resumedByRequestId',req.id) where id=e.id and tenant_id=t;
   elsif req.kind='withdraw' then
    update academy.enrollments set status='withdrawn',metadata=metadata||jsonb_build_object('withdrawalRequestId',req.id) where id=e.id and tenant_id=t;
    update academy.course_runs set enrolled_count=(select count(*) from academy.enrollments where course_run_id=e.course_run_id and status in ('confirmed','active','completed')) where id=e.course_run_id and tenant_id=t;
    select id into staff from people.staff_profiles where tenant_id=t and employment_status='active' and role_key in ('accountant','finance_manager','tenant_owner','tenant_admin') order by (role_key in ('accountant','finance_manager')) desc,created_at,id limit 1;
    select * into h from academy.registration_handoffs where tenant_id=t and id=e.handoff_id;
    insert into work_core.tasks(tenant_id,task_key,title,description,status,priority,assigned_staff_id,created_by_subject_id,contact_id,due_at,metadata)
    values(t,'training-settlement-'||req.id::text,'تسوية تسجيل متدرب منسحب','مراجعة المستحقات والاسترداد عبر الحسابات قبل إغلاق التسوية','todo','high',
      coalesce(staff,req.assigned_staff_id),actor,h.contact_id,now()+interval '1 day',
      jsonb_build_object('source','training_journey','requestId',req.id,'enrollmentId',e.id,'handoffId',h.id,'actionType','withdrawal_settlement'))
    on conflict(tenant_id,task_key) do nothing;
   elsif req.kind='transfer' then
    -- Never rewrite historical attendance, assessments or certificates. A new canonical admission
    -- carries zero new cash and links the same invoice; the origin remains withdrawn with lineage.
    perform 1 from academy.course_runs where tenant_id=t and id in (e.course_run_id,req.target_run_id) order by id for update;
    select * into run from academy.course_runs where tenant_id=t and id=req.target_run_id and status='open';
    if run.id is null or run.id=e.course_run_id then raise exception 'training_target_run_invalid'; end if;
    select * into h from academy.registration_handoffs where tenant_id=t and id=e.handoff_id;
    select * into l from academy.training_financial_links where tenant_id=t and handoff_id=h.id;
    if l.handoff_id is null then raise exception 'training_invoice_link_required'; end if;
    if run.course_id<>e.course_id then raise exception 'training_cross_course_transfer_requires_new_invoice'; end if;
    new_h:=gen_random_uuid();
    insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,course_run_id,status,paid_at,payment_amount_minor,
     payment_status,payment_verified_at,payment_verified_by_subject_id,accepted_at,accepted_by_subject_id,completed_at,completed_by_subject_id,
     assigned_staff_id,created_by_subject_id,metadata)
    values(new_h,t,'training-transfer-'||req.id::text,h.contact_id,run.course_id,run.id,'completed',h.paid_at,0,h.payment_status,h.payment_verified_at,
     h.payment_verified_by_subject_id,now(),actor,now(),actor,req.assigned_staff_id,actor,
     jsonb_build_object('source','training_journey_transfer','originHandoffId',h.id,'originEnrollmentId',e.id,'requestId',req.id,'newFinancialAmountMinor',0));
    insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,sponsor,credit_limit_minor,credit_expires_on,
     credit_approved_by_subject_id,credit_approved_at,credit_reason,certificate_requires_settlement,created_by_subject_id)
    values(t,new_h,l.invoice_id,l.payer_account_id,l.policy,l.sponsor,l.credit_limit_minor,l.credit_expires_on,l.credit_approved_by_subject_id,
     l.credit_approved_at,l.credit_reason,l.certificate_requires_settlement,actor);
    update academy.enrollments set status='withdrawn',metadata=metadata||jsonb_build_object('transferRequestId',req.id,'transferredToHandoffId',new_h) where tenant_id=t and id=e.id;
    insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id,status,confirmed_by_subject_id,metadata)
    values(t,'handoff-'||new_h::text,new_h,e.student_id,run.course_id,run.id,'confirmed',actor,
     jsonb_build_object('source','training_journey_transfer','originEnrollmentId',e.id,'requestId',req.id)) returning id into new_e;
    if to_regprocedure('private_app.training_learning_transfer_v1(uuid,uuid)') is not null then
     execute 'select private_app.training_learning_transfer_v1($1,$2)' using e.id,new_e;
    end if;
    update academy.course_runs cr set enrolled_count=(select count(*) from academy.enrollments en where en.tenant_id=t and en.course_run_id=cr.id and en.status in ('confirmed','active','completed'))
     where cr.tenant_id=t and cr.id in (e.course_run_id,run.id);
   end if;
  end if;
  result:=jsonb_build_object('requestId',req.id,'status',case when p_payload->>'decision'='approve' then 'approved' else 'rejected' end,'newEnrollmentId',new_e,
   'financialSettlementRequired',req.kind='withdraw' and p_payload->>'decision'='approve','refundProcessed',false);
  update academy.training_journey_requests set status=operation.result->>'status',decided_by_subject_id=actor,decided_at=now(),decision_reason=p_payload->>'reason',result=operation.result where tenant_id=t and id=req.id;
  update work_core.tasks set status='completed',completed_at=now() where tenant_id=t and task_key='training-request-'||req.id::text and status in ('todo','in_progress');

 elsif p_action='reconcile' then
  -- Bounded dry-run first; explicit dryRun:false applies only the displayed page.
  for row_record in select h.id,h.contact_id,h.assigned_staff_id,h.course_run_id,h.completed_at,
   e.id enrollment_id,case when e.id is not null then private_app.training_journey_financial_access_v1(e.id) else private_app.training_journey_handoff_finance_v1(h.id) end financial
   from academy.registration_handoffs h left join academy.enrollments e on e.tenant_id=h.tenant_id and e.handoff_id=h.id
   where h.tenant_id=t and h.status not in ('rejected','cancelled') order by h.created_at,h.id
   limit 50 offset greatest(0,least(coalesce((p_payload->>'offset')::integer,0),100000))
  loop
   if (row_record.enrollment_id is null and coalesce((row_record.financial->>'trainingAllowed')::boolean,false))
     or (row_record.enrollment_id is not null and row_record.financial->>'financialStatus' in ('grace_period','overdue')) then
    affected:=affected+1;
    if not coalesce((p_payload->>'dryRun')::boolean,true) then
     staff:=row_record.assigned_staff_id;
     if staff is null then staff:=private_app.current_staff_id(t); end if;
     if staff is null then raise exception 'training_responsible_staff_required'; end if;
     insert into work_core.tasks(tenant_id,task_key,title,description,status,priority,assigned_staff_id,created_by_subject_id,contact_id,due_at,metadata)
     values(t,'training-clearance-'||row_record.id::text,case when row_record.enrollment_id is null then 'استكمال إسناد المتدرب' else 'متابعة قسط متأخر' end,
      'متابعة الحالة من منصة التدريب التفاعلي','todo','high',staff,actor,row_record.contact_id,now()+interval '1 day',
      jsonb_build_object('source','training_journey','handoffId',row_record.id,'enrollmentId',row_record.enrollment_id))
     on conflict(tenant_id,task_key) do update set status='todo',completed_at=null,metadata=excluded.metadata
      where work_core.tasks.status in ('completed','cancelled');
    end if;
   elsif not coalesce((p_payload->>'dryRun')::boolean,true) then
    update work_core.tasks set status='completed',completed_at=now() where tenant_id=t and task_key='training-clearance-'||row_record.id::text and status in ('todo','in_progress');
   end if;
  end loop;
  result:=jsonb_build_object('dryRun',coalesce((p_payload->>'dryRun')::boolean,true),'affectedCount',affected,'pageSize',50,'offset',coalesce((p_payload->>'offset')::integer,0));
 end if;
 perform private_app.training_journey_append_event_v1(t,p_action,coalesce(h.id,e.id,req.id),result);
 return private_app.training_journey_complete_command_v1(t,command,jsonb_build_object('success',true,'action',p_action)||result);
end $$;

create function public.v1_tenant_training_journey_snapshot(p_slug text,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t core.tenants%rowtype; enabled boolean:=false; manage boolean; finance boolean; verify boolean; learning boolean; admissions boolean; configure boolean; capabilities jsonb;
 off integer:=greatest(0,least(coalesce(p_offset,0),100000)); settings jsonb;
begin
 select * into t from core.tenants where slug=p_slug and slug='marktone' and id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and status in ('trial','active');
 if t.id is null or auth.uid() is null or private_app.current_subject_id() is null then raise exception 'forbidden' using errcode='42501'; end if;
 finance:=private_app.has_accounting_permission(t.id,'tenant.accounting.read');
 learning:=private_app.has_tenant_permission(t.id,'tenant.academy.write');
 admissions:=private_app.has_tenant_permission(t.id,'tenant.admissions.read') or private_app.has_tenant_permission(t.id,'tenant.admissions.write');
 configure:=learning and private_app.has_tenant_permission(t.id,'tenant.settings.manage');
 manage:=private_app.has_tenant_permission(t.id,'tenant.academy.write') and private_app.has_tenant_permission(t.id,'tenant.admissions.write');
 if not (learning or finance or admissions) then raise exception 'forbidden' using errcode='42501'; end if;
 if not private_app.tenant_addon_enabled(t.id,'lms') then raise exception 'training_addon_required'; end if;
 select s.enabled,jsonb_build_object('graceDays',s.grace_days,'policyVersion',s.policy_version,'timezone',t.timezone,'policySource',s.policy_source)
 into enabled,settings from academy.training_journey_settings s where s.tenant_id=t.id;
 settings:=coalesce(settings,jsonb_build_object('graceDays',7,'policyVersion',1,'timezone',t.timezone,'policySource','tenant_approved_operating_policy'));
 verify:=private_app.training_journey_payment_authorized_v1(t.id);
 capabilities:=jsonb_build_object('canManage',manage,'canManageLearning',learning,'canVerifyPayments',verify,
 'canApproveCredit',private_app.has_accounting_permission(t.id,'tenant.accounting.payments.approve'),
 'canReadAdmissions',admissions,'canReadAccounting',finance,'canManageCourses',learning,
 'canManageTasks',private_app.has_tenant_permission(t.id,'tenant.tasks.write'),'canConfigureAutomation',configure);
 if not coalesce(enabled,false) then return jsonb_build_object('enabled',false,'settings',settings,
 'capabilities',capabilities,
 'handoffs','[]'::jsonb,'enrollments','[]'::jsonb,'invoices','[]'::jsonb,'payments','[]'::jsonb,'runs','[]'::jsonb,'staff','[]'::jsonb,'requests','[]'::jsonb,'tasks','[]'::jsonb); end if;
 return jsonb_build_object('enabled',true,'settings',settings,'offset',off,'pageSize',50,
 'capabilities',capabilities,
 'handoffs',coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',h.id,'contactId',h.contact_id,'contactName',c.full_name,
  'courseId',h.course_id,'courseTitle',co.title_ar,'courseRunId',h.course_run_id,'status',h.status,'paymentStatus',h.payment_status,'enrollmentId',e.id,
  'financial',case when finance or verify then private_app.training_journey_handoff_finance_v1(h.id)
   else private_app.training_journey_handoff_finance_v1(h.id)-array['paidMinor','totalMinor','outstandingMinor','invoiceId','currency'] end) value
  from academy.registration_handoffs h join sales_core.contacts c on c.tenant_id=h.tenant_id and c.id=h.contact_id
  join academy.courses co on co.tenant_id=h.tenant_id and co.id=h.course_id left join academy.enrollments e on e.tenant_id=h.tenant_id and e.handoff_id=h.id
  where h.tenant_id=t.id and (admissions or (finance and exists(select 1 from academy.training_financial_links l where l.tenant_id=t.id and l.handoff_id=h.id))) order by h.created_at desc,h.id limit 50 offset off)x),'[]'),
 'enrollments',coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',e.id,'handoffId',e.handoff_id,'studentId',e.student_id,
  'studentName',s.full_name,'courseId',e.course_id,'courseTitle',c.title_ar,'courseRunId',e.course_run_id,'runTitle',r.title,'status',e.status,'deferred',coalesce(e.metadata->>'trainingJourneyDeferred','false')='true',
  'financial',case when finance or verify then private_app.training_journey_financial_access_v1(e.id)
   else private_app.training_journey_financial_access_v1(e.id)-array['paidMinor','totalMinor','outstandingMinor','invoiceId','currency'] end) value
  from academy.enrollments e join academy.students s on s.tenant_id=e.tenant_id and s.id=e.student_id
  join academy.courses c on c.tenant_id=e.tenant_id and c.id=e.course_id join academy.course_runs r on r.tenant_id=e.tenant_id and r.id=e.course_run_id
  where e.tenant_id=t.id and (learning or admissions or (finance and exists(select 1 from academy.training_financial_links l where l.tenant_id=t.id and l.handoff_id=e.handoff_id))) order by e.created_at desc,e.id limit 50 offset off)x),'[]'),
 'invoices',case when finance or verify then coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',d.id,'number',d.document_number,
  'customerAccountId',d.customer_account_id,'customerName',d.customer_name_snapshot,'totalMinor',d.total_minor,'currency',d.currency) value
  from accounting_core.sales_documents d where d.tenant_id=t.id and d.document_type='invoice' and d.status='issued'
  and (finance or exists(select 1 from academy.training_financial_links l where l.tenant_id=t.id and l.invoice_id=d.id)) order by d.created_at desc,d.id limit 50 offset off)x),'[]') else '[]'::jsonb end,
 'payments',case when finance or verify then coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',p.id,'number',p.payment_number,
  'customerAccountId',p.customer_account_id,'amountMinor',p.amount_minor,'status',p.status) value
  from accounting_core.payments p where p.tenant_id=t.id and p.status in ('pending_verification','verified')
  and (finance or exists(select 1 from academy.training_financial_links l where l.tenant_id=t.id and l.payer_account_id=p.customer_account_id)) order by p.created_at desc,p.id limit 50 offset off)x),'[]') else '[]'::jsonb end,
 'runs',coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',r.id,'courseId',r.course_id,'title',coalesce(r.title,r.run_code),
  'status',r.status,'capacity',r.capacity,'enrolledCount',r.enrolled_count,'selfpaced',r.metadata->>'trainingJourneySelfpaced'='true') value
  from academy.course_runs r where r.tenant_id=t.id and r.status in ('open','in_progress') order by r.created_at desc,r.id limit 50 offset off)x),'[]'),
 'staff',case when manage then coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',s.id,'name',s.full_name) value
  from people.staff_profiles s where s.tenant_id=t.id and s.employment_status='active' order by s.full_name,s.id limit 50)x),'[]') else '[]'::jsonb end,
 'requests',coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',r.id,'enrollmentId',r.enrollment_id,'kind',r.kind,
  'status',r.status,'reason',r.reason,'assignedStaffId',r.assigned_staff_id,'dueAt',r.due_at,'targetRunId',r.target_run_id) value
  from academy.training_journey_requests r where r.tenant_id=t.id and (manage or r.assigned_staff_id=private_app.current_staff_id(t.id)) order by r.created_at desc,r.id limit 50 offset off)x),'[]'),
 'tasks',coalesce((select jsonb_agg(x.value) from(select jsonb_build_object('id',task.id,'title',task.title,'status',task.status,
  'assignedStaffId',task.assigned_staff_id,'dueAt',task.due_at) value from work_core.tasks task where task.tenant_id=t.id and task.metadata->>'source'='training_journey'
  and (manage or task.assigned_staff_id=private_app.current_staff_id(t.id)) order by task.due_at,task.id limit 50 offset off)x),'[]'));
end $$;

-- Preserve the existing admission lifecycle and commerce locks. Scoped pilot changes:
-- a permission alternative for linked payment verification, and explicit approved
-- company credit acceptance without inventing a verified cash event.
CREATE OR REPLACE FUNCTION private_app.update_admission_before_commerce_v1(p_tenant_slug text, p_handoff_id uuid, p_action text, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_handoff academy.registration_handoffs%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_current_staff_id uuid;
  v_subject_id uuid;
  v_course_id uuid;
  v_course_run academy.course_runs%rowtype;
  v_stage_id uuid;
  v_activity_id uuid;
  v_task_id uuid;
  v_student_id uuid;
  v_enrollment_id uuid;
  v_student_number text;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not (private_app.has_tenant_permission(v_tenant_id, 'tenant.admissions.write')
    or (p_action = 'verify_payment'
      and private_app.training_journey_payment_authorized_v1(v_tenant_id)
      and exists(select 1 from academy.training_financial_links where tenant_id=v_tenant_id and handoff_id=p_handoff_id))
    or (p_action='complete' and p_course_id is null and p_course_run_id is null
      and private_app.training_journey_auto_admission_authorized_v1(v_tenant_id,p_handoff_id)))
  then raise exception 'forbidden'; end if;
  if p_action not in (
    'start_review',
    'save_details',
    'verify_payment',
    'reject_payment',
    'accept',
    'complete',
    'cancel'
  ) then raise exception 'invalid_admission_action'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_subject_id := private_app.current_subject_id();

  select *
  into v_handoff
  from academy.registration_handoffs handoff
  where handoff.id = p_handoff_id
    and handoff.tenant_id = v_tenant_id
  for update;

  if v_handoff.id is null then raise exception 'admission_not_found'; end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = v_handoff.contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then raise exception 'invalid_contact'; end if;

  v_course_id := coalesce(p_course_id, v_handoff.course_id);
  if not exists (
    select 1
    from academy.courses course
    where course.id = v_course_id
      and course.tenant_id = v_tenant_id
      and course.status <> 'archived'
  ) then raise exception 'invalid_course'; end if;

  if p_course_run_id is not null then
    select *
    into v_course_run
    from academy.course_runs run
    where run.id = p_course_run_id
      and run.tenant_id = v_tenant_id
      and run.course_id = v_course_id
      and run.status in ('planning', 'open', 'in_progress');
    if v_course_run.id is null then raise exception 'invalid_course_run'; end if;
  elsif v_handoff.course_run_id is not null
        and v_handoff.course_id = v_course_id then
    select *
    into v_course_run
    from academy.course_runs run
    where run.id = v_handoff.course_run_id
      and run.tenant_id = v_tenant_id;
  end if;

  if v_handoff.status in ('completed', 'cancelled')
     and p_action <> 'save_details'
     and not (v_handoff.status='completed' and p_action='verify_payment' and private_app.training_journey_credit_authorized_v1(v_handoff.id)) then
    raise exception 'admission_closed';
  end if;

  update academy.registration_handoffs
  set course_id = v_course_id,
      course_run_id = case
        when p_course_run_id is not null then p_course_run_id
        when course_id = v_course_id then course_run_id
        else null
      end,
      assigned_staff_id = coalesce(
        assigned_staff_id,
        v_current_staff_id
      ),
      notes = coalesce(
        nullif(trim(coalesce(p_notes, '')), ''),
        notes
      )
  where id = v_handoff.id
  returning * into v_handoff;

  if p_action = 'start_review' then
    if v_handoff.status not in ('pending', 'in_review') then
      raise exception 'invalid_admission_transition';
    end if;

    update academy.registration_handoffs
    set status = 'in_review'
    where id = v_handoff.id
    returning * into v_handoff;

  elsif p_action = 'save_details' then
    if v_handoff.status in ('completed', 'cancelled') then
      raise exception 'admission_closed';
    end if;

  elsif p_action = 'verify_payment' then
    if v_handoff.payment_status = 'refunded' then
      raise exception 'invalid_payment_transition';
    end if;

    update academy.registration_handoffs
    set status = case when status='completed' and private_app.training_journey_credit_authorized_v1(id) then 'completed' else 'in_review' end,
        payment_status = 'verified',
        payment_verified_at = now(),
        payment_verified_by_subject_id = v_subject_id,
        payment_rejection_reason = null
    where id = v_handoff.id
    returning * into v_handoff;

    update academy.registration_documents
    set status = 'approved',
        reviewed_at = now(),
        reviewed_by_subject_id = v_subject_id,
        notes = coalesce(notes, 'تم التحقق بواسطة التسجيل والقبول')
    where handoff_id = v_handoff.id
      and document_type = 'payment_receipt';

    select stage.id
    into v_stage_id
    from sales_core.pipeline_stages stage
    where stage.tenant_id = v_tenant_id
      and stage.stage_key = 'won'
    limit 1;

    if v_stage_id is null then raise exception 'invalid_stage'; end if;

    update sales_core.opportunities
    set course_id = v_handoff.course_id,
        stage_id = v_stage_id,
        value_minor = coalesce(
          v_handoff.payment_amount_minor,
          value_minor
        ),
        next_action_type = null,
        next_action_at = null,
        status = 'won',
        lost_reason = null
    where id = v_handoff.opportunity_id;

    insert into sales_core.activities (
      tenant_id,
      opportunity_id,
      contact_id,
      actor_staff_id,
      activity_type,
      outcome,
      summary,
      result_status,
      result_quality,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      v_handoff.opportunity_id,
      v_contact.id,
      v_current_staff_id,
      'note',
      'paid',
      'تم التحقق من الدفع بواسطة التسجيل والقبول',
      'paid',
      v_contact.lead_quality,
      v_subject_id,
      jsonb_build_object(
        'source',
        'admissions_payment_verification',
        'handoffId',
        v_handoff.id
      )
    )
    returning id into v_activity_id;

    if v_contact.lead_status is distinct from 'paid' then
      insert into sales_core.lead_status_history (
        tenant_id,
        contact_id,
        activity_id,
        from_status,
        to_status,
        reason,
        changed_by_subject_id,
        metadata
      )
      values (
        v_tenant_id,
        v_contact.id,
        v_activity_id,
        v_contact.lead_status,
        'paid',
        'تم تأكيد الدفع بواسطة التسجيل والقبول',
        v_subject_id,
        jsonb_build_object('handoffId', v_handoff.id)
      );
    end if;

    update sales_core.contacts
    set status = 'converted',
        lead_status = 'paid',
        lead_status_changed_at = case
          when lead_status is distinct from 'paid' then now()
          else lead_status_changed_at
        end,
        next_action_type = null,
        next_action_at = null,
        last_activity_at = now(),
        closure_reason = null,
        closed_at = null
    where id = v_contact.id;

    update work_core.tasks
    set title = 'استكمال القبول: ' || v_contact.full_name,
        description = 'تم تأكيد الدفع · استكمل المستندات والدفعة',
        priority = 'high',
        metadata = metadata || jsonb_build_object(
          'paymentStatus',
          'verified'
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text
      and status in ('todo', 'in_progress');

  elsif p_action = 'reject_payment' then
    if p_reason is null or length(trim(p_reason)) < 3 then
      raise exception 'reason_required';
    end if;

    update academy.registration_handoffs
    set status = 'rejected',
        payment_status = 'rejected',
        payment_verified_at = null,
        payment_verified_by_subject_id = null,
        payment_rejection_reason = trim(p_reason)
    where id = v_handoff.id
    returning * into v_handoff;

    update academy.registration_documents
    set status = 'rejected',
        reviewed_at = now(),
        reviewed_by_subject_id = v_subject_id,
        notes = trim(p_reason)
    where handoff_id = v_handoff.id
      and document_type = 'payment_receipt';

    select stage.id
    into v_stage_id
    from sales_core.pipeline_stages stage
    where stage.tenant_id = v_tenant_id
      and stage.stage_key = 'proposal'
    limit 1;

    if v_stage_id is null then raise exception 'invalid_stage'; end if;

    update sales_core.opportunities
    set stage_id = v_stage_id,
        next_action_type = 'payment_followup',
        next_action_at = now() + interval '1 day',
        status = 'open',
        lost_reason = null
    where id = v_handoff.opportunity_id;

    insert into sales_core.activities (
      tenant_id,
      opportunity_id,
      contact_id,
      actor_staff_id,
      activity_type,
      outcome,
      summary,
      next_action_type,
      next_action_at,
      result_status,
      result_quality,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      v_handoff.opportunity_id,
      v_contact.id,
      v_current_staff_id,
      'note',
      'awaiting_payment',
      'تعذر تأكيد الدفع: ' || trim(p_reason),
      'payment_followup',
      now() + interval '1 day',
      'awaiting_payment',
      v_contact.lead_quality,
      v_subject_id,
      jsonb_build_object(
        'source',
        'admissions_payment_rejection',
        'handoffId',
        v_handoff.id
      )
    )
    returning id into v_activity_id;

    insert into sales_core.lead_status_history (
      tenant_id,
      contact_id,
      activity_id,
      from_status,
      to_status,
      reason,
      changed_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      v_contact.id,
      v_activity_id,
      v_contact.lead_status,
      'awaiting_payment',
      trim(p_reason),
      v_subject_id,
      jsonb_build_object(
        'handoffId',
        v_handoff.id,
        'returnedToSales',
        true
      )
    );

    update sales_core.contacts
    set status = 'active',
        lead_status = 'awaiting_payment',
        lead_status_changed_at = now(),
        next_action_type = 'payment_followup',
        next_action_at = now() + interval '1 day',
        last_activity_at = now(),
        closure_reason = null,
        closed_at = null
    where id = v_contact.id;

    update work_core.tasks
    set status = 'cancelled',
        metadata = metadata || jsonb_build_object(
          'cancelReason',
          'payment_rejected'
        )
    where tenant_id = v_tenant_id
      and contact_id = v_contact.id
      and status in ('todo', 'in_progress')
      and coalesce(metadata ->> 'source', '') in (
        'opportunity_next_action',
        'activity_next_action',
        'lead_next_action',
        'sales_followup'
      );

    insert into work_core.tasks (
      tenant_id,
      title,
      description,
      priority,
      assigned_staff_id,
      created_by_subject_id,
      contact_id,
      opportunity_id,
      activity_id,
      due_at,
      metadata
    )
    values (
      v_tenant_id,
      'متابعة دفع: ' || v_contact.full_name,
      'أعاد التسجيل الحالة للمبيعات: ' || trim(p_reason),
      'urgent',
      v_contact.owner_staff_id,
      v_subject_id,
      v_contact.id,
      v_handoff.opportunity_id,
      v_activity_id,
      now() + interval '1 day',
      jsonb_build_object(
        'source',
        'sales_followup',
        'actionType',
        'payment_followup',
        'leadStatus',
        'awaiting_payment',
        'returnedByAdmissions',
        true
      )
    )
    returning id into v_task_id;

    update work_core.tasks
    set status = 'cancelled',
        metadata = metadata || jsonb_build_object(
          'cancelReason',
          'payment_rejected'
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text;

  elsif p_action = 'accept' then
    if v_handoff.payment_status <> 'verified' and not private_app.training_journey_credit_authorized_v1(v_handoff.id) then
      raise exception 'payment_not_verified';
    end if;

    update academy.registration_handoffs
    set status = 'accepted',
        accepted_at = coalesce(accepted_at, now()),
        accepted_by_subject_id = coalesce(
          accepted_by_subject_id,
          v_subject_id
        )
    where id = v_handoff.id
    returning * into v_handoff;

  elsif p_action = 'complete' then
    if v_handoff.payment_status <> 'verified' and not private_app.training_journey_credit_authorized_v1(v_handoff.id) then
      raise exception 'payment_not_verified';
    end if;
    if v_handoff.course_run_id is null then
      raise exception 'course_run_required';
    end if;
    if exists (
      select 1
      from academy.registration_documents document
      where document.handoff_id = v_handoff.id
        and document.is_required
        and document.status not in ('approved', 'not_required')
    ) then raise exception 'documents_incomplete'; end if;

    select *
    into v_course_run
    from academy.course_runs run
    where run.id = v_handoff.course_run_id
      and run.tenant_id = v_tenant_id
      and run.course_id = v_handoff.course_id
      and run.status in ('planning', 'open', 'in_progress')
    for update;

    if v_course_run.id is null then raise exception 'invalid_course_run'; end if;
    if v_course_run.capacity is not null
       and v_course_run.enrolled_count >= v_course_run.capacity then
      raise exception 'course_run_full';
    end if;

    v_student_number := 'STU-'
      || to_char(now(), 'YYYY')
      || '-'
      || upper(substr(replace(v_contact.id::text, '-', ''), 1, 8));

    insert into academy.students (
      tenant_id,
      student_key,
      student_number,
      contact_id,
      full_name,
      phone,
      email,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      'contact-' || v_contact.id::text,
      v_student_number,
      v_contact.id,
      v_contact.full_name,
      coalesce(v_contact.phone, v_contact.whatsapp),
      v_contact.email,
      v_subject_id,
      jsonb_build_object(
        'source',
        'registration_admission',
        'handoffId',
        v_handoff.id
      )
    )
    on conflict (tenant_id, contact_id) do update
    set full_name = excluded.full_name,
        phone = coalesce(excluded.phone, academy.students.phone),
        email = coalesce(excluded.email, academy.students.email),
        status = 'active'
    returning id into v_student_id;

    insert into academy.enrollments (
      tenant_id,
      enrollment_key,
      handoff_id,
      student_id,
      course_id,
      course_run_id,
      status,
      confirmed_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      'handoff-' || v_handoff.id::text,
      v_handoff.id,
      v_student_id,
      v_handoff.course_id,
      v_handoff.course_run_id,
      'confirmed',
      v_subject_id,
      jsonb_build_object('source', 'admissions')
    )
    on conflict (handoff_id) do update
    set student_id = excluded.student_id,
        course_id = excluded.course_id,
        course_run_id = excluded.course_run_id,
        status = 'confirmed',
        confirmed_by_subject_id = excluded.confirmed_by_subject_id
    returning id into v_enrollment_id;

    update academy.course_runs run
    set enrolled_count = (
      select count(*)
      from academy.enrollments enrollment
      where enrollment.course_run_id = run.id
        and enrollment.status in ('confirmed', 'active', 'completed')
    )
    where run.id = v_handoff.course_run_id;

    update academy.registration_handoffs
    set status = 'completed',
        accepted_at = coalesce(accepted_at, now()),
        accepted_by_subject_id = coalesce(
          accepted_by_subject_id,
          v_subject_id
        ),
        completed_at = now(),
        completed_by_subject_id = v_subject_id
    where id = v_handoff.id
    returning * into v_handoff;

    update work_core.tasks
    set status = 'completed',
        completed_at = now(),
        completion_timing = case
          when now() <= due_at then 'on_time'
          else 'late'
        end,
        metadata = metadata || jsonb_build_object(
          'enrollmentId',
          v_enrollment_id
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text
      and status in ('todo', 'in_progress');

  elsif p_action = 'cancel' then
    if p_reason is null or length(trim(p_reason)) < 3 then
      raise exception 'reason_required';
    end if;

    update academy.registration_handoffs
    set status = 'cancelled',
        notes = concat_ws(
          E'\n',
          notes,
          'سبب الإلغاء: ' || trim(p_reason)
        )
    where id = v_handoff.id
    returning * into v_handoff;

    update work_core.tasks
    set status = 'cancelled',
        metadata = metadata || jsonb_build_object(
          'cancelReason',
          trim(p_reason)
        )
    where tenant_id = v_tenant_id
      and task_key = 'registration-' || v_handoff.id::text;
  end if;

  perform private_app.write_audit(
    'tenant.admission_updated',
    'registration_handoff',
    v_handoff.id::text,
    v_tenant_id,
    jsonb_build_object(
      'action',
      p_action,
      'status',
      v_handoff.status,
      'paymentStatus',
      v_handoff.payment_status,
      'studentId',
      v_student_id,
      'enrollmentId',
      v_enrollment_id
    )
  );

  return jsonb_build_object(
    'id',
    v_handoff.id,
    'action',
    p_action,
    'status',
    v_handoff.status,
    'paymentStatus',
    v_handoff.payment_status,
    'taskId',
    v_task_id,
    'studentId',
    v_student_id,
    'enrollmentId',
    v_enrollment_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.v2_tenant_update_admission(p_tenant_slug text, p_handoff_id uuid, p_action text, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t uuid; contact uuid;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if private_app.current_subject_id() is null or t is null or not (private_app.has_tenant_permission(t,'tenant.admissions.write') or (p_action='verify_payment' and private_app.training_journey_payment_authorized_v1(t) and exists(select 1 from academy.training_financial_links where tenant_id=t and handoff_id=p_handoff_id)) or (p_action='complete' and p_course_id is null and p_course_run_id is null and private_app.training_journey_auto_admission_authorized_v1(t,p_handoff_id)))
  then raise exception 'forbidden';end if;
 select contact_id into contact from academy.registration_handoffs where tenant_id=t and id=p_handoff_id;
 if contact is null then raise exception 'admission_not_found';end if;
 perform 1 from commerce_sync.connections where tenant_id=t and id in (
  select w.connection_id from sales_core.commerce_admission_lines l join sales_core.commerce_order_work_items w
   on w.tenant_id=t and w.id=l.work_item_id where l.tenant_id=t and l.handoff_id=p_handoff_id) order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||contact::text,31603));
 perform 1 from sales_core.contacts where tenant_id=t and id=contact for update;
 return private_app.update_admission_before_commerce_v1(p_tenant_slug,p_handoff_id,p_action,p_course_id,p_course_run_id,p_notes,p_reason);
end $function$;

create function private_app.training_journey_validate_links_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.tenant_id<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid then raise exception 'training_pilot_tenant_invalid'; end if;
 if tg_table_name='training_financial_links' then
  if not exists(select 1 from accounting_core.sales_documents d where d.tenant_id=new.tenant_id and d.id=new.invoice_id
   and d.customer_account_id=new.payer_account_id and d.document_type='invoice')
  then raise exception 'training_invoice_payer_mismatch'; end if;
 elsif tg_table_name='training_journey_requests' then
  if not exists(select 1 from academy.enrollments where tenant_id=new.tenant_id and id=new.enrollment_id)
   or not exists(select 1 from people.staff_profiles where tenant_id=new.tenant_id and id=new.assigned_staff_id)
   or (new.target_run_id is not null and not exists(select 1 from academy.course_runs where tenant_id=new.tenant_id and id=new.target_run_id))
  then raise exception 'training_tenant_link_mismatch'; end if;
 end if;
 return new;
end $$;
create trigger training_financial_links_validate before insert or update on academy.training_financial_links
 for each row execute function private_app.training_journey_validate_links_v1();
create trigger training_journey_requests_validate before insert or update on academy.training_journey_requests
 for each row execute function private_app.training_journey_validate_links_v1();
create trigger training_journey_events_append_only before update or delete on academy.training_journey_events
 for each row execute function private_app.accounting_append_only();

create function private_app.training_journey_prevent_duplicate_cash_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare source_handoff uuid;
begin
 if new.source_type='registration_handoff' then
  begin source_handoff:=new.source_id::uuid; exception when invalid_text_representation then return new; end;
  if exists(select 1 from academy.training_financial_links l where l.tenant_id=new.tenant_id and l.handoff_id=source_handoff)
   then raise exception 'payment_source_already_imported'; end if;
 end if;
 return new;
end $$;
create trigger training_journey_no_duplicate_handoff_cash before insert on accounting_core.payments
 for each row execute function private_app.training_journey_prevent_duplicate_cash_v1();

create function public.v1_training_journey_navigation(p_slug text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',exists(select 1 from core.tenants t
  join academy.training_journey_settings cfg on cfg.tenant_id=t.id and cfg.enabled
  where t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.slug='marktone' and t.slug=p_slug
  and t.status in ('trial','active') and auth.uid() is not null
  and private_app.has_tenant_permission(t.id,'tenant.academy.read') and private_app.tenant_addon_enabled(t.id,'lms')))
$$;

do $$
declare f record;
begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private_app' and p.proname like 'training_journey_%'
 loop execute format('revoke all on function %s from public, anon, authenticated',f.signature); end loop;
end $$;
revoke all on function public.v1_tenant_training_journey_action(text,text,jsonb) from public,anon;
revoke all on function public.v1_tenant_training_journey_snapshot(text,integer) from public,anon;
grant execute on function public.v1_tenant_training_journey_action(text,text,jsonb) to authenticated;
grant execute on function public.v1_tenant_training_journey_snapshot(text,integer) to authenticated;
revoke all on function public.v1_training_journey_navigation(text) from public,anon;
grant execute on function public.v1_training_journey_navigation(text) to authenticated;
commit;
