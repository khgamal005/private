begin;

create schema if not exists automation_engine;

revoke all on schema automation_engine
from public, anon, authenticated;

create table automation_engine.rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  rule_key text not null
    check (rule_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  name_ar text not null,
  description_ar text,
  trigger_key text not null
    check (
      trigger_key in (
        'payment_confirmed',
        'enrollment_created',
        'joining_instructions',
        'session_reminder_24h',
        'session_reminder_1h',
        'absence_recorded',
        'certificate_issued',
        'session_rescheduled'
      )
    ),
  template_key text not null,
  status text not null default 'active'
    check (status in ('draft', 'active', 'paused')),
  execution_mode text not null default 'live'
    check (execution_mode in ('live', 'preview')),
  primary_channel text not null default 'auto'
    check (primary_channel in ('auto', 'whatsapp', 'email')),
  fallback_channel text not null default 'email'
    check (fallback_channel in ('none', 'whatsapp', 'email')),
  delay_minutes integer not null default 0
    check (delay_minutes between 0 and 43200),
  condition_config jsonb not null default '{}'::jsonb,
  action_config jsonb not null default '{}'::jsonb,
  priority integer not null default 100
    check (priority between 1 and 1000),
  is_system boolean not null default false,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, rule_key)
);

create table automation_engine.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  event_key text not null,
  source_type text not null,
  source_id text not null,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'processing',
        'completed',
        'ignored',
        'failed'
      )
    ),
  attempts integer not null default 0
    check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table automation_engine.runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  event_id uuid not null
    references automation_engine.events(id) on delete cascade,
  rule_id uuid not null
    references automation_engine.rules(id) on delete cascade,
  status text not null default 'processing'
    check (
      status in (
        'processing',
        'previewed',
        'queued',
        'skipped',
        'completed',
        'failed'
      )
    ),
  action_count integer not null default 0
    check (action_count >= 0),
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, rule_id)
);

create table communication_hub.message_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  automation_run_id uuid
    references automation_engine.runs(id) on delete set null,
  event_id uuid
    references automation_engine.events(id) on delete set null,
  dedupe_key text not null,
  template_key text not null,
  channel text not null
    check (channel in ('whatsapp', 'email')),
  fallback_channel text
    check (
      fallback_channel is null
      or fallback_channel in ('whatsapp', 'email')
    ),
  recipient text not null,
  fallback_recipient text,
  subject text,
  message_text text not null
    check (length(trim(message_text)) between 10 and 5000),
  due_at timestamptz not null default now(),
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'processing',
        'sent',
        'simulated',
        'failed',
        'waiting_configuration',
        'fallback_queued',
        'cancelled'
      )
    ),
  attempts integer not null default 0
    check (attempts >= 0),
  max_attempts integer not null default 3
    check (max_attempts between 1 and 10),
  provider_connection_id uuid
    references communication_hub.provider_connections(id)
    on delete set null,
  provider_key text,
  external_id text,
  external_url text,
  last_error text,
  locked_at timestamptz,
  processed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

create index automation_rules_tenant_status_idx
on automation_engine.rules (
  tenant_id,
  status,
  trigger_key,
  priority
);

create index automation_rules_creator_reference_idx
on automation_engine.rules (created_by_subject_id)
where created_by_subject_id is not null;

create index automation_rules_updater_reference_idx
on automation_engine.rules (updated_by_subject_id)
where updated_by_subject_id is not null;

create index automation_events_claim_idx
on automation_engine.events (
  status,
  available_at,
  occurred_at
)
where status in ('pending', 'failed', 'processing');

create index automation_events_tenant_time_idx
on automation_engine.events (
  tenant_id,
  occurred_at desc
);

create index automation_runs_tenant_time_idx
on automation_engine.runs (
  tenant_id,
  created_at desc
);

create index automation_runs_rule_reference_idx
on automation_engine.runs (rule_id);

create index message_outbox_claim_idx
on communication_hub.message_outbox (
  status,
  due_at,
  created_at
)
where status in (
  'pending',
  'failed',
  'waiting_configuration',
  'processing'
);

create index message_outbox_tenant_time_idx
on communication_hub.message_outbox (
  tenant_id,
  created_at desc
);

create index message_outbox_run_reference_idx
on communication_hub.message_outbox (automation_run_id)
where automation_run_id is not null;

create index message_outbox_event_reference_idx
on communication_hub.message_outbox (event_id)
where event_id is not null;

create index message_outbox_provider_reference_idx
on communication_hub.message_outbox (provider_connection_id)
where provider_connection_id is not null;

create trigger automation_rules_set_updated_at
before update on automation_engine.rules
for each row execute function private_app.set_updated_at();

create trigger message_outbox_set_updated_at
before update on communication_hub.message_outbox
for each row execute function private_app.set_updated_at();

alter table automation_engine.rules enable row level security;
alter table automation_engine.events enable row level security;
alter table automation_engine.runs enable row level security;
alter table communication_hub.message_outbox enable row level security;

create policy automation_rules_isolated_read
on automation_engine.rules
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy automation_events_isolated_read
on automation_engine.events
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy automation_runs_isolated_read
on automation_engine.runs
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy message_outbox_isolated_read
on communication_hub.message_outbox
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on all tables in schema automation_engine
from public, anon, authenticated;

revoke all on all sequences in schema automation_engine
from public, anon, authenticated;

revoke all on table communication_hub.message_outbox
from public, anon, authenticated;

alter default privileges in schema automation_engine
revoke all on tables from public, anon, authenticated;

alter default privileges in schema automation_engine
revoke all on sequences from public, anon, authenticated;

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
values (
  'addon.automation.rules',
  'محرك الأتمتة الذكي',
  'Smart Automation Rules',
  'addon',
  'boolean',
  'false'::jsonb,
  'beta'
)
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    status = excluded.status,
    updated_at = now();

insert into catalog.plan_features (plan_id, feature_id, value)
select plan.id, feature.id, 'true'::jsonb
from catalog.plans plan
join catalog.features feature
  on feature.feature_key = 'addon.automation.rules'
where plan.plan_key = 'full'
on conflict (plan_id, feature_id) do update
set value = excluded.value,
    updated_at = now();

