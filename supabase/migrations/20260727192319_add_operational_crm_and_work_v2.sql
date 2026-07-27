begin;

create schema if not exists sales_core;
create schema if not exists work_core;

create table sales_core.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  stage_key text not null,
  name_ar text not null,
  name_en text,
  position integer not null default 0,
  probability_percent integer not null default 0
    check (probability_percent between 0 and 100),
  is_closed boolean not null default false,
  is_won boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, stage_key),
  check (not is_won or is_closed)
);

create table sales_core.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  contact_key text not null default ('manual-' || gen_random_uuid()::text),
  full_name text not null check (length(trim(full_name)) >= 2),
  organization_name text,
  phone text,
  whatsapp text,
  email text check (email is null or email = lower(trim(email))),
  source text not null default 'manual',
  status text not null default 'active'
    check (status in ('new', 'active', 'unqualified', 'converted', 'archived')),
  owner_staff_id uuid references people.staff_profiles(id) on delete set null,
  interest_course_id uuid references academy.courses(id) on delete set null,
  notes text,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, contact_key)
);

create table sales_core.opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  opportunity_key text not null default ('manual-' || gen_random_uuid()::text),
  contact_id uuid not null references sales_core.contacts(id) on delete cascade,
  course_id uuid references academy.courses(id) on delete set null,
  stage_id uuid not null references sales_core.pipeline_stages(id) on delete restrict,
  owner_staff_id uuid references people.staff_profiles(id) on delete set null,
  title text not null check (length(trim(title)) >= 2),
  value_minor bigint not null default 0 check (value_minor >= 0),
  currency text not null default 'SAR',
  expected_close_date date,
  next_action_type text,
  next_action_at timestamptz,
  status text not null default 'open'
    check (status in ('open', 'won', 'lost', 'cancelled')),
  lost_reason text,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, opportunity_key),
  check (
    status <> 'open'
    or (next_action_type is not null and next_action_at is not null)
  )
);

create table sales_core.activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  activity_key text not null default ('manual-' || gen_random_uuid()::text),
  opportunity_id uuid references sales_core.opportunities(id) on delete cascade,
  contact_id uuid not null references sales_core.contacts(id) on delete cascade,
  actor_staff_id uuid references people.staff_profiles(id) on delete set null,
  activity_type text not null
    check (activity_type in ('call', 'meeting', 'whatsapp', 'email', 'offer', 'note')),
  outcome text,
  summary text not null check (length(trim(summary)) >= 2),
  occurred_at timestamptz not null default now(),
  next_action_type text,
  next_action_at timestamptz,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, activity_key),
  check (
    activity_type = 'note'
    or (next_action_type is not null and next_action_at is not null)
  )
);

create table work_core.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  task_key text not null default ('manual-' || gen_random_uuid()::text),
  title text not null check (length(trim(title)) >= 2),
  description text,
  status text not null default 'todo'
    check (status in ('todo', 'in_progress', 'completed', 'cancelled')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_staff_id uuid references people.staff_profiles(id) on delete set null,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  contact_id uuid references sales_core.contacts(id) on delete cascade,
  opportunity_id uuid references sales_core.opportunities(id) on delete cascade,
  activity_id uuid references sales_core.activities(id) on delete set null,
  starts_at timestamptz,
  due_at timestamptz not null,
  completed_at timestamptz,
  completion_timing text
    check (completion_timing is null or completion_timing in ('on_time', 'late')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, task_key)
);

create index sales_contacts_tenant_owner_status_idx
on sales_core.contacts (tenant_id, owner_staff_id, status);

create index sales_contacts_tenant_course_idx
on sales_core.contacts (tenant_id, interest_course_id);

create index sales_opportunities_tenant_stage_owner_idx
on sales_core.opportunities (tenant_id, stage_id, owner_staff_id, status);

create index sales_opportunities_tenant_next_action_idx
on sales_core.opportunities (tenant_id, next_action_at)
where status = 'open';

create index sales_activities_tenant_occurred_idx
on sales_core.activities (tenant_id, occurred_at desc);

create index sales_activities_opportunity_idx
on sales_core.activities (opportunity_id, occurred_at desc);

create index sales_activities_contact_idx
on sales_core.activities (contact_id, occurred_at desc);

create index sales_activities_actor_idx
on sales_core.activities (actor_staff_id, occurred_at desc);

create index work_tasks_tenant_due_status_idx
on work_core.tasks (tenant_id, due_at, status);

create index work_tasks_assignee_due_idx
on work_core.tasks (assigned_staff_id, due_at, status);

create index work_tasks_opportunity_idx
on work_core.tasks (opportunity_id, due_at);

create index work_tasks_contact_idx
on work_core.tasks (contact_id, due_at);

create index work_tasks_activity_idx
on work_core.tasks (activity_id);

create trigger pipeline_stages_set_updated_at
before update on sales_core.pipeline_stages
for each row execute function private_app.set_updated_at();

create trigger sales_contacts_set_updated_at
before update on sales_core.contacts
for each row execute function private_app.set_updated_at();

create trigger sales_opportunities_set_updated_at
before update on sales_core.opportunities
for each row execute function private_app.set_updated_at();

create trigger work_tasks_set_updated_at
before update on work_core.tasks
for each row execute function private_app.set_updated_at();

alter table sales_core.pipeline_stages enable row level security;
alter table sales_core.contacts enable row level security;
alter table sales_core.opportunities enable row level security;
alter table sales_core.activities enable row level security;
alter table work_core.tasks enable row level security;

create policy pipeline_stages_isolated_read
on sales_core.pipeline_stages
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy sales_contacts_isolated_read
on sales_core.contacts
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy sales_opportunities_isolated_read
on sales_core.opportunities
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy sales_activities_isolated_read
on sales_core.activities
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy work_tasks_isolated_read
on work_core.tasks
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on all tables in schema sales_core from public, anon, authenticated;
revoke all on all tables in schema work_core from public, anon, authenticated;
revoke all on all sequences in schema sales_core from public, anon, authenticated;
revoke all on all sequences in schema work_core from public, anon, authenticated;

