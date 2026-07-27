begin;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values
  (
    'tenant.admissions.read',
    'admissions',
    'عرض التسجيل والقبول',
    'عرض طلبات التسجيل والتحقق من الدفع والمستندات'
  ),
  (
    'tenant.admissions.write',
    'admissions',
    'إدارة التسجيل والقبول',
    'مراجعة الدفع واستكمال القبول وإنشاء ملف المتدرب'
  )
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager',
    'customer_service'
  )
  and permission.permission_key in (
    'tenant.admissions.read',
    'tenant.admissions.write'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in (
    'sales_manager',
    'sales_supervisor',
    'data_officer',
    'data_analyst'
  )
  and permission.permission_key = 'tenant.admissions.read'
on conflict do nothing;

alter table sales_core.contacts
  add column lead_status_changed_at timestamptz not null default now(),
  add column closure_reason text,
  add column closed_at timestamptz,
  add column reopened_at timestamptz,
  add column payment_submitted_at timestamptz;

alter table sales_core.contacts
  drop constraint contacts_lead_status_check;

update sales_core.contacts
set closure_reason = coalesce(
      nullif(trim(closure_reason), ''),
      'ترحيل حالة مغلقة سابقة'
    ),
    closed_at = coalesce(closed_at, updated_at, now())
where lead_status in (
  'not_interested',
  'unqualified',
  'wrong_number',
  'duplicate',
  'cancelled'
);

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
    'payment_submitted',
    'paid',
    'postponed',
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  )),
  add constraint contacts_closure_reason_check
  check (
    lead_status not in (
      'not_interested',
      'unqualified',
      'wrong_number',
      'duplicate',
      'cancelled'
    )
    or (
      closure_reason is not null
      and length(trim(closure_reason)) >= 3
      and closed_at is not null
    )
  );

alter table sales_core.activities
  add column closure_reason text;

alter table sales_core.activities
  drop constraint activities_result_status_check;

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
      'payment_submitted',
      'paid',
      'postponed',
      'not_interested',
      'unqualified',
      'wrong_number',
      'duplicate',
      'cancelled'
    )
  );

alter table sales_core.opportunities
  drop constraint opportunities_status_check;

alter table sales_core.opportunities
  add constraint opportunities_status_check
  check (status in (
    'open',
    'pending_verification',
    'won',
    'lost',
    'cancelled'
  ));

create table sales_core.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  contact_id uuid not null
    references sales_core.contacts(id) on delete cascade,
  activity_id uuid
    references sales_core.activities(id) on delete set null,
  from_status text,
  to_status text not null,
  reason text,
  changed_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  changed_at timestamptz not null default now()
);

create index lead_status_history_contact_time_idx
on sales_core.lead_status_history (contact_id, changed_at desc);

create index lead_status_history_tenant_status_time_idx
on sales_core.lead_status_history (tenant_id, to_status, changed_at desc);

alter table sales_core.lead_status_history enable row level security;

create policy lead_status_history_isolated_read
on sales_core.lead_status_history
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table sales_core.lead_status_history
from public, anon, authenticated;

alter table academy.registration_handoffs
  add column payment_status text not null default 'pending_verification',
  add column payment_reported_at timestamptz not null default now(),
  add column payment_verified_at timestamptz,
  add column payment_verified_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  add column payment_rejection_reason text,
  add column accepted_at timestamptz,
  add column accepted_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  add column completed_at timestamptz,
  add column completed_by_subject_id uuid
    references access_control.subjects(id) on delete set null;

alter table academy.registration_handoffs
  add constraint registration_handoffs_payment_status_check
  check (payment_status in (
    'pending_verification',
    'verified',
    'rejected',
    'refunded'
  )),
  add constraint registration_handoffs_payment_verification_check
  check (
    payment_status <> 'verified'
    or payment_verified_at is not null
  );

create index registration_handoffs_payment_queue_idx
on academy.registration_handoffs (
  tenant_id,
  payment_status,
  status,
  payment_reported_at
);

