begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Additive capability only. No seeds, backfill, tenant updates or rollout writes.
create unique index if not exists courses_tenant_id_id_uidx on academy.courses(tenant_id,id);
create unique index if not exists course_runs_tenant_course_id_uidx on academy.course_runs(tenant_id,course_id,id);
create unique index if not exists course_sessions_tenant_run_id_uidx on academy.course_run_sessions(tenant_id,course_run_id,id);

create table sales_core.contact_course_interests (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  contact_id uuid not null,
  course_id uuid not null,
  course_run_id uuid,
  attendance_session_id uuid,
  position integer not null check(position between 0 and 19),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,contact_id,course_id),
  foreign key(tenant_id,contact_id) references sales_core.contacts(tenant_id,id) on delete cascade,
  foreign key(tenant_id,course_id) references academy.courses(tenant_id,id),
  foreign key(tenant_id,course_id,course_run_id) references academy.course_runs(tenant_id,course_id,id),
  foreign key(tenant_id,course_run_id,attendance_session_id) references academy.course_run_sessions(tenant_id,course_run_id,id),
  check(attendance_session_id is null or course_run_id is not null)
);
create index contact_course_interests_course_idx on sales_core.contact_course_interests(tenant_id,course_id,course_run_id);
create index contact_course_interests_session_idx on sales_core.contact_course_interests(tenant_id,course_run_id,attendance_session_id);
alter table sales_core.contact_course_interests enable row level security;
revoke all on sales_core.contact_course_interests from public,anon,authenticated;

create table sales_core.followup_commands (
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  command_id uuid not null,
  contact_id uuid not null,
  actor_id uuid not null references access_control.subjects(id),
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(tenant_id,command_id),
  foreign key(tenant_id,contact_id) references sales_core.contacts(tenant_id,id) on delete cascade
);
create index followup_commands_contact_idx on sales_core.followup_commands(tenant_id,contact_id,created_at);
create index followup_commands_actor_idx on sales_core.followup_commands(actor_id);
alter table sales_core.followup_commands enable row level security;
revoke all on sales_core.followup_commands from public,anon,authenticated;

-- Reuse the canonical identity registry. Aliases survive edits to primary fields.
alter table sales_core.contact_identities drop constraint contact_identities_source_slot_check;
alter table sales_core.contact_identities add constraint contact_identities_source_slot_check
  check(source_slot in ('phone','whatsapp','email','merged_alias','historical_alias','additional_phone'));

create function private_app.sales_followup_contact(p_slug text,p_contact_id uuid,p_write boolean default false)
returns sales_core.contacts language plpgsql stable security invoker set search_path = '' as $$
declare v_tenant_id uuid; v_contact sales_core.contacts%rowtype; v_staff_id uuid;
begin
  select id into v_tenant_id from core.tenants where slug=p_slug;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if private_app.current_subject_id() is null or not coalesce(private_app.has_tenant_permission(
    v_tenant_id,case when p_write then 'tenant.crm.write' else 'tenant.crm.read' end
  ),false) then raise exception 'forbidden'; end if;
  select * into v_contact from sales_core.contacts where tenant_id=v_tenant_id and id=p_contact_id;
  if v_contact.id is null then raise exception 'invalid_contact'; end if;
  v_staff_id := private_app.current_staff_id(v_tenant_id);
  if not coalesce(private_app.can_view_tenant_team(v_tenant_id),false) and
     (v_staff_id is null or v_contact.owner_staff_id is distinct from v_staff_id)
  then raise exception 'forbidden'; end if;
  return v_contact;
end;
$$;

create function private_app.sales_followup_details(p_tenant_id uuid,p_contact_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'courseInterests',coalesce((
      select jsonb_agg(jsonb_build_object(
        'courseId',i.course_id,'courseName',c.title_ar,'courseStatus',c.status,
        'courseRunId',i.course_run_id,'runTitle',r.title,'runStatus',r.status,
        'attendanceSessionId',i.attendance_session_id,'sessionTitle',s.title,'sessionStatus',s.status,
        'attendanceAt',coalesce(s.starts_at,r.starts_at)
      ) order by i.position,i.course_id)
      from (
        select course_id,course_run_id,attendance_session_id,
          case when course_id=(select interest_course_id from sales_core.contacts where tenant_id=p_tenant_id and id=p_contact_id) then -1 else position end as position
        from sales_core.contact_course_interests where tenant_id=p_tenant_id and contact_id=p_contact_id
        union all
        select contact.interest_course_id,null::uuid,null::uuid,-1
        from sales_core.contacts contact where contact.tenant_id=p_tenant_id and contact.id=p_contact_id
          and contact.interest_course_id is not null and not exists (
            select 1 from sales_core.contact_course_interests existing
            where existing.tenant_id=p_tenant_id and existing.contact_id=p_contact_id
              and existing.course_id=contact.interest_course_id
          )
      ) i
      join academy.courses c on c.tenant_id=p_tenant_id and c.id=i.course_id
      left join academy.course_runs r on r.tenant_id=p_tenant_id and r.id=i.course_run_id
      left join academy.course_run_sessions s on s.tenant_id=p_tenant_id and s.id=i.attendance_session_id
    ),'[]'::jsonb),
    'additionalPhones',coalesce((
      select jsonb_agg(identity.identity_value order by identity.created_at,identity.id)
      from sales_core.contact_identities identity
      where identity.tenant_id=p_tenant_id and identity.contact_id=p_contact_id
        and identity.identity_type='phone' and identity.source_slot='additional_phone'
    ),'[]'::jsonb)
  );
