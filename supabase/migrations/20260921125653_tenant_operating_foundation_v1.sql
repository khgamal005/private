begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local lock_timeout='10s';
set local statement_timeout='120s';

-- Free operating setup uses the existing accounting profile, tenant timezone,
-- staff and permissions. No subscription, integration, payment or live backfill.
create table core.branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  branch_key text not null check(branch_key ~ '^[a-z0-9_]{1,60}$'),
  name text not null check(length(btrim(name)) between 2 and 160),
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(tenant_id,id), unique(tenant_id,branch_key),
  check(not is_default or active)
);
create unique index tenant_one_default_branch on core.branches(tenant_id) where is_default;
create table core.tenant_operating_setup (
  tenant_id uuid primary key references core.tenants(id) on delete cascade,
  intake_source text check(intake_source in('manual','excel','internal_form','integration')),
  staff_scheduling_enabled boolean not null default false,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references access_control.subjects(id)
);
create table core.operating_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  actor_subject_id uuid references access_control.subjects(id),
  action text not null,
  record_id uuid,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index operating_audit_tenant_time on core.operating_audit(tenant_id,created_at desc);

-- These keys make all new relations prove tenant ownership at the FK boundary.
create unique index if not exists staff_profiles_tenant_id_id_governance on people.staff_profiles(tenant_id,id);
create unique index if not exists departments_tenant_id_id_governance on people.departments(tenant_id,id);
create table people.staff_department_memberships (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  staff_id uuid not null,
  department_id uuid not null,
  primary key(tenant_id,staff_id,department_id),
  foreign key(tenant_id,staff_id) references people.staff_profiles(tenant_id,id) on delete cascade,
  foreign key(tenant_id,department_id) references people.departments(tenant_id,id) on delete cascade
);
create index staff_extra_department on people.staff_department_memberships(tenant_id,department_id,staff_id);
create table people.staff_work_shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  staff_id uuid not null,
  iso_day integer not null check(iso_day between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  foreign key(tenant_id,staff_id) references people.staff_profiles(tenant_id,id) on delete cascade,
  check(starts_at<>ends_at),
  unique(tenant_id,staff_id,iso_day,starts_at,ends_at)
);
create index staff_shifts_lookup on people.staff_work_shifts(tenant_id,staff_id,iso_day);
create table people.staff_absences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  staff_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null check(length(btrim(reason)) between 3 and 500),
  cover_staff_id uuid,
  cancelled_at timestamptz,
  created_by uuid references access_control.subjects(id),
  created_at timestamptz not null default now(),
  foreign key(tenant_id,staff_id) references people.staff_profiles(tenant_id,id) on delete cascade,
  foreign key(tenant_id,cover_staff_id) references people.staff_profiles(tenant_id,id),
  check(ends_at>starts_at), check(cover_staff_id is distinct from staff_id)
);
create index staff_absences_lookup on people.staff_absences(tenant_id,staff_id,starts_at,ends_at) where cancelled_at is null;

do $secure_tables$
declare x text;
begin
  foreach x in array array['core.branches','core.tenant_operating_setup','core.operating_audit',
    'people.staff_department_memberships','people.staff_work_shifts','people.staff_absences'] loop
    execute 'alter table '||x||' enable row level security';
    execute 'revoke all on table '||x||' from public,anon,authenticated';
  end loop;
end $secure_tables$;

-- New tenants get their first branch automatically. Existing tenants use
-- explicit save_setup; installing the migration does not touch their rows.
create function private_app.create_first_tenant_branch_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into core.branches(tenant_id,branch_key,name,is_default)
  values(new.id,'main','الفرع الرئيسي',true);
  return new;
end $$;
revoke all on function private_app.create_first_tenant_branch_v1() from public,anon,authenticated;
create trigger tenant_first_operating_branch after insert on core.tenants
for each row execute function private_app.create_first_tenant_branch_v1();