create table academy.registration_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  handoff_id uuid not null
    references academy.registration_handoffs(id) on delete cascade,
  document_type text not null,
  is_required boolean not null default true,
  status text not null default 'pending'
    check (status in (
      'pending',
      'received',
      'approved',
      'rejected',
      'not_required'
    )),
  file_name text,
  storage_path text,
  notes text,
  reviewed_at timestamptz,
  reviewed_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (handoff_id, document_type)
);

create table academy.students (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  student_key text not null,
  student_number text not null,
  contact_id uuid not null
    references sales_core.contacts(id) on delete restrict,
  full_name text not null check (length(trim(full_name)) >= 2),
  phone text,
  email text,
  status text not null default 'active'
    check (status in ('active', 'inactive', 'graduated', 'blocked')),
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, student_key),
  unique (tenant_id, student_number),
  unique (tenant_id, contact_id)
);

create table academy.enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  enrollment_key text not null,
  handoff_id uuid not null unique
    references academy.registration_handoffs(id) on delete restrict,
  student_id uuid not null
    references academy.students(id) on delete restrict,
  course_id uuid not null
    references academy.courses(id) on delete restrict,
  course_run_id uuid not null
    references academy.course_runs(id) on delete restrict,
  status text not null default 'confirmed'
    check (status in (
      'confirmed',
      'active',
      'completed',
      'withdrawn',
      'cancelled'
    )),
  enrolled_at timestamptz not null default now(),
  confirmed_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, enrollment_key),
  unique (student_id, course_run_id)
);

create index registration_documents_tenant_status_idx
on academy.registration_documents (tenant_id, status, created_at);

create index registration_documents_handoff_idx
on academy.registration_documents (handoff_id, is_required, status);

create index academy_students_tenant_status_idx
on academy.students (tenant_id, status, full_name);

create index academy_students_contact_idx
on academy.students (contact_id);

create index academy_enrollments_tenant_status_idx
on academy.enrollments (tenant_id, status, enrolled_at desc);

create index academy_enrollments_student_idx
on academy.enrollments (student_id, enrolled_at desc);

create index academy_enrollments_course_idx
on academy.enrollments (course_id, course_run_id, status);

create trigger registration_documents_set_updated_at
before update on academy.registration_documents
for each row execute function private_app.set_updated_at();

create trigger academy_students_set_updated_at
before update on academy.students
for each row execute function private_app.set_updated_at();

create trigger academy_enrollments_set_updated_at
before update on academy.enrollments
for each row execute function private_app.set_updated_at();

alter table academy.registration_documents enable row level security;
alter table academy.students enable row level security;
alter table academy.enrollments enable row level security;

create policy registration_documents_isolated_read
on academy.registration_documents
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy academy_students_isolated_read
on academy.students
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy academy_enrollments_isolated_read
on academy.enrollments
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table academy.registration_documents
from public, anon, authenticated;
revoke all on table academy.students
from public, anon, authenticated;
revoke all on table academy.enrollments
from public, anon, authenticated;

update academy.registration_handoffs handoff
set payment_status = case
      when contact.lead_status = 'paid' then 'verified'
      else 'pending_verification'
    end,
    payment_reported_at = handoff.paid_at,
    payment_verified_at = case
      when contact.lead_status = 'paid' then handoff.paid_at
      else null
    end,
    payment_verified_by_subject_id = case
      when contact.lead_status = 'paid'
        then coalesce(
          handoff.created_by_subject_id,
          contact.created_by_subject_id
        )
      else null
    end
from sales_core.contacts contact
where contact.id = handoff.contact_id;

insert into academy.registration_documents (
  tenant_id,
  handoff_id,
  document_type,
  is_required,
  status
)
select
  handoff.tenant_id,
  handoff.id,
  document.document_type,
  document.is_required,
  case
    when document.document_type = 'payment_receipt'
      and handoff.payment_status = 'verified' then 'approved'
    when document.document_type = 'payment_receipt'
      and handoff.payment_reference is not null then 'received'
    else 'pending'
  end
