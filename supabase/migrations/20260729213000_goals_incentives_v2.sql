-- Marktone goals and incentives v2.
-- The core is private and exposed only through tenant-authorized RPC functions.

create schema if not exists incentives_core;
revoke all on schema incentives_core from public, anon, authenticated;

create table incentives_core.plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  plan_key text not null,
  title text not null check (length(btrim(title)) >= 3),
  period_start date not null,
  period_end date not null,
  metric_type text not null check (metric_type in (
    'revenue','registered_customers','contracts','closed_opportunities',
    'paid_registrations','courses_sold','collections','conversion_rate',
    'course','branch','campaign'
  )),
  calculation_type text not null check (calculation_type in ('percentage','fixed','tiered')),
  incentive_value numeric(14,4) not null default 0 check (incentive_value >= 0),
  tiers jsonb not null default '[]'::jsonb check (jsonb_typeof(tiers) = 'array'),
  earning_trigger text not null default 'payment_verified' check (earning_trigger in (
    'customer_registered','registration_confirmed','payment_verified','cancellation_window_passed'
  )),
  cancellation_window_days integer not null default 0 check (cancellation_window_days between 0 and 90),
  scope_type text not null default 'employee' check (scope_type in (
    'employee','team','department','branch','course','campaign'
  )),
  scope_reference text,
  status text not null default 'active' check (status in ('draft','active','closed','archived')),
  created_by_subject_id uuid references access_control.subjects(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (tenant_id, plan_key)
);

create table incentives_core.assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  plan_id uuid not null references incentives_core.plans(id) on delete cascade,
  staff_id uuid not null references people.staff_profiles(id) on delete restrict,
  supervisor_staff_id uuid references people.staff_profiles(id) on delete set null,
  target_value numeric(16,2) not null check (target_value > 0),
  active boolean not null default true,
  assigned_at timestamptz not null default now(),
  unique (plan_id, staff_id)
);

create table incentives_core.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  assignment_id uuid not null references incentives_core.assignments(id) on delete cascade,
  staff_id uuid not null references people.staff_profiles(id) on delete restrict,
  source_type text not null check (source_type in (
    'registration_handoff','enrollment','opportunity','contract','collection','manual'
  )),
  source_id uuid,
  customer_name text,
  course_name text,
  campaign_name text,
  metric_value numeric(16,2) not null default 0,
  revenue_amount numeric(16,2) not null default 0,
  incentive_amount numeric(16,2) not null default 0 check (incentive_amount >= 0),
  state text not null default 'expected' check (state in (
    'expected','pending','due','approved','paid','cancelled','refunded'
  )),
  hold_until timestamptz,
  occurred_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by_subject_id uuid references access_control.subjects(id),
  paid_at timestamptz,
  paid_by_subject_id uuid references access_control.subjects(id),
  state_reason text,
  plan_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index incentive_events_source_assignment_idx
  on incentives_core.events(assignment_id, source_type, source_id)
  where source_id is not null;
create index incentive_plans_tenant_period_idx
  on incentives_core.plans(tenant_id, period_start, period_end, status);
create index incentive_assignments_staff_idx
  on incentives_core.assignments(tenant_id, staff_id, active);
create index incentive_assignments_supervisor_idx
  on incentives_core.assignments(tenant_id, supervisor_staff_id, active)
  where supervisor_staff_id is not null;
create index incentive_events_tenant_state_idx
  on incentives_core.events(tenant_id, state, occurred_at desc);
create index incentive_events_staff_idx
  on incentives_core.events(tenant_id, staff_id, occurred_at desc);

comment on table incentives_core.plans is
  'Versioned tenant incentive plans; percentages, fixed values, and slabs remain frozen per event.';
comment on table incentives_core.events is
  'Immutable-source incentive ledger with controlled expected-to-paid transitions.';

create or replace function private_app.incentive_role_keys(p_tenant_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct r.role_key), '{}'::text[])
  from access_control.subjects s
  join access_control.memberships m
    on m.subject_id = s.id
   and m.tenant_id = p_tenant_id
   and m.scope = 'tenant'
   and m.status = 'active'
  join access_control.membership_roles mr on mr.membership_id = m.id
  join access_control.roles r on r.id = mr.role_id
  where s.auth_user_id = auth.uid()
    and s.status = 'active'
    and not s.must_change_password