insert into communication_hub.message_templates (
  tenant_id,
  template_key,
  event_key,
  channel,
  name_ar,
  description_ar,
  subject_template,
  body_template,
  default_subject_template,
  default_body_template,
  locale,
  variables,
  status,
  is_system
)
select
  tenant.id,
  template.template_key,
  template.event_key,
  'any',
  template.name_ar,
  template.description_ar,
  template.subject_template,
  template.body_template,
  template.subject_template,
  template.body_template,
  'ar',
  template.variables,
  'active',
  true
from core.tenants tenant
cross join (
  values
    (
      'absence_followup'::text,
      'training.attendance.absent'::text,
      'متابعة الغياب'::text,
      'متابعة المتدرب بعد تسجيل الغياب.'::text,
      'متابعة غيابك عن {{course}}'::text,
      E'مرحبًا {{name}}،\nتم تسجيل غيابك عن {{session}} بتاريخ {{date}}.\nإذا كان لديك عذر أو تحتاج مساعدة، تواصل مع فريق {{center}}.\nموعد الجلسة التالية أو رابط المتابعة: {{link}}'::text,
      array['name','course','session','date','center','link']::text[]
    ),
    (
      'absence_manager_alert'::text,
      'training.attendance.manager_alert'::text,
      'تنبيه مدير التدريب بالغياب'::text,
      'تنبيه داخلي لمدير التدريب عند غياب متدرب.'::text,
      'غياب يحتاج متابعة — {{name}}'::text,
      E'تم تسجيل غياب المتدرب {{name}} عن {{session}} في دورة {{course}}.\nالدفعة: {{batch}}\nالتاريخ: {{date}}\nيرجى مراجعة الحالة واتخاذ الإجراء المناسب.'::text,
      array['name','course','session','batch','date']::text[]
    )
) template(
  template_key,
  event_key,
  name_ar,
  description_ar,
  subject_template,
  body_template,
  variables
)
where tenant.status in ('trial', 'active')
on conflict (tenant_id, template_key, channel) do nothing;

create or replace function private_app.ensure_automation_rules(
  p_tenant_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private_app.tenant_addon_enabled(
    p_tenant_id,
    'addon.automation.rules'
  ) then return; end if;

  insert into automation_engine.rules (
    tenant_id,
    rule_key,
    name_ar,
    description_ar,
    trigger_key,
    template_key,
    status,
    execution_mode,
    primary_channel,
    fallback_channel,
    delay_minutes,
    condition_config,
    action_config,
    priority,
    is_system
  )
  select
    p_tenant_id,
    source.rule_key,
    source.name_ar,
    source.description_ar,
    source.trigger_key,
    source.template_key,
    'active',
    'live',
    source.primary_channel,
    source.fallback_channel,
    source.delay_minutes,
    '{}'::jsonb,
    source.action_config,
    source.priority,
    true
  from (
    values
      (
        'payment_confirmation',
        'تأكيد الدفع',
        'عند اعتماد الدفع أرسل تأكيدًا للعميل.',
        'payment_confirmed',
        'payment_confirmed',
        'auto',
        'email',
        0,
        '{}'::jsonb,
        10
      ),
      (
        'registration_confirmation',
        'تأكيد التسجيل',
        'عند إنشاء التسجيل أرسل بيانات الدفعة.',
        'enrollment_created',
        'registration_confirmed',
        'auto',
        'email',
        0,
        '{}'::jsonb,
        20
      ),
      (
        'joining_instructions',
        'تعليمات الانضمام',
        'عند إلحاق المتدرب جهز رسالة الانضمام.',
        'joining_instructions',
        'joining_instructions',
        'auto',
        'email',
        0,
        jsonb_build_object('legacySetting', 'joining_enabled'),
        30
      ),
      (
        'session_reminder_24h',
        'تذكير قبل 24 ساعة',
        'جهز تذكير الجلسة قبل يوم.',
        'session_reminder_24h',
        'session_reminder_24h',
        'auto',
        'email',
        0,
        jsonb_build_object('legacySetting', 'reminder_24h_enabled'),
        40
      ),
      (
        'session_reminder_1h',
        'تذكير قبل ساعة',
        'جهز تذكيرًا أخيرًا قبل الجلسة بساعة.',
        'session_reminder_1h',
        'session_reminder_1h',
        'auto',
        'email',
        0,
        jsonb_build_object('legacySetting', 'reminder_1h_enabled'),
        50
      ),
      (
        'absence_followup',
        'متابعة الغياب',
        'أرسل متابعة للمتدرب وتنبيهًا لمدير التدريب.',
        'absence_recorded',
        'absence_followup',
        'auto',
        'email',
        0,
        jsonb_build_object('notifyManager', true),
        60
      ),
      (
        'certificate_delivery',
        'إرسال الشهادة',
        'عند إصدار الشهادة أرسل رابطها للمتدرب.',
        'certificate_issued',
        'certificate_ready',
        'auto',
        'email',
        0,
        '{}'::jsonb,
        70
      ),
      (
        'schedule_change_notice',
        'إشعار تغيير الموعد',
        'أخطر كل متدرب يتأثر بتغيير جلسة.',
        'session_rescheduled',
        'schedule_changed',
        'auto',
        'email',
        0,
        '{}'::jsonb,
        80
      )
  ) source(
    rule_key,
    name_ar,
    description_ar,
    trigger_key,
    template_key,
    primary_channel,
    fallback_channel,
    delay_minutes,
    action_config,
    priority
  )
  on conflict (tenant_id, rule_key) do nothing;
end;
$$;

revoke all on function private_app.ensure_automation_rules(uuid)
from public, anon, authenticated;

select private_app.ensure_automation_rules(tenant.id)
from core.tenants tenant
where tenant.status in ('trial', 'active');

create or replace function private_app.queue_automation_event(
  p_tenant_id uuid,
  p_event_key text,
  p_source_type text,
  p_source_id text,
  p_idempotency_key text,
  p_payload jsonb,
  p_available_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  if not private_app.tenant_addon_enabled(
    p_tenant_id,
    'addon.automation.rules'
  ) then return null; end if;

  perform private_app.ensure_automation_rules(p_tenant_id);

  insert into automation_engine.events (
    tenant_id,
    event_key,
    source_type,
    source_id,
    idempotency_key,
    payload,
    available_at
  )
  values (
    p_tenant_id,
    p_event_key,
    p_source_type,
    p_source_id,
    p_idempotency_key,
    coalesce(p_payload, '{}'::jsonb),
    coalesce(p_available_at, now())
  )
  on conflict (tenant_id, idempotency_key) do update
  set payload = excluded.payload,
      available_at = least(
        automation_engine.events.available_at,
        excluded.available_at
      )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function private_app.queue_automation_event(
  uuid,
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz
) from public, anon, authenticated;

create or replace function private_app.payment_automation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact sales_core.contacts%rowtype;
  v_course academy.courses%rowtype;
  v_run academy.course_runs%rowtype;
  v_tenant core.tenants%rowtype;
begin
  if new.payment_status <> 'verified'
     or old.payment_status = 'verified' then
    return new;
  end if;

  select * into v_contact
  from sales_core.contacts contact
  where contact.id = new.contact_id;
  select * into v_course
  from academy.courses course
  where course.id = new.course_id;
  select * into v_run
  from academy.course_runs run
  where run.id = new.course_run_id;
  select * into v_tenant
  from core.tenants tenant
  where tenant.id = new.tenant_id;

  perform private_app.queue_automation_event(
    new.tenant_id,
    'payment_confirmed',
    'registration_handoff',
    new.id::text,
    'payment-confirmed:' || new.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'handoffId', new.id,
      'courseRunId', new.course_run_id,
      'recipientPhone', coalesce(v_contact.whatsapp, v_contact.phone),
      'recipientEmail', v_contact.email,
      'templateValues', jsonb_build_object(
        'name', coalesce(v_contact.full_name, 'المتدرب'),
        'course', coalesce(v_course.title_ar, 'البرنامج التدريبي'),
        'batch', coalesce(v_run.title, v_run.run_code, 'يحدد لاحقًا'),
        'date', coalesce(
          to_char(
            v_run.starts_at at time zone v_tenant.timezone,
            'YYYY-MM-DD'
          ),
          'يحدد لاحقًا'
        ),
        'time', coalesce(
          to_char(
            v_run.starts_at at time zone v_tenant.timezone,
            'HH24:MI'
          ),
          'يحدد لاحقًا'
        ),
        'link', coalesce(v_run.venue_or_link, 'سيحدد لاحقًا'),
        'amount',
          coalesce(
            trim(to_char(
              new.payment_amount_minor::numeric / 100,
              'FM999999990.00'
            )) || ' ر.س',
            '—'
          ),
        'center', v_tenant.name
      )
    )),
    now()
  );
  return new;