from academy.registration_handoffs handoff
cross join (
  values
    ('payment_receipt'::text, true),
    ('national_id'::text, true),
    ('qualification'::text, true),
    ('personal_photo'::text, false)
) document(document_type, is_required)
on conflict (handoff_id, document_type) do nothing;

insert into sales_core.lead_status_history (
  tenant_id,
  contact_id,
  from_status,
  to_status,
  reason,
  changed_by_subject_id,
  metadata,
  changed_at
)
select
  contact.tenant_id,
  contact.id,
  null,
  contact.lead_status,
  'ترحيل الحالة الحالية عند تفعيل سجل الانتقالات',
  contact.created_by_subject_id,
  jsonb_build_object('migration', true),
  coalesce(contact.last_activity_at, contact.updated_at, contact.created_at)
from sales_core.contacts contact;

with ranked_followups as (
  select
    task.id,
    row_number() over (
      partition by task.tenant_id, task.contact_id
      order by task.due_at desc, task.created_at desc, task.id
    ) as position
  from work_core.tasks task
  where task.contact_id is not null
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
)
update work_core.tasks task
set status = 'cancelled',
    metadata = task.metadata || jsonb_build_object(
      'cancelReason',
      'duplicate_open_sales_followup'
    )
from ranked_followups ranked
where task.id = ranked.id
  and ranked.position > 1;

create unique index work_tasks_one_open_sales_followup_idx
on work_core.tasks (tenant_id, contact_id)
where contact_id is not null
  and status in ('todo', 'in_progress')
  and coalesce(metadata ->> 'source', '') in (
    'opportunity_next_action',
    'activity_next_action',
    'lead_next_action',
    'sales_followup'
  );

