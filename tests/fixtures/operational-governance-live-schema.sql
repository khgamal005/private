-- Additional production schema/function contracts inspected 2026-09-21; no data.
set check_function_bodies=off;
create table sales_core.lead_import_batches (id uuid default gen_random_uuid() not null,tenant_id uuid not null,batch_key text not null,file_name text not null,source text default 'sheet_import'::text not null,campaign_name text,ad_set_name text,ad_name text,status text default 'ready'::text not null,total_rows integer default 0 not null,valid_rows integer default 0 not null,duplicate_rows integer default 0 not null,invalid_rows integer default 0 not null,distributed_rows integer default 0 not null,imported_by_subject_id uuid,imported_by_staff_id uuid,last_distributed_by_staff_id uuid,last_distribution_strategy text,last_deadline_at timestamp with time zone,distributed_at timestamp with time zone,metadata jsonb default '{}'::jsonb not null,created_at timestamp with time zone default now() not null,updated_at timestamp with time zone default now() not null);
create table sales_core.lead_import_rows (id uuid default gen_random_uuid() not null,tenant_id uuid not null,batch_id uuid not null,row_number integer not null,full_name text,organization_name text,phone text,normalized_phone text,whatsapp text,normalized_whatsapp text,email text,source text default 'sheet_import'::text not null,campaign_name text,ad_set_name text,ad_name text,program_name text,notes text,validation_status text not null,validation_errors text[] default '{}'::text[] not null,duplicate_kind text,duplicate_contact_id uuid,queue_status text default 'awaiting_distribution'::text not null,contact_id uuid,raw_data jsonb default '{}'::jsonb not null,created_at timestamp with time zone default now() not null,updated_at timestamp with time zone default now() not null,duplicate_import_row_id uuid);
-- The shared training fixture only needs commerce work item identity. These
-- additional inspected production columns are used by its real owner selector.
alter table sales_core.commerce_order_work_items add column assigned_staff_id uuid,
  add column assigned_at timestamptz, add column task_id uuid;
create table sales_core.lead_assignments (id uuid default gen_random_uuid() not null,tenant_id uuid not null,batch_id uuid not null,import_row_id uuid not null,contact_id uuid not null,opportunity_id uuid,task_id uuid,assigned_staff_id uuid not null,assigned_by_staff_id uuid,assigned_by_subject_id uuid,assignment_strategy text not null,status text default 'active'::text not null,assigned_at timestamp with time zone default now() not null,deadline_at timestamp with time zone not null,first_action_at timestamp with time zone,completed_at timestamp with time zone,metadata jsonb default '{}'::jsonb not null,created_at timestamp with time zone default now() not null,updated_at timestamp with time zone default now() not null);

create table sales_core.sales_assignment_profiles (id uuid default gen_random_uuid() not null,tenant_id uuid not null,staff_id uuid not null,sales_channel text default 'online'::text not null,eligible_for_leads boolean default true not null,daily_capacity integer default 50 not null,weight integer default 1 not null,last_assigned_at timestamp with time zone,updated_by_subject_id uuid,created_at timestamp with time zone default now() not null,updated_at timestamp with time zone default now() not null);

alter table sales_core.lead_assignments add constraint lead_assignments_assignment_strategy_check CHECK ((assignment_strategy = ANY (ARRAY['fair'::text, 'online_only'::text, 'selected'::text])));

alter table sales_core.lead_assignments add constraint lead_assignments_check CHECK ((deadline_at > assigned_at));

alter table sales_core.lead_assignments add constraint lead_assignments_check1 CHECK (((completed_at IS NULL) OR (completed_at >= assigned_at)));

alter table sales_core.lead_assignments add constraint lead_assignments_pkey PRIMARY KEY (id);

alter table sales_core.lead_assignments add constraint lead_assignments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'reassigned'::text, 'cancelled'::text])));

alter table sales_core.sales_assignment_profiles add constraint sales_assignment_profiles_daily_capacity_check CHECK (((daily_capacity >= 1) AND (daily_capacity <= 1000)));

alter table sales_core.sales_assignment_profiles add constraint sales_assignment_profiles_pkey PRIMARY KEY (id);

alter table sales_core.sales_assignment_profiles add constraint sales_assignment_profiles_sales_channel_check CHECK ((sales_channel = ANY (ARRAY['online'::text, 'field'::text, 'hybrid'::text])));

alter table sales_core.sales_assignment_profiles add constraint sales_assignment_profiles_tenant_id_staff_id_key UNIQUE (tenant_id, staff_id);

alter table sales_core.sales_assignment_profiles add constraint sales_assignment_profiles_weight_check CHECK (((weight >= 1) AND (weight <= 10)));

CREATE OR REPLACE FUNCTION private_app.capture_task_history_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event_type text;
  v_transition jsonb;