end;
$$;

create trigger registration_handoffs_payment_automation_event
after update of payment_status
on academy.registration_handoffs
for each row execute function private_app.payment_automation_event();

create or replace function private_app.enrollment_automation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student academy.students%rowtype;
  v_course academy.courses%rowtype;
  v_run academy.course_runs%rowtype;
  v_tenant core.tenants%rowtype;
begin
  if new.status not in ('confirmed', 'active') then return new; end if;

  select * into v_student
  from academy.students student
  where student.id = new.student_id;
  select * into v_course
  from academy.courses course
  where course.id = new.course_id;
  select * into v_run
  from academy.course_runs run
  where run.id = new.course_run_id;
  select * into v_tenant
  from core.tenants tenant
  where tenant.id = new.tenant_id;

  perform private_app.queue_automation_event(
    new.tenant_id,
    'enrollment_created',
    'enrollment',
    new.id::text,
    'enrollment-created:' || new.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'enrollmentId', new.id,
      'courseRunId', new.course_run_id,
      'recipientPhone', v_student.phone,
      'recipientEmail', v_student.email,
      'templateValues', jsonb_build_object(
        'name', v_student.full_name,
        'course', v_course.title_ar,
        'batch', coalesce(v_run.title, v_run.run_code),
        'date', to_char(
          v_run.starts_at at time zone v_tenant.timezone,
          'YYYY-MM-DD'
        ),
        'time', to_char(
          v_run.starts_at at time zone v_tenant.timezone,
          'HH24:MI'
        ),
        'link', coalesce(v_run.venue_or_link, 'سيحدد لاحقًا'),
        'delivery_mode', v_run.delivery_mode,
        'center', v_tenant.name
      )
    )),
    now()
  );
  return new;
end;
$$;

create trigger enrollments_automation_event
after insert on academy.enrollments
for each row execute function private_app.enrollment_automation_event();

create or replace function private_app.absence_automation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student academy.students%rowtype;
  v_course academy.courses%rowtype;
  v_run academy.course_runs%rowtype;
  v_session academy.course_run_sessions%rowtype;
  v_tenant core.tenants%rowtype;
begin
  if new.status <> 'absent'
     or (tg_op = 'UPDATE' and old.status = 'absent') then
    return new;
  end if;

  select student.* into v_student
  from academy.enrollments enrollment
  join academy.students student on student.id = enrollment.student_id
  where enrollment.id = new.enrollment_id;
  select * into v_run from academy.course_runs run
  where run.id = new.course_run_id;
  select * into v_course from academy.courses course
  where course.id = v_run.course_id;
  select * into v_session from academy.course_run_sessions session
  where session.id = new.session_id;
  select * into v_tenant from core.tenants tenant
  where tenant.id = new.tenant_id;

  perform private_app.queue_automation_event(
    new.tenant_id,
    'absence_recorded',
    'attendance_record',
    new.id::text,
    'absence:' || new.id::text || ':'
      || extract(epoch from new.updated_at)::bigint::text,
    jsonb_strip_nulls(jsonb_build_object(
      'attendanceId', new.id,
      'enrollmentId', new.enrollment_id,
      'courseRunId', new.course_run_id,
      'sessionId', new.session_id,
      'recipientPhone', v_student.phone,
      'recipientEmail', v_student.email,
      'templateValues', jsonb_build_object(
        'name', v_student.full_name,
        'course', v_course.title_ar,
        'batch', coalesce(v_run.title, v_run.run_code),
        'session', v_session.title,
        'date', to_char(
          v_session.starts_at at time zone v_tenant.timezone,
          'YYYY-MM-DD HH24:MI'
        ),
        'link', coalesce(
          v_session.meeting_join_url,
          v_session.venue_or_link,
          v_run.venue_or_link,
          'تواصل مع إدارة التدريب'
        ),
        'center', v_tenant.name
      )
    )),
    now()
  );
  return new;