$$;

create or replace function private_app.incentive_tier(
  p_plan incentives_core.plans,
  p_achievement numeric
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select tier
    from jsonb_array_elements(p_plan.tiers) tier
    where p_achievement >= coalesce((tier->>'from')::numeric, 0)
      and (
        nullif(tier->>'to','') is null
        or p_achievement <= (tier->>'to')::numeric
      )
    order by coalesce((tier->>'from')::numeric, 0) desc
    limit 1
  ), '{}'::jsonb)
$$;

create or replace function private_app.calculate_incentive(
  p_plan incentives_core.plans,
  p_metric_value numeric,
  p_revenue_amount numeric,
  p_achievement numeric
)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tier jsonb;
  v_type text;
  v_value numeric;
begin
  if p_plan.calculation_type = 'tiered' then
    v_tier := private_app.incentive_tier(p_plan, p_achievement);
    v_type := coalesce(v_tier->>'type', 'fixed');
    v_value := coalesce((v_tier->>'value')::numeric, 0);
  else
    v_type := p_plan.calculation_type;
    v_value := p_plan.incentive_value;
  end if;

  if v_type = 'percentage' then
    return round(greatest(coalesce(p_revenue_amount, 0), 0) * v_value / 100, 2);
  end if;
  return round(greatest(coalesce(p_metric_value, 0), 0) * v_value, 2);
end
$$;

create or replace function private_app.incentive_source_state(
  p_plan incentives_core.plans,
  p_handoff academy.registration_handoffs
)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_handoff.payment_status = 'refunded' then return 'refunded'; end if;
  if p_handoff.status in ('cancelled','rejected') or p_handoff.payment_status = 'rejected' then
    return 'cancelled';
  end if;
  if p_plan.earning_trigger in ('payment_verified','cancellation_window_passed')
     and p_handoff.payment_status = 'verified' then
    return case when p_plan.cancellation_window_days > 0 then 'pending' else 'due' end;
  end if;
  if p_plan.earning_trigger = 'registration_confirmed'
     and exists (
       select 1 from academy.enrollments e
       where e.handoff_id = p_handoff.id and e.status in ('confirmed','active','completed')
     ) then
    return case when p_plan.cancellation_window_days > 0 then 'pending' else 'due' end;
  end if;
  if p_plan.earning_trigger = 'customer_registered'
     and p_handoff.status in ('accepted','completed') then
    return case when p_plan.cancellation_window_days > 0 then 'pending' else 'due' end;
  end if;
  if p_handoff.payment_status = 'pending_verification' then return 'pending'; end if;
  return 'expected';
end
$$;