alter table people.staff_profiles add column branch_id uuid;
alter table academy.course_runs add column branch_id uuid;
alter table academy.registration_handoffs add column branch_id uuid;
alter table people.staff_profiles add foreign key(tenant_id,branch_id) references core.branches(tenant_id,id);
alter table academy.course_runs add foreign key(tenant_id,branch_id) references core.branches(tenant_id,id);
alter table academy.registration_handoffs add foreign key(tenant_id,branch_id) references core.branches(tenant_id,id);
create index staff_branch_lookup on people.staff_profiles(tenant_id,branch_id);
create index runs_branch_lookup on academy.course_runs(tenant_id,branch_id);
create index handoffs_branch_lookup on academy.registration_handoffs(tenant_id,branch_id);
-- Branch is the point of operation, not a second customer/program identity.
-- Shared contacts and course catalog stay tenant-wide. Historical rows stay null.
do $branch_links$
declare relation text;
begin
  foreach relation in array array['academy.enrollments','work_core.tasks','accounting_core.sales_documents','accounting_core.payments'] loop
    execute 'alter table '||relation||' add column branch_id uuid';
    execute 'alter table '||relation||' add foreign key(tenant_id,branch_id) references core.branches(tenant_id,id)';
    execute format('create index %I on %s(tenant_id,branch_id)',replace(relation,'.','_')||'_branch_idx',relation);
  end loop;
end $branch_links$;
create function private_app.default_operating_branch_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare related_branch uuid;
begin
  if new.branch_id is null then
    select b.id into new.branch_id from core.branches b
    where b.tenant_id=new.tenant_id and b.is_default and b.active;
  end if;
  if tg_table_schema='academy' and tg_table_name='registration_handoffs' then
    if new.course_run_id is not null then
      select r.branch_id into related_branch from academy.course_runs r
      where r.tenant_id=new.tenant_id and r.id=new.course_run_id;
      new.branch_id:=coalesce(related_branch,new.branch_id);
    end if;
  end if;
  if tg_table_schema='academy' and tg_table_name='enrollments' then
    select r.branch_id into related_branch from academy.course_runs r where r.tenant_id=new.tenant_id and r.id=new.course_run_id;
    new.branch_id:=coalesce(related_branch,new.branch_id);
  end if;
  if tg_table_schema='work_core' and tg_table_name='tasks' then
    select h.branch_id into related_branch from academy.registration_handoffs h
    where h.tenant_id=new.tenant_id and h.opportunity_id=new.opportunity_id order by h.created_at desc limit 1;
    if related_branch is null then
      select s.branch_id into related_branch from people.staff_profiles s where s.tenant_id=new.tenant_id and s.id=new.assigned_staff_id;
    end if;
    new.branch_id:=coalesce(related_branch,new.branch_id);
  end if;
  if tg_table_schema='accounting_core' then
    if new.source_type='registration_handoff' then
      select h.branch_id into related_branch from academy.registration_handoffs h where h.tenant_id=new.tenant_id and h.id::text=new.source_id;
      new.branch_id:=coalesce(related_branch,new.branch_id);
    end if;
  end if;
  return new;
end $$;
revoke all on function private_app.default_operating_branch_v1() from public,anon,authenticated;
create trigger staff_default_operating_branch before insert on people.staff_profiles for each row execute function private_app.default_operating_branch_v1();
create trigger run_default_operating_branch before insert on academy.course_runs for each row execute function private_app.default_operating_branch_v1();
create trigger handoff_default_operating_branch before insert or update of course_run_id on academy.registration_handoffs for each row execute function private_app.default_operating_branch_v1();
create trigger enrollment_default_operating_branch before insert or update of course_run_id on academy.enrollments for each row execute function private_app.default_operating_branch_v1();
create trigger task_default_operating_branch before insert on work_core.tasks for each row execute function private_app.default_operating_branch_v1();
create trigger document_default_operating_branch before insert on accounting_core.sales_documents for each row execute function private_app.default_operating_branch_v1();
create trigger payment_default_operating_branch before insert on accounting_core.payments for each row execute function private_app.default_operating_branch_v1();
create function private_app.guard_financial_branch_history_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.branch_id is distinct from old.branch_id and old.status in('issued','verified','refunded') then
    raise exception 'financial_branch_history_immutable';
  end if;
  return new;