end;
$$;

create trigger attendance_records_automation_event
after insert or update of status
on academy.attendance_records
for each row execute function private_app.absence_automation_event();

create or replace function private_app.certificate_automation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student academy.students%rowtype;
  v_course academy.courses%rowtype;
  v_run academy.course_runs%rowtype;
  v_tenant core.tenants%rowtype;
begin
  if new.status <> 'issued' then return new; end if;

  select student.* into v_student
  from academy.enrollments enrollment
  join academy.students student on student.id = enrollment.student_id
  where enrollment.id = new.enrollment_id;
  select * into v_run from academy.course_runs run
  where run.id = new.course_run_id;
  select * into v_course from academy.courses course
  where course.id = v_run.course_id;
  select * into v_tenant from core.tenants tenant
  where tenant.id = new.tenant_id;

  perform private_app.queue_automation_event(
    new.tenant_id,
    'certificate_issued',
    'certificate',
    new.id::text,
    'certificate-issued:' || new.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'certificateId', new.id,
      'enrollmentId', new.enrollment_id,
      'courseRunId', new.course_run_id,
      'recipientPhone', v_student.phone,
      'recipientEmail', v_student.email,
      'templateValues', jsonb_build_object(
        'name', v_student.full_name,
        'course', v_course.title_ar,
        'batch', coalesce(v_run.title, v_run.run_code),
        'certificate_number', new.certificate_number,
        'certificate_link',
          '/tenant/' || v_tenant.slug
          || '/certificates/' || new.id::text,
        'center', v_tenant.name
      )
    )),
    now()
  );
  return new;
end;
$$;

create trigger certificates_automation_event
after insert on academy.certificates
for each row execute function private_app.certificate_automation_event();

create or replace function private_app.session_change_automation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enrollment record;
  v_course academy.courses%rowtype;
  v_run academy.course_runs%rowtype;
  v_tenant core.tenants%rowtype;
  v_change_hash text;
begin
  if new.starts_at is not distinct from old.starts_at
     and new.ends_at is not distinct from old.ends_at
     and new.venue_or_link is not distinct from old.venue_or_link
     and new.status is not distinct from old.status then
    return new;
  end if;
  if new.starts_at <= now() then return new; end if;

  select * into v_run from academy.course_runs run
  where run.id = new.course_run_id;
  select * into v_course from academy.courses course
  where course.id = v_run.course_id;
  select * into v_tenant from core.tenants tenant
  where tenant.id = new.tenant_id;
  v_change_hash := encode(digest(
    concat_ws(
      '|',
      new.starts_at::text,
      new.ends_at::text,
      new.venue_or_link,
      new.status
    ),
    'sha256'
  ), 'hex');

  for v_enrollment in
    select
      enrollment.id as enrollment_id,
      student.full_name,
      student.phone,
      student.email
    from academy.enrollments enrollment
    join academy.students student
      on student.id = enrollment.student_id
    where enrollment.course_run_id = new.course_run_id
      and enrollment.status in ('confirmed', 'active')
  loop
    perform private_app.queue_automation_event(
      new.tenant_id,
      'session_rescheduled',
      'course_run_session',
      new.id::text,
      'session-change:' || new.id::text || ':'
        || v_enrollment.enrollment_id::text || ':' || v_change_hash,
      jsonb_strip_nulls(jsonb_build_object(
        'sessionId', new.id,
        'enrollmentId', v_enrollment.enrollment_id,
        'courseRunId', new.course_run_id,
        'recipientPhone', v_enrollment.phone,
        'recipientEmail', v_enrollment.email,
        'templateValues', jsonb_build_object(
          'name', v_enrollment.full_name,
          'course', v_course.title_ar,
          'batch', coalesce(v_run.title, v_run.run_code),
          'session', new.title,
          'date', to_char(
            new.starts_at at time zone v_tenant.timezone,
            'YYYY-MM-DD'
          ),
          'time', to_char(
            new.starts_at at time zone v_tenant.timezone,
            'HH24:MI'
          ),
          'link', coalesce(
            new.meeting_join_url,
            new.venue_or_link,
            v_run.venue_or_link,
            'سيحدد لاحقًا'
          ),
          'center', v_tenant.name
        )
      )),
      now()
    );
  end loop;
  return new;
end;
$$;

create trigger course_run_sessions_change_automation_event
after update of starts_at, ends_at, venue_or_link, status
on academy.course_run_sessions
for each row execute function private_app.session_change_automation_event();