alter default privileges in schema sales_core
revoke all on tables from public, anon, authenticated;
alter default privileges in schema work_core
revoke all on tables from public, anon, authenticated;
alter default privileges in schema sales_core
revoke all on sequences from public, anon, authenticated;
alter default privileges in schema work_core
revoke all on sequences from public, anon, authenticated;

create or replace function private_app.current_staff_id(p_tenant_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sp.id
  from access_control.subjects s
  join access_control.memberships m
    on m.subject_id = s.id
   and m.tenant_id = p_tenant_id
   and m.scope = 'tenant'
   and m.status = 'active'
  join people.staff_profiles sp
    on sp.membership_id = m.id
   and sp.tenant_id = p_tenant_id
   and sp.employment_status = 'active'
  where s.auth_user_id = auth.uid()
    and s.status = 'active'
  limit 1
$$;

create or replace function private_app.has_tenant_role(
  p_tenant_id uuid,
  p_role_keys text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects s
      join access_control.memberships m
        on m.subject_id = s.id
       and m.tenant_id = p_tenant_id
       and m.scope = 'tenant'
       and m.status = 'active'
      join access_control.membership_roles mr on mr.membership_id = m.id
      join access_control.roles r
        on r.id = mr.role_id
       and r.scope = 'tenant'
      where s.auth_user_id = auth.uid()
        and s.status = 'active'
        and r.role_key = any(p_role_keys)
    )
  )
$$;

