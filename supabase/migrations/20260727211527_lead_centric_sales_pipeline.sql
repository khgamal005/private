begin;

alter table sales_core.contacts
  add column lead_status text not null default 'new',
  add column lead_quality text not null default 'unrated',
  add column next_action_type text,
  add column next_action_at timestamptz,
  add column last_activity_at timestamptz,
  add column campaign_name text,
  add column ad_name text;

alter table sales_core.contacts
  add constraint contacts_lead_status_check
    check (lead_status in (
      'new',
      'no_answer',
      'busy',
      'follow_up',
      'interested',
      'very_interested',
      'awaiting_payment',
      'paid',
      'postponed',
      'not_interested',
      'unqualified',
      'wrong_number',
      'duplicate',
      'cancelled'
    )),
  add constraint contacts_lead_quality_check
    check (lead_quality in (
      'unrated',
      'unqualified',
      'weak',
      'qualified',
      'good',
      'excellent'
    )),
  add constraint contacts_next_action_pair_check
    check (num_nonnulls(next_action_type, next_action_at) in (0, 2));

alter table sales_core.activities
  add column result_status text,
  add column result_quality text;

alter table sales_core.activities
  add constraint activities_result_status_check
    check (
      result_status is null
      or result_status in (
        'new',
        'no_answer',
        'busy',
        'follow_up',
        'interested',
        'very_interested',
        'awaiting_payment',
        'paid',
        'postponed',
        'not_interested',
        'unqualified',
        'wrong_number',
        'duplicate',
        'cancelled'
      )
    ),
  add constraint activities_result_quality_check
    check (
      result_quality is null
      or result_quality in (
        'unrated',
        'unqualified',
        'weak',
        'qualified',
        'good',
        'excellent'
      )
    );

alter table sales_core.activities
  drop constraint activities_check;

alter table sales_core.activities
  add constraint activities_next_action_pair_check
    check (num_nonnulls(next_action_type, next_action_at) in (0, 2));

create index sales_contacts_tenant_lead_status_idx
on sales_core.contacts (tenant_id, lead_status, owner_staff_id);

create index sales_contacts_tenant_lead_quality_idx
on sales_core.contacts (tenant_id, lead_quality, source);

create index sales_contacts_tenant_next_action_idx
on sales_core.contacts (tenant_id, next_action_at)
where next_action_at is not null;

create table academy.registration_handoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  handoff_key text not null,
  contact_id uuid not null
    references sales_core.contacts(id) on delete cascade,
  opportunity_id uuid
    references sales_core.opportunities(id) on delete set null,
  course_id uuid not null
    references academy.courses(id) on delete restrict,
  course_run_id uuid
    references academy.course_runs(id) on delete set null,
  assigned_department_id uuid
    references people.departments(id) on delete set null,
  assigned_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  status text not null default 'pending'
    check (status in (
      'pending',
      'in_review',
      'accepted',
      'rejected',
      'completed',
      'cancelled'
    )),
  paid_at timestamptz not null default now(),
  payment_amount_minor bigint
    check (payment_amount_minor is null or payment_amount_minor >= 0),
  payment_reference text,
  preferred_start_date date,
  notes text,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, handoff_key)
);

create index registration_handoffs_tenant_status_idx
on academy.registration_handoffs (tenant_id, status, created_at desc);

create index registration_handoffs_contact_reference_idx
on academy.registration_handoffs (contact_id);

create index registration_handoffs_opportunity_reference_idx
on academy.registration_handoffs (opportunity_id);

create index registration_handoffs_course_reference_idx
on academy.registration_handoffs (course_id);

create index registration_handoffs_course_run_reference_idx
on academy.registration_handoffs (course_run_id);

create index registration_handoffs_department_reference_idx
on academy.registration_handoffs (assigned_department_id);

create index registration_handoffs_staff_reference_idx
on academy.registration_handoffs (assigned_staff_id);

create index registration_handoffs_creator_reference_idx
on academy.registration_handoffs (created_by_subject_id);

create trigger registration_handoffs_set_updated_at
before update on academy.registration_handoffs
for each row execute function private_app.set_updated_at();

alter table academy.registration_handoffs enable row level security;