create or replace function private_app.sync_legacy_automation_rule(
  p_rule automation_engine.rules
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into academy.training_automation_settings (tenant_id)
  values (p_rule.tenant_id)
  on conflict (tenant_id) do nothing;

  if p_rule.rule_key = 'joining_instructions' then
    update academy.training_automation_settings
    set joining_enabled = p_rule.status = 'active'
    where tenant_id = p_rule.tenant_id;
  elsif p_rule.rule_key = 'session_reminder_24h' then
    update academy.training_automation_settings
    set reminder_24h_enabled = p_rule.status = 'active'
    where tenant_id = p_rule.tenant_id;
  elsif p_rule.rule_key = 'session_reminder_1h' then
    update academy.training_automation_settings
    set reminder_1h_enabled = p_rule.status = 'active'
    where tenant_id = p_rule.tenant_id;
  end if;
end;
$$;

revoke all on function private_app.sync_legacy_automation_rule(
  automation_engine.rules
) from public, anon, authenticated;

create or replace function private_app.process_automation_events(
  p_limit integer default 50,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event automation_engine.events%rowtype;
  v_rule automation_engine.rules%rowtype;
  v_run_id uuid;
  v_job_id uuid;
  v_manager_job_id uuid;
  v_values jsonb;
  v_channel text;
  v_fallback_channel text;
  v_recipient text;
  v_fallback_recipient text;
  v_subject text;
  v_body text;
  v_manager_email text;
  v_action_count integer;
  v_matched integer;
  v_events integer := 0;
  v_jobs integer := 0;
  v_previewed integer := 0;
  v_skipped integer := 0;
begin
  if p_limit < 1 or p_limit > 200 then
    raise exception 'invalid_event_limit';
  end if;

  for v_event in
    select event.*
    from automation_engine.events event
    where event.status in ('pending', 'failed')
      and event.available_at <= now()
      and event.attempts < 10
      and (p_tenant_id is null or event.tenant_id = p_tenant_id)
    order by event.available_at, event.occurred_at
    for update skip locked
    limit p_limit
  loop
    begin
      update automation_engine.events
      set status = 'processing',
          attempts = attempts + 1,
          last_error = null
      where id = v_event.id;
      v_events := v_events + 1;
      v_matched := 0;

      for v_rule in
        select rule.*
        from automation_engine.rules rule
        where rule.tenant_id = v_event.tenant_id
          and rule.trigger_key = v_event.event_key
          and rule.status = 'active'
        order by rule.priority, rule.created_at
      loop
        v_matched := v_matched + 1;
        v_run_id := null;
        v_job_id := null;
        v_manager_job_id := null;
        v_manager_email := null;
        v_action_count := 0;
        insert into automation_engine.runs (
          tenant_id,
          event_id,
          rule_id,
          status
        )
        values (
          v_event.tenant_id,
          v_event.id,
          v_rule.id,
          'processing'
        )
        on conflict (event_id, rule_id) do nothing
        returning id into v_run_id;
        if v_run_id is null then continue; end if;

        v_values := coalesce(
          v_event.payload -> 'templateValues',
          '{}'::jsonb
        );

        if v_rule.execution_mode = 'preview' then
          update automation_engine.runs
          set status = 'previewed',
              result = jsonb_build_object(
                'templateKey', v_rule.template_key,
                'values', v_values,
                'sent', false
              ),
              completed_at = now()
          where id = v_run_id;
          v_previewed := v_previewed + 1;
          continue;
        end if;

        v_channel := v_rule.primary_channel;
        if v_channel = 'auto' then
          select settings.primary_channel
          into v_channel
          from academy.training_automation_settings settings
          where settings.tenant_id = v_event.tenant_id;
          v_channel := coalesce(v_channel, 'whatsapp');
        end if;

        v_fallback_channel := nullif(v_rule.fallback_channel, 'none');
        if v_channel = 'whatsapp' then
          v_recipient := private_app.normalize_training_phone(
            v_event.payload ->> 'recipientPhone',
            coalesce((
              select settings.whatsapp_country_code
              from academy.training_automation_settings settings
              where settings.tenant_id = v_event.tenant_id
            ), '966')
          );
          v_fallback_recipient := case
            when v_fallback_channel = 'email'
              then nullif(v_event.payload ->> 'recipientEmail', '')
            else null
          end;
        else
          v_recipient := nullif(
            lower(v_event.payload ->> 'recipientEmail'),
            ''
          );
          v_fallback_recipient := case
            when v_fallback_channel = 'whatsapp'
              then private_app.normalize_training_phone(
                v_event.payload ->> 'recipientPhone',
                coalesce((
                  select settings.whatsapp_country_code
                  from academy.training_automation_settings settings
                  where settings.tenant_id = v_event.tenant_id
                ), '966')
              )
            else null
          end;
        end if;

        if v_recipient is null and v_fallback_recipient is not null then
          v_channel := v_fallback_channel;
          v_recipient := v_fallback_recipient;
          v_fallback_channel := null;
          v_fallback_recipient := null;
        end if;

        v_subject := private_app.message_template_field(
          v_event.tenant_id,
          v_rule.template_key,
          v_channel,
          'subject',
          v_values,
          v_rule.name_ar
        );
        v_body := private_app.message_template_field(
          v_event.tenant_id,
          v_rule.template_key,
          v_channel,
          'body',
          v_values,
          v_rule.description_ar
        );

        if v_recipient is null
           or nullif(trim(v_body), '') is null
           or length(trim(v_body)) < 10 then
          update automation_engine.runs
          set status = 'skipped',
              result = jsonb_build_object(
                'reason',
                case
                  when v_recipient is null
                    then 'recipient_channel_missing'
                  else 'message_template_missing'
                end,
                'sent', false
              ),
              completed_at = now()
          where id = v_run_id;
          v_skipped := v_skipped + 1;
          continue;
        end if;

        insert into communication_hub.message_outbox (
          tenant_id,
          automation_run_id,
          event_id,
          dedupe_key,
          template_key,
          channel,
          fallback_channel,
          recipient,
          fallback_recipient,
          subject,
          message_text,
          due_at,
          metadata
        )
        values (
          v_event.tenant_id,
          v_run_id,
          v_event.id,
          'automation:' || v_event.id::text || ':' || v_rule.id::text,
          v_rule.template_key,
          v_channel,
          case
            when v_fallback_recipient is not null
              then v_fallback_channel
            else null
          end,
          v_recipient,
          v_fallback_recipient,
          v_subject,
          v_body,
          now() + make_interval(mins => v_rule.delay_minutes),
          jsonb_strip_nulls(jsonb_build_object(
            'eventKey', v_event.event_key,
            'ruleKey', v_rule.rule_key,
            'templateValues', v_values,
            'courseRunId', v_event.payload ->> 'courseRunId',
            'enrollmentId', v_event.payload ->> 'enrollmentId',
            'sourceType', v_event.source_type,
            'sourceId', v_event.source_id
          ))
        )
        on conflict (tenant_id, dedupe_key) do update
        set due_at = least(
              communication_hub.message_outbox.due_at,
              excluded.due_at
            ),
            updated_at = now()
        returning id into v_job_id;
        v_action_count := 1;
        v_jobs := v_jobs + 1;

        if v_event.event_key = 'absence_recorded'
           and coalesce(
             (v_rule.action_config ->> 'notifyManager')::boolean,
             false
           ) then
          select subject.email
          into v_manager_email
          from access_control.memberships membership
          join access_control.subjects subject
            on subject.id = membership.subject_id
          join access_control.membership_roles membership_role
            on membership_role.membership_id = membership.id
          join access_control.roles role
            on role.id = membership_role.role_id
          where membership.tenant_id = v_event.tenant_id
            and membership.status = 'active'
            and subject.status = 'active'
            and role.role_key in (
              'training_manager',
              'tenant_owner',
              'tenant_admin'
            )
            and subject.email is not null
          order by case role.role_key
            when 'training_manager' then 1
            when 'tenant_owner' then 2
            else 3
          end
          limit 1;

          if v_manager_email is not null then
            insert into communication_hub.message_outbox (
              tenant_id,
              automation_run_id,
              event_id,
              dedupe_key,
              template_key,
              channel,
              recipient,
              subject,
              message_text,
              due_at,
              metadata
            )
            values (
              v_event.tenant_id,
              v_run_id,
              v_event.id,
              'automation:' || v_event.id::text
                || ':' || v_rule.id::text || ':manager',
              'absence_manager_alert',
              'email',
              v_manager_email,
              private_app.message_template_field(
                v_event.tenant_id,
                'absence_manager_alert',
                'email',
                'subject',
                v_values,
                'غياب يحتاج متابعة'
              ),
              private_app.message_template_field(
                v_event.tenant_id,
                'absence_manager_alert',
                'email',
                'body',
                v_values,
                'تم تسجيل غياب يحتاج متابعة.'
              ),
              now(),
              jsonb_build_object(
                'eventKey', 'absence_manager_alert',
                'ruleKey', v_rule.rule_key,
                'templateValues', v_values,
                'internalNotification', true
              )
            )
            on conflict (tenant_id, dedupe_key) do update
            set due_at = least(
                  communication_hub.message_outbox.due_at,
                  excluded.due_at
                ),
                updated_at = now()
            returning id into v_manager_job_id;
            v_action_count := v_action_count + 1;
            v_jobs := v_jobs + 1;
          end if;
        end if;

        update automation_engine.runs
        set status = 'queued',
            action_count = v_action_count,
            result = jsonb_strip_nulls(jsonb_build_object(
              'messageJobId', v_job_id,
              'managerJobId', v_manager_job_id,
              'primaryChannel', v_channel,
              'fallbackChannel', v_fallback_channel,
              'sent', false
            )),
            completed_at = now()
        where id = v_run_id;
        v_manager_job_id := null;
      end loop;

      update automation_engine.events
      set status = case when v_matched = 0 then 'ignored' else 'completed' end,
          processed_at = now(),
          last_error = null
      where id = v_event.id;
    exception when others then
      update automation_engine.events
      set status = 'failed',
          available_at = now() + interval '10 minutes',
          last_error = left(sqlerrm, 500)
      where id = v_event.id;
    end;
  end loop;

  return jsonb_build_object(
    'events', v_events,
    'jobs', v_jobs,
    'previewed', v_previewed,
    'skipped', v_skipped
  );
end;
$$;

revoke all on function private_app.process_automation_events(
  integer,
  uuid
) from public, anon, authenticated;

create or replace function public.v2_automation_claim_messages(
  p_secret text,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private_app.training_automation_secret_valid(p_secret) then
    raise exception 'forbidden';
  end if;
  if p_limit < 1 or p_limit > 50 then
    raise exception 'invalid_job_limit';
  end if;

  perform private_app.process_automation_events(100, null);

  update communication_hub.message_outbox
  set status = 'pending',
      locked_at = null,
      last_error = 'dispatcher_timeout'
  where status = 'processing'
    and locked_at < now() - interval '10 minutes';

  with due as (
    select job.id
    from communication_hub.message_outbox job
    where (
      job.status in ('pending', 'waiting_configuration')
      or (
        job.status = 'failed'
        and job.attempts < job.max_attempts
      )
    )
      and job.due_at <= now()
    order by job.due_at, job.created_at
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update communication_hub.message_outbox job
    set status = 'processing',
        locked_at = now(),
        attempts = job.attempts + case
          when job.status = 'waiting_configuration' then 0
          else 1
        end
    from due
    where job.id = due.id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'queue', 'automation',
    'id', claimed.id,
    'tenantId', claimed.tenant_id,
    'type', claimed.template_key,
    'channel', claimed.channel,
    'recipient', claimed.recipient,
    'subject', claimed.subject,
    'messageText', claimed.message_text,
    'attempts', claimed.attempts,
    'metadata', claimed.metadata,
    'courseRun', jsonb_strip_nulls(jsonb_build_object(
      'id', claimed.metadata ->> 'courseRunId',
      'title', claimed.metadata #>> '{templateValues,batch}',
      'courseName', claimed.metadata #>> '{templateValues,course}',
      'runCode', claimed.metadata ->> 'courseRunId'
    ))
  )) order by claimed.due_at), '[]'::jsonb)
  into v_result
  from claimed;

  return v_result;