begin
  if row(
    old.status,
    old.due_at,
    old.assigned_staff_id,
    old.title,
    old.description,
    old.priority,
    old.metadata
  ) is not distinct from row(
    new.status,
    new.due_at,
    new.assigned_staff_id,
    new.title,
    new.description,
    new.priority,
    new.metadata
  ) then
    return new;
  end if;

  v_event_type := case
    when old.due_at is distinct from new.due_at then 'rescheduled'
    when old.status is distinct from new.status then 'status_changed'
    when old.assigned_staff_id is distinct from new.assigned_staff_id
      then 'reassigned'
    else 'updated'
  end;
  v_transition := case
    when old.metadata -> 'lastTransition'
      is distinct from new.metadata -> 'lastTransition'
      then coalesce(new.metadata -> 'lastTransition', '{}'::jsonb)
    else '{}'::jsonb
  end;

  insert into work_core.task_history (
    tenant_id,
    task_id,
    task_key,
    contact_id,
    opportunity_id,
    actor_subject_id,
    event_type,
    task_title,
    task_description,
    previous_status,
    next_status,
    previous_due_at,
    next_due_at,
    previous_assigned_staff_id,
    next_assigned_staff_id,
    note,
    metadata,
    changed_at
  )
  values (
    new.tenant_id,
    new.id,
    new.task_key,
    new.contact_id,
    new.opportunity_id,
    private_app.current_subject_id(),
    v_event_type,
    new.title,
    new.description,
    old.status,
    new.status,
    old.due_at,
    new.due_at,
    old.assigned_staff_id,
    new.assigned_staff_id,
    nullif(v_transition ->> 'note', ''),
    jsonb_strip_nulls(jsonb_build_object(
      'source', new.metadata ->> 'source',
      'actionType', new.metadata ->> 'actionType',
      'transition', v_transition
    )),
    now()
  );

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION private_app.complete_terminal_contact_sales_tasks_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_activity_id uuid;
  v_actor_subject_id uuid;
  v_terminal_at timestamptz;
begin
  select
    activity.id,
    activity.created_by_subject_id,
    activity.occurred_at
  into
    v_activity_id,
    v_actor_subject_id,
    v_terminal_at
  from sales_core.activities activity
  where activity.tenant_id = new.tenant_id
    and activity.contact_id = new.id
    and activity.result_status = new.lead_status
  order by activity.occurred_at desc, activity.id desc
  limit 1;

  v_terminal_at := coalesce(
    v_terminal_at,
    case when new.lead_status = 'payment_submitted'
      then new.payment_submitted_at end,
    case when new.lead_status in (
      'not_interested', 'unqualified', 'wrong_number',
      'duplicate', 'cancelled'
    ) then new.closed_at end,
    new.lead_status_changed_at,
    new.last_activity_at,
    clock_timestamp()
  );

  update work_core.tasks task
  set status = 'completed',
      activity_id = coalesce(v_activity_id, task.activity_id),
      completed_at = greatest(v_terminal_at, task.created_at),
      completion_timing = case
        when greatest(v_terminal_at, task.created_at) <= task.due_at
          then 'on_time'
        else 'late'
      end,
      metadata = (
        task.metadata - 'cancelReason'
      ) || jsonb_strip_nulls(jsonb_build_object(
        'resolvedByActivityId', v_activity_id,
        'completedBySubjectId', v_actor_subject_id,
        'terminalLeadStatus', new.lead_status,
        'salesLifecycleResolution', jsonb_build_object(
          'version', 'sales_contact_task_lifecycle_v1',
          'kind', 'terminal_contact_fallback',
          'leadStatus', new.lead_status,
          'resolvedAt', greatest(v_terminal_at, task.created_at)
        ),
        'lastTransition', jsonb_strip_nulls(jsonb_build_object(
          'fromStatus', task.status,
          'toStatus', 'completed',
          'fromDueAt', task.due_at,
          'toDueAt', task.due_at,
          'actorSubjectId', v_actor_subject_id,
          'at', greatest(v_terminal_at, task.created_at),
          'mode', 'terminal_contact_fallback_v1',
          'note', 'إغلاق مهمة المبيعات بعد وصول العميل إلى حالة نهائية'
        ))
      ))
  where task.tenant_id = new.tenant_id
    and task.contact_id = new.id
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    );

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION private_app.guard_terminal_contact_sales_task_insert_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_contact sales_core.contacts%rowtype;
  v_activity_id uuid;
  v_actor_subject_id uuid;
  v_terminal_at timestamptz;