create policy registration_handoffs_isolated_read
on academy.registration_handoffs
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table academy.registration_handoffs
from public, anon, authenticated;

insert into people.departments (
  tenant_id,
  department_key,
  name_ar,
  name_en
)
select
  tenant.id,
  'admissions',
  'التسجيل والقبول',
  'Admissions'
from core.tenants tenant
on conflict (tenant_id, department_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    status = 'active';

with latest_case as (
  select distinct on (opportunity.contact_id)
    opportunity.contact_id,
    opportunity.next_action_type,
    opportunity.next_action_at,
    opportunity.updated_at,
    stage.stage_key
  from sales_core.opportunities opportunity
  join sales_core.pipeline_stages stage on stage.id = opportunity.stage_id
  order by opportunity.contact_id, opportunity.created_at desc
),
latest_activity as (
  select
    activity.contact_id,
    max(activity.occurred_at) as occurred_at
  from sales_core.activities activity
  group by activity.contact_id
)
update sales_core.contacts contact
set lead_status = case latest_case.stage_key
      when 'won' then 'paid'
      when 'lost' then 'not_interested'
      when 'proposal' then 'awaiting_payment'
      when 'qualified' then 'very_interested'
      when 'contacted' then 'interested'
      else 'new'
    end,
    lead_quality = case latest_case.stage_key
      when 'won' then 'excellent'
      when 'proposal' then 'good'
      when 'qualified' then 'qualified'
      when 'contacted' then 'weak'
      when 'lost' then 'unqualified'
      else 'unrated'
    end,
    status = case latest_case.stage_key
      when 'won' then 'converted'
      when 'lost' then 'unqualified'
      else 'active'
    end,
    next_action_type = case
      when latest_case.stage_key in ('won', 'lost') then null
      else latest_case.next_action_type
    end,
    next_action_at = case
      when latest_case.stage_key in ('won', 'lost') then null
      else latest_case.next_action_at
    end,
    last_activity_at = coalesce(
      latest_activity.occurred_at,
      latest_case.updated_at,
      contact.updated_at
    )
from latest_case
left join latest_activity
  on latest_activity.contact_id = latest_case.contact_id
where contact.id = latest_case.contact_id;

update sales_core.activities activity
set result_status = contact.lead_status,
    result_quality = contact.lead_quality
from sales_core.contacts contact
where contact.id = activity.contact_id
  and activity.result_status is null;

update sales_core.contacts
set campaign_name = case source
      when 'meta' then 'حملة التسجيل الصيفية'
      when 'google' then 'بحث البرامج المهنية'
      when 'website' then 'نماذج موقع ريف'
      when 'whatsapp' then 'استفسارات واتساب'
      when 'referral' then 'ترشيحات المتدربين'
      else null
    end,
    ad_name = case
      when source = 'meta' then 'طوّر مسارك المهني'
      when source = 'google' then 'دورات احترافية معتمدة'
      else null
    end
where coalesce((metadata ->> 'demo')::boolean, false);

create or replace function public.v2_tenant_sales_pipeline_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_view_team boolean;
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
    'tenant.crm.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_view_team := private_app.can_view_tenant_team(v_tenant.id);
  v_today := (now() at time zone v_tenant.timezone)::date;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'viewTeam', v_view_team,
      'canWriteCrm', private_app.has_tenant_permission(
        v_tenant.id,
        'tenant.crm.write'
      )
    ),
    'summary', jsonb_build_object(
      'activeLeads', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.lead_status in (
            'new',
            'no_answer',
            'busy',
            'follow_up',
            'interested',
            'very_interested',
            'awaiting_payment',
            'postponed'
          )
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ),
      'awaitingPayment', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.lead_status = 'awaiting_payment'
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ),
      'veryInterested', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.lead_status = 'very_interested'
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ),
      'excellentLeads', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.lead_quality = 'excellent'
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ),
      'unqualifiedLeads', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.lead_quality = 'unqualified'
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ),
      'paidThisMonth', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.lead_status = 'paid'
          and date_trunc(
            'month',
            coalesce(contact.last_activity_at, contact.updated_at)
              at time zone v_tenant.timezone
          ) = date_trunc(
            'month',
            now() at time zone v_tenant.timezone
          )
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ),
      'overdueFollowups', (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.next_action_at < now()
          and contact.lead_status not in (
            'paid',
            'not_interested',
            'unqualified',
            'wrong_number',
            'duplicate',
            'cancelled'
          )
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ),
      'activitiesToday', (
        select count(*)
        from sales_core.activities activity
        join sales_core.contacts contact on contact.id = activity.contact_id
        where activity.tenant_id = v_tenant.id
          and (
            activity.occurred_at at time zone v_tenant.timezone
          )::date = v_today
          and (
            v_view_team
            or activity.actor_staff_id = v_staff_id
            or contact.owner_staff_id = v_staff_id
          )
      )
    ),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', contact.id,
        'contactKey', contact.contact_key,
        'name', contact.full_name,
        'organizationName', contact.organization_name,
        'phone', contact.phone,
        'whatsapp', contact.whatsapp,
        'email', contact.email,
        'source', contact.source,
        'campaignName', contact.campaign_name,
        'adName', contact.ad_name,
        'status', contact.lead_status,
        'leadStatus', contact.lead_status,
        'leadQuality', contact.lead_quality,
        'ownerStaffId', contact.owner_staff_id,
        'ownerName', owner.full_name,
        'interestCourseId', contact.interest_course_id,
        'interestCourseName', course.title_ar,
        'notes', contact.notes,
        'nextActionType', contact.next_action_type,
        'nextActionAt', contact.next_action_at,
        'lastActivityAt', contact.last_activity_at,
        'caseId', sales_case.id,
        'caseTitle', sales_case.title,
        'valueMinor', coalesce(sales_case.value_minor, 0),
        'demo', coalesce((contact.metadata ->> 'demo')::boolean, false),
        'createdAt', contact.created_at,
        'updatedAt', contact.updated_at
      ) order by contact.next_action_at nulls last, contact.created_at desc)
      from sales_core.contacts contact
      left join people.staff_profiles owner
        on owner.id = contact.owner_staff_id
      left join academy.courses course
        on course.id = contact.interest_course_id
      left join lateral (
        select opportunity.*
        from sales_core.opportunities opportunity
        where opportunity.contact_id = contact.id
        order by
          (opportunity.status = 'open') desc,
          opportunity.created_at desc
        limit 1
      ) sales_case on true
      where contact.tenant_id = v_tenant.id
        and (v_view_team or contact.owner_staff_id = v_staff_id)
    ), '[]'::jsonb),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', activity.id,
        'contactId', activity.contact_id,
        'contactName', contact.full_name,
        'contactPhone', contact.phone,
        'actorStaffId', activity.actor_staff_id,
        'actorName', actor.full_name,
        'type', activity.activity_type,
        'outcome', activity.outcome,
        'summary', activity.summary,
        'resultStatus', activity.result_status,
        'resultQuality', activity.result_quality,
        'occurredAt', activity.occurred_at,
        'nextActionType', activity.next_action_type,
        'nextActionAt', activity.next_action_at,
        'demo', coalesce((activity.metadata ->> 'demo')::boolean, false)
      ) order by activity.occurred_at desc)
      from sales_core.activities activity
      join sales_core.contacts contact on contact.id = activity.contact_id
      left join people.staff_profiles actor
        on actor.id = activity.actor_staff_id
      where activity.tenant_id = v_tenant.id
        and (
          v_view_team
          or activity.actor_staff_id = v_staff_id
          or contact.owner_staff_id = v_staff_id
        )
      limit 150
    ), '[]'::jsonb),
    'courseRuns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', run.id,
        'courseId', run.course_id,
        'runCode', run.run_code,
        'title', coalesce(run.title, course.title_ar),
        'startsAt', run.starts_at,
        'endsAt', run.ends_at,
        'status', run.status,
        'capacity', run.capacity,
        'enrolledCount', run.enrolled_count
      ) order by run.starts_at nulls last, run.created_at)
      from academy.course_runs run
      join academy.courses course on course.id = run.course_id
      where run.tenant_id = v_tenant.id
        and run.status in ('planning', 'open', 'in_progress')
    ), '[]'::jsonb),
    'registrationHandoffs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', handoff.id,
        'contactId', handoff.contact_id,
        'contactName', contact.full_name,
        'courseId', handoff.course_id,
        'courseName', course.title_ar,
        'courseRunId', handoff.course_run_id,
        'courseRunName', coalesce(run.title, run.run_code),
        'status', handoff.status,
        'paidAt', handoff.paid_at,
        'amountMinor', handoff.payment_amount_minor,
        'preferredStartDate', handoff.preferred_start_date,
        'assignedStaffName', assignee.full_name,
        'demo', coalesce((handoff.metadata ->> 'demo')::boolean, false)
      ) order by handoff.created_at desc)
      from academy.registration_handoffs handoff
      join sales_core.contacts contact on contact.id = handoff.contact_id
      join academy.courses course on course.id = handoff.course_id
      left join academy.course_runs run on run.id = handoff.course_run_id
      left join people.staff_profiles assignee
        on assignee.id = handoff.assigned_staff_id
      where handoff.tenant_id = v_tenant.id
        and (
          v_view_team
          or contact.owner_staff_id = v_staff_id
          or handoff.assigned_staff_id = v_staff_id
        )
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_create_sales_lead(
  p_tenant_slug text,
  p_full_name text,
  p_phone text default null,
  p_whatsapp text default null,
  p_email text default null,
  p_organization_name text default null,
  p_source text default 'manual',
  p_campaign_name text default null,
  p_ad_name text default null,
  p_owner_staff_id uuid default null,
  p_interest_course_id uuid default null,
  p_lead_quality text default 'unrated',
  p_next_action_type text default 'call',
  p_next_action_at timestamptz default null,
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
  v_opportunity_id uuid;
  v_task_id uuid;
  v_owner_staff_id uuid;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_stage_id uuid;
  v_course academy.courses%rowtype;
  v_email text;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;
  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'full_name_required';
  end if;
  if nullif(trim(coalesce(p_phone, '')), '') is null
     and nullif(trim(coalesce(p_whatsapp, '')), '') is null then
    raise exception 'phone_required';
  end if;
  if p_lead_quality not in (
    'unrated', 'unqualified', 'weak', 'qualified', 'good', 'excellent'
  ) then raise exception 'invalid_lead_quality'; end if;
  if p_next_action_type not in (
    'call', 'whatsapp', 'send_details', 'meeting', 'payment_followup', 'follow_up'
  ) then raise exception 'invalid_next_action'; end if;
  if p_next_action_at is null then raise exception 'next_action_required'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  v_owner_staff_id := coalesce(p_owner_staff_id, v_current_staff_id);
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');

  if not v_view_team then
    if v_current_staff_id is null then
      raise exception 'staff_account_not_linked';
    end if;
    v_owner_staff_id := v_current_staff_id;
  end if;
  if v_owner_staff_id is not null and not exists (
    select 1
    from people.staff_profiles staff
    where staff.id = v_owner_staff_id
      and staff.tenant_id = v_tenant_id
      and staff.employment_status = 'active'
  ) then raise exception 'invalid_owner'; end if;
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;

  if p_interest_course_id is not null then
    select *
    into v_course
    from academy.courses course
    where course.id = p_interest_course_id
      and course.tenant_id = v_tenant_id;
    if v_course.id is null then raise exception 'invalid_course'; end if;
  end if;

  select stage.id
  into v_stage_id
  from sales_core.pipeline_stages stage
  where stage.tenant_id = v_tenant_id
    and stage.stage_key = 'new_lead'
  limit 1;
  if v_stage_id is null then raise exception 'invalid_stage'; end if;

  insert into sales_core.contacts (
    tenant_id,
    full_name,
    organization_name,
    phone,
    whatsapp,
    email,
    source,
    status,
    lead_status,
    lead_quality,
    owner_staff_id,
    interest_course_id,
    campaign_name,
    ad_name,
    next_action_type,
    next_action_at,
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
    coalesce(nullif(trim(coalesce(p_source, '')), ''), 'manual'),
    'new',
    'new',
    p_lead_quality,
    v_owner_staff_id,
    p_interest_course_id,
    nullif(trim(coalesce(p_campaign_name, '')), ''),
    nullif(trim(coalesce(p_ad_name, '')), ''),
    p_next_action_type,
    p_next_action_at,
    nullif(trim(coalesce(p_notes, '')), ''),
    private_app.current_subject_id()
  )
  returning id into v_contact_id;

  insert into sales_core.opportunities (
    tenant_id,
    contact_id,
    course_id,
    stage_id,
    owner_staff_id,
    title,
    value_minor,
    next_action_type,
    next_action_at,
    status,
    created_by_subject_id,
    metadata
  )
  values (
    v_tenant_id,
    v_contact_id,
    p_interest_course_id,
    v_stage_id,
    v_owner_staff_id,
    case
      when v_course.id is null then 'متابعة ' || trim(p_full_name)
      else 'متابعة التسجيل في ' || v_course.title_ar
    end,
    0,
    p_next_action_type,
    p_next_action_at,
    'open',
    private_app.current_subject_id(),
    jsonb_build_object('model', 'lead_centric')
  )
  returning id into v_opportunity_id;

  insert into work_core.tasks (
    tenant_id,
    title,
    description,
    priority,
    assigned_staff_id,
    created_by_subject_id,
    contact_id,
    opportunity_id,
    due_at,
    metadata
  )
  values (
    v_tenant_id,
    'متابعة: ' || trim(p_full_name),
    'الإجراء التالي: ' || p_next_action_type,
    'normal',
    v_owner_staff_id,
    private_app.current_subject_id(),
    v_contact_id,
    v_opportunity_id,
    p_next_action_at,
    jsonb_build_object(
      'source', 'lead_next_action',
      'actionType', p_next_action_type,
      'leadStatus', 'new',
      'leadQuality', p_lead_quality
    )
  )
  returning id into v_task_id;

  perform private_app.write_audit(
    'tenant.sales_lead_created',
    'sales_contact',
    v_contact_id::text,
    v_tenant_id,
    jsonb_build_object(
      'quality', p_lead_quality,
      'taskId', v_task_id,
      'source', p_source
    )
  );

  return jsonb_build_object(
    'id', v_contact_id,
    'taskId', v_task_id,
    'name', trim(p_full_name)
  );
end;
$$;

create or replace function public.v2_tenant_record_sales_followup(
  p_tenant_slug text,
  p_contact_id uuid,
  p_activity_type text,
  p_summary text,
  p_lead_status text,
  p_lead_quality text default 'unrated',
  p_next_action_type text default null,
  p_next_action_at timestamptz default null,
  p_course_id uuid default null,
  p_course_run_id uuid default null,
  p_payment_amount_minor bigint default null,
  p_payment_reference text default null,
  p_preferred_start_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_opportunity sales_core.opportunities%rowtype;
  v_stage sales_core.pipeline_stages%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_is_open boolean;
  v_stage_key text;
  v_case_status text;
  v_contact_status text;
  v_course_id uuid;
  v_course_run academy.course_runs%rowtype;
  v_activity_id uuid;
  v_task_id uuid;
  v_handoff_id uuid;
  v_admissions_department_id uuid;
  v_admissions_staff_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;
  if p_activity_type not in (
    'call', 'meeting', 'whatsapp', 'email', 'note'
  ) then raise exception 'invalid_activity_type'; end if;
  if p_summary is null or length(trim(p_summary)) < 2 then
    raise exception 'summary_required';
  end if;
  if p_lead_status not in (
    'new',
    'no_answer',
    'busy',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'paid',
    'postponed',
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  ) then raise exception 'invalid_lead_status'; end if;
  if p_lead_quality not in (
    'unrated', 'unqualified', 'weak', 'qualified', 'good', 'excellent'
  ) then raise exception 'invalid_lead_quality'; end if;
  if p_payment_amount_minor is not null and p_payment_amount_minor < 0 then
    raise exception 'invalid_value';
  end if;

  v_is_open := p_lead_status in (
    'new',
    'no_answer',
    'busy',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'postponed'
  );

  if v_is_open and (
    p_next_action_type is null
    or p_next_action_at is null
  ) then raise exception 'next_action_required'; end if;
  if v_is_open and p_next_action_type not in (
    'call', 'whatsapp', 'send_details', 'meeting', 'payment_followup', 'follow_up'
  ) then raise exception 'invalid_next_action'; end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;
  if v_contact.id is null then raise exception 'invalid_contact'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  v_course_id := coalesce(p_course_id, v_contact.interest_course_id);
  if v_course_id is not null and not exists (
    select 1
    from academy.courses course
    where course.id = v_course_id
      and course.tenant_id = v_tenant_id
      and course.status <> 'archived'
  ) then raise exception 'invalid_course'; end if;
  if p_lead_status = 'paid' and v_course_id is null then
    raise exception 'course_required_for_payment';
  end if;

  if p_course_run_id is not null then
    select *
    into v_course_run
    from academy.course_runs run
    where run.id = p_course_run_id
      and run.tenant_id = v_tenant_id
      and run.course_id = v_course_id
      and run.status in ('planning', 'open', 'in_progress');
    if v_course_run.id is null then raise exception 'invalid_course_run'; end if;
  end if;

  v_stage_key := case
    when p_lead_status = 'paid' then 'won'
    when p_lead_status in (
      'not_interested', 'unqualified', 'wrong_number', 'duplicate', 'cancelled'
    ) then 'lost'
    when p_lead_status in ('very_interested', 'awaiting_payment') then 'proposal'
    when p_lead_status = 'interested' then 'qualified'
    when p_lead_status in ('no_answer', 'busy', 'follow_up', 'postponed') then 'contacted'
    else 'new_lead'
  end;

  select *
  into v_stage
  from sales_core.pipeline_stages stage
  where stage.tenant_id = v_tenant_id
    and stage.stage_key = v_stage_key
  limit 1;
  if v_stage.id is null then raise exception 'invalid_stage'; end if;

  select *
  into v_opportunity
  from sales_core.opportunities opportunity
  where opportunity.tenant_id = v_tenant_id
    and opportunity.contact_id = p_contact_id
  order by
    (opportunity.status = 'open') desc,
    opportunity.created_at desc
  limit 1
  for update;

  v_case_status := case
    when p_lead_status = 'paid' then 'won'
    when v_is_open then 'open'
    else 'lost'
  end;
  v_contact_status := case
    when p_lead_status = 'paid' then 'converted'
    when v_is_open then 'active'
    when p_lead_status = 'unqualified' then 'unqualified'
    else 'archived'
  end;

  if v_opportunity.id is null then
    insert into sales_core.opportunities (
      tenant_id,
      contact_id,
      course_id,
      stage_id,
      owner_staff_id,
      title,
      value_minor,
      next_action_type,
      next_action_at,
      status,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      p_contact_id,
      v_course_id,
      v_stage.id,
      coalesce(v_contact.owner_staff_id, v_current_staff_id),
      'متابعة ' || v_contact.full_name,
      coalesce(p_payment_amount_minor, 0),
      case when v_is_open then p_next_action_type else null end,
      case when v_is_open then p_next_action_at else null end,
      v_case_status,
      private_app.current_subject_id(),
      jsonb_build_object('model', 'lead_centric')
    )
    returning * into v_opportunity;
  else
    update sales_core.opportunities
    set course_id = coalesce(v_course_id, course_id),
        stage_id = v_stage.id,
        value_minor = coalesce(p_payment_amount_minor, value_minor),
        next_action_type = case when v_is_open then p_next_action_type else null end,
        next_action_at = case when v_is_open then p_next_action_at else null end,
        status = v_case_status,
        lost_reason = case
          when v_case_status = 'lost' then p_lead_status
          else null
        end
    where id = v_opportunity.id
    returning * into v_opportunity;
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
    result_status,
    result_quality,
    created_by_subject_id,
    metadata
  )
  values (
    v_tenant_id,
    v_opportunity.id,
    p_contact_id,
    coalesce(v_current_staff_id, v_contact.owner_staff_id),
    p_activity_type,
    p_lead_status,
    trim(p_summary),
    now(),
    case when v_is_open then p_next_action_type else null end,
    case when v_is_open then p_next_action_at else null end,
    p_lead_status,
    p_lead_quality,
    private_app.current_subject_id(),
    jsonb_build_object('model', 'lead_centric')
  )
  returning id into v_activity_id;

  update work_core.tasks
  set status = 'cancelled'
  where tenant_id = v_tenant_id
    and contact_id = p_contact_id
    and status in ('todo', 'in_progress')
    and coalesce(metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    );

  update sales_core.contacts
  set status = v_contact_status,
      lead_status = p_lead_status,
      lead_quality = p_lead_quality,
      interest_course_id = coalesce(v_course_id, interest_course_id),
      next_action_type = case when v_is_open then p_next_action_type else null end,
      next_action_at = case when v_is_open then p_next_action_at else null end,
      last_activity_at = now()
  where id = p_contact_id;

  if v_is_open then
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
      'متابعة: ' || v_contact.full_name,
      'الحالة: ' || p_lead_status || ' · الإجراء التالي: ' || p_next_action_type,
      case
        when p_lead_status in ('very_interested', 'awaiting_payment') then 'high'
        else 'normal'
      end,
      coalesce(v_contact.owner_staff_id, v_current_staff_id),
      private_app.current_subject_id(),
      p_contact_id,
      v_opportunity.id,
      v_activity_id,
      p_next_action_at,
      jsonb_build_object(
        'source', 'sales_followup',
        'actionType', p_next_action_type,
        'leadStatus', p_lead_status,
        'leadQuality', p_lead_quality
      )
    )
    returning id into v_task_id;
  elsif p_lead_status = 'paid' then
    select department.id
    into v_admissions_department_id
    from people.departments department
    where department.tenant_id = v_tenant_id
      and department.department_key = 'admissions'
    limit 1;

    select staff.id
    into v_admissions_staff_id
    from people.staff_profiles staff
    left join people.departments department
      on department.id = staff.department_id
    where staff.tenant_id = v_tenant_id
      and staff.employment_status = 'active'
      and (
        department.department_key = 'admissions'
        or staff.role_key = 'customer_service'
      )
    order by
      (department.department_key = 'admissions') desc,
      staff.created_at
    limit 1;

    insert into academy.registration_handoffs (
      tenant_id,
      handoff_key,
      contact_id,
      opportunity_id,
      course_id,
      course_run_id,
      assigned_department_id,
      assigned_staff_id,
      status,
      paid_at,
      payment_amount_minor,
      payment_reference,
      preferred_start_date,
      notes,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      'payment-' || v_opportunity.id::text,
      p_contact_id,
      v_opportunity.id,
      v_course_id,
      p_course_run_id,
      v_admissions_department_id,
      v_admissions_staff_id,
      'pending',
      now(),
      p_payment_amount_minor,
      nullif(trim(coalesce(p_payment_reference, '')), ''),
      p_preferred_start_date,
      trim(p_summary),
      private_app.current_subject_id(),
      jsonb_build_object(
        'source', 'sales_payment',
        'notification', true
      )
    )
    on conflict (tenant_id, handoff_key) do update
    set course_id = excluded.course_id,
        course_run_id = excluded.course_run_id,
        assigned_department_id = excluded.assigned_department_id,
        assigned_staff_id = excluded.assigned_staff_id,
        status = 'pending',
        paid_at = excluded.paid_at,
        payment_amount_minor = excluded.payment_amount_minor,
        payment_reference = excluded.payment_reference,
        preferred_start_date = excluded.preferred_start_date,
        notes = excluded.notes,
        metadata = excluded.metadata
    returning id into v_handoff_id;

    insert into work_core.tasks (
      tenant_id,
      task_key,
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
      'registration-' || v_handoff_id::text,
      'تسجيل وقبول: ' || v_contact.full_name,
      case
        when p_course_run_id is null then 'تم الدفع · الدفعة أو موعد البداية لم يحدد بعد'
        else 'تم الدفع · التسجيل في الدفعة المحددة'
      end,
      'urgent',
      v_admissions_staff_id,
      private_app.current_subject_id(),
      p_contact_id,
      v_opportunity.id,
      v_activity_id,
      now(),
      jsonb_build_object(
        'source', 'registration_handoff',
        'handoffId', v_handoff_id,
        'department', 'admissions',
        'notification', true
      )
    )
    on conflict (tenant_id, task_key) do update
    set title = excluded.title,
        description = excluded.description,
        priority = excluded.priority,
        assigned_staff_id = excluded.assigned_staff_id,
        status = 'todo',
        completed_at = null,
        completion_timing = null,
        due_at = excluded.due_at,
        metadata = excluded.metadata
    returning id into v_task_id;
  end if;

  perform private_app.write_audit(
    'tenant.sales_followup_recorded',
    'sales_contact',
    p_contact_id::text,
    v_tenant_id,
    jsonb_build_object(
      'activityId', v_activity_id,
      'status', p_lead_status,
      'quality', p_lead_quality,
      'taskId', v_task_id,
      'handoffId', v_handoff_id
    )
  );

  return jsonb_build_object(
    'id', v_activity_id,
    'contactId', p_contact_id,
    'status', p_lead_status,
    'quality', p_lead_quality,
    'taskId', v_task_id,
    'handoffId', v_handoff_id,
    'registrationNotified', v_handoff_id is not null
  );