end $$;
revoke all on function private_app.guard_financial_branch_history_v1() from public,anon,authenticated;
create trigger document_financial_branch_history before update of branch_id on accounting_core.sales_documents for each row execute function private_app.guard_financial_branch_history_v1();
create trigger payment_financial_branch_history before update of branch_id on accounting_core.payments for each row execute function private_app.guard_financial_branch_history_v1();

create function private_app.staff_operationally_available_v1(p_tenant_id uuid,p_staff_id uuid,p_as_of timestamptz default now())
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_local timestamp; v_day integer;
begin
  if not exists(select 1 from people.staff_profiles s where s.tenant_id=p_tenant_id and s.id=p_staff_id and s.employment_status='active') then return false; end if;
  if not exists(select 1 from core.tenant_operating_setup where tenant_id=p_tenant_id and staff_scheduling_enabled) then return true; end if;
  if not exists(select 1 from people.staff_profiles s join access_control.memberships m on m.id=s.membership_id and m.tenant_id=s.tenant_id
    join access_control.subjects u on u.id=m.subject_id
    where s.tenant_id=p_tenant_id and s.id=p_staff_id and s.account_status='active' and m.status='active' and u.status='active') then return false; end if;
  if exists(select 1 from people.staff_absences a where a.tenant_id=p_tenant_id and a.staff_id=p_staff_id and a.cancelled_at is null and p_as_of>=a.starts_at and p_as_of<a.ends_at) then return false; end if;
  select p_as_of at time zone t.timezone into v_local from core.tenants t where t.id=p_tenant_id;
  v_day:=extract(isodow from v_local);
  -- No shift means unconfigured, hence not eligible once scheduling is enabled.
  return exists(select 1 from people.staff_work_shifts s where s.tenant_id=p_tenant_id and s.staff_id=p_staff_id and (
    (s.starts_at<s.ends_at and s.iso_day=v_day and v_local::time>=s.starts_at and v_local::time<s.ends_at)
    or(s.starts_at>s.ends_at and ((s.iso_day=v_day and v_local::time>=s.starts_at)
      or(s.iso_day=case when v_day=1 then 7 else v_day-1 end and v_local::time<s.ends_at)))
  ));
end $$;
revoke all on function private_app.staff_operationally_available_v1(uuid,uuid,timestamptz) from public,anon,authenticated;

create function private_app.guard_new_operating_assignment_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.owner_staff_id is null then return new; end if;
  if tg_op='UPDATE' then
    if new.owner_staff_id is not distinct from old.owner_staff_id then return new; end if;
  end if;
  if exists(select 1 from core.tenant_operating_setup where tenant_id=new.tenant_id and staff_scheduling_enabled)
    and not private_app.staff_operationally_available_v1(new.tenant_id,new.owner_staff_id) then
    raise exception 'operating_assignee_unavailable';
  end if;
  return new;
end $$;
revoke all on function private_app.guard_new_operating_assignment_v1() from public,anon,authenticated;
create trigger operating_new_contact_owner before insert or update of owner_staff_id on sales_core.contacts
for each row execute function private_app.guard_new_operating_assignment_v1();