create or replace function public.v2_tenant_record_sales_followup_v2(
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
  p_preferred_start_date date default null,
  p_closure_reason text default null
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
  v_is_closed boolean;
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
  v_reopened boolean;
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
    'payment_submitted',
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
  v_is_closed := p_lead_status in (
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  );

  if v_is_open and (
    p_next_action_type is null
    or p_next_action_at is null
  ) then raise exception 'next_action_required'; end if;
  if v_is_open and p_next_action_type not in (
    'call',
    'whatsapp',
    'send_details',
    'meeting',
    'payment_followup',
    'follow_up'
  ) then raise exception 'invalid_next_action'; end if;
  if v_is_closed and (
    p_closure_reason is null
    or length(trim(p_closure_reason)) < 3
  ) then raise exception 'closure_reason_required'; end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then raise exception 'invalid_contact'; end if;
  if v_contact.lead_status in ('payment_submitted', 'paid') then
    raise exception 'lead_under_admissions';
  end if;

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
  if p_lead_status = 'payment_submitted' and v_course_id is null then
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
    when p_lead_status = 'payment_submitted' then 'proposal'
    when v_is_closed then 'lost'
    when p_lead_status in ('very_interested', 'awaiting_payment') then 'proposal'
    when p_lead_status = 'interested' then 'qualified'
    when p_lead_status in ('no_answer', 'busy', 'follow_up', 'postponed')
      then 'contacted'
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
    (opportunity.status in ('open', 'pending_verification')) desc,
    opportunity.created_at desc
  limit 1
  for update;

  v_case_status := case
    when p_lead_status = 'payment_submitted' then 'pending_verification'
    when v_is_open then 'open'
    else 'lost'
  end;
  v_contact_status := case
    when p_lead_status = 'payment_submitted' then 'active'
    when v_is_open then 'active'
    when p_lead_status = 'unqualified' then 'unqualified'
    else 'archived'
  end;
  v_reopened := v_contact.lead_status in (
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  ) and v_is_open;

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
      lost_reason,
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
      case when v_is_closed then trim(p_closure_reason) else null end,
      private_app.current_subject_id(),
      jsonb_build_object('model', 'lead_centric')
    )
    returning * into v_opportunity;
  else
    update sales_core.opportunities
    set course_id = coalesce(v_course_id, course_id),
        stage_id = v_stage.id,
        value_minor = coalesce(p_payment_amount_minor, value_minor),
        next_action_type = case
          when v_is_open then p_next_action_type
          else null
        end,
        next_action_at = case
          when v_is_open then p_next_action_at
          else null
        end,
        status = v_case_status,
        lost_reason = case
          when v_is_closed then trim(p_closure_reason)
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
    closure_reason,
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
    case when v_is_closed then trim(p_closure_reason) else null end,
    private_app.current_subject_id(),
    jsonb_build_object(
      'model',
      'lead_centric',
      'reopened',
      v_reopened
    )
  )
  returning id into v_activity_id;

  update work_core.tasks
  set status = 'cancelled',
      metadata = metadata || jsonb_build_object(
        'cancelReason',
        'superseded_by_sales_outcome'
      )
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
      last_activity_at = now(),
      lead_status_changed_at = case
        when lead_status is distinct from p_lead_status then now()
        else lead_status_changed_at
      end,
      closure_reason = case
        when v_is_closed then trim(p_closure_reason)
        else null
      end,
      closed_at = case
        when v_is_closed then now()
        else null
      end,
      reopened_at = case
        when v_reopened then now()
        else reopened_at
      end,
      payment_submitted_at = case
        when p_lead_status = 'payment_submitted' then now()
        else payment_submitted_at
      end
  where id = p_contact_id;

  if v_contact.lead_status is distinct from p_lead_status then
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
      p_contact_id,
      v_activity_id,
      v_contact.lead_status,
      p_lead_status,
      case
        when v_is_closed then trim(p_closure_reason)
        else trim(p_summary)
      end,
      private_app.current_subject_id(),
      jsonb_build_object('reopened', v_reopened)
    );
  end if;

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
      'الحالة: ' || p_lead_status
        || ' · الإجراء التالي: ' || p_next_action_type,
      case
        when p_lead_status in ('very_interested', 'awaiting_payment')
          then 'high'
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
  elsif p_lead_status = 'payment_submitted' then
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
      payment_status,
      payment_reported_at,
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
      'pending_verification',
      now(),
      p_payment_amount_minor,
      nullif(trim(coalesce(p_payment_reference, '')), ''),
      p_preferred_start_date,
      trim(p_summary),
      private_app.current_subject_id(),
      jsonb_build_object(
        'source',
        'sales_payment_report',
        'notification',
        true
      )
    )
    on conflict (tenant_id, handoff_key) do update
    set course_id = excluded.course_id,
        course_run_id = excluded.course_run_id,
        assigned_department_id = excluded.assigned_department_id,
        assigned_staff_id = excluded.assigned_staff_id,
        status = 'pending',
        paid_at = excluded.paid_at,
        payment_status = 'pending_verification',
        payment_reported_at = excluded.payment_reported_at,
        payment_verified_at = null,
        payment_verified_by_subject_id = null,
        payment_rejection_reason = null,
        payment_amount_minor = excluded.payment_amount_minor,
        payment_reference = excluded.payment_reference,
        preferred_start_date = excluded.preferred_start_date,
        notes = excluded.notes,
        metadata = excluded.metadata
    returning id into v_handoff_id;

    insert into academy.registration_documents (
      tenant_id,
      handoff_id,
      document_type,
      is_required,
      status
    )
    select
      v_tenant_id,
      v_handoff_id,
      document.document_type,
      document.is_required,
      case
        when document.document_type = 'payment_receipt'
          and nullif(trim(coalesce(p_payment_reference, '')), '') is not null
          then 'received'
        else 'pending'
      end
    from (
      values
        ('payment_receipt'::text, true),
        ('national_id'::text, true),
        ('qualification'::text, true),
        ('personal_photo'::text, false)
    ) document(document_type, is_required)
    on conflict (handoff_id, document_type) do update
    set status = case
          when excluded.document_type = 'payment_receipt'
            and excluded.status = 'received' then 'received'
          else academy.registration_documents.status
        end,
        is_required = excluded.is_required;

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
      'تحقق من الدفع: ' || v_contact.full_name,
      case
        when p_course_run_id is null
          then 'أبلغ العميل بالدفع · يلزم التحقق وتحديد الدفعة'
        else 'أبلغ العميل بالدفع · يلزم التحقق قبل تأكيد التسجيل'
      end,
      'urgent',
      v_admissions_staff_id,
      private_app.current_subject_id(),
      p_contact_id,
      v_opportunity.id,
      v_activity_id,
      now(),
      jsonb_build_object(
        'source',
        'registration_handoff',
        'handoffId',
        v_handoff_id,
        'department',
        'admissions',
        'notification',
        true,
        'paymentStatus',
        'pending_verification'
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
      'activityId',
      v_activity_id,
      'status',
      p_lead_status,
      'quality',
      p_lead_quality,
      'taskId',
      v_task_id,
      'handoffId',
      v_handoff_id,
      'closureReason',
      case when v_is_closed then trim(p_closure_reason) else null end
    )
  );

  return jsonb_build_object(
    'id',
    v_activity_id,
    'contactId',
    p_contact_id,
    'status',
    p_lead_status,
    'quality',
    p_lead_quality,
    'taskId',
    v_task_id,
    'handoffId',
    v_handoff_id,
    'paymentReviewNotified',
    v_handoff_id is not null
  );
