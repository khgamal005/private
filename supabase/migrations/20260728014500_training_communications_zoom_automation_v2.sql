begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

alter table academy.course_run_sessions
  add column meeting_provider text,
  add column external_meeting_id text,
  add column meeting_join_url text,
  add column meeting_status text not null default 'not_created',
  add column meeting_created_at timestamptz,
  add column meeting_last_error text;

alter table academy.course_run_sessions
  add constraint course_run_sessions_meeting_provider_check
  check (meeting_provider is null or meeting_provider = 'zoom'),
  add constraint course_run_sessions_meeting_status_check
  check (
    meeting_status in (
      'not_created',
      'queued',
      'ready',
      'failed'
    )
  ),
  add constraint course_run_sessions_meeting_ready_check
  check (
    meeting_status <> 'ready'
    or (
      meeting_provider = 'zoom'
      and external_meeting_id is not null
      and meeting_join_url is not null
      and meeting_created_at is not null
    )
  );

create unique index course_run_sessions_zoom_meeting_idx
on academy.course_run_sessions (tenant_id, external_meeting_id)
where external_meeting_id is not null;

create table academy.training_automation_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  joining_enabled boolean not null default true,
  reminder_24h_enabled boolean not null default true,
  reminder_1h_enabled boolean not null default true,
  zoom_auto_create boolean not null default false,
  primary_channel text not null default 'whatsapp'
    check (primary_channel in ('whatsapp', 'email')),
  email_fallback_enabled boolean not null default true,
  whatsapp_country_code text not null default '966'
    check (whatsapp_country_code ~ '^[1-9][0-9]{0,3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create table academy.training_automation_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  course_run_id uuid not null
    references academy.course_runs(id) on delete cascade,
  session_id uuid
    references academy.course_run_sessions(id) on delete cascade,
  enrollment_id uuid
    references academy.enrollments(id) on delete cascade,
  dedupe_key text not null
    check (length(trim(dedupe_key)) >= 8),
  job_type text not null
    check (
      job_type in (
        'joining_instructions',
        'session_reminder_24h',
        'session_reminder_1h',
        'zoom_meeting_create'
      )
    ),
  channel text not null
    check (channel in ('whatsapp', 'email', 'zoom')),
  recipient text,
  subject text,
  message_text text,
  due_at timestamptz not null default now(),
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'processing',
        'sent',
        'failed',
        'waiting_configuration',
        'cancelled'
      )
    ),
  attempts integer not null default 0
    check (attempts >= 0),
  max_attempts integer not null default 3
    check (max_attempts between 1 and 10),
  external_id text,
  external_url text,
  last_error text,
  locked_at timestamptz,
  processed_at timestamptz,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key),
  check (
    (
      job_type = 'zoom_meeting_create'
      and channel = 'zoom'
      and session_id is not null
      and enrollment_id is null
    )
    or
    (
      job_type = 'joining_instructions'
      and channel in ('whatsapp', 'email')
      and enrollment_id is not null
      and session_id is null
      and recipient is not null
      and message_text is not null
    )
    or
    (
      job_type in (
        'session_reminder_24h',
        'session_reminder_1h'
      )
      and channel in ('whatsapp', 'email')
      and enrollment_id is not null
      and session_id is not null
      and recipient is not null
      and message_text is not null
    )
  )
);

create index training_automation_jobs_due_idx
on academy.training_automation_jobs (
  status,
  due_at
)
where status in (
  'pending',
  'failed',
  'waiting_configuration',
  'processing'
);

create index training_automation_jobs_run_idx
on academy.training_automation_jobs (
  tenant_id,
  course_run_id,
  created_at desc
);

create index training_automation_jobs_session_idx
on academy.training_automation_jobs (session_id)
where session_id is not null;

create index training_automation_jobs_enrollment_idx
on academy.training_automation_jobs (enrollment_id)
where enrollment_id is not null;

create index training_automation_jobs_actor_idx
on academy.training_automation_jobs (created_by_subject_id)
where created_by_subject_id is not null;

create unique index core_tenant_integrations_system_idx
on core.integrations (tenant_id, system_type)
where tenant_id is not null;

create trigger training_automation_settings_set_updated_at
before update on academy.training_automation_settings
for each row execute function private_app.set_updated_at();

create trigger training_automation_jobs_set_updated_at
before update on academy.training_automation_jobs
for each row execute function private_app.set_updated_at();

alter table academy.training_automation_settings
enable row level security;

alter table academy.training_automation_jobs
enable row level security;

create policy training_automation_settings_isolated_read
on academy.training_automation_settings
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy training_automation_jobs_isolated_read
on academy.training_automation_jobs
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table academy.training_automation_settings
from public, anon, authenticated;

revoke all on table academy.training_automation_jobs
from public, anon, authenticated;

insert into academy.training_automation_settings (tenant_id)
select tenant.id
from core.tenants tenant
where tenant.status in ('trial', 'active')
on conflict (tenant_id) do nothing;

insert into core.integrations (
  tenant_id,
  system_type,
  display_name,
  status,
  configuration
)
select
  tenant.id,
  provider.system_type,
  provider.display_name,
  'draft',
  jsonb_build_object(
    'dispatchMode',
    'supabase_edge_function',
    'providerState',
    'unknown'
  )
from core.tenants tenant
cross join (
  values
    ('whatsapp_cloud', 'WhatsApp Cloud API'),
    ('resend_email', 'Resend Email'),
    ('zoom_meetings', 'Zoom Meetings')
) provider(system_type, display_name)
where tenant.status in ('trial', 'active')
on conflict (tenant_id, system_type) where tenant_id is not null
do nothing;

do $secret$
begin
  if not exists (
    select 1
    from vault.secrets secret
    where secret.name = 'training_automation_secret'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'training_automation_secret',
      'Authorizes the Marktone training automation dispatcher.'
    );
  end if;