create or replace function private_app.sync_incentive_source(p_handoff_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handoff academy.registration_handoffs%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_row record;
  v_metric numeric;
  v_revenue numeric;
  v_achievement numeric;
  v_amount numeric;
  v_state text;
  v_hold timestamptz;
  v_course_name text;
begin
  select * into v_handoff
  from academy.registration_handoffs
  where id = p_handoff_id;
  if v_handoff.id is null then return; end if;

  select * into v_contact
  from sales_core.contacts
  where id = v_handoff.contact_id;
  if v_contact.owner_staff_id is null then return; end if;

  select c.title_ar into v_course_name
  from academy.courses c
  where c.id = v_handoff.course_id;

  for v_row in
    select a as assignment_row, p as plan_row
    from incentives_core.assignments a
    join incentives_core.plans p on p.id = a.plan_id
    where a.tenant_id = v_handoff.tenant_id
      and a.staff_id = v_contact.owner_staff_id
      and a.active
      and p.status = 'active'
      and v_handoff.created_at::date between p.period_start and p.period_end
      and (
        p.scope_type not in ('course','campaign')
        or (p.scope_type = 'course' and p.scope_reference = v_handoff.course_id::text)
        or (p.scope_type = 'campaign' and p.scope_reference = coalesce(v_contact.campaign_name,''))
      )
  loop
    v_revenue := coalesce(v_handoff.payment_amount_minor,0)::numeric / 100;
    v_metric := case
      when (v_row.plan_row).metric_type in ('revenue','collections') then v_revenue
      else 1
    end;
    select coalesce(sum(e.metric_value),0) + v_metric
    into v_achievement
    from incentives_core.events e
    where e.assignment_id = (v_row.assignment_row).id
      and e.state not in ('cancelled','refunded')
      and not (e.source_type = 'registration_handoff' and e.source_id = v_handoff.id);

    v_amount := private_app.calculate_incentive(
      v_row.plan_row, v_metric, v_revenue, v_achievement
    );
    v_state := private_app.incentive_source_state(v_row.plan_row, v_handoff);
    v_hold := case
      when v_state = 'pending'
       and (v_row.plan_row).cancellation_window_days > 0
       and (
         v_handoff.payment_status = 'verified'
         or v_handoff.status in ('accepted','completed')
       )
      then coalesce(v_handoff.payment_verified_at,v_handoff.accepted_at,now())
           + make_interval(days => (v_row.plan_row).cancellation_window_days)
      else null
    end;

    insert into incentives_core.events(
      tenant_id, assignment_id, staff_id, source_type, source_id,
      customer_name, course_name, campaign_name, metric_value, revenue_amount,
      incentive_amount, state, hold_until, occurred_at, plan_snapshot, metadata
    ) values (
      v_handoff.tenant_id, (v_row.assignment_row).id, (v_row.assignment_row).staff_id,
      'registration_handoff', v_handoff.id, v_contact.full_name, v_course_name,
      v_contact.campaign_name, v_metric, v_revenue, v_amount, v_state, v_hold,
      v_handoff.created_at,
      jsonb_build_object(
        'planId',(v_row.plan_row).id,'title',(v_row.plan_row).title,
        'metricType',(v_row.plan_row).metric_type,
        'calculationType',(v_row.plan_row).calculation_type,
        'incentiveValue',(v_row.plan_row).incentive_value,
        'tiers',(v_row.plan_row).tiers,'earningTrigger',(v_row.plan_row).earning_trigger
      ),
      jsonb_build_object(
        'paymentStatus',v_handoff.payment_status,
        'registrationStatus',v_handoff.status,
        'paymentReference',v_handoff.payment_reference
      )
    )
    on conflict (assignment_id, source_type, source_id)
      where source_id is not null
    do update set
      customer_name = excluded.customer_name,
      course_name = excluded.course_name,
      campaign_name = excluded.campaign_name,
      metric_value = excluded.metric_value,
      revenue_amount = excluded.revenue_amount,
      incentive_amount = case
        when incentives_core.events.state in ('approved','paid')
          then incentives_core.events.incentive_amount
        else excluded.incentive_amount
      end,
      state = case
        when incentives_core.events.state in ('approved','paid')
          then incentives_core.events.state
        else excluded.state
      end,
      hold_until = excluded.hold_until,
      metadata = excluded.metadata,
      updated_at = now();
  end loop;
end
$$;

create or replace function private_app.sync_incentive_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source uuid;
begin
  for v_source in
    select h.id
    from academy.registration_handoffs h
    join incentives_core.plans p
      on p.id = p_plan_id
     and p.tenant_id = h.tenant_id
     and h.created_at::date between p.period_start and p.period_end
  loop
    perform private_app.sync_incentive_source(v_source);
  end loop;
end
$$;

create or replace function private_app.registration_handoff_incentives_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private_app.sync_incentive_source(new.id);
  return new;
end
$$;

drop trigger if exists registration_handoff_incentives_v2
  on academy.registration_handoffs;
create trigger registration_handoff_incentives_v2
after insert or update of status,payment_status,payment_amount_minor,payment_verified_at,course_id
on academy.registration_handoffs
for each row execute function private_app.registration_handoff_incentives_v2();

create or replace function public.v2_tenant_incentives_snapshot(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_roles text[];
  v_is_all boolean;
  v_is_team boolean;
  v_can_manage boolean;
  v_can_approve boolean;
  v_can_pay boolean;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_tenant from core.tenants where slug = p_slug and status in ('trial','active');
  if v_tenant.id is null or not private_app.has_tenant_permission(v_tenant.id,'tenant.incentives.read') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_roles := private_app.incentive_role_keys(v_tenant.id);
  v_is_all := private_app.has_platform_permission('platform.control.read')
    or v_roles && array['tenant_owner','tenant_admin','executive_manager','sales_manager'];
  v_is_team := v_is_all or 'sales_supervisor' = any(v_roles);
  v_can_manage := private_app.has_tenant_permission(v_tenant.id,'tenant.incentives.write');
  v_can_approve := v_is_all;
  v_can_pay := private_app.has_platform_permission('platform.control.read')
    or v_roles && array['tenant_owner','tenant_admin','executive_manager'];

  update incentives_core.events e
  set state = 'due', updated_at = now()
  where e.tenant_id = v_tenant.id
    and e.state = 'pending'
    and e.hold_until is not null
    and e.hold_until <= now();

  return jsonb_build_object(
    'viewer',jsonb_build_object(
      'staffId',v_staff_id,'roles',v_roles,
      'scope',case when v_is_all then 'all' when v_is_team then 'team' else 'own' end,
      'canManagePlans',v_can_manage,'canApprove',v_can_approve,'canPay',v_can_pay
    ),
    'employees',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',s.id,'name',s.full_name,'jobTitle',s.job_title,'role',s.role_key
      ) order by s.full_name)
      from people.staff_profiles s
      where s.tenant_id = v_tenant.id
        and s.employment_status = 'active'
        and s.role_key in ('sales_user','sales_supervisor','sales_manager','executive_manager','tenant_admin','tenant_owner')
    ),'[]'::jsonb),
    'plans',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'title',p.title,'periodStart',p.period_start,'periodEnd',p.period_end,
        'metricType',p.metric_type,'calculationType',p.calculation_type,
        'incentiveValue',p.incentive_value,'tiers',p.tiers,
        'earningTrigger',p.earning_trigger,'cancellationWindowDays',p.cancellation_window_days,
        'scopeType',p.scope_type,'scopeReference',p.scope_reference,'status',p.status,
        'assignmentCount',(select count(*) from incentives_core.assignments a where a.plan_id=p.id and a.active)
      ) order by p.created_at desc)
      from incentives_core.plans p where p.tenant_id = v_tenant.id
    ),'[]'::jsonb),
    'assignments',coalesce((
      select jsonb_agg(item order by item->>'employeeName')
      from (
        select jsonb_build_object(
          'id',a.id,'planId',a.plan_id,'planTitle',p.title,
          'employeeId',a.staff_id,'employeeName',s.full_name,'jobTitle',s.job_title,
          'supervisorId',a.supervisor_staff_id,'target',a.target_value,
          'metricType',p.metric_type,'tiers',p.tiers,
          'achieved',coalesce(sum(e.metric_value) filter (where e.state not in ('cancelled','refunded')),0),
          'expected',coalesce(sum(e.incentive_amount) filter (where e.state='expected'),0),
          'pending',coalesce(sum(e.incentive_amount) filter (where e.state='pending'),0),
          'due',coalesce(sum(e.incentive_amount) filter (where e.state='due'),0),
          'approved',coalesce(sum(e.incentive_amount) filter (where e.state='approved'),0),
          'paid',coalesce(sum(e.incentive_amount) filter (where e.state='paid'),0),
          'cancelled',coalesce(sum(e.incentive_amount) filter (where e.state in ('cancelled','refunded')),0)
        ) item
        from incentives_core.assignments a
        join incentives_core.plans p on p.id=a.plan_id
        join people.staff_profiles s on s.id=a.staff_id
        left join incentives_core.events e on e.assignment_id=a.id
        where a.tenant_id=v_tenant.id and a.active
          and (
            v_is_all
            or (v_is_team and (a.supervisor_staff_id=v_staff_id or a.staff_id=v_staff_id))
            or a.staff_id=v_staff_id
          )
        group by a.id,p.id,s.id
      ) scoped_assignments
    ),'[]'::jsonb),
    'events',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'assignmentId',e.assignment_id,'staffId',e.staff_id,
        'employeeName',s.full_name,'customerName',e.customer_name,
        'courseName',e.course_name,'campaignName',e.campaign_name,
        'metricValue',e.metric_value,'revenueAmount',e.revenue_amount,
        'incentiveAmount',e.incentive_amount,'state',e.state,
        'holdUntil',e.hold_until,'occurredAt',e.occurred_at,
        'stateReason',e.state_reason,'planTitle',p.title
      ) order by e.occurred_at desc)
      from incentives_core.events e
      join incentives_core.assignments a on a.id=e.assignment_id
      join incentives_core.plans p on p.id=a.plan_id
      join people.staff_profiles s on s.id=e.staff_id
      where e.tenant_id=v_tenant.id
        and (
          v_is_all
          or (v_is_team and (a.supervisor_staff_id=v_staff_id or a.staff_id=v_staff_id))
          or e.staff_id=v_staff_id
        )
    ),'[]'::jsonb)
  );