$$;

create function public.v1_tenant_sales_followup_context(p_tenant_slug text,p_contact_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_contact sales_core.contacts%rowtype; v_details jsonb;
begin
  v_contact := private_app.sales_followup_contact(p_tenant_slug,p_contact_id);
  v_details := private_app.sales_followup_details(v_contact.tenant_id,v_contact.id);
  return v_details || jsonb_build_object(
    'revision',md5(v_contact.updated_at::text || v_details::text),
    'primaryPhone',v_contact.phone,'whatsapp',v_contact.whatsapp,
    'baseContact',jsonb_build_object('name',v_contact.full_name,'leadStatus',v_contact.lead_status,'leadQuality',v_contact.lead_quality),
    'timezone',(select timezone from core.tenants where id=v_contact.tenant_id)
  );
end;
$$;

create function public.v1_tenant_sales_followup_options(p_tenant_slug text,p_contact_id uuid,p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set statement_timeout = '4s' as $$
declare v_contact sales_core.contacts%rowtype; v_runs jsonb;
begin
  v_contact := private_app.sales_followup_contact(p_tenant_slug,p_contact_id);
  if not exists(select 1 from academy.courses where tenant_id=v_contact.tenant_id and id=p_course_id)
    then raise exception 'invalid_course'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'courseId',r.course_id,'title',coalesce(r.title,r.run_code),
    'startsAt',r.starts_at,'status',r.status,
    'sessions',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'title',s.title,'startsAt',s.starts_at,'endsAt',s.ends_at,'status',s.status
    ) order by s.starts_at,s.id)
    from academy.course_run_sessions s where s.tenant_id=v_contact.tenant_id and s.course_run_id=r.id
      and s.status='scheduled'),'[]'::jsonb)
  ) order by r.starts_at nulls last,r.id),'[]'::jsonb) into v_runs
  from academy.course_runs r where r.tenant_id=v_contact.tenant_id and r.course_id=p_course_id
    and r.status in ('planning','open','in_progress');
  return jsonb_build_object('courseId',p_course_id,'runs',v_runs);
end;
$$;