end;
$$;

create or replace function public.v2_tenant_admissions_snapshot(
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
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.admissions.read'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt',
    now(),
    'viewer',
    jsonb_build_object(
      'staffId',
      private_app.current_staff_id(v_tenant.id),
      'canManage',
      private_app.has_tenant_permission(
        v_tenant.id,
        'tenant.admissions.write'
      )
    ),
    'summary',
    jsonb_build_object(
      'pendingVerification',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'pending_verification'
          and handoff.status not in ('completed', 'cancelled')
      ),
      'inReview',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'in_review'
      ),
      'accepted',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'accepted'
      ),
      'completed',
      (
        select count(*)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.status = 'completed'
      ),
      'documentsPending',
      (
        select count(*)
        from academy.registration_documents document
        join academy.registration_handoffs handoff
          on handoff.id = document.handoff_id
        where document.tenant_id = v_tenant.id
          and document.is_required
          and document.status not in ('approved', 'not_required')
          and handoff.status not in ('completed', 'cancelled', 'rejected')
      )
    ),
    'cases',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        handoff.id,
        'contactId',
        handoff.contact_id,
        'contactName',
        contact.full_name,
        'phone',
        contact.phone,
        'whatsapp',
        contact.whatsapp,
        'email',
        contact.email,
        'source',
        contact.source,
        'campaignName',
        contact.campaign_name,
        'salesOwnerName',
        owner.full_name,
        'courseId',
        handoff.course_id,
        'courseName',
        course.title_ar,
        'courseRunId',
        handoff.course_run_id,
        'courseRunName',
        coalesce(run.title, run.run_code),
        'runStartsAt',
        run.starts_at,
        'preferredStartDate',
        handoff.preferred_start_date,
        'status',
        handoff.status,
        'paymentStatus',
        handoff.payment_status,
        'paymentReportedAt',
        handoff.payment_reported_at,
        'paymentVerifiedAt',
        handoff.payment_verified_at,
        'paymentAmountMinor',
        handoff.payment_amount_minor,
        'paymentReference',
        handoff.payment_reference,
        'paymentRejectionReason',
        handoff.payment_rejection_reason,
        'notes',
        handoff.notes,
        'assignedStaffId',
        handoff.assigned_staff_id,
        'assignedStaffName',
        assignee.full_name,
        'acceptedAt',
        handoff.accepted_at,
        'completedAt',
        handoff.completed_at,
        'demo',
        coalesce((handoff.metadata ->> 'demo')::boolean, false),
        'documents',
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',
            document.id,
            'type',
            document.document_type,
            'required',
            document.is_required,
            'status',
            document.status,
            'fileName',
            document.file_name,
            'notes',
            document.notes,
            'reviewedAt',
            document.reviewed_at
          ) order by document.is_required desc, document.document_type)
          from academy.registration_documents document
          where document.handoff_id = handoff.id
        ), '[]'::jsonb),
        'enrollment',
        (
          select jsonb_build_object(
            'id',
            enrollment.id,
            'studentId',
            student.id,
            'studentNumber',
            student.student_number,
            'status',
            enrollment.status,
            'enrolledAt',
            enrollment.enrolled_at
          )
          from academy.enrollments enrollment
          join academy.students student on student.id = enrollment.student_id
          where enrollment.handoff_id = handoff.id
          limit 1
        )
      ) order by
        case handoff.payment_status
          when 'pending_verification' then 0
          when 'verified' then 1
          when 'rejected' then 2
          else 3
        end,
        handoff.payment_reported_at desc
      )
      from academy.registration_handoffs handoff
      join sales_core.contacts contact on contact.id = handoff.contact_id
      join academy.courses course on course.id = handoff.course_id
      left join academy.course_runs run on run.id = handoff.course_run_id
      left join people.staff_profiles owner
        on owner.id = contact.owner_staff_id
      left join people.staff_profiles assignee
        on assignee.id = handoff.assigned_staff_id
      where handoff.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'staff',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        staff.id,
        'name',
        staff.full_name,
        'roleKey',
        staff.role_key,
        'department',
        department.name_ar
      ) order by staff.full_name)
      from people.staff_profiles staff
      left join people.departments department
        on department.id = staff.department_id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and (
          department.department_key = 'admissions'
          or staff.role_key in (
            'customer_service',
            'tenant_admin',
            'executive_manager'
          )
        )
    ), '[]'::jsonb),
    'courses',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        course.id,
        'courseCode',
        course.course_code,
        'nameAr',
        course.title_ar,
        'status',
        course.status
      ) order by course.title_ar)
      from academy.courses course
      where course.tenant_id = v_tenant.id
        and course.status = 'active'
    ), '[]'::jsonb),
    'courseRuns',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',
        run.id,
        'courseId',
        run.course_id,
        'runCode',
        run.run_code,
        'title',
        coalesce(run.title, course.title_ar),
        'startsAt',
        run.starts_at,
        'endsAt',
        run.ends_at,
        'capacity',
        run.capacity,
        'enrolledCount',
        run.enrolled_count,
        'status',
        run.status
      ) order by run.starts_at nulls last, run.created_at)
      from academy.course_runs run
      join academy.courses course on course.id = run.course_id
      where run.tenant_id = v_tenant.id
        and run.status in ('planning', 'open', 'in_progress')
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_update_admission(
  p_tenant_slug text,
  p_handoff_id uuid,
  p_action text,
  p_course_id uuid default null,
  p_course_run_id uuid default null,
  p_notes text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.admissions.write'
  ) then raise exception 'forbidden'; end if;
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
     and p_action <> 'save_details' then
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
    set status = 'in_review',
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
    if v_handoff.payment_status <> 'verified' then
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
    if v_handoff.payment_status <> 'verified' then
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
$$;