end;
$secret$;

create or replace function private_app.normalize_training_phone(
  p_phone text,
  p_country_code text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_phone text;
begin
  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if v_phone = '' then return null; end if;
  if left(v_phone, 2) = '00' then
    v_phone := substr(v_phone, 3);
  elsif left(v_phone, 1) = '0' then
    v_phone := coalesce(nullif(p_country_code, ''), '966')
      || substr(v_phone, 2);
  end if;
  if length(v_phone) < 8 or length(v_phone) > 15 then
    return null;
  end if;
  return v_phone;
end;
$$;

revoke all on function private_app.normalize_training_phone(text, text)
from public, anon, authenticated;

create or replace function private_app.build_session_reminder_message(
  p_enrollment_id uuid,
  p_session_id uuid
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_message text;
begin
  select format(
    E'مرحبًا %s،\nتذكير بموعد %s ضمن %s.\nالموعد: %s\nرابط/مكان الحضور: %s\nنتمنى لك جلسة موفقة.',
    student.full_name,
    session.title,
    course.title_ar,
    to_char(
      session.starts_at at time zone tenant.timezone,
      'YYYY-MM-DD HH24:MI'
    ),
    coalesce(
      session.meeting_join_url,
      session.venue_or_link,
      run.venue_or_link,
      'سيحدد لاحقًا'
    )
  )
  into v_message
  from academy.enrollments enrollment
  join academy.students student
    on student.id = enrollment.student_id
  join academy.course_runs run
    on run.id = enrollment.course_run_id
  join academy.courses course
    on course.id = enrollment.course_id
  join academy.course_run_sessions session
    on session.id = p_session_id
   and session.course_run_id = enrollment.course_run_id
  join core.tenants tenant
    on tenant.id = enrollment.tenant_id
  where enrollment.id = p_enrollment_id;

  if v_message is null then
    raise exception 'invalid_training_record';
  end if;
  return v_message;
end;
$$;

revoke all on function
  private_app.build_session_reminder_message(uuid, uuid)
from public, anon, authenticated;

create or replace function private_app.prepare_training_automation_jobs(
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_joining integer := 0;
  v_reminder_24h integer := 0;
  v_reminder_1h integer := 0;
  v_zoom integer := 0;
begin
  insert into academy.training_automation_settings (tenant_id)
  select tenant.id
  from core.tenants tenant
  where tenant.status in ('trial', 'active')
    and (p_tenant_id is null or tenant.id = p_tenant_id)
  on conflict (tenant_id) do nothing;

  insert into core.integrations (
    tenant_id,
    system_type,
    display_name,
    status,
    configuration
  )
  select
    tenant.id,
    provider.system_type,
    provider.display_name,
    'draft',
    jsonb_build_object(
      'dispatchMode',
      'supabase_edge_function',
      'providerState',
      'unknown'
    )
  from core.tenants tenant
  cross join (
    values
      ('whatsapp_cloud', 'WhatsApp Cloud API'),
      ('resend_email', 'Resend Email'),
      ('zoom_meetings', 'Zoom Meetings')
  ) provider(system_type, display_name)
  where tenant.status in ('trial', 'active')
    and (p_tenant_id is null or tenant.id = p_tenant_id)
  on conflict (tenant_id, system_type) where tenant_id is not null
  do nothing;

  with candidates as (
    select
      enrollment.tenant_id,
      enrollment.course_run_id,
      enrollment.id as enrollment_id,
      settings.primary_channel,
      settings.email_fallback_enabled,
      settings.whatsapp_country_code,
      student.phone,
      student.email,
      private_app.build_joining_message(enrollment.id) as message_text,
      student.full_name,
      course.title_ar,
      coalesce(run.title, course.title_ar) as run_title,
      to_char(
        run.starts_at at time zone tenant.timezone,
        'YYYY-MM-DD HH24:MI'
      ) as local_start,
      coalesce(run.venue_or_link, 'سيحدد لاحقًا') as venue_or_link
    from academy.enrollments enrollment
    join academy.students student
      on student.id = enrollment.student_id
    join academy.course_runs run
      on run.id = enrollment.course_run_id
    join academy.courses course
      on course.id = enrollment.course_id
    join core.tenants tenant
      on tenant.id = enrollment.tenant_id
    join academy.training_automation_settings settings
      on settings.tenant_id = enrollment.tenant_id
     and settings.joining_enabled
    where enrollment.status in ('confirmed', 'active')
      and (p_tenant_id is null or enrollment.tenant_id = p_tenant_id)
      and not exists (
        select 1
        from academy.student_communications communication
        where communication.enrollment_id = enrollment.id
          and communication.message_type = 'joining_instructions'
          and communication.status = 'sent'
      )
  ),
  inserted as (
    insert into academy.training_automation_jobs (
      tenant_id,
      course_run_id,
      enrollment_id,
      dedupe_key,
      job_type,
      channel,
      recipient,
      subject,
      message_text,
      due_at,
      metadata
    )
    select
      candidate.tenant_id,
      candidate.course_run_id,
      candidate.enrollment_id,
      'joining:' || candidate.enrollment_id::text,
      'joining_instructions',
      case
        when candidate.primary_channel = 'whatsapp'
         and private_app.normalize_training_phone(
           candidate.phone,
           candidate.whatsapp_country_code
         ) is not null then 'whatsapp'
        else 'email'
      end,
      case
        when candidate.primary_channel = 'whatsapp'
         and private_app.normalize_training_phone(
           candidate.phone,
           candidate.whatsapp_country_code
         ) is not null then
          private_app.normalize_training_phone(
            candidate.phone,
            candidate.whatsapp_country_code
          )
        else candidate.email
      end,
      'تعليمات الانضمام إلى ' || candidate.run_title,
      candidate.message_text,
      now(),
      jsonb_build_object(
        'studentName', candidate.full_name,
        'courseName', candidate.title_ar,
        'runName', candidate.run_title,
        'startDate', candidate.local_start,
        'venueOrLink', candidate.venue_or_link,
        'source', 'automatic_preparation'
      )
    from candidates candidate
    where (
      candidate.primary_channel = 'whatsapp'
      and private_app.normalize_training_phone(
        candidate.phone,
        candidate.whatsapp_country_code
      ) is not null
    ) or (
      candidate.primary_channel = 'email'
      and candidate.email is not null
    ) or (
      candidate.primary_channel = 'whatsapp'
      and candidate.email_fallback_enabled
      and candidate.email is not null
    )
    on conflict (tenant_id, dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_joining from inserted;

  with candidates as (
    select
      enrollment.tenant_id,
      enrollment.course_run_id,
      enrollment.id as enrollment_id,
      session.id as session_id,
      session.starts_at,
      settings.primary_channel,
      settings.email_fallback_enabled,
      settings.whatsapp_country_code,
      student.phone,
      student.email,
      student.full_name,
      course.title_ar,
      session.title as session_title,
      to_char(
        session.starts_at at time zone tenant.timezone,
        'YYYY-MM-DD HH24:MI'
      ) as local_start,
      coalesce(
        session.meeting_join_url,
        session.venue_or_link,
        run.venue_or_link,
        'سيحدد لاحقًا'
      ) as venue_or_link,
      private_app.build_session_reminder_message(
        enrollment.id,
        session.id
      ) as message_text
    from academy.enrollments enrollment
    join academy.students student
      on student.id = enrollment.student_id
    join academy.course_runs run
      on run.id = enrollment.course_run_id
    join academy.courses course
      on course.id = enrollment.course_id
    join academy.course_run_sessions session
      on session.course_run_id = enrollment.course_run_id
     and session.status = 'scheduled'
     and session.starts_at > now()
     and session.starts_at <= now() + interval '8 days'
    join core.tenants tenant
      on tenant.id = enrollment.tenant_id
    join academy.training_automation_settings settings
      on settings.tenant_id = enrollment.tenant_id
    where enrollment.status in ('confirmed', 'active')
      and (p_tenant_id is null or enrollment.tenant_id = p_tenant_id)
  ),
  inserted_24h as (
    insert into academy.training_automation_jobs (
      tenant_id,
      course_run_id,
      session_id,
      enrollment_id,
      dedupe_key,
      job_type,
      channel,
      recipient,
      subject,
      message_text,
      due_at,
      metadata
    )
    select
      candidate.tenant_id,
      candidate.course_run_id,
      candidate.session_id,
      candidate.enrollment_id,
      'reminder24:' || candidate.session_id::text
        || ':' || candidate.enrollment_id::text,
      'session_reminder_24h',
      case
        when candidate.primary_channel = 'whatsapp'
         and private_app.normalize_training_phone(
           candidate.phone,
           candidate.whatsapp_country_code
         ) is not null then 'whatsapp'
        else 'email'
      end,
      case
        when candidate.primary_channel = 'whatsapp'
         and private_app.normalize_training_phone(
           candidate.phone,
           candidate.whatsapp_country_code
         ) is not null then
          private_app.normalize_training_phone(
            candidate.phone,
            candidate.whatsapp_country_code
          )
        else candidate.email
      end,
      'تذكير بموعد ' || candidate.session_title,
      candidate.message_text,
      candidate.starts_at - interval '24 hours',
      jsonb_build_object(
        'studentName', candidate.full_name,
        'courseName', candidate.title_ar,
        'sessionTitle', candidate.session_title,
        'startDate', candidate.local_start,
        'venueOrLink', candidate.venue_or_link,
        'source', 'automatic_preparation'
      )
    from candidates candidate
    join academy.training_automation_settings settings
      on settings.tenant_id = candidate.tenant_id
     and settings.reminder_24h_enabled
    where (
      candidate.primary_channel = 'whatsapp'
      and private_app.normalize_training_phone(
        candidate.phone,
        candidate.whatsapp_country_code
      ) is not null
    ) or (
      candidate.primary_channel = 'email'
      and candidate.email is not null
    ) or (
      candidate.primary_channel = 'whatsapp'
      and candidate.email_fallback_enabled
      and candidate.email is not null
    )
    on conflict (tenant_id, dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_reminder_24h from inserted_24h;

  with candidates as (
    select
      enrollment.tenant_id,
      enrollment.course_run_id,
      enrollment.id as enrollment_id,
      session.id as session_id,
      session.starts_at,
      settings.primary_channel,
      settings.email_fallback_enabled,
      settings.whatsapp_country_code,
      student.phone,
      student.email,
      student.full_name,
      course.title_ar,
      session.title as session_title,
      to_char(
        session.starts_at at time zone tenant.timezone,
        'YYYY-MM-DD HH24:MI'
      ) as local_start,
      coalesce(
        session.meeting_join_url,
        session.venue_or_link,
        run.venue_or_link,
        'سيحدد لاحقًا'
      ) as venue_or_link,
      private_app.build_session_reminder_message(
        enrollment.id,
        session.id
      ) as message_text
    from academy.enrollments enrollment
    join academy.students student
      on student.id = enrollment.student_id
    join academy.course_runs run
      on run.id = enrollment.course_run_id
    join academy.courses course
      on course.id = enrollment.course_id
    join academy.course_run_sessions session
      on session.course_run_id = enrollment.course_run_id
     and session.status = 'scheduled'
     and session.starts_at > now()
     and session.starts_at <= now() + interval '8 days'
    join core.tenants tenant
      on tenant.id = enrollment.tenant_id
    join academy.training_automation_settings settings
      on settings.tenant_id = enrollment.tenant_id
     and settings.reminder_1h_enabled
    where enrollment.status in ('confirmed', 'active')
      and (p_tenant_id is null or enrollment.tenant_id = p_tenant_id)
  ),
  inserted_1h as (
    insert into academy.training_automation_jobs (
      tenant_id,
      course_run_id,
      session_id,
      enrollment_id,
      dedupe_key,
      job_type,
      channel,
      recipient,
      subject,
      message_text,
      due_at,
      metadata
    )
    select
      candidate.tenant_id,
      candidate.course_run_id,
      candidate.session_id,
      candidate.enrollment_id,
      'reminder1:' || candidate.session_id::text
        || ':' || candidate.enrollment_id::text,
      'session_reminder_1h',
      case
        when candidate.primary_channel = 'whatsapp'
         and private_app.normalize_training_phone(
           candidate.phone,
           candidate.whatsapp_country_code
         ) is not null then 'whatsapp'
        else 'email'
      end,
      case
        when candidate.primary_channel = 'whatsapp'
         and private_app.normalize_training_phone(
           candidate.phone,
           candidate.whatsapp_country_code
         ) is not null then
          private_app.normalize_training_phone(
            candidate.phone,
            candidate.whatsapp_country_code
          )
        else candidate.email
      end,
      'تذكير قريب بموعد ' || candidate.session_title,
      candidate.message_text,
      candidate.starts_at - interval '1 hour',
      jsonb_build_object(
        'studentName', candidate.full_name,
        'courseName', candidate.title_ar,
        'sessionTitle', candidate.session_title,
        'startDate', candidate.local_start,
        'venueOrLink', candidate.venue_or_link,
        'source', 'automatic_preparation'
      )
    from candidates candidate
    where (
      candidate.primary_channel = 'whatsapp'
      and private_app.normalize_training_phone(
        candidate.phone,
        candidate.whatsapp_country_code
      ) is not null
    ) or (
      candidate.primary_channel = 'email'
      and candidate.email is not null
    ) or (
      candidate.primary_channel = 'whatsapp'
      and candidate.email_fallback_enabled
      and candidate.email is not null
    )
    on conflict (tenant_id, dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_reminder_1h from inserted_1h;

  with inserted_zoom as (
    insert into academy.training_automation_jobs (
      tenant_id,
      course_run_id,
      session_id,
      dedupe_key,
      job_type,
      channel,
      due_at,
      metadata
    )
    select
      session.tenant_id,
      session.course_run_id,
      session.id,
      'zoom:' || session.id::text,
      'zoom_meeting_create',
      'zoom',
      now(),
      jsonb_build_object('source', 'automatic_preparation')
    from academy.course_run_sessions session
    join academy.training_automation_settings settings
      on settings.tenant_id = session.tenant_id
     and settings.zoom_auto_create
    where session.status = 'scheduled'
      and session.delivery_mode in ('online', 'hybrid')
      and session.starts_at > now()
      and session.meeting_status <> 'ready'
      and (p_tenant_id is null or session.tenant_id = p_tenant_id)
    on conflict (tenant_id, dedupe_key) do nothing
    returning session_id
  )
  update academy.course_run_sessions session
  set meeting_provider = 'zoom',
      meeting_status = 'queued',
      meeting_last_error = null
  where session.id in (select session_id from inserted_zoom);

  get diagnostics v_zoom = row_count;

  return jsonb_build_object(
    'joining', v_joining,
    'reminder24h', v_reminder_24h,
    'reminder1h', v_reminder_1h,
    'zoom', v_zoom
  );
end;
$$;

revoke all on function
  private_app.prepare_training_automation_jobs(uuid)
from public, anon, authenticated;

create or replace function public.v2_tenant_training_automation_snapshot(
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
    'tenant.training.read'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'canManage',
      private_app.has_tenant_permission(
        v_tenant.id,
        'tenant.training.write'
      )
    ),
    'settings', (
      select jsonb_build_object(
        'joiningEnabled', settings.joining_enabled,
        'reminder24hEnabled', settings.reminder_24h_enabled,
        'reminder1hEnabled', settings.reminder_1h_enabled,
        'zoomAutoCreate', settings.zoom_auto_create,
        'primaryChannel', settings.primary_channel,
        'emailFallbackEnabled', settings.email_fallback_enabled,
        'whatsappCountryCode', settings.whatsapp_country_code
      )
      from academy.training_automation_settings settings
      where settings.tenant_id = v_tenant.id
    ),
    'summary', jsonb_build_object(
      'pending', (
        select count(*)
        from academy.training_automation_jobs job
        where job.tenant_id = v_tenant.id
          and job.status in ('pending', 'processing')
      ),
      'waitingConfiguration', (
        select count(*)
        from academy.training_automation_jobs job
        where job.tenant_id = v_tenant.id
          and job.status = 'waiting_configuration'
      ),
      'failed', (
        select count(*)
        from academy.training_automation_jobs job
        where job.tenant_id = v_tenant.id
          and job.status = 'failed'
      ),
      'sent', (
        select count(*)
        from academy.training_automation_jobs job
        where job.tenant_id = v_tenant.id
          and job.status = 'sent'
      ),
      'zoomReady', (
        select count(*)
        from academy.course_run_sessions session
        where session.tenant_id = v_tenant.id
          and session.meeting_status = 'ready'
      )
    ),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', integration.system_type,
        'name', integration.display_name,
        'status', integration.status,
        'state',
        coalesce(
          integration.configuration ->> 'providerState',
          'unknown'
        ),
        'detail',
        integration.configuration ->> 'statusDetail',
        'lastCheckedAt', integration.last_checked_at
      ) order by integration.system_type)
      from core.integrations integration
      where integration.tenant_id = v_tenant.id
        and integration.system_type in (
          'whatsapp_cloud',
          'resend_email',
          'zoom_meetings'
        )
    ), '[]'::jsonb),
    'meetings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sessionId', session.id,
        'courseRunId', session.course_run_id,
        'provider', session.meeting_provider,
        'externalMeetingId', session.external_meeting_id,
        'joinUrl', session.meeting_join_url,
        'status', session.meeting_status,
        'createdAt', session.meeting_created_at,
        'lastError', session.meeting_last_error
      ) order by session.starts_at)
      from academy.course_run_sessions session
      where session.tenant_id = v_tenant.id
        and (
          session.meeting_status <> 'not_created'
          or session.delivery_mode in ('online', 'hybrid')
        )
    ), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', job.id,
        'courseRunId', job.course_run_id,
        'sessionId', job.session_id,
        'enrollmentId', job.enrollment_id,
        'type', job.job_type,
        'channel', job.channel,
        'recipient', case
          when job.channel = 'email' then regexp_replace(
            coalesce(job.recipient, ''),
            '(^.).*(@.*$)',
            '\1***\2'
          )
          when job.channel = 'whatsapp' then
            '***' || right(coalesce(job.recipient, ''), 4)
          else null
        end,
        'subject', job.subject,
        'status', job.status,
        'dueAt', job.due_at,
        'attempts', job.attempts,
        'maxAttempts', job.max_attempts,
        'externalId', job.external_id,
        'externalUrl', job.external_url,
        'lastError', job.last_error,
        'processedAt', job.processed_at,
        'createdAt', job.created_at
      ) order by job.created_at desc)
      from (
        select *
        from academy.training_automation_jobs source_job
        where source_job.tenant_id = v_tenant.id
        order by source_job.created_at desc
        limit 150
      ) job
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_training_automation_action(
  p_tenant_slug text,
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
  v_settings academy.training_automation_settings%rowtype;
  v_enrollment academy.enrollments%rowtype;
  v_student academy.students%rowtype;
  v_run academy.course_runs%rowtype;
  v_session academy.course_run_sessions%rowtype;
  v_job academy.training_automation_jobs%rowtype;
  v_channel text;
  v_recipient text;
  v_message text;
  v_prepared jsonb;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.training.write'
  ) then raise exception 'forbidden'; end if;

  v_actor_subject_id := private_app.current_subject_id();
  if v_actor_subject_id is null then raise exception 'forbidden'; end if;

  insert into academy.training_automation_settings (tenant_id)
  values (v_tenant.id)
  on conflict (tenant_id) do nothing;

  select *
  into v_settings
  from academy.training_automation_settings settings
  where settings.tenant_id = v_tenant.id;

  if p_action = 'prepare_jobs' then
    v_prepared := private_app.prepare_training_automation_jobs(
      v_tenant.id
    );
    return jsonb_build_object(
      'action', p_action,
      'prepared', v_prepared
    );
  end if;

  if p_action = 'save_settings' then
    update academy.training_automation_settings
    set joining_enabled = coalesce(
          (p_payload ->> 'joiningEnabled')::boolean,
          joining_enabled
        ),
        reminder_24h_enabled = coalesce(
          (p_payload ->> 'reminder24hEnabled')::boolean,
          reminder_24h_enabled
        ),
        reminder_1h_enabled = coalesce(
          (p_payload ->> 'reminder1hEnabled')::boolean,
          reminder_1h_enabled
        ),
        zoom_auto_create = coalesce(
          (p_payload ->> 'zoomAutoCreate')::boolean,
          zoom_auto_create
        ),
        primary_channel = coalesce(
          nullif(p_payload ->> 'primaryChannel', ''),
          primary_channel
        ),
        email_fallback_enabled = coalesce(
          (p_payload ->> 'emailFallbackEnabled')::boolean,
          email_fallback_enabled
        )
    where tenant_id = v_tenant.id;

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
      'training.automation.settings_updated',
      'training_automation_settings',
      v_tenant.id::text,
      jsonb_strip_nulls(p_payload)
    );

    return jsonb_build_object('action', p_action);
  end if;

  if p_action in ('retry_job', 'cancel_job') then
    select *
    into v_job
    from academy.training_automation_jobs job
    where job.id = nullif(p_payload ->> 'jobId', '')::uuid
      and job.tenant_id = v_tenant.id
    for update;

    if v_job.id is null then raise exception 'automation_job_not_found'; end if;

    if p_action = 'retry_job' then
      if v_job.status not in (
        'failed',
        'waiting_configuration',
        'cancelled'
      ) then raise exception 'automation_job_not_retryable'; end if;
      update academy.training_automation_jobs
      set status = 'pending',
          due_at = now(),
          last_error = null,
          locked_at = null,
          processed_at = null
      where id = v_job.id
      returning * into v_job;
      if v_job.job_type = 'zoom_meeting_create' then
        update academy.course_run_sessions
        set meeting_provider = 'zoom',
            meeting_status = 'queued',
            meeting_last_error = null
        where id = v_job.session_id;
      end if;
    else
      if v_job.status = 'sent' then
        raise exception 'automation_job_already_sent';
      end if;
      update academy.training_automation_jobs
      set status = 'cancelled',
          processed_at = now(),
          locked_at = null
      where id = v_job.id
      returning * into v_job;
    end if;

  elsif p_action in ('queue_joining', 'mark_manual_sent') then
    select *
    into v_enrollment
    from academy.enrollments enrollment
    where enrollment.id =
      nullif(p_payload ->> 'enrollmentId', '')::uuid
      and enrollment.tenant_id = v_tenant.id
    for update;

    if v_enrollment.id is null then
      raise exception 'enrollment_not_found';
    end if;
    if v_enrollment.status in ('withdrawn', 'cancelled') then
      raise exception 'enrollment_inactive';
    end if;

    select *
    into v_student
    from academy.students student
    where student.id = v_enrollment.student_id;

    select *
    into v_run
    from academy.course_runs run
    where run.id = v_enrollment.course_run_id;

    v_message := private_app.build_joining_message(v_enrollment.id);

    if p_action = 'mark_manual_sent' then
      insert into academy.student_communications (
        tenant_id,
        course_run_id,
        enrollment_id,
        message_type,
        channel,
        status,
        message_text,
        sent_at,
        sent_by_subject_id,
        metadata
      )
      values (
        v_tenant.id,
        v_run.id,
        v_enrollment.id,
        'joining_instructions',
        'manual',
        'sent',
        v_message,
        now(),
        v_actor_subject_id,
        jsonb_build_object(
          'deliveryMode',
          'manual_confirmation',
          'source',
          'training_automation_workspace'
        )
      )
      on conflict (enrollment_id, message_type) do update
      set channel = 'manual',
          status = 'sent',
          message_text = excluded.message_text,
          sent_at = now(),
          sent_by_subject_id = excluded.sent_by_subject_id,
          metadata = excluded.metadata;

      update academy.training_automation_jobs
      set status = case
            when status = 'sent' then status
            else 'cancelled'
          end,
          processed_at = coalesce(processed_at, now()),
          last_error = null
      where tenant_id = v_tenant.id
        and enrollment_id = v_enrollment.id
        and job_type = 'joining_instructions'
        and status <> 'sent';
    else
      v_channel := coalesce(
        nullif(p_payload ->> 'channel', ''),
        v_settings.primary_channel
      );
      if v_channel not in ('whatsapp', 'email') then
        raise exception 'invalid_communication_channel';
      end if;

      if v_channel = 'whatsapp' then
        v_recipient := private_app.normalize_training_phone(
          v_student.phone,
          v_settings.whatsapp_country_code
        );
        if v_recipient is null
           and v_settings.email_fallback_enabled
           and v_student.email is not null then
          v_channel := 'email';
          v_recipient := v_student.email;
        end if;
      else
        v_recipient := v_student.email;
      end if;

      if v_recipient is null then
        raise exception 'training_contact_channel_missing';
      end if;

      insert into academy.training_automation_jobs (
        tenant_id,
        course_run_id,
        enrollment_id,
        dedupe_key,
        job_type,
        channel,
        recipient,
        subject,
        message_text,
        due_at,
        status,
        attempts,
        last_error,
        locked_at,
        processed_at,
        created_by_subject_id,
        metadata
      )
      values (
        v_tenant.id,
        v_run.id,
        v_enrollment.id,
        'joining:' || v_enrollment.id::text,
        'joining_instructions',
        v_channel,
        v_recipient,
        'تعليمات الانضمام إلى '
          || coalesce(v_run.title, 'البرنامج التدريبي'),
        v_message,
        now(),
        'pending',
        0,
        null,
        null,
        null,
        v_actor_subject_id,
        jsonb_build_object(
          'studentName', v_student.full_name,
          'source', 'manual_queue'
        )
      )
      on conflict (tenant_id, dedupe_key) do update
      set channel = excluded.channel,
          recipient = excluded.recipient,
          subject = excluded.subject,
          message_text = excluded.message_text,
          due_at = now(),
          status = case
            when academy.training_automation_jobs.status = 'sent'
              then 'sent'
            else 'pending'
          end,
          attempts = case
            when academy.training_automation_jobs.status = 'sent'
              then academy.training_automation_jobs.attempts
            else 0
          end,
          last_error = null,
          locked_at = null,
          processed_at = case
            when academy.training_automation_jobs.status = 'sent'
              then academy.training_automation_jobs.processed_at
            else null
          end,
          created_by_subject_id = excluded.created_by_subject_id,
          metadata = academy.training_automation_jobs.metadata
            || excluded.metadata
      returning * into v_job;
    end if;

  elsif p_action = 'queue_zoom' then
    select *
    into v_session
    from academy.course_run_sessions session
    where session.id = nullif(p_payload ->> 'sessionId', '')::uuid
      and session.tenant_id = v_tenant.id
    for update;

    if v_session.id is null then raise exception 'invalid_session'; end if;
    if v_session.status <> 'scheduled' then
      raise exception 'session_not_schedulable';
    end if;
    if v_session.delivery_mode not in ('online', 'hybrid') then
      raise exception 'zoom_requires_online_session';
    end if;
    if v_session.starts_at <= now() then
      raise exception 'zoom_session_must_be_future';
    end if;
    if v_session.meeting_status = 'ready' then
      return jsonb_build_object(
        'action', p_action,
        'sessionId', v_session.id,
        'status', 'ready',
        'joinUrl', v_session.meeting_join_url
      );
    end if;

    insert into academy.training_automation_jobs (
      tenant_id,
      course_run_id,
      session_id,
      dedupe_key,
      job_type,
      channel,
      due_at,
      status,
      attempts,
      last_error,
      locked_at,
      processed_at,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant.id,
      v_session.course_run_id,
      v_session.id,
      'zoom:' || v_session.id::text,
      'zoom_meeting_create',
      'zoom',
      now(),
      'pending',
      0,
      null,
      null,
      null,
      v_actor_subject_id,
      jsonb_build_object('source', 'manual_queue')
    )
    on conflict (tenant_id, dedupe_key) do update
    set due_at = now(),
        status = case
          when academy.training_automation_jobs.status = 'sent'
            then 'sent'
          else 'pending'
        end,
        attempts = case
          when academy.training_automation_jobs.status = 'sent'
            then academy.training_automation_jobs.attempts
          else 0
        end,
        last_error = null,
        locked_at = null,
        processed_at = null,
        created_by_subject_id = excluded.created_by_subject_id,
        metadata = academy.training_automation_jobs.metadata
          || excluded.metadata
    returning * into v_job;

    update academy.course_run_sessions
    set meeting_provider = 'zoom',
        meeting_status = 'queued',
        meeting_last_error = null
    where id = v_session.id;
  else
    raise exception 'invalid_training_automation_action';
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
    'training.automation.' || p_action,
    case
      when v_job.id is not null then 'training_automation_job'
      when v_enrollment.id is not null then 'enrollment'
      else 'training_automation'
    end,
    coalesce(
      v_job.id::text,
      v_enrollment.id::text,
      v_tenant.id::text
    ),
    jsonb_strip_nulls(jsonb_build_object(
      'jobId', v_job.id,
      'jobType', v_job.job_type,
      'channel', v_job.channel,
      'sessionId', coalesce(v_job.session_id, v_session.id),
      'enrollmentId', coalesce(v_job.enrollment_id, v_enrollment.id)
    ))
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'action', p_action,
    'jobId', v_job.id,
    'status', v_job.status,
    'jobType', v_job.job_type,
    'channel', v_job.channel,
    'sessionId', coalesce(v_job.session_id, v_session.id),
    'enrollmentId', coalesce(v_job.enrollment_id, v_enrollment.id)
  ));