create function public.v1_tenant_operating_snapshot(p_tenant_slug text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t core.tenants%rowtype; s core.tenant_operating_setup%rowtype; f accounting_core.tenant_profiles%rowtype; checks jsonb; members integer;
begin
  select * into t from core.tenants where slug=p_tenant_slug;
  if t.id is null then raise exception 'tenant_not_found'; end if;
  if private_app.current_subject_id() is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden' using errcode='42501'; end if;
  select * into s from core.tenant_operating_setup where tenant_id=t.id;
  select * into f from accounting_core.tenant_profiles where tenant_id=t.id;
  select count(*) into members from access_control.memberships m where m.tenant_id=t.id and m.status='active' and exists(select 1 from access_control.membership_roles r where r.membership_id=m.id);
  checks:=jsonb_build_object(
    'basicData',length(btrim(t.name))>=2 and length(btrim(coalesce(t.legal_name,'')))>=2,
    'firstBranch',exists(select 1 from core.branches where tenant_id=t.id and is_default and active),
    'currency',f.tenant_id is not null and f.base_currency ~ '^[A-Z]{3}$',
    'timezone',exists(select 1 from pg_catalog.pg_timezone_names where name=t.timezone) and (f.tenant_id is null or f.timezone=t.timezone),
    'taxConfiguration',f.tenant_id is not null,
    'teamAndPermissions',members>0,
    'intakeSource',s.intake_source is not null);
  return jsonb_build_object('checks',checks,'ready',not exists(select 1 from jsonb_each(checks) c where c.value<>'true'::jsonb),
    'tenant',jsonb_build_object('name',t.name,'legalName',t.legal_name,'timezone',t.timezone),
    'finance',jsonb_build_object('configured',f.tenant_id is not null,'currency',f.base_currency,'taxRegistered',f.tax_registered,'timezone',f.timezone),
    'setup',jsonb_build_object('intakeSource',s.intake_source,'version',coalesce(s.version,0),'staffSchedulingEnabled',coalesce(s.staff_scheduling_enabled,false)),
    'canManagePeople',private_app.has_tenant_permission(t.id,'tenant.people.manage'),
    'branches',coalesce((select jsonb_agg(to_jsonb(b) order by b.is_default desc,b.name) from core.branches b where b.tenant_id=t.id),'[]'::jsonb),
    'departments',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name_ar) order by d.name_ar) from people.departments d where d.tenant_id=t.id and d.status='active'),'[]'::jsonb),
    'staff',case when private_app.has_tenant_permission(t.id,'tenant.people.manage') then coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.full_name,'departmentId',p.department_id,'branchId',p.branch_id,'status',p.employment_status,
      'availableNow',private_app.staff_operationally_available_v1(t.id,p.id),
      'extraDepartments',coalesce((select jsonb_agg(m.department_id) from people.staff_department_memberships m where m.tenant_id=t.id and m.staff_id=p.id),'[]'::jsonb),
      'shifts',coalesce((select jsonb_agg(jsonb_build_object('isoDay',w.iso_day,'startsAt',w.starts_at,'endsAt',w.ends_at) order by w.iso_day,w.starts_at) from people.staff_work_shifts w where w.tenant_id=t.id and w.staff_id=p.id),'[]'::jsonb),
      'absences',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'startsAt',a.starts_at,'endsAt',a.ends_at,'reason',a.reason,'coverStaffId',a.cover_staff_id) order by a.starts_at) from people.staff_absences a where a.tenant_id=t.id and a.staff_id=p.id and a.cancelled_at is null and a.ends_at>now()),'[]'::jsonb)
    ) order by p.full_name) from people.staff_profiles p where p.tenant_id=t.id),'[]'::jsonb) else '[]'::jsonb end,
    'planningQueue',case when private_app.has_tenant_permission(t.id,'tenant.crm.read') and private_app.can_view_tenant_team(t.id) then jsonb_build_object('total',(select count(*) from sales_core.opportunities o where o.tenant_id=t.id and o.status='open' and o.next_action_at is null),
      'items',coalesce((select jsonb_agg(to_jsonb(x) order by x."createdAt") from (
        select o.id,o.title,c.full_name "contactName",c.owner_staff_id "ownerId",p.full_name "ownerName",o.created_at "createdAt",
          private_app.admission_business_deadline_v1(t.id,o.created_at,1) "reviewAt"
        from sales_core.opportunities o join sales_core.contacts c on c.tenant_id=o.tenant_id and c.id=o.contact_id
        left join people.staff_profiles p on p.tenant_id=t.id and p.id=c.owner_staff_id
        where o.tenant_id=t.id and o.status='open' and o.next_action_at is null order by o.created_at,o.id limit 100
      ) x),'[]'::jsonb)) else jsonb_build_object('total',0,'items','[]'::jsonb) end,
    'legacyRowsWithoutBranch',jsonb_build_object('staff',(select count(*) from people.staff_profiles where tenant_id=t.id and branch_id is null),
      'runs',(select count(*) from academy.course_runs where tenant_id=t.id and branch_id is null),'handoffs',(select count(*) from academy.registration_handoffs where tenant_id=t.id and branch_id is null)));