create or replace function public.v2_tenant_update_admission_document(
  p_tenant_slug text,
  p_handoff_id uuid,
  p_document_type text,
  p_status text,
  p_notes text default null,
  p_is_required boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_document_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.admissions.write'
  ) then raise exception 'forbidden'; end if;
  if p_document_type is null
     or length(trim(p_document_type)) < 2
     or length(trim(p_document_type)) > 80 then
    raise exception 'invalid_document_type';
  end if;
  if p_status not in (
    'pending',
    'received',
    'approved',
    'rejected',
    'not_required'
  ) then raise exception 'invalid_document_status'; end if;
  if p_status = 'rejected' and (
    p_notes is null
    or length(trim(p_notes)) < 3
  ) then raise exception 'reason_required'; end if;
  if not exists (
    select 1
    from academy.registration_handoffs handoff
    where handoff.id = p_handoff_id
      and handoff.tenant_id = v_tenant_id
      and handoff.status not in ('completed', 'cancelled')
  ) then raise exception 'admission_closed'; end if;

  insert into academy.registration_documents (
    tenant_id,
    handoff_id,
    document_type,
    is_required,
    status,
    notes,
    reviewed_at,
    reviewed_by_subject_id
  )
  values (
    v_tenant_id,
    p_handoff_id,
    trim(p_document_type),
    p_is_required,
    p_status,
    nullif(trim(coalesce(p_notes, '')), ''),
    case
      when p_status in ('approved', 'rejected', 'not_required') then now()
      else null
    end,
    case
      when p_status in ('approved', 'rejected', 'not_required')
        then private_app.current_subject_id()
      else null
    end
  )
  on conflict (handoff_id, document_type) do update
  set is_required = excluded.is_required,
      status = excluded.status,
      notes = excluded.notes,
      reviewed_at = excluded.reviewed_at,
      reviewed_by_subject_id = excluded.reviewed_by_subject_id
  returning id into v_document_id;

  perform private_app.write_audit(
    'tenant.admission_document_updated',
    'registration_document',
    v_document_id::text,
    v_tenant_id,
    jsonb_build_object(
      'handoffId',
      p_handoff_id,
      'documentType',
      trim(p_document_type),
      'status',
      p_status
    )
  );

  return jsonb_build_object(
    'id',
    v_document_id,
    'handoffId',
    p_handoff_id,
    'type',
    trim(p_document_type),
    'status',
    p_status
  );