create function public.v2_tenant_record_sales_followup_v6(
  p_tenant_slug text,p_contact_id uuid,p_activity_type text,p_summary text,p_lead_status text,
  p_course_interests jsonb,p_additional_phones jsonb,p_expected_revision text,p_command_id uuid,
  p_lead_quality text default 'unrated',p_next_action_type text default null,p_next_action_at timestamptz default null,
  p_payment_course_id uuid default null,p_payment_amount_minor bigint default null,p_payment_reference text default null,
  p_closure_reason text default null,p_contact_name text default null,p_task_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_contact sales_core.contacts%rowtype; v_context jsonb; v_previous jsonb; v_result jsonb;
  v_request_hash text; v_command sales_core.followup_commands%rowtype;
  v_item jsonb; v_course_id uuid; v_run_id uuid; v_session_id uuid; v_position integer := 0;
  v_courses uuid[] := '{}'::uuid[]; v_phones text[] := '{}'::text[]; v_phone text;
  v_selected jsonb; v_primary_course uuid; v_attendance_at timestamptz; v_start_date date;
begin
  v_contact := private_app.sales_followup_contact(p_tenant_slug,p_contact_id,true);
  if p_command_id is null or p_expected_revision is null then raise exception 'followup_reload_required'; end if;
  if jsonb_typeof(p_course_interests) is distinct from 'array' or jsonb_array_length(p_course_interests)>20
     or jsonb_typeof(p_additional_phones) is distinct from 'array' or jsonb_array_length(p_additional_phones)>10
    then raise exception 'invalid_followup_details'; end if;
  v_request_hash := md5(jsonb_build_array(p_contact_id,p_activity_type,p_summary,p_lead_status,p_course_interests,
    p_additional_phones,p_expected_revision,p_lead_quality,p_next_action_type,p_next_action_at,p_payment_course_id,
    p_payment_amount_minor,p_payment_reference,p_closure_reason,p_contact_name,p_task_id)::text);
  -- Match the existing identity editor lock order, then the existing task lifecycle lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_contact.tenant_id::text,1729));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_contact.tenant_id::text || ':' || p_contact_id::text,31603));
  perform id from sales_core.contacts where tenant_id=v_contact.tenant_id and id=p_contact_id for update;
  v_contact := private_app.sales_followup_contact(p_tenant_slug,p_contact_id,true);
  select * into v_command from sales_core.followup_commands where tenant_id=v_contact.tenant_id and command_id=p_command_id;
  if found then
    if v_command.contact_id<>p_contact_id or v_command.actor_id<>private_app.current_subject_id()
       or v_command.request_hash<>v_request_hash then raise exception 'followup_command_conflict'; end if;
    return v_command.result || jsonb_build_object('replayed',true);
  end if;
  v_context := public.v1_tenant_sales_followup_context(p_tenant_slug,p_contact_id);
  if v_context->>'revision' is distinct from p_expected_revision then raise exception 'followup_changed_reload'; end if;
    v_previous := v_context - 'revision' - 'timezone';

  for v_item in select value from jsonb_array_elements(p_course_interests) loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'invalid_followup_details'; end if;
    v_course_id := nullif(v_item->>'courseId','')::uuid;
    v_run_id := nullif(v_item->>'courseRunId','')::uuid;
    v_session_id := nullif(v_item->>'attendanceSessionId','')::uuid;
    if v_course_id is null or v_course_id=any(v_courses) then raise exception 'duplicate_or_missing_course'; end if;
    if not exists(select 1 from academy.courses where tenant_id=v_contact.tenant_id and id=v_course_id and status<>'archived')
      then raise exception 'invalid_course'; end if;
    if v_run_id is not null and not exists(select 1 from academy.course_runs
      where tenant_id=v_contact.tenant_id and course_id=v_course_id and id=v_run_id and status in ('planning','open','in_progress'))
      then raise exception 'invalid_course_run'; end if;
    if v_session_id is not null and (v_run_id is null or not exists(select 1 from academy.course_run_sessions
      where tenant_id=v_contact.tenant_id and course_run_id=v_run_id and id=v_session_id and status='scheduled'))
      then raise exception 'invalid_attendance_session'; end if;
    v_courses := array_append(v_courses,v_course_id);
  end loop;
  v_primary_course := v_courses[1];
  if p_lead_status='payment_submitted' then
    if p_payment_course_id is null or not (p_payment_course_id=any(v_courses)) then raise exception 'payment_course_required'; end if;
    select item into v_selected from jsonb_array_elements(p_course_interests) item where item->>'courseId'=p_payment_course_id::text;
    v_run_id := nullif(v_selected->>'courseRunId','')::uuid;
    v_session_id := nullif(v_selected->>'attendanceSessionId','')::uuid;
    select coalesce(s.starts_at,r.starts_at) into v_attendance_at from academy.course_runs r
      left join academy.course_run_sessions s on s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.id=v_session_id
      where r.tenant_id=v_contact.tenant_id and r.id=v_run_id;
    v_start_date := (v_attendance_at at time zone coalesce(nullif(v_context->>'timezone',''),'UTC'))::date;
  else v_run_id := null; v_session_id := null; end if;

  for v_item in select value from jsonb_array_elements(p_additional_phones) loop
    if jsonb_typeof(v_item)<>'string' or length(v_item #>> '{}')>40 then raise exception 'invalid_phone'; end if;
    v_phone := private_app.normalize_lead_phone(v_item #>> '{}');
    if v_phone is null then raise exception 'invalid_phone'; end if;
    if v_phone=any(v_phones) or v_phone in (private_app.normalize_lead_phone(v_contact.phone),private_app.normalize_lead_phone(v_contact.whatsapp))
      then raise exception 'duplicate_additional_phone'; end if;
    if exists(select 1 from sales_core.contact_identities where tenant_id=v_contact.tenant_id and identity_type='phone'
      and identity_value=v_phone and contact_id<>p_contact_id) then raise exception 'duplicate_contact_identity'; end if;
    v_phones := array_append(v_phones,v_phone);
  end loop;

  -- Explicit clear is supported; the legacy scalar remains the first interest for old readers.
  update sales_core.contacts set interest_course_id=v_primary_course where tenant_id=v_contact.tenant_id and id=p_contact_id;
  v_result := public.v2_tenant_record_sales_followup_v5(
    p_tenant_slug=>p_tenant_slug,p_contact_id=>p_contact_id,p_activity_type=>p_activity_type,p_summary=>p_summary,
    p_lead_status=>p_lead_status,p_lead_quality=>p_lead_quality,p_next_action_type=>p_next_action_type,p_next_action_at=>p_next_action_at,
    p_course_id=>case when p_lead_status='payment_submitted' then p_payment_course_id else v_primary_course end,
    p_course_run_id=>v_run_id,p_payment_amount_minor=>p_payment_amount_minor,p_payment_reference=>p_payment_reference,
    p_preferred_start_date=>v_start_date,p_closure_reason=>p_closure_reason,p_contact_name=>p_contact_name,p_task_id=>p_task_id
  );
  update sales_core.contacts set interest_course_id=v_primary_course where tenant_id=v_contact.tenant_id and id=p_contact_id;
  delete from sales_core.contact_course_interests where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and not(course_id=any(v_courses));
  for v_item in select value from jsonb_array_elements(p_course_interests) loop
    insert into sales_core.contact_course_interests(tenant_id,contact_id,course_id,course_run_id,attendance_session_id,position)
    values(v_contact.tenant_id,p_contact_id,(v_item->>'courseId')::uuid,nullif(v_item->>'courseRunId','')::uuid,
      nullif(v_item->>'attendanceSessionId','')::uuid,v_position)
    on conflict(tenant_id,contact_id,course_id) do update set course_run_id=excluded.course_run_id,
      attendance_session_id=excluded.attendance_session_id,position=excluded.position,updated_at=now();
    v_position := v_position+1;
  end loop;
  update sales_core.contact_identities set source_slot='historical_alias',updated_at=now()
    where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and source_slot='additional_phone' and not(identity_value=any(v_phones));
  foreach v_phone in array v_phones loop
    insert into sales_core.contact_identities(tenant_id,contact_id,identity_type,identity_value,source_slot,is_alias)
    values(v_contact.tenant_id,p_contact_id,'phone',v_phone,'additional_phone',true)
    on conflict(tenant_id,identity_type,identity_value) do update set source_slot='additional_phone',is_alias=true,updated_at=now()
      where sales_core.contact_identities.contact_id=excluded.contact_id;
    if not found then raise exception 'duplicate_contact_identity'; end if;
  end loop;
  v_context := public.v1_tenant_sales_followup_context(p_tenant_slug,p_contact_id);
  update sales_core.activities set metadata=metadata || jsonb_build_object('courseInterests',v_context->'courseInterests',
    'additionalPhones',v_context->'additionalPhones','followupCommandId',p_command_id)
    where tenant_id=v_contact.tenant_id and id=(v_result->>'id')::uuid;
  if v_result->>'handoffId' is not null then
    update academy.registration_handoffs set metadata=metadata || jsonb_build_object(
      'attendanceSessionId',v_session_id,'attendanceAt',v_attendance_at,'courseInterests',v_context->'courseInterests')
      where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and id=(v_result->>'handoffId')::uuid;
  end if;
  perform private_app.write_audit('tenant.sales_followup_details_updated','sales_contact',p_contact_id::text,v_contact.tenant_id,
    jsonb_build_object('old',v_previous,'new',v_context-'revision'-'timezone','commandId',p_command_id));
  v_result := v_result || jsonb_build_object('followupDetails',v_context);
  insert into sales_core.followup_commands(tenant_id,command_id,contact_id,actor_id,request_hash,result)
    values(v_contact.tenant_id,p_command_id,p_contact_id,private_app.current_subject_id(),v_request_hash,v_result);
  return v_result;
end;
$$;

create function public.v5_tenant_customer_history_snapshot(p_slug text,p_contact_id uuid,p_limit integer default 250)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_snapshot jsonb; v_tenant_id uuid;
begin
  v_snapshot := public.v4_tenant_customer_history_snapshot(p_slug,p_contact_id,p_limit);
  select id into v_tenant_id from core.tenants where slug=p_slug;
  return jsonb_set(v_snapshot || jsonb_build_object('timezone',(select timezone from core.tenants where id=v_tenant_id)),'{contact}',coalesce(v_snapshot->'contact','{}'::jsonb)
    || private_app.sales_followup_details(v_tenant_id,p_contact_id));
end;
$$;

revoke all on function private_app.sales_followup_contact(text,uuid,boolean) from public,anon,authenticated;
revoke all on function private_app.sales_followup_details(uuid,uuid) from public,anon,authenticated;
revoke all on function public.v1_tenant_sales_followup_context(text,uuid) from public,anon;
revoke all on function public.v1_tenant_sales_followup_options(text,uuid,uuid) from public,anon;
revoke all on function public.v5_tenant_customer_history_snapshot(text,uuid,integer) from public,anon;
revoke all on function public.v2_tenant_record_sales_followup_v6(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid) from public,anon;
grant execute on function public.v1_tenant_sales_followup_context(text,uuid),
  public.v1_tenant_sales_followup_options(text,uuid,uuid),
  public.v5_tenant_customer_history_snapshot(text,uuid,integer),
  public.v2_tenant_record_sales_followup_v6(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid)
to authenticated;

-- Versioned sales read keeps the original filters, metrics and cursor contract.
CREATE OR REPLACE FUNCTION public.v2_tenant_sales_workspace_snapshot(p_slug text, p_limit integer DEFAULT 80, p_query text DEFAULT NULL::text, p_filter text DEFAULT 'all'::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_focus_contact_id uuid DEFAULT NULL::uuid, p_include_auxiliary boolean DEFAULT true, p_after_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_after_next_action_is_null boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '4s'
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_view_team boolean := false;
  v_can_write boolean := false;
  v_can_reassign boolean := false;
  v_limit integer;
  v_query text;
  v_query_digit_count integer := 0;
  v_query_letter_count integer := 0;
  v_filter text;
  v_timezone text;
  v_today date;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_has_cursor boolean := false;
  v_summary jsonb := '{}'::jsonb;
  v_pipeline_counts jsonb := '{}'::jsonb;
  v_filtered_total bigint := 0;
  v_contacts jsonb := '[]'::jsonb;
  v_focused_contact jsonb := null;
  v_activities jsonb := '[]'::jsonb;
  v_handoffs jsonb := '[]'::jsonb;
  v_staff jsonb := '[]'::jsonb;
  v_courses jsonb := '[]'::jsonb;
  v_course_runs jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_last_contact jsonb := null;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = trim(coalesce(p_slug, ''))
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

  v_limit := least(greatest(coalesce(p_limit, 80), 1), 100);
  v_query := nullif(left(trim(coalesce(p_query, '')), 100), '');
  if v_query is not null then
    v_query_digit_count := char_length(regexp_replace(
      v_query,
      '[^0-9٠-٩۰-۹]',
      '',
      'g'
    ));
    v_query_letter_count := char_length(regexp_replace(
      v_query,
      '[^[:alpha:]]',
      '',
      'g'
    ));
    if (v_query_letter_count = 0 and v_query_digit_count < 3)
       or (v_query_letter_count > 0 and v_query_letter_count < 2) then
      raise exception 'invalid_query';
    end if;
  end if;
  v_filter := coalesce(nullif(trim(p_filter), ''), 'all');
  if v_filter not in (
    'all',
    'awaiting_payment',
    'payment_submitted',
    'very_interested',
    'excellent',
    'unqualified',
    'overdue',
    'closed',
    'paid'
  ) then
    raise exception 'invalid_filter';
  end if;
  if p_from is not null and p_to is not null and p_to < p_from then
    raise exception 'invalid_date_range';
  end if;

  v_has_cursor := p_after_created_at is not null
    and p_after_id is not null;
  if (p_after_created_at is null) <> (p_after_id is null) then
    raise exception 'invalid_cursor';
  end if;
  if v_has_cursor
     and not coalesce(p_after_next_action_is_null, false)
     and p_after_next_action_at is null then
    raise exception 'invalid_cursor';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_view_team := coalesce(
    private_app.can_view_tenant_team(v_tenant.id),
    false
  );
  v_can_write := coalesce(private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.crm.write'
  ), false);
  v_can_reassign := coalesce(private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.leads.reassign'
  ), false);
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_today := (now() at time zone v_timezone)::date;
  if p_from is not null then
    v_from_at := p_from::timestamp at time zone v_timezone;
  end if;
  if p_to is not null then
    v_to_at := (p_to + 1)::timestamp at time zone v_timezone;
  end if;

  select jsonb_build_object(
    'activeLeads', count(*) filter (
      where contact.lead_status in (
        'new',
        'no_answer',
        'busy',
        'phone_off',
        'follow_up',
        'interested',
        'very_interested',
        'awaiting_payment',
        'postponed'
      )
    ),
    'awaitingPayment', count(*) filter (
      where contact.lead_status = 'awaiting_payment'
    ),
    'paymentSubmitted', count(*) filter (
      where contact.lead_status = 'payment_submitted'
    ),
    'veryInterested', count(*) filter (
      where contact.lead_status = 'very_interested'
    ),
    'excellentLeads', count(*) filter (
      where contact.lead_quality = 'excellent'
    ),
    'unqualifiedLeads', count(*) filter (
      where contact.lead_quality = 'unqualified'
         or contact.lead_status = 'unqualified'
    ),
    'paidThisMonth', count(*) filter (
      where contact.lead_status = 'paid'
        and date_trunc(
          'month',
          coalesce(
            contact.last_activity_at,
            contact.lead_status_changed_at,
            contact.updated_at
          ) at time zone v_timezone
        ) = date_trunc('month', now() at time zone v_timezone)
    ),
    'overdueFollowups', count(*) filter (
      where contact.lead_status in (
        'new',
        'no_answer',
        'busy',
        'phone_off',
        'follow_up',
        'interested',
        'very_interested',
        'awaiting_payment',
        'postponed'
      )
        and contact.next_action_at is not null
        and (
          contact.next_action_at at time zone v_timezone
        )::date < v_today
    )
  )
  into v_summary
  from sales_core.contacts contact
  where contact.tenant_id = v_tenant.id
    and (v_view_team or contact.owner_staff_id = v_staff_id);

  select
    count(*),
    jsonb_build_object(
      'new', count(*) filter (
        where contact.lead_status in (
          'new',
          'no_answer',
          'busy',
          'follow_up',
          'postponed'
        )
      ),
      'interested', count(*) filter (
        where contact.lead_status = 'interested'
      ),
      'very_interested', count(*) filter (
        where contact.lead_status = 'very_interested'
      ),
      'awaiting_payment', count(*) filter (
        where contact.lead_status = 'awaiting_payment'
      )
    )
  into v_filtered_total, v_pipeline_counts
  from sales_core.contacts contact
  left join academy.courses course
    on course.id = contact.interest_course_id
   and course.tenant_id = v_tenant.id
  where contact.tenant_id = v_tenant.id
    and (v_view_team or contact.owner_staff_id = v_staff_id)
    and (
      v_query is null
      or exists (select 1 from sales_core.contact_identities identity
        where identity.tenant_id=v_tenant.id and identity.contact_id=contact.id
          and identity.identity_type='phone'
          and identity.identity_value=private_app.normalize_lead_phone(v_query))
      or position(
        lower(v_query) in lower(concat_ws(
          ' ',
          contact.full_name,
          contact.organization_name,
          contact.phone,
          course.title_ar,
          contact.source,
          contact.campaign_name
        ))
      ) > 0
    )
    and (
      v_filter = 'all'
      or (v_filter = 'excellent' and contact.lead_quality = 'excellent')
      or (
        v_filter = 'unqualified'
        and (
          contact.lead_quality = 'unqualified'
          or contact.lead_status = 'unqualified'
        )
      )
      or (
        v_filter = 'overdue'
        and contact.lead_status in (
          'new',
          'no_answer',
          'busy',
          'phone_off',
          'follow_up',
          'interested',
          'very_interested',
          'awaiting_payment',
          'postponed'
        )
        and contact.next_action_at is not null
        and (
          contact.next_action_at at time zone v_timezone
        )::date < v_today
      )
      or (
        v_filter = 'closed'
        and contact.lead_status in (
          'not_interested',
          'unqualified',
          'wrong_number',
          'duplicate',
          'cancelled'
        )
      )
      or (
        v_filter in (
          'awaiting_payment',
          'payment_submitted',
          'very_interested',
          'paid'
        )
        and contact.lead_status = v_filter
      )
    )
    and (v_from_at is null or contact.next_action_at >= v_from_at)
    and (v_to_at is null or contact.next_action_at < v_to_at);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', page.id,
      'contactKey', page.contact_key,
      'name', page.full_name,
      'organizationName', page.organization_name,
      'phone', page.phone,
      'whatsapp', page.whatsapp,
      'email', page.email,
      'source', page.source,
      'campaignName', page.campaign_name,
      'adName', page.ad_name,
      'status', page.lead_status,
      'leadStatus', page.lead_status,
      'leadQuality', page.lead_quality,
      'ownerStaffId', page.owner_staff_id,
      'ownerName', page.owner_name,
      'followupDetails', private_app.sales_followup_details(v_tenant.id, page.id),
      'interestCourseId', page.interest_course_id,
      'interestCourseName', page.course_name,
      'notes', page.notes,
      'nextActionType', page.next_action_type,
      'nextActionAt', page.next_action_at,
      'lastActivityAt', page.last_activity_at,
      'latestNote', coalesce(
        nullif(latest_activity.summary, ''),
        nullif(page.notes, '')
      ),
      'latestNoteAt', coalesce(
        latest_activity.occurred_at,
        page.updated_at
      ),
      'latestNoteType', coalesce(
        latest_activity.activity_type,
        case when nullif(page.notes, '') is not null then 'customer_note' end
      ),
      'caseId', sales_case.id,
      'caseTitle', sales_case.title,
      'valueMinor', coalesce(sales_case.value_minor, 0),
      'activeAssignmentId', case
        when v_can_reassign then assignment.id
      end,
      'activeAssignmentStaffId', case
        when v_can_reassign then assignment.assigned_staff_id
      end,
      'demo', coalesce((page.metadata ->> 'demo')::boolean, false),
      'createdAt', page.created_at,
      'updatedAt', page.updated_at
    )
    order by
      page.next_action_at nulls last,
      page.created_at desc,
      page.id desc
  ), '[]'::jsonb)
  into v_contacts
  from (
    select
      contact.*,
      owner.full_name as owner_name,
      course.title_ar as course_name
    from sales_core.contacts contact
    left join people.staff_profiles owner
      on owner.id = contact.owner_staff_id
     and owner.tenant_id = v_tenant.id
    left join academy.courses course
      on course.id = contact.interest_course_id
     and course.tenant_id = v_tenant.id
    where contact.tenant_id = v_tenant.id
      and (v_view_team or contact.owner_staff_id = v_staff_id)
      and (
        v_query is null
        or exists (select 1 from sales_core.contact_identities identity
          where identity.tenant_id=v_tenant.id and identity.contact_id=contact.id
            and identity.identity_type='phone'
            and identity.identity_value=private_app.normalize_lead_phone(v_query))
        or position(
          lower(v_query) in lower(concat_ws(
            ' ',
            contact.full_name,
            contact.organization_name,
            contact.phone,
            course.title_ar,
            contact.source,
            contact.campaign_name
          ))
        ) > 0
      )
      and (
        v_filter = 'all'
        or (v_filter = 'excellent' and contact.lead_quality = 'excellent')
        or (
          v_filter = 'unqualified'
          and (
            contact.lead_quality = 'unqualified'
            or contact.lead_status = 'unqualified'
          )
        )
        or (
          v_filter = 'overdue'
          and contact.lead_status in (
            'new',
            'no_answer',
            'busy',
            'phone_off',
            'follow_up',
            'interested',
            'very_interested',
            'awaiting_payment',
            'postponed'
          )
          and contact.next_action_at is not null
          and (
            contact.next_action_at at time zone v_timezone
          )::date < v_today
        )
        or (
          v_filter = 'closed'
          and contact.lead_status in (
            'not_interested',
            'unqualified',
            'wrong_number',
            'duplicate',
            'cancelled'
          )
        )
        or (
          v_filter in (
            'awaiting_payment',
            'payment_submitted',
            'very_interested',
            'paid'
          )
          and contact.lead_status = v_filter
        )
      )
      and (v_from_at is null or contact.next_action_at >= v_from_at)
      and (v_to_at is null or contact.next_action_at < v_to_at)
      and (
        not v_has_cursor
        or (
          coalesce(p_after_next_action_is_null, false)
          and contact.next_action_at is null
          and (
            contact.created_at < p_after_created_at
            or (
              contact.created_at = p_after_created_at
              and contact.id < p_after_id
            )
          )
        )
        or (
          not coalesce(p_after_next_action_is_null, false)
          and (
            contact.next_action_at is null
            or contact.next_action_at > p_after_next_action_at
            or (
              contact.next_action_at = p_after_next_action_at
              and (
                contact.created_at < p_after_created_at
                or (
                  contact.created_at = p_after_created_at
                  and contact.id < p_after_id
                )
              )
            )
          )
        )
      )
    order by
      contact.next_action_at nulls last,
      contact.created_at desc,
      contact.id desc
    limit v_limit + 1
  ) page
  left join lateral (
    select
      opportunity.id,
      opportunity.title,
      opportunity.value_minor
    from sales_core.opportunities opportunity
    where opportunity.tenant_id = v_tenant.id
      and opportunity.contact_id = page.id
    order by
      (opportunity.status = 'open') desc,
      opportunity.created_at desc,
      opportunity.id desc
    limit 1
  ) sales_case on true
  left join lateral (
    select
      activity.summary,
      activity.occurred_at,
      activity.activity_type
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.contact_id = page.id
    order by activity.occurred_at desc, activity.id desc
    limit 1
  ) latest_activity on true
  left join sales_core.lead_assignments assignment
    on v_can_reassign
   and assignment.tenant_id = v_tenant.id
   and assignment.contact_id = page.id
   and assignment.status = 'active';

  v_has_more := jsonb_array_length(v_contacts) > v_limit;
  if v_has_more then
    v_contacts := v_contacts - v_limit;
  end if;
  if jsonb_array_length(v_contacts) > 0 then
    v_last_contact := v_contacts -> (jsonb_array_length(v_contacts) - 1);
  end if;

  if p_focus_contact_id is not null then
    select item
    into v_focused_contact
    from jsonb_array_elements(v_contacts) item
    where item ->> 'id' = p_focus_contact_id::text
    limit 1;

    if v_focused_contact is null then
      select jsonb_build_object(
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
        'followupDetails', private_app.sales_followup_details(v_tenant.id, contact.id),
      'interestCourseId', contact.interest_course_id,
        'interestCourseName', course.title_ar,
        'notes', contact.notes,
        'nextActionType', contact.next_action_type,
        'nextActionAt', contact.next_action_at,
        'lastActivityAt', contact.last_activity_at,
        'latestNote', coalesce(
          nullif(latest_activity.summary, ''),
          nullif(contact.notes, '')
        ),
        'latestNoteAt', coalesce(
          latest_activity.occurred_at,
          contact.updated_at
        ),
        'latestNoteType', coalesce(
          latest_activity.activity_type,
          case
            when nullif(contact.notes, '') is not null then 'customer_note'
          end
        ),
        'caseId', sales_case.id,
        'caseTitle', sales_case.title,
        'valueMinor', coalesce(sales_case.value_minor, 0),
        'activeAssignmentId', case
          when v_can_reassign then assignment.id
        end,
        'activeAssignmentStaffId', case
          when v_can_reassign then assignment.assigned_staff_id
        end,
        'demo', coalesce((contact.metadata ->> 'demo')::boolean, false),
        'createdAt', contact.created_at,
        'updatedAt', contact.updated_at
      )
      into v_focused_contact
      from sales_core.contacts contact
      left join people.staff_profiles owner
        on owner.id = contact.owner_staff_id
       and owner.tenant_id = v_tenant.id
      left join academy.courses course
        on course.id = contact.interest_course_id
       and course.tenant_id = v_tenant.id
      left join lateral (
        select
          opportunity.id,
          opportunity.title,
          opportunity.value_minor
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant.id
          and opportunity.contact_id = contact.id
        order by
          (opportunity.status = 'open') desc,
          opportunity.created_at desc,
          opportunity.id desc
        limit 1
      ) sales_case on true
      left join lateral (
        select
          activity.summary,
          activity.occurred_at,
          activity.activity_type
        from sales_core.activities activity
        where activity.tenant_id = v_tenant.id
          and activity.contact_id = contact.id
        order by activity.occurred_at desc, activity.id desc
        limit 1
      ) latest_activity on true
      left join sales_core.lead_assignments assignment
        on v_can_reassign
       and assignment.tenant_id = v_tenant.id
       and assignment.contact_id = contact.id
       and assignment.status = 'active'
      where contact.tenant_id = v_tenant.id
        and contact.id = p_focus_contact_id
        and (v_view_team or contact.owner_staff_id = v_staff_id)
      limit 1;
    end if;
  end if;

  if coalesce(p_include_auxiliary, true) then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', item.id,
        'contactId', item.contact_id,
        'contactName', item.contact_name,
        'contactPhone', item.contact_phone,
        'actorStaffId', item.actor_staff_id,
        'actorName', item.actor_name,
        'type', item.activity_type,
        'outcome', item.outcome,
        'summary', item.summary,
        'resultStatus', item.result_status,
        'resultQuality', item.result_quality,
        'occurredAt', item.occurred_at,
        'nextActionType', item.next_action_type,
        'nextActionAt', item.next_action_at,
        'demo', item.demo
      )
      order by item.occurred_at desc, item.id desc
    ), '[]'::jsonb)
    into v_activities
    from (
      select
        activity.id,
        activity.contact_id,
        contact.full_name as contact_name,
        contact.phone as contact_phone,
        activity.actor_staff_id,
        actor.full_name as actor_name,
        activity.activity_type,
        activity.outcome,
        activity.summary,
        activity.result_status,
        activity.result_quality,
        activity.occurred_at,
        activity.next_action_type,
        activity.next_action_at,
        coalesce((activity.metadata ->> 'demo')::boolean, false) as demo
      from sales_core.activities activity
      join sales_core.contacts contact
        on contact.id = activity.contact_id
       and contact.tenant_id = v_tenant.id
      left join people.staff_profiles actor
        on actor.id = activity.actor_staff_id
       and actor.tenant_id = v_tenant.id
      where activity.tenant_id = v_tenant.id
        and (
          v_view_team
          or activity.actor_staff_id = v_staff_id
          or contact.owner_staff_id = v_staff_id
        )
      order by activity.occurred_at desc, activity.id desc
      limit 150
    ) item;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', item.id,
        'contactId', item.contact_id,
        'contactName', item.contact_name,
        'courseId', item.course_id,
        'courseName', item.course_name,
        'courseRunId', item.course_run_id,
        'courseRunName', item.course_run_name,
        'status', item.status,
        'paidAt', item.paid_at,
        'amountMinor', item.payment_amount_minor,
        'preferredStartDate', item.preferred_start_date,
        'assignedStaffName', item.assigned_staff_name,
        'demo', item.demo
      )
      order by item.created_at desc, item.id desc
    ), '[]'::jsonb)
    into v_handoffs
    from (
      select
        handoff.id,
        handoff.contact_id,
        contact.full_name as contact_name,
        handoff.course_id,
        course.title_ar as course_name,
        handoff.course_run_id,
        coalesce(run.title, run.run_code) as course_run_name,
        handoff.status,
        handoff.paid_at,
        handoff.payment_amount_minor,
        handoff.preferred_start_date,
        assignee.full_name as assigned_staff_name,
        handoff.created_at,
        coalesce((handoff.metadata ->> 'demo')::boolean, false) as demo
      from academy.registration_handoffs handoff
      join sales_core.contacts contact
        on contact.id = handoff.contact_id
       and contact.tenant_id = v_tenant.id
      join academy.courses course
        on course.id = handoff.course_id
       and course.tenant_id = v_tenant.id
      left join academy.course_runs run
        on run.id = handoff.course_run_id
       and run.tenant_id = v_tenant.id
      left join people.staff_profiles assignee
        on assignee.id = handoff.assigned_staff_id
       and assignee.tenant_id = v_tenant.id
      where handoff.tenant_id = v_tenant.id
        and (
          v_view_team
          or contact.owner_staff_id = v_staff_id
          or handoff.assigned_staff_id = v_staff_id
        )
      order by handoff.created_at desc, handoff.id desc
      limit 100
    ) item;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', item.id,
        'name', item.full_name,
        'roleKey', item.role_key,
        'jobTitle', item.job_title,
        'departmentId', item.department_id,
        'department', item.department_name,
        'accountStatus', item.account_status
      )
      order by item.full_name, item.id
    ), '[]'::jsonb)
    into v_staff
    from (
      select
        staff.id,
        staff.full_name,
        staff.role_key,
        staff.job_title,
        staff.department_id,
        department.name_ar as department_name,
        staff.account_status
      from people.staff_profiles staff
      left join people.departments department
        on department.id = staff.department_id
       and department.tenant_id = v_tenant.id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and (
          v_view_team
          or v_can_reassign
          or staff.id = v_staff_id
        )
      order by staff.full_name, staff.id
      limit 250
    ) item;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', item.id,
        'courseCode', item.course_code,
        'nameAr', item.title_ar,
        'status', item.status
      )
      order by item.title_ar, item.id
    ), '[]'::jsonb)
    into v_courses
    from (
      select
        course.id,
        course.course_code,
        course.title_ar,
        course.status
      from academy.courses course
      where course.tenant_id = v_tenant.id
        and course.status <> 'archived'
      order by course.title_ar, course.id
      limit 500
    ) item;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', item.id,
        'courseId', item.course_id,
        'runCode', item.run_code,
        'title', item.title,
        'startsAt', item.starts_at,
        'endsAt', item.ends_at,
        'status', item.status,
        'capacity', item.capacity,
        'enrolledCount', item.enrolled_count
      )
      order by item.starts_at nulls last, item.id
    ), '[]'::jsonb)
    into v_course_runs
    from (
      select
        run.id,
        run.course_id,
        run.run_code,
        coalesce(run.title, course.title_ar) as title,
        run.starts_at,
        run.ends_at,
        run.status,
        run.capacity,
        run.enrolled_count
      from academy.course_runs run
      join academy.courses course
        on course.id = run.course_id
       and course.tenant_id = v_tenant.id
      where run.tenant_id = v_tenant.id
        and run.status in ('planning', 'open', 'in_progress')
      order by run.starts_at nulls last, run.id
      limit 250
    ) item;
  end if;

  return jsonb_build_object(
    'schemaVersion', 'tenant-sales-workspace-v1',
    'generatedAt', now(),
    'timezone', v_timezone,
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'viewTeam', v_view_team,
      'canWriteCrm', v_can_write,
      'canReassign', v_can_reassign
    ),
    'summary', v_summary,
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'total', v_filtered_total,
      'returned', jsonb_array_length(v_contacts),
      'hasMore', v_has_more,
      'pipelineCounts', v_pipeline_counts,
      'nextCursor', case
        when v_has_more and v_last_contact is not null then
          jsonb_build_object(
            'nextActionAt', v_last_contact -> 'nextActionAt',
            'createdAt', v_last_contact -> 'createdAt',
            'id', v_last_contact -> 'id',
            'nextActionIsNull',
              (v_last_contact ->> 'nextActionAt') is null
          )
        else null
      end
    ),
    'focusedContact', v_focused_contact,
    'contacts', v_contacts,
    'auxiliaryIncluded', coalesce(p_include_auxiliary, true),
    'auxiliaryLimits', jsonb_build_object(
      'activities', 150,
      'registrationHandoffs', 100,
      'staff', 250,
      'courses', 500,
      'courseRuns', 250
    ),
    'activities', v_activities,
    'registrationHandoffs', v_handoffs,
    'staff', v_staff,
    'courses', v_courses,
    'courseRuns', v_course_runs
  );
end;
$function$

;
revoke all on function public.v2_tenant_sales_workspace_snapshot(text,integer,text,text,date,date,uuid,boolean,timestamptz,timestamptz,uuid,boolean) from public,anon;
grant execute on function public.v2_tenant_sales_workspace_snapshot(text,integer,text,text,date,date,uuid,boolean,timestamptz,timestamptz,uuid,boolean) to authenticated;

commit;