end $$;
revoke all on function public.v1_tenant_operating_snapshot(text) from public,anon;
grant execute on function public.v1_tenant_operating_snapshot(text) to authenticated;

create function public.v1_tenant_operating_action(p_tenant_slug text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare t core.tenants%rowtype; s core.tenant_operating_setup%rowtype; p people.staff_profiles%rowtype; aid uuid;
  old_state jsonb; next_state jsonb; branch uuid; department uuid; item jsonb; cover uuid;
begin
  select * into t from core.tenants where slug=p_tenant_slug for update;
  if t.id is null then raise exception 'tenant_not_found'; end if;
  if private_app.current_subject_id() is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden' using errcode='42501'; end if;
  select * into s from core.tenant_operating_setup where tenant_id=t.id for update;
  if p_action='preview_scheduling' then
    return jsonb_build_object('version',coalesce(s.version,0),'activeStaff',(select count(*) from people.staff_profiles where tenant_id=t.id and employment_status='active'),
      'withoutShift',(select count(*) from people.staff_profiles sp where sp.tenant_id=t.id and sp.employment_status='active' and not exists(select 1 from people.staff_work_shifts w where w.tenant_id=t.id and w.staff_id=sp.id)),
      'legacyRowsWillChange',0);
  elsif p_action='save_setup' then
    if coalesce((p_payload->>'expectedVersion')::integer,-1)<>coalesce(s.version,0) then raise exception 'operating_setup_version_conflict'; end if;
    if nullif(btrim(p_payload->>'name'),'') is null or length(btrim(p_payload->>'name'))<2
      or nullif(btrim(p_payload->>'legalName'),'') is null or length(btrim(p_payload->>'legalName'))<2 then raise exception 'operating_basic_data_required'; end if;
    if not exists(select 1 from pg_catalog.pg_timezone_names where name=p_payload->>'timezone') then raise exception 'operating_timezone_invalid'; end if;
    if p_payload->>'intakeSource' is null or p_payload->>'intakeSource' not in('manual','excel','internal_form','integration') then raise exception 'operating_intake_required'; end if;
    if p_payload->>'timezone' is distinct from t.timezone and p_payload->>'confirmTimezoneChange' is distinct from 'true' then raise exception 'operating_timezone_confirmation_required'; end if;
    if exists(select 1 from accounting_core.tenant_profiles where tenant_id=t.id and timezone is distinct from p_payload->>'timezone')
      and not private_app.has_accounting_permission(t.id,'tenant.accounting.settings.manage') then raise exception 'operating_finance_timezone_permission_required'; end if;
    old_state:=jsonb_build_object('name',t.name,'legalName',t.legal_name,'timezone',t.timezone,'setup',to_jsonb(s));
    update core.tenants set name=btrim(p_payload->>'name'),legal_name=btrim(p_payload->>'legalName'),timezone=p_payload->>'timezone',updated_at=now() where id=t.id;
    update accounting_core.tenant_profiles set timezone=p_payload->>'timezone',updated_at=now(),updated_by_subject_id=private_app.current_subject_id() where tenant_id=t.id and timezone is distinct from p_payload->>'timezone';
    insert into core.branches(tenant_id,branch_key,name,is_default) values(t.id,'main',coalesce(nullif(btrim(p_payload->>'firstBranchName'),''),'الفرع الرئيسي'),true)
      on conflict(tenant_id,branch_key) do nothing;
    insert into core.tenant_operating_setup(tenant_id,intake_source,updated_by) values(t.id,p_payload->>'intakeSource',private_app.current_subject_id())
      on conflict(tenant_id) do update set intake_source=excluded.intake_source,version=core.tenant_operating_setup.version+1,updated_at=now(),updated_by=excluded.updated_by;
    next_state:=public.v1_tenant_operating_snapshot(p_tenant_slug)->'setup';
  elsif p_action='set_scheduling' then
    if not private_app.has_tenant_permission(t.id,'tenant.people.manage') then raise exception 'forbidden' using errcode='42501'; end if;
    if s.tenant_id is null then raise exception 'operating_setup_required'; end if;
    if p_payload->>'confirmed' is distinct from 'true' or (p_payload->>'expectedVersion')::integer is distinct from s.version then raise exception 'operating_preview_confirmation_required'; end if;
    if p_payload->>'enabled' not in('true','false') or p_payload->>'enabled' is null then raise exception 'operating_enabled_required'; end if;
    if (p_payload->>'enabled')::boolean and exists(select 1 from people.staff_profiles sp where sp.tenant_id=t.id and sp.employment_status='active' and not exists(select 1 from people.staff_work_shifts w where w.tenant_id=t.id and w.staff_id=sp.id)) then raise exception 'operating_staff_shifts_required'; end if;
    old_state:=to_jsonb(s);
    update core.tenant_operating_setup set staff_scheduling_enabled=(p_payload->>'enabled')::boolean,version=version+1,updated_at=now(),updated_by=private_app.current_subject_id() where tenant_id=t.id returning to_jsonb(core.tenant_operating_setup.*) into next_state;
  elsif p_action='save_staff_operations' then
    if not private_app.has_tenant_permission(t.id,'tenant.people.manage') then raise exception 'forbidden' using errcode='42501'; end if;
    select * into p from people.staff_profiles where tenant_id=t.id and id=(p_payload->>'staffId')::uuid for update;
    if p.id is null then raise exception 'staff_not_found'; end if;
    department:=(p_payload->>'primaryDepartmentId')::uuid; branch:=(p_payload->>'branchId')::uuid;
    if not exists(select 1 from people.departments where tenant_id=t.id and id=department and status='active') then raise exception 'operating_primary_department_required'; end if;
    if not exists(select 1 from core.branches where tenant_id=t.id and id=branch and active) then raise exception 'operating_branch_required'; end if;
    if jsonb_typeof(p_payload->'extraDepartmentIds') is distinct from 'array' or jsonb_typeof(p_payload->'shifts') is distinct from 'array' then raise exception 'operating_staff_payload_invalid'; end if;
    if jsonb_array_length(p_payload->'shifts')>28 then raise exception 'operating_too_many_shifts'; end if;
    if coalesce(s.staff_scheduling_enabled,false) and jsonb_array_length(p_payload->'shifts')=0 then raise exception 'operating_staff_shifts_required'; end if;
    old_state:=jsonb_build_object('departmentId',p.department_id,'branchId',p.branch_id,
      'extraDepartments',(select jsonb_agg(department_id) from people.staff_department_memberships where tenant_id=t.id and staff_id=p.id),
      'shifts',(select jsonb_agg(to_jsonb(w)) from people.staff_work_shifts w where w.tenant_id=t.id and w.staff_id=p.id));
    update people.staff_profiles set department_id=department,branch_id=branch where id=p.id and tenant_id=t.id;
    delete from people.staff_department_memberships where tenant_id=t.id and staff_id=p.id;
    for item in select value from jsonb_array_elements(p_payload->'extraDepartmentIds') loop
      if (item#>>'{}')::uuid=department then raise exception 'operating_primary_department_duplicated'; end if;
      if not exists(select 1 from people.departments where tenant_id=t.id and id=(item#>>'{}')::uuid and status='active') then raise exception 'operating_department_invalid'; end if;
      insert into people.staff_department_memberships(tenant_id,staff_id,department_id) values(t.id,p.id,(item#>>'{}')::uuid) on conflict do nothing;
    end loop;
    delete from people.staff_work_shifts where tenant_id=t.id and staff_id=p.id;
    for item in select value from jsonb_array_elements(p_payload->'shifts') loop
      insert into people.staff_work_shifts(tenant_id,staff_id,iso_day,starts_at,ends_at) values(t.id,p.id,(item->>'isoDay')::integer,(item->>'startsAt')::time,(item->>'endsAt')::time);
    end loop;
    next_state:=p_payload; aid:=p.id;
  elsif p_action='record_absence' then
    if not private_app.has_tenant_permission(t.id,'tenant.people.manage') then raise exception 'forbidden' using errcode='42501'; end if;
    select * into p from people.staff_profiles where tenant_id=t.id and id=(p_payload->>'staffId')::uuid for update;
    if p.id is null then raise exception 'staff_not_found'; end if;
    cover:=nullif(p_payload->>'coverStaffId','')::uuid;
    if cover is not null and not exists(select 1 from people.staff_profiles c where c.id=cover and c.tenant_id=t.id and c.employment_status='active'
      and (c.department_id=p.department_id or exists(select 1 from people.staff_department_memberships m where m.tenant_id=t.id and m.staff_id=c.id and m.department_id=p.department_id))) then raise exception 'operating_cover_department_invalid'; end if;
    insert into people.staff_absences(tenant_id,staff_id,starts_at,ends_at,reason,cover_staff_id,created_by)
      values(t.id,p.id,(p_payload->>'startsAt')::timestamptz,(p_payload->>'endsAt')::timestamptz,btrim(p_payload->>'reason'),cover,private_app.current_subject_id()) returning id,to_jsonb(people.staff_absences.*) into aid,next_state;
  elsif p_action='cancel_absence' then
    if not private_app.has_tenant_permission(t.id,'tenant.people.manage') then raise exception 'forbidden' using errcode='42501'; end if;
    select to_jsonb(a) into old_state from people.staff_absences a where tenant_id=t.id and id=(p_payload->>'absenceId')::uuid for update;
    if old_state is null then raise exception 'operating_absence_not_found'; end if;
    update people.staff_absences set cancelled_at=coalesce(cancelled_at,now()) where tenant_id=t.id and id=(p_payload->>'absenceId')::uuid returning id,to_jsonb(people.staff_absences.*) into aid,next_state;
  else raise exception 'operating_action_invalid'; end if;
  if p_action in('save_staff_operations','record_absence','cancel_absence') then
    update core.tenant_operating_setup set version=version+1,updated_at=now(),updated_by=private_app.current_subject_id() where tenant_id=t.id;
  end if;
  insert into core.operating_audit(tenant_id,actor_subject_id,action,record_id,before_state,after_state)
    values(t.id,private_app.current_subject_id(),p_action,aid,old_state,next_state);
  -- Re-evaluate waiting SLA owners asynchronously after availability changes.
  -- Do not lock admissions or finance records while holding the settings lock.
  if p_action in('set_scheduling','save_staff_operations','record_absence','cancel_absence')
     and exists(select 1 from academy.admission_governance_settings where tenant_id=t.id and enabled) then
    perform private_app.queue_admission_governance_v1(t.id,h.id)
      from academy.registration_handoffs h where h.tenant_id=t.id
      and h.registration_status not in('cancelled','rejected','completed');
  end if;
  return public.v1_tenant_operating_snapshot(p_tenant_slug);
end $$;
revoke all on function public.v1_tenant_operating_action(text,text,jsonb) from public,anon;
grant execute on function public.v1_tenant_operating_action(text,text,jsonb) to authenticated;

-- Patch only live assignment selectors, never historical/reporting queries.
-- An unexpected source fails deployment instead of silently skipping a gate.
do $assignment_selectors$
declare signature text; definition text; updated text;
begin
  foreach signature in array array[
    'private_app.commerce_order_pick_assignee(uuid,text)',
    'public.v2_tenant_lead_intake_action_unhardened_20260806(text,text,jsonb)',
    'public.v1_tenant_lead_reassignment_action(text,jsonb)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    updated:=replace(definition,'staff.employment_status = ''active''',
      'staff.employment_status = ''active'' and private_app.staff_operationally_available_v1(staff.tenant_id,staff.id)');
    if definition=updated then raise exception 'operating_assignment_selector_changed: %',signature; end if;
    execute updated;
  end loop;
end $assignment_selectors$;

commit;