end;
$$;

revoke execute on function public.v2_tenant_record_sales_followup(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date
) from public, anon, authenticated;

revoke execute on function public.v2_tenant_record_sales_followup_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text
) from public, anon;

revoke execute on function public.v2_tenant_admissions_snapshot(text)
from public, anon;

revoke execute on function public.v2_tenant_update_admission(
  text,
  uuid,
  text,
  uuid,
  uuid,
  text,
  text
) from public, anon;

revoke execute on function public.v2_tenant_update_admission_document(
  text,
  uuid,
  text,
  text,
  text,
  boolean
) from public, anon;

grant execute on function public.v2_tenant_record_sales_followup_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text
) to authenticated;

grant execute on function public.v2_tenant_admissions_snapshot(text)
to authenticated;

grant execute on function public.v2_tenant_update_admission(
  text,
  uuid,
  text,
  uuid,
  uuid,
  text,
  text
) to authenticated;

grant execute on function public.v2_tenant_update_admission_document(
  text,
  uuid,
  text,
  text,
  text,
  boolean
) to authenticated;

comment on table sales_core.lead_status_history is
'Immutable lead status timeline for transition-date analytics and reopening audit.';

comment on table academy.registration_documents is
'Admissions checklist for payment evidence and applicant documents.';

comment on table academy.students is
'One tenant-level learner profile created after admissions completion.';

comment on table academy.enrollments is
'Confirmed learner placement in a specific course run.';

comment on function public.v2_tenant_record_sales_followup_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text
) is
'Guarded lead-centric follow-up: one next task, mandatory closure reason, and payment review handoff.';

comment on function public.v2_tenant_update_admission(
  text,
  uuid,
  text,
  uuid,
  uuid,
  text,
  text
) is
'Verifies payment, returns rejected payments to sales, and completes enrollment.';

commit;