end;
$$;

create or replace function private_app.training_automation_secret_valid(
  p_secret text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets secret
    where secret.name = 'training_automation_secret'
      and secret.decrypted_secret = p_secret
  );
$$;

revoke all on function
  private_app.training_automation_secret_valid(text)
from public, anon, authenticated;

create or replace function public.v2_training_automation_claim_jobs(
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

  perform private_app.prepare_training_automation_jobs(null);

  update academy.training_automation_jobs
  set status = 'pending',
      locked_at = null,
      last_error = 'dispatcher_timeout'
  where status = 'processing'
    and locked_at < now() - interval '10 minutes';

  with due_zoom as (
    select exists (
      select 1
      from academy.training_automation_jobs zoom_job
      where (
        zoom_job.status in ('pending', 'waiting_configuration')
        or (
          zoom_job.status = 'failed'
          and zoom_job.attempts < zoom_job.max_attempts
        )
      )
        and zoom_job.due_at <= now()
        and zoom_job.job_type = 'zoom_meeting_create'
    ) as has_due_zoom
  ),
  due as (
    select job.id
    from academy.training_automation_jobs job
    where (
      job.status in ('pending', 'waiting_configuration')
      or (
        job.status = 'failed'
        and job.attempts < job.max_attempts
      )
    )
      and job.due_at <= now()
      and (
        job.job_type = 'zoom_meeting_create'
        or not (select has_due_zoom from due_zoom)
      )
    order by job.due_at, job.created_at
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update academy.training_automation_jobs job
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
    'id', claimed.id,
    'tenantId', claimed.tenant_id,
    'courseRunId', claimed.course_run_id,
    'sessionId', claimed.session_id,
    'enrollmentId', claimed.enrollment_id,
    'type', claimed.job_type,
    'channel', claimed.channel,
    'recipient', claimed.recipient,
    'subject', claimed.subject,
    'messageText', claimed.message_text,
    'attempts', claimed.attempts,
    'metadata', claimed.metadata,
    'timezone', tenant.timezone,
    'session', case
      when session.id is null then null
      else jsonb_build_object(
        'id', session.id,
        'title', session.title,
        'startsAt', session.starts_at,
        'endsAt', session.ends_at,
        'deliveryMode', session.delivery_mode,
        'instructorName', session.instructor_name
      )
    end,
    'courseRun', jsonb_build_object(
      'id', run.id,
      'title', coalesce(run.title, course.title_ar),
      'courseName', course.title_ar,
      'runCode', run.run_code
    )
  )) order by claimed.due_at), '[]'::jsonb)
  into v_result
  from claimed
  join core.tenants tenant
    on tenant.id = claimed.tenant_id
  join academy.course_runs run
    on run.id = claimed.course_run_id
  join academy.courses course
    on course.id = run.course_id
  left join academy.course_run_sessions session
    on session.id = claimed.session_id;

  return v_result;