begin
  if new.status not in ('todo', 'in_progress')
     or new.contact_id is null
     or coalesce(new.metadata ->> 'source', '') not in (
       'lead_assignment',
       'opportunity_next_action',
       'activity_next_action',
       'lead_next_action',
       'sales_followup'
     )
  then
    return new;
  end if;

  select contact.*
  into v_contact
  from sales_core.contacts contact
  where contact.tenant_id = new.tenant_id
    and contact.id = new.contact_id
  for share;

  if v_contact.id is null
     or v_contact.lead_status not in (
       'payment_submitted',
       'paid',
       'not_interested',
       'unqualified',
       'wrong_number',
       'duplicate',
       'cancelled'
     )
  then
    return new;
  end if;

  select
    activity.id,
    activity.created_by_subject_id,
    activity.occurred_at
  into
    v_activity_id,
    v_actor_subject_id,
    v_terminal_at
  from sales_core.activities activity
  where activity.tenant_id = new.tenant_id
    and activity.contact_id = new.contact_id
    and activity.result_status = v_contact.lead_status
  order by activity.occurred_at desc, activity.id desc
  limit 1;

  v_terminal_at := greatest(
    coalesce(
      v_terminal_at,
      case when v_contact.lead_status = 'payment_submitted'
        then v_contact.payment_submitted_at end,
      case when v_contact.lead_status in (
        'not_interested', 'unqualified', 'wrong_number',
        'duplicate', 'cancelled'
      ) then v_contact.closed_at end,
      v_contact.lead_status_changed_at,
      v_contact.last_activity_at,
      clock_timestamp()
    ),
    coalesce(new.created_at, clock_timestamp())
  );

  new.status := 'completed';
  new.activity_id := coalesce(v_activity_id, new.activity_id);
  new.completed_at := v_terminal_at;
  new.completion_timing := case
    when v_terminal_at <= new.due_at then 'on_time'
    else 'late'
  end;
  new.metadata := (
    new.metadata - 'cancelReason'
  ) || jsonb_strip_nulls(jsonb_build_object(
    'resolvedByActivityId', v_activity_id,
    'completedBySubjectId', v_actor_subject_id,
    'terminalLeadStatus', v_contact.lead_status,
    'salesLifecycleResolution', jsonb_build_object(
      'version', 'sales_contact_task_lifecycle_v1',
      'kind', 'terminal_contact_insert_guard',
      'leadStatus', v_contact.lead_status,
      'resolvedAt', v_terminal_at
    )
  ));

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION private_app.prepare_contact_identity_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_normalized text;
begin
  if nullif(pg_catalog.btrim(coalesce(new.phone, '')), '') is not null then
    v_normalized := private_app.normalize_lead_phone(new.phone);
    if v_normalized is null then
      raise exception 'invalid_phone';
    end if;
    new.phone := private_app.format_customer_phone(new.phone);
  else
    new.phone := null;
  end if;

  if nullif(pg_catalog.btrim(coalesce(new.whatsapp, '')), '') is not null then
    v_normalized := private_app.normalize_lead_phone(new.whatsapp);
    if v_normalized is null then
      raise exception 'invalid_whatsapp';
    end if;
    new.whatsapp := private_app.format_customer_phone(new.whatsapp);
  else
    new.whatsapp := null;
  end if;

  new.email := nullif(pg_catalog.lower(pg_catalog.btrim(
    coalesce(new.email, '')
  )), '');
  if new.email is not null
     and new.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;
  if new.phone is null
     and new.whatsapp is null
     and new.email is null then
    raise exception 'contact_identity_required';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION private_app.sync_contact_identities()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'UPDATE' and old.tenant_id is distinct from new.tenant_id then
    delete from sales_core.contact_identities
    where contact_id = new.id;
  elsif tg_op = 'UPDATE' then
    update sales_core.contact_identities
    set source_slot = 'historical_alias',
        is_alias = true,
        updated_at = now()
    where contact_id = new.id
      and not is_alias;
  else
    delete from sales_core.contact_identities
    where contact_id = new.id
      and not is_alias;
  end if;

  delete from sales_core.contact_identities identity
  where identity.contact_id = new.id
    and identity.is_alias
    and (
      (
        identity.identity_type = 'phone'
        and identity.identity_value in (
          private_app.normalize_lead_phone(new.phone),
          private_app.normalize_lead_phone(new.whatsapp)
        )
      )
      or (
        identity.identity_type = 'email'
        and identity.identity_value = new.email
      )
    );

  insert into sales_core.contact_identities (
    tenant_id,
    contact_id,
    identity_type,
    identity_value,
    source_slot,
    is_alias
  )
  select distinct on (candidate.identity_type, candidate.identity_value)
    new.tenant_id,
    new.id,
    candidate.identity_type,
    candidate.identity_value,
    candidate.source_slot,
    false
  from (
    values
      (
        'phone'::text,
        private_app.normalize_lead_phone(new.phone),
        'phone'::text,
        1
      ),
      (
        'phone'::text,
        private_app.normalize_lead_phone(new.whatsapp),
        'whatsapp'::text,
        2
      ),
      ('email'::text, new.email, 'email'::text, 3)
  ) as candidate(identity_type, identity_value, source_slot, source_order)
  where candidate.identity_value is not null
  order by
    candidate.identity_type,
    candidate.identity_value,
    candidate.source_order;

  return new;
end;
$function$
;
set check_function_bodies=on;
