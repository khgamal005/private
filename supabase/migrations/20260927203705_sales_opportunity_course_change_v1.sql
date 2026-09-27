-- No backfill. Course replacement is an explicit employee action in one transaction.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

CREATE OR REPLACE FUNCTION private_app.sales_opportunity_course_change_allowed_v1(p_tenant_id uuid,p_opportunity_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=''
AS $function$
  select exists(select 1 from sales_core.opportunities o
    where o.tenant_id=p_tenant_id and o.id=p_opportunity_id and o.status='open'
      and o.course_id is not null and o.opportunity_kind in ('training','legacy_unclassified')
      and not exists(select 1 from academy.registration_handoffs h
        where h.tenant_id=p_tenant_id and h.opportunity_id=o.id));
$function$;
revoke all on function private_app.sales_opportunity_course_change_allowed_v1(uuid,uuid) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION private_app.record_sales_followup_scoped_v2(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_course_interests jsonb, p_additional_phones jsonb, p_expected_revision text, p_command_id uuid, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_payment_course_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid, p_opportunity_id uuid DEFAULT NULL::uuid, p_opportunity_course_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_scoped_opportunity sales_core.opportunities%rowtype;
  v_can_bind_payment_course boolean; v_previous_kind text;
  v_course_change jsonb; v_old_course_name text; v_new_course_name text;
  v_contact sales_core.contacts%rowtype; v_context jsonb; v_previous jsonb; v_result jsonb;
  v_request_hash text; v_command sales_core.followup_commands%rowtype;
  v_item jsonb; v_course_id uuid; v_run_id uuid; v_session_id uuid; v_position integer := 0;
  v_courses uuid[] := '{}'::uuid[]; v_phones text[] := '{}'::text[]; v_phone text;
  v_selected jsonb; v_primary_course uuid; v_attendance_at timestamptz; v_start_date date;
begin
  v_contact := private_app.sales_followup_contact(p_tenant_slug,p_contact_id,true);
  if p_command_id is null or p_expected_revision is null then raise exception 'followup_reload_required'; end if;
  if jsonb_typeof(p_course_interests) is distinct from 'array' or jsonb_array_length(p_course_interests)>20
     or jsonb_typeof(p_additional_phones) is distinct from 'array'
    then raise exception 'invalid_followup_details'; end if;
  v_request_hash := md5(jsonb_build_array(p_contact_id,p_activity_type,p_summary,p_lead_status,p_course_interests,
    p_additional_phones,p_expected_revision,p_lead_quality,p_next_action_type,p_next_action_at,p_payment_course_id,
    p_payment_amount_minor,p_payment_reference,p_closure_reason,p_contact_name,p_task_id)::text
    || coalesce(':'||p_opportunity_id::text,'') || ':course_change:' || coalesce(p_opportunity_course_id::text,''));
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
  perform private_app.validate_customer_phone_capacity_v1(v_contact.phone,v_contact.whatsapp,p_additional_phones);
  v_context := public.v1_tenant_sales_followup_context(p_tenant_slug,p_contact_id);
  if v_context->>'revision' is distinct from p_expected_revision then raise exception 'followup_changed_reload'; end if;
    v_previous := v_context - 'revision' - 'timezone';
  if p_opportunity_id is null and (select count(*) from sales_core.opportunities
      where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and status='open')>1
    then raise exception 'followup_opportunity_required'; end if;
  select * into v_scoped_opportunity from sales_core.opportunities
    where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and status='open'
      and (p_opportunity_id is null or id=p_opportunity_id)
    order by created_at,id limit 1 for update;
  if p_opportunity_id is not null and v_scoped_opportunity.id is null then raise exception 'invalid_followup_opportunity'; end if;
  v_can_bind_payment_course := private_app.sales_payment_course_bindable_v1(
    v_scoped_opportunity.opportunity_kind,v_scoped_opportunity.course_id,v_scoped_opportunity.metadata);
  if p_lead_status='payment_submitted' and v_scoped_opportunity.id is not null
      and coalesce(p_opportunity_course_id,v_scoped_opportunity.course_id) is distinct from p_payment_course_id
      and not v_can_bind_payment_course
    then raise exception 'payment_opportunity_mismatch'; end if;

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


  -- Explicit replacement only; interest edits alone never mutate a sale.
  if p_opportunity_course_id is not null then
    if p_opportunity_id is null or v_scoped_opportunity.course_id is null
      then raise exception 'opportunity_course_change_unavailable'; end if;
    if not (p_opportunity_course_id=any(v_courses))
      then raise exception 'opportunity_course_not_selected'; end if;
    if p_opportunity_course_id is distinct from v_scoped_opportunity.course_id then
      if p_lead_status not in ('new','no_answer','busy','phone_off','follow_up','interested',
          'very_interested','awaiting_payment','postponed','payment_submitted')
        then raise exception 'opportunity_course_change_unavailable'; end if;
      if not private_app.sales_opportunity_course_change_allowed_v1(v_contact.tenant_id,v_scoped_opportunity.id)
        then raise exception 'opportunity_course_change_unavailable'; end if;
      if exists(select 1 from sales_core.opportunities where tenant_id=v_contact.tenant_id
          and contact_id=p_contact_id and status='open' and course_id=p_opportunity_course_id
          and id<>v_scoped_opportunity.id)
        then raise exception 'payment_course_has_open_opportunity'; end if;
      select title_ar into v_old_course_name from academy.courses
        where tenant_id=v_contact.tenant_id and id=v_scoped_opportunity.course_id;
      select title_ar into v_new_course_name from academy.courses
        where tenant_id=v_contact.tenant_id and id=p_opportunity_course_id;
      v_course_change := jsonb_build_object('opportunityId',v_scoped_opportunity.id,
        'fromCourseId',v_scoped_opportunity.course_id,'fromCourseName',v_old_course_name,
        'toCourseId',p_opportunity_course_id,'toCourseName',v_new_course_name,
        'previousKind',v_scoped_opportunity.opportunity_kind,'commandId',p_command_id);
      update sales_core.opportunities set course_id=p_opportunity_course_id,opportunity_kind='training'
        where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and id=v_scoped_opportunity.id
        returning * into v_scoped_opportunity;
      perform private_app.write_audit('tenant.sales_opportunity_course_changed','sales_opportunity',
        v_scoped_opportunity.id::text,v_contact.tenant_id,v_course_change);
    end if;
  end if;

  -- Bind only eligible course-less legacy or automatic intake opportunities, and only
  -- when the employee explicitly reports payment for a validated selected course.
  -- The existing tenant/contact locks serialize this with opportunity creation.
  if p_lead_status='payment_submitted' and v_scoped_opportunity.id is not null
      and v_can_bind_payment_course then
    if exists(select 1 from sales_core.opportunities
      where tenant_id=v_contact.tenant_id and contact_id=p_contact_id
        and status='open' and course_id=p_payment_course_id
        and id<>v_scoped_opportunity.id)
      then raise exception 'payment_course_has_open_opportunity'; end if;
    v_previous_kind := v_scoped_opportunity.opportunity_kind;
    update sales_core.opportunities
      set course_id=p_payment_course_id,opportunity_kind='training'
      where tenant_id=v_contact.tenant_id and contact_id=p_contact_id
        and id=v_scoped_opportunity.id and status='open'
      returning * into v_scoped_opportunity;
    perform private_app.write_audit('tenant.sales_opportunity_course_bound','sales_opportunity',
      v_scoped_opportunity.id::text,v_contact.tenant_id,jsonb_build_object(
        'previousKind',v_previous_kind,'previousCourseId',null,'courseId',p_payment_course_id,
        'source','payment_report','commandId',p_command_id));
  end if;

  -- Explicit clear is supported; the legacy scalar remains the first interest for old readers.
  update sales_core.contacts set interest_course_id=v_primary_course where tenant_id=v_contact.tenant_id and id=p_contact_id;
  v_result := public.v2_tenant_record_sales_followup_v5(
    p_tenant_slug=>p_tenant_slug,p_contact_id=>p_contact_id,p_activity_type=>p_activity_type,p_summary=>p_summary,
    p_lead_status=>p_lead_status,p_lead_quality=>p_lead_quality,p_next_action_type=>p_next_action_type,p_next_action_at=>p_next_action_at,
    p_course_id=>case when v_scoped_opportunity.id is not null then v_scoped_opportunity.course_id
      when p_lead_status='payment_submitted' then p_payment_course_id else v_primary_course end,
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
  if v_course_change is not null then
    update sales_core.activities set metadata=metadata||jsonb_build_object('opportunityCourseChange',v_course_change),
      summary=summary||E'\n'||'تغيير دورة الفرصة من «'||v_old_course_name||'» إلى «'||v_new_course_name||'».'
      where tenant_id=v_contact.tenant_id and id=(v_result->>'id')::uuid;
  end if;
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
$function$
;
CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v8(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_course_interests jsonb, p_additional_phones jsonb, p_expected_revision text, p_command_id uuid, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_payment_course_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid, p_opportunity_id uuid DEFAULT NULL::uuid, p_opportunity_course_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private_app.record_sales_followup_scoped_v2(p_tenant_slug,p_contact_id,p_activity_type,p_summary,p_lead_status,p_course_interests,p_additional_phones,p_expected_revision,p_command_id,p_lead_quality,p_next_action_type,p_next_action_at,p_payment_course_id,p_payment_amount_minor,p_payment_reference,p_closure_reason,p_contact_name,p_task_id,p_opportunity_id,p_opportunity_course_id);
$function$
;
revoke all on function private_app.record_sales_followup_scoped_v2(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.v2_tenant_record_sales_followup_v8(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid,uuid,uuid) from public,anon;
grant execute on function public.v2_tenant_record_sales_followup_v8(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid,uuid,uuid) to authenticated;
CREATE OR REPLACE FUNCTION private_app.sales_followup_details(p_tenant_id uuid, p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
    'openOpportunities',coalesce((
      select jsonb_agg(jsonb_build_object('id',id,'courseId',course_id,'title',title,'kind',opportunity_kind,
        'canBindPaymentCourse',private_app.sales_payment_course_bindable_v1(opportunity_kind,course_id,metadata),
        'canChangeCourse',private_app.sales_opportunity_course_change_allowed_v1(p_tenant_id,o.id),
        'courseName',(select c.title_ar from academy.courses c where c.tenant_id=p_tenant_id and c.id=o.course_id),
        'nextActionAt',next_action_at) order by next_action_at nulls last,created_at,id)
      from sales_core.opportunities o where tenant_id=p_tenant_id and contact_id=p_contact_id and status='open'
    ),'[]'::jsonb),
    'additionalPhones',coalesce((
      select jsonb_agg(identity.identity_value order by identity.created_at,identity.id)
      from sales_core.contact_identities identity
      where identity.tenant_id=p_tenant_id and identity.contact_id=p_contact_id
        and identity.identity_type='phone' and identity.source_slot='additional_phone'
    ),'[]'::jsonb)
  );
$function$
;
commit;