end;
$$;

create or replace function public.v2_automation_complete_message(
  p_secret text,
  p_job_id uuid,
  p_result_state text,
  p_external_id text default null,
  p_external_url text default null,
  p_error text default null,
  p_provider_connection_id uuid default null,
  p_provider_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job communication_hub.message_outbox%rowtype;
  v_fallback_job_id uuid;
begin
  if not private_app.training_automation_secret_valid(p_secret) then
    raise exception 'forbidden';
  end if;
  if p_result_state not in (
    'sent',
    'simulated',
    'missing_configuration',
    'failed'
  ) then raise exception 'invalid_job_result'; end if;

  select *
  into v_job
  from communication_hub.message_outbox job
  where job.id = p_job_id
  for update;
  if v_job.id is null then raise exception 'automation_job_not_found'; end if;

  if p_result_state in ('sent', 'simulated') then
    update communication_hub.message_outbox
    set status = p_result_state,
        provider_connection_id = p_provider_connection_id,
        provider_key = p_provider_key,
        external_id = nullif(p_external_id, ''),
        external_url = nullif(p_external_url, ''),
        last_error = null,
        locked_at = null,
        processed_at = now(),
        metadata = metadata || jsonb_build_object(
          'sentToRecipient', p_result_state = 'sent',
          'truthLabel', case
            when p_result_state = 'simulated'
              then 'simulated_not_sent_to_recipient'
            else 'provider_accepted'
          end
        )
    where id = v_job.id
    returning * into v_job;
  elsif v_job.fallback_channel is not null
        and v_job.fallback_recipient is not null
        and not coalesce(
          (v_job.metadata ->> 'fallbackUsed')::boolean,
          false
        ) then
    insert into communication_hub.message_outbox (
      tenant_id,
      automation_run_id,
      event_id,
      dedupe_key,
      template_key,
      channel,
      recipient,
      subject,
      message_text,
      due_at,
      metadata
    )
    values (
      v_job.tenant_id,
      v_job.automation_run_id,
      v_job.event_id,
      v_job.dedupe_key || ':fallback',
      v_job.template_key,
      v_job.fallback_channel,
      v_job.fallback_recipient,
      v_job.subject,
      v_job.message_text,
      now(),
      v_job.metadata || jsonb_build_object(
        'fallbackUsed', true,
        'fallbackFromJobId', v_job.id,
        'fallbackReason',
          coalesce(nullif(p_error, ''), p_result_state)
      )
    )
    on conflict (tenant_id, dedupe_key) do update
    set due_at = now(),
        status = case
          when communication_hub.message_outbox.status in (
            'sent',
            'simulated'
          ) then communication_hub.message_outbox.status
          else 'pending'
        end,
        last_error = null,
        locked_at = null
    returning id into v_fallback_job_id;

    update communication_hub.message_outbox
    set status = 'fallback_queued',
        last_error = left(
          coalesce(nullif(p_error, ''), p_result_state),
          500
        ),
        locked_at = null,
        processed_at = now(),
        metadata = metadata || jsonb_build_object(
          'fallbackJobId', v_fallback_job_id,
          'sentToRecipient', false
        )
    where id = v_job.id
    returning * into v_job;
  elsif p_result_state = 'missing_configuration' then
    update communication_hub.message_outbox
    set status = 'waiting_configuration',
        due_at = now() + interval '6 hours',
        last_error = left(
          coalesce(nullif(p_error, ''), 'provider_not_configured'),
          500
        ),
        locked_at = null
    where id = v_job.id
    returning * into v_job;
  else
    update communication_hub.message_outbox
    set status = 'failed',
        due_at = now() + (
          least(greatest(attempts, 1), 6) * interval '10 minutes'
        ),
        last_error = left(
          coalesce(nullif(p_error, ''), 'provider_request_failed'),
          500
        ),
        locked_at = null,
        processed_at = case
          when attempts >= max_attempts then now()
          else null
        end
    where id = v_job.id
    returning * into v_job;
  end if;

  insert into audit_log.events (
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_job.tenant_id,
    'automation.message.' || v_job.status,
    'message_outbox',
    v_job.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'templateKey', v_job.template_key,
      'channel', v_job.channel,
      'providerKey', p_provider_key,
      'externalId', v_job.external_id,
      'fallbackJobId', v_fallback_job_id,
      'sentToRecipient', v_job.status = 'sent'
    ))
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'jobId', v_job.id,
    'status', v_job.status,
    'attempts', v_job.attempts,
    'fallbackJobId', v_fallback_job_id,
    'sentToRecipient', v_job.status = 'sent'
  ));