end
$$;

create or replace function public.v2_tenant_incentives_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_subject_id uuid;
  v_staff_id uuid;
  v_roles text[];
  v_plan incentives_core.plans%rowtype;
  v_plan_id uuid;
  v_event incentives_core.events%rowtype;
  v_assignment jsonb;
  v_tiers jsonb;
  v_next_state text;
  v_can_all boolean;
  v_can_pay boolean;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_tenant from core.tenants where slug=p_slug and status in ('trial','active');
  if v_tenant.id is null or not private_app.has_tenant_permission(v_tenant.id,'tenant.incentives.read') then
    raise exception 'forbidden' using errcode='42501';
  end if;
  v_subject_id := private_app.current_subject_id();
  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_roles := private_app.incentive_role_keys(v_tenant.id);
  v_can_all := private_app.has_platform_permission('platform.control.read')
    or v_roles && array['tenant_owner','tenant_admin','executive_manager','sales_manager'];
  v_can_pay := private_app.has_platform_permission('platform.control.read')
    or v_roles && array['tenant_owner','tenant_admin','executive_manager'];

  if p_action='create_plan' then
    if not private_app.has_tenant_permission(v_tenant.id,'tenant.incentives.write') then
      raise exception 'forbidden' using errcode='42501';
    end if;
    if coalesce(jsonb_array_length(p_payload->'assignments'),0)=0 then
      raise exception 'assignments_required';
    end if;
    v_tiers := coalesce(p_payload->'tiers','[]'::jsonb);
    if p_payload->>'calculationType'='tiered' and jsonb_array_length(v_tiers)=0 then
      raise exception 'tiers_required';
    end if;

    insert into incentives_core.plans(
      tenant_id,plan_key,title,period_start,period_end,metric_type,
      calculation_type,incentive_value,tiers,earning_trigger,
      cancellation_window_days,scope_type,scope_reference,status,created_by_subject_id
    ) values (
      v_tenant.id,'INC-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS'),
      btrim(p_payload->>'title'),(p_payload->>'periodStart')::date,
      (p_payload->>'periodEnd')::date,p_payload->>'metricType',
      p_payload->>'calculationType',coalesce((p_payload->>'incentiveValue')::numeric,0),
      v_tiers,coalesce(p_payload->>'earningTrigger','payment_verified'),
      coalesce((p_payload->>'cancellationWindowDays')::integer,0),
      coalesce(p_payload->>'scopeType','employee'),nullif(p_payload->>'scopeReference',''),
      coalesce(p_payload->>'status','active'),v_subject_id
    ) returning * into v_plan;

    for v_assignment in select * from jsonb_array_elements(p_payload->'assignments')
    loop
      if not exists (
        select 1 from people.staff_profiles s
        where s.id=(v_assignment->>'staffId')::uuid
          and s.tenant_id=v_tenant.id and s.employment_status='active'
      ) then raise exception 'invalid_staff'; end if;
      insert into incentives_core.assignments(
        tenant_id,plan_id,staff_id,supervisor_staff_id,target_value
      ) values (
        v_tenant.id,v_plan.id,(v_assignment->>'staffId')::uuid,
        nullif(v_assignment->>'supervisorStaffId','')::uuid,
        (v_assignment->>'targetValue')::numeric
      );
    end loop;
    if v_plan.status='active' then perform private_app.sync_incentive_plan(v_plan.id); end if;
    return jsonb_build_object('success',true,'planId',v_plan.id);
  end if;

  if p_action='set_plan_status' then
    if not private_app.has_tenant_permission(v_tenant.id,'tenant.incentives.write') then
      raise exception 'forbidden' using errcode='42501';
    end if;
    update incentives_core.plans
    set status=p_payload->>'status',updated_at=now()
    where id=(p_payload->>'planId')::uuid and tenant_id=v_tenant.id
    returning id into v_plan_id;
    if v_plan_id is null then raise exception 'plan_not_found'; end if;
    if p_payload->>'status'='active' then perform private_app.sync_incentive_plan(v_plan_id); end if;
    return jsonb_build_object('success',true);
  end if;

  if p_action='sync' then
    if not private_app.has_tenant_permission(v_tenant.id,'tenant.incentives.write') then
      raise exception 'forbidden' using errcode='42501';
    end if;
    for v_plan_id in select id from incentives_core.plans where tenant_id=v_tenant.id and status='active'
    loop perform private_app.sync_incentive_plan(v_plan_id); end loop;
    return jsonb_build_object('success',true);
  end if;

  if p_action='transition_event' then
    select * into v_event from incentives_core.events
    where id=(p_payload->>'eventId')::uuid and tenant_id=v_tenant.id
    for update;
    if v_event.id is null then raise exception 'event_not_found'; end if;
    v_next_state := p_payload->>'state';
    if v_next_state='approved' then
      if not v_can_all or v_event.state<>'due' then raise exception 'invalid_transition'; end if;
    elsif v_next_state='paid' then
      if not v_can_pay or v_event.state<>'approved' then raise exception 'invalid_transition'; end if;
    elsif v_next_state in ('cancelled','refunded') then
      if not v_can_all or v_event.state='paid' then raise exception 'invalid_transition'; end if;
    else
      raise exception 'invalid_transition';
    end if;
    update incentives_core.events set
      state=v_next_state,
      approved_at=case when v_next_state='approved' then now() else approved_at end,
      approved_by_subject_id=case when v_next_state='approved' then v_subject_id else approved_by_subject_id end,
      paid_at=case when v_next_state='paid' then now() else paid_at end,
      paid_by_subject_id=case when v_next_state='paid' then v_subject_id else paid_by_subject_id end,
      state_reason=nullif(p_payload->>'reason',''),updated_at=now()
    where id=v_event.id;
    return jsonb_build_object('success',true);
  end if;

  raise exception 'unsupported_action';
end
$$;

revoke all on function public.v2_tenant_incentives_snapshot(text) from public, anon;
revoke all on function public.v2_tenant_incentives_action(text,text,jsonb) from public, anon;
grant execute on function public.v2_tenant_incentives_snapshot(text) to authenticated;
grant execute on function public.v2_tenant_incentives_action(text,text,jsonb) to authenticated;

revoke all on all tables in schema incentives_core from public, anon, authenticated;
revoke all on function private_app.incentive_role_keys(uuid) from public, anon, authenticated;
revoke all on function private_app.incentive_tier(incentives_core.plans,numeric) from public, anon, authenticated;
revoke all on function private_app.calculate_incentive(incentives_core.plans,numeric,numeric,numeric) from public, anon, authenticated;
revoke all on function private_app.incentive_source_state(incentives_core.plans,academy.registration_handoffs) from public, anon, authenticated;
revoke all on function private_app.sync_incentive_source(uuid) from public, anon, authenticated;
revoke all on function private_app.sync_incentive_plan(uuid) from public, anon, authenticated;