end;
$$;

create or replace function public.v2_training_automation_complete_job(
  p_secret text,
  p_job_id uuid,
  p_result_state text,
  p_external_id text default null,
  p_external_url text default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job academy.training_automation_jobs%rowtype;
begin
  if not private_app.training_automation_secret_valid(p_secret) then
    raise exception 'forbidden';
  end if;
  if p_result_state not in (
    'sent',
    'ready',
    'missing_configuration',
    'failed'
  ) then raise exception 'invalid_job_result'; end if;

  select *
  into v_job
  from academy.training_automation_jobs job
  where job.id = p_job_id
  for update;

  if v_job.id is null then raise exception 'automation_job_not_found'; end if;
  if v_job.job_type = 'zoom_meeting_create'
     and p_result_state in ('sent', 'ready')
     and (
       p_result_state <> 'ready'
       or nullif(p_external_id, '') is null
       or nullif(p_external_url, '') is null
     ) then
    raise exception 'invalid_zoom_provider_result';
  end if;
  if v_job.job_type <> 'zoom_meeting_create'
     and p_result_state = 'ready' then
    raise exception 'invalid_communication_provider_result';
  end if;

  if p_result_state in ('sent', 'ready') then
    update academy.training_automation_jobs
    set status = 'sent',
        external_id = nullif(p_external_id, ''),
        external_url = nullif(p_external_url, ''),
        last_error = null,
        locked_at = null,
        processed_at = now()
    where id = v_job.id
    returning * into v_job;
  elsif p_result_state = 'missing_configuration' then
    update academy.training_automation_jobs
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
    update academy.training_automation_jobs
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

  if v_job.job_type = 'joining_instructions'
     and v_job.status = 'sent' then
    insert into academy.student_communications (
      tenant_id,
      course_run_id,
      enrollment_id,
      message_type,
      channel,
      status,
      message_text,
      sent_at,
      metadata
    )
    values (
      v_job.tenant_id,
      v_job.course_run_id,
      v_job.enrollment_id,
      'joining_instructions',
      v_job.channel,
      'sent',
      v_job.message_text,
      now(),
      jsonb_strip_nulls(jsonb_build_object(
        'deliveryMode', 'provider_api',
        'jobId', v_job.id,
        'externalId', v_job.external_id
      ))
    )
    on conflict (enrollment_id, message_type) do update
    set channel = excluded.channel,
        status = 'sent',
        message_text = excluded.message_text,
        sent_at = now(),
        sent_by_subject_id = null,
        metadata = excluded.metadata;
  end if;

  if v_job.job_type = 'zoom_meeting_create' then
    if v_job.status = 'sent' then
      update academy.course_run_sessions
      set meeting_provider = 'zoom',
          external_meeting_id = v_job.external_id,
          meeting_join_url = v_job.external_url,
          meeting_status = 'ready',
          meeting_created_at = now(),
          meeting_last_error = null,
          venue_or_link = v_job.external_url
      where id = v_job.session_id;

      update academy.training_automation_jobs reminder
      set message_text =
            private_app.build_session_reminder_message(
              reminder.enrollment_id,
              reminder.session_id
            ),
          metadata = jsonb_set(
            reminder.metadata,
            '{venueOrLink}',
            to_jsonb(v_job.external_url),
            true
          )
      where reminder.session_id = v_job.session_id
        and reminder.job_type in (
          'session_reminder_24h',
          'session_reminder_1h'
        )
        and reminder.status not in ('sent', 'cancelled');
    elsif v_job.status = 'failed' then
      update academy.course_run_sessions
      set meeting_provider = 'zoom',
          meeting_status = 'failed',
          meeting_last_error = v_job.last_error
      where id = v_job.session_id;
    else
      update academy.course_run_sessions
      set meeting_provider = 'zoom',
          meeting_status = 'queued',
          meeting_last_error = v_job.last_error
      where id = v_job.session_id;
    end if;
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
    'training.automation.dispatch_' || p_result_state,
    'training_automation_job',
    v_job.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'jobType', v_job.job_type,
      'channel', v_job.channel,
      'attempts', v_job.attempts,
      'externalId', v_job.external_id
    ))
  );

  return jsonb_build_object(
    'jobId', v_job.id,
    'status', v_job.status,
    'attempts', v_job.attempts
  );