end;
$$;

create or replace function public.v2_tenant_automation_studio_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  perform private_app.ensure_automation_rules(v_tenant.id);

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object('canManage', true),
    'summary', jsonb_build_object(
      'activeRules', (
        select count(*) from automation_engine.rules rule
        where rule.tenant_id = v_tenant.id
          and rule.status = 'active'
      ),
      'pendingEvents', (
        select count(*) from automation_engine.events event
        where event.tenant_id = v_tenant.id
          and event.status in ('pending', 'failed')
      ),
      'queuedMessages', (
        select count(*) from communication_hub.message_outbox job
        where job.tenant_id = v_tenant.id
          and job.status in (
            'pending',
            'processing',
            'waiting_configuration'
          )
      ),
      'previewRules', (
        select count(*) from automation_engine.rules rule
        where rule.tenant_id = v_tenant.id
          and rule.execution_mode = 'preview'
      )
    ),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rule.id,
        'key', rule.rule_key,
        'name', rule.name_ar,
        'description', rule.description_ar,
        'triggerKey', rule.trigger_key,
        'templateKey', rule.template_key,
        'status', rule.status,
        'executionMode', rule.execution_mode,
        'primaryChannel', rule.primary_channel,
        'fallbackChannel', rule.fallback_channel,
        'delayMinutes', rule.delay_minutes,
        'conditionConfig', rule.condition_config,
        'actionConfig', rule.action_config,
        'priority', rule.priority,
        'system', rule.is_system,
        'updatedAt', rule.updated_at
      ) order by rule.priority)
      from automation_engine.rules rule
      where rule.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'recentRuns', coalesce((
      select jsonb_agg(run_row.payload order by run_row.created_at desc)
      from (
        select
          run.created_at,
          jsonb_build_object(
            'id', run.id,
            'status', run.status,
            'ruleName', rule.name_ar,
            'eventKey', event.event_key,
            'actionCount', run.action_count,
            'result', run.result,
            'createdAt', run.created_at
          ) as payload
        from automation_engine.runs run
        join automation_engine.rules rule on rule.id = run.rule_id
        join automation_engine.events event on event.id = run.event_id
        where run.tenant_id = v_tenant.id
        order by run.created_at desc
        limit 20
      ) run_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_automation_studio_action(
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
  v_actor_subject_id uuid;
  v_rule automation_engine.rules%rowtype;
  v_event_id uuid;
  v_run_id uuid;
  v_values jsonb;
  v_subject text;
  v_body text;
  v_processed jsonb;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  v_actor_subject_id := private_app.current_subject_id();
  perform private_app.ensure_automation_rules(v_tenant.id);

  if p_action in ('save_rule', 'toggle_rule', 'preview_rule') then
    begin
      select *
      into v_rule
      from automation_engine.rules rule
      where rule.id = (p_payload ->> 'ruleId')::uuid
        and rule.tenant_id = v_tenant.id
      for update;
    exception when invalid_text_representation then
      raise exception 'invalid_automation_rule';
    end;
    if v_rule.id is null then
      raise exception 'automation_rule_not_found';
    end if;
  end if;

  if p_action = 'toggle_rule' then
    update automation_engine.rules
    set status = case
          when coalesce((p_payload ->> 'enabled')::boolean, false)
            then 'active'
          else 'paused'
        end,
        updated_by_subject_id = v_actor_subject_id
    where id = v_rule.id
    returning * into v_rule;
    perform private_app.sync_legacy_automation_rule(v_rule);

  elsif p_action = 'save_rule' then
    if coalesce(p_payload ->> 'executionMode', '')
       not in ('live', 'preview') then
      raise exception 'invalid_automation_mode';
    end if;
    if coalesce(p_payload ->> 'primaryChannel', '')
       not in ('auto', 'whatsapp', 'email') then
      raise exception 'invalid_automation_channel';
    end if;
    if coalesce(p_payload ->> 'fallbackChannel', '')
       not in ('none', 'whatsapp', 'email') then
      raise exception 'invalid_automation_fallback';
    end if;

    update automation_engine.rules
    set execution_mode = p_payload ->> 'executionMode',
        primary_channel = p_payload ->> 'primaryChannel',
        fallback_channel = p_payload ->> 'fallbackChannel',
        delay_minutes = least(
          greatest(coalesce((p_payload ->> 'delayMinutes')::integer, 0), 0),
          43200
        ),
        updated_by_subject_id = v_actor_subject_id
    where id = v_rule.id
    returning * into v_rule;
    perform private_app.sync_legacy_automation_rule(v_rule);

  elsif p_action = 'preview_rule' then
    v_values := jsonb_build_object(
      'name', 'سارة أحمد',
      'course', 'إدارة المشاريع الاحترافية',
      'batch', 'دفعة أغسطس',
      'session', 'الجلسة الثانية',
      'date', '2026-08-15',
      'time', '18:00',
      'link', 'https://example.com/training',
      'amount', '699 ر.س',
      'certificate_number', 'REEF-DEMO-001',
      'certificate_link', '/certificates/demo',
      'delivery_mode', 'عن بُعد',
      'center', v_tenant.name
    );
    insert into automation_engine.events (
      tenant_id,
      event_key,
      source_type,
      source_id,
      idempotency_key,
      payload,
      status,
      processed_at
    )
    values (
      v_tenant.id,
      v_rule.trigger_key,
      'preview',
      v_rule.id::text,
      'preview:' || v_rule.id::text || ':' || gen_random_uuid()::text,
      jsonb_build_object(
        'templateValues', v_values,
        'recipientPhone', '966500000000',
        'recipientEmail', 'preview@example.com'
      ),
      'completed',
      now()
    )
    returning id into v_event_id;

    v_subject := private_app.message_template_field(
      v_tenant.id,
      v_rule.template_key,
      case
        when v_rule.primary_channel = 'email' then 'email'
        else 'whatsapp'
      end,
      'subject',
      v_values,
      v_rule.name_ar
    );
    v_body := private_app.message_template_field(
      v_tenant.id,
      v_rule.template_key,
      case
        when v_rule.primary_channel = 'email' then 'email'
        else 'whatsapp'
      end,
      'body',
      v_values,
      v_rule.description_ar
    );

    insert into automation_engine.runs (
      tenant_id,
      event_id,
      rule_id,
      status,
      result,
      completed_at
    )
    values (
      v_tenant.id,
      v_event_id,
      v_rule.id,
      'previewed',
      jsonb_build_object(
        'subject', v_subject,
        'body', v_body,
        'sent', false,
        'truthLabel', 'preview_not_queued'
      ),
      now()
    )
    returning id into v_run_id;

    return jsonb_build_object(
      'ruleId', v_rule.id,
      'runId', v_run_id,
      'subject', v_subject,
      'body', v_body,
      'sent', false
    );

  elsif p_action = 'process_now' then
    v_processed := private_app.process_automation_events(
      100,
      v_tenant.id
    );
    return jsonb_build_object(
      'action', p_action,
      'processed', v_processed
    );
  else
    raise exception 'invalid_automation_action';
  end if;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_tenant.id,
    v_actor_subject_id,
    'automation.rule.' || p_action,
    'automation_rule',
    v_rule.id::text,
    jsonb_build_object(
      'ruleKey', v_rule.rule_key,
      'status', v_rule.status,
      'executionMode', v_rule.execution_mode,
      'primaryChannel', v_rule.primary_channel,
      'fallbackChannel', v_rule.fallback_channel,
      'delayMinutes', v_rule.delay_minutes
    )
  );

  return jsonb_build_object(
    'ruleId', v_rule.id,
    'status', v_rule.status,
    'executionMode', v_rule.execution_mode,
    'primaryChannel', v_rule.primary_channel,
    'fallbackChannel', v_rule.fallback_channel,
    'delayMinutes', v_rule.delay_minutes
  );
end;
$$;

revoke execute on function public.v2_automation_claim_messages(
  text,
  integer
) from public, anon, authenticated;

revoke execute on function public.v2_automation_complete_message(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text
) from public, anon, authenticated;

revoke execute on function public.v2_tenant_automation_studio_snapshot(
  text
) from public, anon;

revoke execute on function public.v2_tenant_automation_studio_action(
  text,
  text,
  jsonb
) from public, anon;

grant execute on function public.v2_automation_claim_messages(
  text,
  integer
) to service_role;

grant execute on function public.v2_automation_complete_message(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text
) to service_role;

grant execute on function public.v2_tenant_automation_studio_snapshot(
  text
) to authenticated;

grant execute on function public.v2_tenant_automation_studio_action(
  text,
  text,
  jsonb
) to authenticated;

comment on schema automation_engine is
'Tenant-isolated event, rule, and execution engine for sellable Marktone automation add-ons.';

comment on table automation_engine.rules is
'Event-condition-action rules with preview mode, delay, priority, and fallback channel.';

comment on table automation_engine.events is
'Idempotent domain-event queue produced by payment, enrollment, attendance, certificate, and schedule changes.';

comment on table communication_hub.message_outbox is
'General provider-neutral message outbox with explicit fallback and truthful simulated states.';

commit;