create or replace function private_app.can_view_tenant_team(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private_app.has_tenant_role(
    p_tenant_id,
    array[
      'tenant_owner',
      'tenant_admin',
      'executive_manager',
      'sales_manager',
      'sales_supervisor',
      'data_officer',
      'data_analyst'
    ]::text[]
  )
$$;

revoke all on function private_app.current_staff_id(uuid)
from public, anon, authenticated;
revoke all on function private_app.has_tenant_role(uuid, text[])
from public, anon, authenticated;
revoke all on function private_app.can_view_tenant_team(uuid)
from public, anon, authenticated;

create or replace function private_app.seed_tenant_pipeline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into sales_core.pipeline_stages (
    tenant_id,
    stage_key,
    name_ar,
    name_en,
    position,
    probability_percent,
    is_closed,
    is_won
  )
  values
    (new.id, 'new_lead', 'عميل جديد', 'New lead', 10, 10, false, false),
    (new.id, 'contacted', 'تم التواصل', 'Contacted', 20, 25, false, false),
    (new.id, 'qualified', 'مؤهل', 'Qualified', 30, 50, false, false),
    (new.id, 'proposal', 'عرض مرسل', 'Proposal sent', 40, 75, false, false),
    (new.id, 'won', 'ناجحة', 'Won', 50, 100, true, true),
    (new.id, 'lost', 'غير ناجحة', 'Lost', 60, 0, true, false)
  on conflict (tenant_id, stage_key) do nothing;

  return new;
end;
$$;

revoke all on function private_app.seed_tenant_pipeline()
from public, anon, authenticated;

create trigger tenants_seed_pipeline_after_insert
after insert on core.tenants
for each row execute function private_app.seed_tenant_pipeline();

insert into sales_core.pipeline_stages (
  tenant_id,
  stage_key,
  name_ar,
  name_en,
  position,
  probability_percent,
  is_closed,
  is_won
)
select
  t.id,
  seed.stage_key,
  seed.name_ar,
  seed.name_en,
  seed.position,
  seed.probability_percent,
  seed.is_closed,
  seed.is_won
from core.tenants t
cross join (
  values
    ('new_lead', 'عميل جديد', 'New lead', 10, 10, false, false),
    ('contacted', 'تم التواصل', 'Contacted', 20, 25, false, false),
    ('qualified', 'مؤهل', 'Qualified', 30, 50, false, false),
    ('proposal', 'عرض مرسل', 'Proposal sent', 40, 75, false, false),
    ('won', 'ناجحة', 'Won', 50, 100, true, true),
    ('lost', 'غير ناجحة', 'Lost', 60, 0, true, false)
) as seed(
  stage_key,
  name_ar,
  name_en,
  position,
  probability_percent,
  is_closed,
  is_won
)
on conflict (tenant_id, stage_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    position = excluded.position,
    probability_percent = excluded.probability_percent,
    is_closed = excluded.is_closed,
    is_won = excluded.is_won;

create or replace function public.v2_tenant_operations_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_subject_id uuid;
  v_view_team boolean;
  v_can_write_crm boolean;
  v_can_write_work boolean;
  v_today date;
begin
  select *
  into v_tenant
  from core.tenants
  where slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.workspace.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_subject_id := private_app.current_subject_id();
  v_view_team := private_app.can_view_tenant_team(v_tenant.id);
  v_can_write_crm := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.crm.write'
  );
  v_can_write_work := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.work.write'
  );
  v_today := (now() at time zone v_tenant.timezone)::date;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'viewTeam', v_view_team,
      'canWriteCrm', v_can_write_crm,
      'canWriteWork', v_can_write_work
    ),
    'summary', jsonb_build_object(
      'activeContacts', (
        select count(*)
        from sales_core.contacts c
        where c.tenant_id = v_tenant.id
          and c.status in ('new', 'active', 'converted')
          and (v_view_team or c.owner_staff_id = v_staff_id)
      ),
      'openOpportunities', (
        select count(*)
        from sales_core.opportunities o
        where o.tenant_id = v_tenant.id
          and o.status = 'open'
          and (v_view_team or o.owner_staff_id = v_staff_id)
      ),
      'pipelineValueMinor', (
        select coalesce(sum(o.value_minor), 0)
        from sales_core.opportunities o
        where o.tenant_id = v_tenant.id
          and o.status = 'open'
          and (v_view_team or o.owner_staff_id = v_staff_id)
      ),
      'dueToday', (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.status in ('todo', 'in_progress')
          and (task.due_at at time zone v_tenant.timezone)::date = v_today
          and (
            v_view_team
            or task.assigned_staff_id = v_staff_id
            or task.created_by_subject_id = v_subject_id
          )
      ),
      'overdueTasks', (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.status in ('todo', 'in_progress')
          and task.due_at < now()
          and (
            v_view_team
            or task.assigned_staff_id = v_staff_id
            or task.created_by_subject_id = v_subject_id
          )
      ),
      'activitiesToday', (
        select count(*)
        from sales_core.activities a
        left join sales_core.opportunities o on o.id = a.opportunity_id
        left join sales_core.contacts c on c.id = a.contact_id
        where a.tenant_id = v_tenant.id
          and (a.occurred_at at time zone v_tenant.timezone)::date = v_today
          and (
            v_view_team
            or a.actor_staff_id = v_staff_id
            or o.owner_staff_id = v_staff_id
            or c.owner_staff_id = v_staff_id
          )
      ),
      'wonThisMonth', (
        select count(*)
        from sales_core.opportunities o
        where o.tenant_id = v_tenant.id
          and o.status = 'won'
          and date_trunc(
            'month',
            o.updated_at at time zone v_tenant.timezone
          ) = date_trunc(
            'month',
            now() at time zone v_tenant.timezone
          )
          and (v_view_team or o.owner_staff_id = v_staff_id)
      )
    ),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', stage.id,
        'key', stage.stage_key,
        'nameAr', stage.name_ar,
        'position', stage.position,
        'probability', stage.probability_percent,
        'closed', stage.is_closed,
        'won', stage.is_won
      ) order by stage.position)
      from sales_core.pipeline_stages stage
      where stage.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sp.id,
        'name', sp.full_name,
        'jobTitle', sp.job_title,
        'roleKey', sp.role_key,
        'department', d.name_ar,
        'accountStatus', sp.account_status
      ) order by d.name_ar, sp.full_name)
      from people.staff_profiles sp
      left join people.departments d on d.id = sp.department_id
      where sp.tenant_id = v_tenant.id
        and sp.employment_status = 'active'
        and (
          v_view_team
          or sp.id = v_staff_id
        )
    ), '[]'::jsonb),
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'courseCode', c.course_code,
        'nameAr', c.title_ar,
        'status', c.status
      ) order by c.title_ar)
      from academy.courses c
      where c.tenant_id = v_tenant.id
        and c.status = 'active'
    ), '[]'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'contactKey', c.contact_key,
        'name', c.full_name,
        'organizationName', c.organization_name,
        'phone', c.phone,
        'whatsapp', c.whatsapp,
        'email', c.email,
        'source', c.source,
        'status', c.status,
        'ownerStaffId', c.owner_staff_id,
        'ownerName', owner.full_name,
        'interestCourseId', c.interest_course_id,
        'interestCourseName', course.title_ar,
        'notes', c.notes,
        'demo', coalesce((c.metadata ->> 'demo')::boolean, false),
        'createdAt', c.created_at
      ) order by c.created_at desc)
      from sales_core.contacts c
      left join people.staff_profiles owner on owner.id = c.owner_staff_id
      left join academy.courses course on course.id = c.interest_course_id
      where c.tenant_id = v_tenant.id
        and (v_view_team or c.owner_staff_id = v_staff_id)
    ), '[]'::jsonb),
    'opportunities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'opportunityKey', o.opportunity_key,
        'title', o.title,
        'contactId', o.contact_id,
        'contactName', contact.full_name,
        'organizationName', contact.organization_name,
        'courseId', o.course_id,
        'courseName', course.title_ar,
        'stageId', o.stage_id,
        'stageKey', stage.stage_key,
        'stageName', stage.name_ar,
        'closed', stage.is_closed,
        'won', stage.is_won,
        'ownerStaffId', o.owner_staff_id,
        'ownerName', owner.full_name,
        'valueMinor', o.value_minor,
        'currency', o.currency,
        'expectedCloseDate', o.expected_close_date,
        'nextActionType', o.next_action_type,
        'nextActionAt', o.next_action_at,
        'status', o.status,
        'demo', coalesce((o.metadata ->> 'demo')::boolean, false),
        'createdAt', o.created_at,
        'updatedAt', o.updated_at
      ) order by stage.position, o.next_action_at nulls last)
      from sales_core.opportunities o
      join sales_core.contacts contact on contact.id = o.contact_id
      join sales_core.pipeline_stages stage on stage.id = o.stage_id
      left join academy.courses course on course.id = o.course_id
      left join people.staff_profiles owner on owner.id = o.owner_staff_id
      where o.tenant_id = v_tenant.id
        and (v_view_team or o.owner_staff_id = v_staff_id)
    ), '[]'::jsonb),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', activity.id,
        'opportunityId', activity.opportunity_id,
        'opportunityTitle', opportunity.title,
        'contactId', activity.contact_id,
        'contactName', contact.full_name,
        'actorStaffId', activity.actor_staff_id,
        'actorName', actor.full_name,
        'type', activity.activity_type,
        'outcome', activity.outcome,
        'summary', activity.summary,
        'occurredAt', activity.occurred_at,
        'nextActionType', activity.next_action_type,
        'nextActionAt', activity.next_action_at,
        'demo', coalesce((activity.metadata ->> 'demo')::boolean, false)
      ) order by activity.occurred_at desc)
      from sales_core.activities activity
      left join sales_core.opportunities opportunity
        on opportunity.id = activity.opportunity_id
      join sales_core.contacts contact on contact.id = activity.contact_id
      left join people.staff_profiles actor on actor.id = activity.actor_staff_id
      where activity.tenant_id = v_tenant.id
        and (
          v_view_team
          or activity.actor_staff_id = v_staff_id
          or opportunity.owner_staff_id = v_staff_id
          or contact.owner_staff_id = v_staff_id
        )
      limit 100
    ), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', task.id,
        'taskKey', task.task_key,
        'title', task.title,
        'description', task.description,
        'status', task.status,
        'priority', task.priority,
        'assignedStaffId', task.assigned_staff_id,
        'assigneeName', assignee.full_name,
        'contactId', task.contact_id,
        'contactName', contact.full_name,
        'opportunityId', task.opportunity_id,
        'opportunityTitle', opportunity.title,
        'startsAt', task.starts_at,
        'dueAt', task.due_at,
        'completedAt', task.completed_at,
        'completionTiming', task.completion_timing,
        'demo', coalesce((task.metadata ->> 'demo')::boolean, false),
        'createdAt', task.created_at
      ) order by task.due_at)
      from work_core.tasks task
      left join people.staff_profiles assignee
        on assignee.id = task.assigned_staff_id
      left join sales_core.contacts contact on contact.id = task.contact_id
      left join sales_core.opportunities opportunity
        on opportunity.id = task.opportunity_id
      where task.tenant_id = v_tenant.id
        and (
          v_view_team
          or task.assigned_staff_id = v_staff_id
          or task.created_by_subject_id = v_subject_id
        )
    ), '[]'::jsonb),
    'leaderboard', case
      when v_view_team then coalesce((
        select jsonb_agg(jsonb_build_object(
          'staffId', sp.id,
          'name', sp.full_name,
          'roleKey', sp.role_key,
          'openOpportunities', (
            select count(*)
            from sales_core.opportunities o
            where o.tenant_id = v_tenant.id
              and o.owner_staff_id = sp.id
              and o.status = 'open'
          ),
          'activitiesToday', (
            select count(*)
            from sales_core.activities a
            where a.tenant_id = v_tenant.id
              and a.actor_staff_id = sp.id
              and (
                a.occurred_at at time zone v_tenant.timezone
              )::date = v_today
          ),
          'wonThisMonth', (
            select count(*)
            from sales_core.opportunities o
            where o.tenant_id = v_tenant.id
              and o.owner_staff_id = sp.id
              and o.status = 'won'
              and date_trunc(
                'month',
                o.updated_at at time zone v_tenant.timezone
              ) = date_trunc(
                'month',
                now() at time zone v_tenant.timezone
              )
          ),
          'overdueTasks', (
            select count(*)
            from work_core.tasks task
            where task.tenant_id = v_tenant.id
              and task.assigned_staff_id = sp.id
              and task.status in ('todo', 'in_progress')
              and task.due_at < now()
          )
        ) order by sp.full_name)
        from people.staff_profiles sp
        where sp.tenant_id = v_tenant.id
          and sp.employment_status = 'active'
          and sp.role_key in (
            'sales_user',
            'sales_supervisor',
            'sales_manager'
          )
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
end;
$$;

create or replace function public.v2_tenant_create_contact(
  p_tenant_slug text,
  p_full_name text,
  p_phone text default null,
  p_whatsapp text default null,
  p_email text default null,
  p_organization_name text default null,
  p_source text default 'manual',
  p_owner_staff_id uuid default null,
  p_interest_course_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_contact_id uuid;
  v_owner_staff_id uuid;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_email text;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;
  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'full_name_required';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  v_owner_staff_id := coalesce(p_owner_staff_id, v_current_staff_id);
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');

  if not v_view_team then
    if v_current_staff_id is null then raise exception 'staff_account_not_linked'; end if;
    v_owner_staff_id := v_current_staff_id;
  end if;
  if v_owner_staff_id is not null and not exists (
    select 1 from people.staff_profiles sp
    where sp.id = v_owner_staff_id
      and sp.tenant_id = v_tenant_id
      and sp.employment_status = 'active'
  ) then raise exception 'invalid_owner'; end if;
  if p_interest_course_id is not null and not exists (
    select 1 from academy.courses c
    where c.id = p_interest_course_id
      and c.tenant_id = v_tenant_id
  ) then raise exception 'invalid_course'; end if;
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;

  insert into sales_core.contacts (
    tenant_id,
    full_name,
    organization_name,
    phone,
    whatsapp,
    email,
    source,
    owner_staff_id,
    interest_course_id,
    notes,
    created_by_subject_id
  )
  values (
    v_tenant_id,
    trim(p_full_name),
    nullif(trim(coalesce(p_organization_name, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_whatsapp, '')), ''),
    v_email,
    coalesce(nullif(trim(p_source), ''), 'manual'),
    v_owner_staff_id,
    p_interest_course_id,
    nullif(trim(coalesce(p_notes, '')), ''),
    private_app.current_subject_id()
  )
  returning id into v_contact_id;

  perform private_app.write_audit(
    'tenant.crm_contact_created',
    'sales_contact',
    v_contact_id::text,
    v_tenant_id,
    jsonb_build_object('name', trim(p_full_name))
  );

  return jsonb_build_object('id', v_contact_id, 'name', trim(p_full_name));
end;
$$;

create or replace function public.v2_tenant_create_opportunity(
  p_tenant_slug text,
  p_contact_id uuid,
  p_title text,
  p_stage_id uuid,
  p_value_minor bigint default 0,
  p_course_id uuid default null,
  p_owner_staff_id uuid default null,
  p_expected_close_date date default null,
  p_next_action_type text default null,
  p_next_action_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_opportunity_id uuid;
  v_task_id uuid;
  v_owner_staff_id uuid;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_contact sales_core.contacts%rowtype;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;
  if p_title is null or length(trim(p_title)) < 2 then
    raise exception 'title_required';
  end if;
  if p_next_action_type is null or p_next_action_at is null then
    raise exception 'next_action_required';
  end if;
  if coalesce(p_value_minor, 0) < 0 then raise exception 'invalid_value'; end if;

  select * into v_contact
  from sales_core.contacts c
  where c.id = p_contact_id
    and c.tenant_id = v_tenant_id;
  if v_contact.id is null then raise exception 'invalid_contact'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  v_owner_staff_id := coalesce(
    p_owner_staff_id,
    v_contact.owner_staff_id,
    v_current_staff_id
  );

  if not v_view_team then
    if v_current_staff_id is null then raise exception 'staff_account_not_linked'; end if;
    if v_contact.owner_staff_id is distinct from v_current_staff_id then
      raise exception 'forbidden';
    end if;
    v_owner_staff_id := v_current_staff_id;
  end if;
  if not exists (
    select 1 from sales_core.pipeline_stages stage
    where stage.id = p_stage_id
      and stage.tenant_id = v_tenant_id
      and not stage.is_closed
  ) then raise exception 'invalid_stage'; end if;
  if v_owner_staff_id is not null and not exists (
    select 1 from people.staff_profiles sp
    where sp.id = v_owner_staff_id
      and sp.tenant_id = v_tenant_id
      and sp.employment_status = 'active'
  ) then raise exception 'invalid_owner'; end if;
  if p_course_id is not null and not exists (
    select 1 from academy.courses c
    where c.id = p_course_id
      and c.tenant_id = v_tenant_id
  ) then raise exception 'invalid_course'; end if;

  insert into sales_core.opportunities (
    tenant_id,
    contact_id,
    course_id,
    stage_id,
    owner_staff_id,
    title,
    value_minor,
    expected_close_date,
    next_action_type,
    next_action_at,
    created_by_subject_id
  )
  values (
    v_tenant_id,
    p_contact_id,
    p_course_id,
    p_stage_id,
    v_owner_staff_id,
    trim(p_title),
    coalesce(p_value_minor, 0),
    p_expected_close_date,
    p_next_action_type,
    p_next_action_at,
    private_app.current_subject_id()
  )
  returning id into v_opportunity_id;

  insert into work_core.tasks (
    tenant_id,
    title,
    description,
    assigned_staff_id,
    created_by_subject_id,
    contact_id,
    opportunity_id,
    due_at,
    metadata
  )
  values (
    v_tenant_id,
    'متابعة: ' || trim(p_title),
    'الإجراء التالي: ' || p_next_action_type,
    v_owner_staff_id,
    private_app.current_subject_id(),
    p_contact_id,
    v_opportunity_id,
    p_next_action_at,
    jsonb_build_object('source', 'opportunity_next_action')
  )
  returning id into v_task_id;

  update sales_core.contacts
  set owner_staff_id = coalesce(owner_staff_id, v_owner_staff_id),
      status = 'active'
  where id = p_contact_id;

  perform private_app.write_audit(
    'tenant.crm_opportunity_created',
    'sales_opportunity',
    v_opportunity_id::text,
    v_tenant_id,
    jsonb_build_object('title', trim(p_title), 'taskId', v_task_id)
  );

  return jsonb_build_object(
    'id', v_opportunity_id,
    'taskId', v_task_id,
    'title', trim(p_title)
  );
end;
$$;

create or replace function public.v2_tenant_move_opportunity(
  p_tenant_slug text,
  p_opportunity_id uuid,
  p_stage_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_opportunity sales_core.opportunities%rowtype;
  v_stage sales_core.pipeline_stages%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_status text;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;

  select * into v_opportunity
  from sales_core.opportunities o
  where o.id = p_opportunity_id
    and o.tenant_id = v_tenant_id
  for update;
  if v_opportunity.id is null then raise exception 'opportunity_not_found'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_opportunity.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  select * into v_stage
  from sales_core.pipeline_stages stage
  where stage.id = p_stage_id
    and stage.tenant_id = v_tenant_id;
  if v_stage.id is null then raise exception 'invalid_stage'; end if;

  v_status := case
    when not v_stage.is_closed then 'open'
    when v_stage.is_won then 'won'
    else 'lost'
  end;

  update sales_core.opportunities
  set stage_id = p_stage_id,
      status = v_status,
      next_action_type = case when v_stage.is_closed then null else next_action_type end,
      next_action_at = case when v_stage.is_closed then null else next_action_at end
  where id = p_opportunity_id;

  if v_stage.is_closed then
    update work_core.tasks
    set status = 'cancelled'
    where opportunity_id = p_opportunity_id
      and status in ('todo', 'in_progress');
  end if;

  perform private_app.write_audit(
    'tenant.crm_opportunity_moved',
    'sales_opportunity',
    p_opportunity_id::text,
    v_tenant_id,
    jsonb_build_object('stageKey', v_stage.stage_key, 'status', v_status)
  );

  return jsonb_build_object(
    'id', p_opportunity_id,
    'stageId', p_stage_id,
    'status', v_status
  );
end;
$$;

create or replace function public.v2_tenant_log_activity(
  p_tenant_slug text,
  p_opportunity_id uuid,
  p_activity_type text,
  p_summary text,
  p_outcome text default null,
  p_occurred_at timestamptz default now(),
  p_next_action_type text default null,
  p_next_action_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_opportunity sales_core.opportunities%rowtype;
  v_activity_id uuid;
  v_task_id uuid;
  v_current_staff_id uuid;
  v_view_team boolean;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;
  if p_activity_type not in (
    'call', 'meeting', 'whatsapp', 'email', 'offer', 'note'
  ) then raise exception 'invalid_activity_type'; end if;
  if p_summary is null or length(trim(p_summary)) < 2 then
    raise exception 'summary_required';
  end if;
  if p_activity_type <> 'note'
     and (p_next_action_type is null or p_next_action_at is null) then
    raise exception 'next_action_required';
  end if;

  select * into v_opportunity
  from sales_core.opportunities o
  where o.id = p_opportunity_id
    and o.tenant_id = v_tenant_id
    and o.status = 'open'
  for update;
  if v_opportunity.id is null then raise exception 'opportunity_not_found'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_opportunity.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  insert into sales_core.activities (
    tenant_id,
    opportunity_id,
    contact_id,
    actor_staff_id,
    activity_type,
    outcome,
    summary,
    occurred_at,
    next_action_type,
    next_action_at,
    created_by_subject_id
  )
  values (
    v_tenant_id,
    p_opportunity_id,
    v_opportunity.contact_id,
    coalesce(v_current_staff_id, v_opportunity.owner_staff_id),
    p_activity_type,
    nullif(trim(coalesce(p_outcome, '')), ''),
    trim(p_summary),
    coalesce(p_occurred_at, now()),
    p_next_action_type,
    p_next_action_at,
    private_app.current_subject_id()
  )
  returning id into v_activity_id;

  if p_activity_type <> 'note' then
    update work_core.tasks
    set status = 'cancelled'
    where opportunity_id = p_opportunity_id
      and status in ('todo', 'in_progress');

    insert into work_core.tasks (
      tenant_id,
      title,
      description,
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
      'متابعة: ' || v_opportunity.title,
      'الإجراء التالي: ' || p_next_action_type,
      v_opportunity.owner_staff_id,
      private_app.current_subject_id(),
      v_opportunity.contact_id,
      p_opportunity_id,
      v_activity_id,
      p_next_action_at,
      jsonb_build_object('source', 'activity_next_action')
    )
    returning id into v_task_id;

    update sales_core.opportunities
    set next_action_type = p_next_action_type,
        next_action_at = p_next_action_at
    where id = p_opportunity_id;
  end if;

  perform private_app.write_audit(
    'tenant.crm_activity_logged',
    'sales_activity',
    v_activity_id::text,
    v_tenant_id,
    jsonb_build_object(
      'opportunityId', p_opportunity_id,
      'type', p_activity_type,
      'taskId', v_task_id
    )
  );

  return jsonb_build_object('id', v_activity_id, 'taskId', v_task_id);
end;
$$;

create or replace function public.v2_tenant_create_task(
  p_tenant_slug text,
  p_title text,
  p_description text default null,
  p_assigned_staff_id uuid default null,
  p_due_at timestamptz default null,
  p_priority text default 'normal',
  p_opportunity_id uuid default null,
  p_contact_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_task_id uuid;
  v_current_staff_id uuid;
  v_assigned_staff_id uuid;
  v_view_team boolean;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.work.write'
  ) then raise exception 'forbidden'; end if;
  if p_title is null or length(trim(p_title)) < 2 then
    raise exception 'title_required';
  end if;
  if p_due_at is null then raise exception 'due_at_required'; end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'invalid_priority';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  v_assigned_staff_id := coalesce(p_assigned_staff_id, v_current_staff_id);
  if not v_view_team then
    if v_current_staff_id is null then raise exception 'staff_account_not_linked'; end if;
    v_assigned_staff_id := v_current_staff_id;
  end if;
  if v_assigned_staff_id is not null and not exists (
    select 1 from people.staff_profiles sp
    where sp.id = v_assigned_staff_id
      and sp.tenant_id = v_tenant_id
      and sp.employment_status = 'active'
  ) then raise exception 'invalid_assignee'; end if;
  if p_opportunity_id is not null and not exists (
    select 1 from sales_core.opportunities o
    where o.id = p_opportunity_id
      and o.tenant_id = v_tenant_id
  ) then raise exception 'invalid_opportunity'; end if;
  if p_contact_id is not null and not exists (
    select 1 from sales_core.contacts c
    where c.id = p_contact_id
      and c.tenant_id = v_tenant_id
  ) then raise exception 'invalid_contact'; end if;

  insert into work_core.tasks (
    tenant_id,
    title,
    description,
    priority,
    assigned_staff_id,
    created_by_subject_id,
    opportunity_id,
    contact_id,
    due_at
  )
  values (
    v_tenant_id,
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    p_priority,
    v_assigned_staff_id,
    private_app.current_subject_id(),
    p_opportunity_id,
    p_contact_id,
    p_due_at
  )
  returning id into v_task_id;

  perform private_app.write_audit(
    'tenant.work_task_created',
    'work_task',
    v_task_id::text,
    v_tenant_id,
    jsonb_build_object('title', trim(p_title))
  );

  return jsonb_build_object('id', v_task_id, 'title', trim(p_title));
end;
$$;

create or replace function public.v2_tenant_update_task_status(
  p_tenant_slug text,
  p_task_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_task work_core.tasks%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_completed_at timestamptz;
  v_completion_timing text;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.work.write'
  ) then raise exception 'forbidden'; end if;
  if p_status not in ('todo', 'in_progress', 'completed', 'cancelled') then
    raise exception 'invalid_task_status';
  end if;

  select * into v_task
  from work_core.tasks task
  where task.id = p_task_id
    and task.tenant_id = v_tenant_id
  for update;
  if v_task.id is null then raise exception 'task_not_found'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_task.assigned_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  if p_status = 'completed' then
    v_completed_at := now();
    v_completion_timing := case
      when now() <= v_task.due_at then 'on_time'
      else 'late'
    end;
  else
    v_completed_at := null;
    v_completion_timing := null;
  end if;

  update work_core.tasks
  set status = p_status,
      completed_at = v_completed_at,
      completion_timing = v_completion_timing
  where id = p_task_id;

  perform private_app.write_audit(
    'tenant.work_task_status_updated',
    'work_task',
    p_task_id::text,
    v_tenant_id,
    jsonb_build_object(
      'status', p_status,
      'completionTiming', v_completion_timing
    )
  );

  return jsonb_build_object(
    'id', p_task_id,
    'status', p_status,
    'completionTiming', v_completion_timing
  );
end;
$$;

revoke execute on function public.v2_tenant_operations_snapshot(text)
from public, anon;
revoke execute on function public.v2_tenant_create_contact(
  text, text, text, text, text, text, text, uuid, uuid, text
) from public, anon;
revoke execute on function public.v2_tenant_create_opportunity(
  text, uuid, text, uuid, bigint, uuid, uuid, date, text, timestamptz
) from public, anon;
revoke execute on function public.v2_tenant_move_opportunity(
  text, uuid, uuid
) from public, anon;
revoke execute on function public.v2_tenant_log_activity(
  text, uuid, text, text, text, timestamptz, text, timestamptz
) from public, anon;
revoke execute on function public.v2_tenant_create_task(
  text, text, text, uuid, timestamptz, text, uuid, uuid
) from public, anon;
revoke execute on function public.v2_tenant_update_task_status(
  text, uuid, text
) from public, anon;

grant execute on function public.v2_tenant_operations_snapshot(text)
to authenticated;
grant execute on function public.v2_tenant_create_contact(
  text, text, text, text, text, text, text, uuid, uuid, text
) to authenticated;
grant execute on function public.v2_tenant_create_opportunity(
  text, uuid, text, uuid, bigint, uuid, uuid, date, text, timestamptz
) to authenticated;
grant execute on function public.v2_tenant_move_opportunity(
  text, uuid, uuid
) to authenticated;
grant execute on function public.v2_tenant_log_activity(
  text, uuid, text, text, text, timestamptz, text, timestamptz
) to authenticated;
grant execute on function public.v2_tenant_create_task(
  text, text, text, uuid, timestamptz, text, uuid, uuid
) to authenticated;
grant execute on function public.v2_tenant_update_task_status(
  text, uuid, text
) to authenticated;

do $$
declare
  v_tenant_id uuid;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = 'reef-skills'
  limit 1;

  if v_tenant_id is null then
    return;
  end if;

  insert into sales_core.contacts (
    tenant_id,
    contact_key,
    full_name,
    organization_name,
    phone,
    source,
    owner_staff_id,
    interest_course_id,
    notes,
    metadata,
    created_at
  )
  select
    v_tenant_id,
    seed.contact_key,
    seed.full_name,
    seed.organization_name,
    seed.phone,
    seed.source,
    staff.id,
    course.id,
    'بيانات تشغيلية تجريبية للمعاينة',
    jsonb_build_object('demo', true, 'demoSet', 'reef-operations-v1'),
    now() - seed.age
  from (
    values
      ('reef-demo-001', 'سعود القحطاني', 'شركة آفاق الأعمال', '0500000101', 'meta', 'REEF-SALES-001', 'PMP', interval '11 days'),
      ('reef-demo-002', 'نورة الشهري', 'مؤسسة إتقان', '0500000102', 'google', 'REEF-SALES-002', 'POWER-BI', interval '10 days'),
      ('reef-demo-003', 'عبدالعزيز الحربي', null, '0500000103', 'website', 'REEF-SALES-003', 'AI-SKILLS', interval '9 days'),
      ('reef-demo-004', 'ريم العتيبي', 'مجموعة الريادة', '0500000104', 'whatsapp', 'REEF-SALES-004', 'KPI', interval '8 days'),
      ('reef-demo-005', 'خالد الدوسري', null, '0500000105', 'meta', 'REEF-SALES-005', 'PMP', interval '7 days'),
      ('reef-demo-006', 'الجوهرة المطيري', 'شركة مدار', '0500000106', 'referral', 'REEF-SALES-006', 'EXCEL-ADV', interval '6 days'),
      ('reef-demo-007', 'محمد السبيعي', null, '0500000107', 'tiktok', 'REEF-SALES-007', 'AI-SKILLS', interval '5 days'),
      ('reef-demo-008', 'أروى الزهراني', 'مؤسسة نماء', '0500000108', 'google', 'REEF-SALES-001', 'APHRI', interval '4 days'),
      ('reef-demo-009', 'فيصل الغامدي', null, '0500000109', 'website', 'REEF-SALES-002', 'PMP', interval '3 days'),
      ('reef-demo-010', 'سارة القحطاني', 'شركة بوصلة', '0500000110', 'meta', 'REEF-SALES-003', 'POWER-BI', interval '2 days'),
      ('reef-demo-011', 'تركي الشهراني', null, '0500000111', 'whatsapp', 'REEF-SALES-004', 'KPI', interval '1 day'),
      ('reef-demo-012', 'دانا الحربي', 'أكاديمية خطوة', '0500000112', 'referral', 'REEF-SALES-005', 'AI-SKILLS', interval '12 hours')
  ) as seed(
    contact_key,
    full_name,
    organization_name,
    phone,
    source,
    employee_code,
    course_code,
    age
  )
  join people.staff_profiles staff
    on staff.tenant_id = v_tenant_id
   and staff.employee_code = seed.employee_code
  join academy.courses course
    on course.tenant_id = v_tenant_id
   and course.course_code = seed.course_code
  on conflict (tenant_id, contact_key) do nothing;

  insert into sales_core.opportunities (
    tenant_id,
    opportunity_key,
    contact_id,
    course_id,
    stage_id,
    owner_staff_id,
    title,
    value_minor,
    expected_close_date,
    next_action_type,
    next_action_at,
    status,
    metadata,
    created_at
  )
  select
    v_tenant_id,
    seed.opportunity_key,
    contact.id,
    contact.interest_course_id,
    stage.id,
    contact.owner_staff_id,
    seed.title,
    seed.value_minor,
    current_date + seed.close_after,
    case when stage.is_closed then null else seed.next_action_type end,
    case when stage.is_closed then null else now() + seed.next_after end,
    case
      when not stage.is_closed then 'open'
      when stage.is_won then 'won'
      else 'lost'
    end,
    jsonb_build_object('demo', true, 'demoSet', 'reef-operations-v1'),
    contact.created_at + interval '2 hours'
  from (
    values
      ('reef-demo-opp-001', 'reef-demo-001', 'الاشتراك في برنامج PMP', 'proposal', 69900::bigint, 4, 'call', interval '-2 hours'),
      ('reef-demo-opp-002', 'reef-demo-002', 'تدريب فريق على Power BI', 'qualified', 349500::bigint, 8, 'meeting', interval '3 hours'),
      ('reef-demo-opp-003', 'reef-demo-003', 'دورة مهارات الذكاء الاصطناعي', 'contacted', 69900::bigint, 6, 'whatsapp', interval '1 day'),
      ('reef-demo-opp-004', 'reef-demo-004', 'برنامج مؤشرات الأداء KPI', 'proposal', 139800::bigint, 5, 'offer', interval '5 hours'),
      ('reef-demo-opp-005', 'reef-demo-005', 'التحضير لشهادة PMP', 'new_lead', 69900::bigint, 10, 'call', interval '2 hours'),
      ('reef-demo-opp-006', 'reef-demo-006', 'Excel المتقدم لموظفي الشركة', 'qualified', 279600::bigint, 9, 'meeting', interval '2 days'),
      ('reef-demo-opp-007', 'reef-demo-007', 'برنامج AI للإنتاجية', 'contacted', 69900::bigint, 7, 'whatsapp', interval '-1 day'),
      ('reef-demo-opp-008', 'reef-demo-008', 'التأهيل لشهادة aPHRi', 'won', 69900::bigint, 0, null, interval '0'),
      ('reef-demo-opp-009', 'reef-demo-009', 'الاشتراك في PMP', 'won', 69900::bigint, 0, null, interval '0'),
      ('reef-demo-opp-010', 'reef-demo-010', 'تحليل البيانات باستخدام Power BI', 'proposal', 69900::bigint, 3, 'call', interval '8 hours'),
      ('reef-demo-opp-011', 'reef-demo-011', 'برنامج KPI للأفراد', 'lost', 69900::bigint, 0, null, interval '0'),
      ('reef-demo-opp-012', 'reef-demo-012', 'حلول الذكاء الاصطناعي للعمل', 'new_lead', 69900::bigint, 12, 'call', interval '1 day')
  ) as seed(
    opportunity_key,
    contact_key,
    title,
    stage_key,
    value_minor,
    close_after,
    next_action_type,
    next_after
  )
  join sales_core.contacts contact
    on contact.tenant_id = v_tenant_id
   and contact.contact_key = seed.contact_key
  join sales_core.pipeline_stages stage
    on stage.tenant_id = v_tenant_id
   and stage.stage_key = seed.stage_key
  on conflict (tenant_id, opportunity_key) do nothing;

  insert into sales_core.activities (
    tenant_id,
    activity_key,
    opportunity_id,
    contact_id,
    actor_staff_id,
    activity_type,
    outcome,
    summary,
    occurred_at,
    next_action_type,
    next_action_at,
    metadata
  )
  select
    v_tenant_id,
    'reef-demo-activity-' || lpad(seed.sequence::text, 3, '0'),
    opportunity.id,
    opportunity.contact_id,
    opportunity.owner_staff_id,
    seed.activity_type,
    seed.outcome,
    seed.summary,
    now() - seed.occurred_before,
    seed.next_action_type,
    opportunity.next_action_at,
    jsonb_build_object('demo', true, 'demoSet', 'reef-operations-v1')
  from (
    values
      (1, 'reef-demo-opp-001', 'call', 'مهتم ويحتاج موافقة الإدارة', 'تم شرح محتوى البرنامج والاعتماد', interval '1 day', 'call'),
      (2, 'reef-demo-opp-002', 'meeting', 'طلب عرضًا لمجموعة موظفين', 'اجتماع احتياج أولي مع مسؤول الموارد البشرية', interval '1 day', 'meeting'),
      (3, 'reef-demo-opp-003', 'whatsapp', 'تم إرسال التفاصيل', 'إرسال ملف الدورة والمواعيد المقترحة', interval '12 hours', 'whatsapp'),
      (4, 'reef-demo-opp-004', 'offer', 'العرض قيد المراجعة', 'إرسال العرض التدريبي والمالي', interval '8 hours', 'offer'),
      (5, 'reef-demo-opp-006', 'meeting', 'طلب تخصيص المحتوى', 'تحديد مستوى الفريق والموضوعات المطلوبة', interval '2 days', 'meeting'),
      (6, 'reef-demo-opp-007', 'call', 'لم يرد', 'محاولة اتصال أولى دون رد', interval '2 days', 'whatsapp'),
      (7, 'reef-demo-opp-008', 'note', 'تم التسجيل', 'تأكيد التسجيل وإرسال تعليمات البداية', interval '3 days', null::text),
      (8, 'reef-demo-opp-010', 'whatsapp', 'مهتم بالسعر الجماعي', 'إرسال تفاصيل خصم المجموعة', interval '4 hours', 'call')
  ) as seed(
    sequence,
    opportunity_key,
    activity_type,
    outcome,
    summary,
    occurred_before,
    next_action_type
  )
  join sales_core.opportunities opportunity
    on opportunity.tenant_id = v_tenant_id
   and opportunity.opportunity_key = seed.opportunity_key
  on conflict (tenant_id, activity_key) do nothing;

  insert into work_core.tasks (
    tenant_id,
    task_key,
    title,
    description,
    priority,
    assigned_staff_id,
    contact_id,
    opportunity_id,
    due_at,
    metadata
  )
  select
    v_tenant_id,
    'reef-demo-task-' || right(opportunity.opportunity_key, 3),
    'متابعة: ' || opportunity.title,
    'مهمة تجريبية ناتجة عن الإجراء التالي للفرصة',
    case
      when opportunity.next_action_at < now() then 'urgent'
      when opportunity.next_action_at::date = current_date then 'high'
      else 'normal'
    end,
    opportunity.owner_staff_id,
    opportunity.contact_id,
    opportunity.id,
    opportunity.next_action_at,
    jsonb_build_object('demo', true, 'demoSet', 'reef-operations-v1')
  from sales_core.opportunities opportunity
  where opportunity.tenant_id = v_tenant_id
    and opportunity.opportunity_key like 'reef-demo-opp-%'
    and opportunity.status = 'open'
  on conflict (tenant_id, task_key) do nothing;
end;
$$;

comment on schema sales_core is
'Clean v2 tenant CRM: contacts, pipeline, opportunities and activities.';
comment on schema work_core is
'Clean v2 tenant work management linked to CRM and staff profiles.';

commit;