end;
$$;

revoke execute on function public.v2_tenant_sales_pipeline_snapshot(text)
from public, anon;
revoke execute on function public.v2_tenant_create_sales_lead(
  text, text, text, text, text, text, text, text, text,
  uuid, uuid, text, text, timestamptz, text
) from public, anon;
revoke execute on function public.v2_tenant_record_sales_followup(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date
) from public, anon;

grant execute on function public.v2_tenant_sales_pipeline_snapshot(text)
to authenticated;
grant execute on function public.v2_tenant_create_sales_lead(
  text, text, text, text, text, text, text, text, text,
  uuid, uuid, text, text, timestamptz, text
) to authenticated;
grant execute on function public.v2_tenant_record_sales_followup(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date
) to authenticated;

do $$
declare
  v_tenant_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = 'reef-skills'
  limit 1;

  if v_tenant_id is null then
    return;
  end if;

  insert into academy.registration_handoffs (
    tenant_id,
    handoff_key,
    contact_id,
    opportunity_id,
    course_id,
    assigned_department_id,
    assigned_staff_id,
    status,
    paid_at,
    payment_amount_minor,
    notes,
    metadata
  )
  select
    v_tenant_id,
    'demo-paid-' || contact.contact_key,
    contact.id,
    opportunity.id,
    opportunity.course_id,
    admissions.id,
    customer_service.id,
    'pending',
    coalesce(contact.last_activity_at, opportunity.updated_at),
    opportunity.value_minor,
    'تنويه تجريبي للتسجيل والقبول بعد تأكيد الدفع',
    jsonb_build_object(
      'demo', true,
      'demoSet', 'reef-lead-pipeline-v2'
    )
  from sales_core.contacts contact
  join sales_core.opportunities opportunity
    on opportunity.contact_id = contact.id
   and opportunity.status = 'won'
  left join people.departments admissions
    on admissions.tenant_id = v_tenant_id
   and admissions.department_key = 'admissions'
  left join lateral (
    select staff.id
    from people.staff_profiles staff
    where staff.tenant_id = v_tenant_id
      and staff.role_key = 'customer_service'
      and staff.employment_status = 'active'
    order by staff.created_at
    limit 1
  ) customer_service on true
  where contact.tenant_id = v_tenant_id
    and coalesce((contact.metadata ->> 'demo')::boolean, false)
  on conflict (tenant_id, handoff_key) do nothing;

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
    'registration-' || handoff.id::text,
    'تسجيل وقبول: ' || contact.full_name,
    'تم الدفع · اختيار الدفعة واستكمال إجراءات القبول',
    'urgent',
    handoff.assigned_staff_id,
    handoff.contact_id,
    handoff.opportunity_id,
    now(),
    jsonb_build_object(
      'source', 'registration_handoff',
      'handoffId', handoff.id,
      'department', 'admissions',
      'notification', true,
      'demo', true,
      'demoSet', 'reef-lead-pipeline-v2'
    )
  from academy.registration_handoffs handoff
  join sales_core.contacts contact on contact.id = handoff.contact_id
  where handoff.tenant_id = v_tenant_id
    and coalesce((handoff.metadata ->> 'demo')::boolean, false)
  on conflict (tenant_id, task_key) do nothing;
end;
$$;

comment on table academy.registration_handoffs is
'Payment-triggered queue from sales to registration and admissions.';
comment on function public.v2_tenant_record_sales_followup(
  text, uuid, text, text, text, text, text, timestamptz,
  uuid, uuid, bigint, text, date
) is
'Records the sales outcome, schedules the next task, or hands a paid lead to admissions.';

commit;
