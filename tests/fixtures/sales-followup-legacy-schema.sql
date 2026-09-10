-- Synthetic fixture: table column types/defaults inspected from ODEIR on 2026-09-10.
-- No production records or credentials. Constraints below model the affected contracts.
create role anon; create role authenticated; create role service_role;
create schema academy;
create schema access_control;
create schema core;
create schema people;
create schema sales_core;
create schema work_core;
create schema private_app;
create table academy.course_run_sessions (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 course_run_id uuid,
 session_number integer,
 title text,
 starts_at timestamp with time zone,
 ends_at timestamp with time zone,
 delivery_mode text,
 instructor_name text,
 venue_or_link text,
 status text default 'scheduled'::text,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now(),
 meeting_provider text,
 external_meeting_id text,
 meeting_join_url text,
 meeting_status text default 'not_created'::text,
 meeting_created_at timestamp with time zone,
 meeting_last_error text
);
create table academy.course_runs (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 course_id uuid,
 run_code text,
 title text,
 delivery_mode text,
 starts_at timestamp with time zone,
 ends_at timestamp with time zone,
 capacity integer,
 enrolled_count integer default 0,
 instructor_name text,
 venue_or_link text,
 price_minor bigint,
 currency text default 'SAR'::text,
 status text default 'planning'::text,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now(),
 registration_opens_at timestamp with time zone,
 registration_closes_at timestamp with time zone
);
create table academy.courses (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 course_code text,
 title_ar text,
 title_en text,
 category text,
 description text,
 delivery_mode text default 'hybrid'::text,
 duration_hours numeric(7,2),
 duration_days integer,
 price_minor bigint,
 currency text default 'SAR'::text,
 certification_code text,
 status text default 'active'::text,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now(),
 regular_price_minor bigint,
 sale_price_minor bigint,
 sale_starts_at timestamp with time zone,
 sale_ends_at timestamp with time zone,
 currency_minor_digits smallint default 2,
 external_source text,
 external_id text,
 external_url text,
 external_updated_at timestamp with time zone,
 primary_image_url text,
 gallery_urls text[] default '{}'::text[],
 stock_status text,
 stock_quantity numeric(14,3),
 product_type text,
 virtual boolean default false,
 downloadable boolean default false
);
create table academy.registration_documents (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 handoff_id uuid,
 document_type text,
 is_required boolean default false,
 status text default 'pending'::text,
 file_name text,
 storage_path text,
 notes text,
 reviewed_at timestamp with time zone,
 reviewed_by_subject_id uuid,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table academy.registration_handoffs (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 handoff_key text,
 contact_id uuid,
 opportunity_id uuid,
 course_id uuid,
 course_run_id uuid,
 assigned_department_id uuid,
 assigned_staff_id uuid,
 status text default 'pending'::text,
 paid_at timestamp with time zone default now(),
 payment_amount_minor bigint,
 payment_reference text,
 preferred_start_date date,
 notes text,
 created_by_subject_id uuid,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now(),
 payment_status text default 'pending_verification'::text,
 payment_reported_at timestamp with time zone default now(),
 payment_verified_at timestamp with time zone,
 payment_verified_by_subject_id uuid,
 payment_rejection_reason text,
 accepted_at timestamp with time zone,
 accepted_by_subject_id uuid,
 completed_at timestamp with time zone,
 completed_by_subject_id uuid
);
create table access_control.subjects (
 id uuid default gen_random_uuid() primary key,
 auth_user_id uuid,
 email text,
 full_name text,
 status text default 'active'::text,
 must_change_password boolean default false,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table core.tenants (
 id uuid default gen_random_uuid() primary key,
 organization_id uuid,
 tenant_key text,
 slug text,
 name text,
 legal_name text,
 status text default 'trial'::text,
 country_code text default 'SA'::text,
 timezone text default 'Asia/Riyadh'::text,
 default_locale text default 'ar-SA'::text,
 settings jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table people.departments (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 department_key text,
 name_ar text,
 name_en text,
 status text default 'active'::text,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table people.staff_profiles (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 membership_id uuid,
 employee_code text,
 full_name text,
 email text,
 phone text,
 job_title text,
 department_id uuid,
 role_key text,
 employment_status text default 'active'::text,
 account_status text default 'profile_only'::text,
 capacity_minutes_weekly integer default 2400,
 hired_at date,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now(),
 supervisor_staff_id uuid
);
create table sales_core.activities (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 activity_key text default ('manual-'::text || (gen_random_uuid())::text),
 opportunity_id uuid,
 contact_id uuid,
 actor_staff_id uuid,
 activity_type text,
 outcome text,
 summary text,
 occurred_at timestamp with time zone default now(),
 next_action_type text,
 next_action_at timestamp with time zone,
 created_by_subject_id uuid,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 result_status text,
 result_quality text,
 closure_reason text
);
create table sales_core.contact_identities (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 contact_id uuid,
 identity_type text,
 identity_value text,
 source_slot text,
 is_alias boolean default false,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table sales_core.contacts (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 contact_key text default ('manual-'::text || (gen_random_uuid())::text),
 full_name text,
 organization_name text,
 phone text,
 whatsapp text,
 email text,
 source text default 'manual'::text,
 status text default 'active'::text,
 owner_staff_id uuid,
 interest_course_id uuid,
 notes text,
 created_by_subject_id uuid,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now(),
 lead_status text default 'new'::text,
 lead_quality text default 'unrated'::text,
 next_action_type text,
 next_action_at timestamp with time zone,
 last_activity_at timestamp with time zone,
 campaign_name text,
 ad_name text,
 lead_status_changed_at timestamp with time zone default now(),
 closure_reason text,
 closed_at timestamp with time zone,
 reopened_at timestamp with time zone,
 payment_submitted_at timestamp with time zone
);
create table sales_core.lead_assignments (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 batch_id uuid,
 import_row_id uuid,
 contact_id uuid,
 opportunity_id uuid,
 task_id uuid,
 assigned_staff_id uuid,
 assigned_by_staff_id uuid,
 assigned_by_subject_id uuid,
 assignment_strategy text,
 status text default 'active'::text,
 assigned_at timestamp with time zone default now(),
 deadline_at timestamp with time zone,
 first_action_at timestamp with time zone,
 completed_at timestamp with time zone,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table sales_core.lead_status_history (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 contact_id uuid,
 activity_id uuid,
 from_status text,
 to_status text,
 reason text,
 changed_by_subject_id uuid,
 metadata jsonb default '{}'::jsonb,
 changed_at timestamp with time zone default now()
);
create table sales_core.opportunities (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 opportunity_key text default ('manual-'::text || (gen_random_uuid())::text),
 contact_id uuid,
 course_id uuid,
 stage_id uuid,
 owner_staff_id uuid,
 title text,
 value_minor bigint default 0,
 currency text default 'SAR'::text,
 expected_close_date date,
 next_action_type text,
 next_action_at timestamp with time zone,
 status text default 'open'::text,
 lost_reason text,
 created_by_subject_id uuid,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table sales_core.pipeline_stages (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 stage_key text,
 name_ar text,
 name_en text,
 position integer default 0,
 probability_percent integer default 0,
 is_closed boolean default false,
 is_won boolean default false,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);
create table work_core.tasks (
 id uuid default gen_random_uuid() primary key,
 tenant_id uuid,
 task_key text default ('manual-'::text || (gen_random_uuid())::text),
 title text,
 description text,
 status text default 'todo'::text,
 priority text default 'normal'::text,
 assigned_staff_id uuid,
 created_by_subject_id uuid,
 contact_id uuid,
 opportunity_id uuid,
 activity_id uuid,
 starts_at timestamp with time zone,
 due_at timestamp with time zone,
 completed_at timestamp with time zone,
 completion_timing text,
 metadata jsonb default '{}'::jsonb,
 created_at timestamp with time zone default now(),
 updated_at timestamp with time zone default now()
);

alter table sales_core.contacts add unique(tenant_id,id);
alter table sales_core.contact_identities add unique(tenant_id,identity_type,identity_value);
alter table sales_core.contact_identities add constraint contact_identities_source_slot_check
  check(source_slot in ('phone','whatsapp','email','historical_alias','merged_alias'));
alter table academy.registration_handoffs add unique(tenant_id,handoff_key);
alter table academy.registration_documents add unique(handoff_id,document_type);
alter table work_core.tasks add unique(tenant_id,task_key);
create table private_app.audit_fixture(event text,tenant_id uuid,payload jsonb);
create function private_app.current_subject_id() returns uuid language sql stable as $$
 select nullif(current_setting('fixture.subject',true),'')::uuid $$;
create function private_app.current_staff_id(t uuid) returns uuid language sql stable as $$
 select nullif(current_setting('fixture.staff',true),'')::uuid $$;
create function private_app.has_tenant_permission(t uuid,p text) returns boolean language sql stable as $$
 select coalesce(t::text=current_setting('fixture.tenant',true),false) and
   coalesce(current_setting('fixture.deny',true),'')<>p and private_app.current_subject_id() is not null $$;
create function private_app.can_view_tenant_team(t uuid) returns boolean language sql stable as $$
 select coalesce(current_setting('fixture.team',true),'no')='yes' $$;
create function private_app.write_audit(event text,entity text,entity_id text,tenant uuid,payload jsonb)
 returns void language sql as $$insert into private_app.audit_fixture values(event,tenant,payload) $$;
create function private_app.fixture_updated_at() returns trigger language plpgsql as $$
 begin new.updated_at=clock_timestamp(); return new; end $$;
create trigger contact_updated_at before update on sales_core.contacts for each row execute function private_app.fixture_updated_at();
create function public.v4_tenant_customer_history_snapshot(p_slug text,p_contact_id uuid,p_limit integer)
 returns jsonb language plpgsql security definer as $$
 declare t uuid; begin select tenant_id into t from sales_core.contacts where id=p_contact_id;
 if not private_app.has_tenant_permission(t,'tenant.crm.read') then raise exception 'forbidden'; end if;
 return jsonb_build_object('contact',jsonb_build_object('id',p_contact_id),'summary','{}'::jsonb,'events','[]'::jsonb); end $$;
CREATE OR REPLACE FUNCTION private_app.normalize_lead_phone(p_value text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  v_digits text;
begin
  v_digits := pg_catalog.translate(
    coalesce(p_value, ''),
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
    '01234567890123456789'
  );
  v_digits := pg_catalog.regexp_replace(v_digits, '[^0-9]', '', 'g');

  if v_digits like '00%' then
    v_digits := pg_catalog.substr(v_digits, 3);
  end if;

  if v_digits ~ '^(9660?|996)5[0-9]{8}$' then
    return '966' || pg_catalog.right(v_digits, 9);
  end if;
  if v_digits ~ '^05[0-9]{8}$' then
    return '966' || pg_catalog.substr(v_digits, 2);
  end if;
  if v_digits ~ '^5[0-9]{8}$' then
    return '966' || v_digits;
  end if;
  if pg_catalog.length(v_digits) = 10 and v_digits like '0%' then
    return '966' || pg_catalog.substr(v_digits, 2);
  end if;
  if pg_catalog.length(v_digits) between 8 and 15 then
    return v_digits;
  end if;
  return null;
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
create trigger prepare_contact before insert or update of phone,whatsapp,email on sales_core.contacts for each row execute function private_app.prepare_contact_identity_fields();
create trigger sync_contact after insert or update of phone,whatsapp,email on sales_core.contacts for each row execute function private_app.sync_contact_identities();
CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v2(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_preferred_start_date date DEFAULT NULL::date, p_closure_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_followup_task work_core.tasks%rowtype;
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
    'phone_off',
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
    'phone_off',
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
    when p_lead_status in ('no_answer', 'busy', 'phone_off', 'follow_up', 'postponed')
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

  select task.*
  into v_followup_task
  from work_core.tasks task
  where task.tenant_id = v_tenant_id
    and task.contact_id = p_contact_id
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
  order by task.due_at desc, task.created_at desc, task.id
  limit 1
  for update;

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
    jsonb_strip_nulls(jsonb_build_object(
      'model',
      'lead_centric',
      'reopened',
      v_reopened,
      'scheduledTaskId',
      v_followup_task.id,
      'scheduledAt',
      v_followup_task.due_at,
      'taskUpdateMode',
      case
        when v_followup_task.id is null then 'created'
        else 'updated'
      end
    ))
  )
  returning id into v_activity_id;

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
    if v_followup_task.id is not null then
      update work_core.tasks
      set title = 'متابعة: ' || v_contact.full_name,
          description = 'الحالة: ' || p_lead_status
            || ' · الإجراء التالي: ' || p_next_action_type,
          priority = case
            when p_lead_status in ('very_interested', 'awaiting_payment')
              then 'high'
            else 'normal'
          end,
          status = 'todo',
          assigned_staff_id = coalesce(
            v_contact.owner_staff_id,
            v_current_staff_id
          ),
          opportunity_id = v_opportunity.id,
          activity_id = v_activity_id,
          due_at = p_next_action_at,
          completed_at = null,
          completion_timing = null,
          metadata = (
            metadata
            - 'resolvedByActivityId'
            - 'completedBySubjectId'
            - 'cancelReason'
          ) || jsonb_build_object(
            'source', 'sales_followup',
            'actionType', p_next_action_type,
            'leadStatus', p_lead_status,
            'leadQuality', p_lead_quality,
            'taskUpdateMode', 'single_record',
            'lastMovedAt', now()
          )
      where id = v_followup_task.id
        and tenant_id = v_tenant_id
      returning id into v_task_id;
    else
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
          'leadQuality', p_lead_quality,
          'taskUpdateMode', 'single_record'
        )
      )
      returning id into v_task_id;
    end if;
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
      'taskUpdated',
      v_is_open and v_followup_task.id is not null,
      'previousDueAt',
      v_followup_task.due_at,
      'nextDueAt',
      case when v_is_open then p_next_action_at else null end,
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
    'taskUpdated',
    v_is_open and v_followup_task.id is not null,
    'previousDueAt',
    v_followup_task.due_at,
    'nextDueAt',
    case when v_is_open then p_next_action_at else null end,
    'handoffId',
    v_handoff_id,
    'paymentReviewNotified',
    v_handoff_id is not null
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v5(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_preferred_start_date date DEFAULT NULL::date, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_selected_task work_core.tasks%rowtype;
  v_result jsonb;
  v_result_task_id uuid;
  v_lead_status text := p_lead_status;
  v_lead_quality text := coalesce(p_lead_quality, 'unrated');
  v_closure_reason text := p_closure_reason;
  v_normalized boolean := false;
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

  if v_lead_quality = 'unqualified'
     and v_lead_status in (
       'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
       'interested', 'very_interested', 'awaiting_payment', 'postponed'
     )
  then
    v_lead_status := 'unqualified';
    v_closure_reason := coalesce(
      nullif(trim(v_closure_reason), ''),
      'جودة العميل غير مؤهل'
    );
    v_normalized := true;
  elsif v_lead_status = 'unqualified'
        and v_lead_quality <> 'unqualified'
  then
    v_lead_quality := 'unqualified';
    v_normalized := true;
  elsif v_lead_quality = 'unqualified'
        and v_lead_status in ('payment_submitted', 'paid')
  then
    raise exception 'unqualified_quality_requires_closed_status';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_tenant_id::text || ':' || p_contact_id::text,
      31603
    )
  );

  perform contact.id
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if not found then raise exception 'invalid_contact'; end if;

  if p_task_id is not null then
    select task.*
    into v_selected_task
    from work_core.tasks task
    where task.id = p_task_id
      and task.tenant_id = v_tenant_id
      and task.contact_id = p_contact_id
      and task.status in ('todo', 'in_progress')
      and coalesce(task.metadata ->> 'source', '') in (
        'lead_assignment',
        'opportunity_next_action',
        'activity_next_action',
        'lead_next_action',
        'sales_followup'
      )
    for update;

    if v_selected_task.id is null then
      raise exception 'task_not_followup';
    end if;
  end if;

  v_result := public.v2_tenant_record_sales_followup_v4(
    p_tenant_slug => p_tenant_slug,
    p_contact_id => p_contact_id,
    p_activity_type => p_activity_type,
    p_summary => p_summary,
    p_lead_status => v_lead_status,
    p_lead_quality => v_lead_quality,
    p_next_action_type => case
      when v_lead_status in (
        'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
        'interested', 'very_interested', 'awaiting_payment', 'postponed'
      ) then p_next_action_type
      else null
    end,
    p_next_action_at => case
      when v_lead_status in (
        'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
        'interested', 'very_interested', 'awaiting_payment', 'postponed'
      ) then p_next_action_at
      else null
    end,
    p_course_id => p_course_id,
    p_course_run_id => p_course_run_id,
    p_payment_amount_minor => p_payment_amount_minor,
    p_payment_reference => p_payment_reference,
    p_preferred_start_date => p_preferred_start_date,
    p_closure_reason => v_closure_reason,
    p_contact_name => p_contact_name
  );

  if p_task_id is not null then
    v_result_task_id := nullif(coalesce(
      v_result ->> 'followupTaskId',
      v_result ->> 'taskId'
    ), '')::uuid;
    if v_result_task_id is distinct from p_task_id then
      raise exception 'task_transition_conflict';
    end if;
  end if;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'selectedTaskId', p_task_id,
    'taskUpdateMode', 'bound_task_id_v5',
    'lifecycleNormalized', v_normalized,
    'normalizedLeadStatus', case when v_normalized then v_lead_status end,
    'normalizedLeadQuality', case when v_normalized then v_lead_quality end
  ));
end;
$function$
;
CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v3(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_preferred_start_date date DEFAULT NULL::date, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_clean_name text;
  v_name_changed boolean;
  v_result jsonb;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then
    raise exception 'forbidden';
  end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then
    raise exception 'invalid_contact';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  if p_contact_name is null then
    v_clean_name := v_contact.full_name;
  else
    v_clean_name := nullif(btrim(p_contact_name), '');
    if v_clean_name is null or length(v_clean_name) < 2 then
      raise exception 'contact_name_required';
    end if;
    if length(v_clean_name) > 150 then
      raise exception 'contact_name_too_long';
    end if;
  end if;

  v_name_changed := v_contact.full_name is distinct from v_clean_name;
  if v_name_changed then
    update sales_core.contacts
    set full_name = v_clean_name
    where id = v_contact.id
      and tenant_id = v_tenant_id;
  end if;

  v_result := public.v2_tenant_record_sales_followup_v2(
    p_tenant_slug => p_tenant_slug,
    p_contact_id => p_contact_id,
    p_activity_type => p_activity_type,
    p_summary => p_summary,
    p_lead_status => p_lead_status,
    p_lead_quality => p_lead_quality,
    p_next_action_type => p_next_action_type,
    p_next_action_at => p_next_action_at,
    p_course_id => p_course_id,
    p_course_run_id => p_course_run_id,
    p_payment_amount_minor => p_payment_amount_minor,
    p_payment_reference => p_payment_reference,
    p_preferred_start_date => p_preferred_start_date,
    p_closure_reason => p_closure_reason
  );

  if v_name_changed then
    perform private_app.write_audit(
      'tenant.sales_contact_name_updated',
      'sales_contact',
      p_contact_id::text,
      v_tenant_id,
      jsonb_build_object(
        'oldName', v_contact.full_name,
        'newName', v_clean_name,
        'source', 'sales_followup'
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'contactName', v_clean_name,
    'nameUpdated', v_name_changed
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v4(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_preferred_start_date date DEFAULT NULL::date, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_is_open boolean;
  v_followup_task work_core.tasks%rowtype;
  v_previous_due_at timestamptz;
  v_result jsonb;
  v_activity_id uuid;
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
  if p_lead_status not in (
    'new',
    'no_answer',
    'busy',
    'phone_off',
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

  select contact.*
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then raise exception 'invalid_contact'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_current_staff_id
  then
    raise exception 'forbidden';
  end if;

  v_is_open := p_lead_status in (
    'new',
    'no_answer',
    'busy',
    'phone_off',
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

  select task.*
  into v_followup_task
  from work_core.tasks task
  where task.tenant_id = v_tenant_id
    and task.contact_id = p_contact_id
    and coalesce(task.metadata ->> 'source', '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
  order by
    (task.status in ('todo', 'in_progress')) desc,
    (
      v_contact.next_action_at is not null
      and task.due_at = v_contact.next_action_at
    ) desc,
    (task.metadata ->> 'source' = 'sales_followup') desc,
    task.updated_at desc,
    task.id
  limit 1
  for update;

  v_previous_due_at := v_followup_task.due_at;

  if v_is_open and v_followup_task.id is not null then
    update work_core.tasks
    set status = 'todo',
        due_at = p_next_action_at,
        completed_at = null,
        completion_timing = null,
        metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
          'source', 'sales_followup',
          'originalSource', coalesce(
            metadata ->> 'originalSource',
            metadata ->> 'source'
          ),
          'taskUpdateMode', 'single_calendar_record_v2'
        ))
    where id = v_followup_task.id
      and tenant_id = v_tenant_id;
  end if;

  v_result := public.v2_tenant_record_sales_followup_v3(
    p_tenant_slug => p_tenant_slug,
    p_contact_id => p_contact_id,
    p_activity_type => p_activity_type,
    p_summary => p_summary,
    p_lead_status => p_lead_status,
    p_lead_quality => p_lead_quality,
    p_next_action_type => p_next_action_type,
    p_next_action_at => p_next_action_at,
    p_course_id => p_course_id,
    p_course_run_id => p_course_run_id,
    p_payment_amount_minor => p_payment_amount_minor,
    p_payment_reference => p_payment_reference,
    p_preferred_start_date => p_preferred_start_date,
    p_closure_reason => p_closure_reason,
    p_contact_name => p_contact_name
  );

  v_activity_id := nullif(v_result ->> 'id', '')::uuid;

  if v_followup_task.id is not null then
    update sales_core.activities activity
    set metadata = activity.metadata || jsonb_strip_nulls(jsonb_build_object(
          'scheduledTaskId', v_followup_task.id,
          'scheduledAt', v_previous_due_at,
          'taskUpdateMode', 'single_calendar_record_v2'
        ))
    where activity.id = v_activity_id
      and activity.tenant_id = v_tenant_id;
  end if;

  if not v_is_open and v_followup_task.id is not null then
    update work_core.tasks task
    set status = 'completed',
        activity_id = v_activity_id,
        completed_at = now(),
        completion_timing = case
          when v_previous_due_at < now() then 'late'
          else 'on_time'
        end,
        metadata = (
          task.metadata - 'cancelReason'
        ) || jsonb_strip_nulls(jsonb_build_object(
          'resolvedByActivityId', v_activity_id,
          'completedBySubjectId', private_app.current_subject_id(),
          'taskUpdateMode', 'single_calendar_record_v2',
          'lastResolvedAt', now(),
          'lastTransition', jsonb_build_object(
            'fromStatus', task.status,
            'toStatus', 'completed',
            'fromDueAt', task.due_at,
            'toDueAt', task.due_at,
            'actorSubjectId', private_app.current_subject_id(),
            'at', now(),
            'mode', 'sales_followup_terminal_v2',
            'note', 'إغلاق مهمة المبيعات بعد تسجيل نتيجة نهائية'
          )
        ))
    where task.id = v_followup_task.id
      and task.tenant_id = v_tenant_id
      and task.status in ('todo', 'in_progress');
  end if;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'followupTaskId', coalesce(
      case when v_is_open then v_result ->> 'taskId' end,
      v_followup_task.id::text
    ),
    'taskClosed', not v_is_open and v_followup_task.id is not null,
    'previousDueAt', v_previous_due_at,
    'nextDueAt', case when v_is_open then p_next_action_at end
  ));
end;
$function$
;

create or replace function private_app.format_customer_phone(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_original text;
  v_identity text;
begin
  v_original := nullif(pg_catalog.btrim(coalesce(p_value, '')), '');
  if v_original is null then
    return null;
  end if;

  v_identity := private_app.normalize_lead_phone(v_original);
  if v_identity is null then
    return null;
  end if;

  if v_identity ~ '^9665[0-9]{8}$' then
    return '0' || pg_catalog.right(v_identity, 9);
  end if;

  -- A non-Saudi number keeps its country code and entered representation.
  return v_original;
end;
$$;