end;
$$;

create or replace function public.v2_training_automation_provider_health(
  p_secret text,
  p_provider text,
  p_state text,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_system_type text;
  v_status text;
  v_count integer;
begin
  if not private_app.training_automation_secret_valid(p_secret) then
    raise exception 'forbidden';
  end if;
  if p_provider not in ('whatsapp', 'email', 'zoom') then
    raise exception 'invalid_provider';
  end if;
  if p_state not in ('ready', 'missing_configuration', 'error') then
    raise exception 'invalid_provider_state';
  end if;

  v_system_type := case p_provider
    when 'whatsapp' then 'whatsapp_cloud'
    when 'email' then 'resend_email'
    else 'zoom_meetings'
  end;
  v_status := case p_state
    when 'ready' then 'active'
    when 'error' then 'error'
    else 'draft'
  end;

  update core.integrations integration
  set status = v_status,
      last_checked_at = now(),
      configuration = integration.configuration
        || jsonb_strip_nulls(jsonb_build_object(
          'dispatchMode', 'supabase_edge_function',
          'providerState', p_state,
          'statusDetail', left(nullif(p_detail, ''), 240)
        ))
  where integration.system_type = v_system_type
    and integration.tenant_id is not null;

  get diagnostics v_count = row_count;
  return jsonb_build_object(
    'provider', p_provider,
    'state', p_state,
    'updated', v_count
  );
end;
$$;

revoke execute on function
  public.v2_tenant_training_automation_snapshot(text)
from public, anon;

revoke execute on function
  public.v2_tenant_training_automation_action(text, text, jsonb)
from public, anon;

revoke execute on function
  public.v2_training_automation_claim_jobs(text, integer)
from public, anon, authenticated;

revoke execute on function
  public.v2_training_automation_complete_job(
    text,
    uuid,
    text,
    text,
    text,
    text
  )
from public, anon, authenticated;

revoke execute on function
  public.v2_training_automation_provider_health(
    text,
    text,
    text,
    text
  )
from public, anon, authenticated;

grant execute on function
  public.v2_tenant_training_automation_snapshot(text)
to authenticated;

grant execute on function
  public.v2_tenant_training_automation_action(text, text, jsonb)
to authenticated;

grant execute on function
  public.v2_training_automation_claim_jobs(text, integer)
to service_role;

grant execute on function
  public.v2_training_automation_complete_job(
    text,
    uuid,
    text,
    text,
    text,
    text
  )
to service_role;

grant execute on function
  public.v2_training_automation_provider_health(
    text,
    text,
    text,
    text
  )
to service_role;

do $schedule$
declare
  v_job_id bigint;
begin
  select job.jobid
  into v_job_id
  from cron.job job
  where job.jobname = 'marktone-training-automation-dispatch'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'marktone-training-automation-dispatch',
    '*/5 * * * *',
    $command$
      select net.http_post(
        url :=
          'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
          || 'training-automation-dispatch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-marktone-automation-secret',
          (
            select secret.decrypted_secret
            from vault.decrypted_secrets secret
            where secret.name = 'training_automation_secret'
          )
        ),
        body := jsonb_build_object(
          'trigger', 'pg_cron',
          'requestedAt', now()
        ),
        timeout_milliseconds := 10000
      ) as request_id;
    $command$
  );
end;
$schedule$;

comment on table academy.training_automation_settings is
'Tenant preferences for joining messages, reminders, and Zoom meeting creation.';

comment on table academy.training_automation_jobs is
'Durable provider-neutral outbox for learner communications and Zoom meetings.';

comment on function
  public.v2_tenant_training_automation_snapshot(text) is
'Role-protected delivery, provider-health, and Zoom status snapshot.';

comment on function
  public.v2_tenant_training_automation_action(text, text, jsonb) is
'Queues or retries learner communication and Zoom automation after permission checks.';

commit;
