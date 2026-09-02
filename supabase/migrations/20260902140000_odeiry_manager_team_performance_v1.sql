begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- ODEIRY Manager live team-performance insight v1.
--
-- Safety properties:
--   * the tenant is derived from the authenticated manager run; callers do
--     not provide a slug, tenant id, staff id, table name, or SQL fragment;
--   * the run owner, manager-thread marker, feature gates, and exact tenant
--     permissions are verified before any report data is read;
--   * the existing two-read manager budget is consumed atomically;
--   * only a bounded, sanitized top-five facts contract is returned;
--   * no staff ids, tenant identifiers, customer rows, contact details, task
--     text, notes, or URLs leave the function;
--   * the read audit contains metadata only, never employee names or metrics.

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('core.odeiry_runs') is null
     or to_regclass('core.odeiry_manager_threads') is null
     or to_regclass('access_control.subjects') is null
     or to_regclass('access_control.memberships') is null
     or to_regclass('access_control.membership_roles') is null
     or to_regclass('access_control.roles') is null
     or to_regclass('access_control.role_permissions') is null
     or to_regclass('people.staff_profiles') is null
     or to_regclass('people.departments') is null then
    raise exception 'odeiry_manager_team_performance_missing_schema';
  end if;
  if to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure(
       'private_app.odeiry_manager_is_available(uuid)'
     ) is null
     or to_regprocedure(
       'private_app.v3_assignment_events(uuid,timestamptz,timestamptz,uuid[])'
     ) is null
     or to_regprocedure(
       'private_app.v3_metric_is_valid_assigned_contact(text,text,text)'
     ) is null
     or to_regprocedure(
       'private_app.write_audit(text,text,text,uuid,jsonb)'
     ) is null
     or to_regprocedure(
       'public.v5_tenant_reports_snapshot(text,date,date,uuid,text,integer,integer)'
     ) is null then
    raise exception 'odeiry_manager_team_performance_missing_function';
  end if;
end;
$preflight$;

-- Deliberately excludes the platform-control shortcut implemented by the
-- legacy generic permission helper. Manager insights must be authorized by a
-- real role assignment in the exact tenant whose run is being served.
create or replace function
  private_app.odeiry_manager_has_tenant_permission(
    p_tenant_id uuid,
    p_permission_key text
  )
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_subject_id uuid:=private_app.current_subject_id();
begin
  return auth.uid() is not null
    and v_subject_id is not null
    and p_tenant_id is not null
    and nullif(btrim(coalesce(p_permission_key,'')),'') is not null
    and exists(
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=v_subject_id
       and membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
       and membership.tenant_id=p_tenant_id
      join core.tenants tenant
        on tenant.id=membership.tenant_id
       and tenant.status in ('trial','active')
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id
       and role.scope='tenant'
       and (role.tenant_id is null or role.tenant_id=p_tenant_id)
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
       and role_permission.permission_key=p_permission_key
      where subject.id=v_subject_id
        and subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
    );
end;
$$;

-- This manager-specific projection selects only the assignment facts needed
-- for ranking. The underlying event contract validates its contact join with
-- the same tenant id; no customer label or contact field is projected here.
create or replace function
  private_app.odeiry_manager_assignment_staff_metrics(
    p_tenant_id uuid,
    p_from_at timestamptz,
    p_to_at timestamptz,
    p_staff_ids uuid[]
  )
returns table(
  staff_id uuid,
  assigned_customers bigint,
  assignment_operations bigint,
  valid_assigned_customers bigint,
  contacted_customers bigint,
  first_actions_on_time_customers bigint
)
language sql
stable
security definer
set search_path=''
as $$
  with events as (
    select
      event.assigned_staff_id,
      event.contact_id,
      event.contact_status,
      event.lead_status,
      event.lead_quality,
      event.first_action_at,
      event.deadline_at
    from private_app.v3_assignment_events(
      p_tenant_id,p_from_at,p_to_at,p_staff_ids
    ) event
  ),
  contact_rollup as (
    select
      event.assigned_staff_id,
      event.contact_id,
      count(*)::bigint as operations,
      bool_or(private_app.v3_metric_is_valid_assigned_contact(
        event.contact_status,event.lead_status,event.lead_quality
      )) as valid,
      bool_or(event.first_action_at is not null) as contacted,
      bool_or(
        event.first_action_at is not null
        and event.first_action_at<=event.deadline_at
      ) as first_action_on_time
    from events event
    group by event.assigned_staff_id,event.contact_id
  )
  select
    rollup.assigned_staff_id,
    count(*)::bigint,
    sum(rollup.operations)::bigint,
    count(*) filter(where rollup.valid)::bigint,
    count(*) filter(where rollup.contacted)::bigint,
    count(*) filter(where rollup.first_action_on_time)::bigint
  from contact_rollup rollup
  group by rollup.assigned_staff_id
$$;

-- Business labels are data, never instructions. Remove invisible controls and
-- markup, collapse whitespace, and replace values that resemble contact data,
-- URLs, or prompt-injection text. The application applies a second allowlist.
create or replace function private_app.odeiry_manager_safe_business_label(
  p_value text,
  p_fallback text default null,
  p_max_length integer default 80
)
returns text
language plpgsql
immutable
set search_path=''
as $$
declare
  v_value text:=btrim(coalesce(p_value,''));
  v_fallback text:=nullif(btrim(coalesce(p_fallback,'')),'');
  v_limit integer:=least(greatest(coalesce(p_max_length,80),1),120);
begin
  if v_value='' then
    return case when v_fallback is null
      then null else left(v_fallback,v_limit) end;
  end if;
  v_value:=translate(
    v_value,
    chr(1564)||chr(8203)||chr(8204)||chr(8205)||chr(8206)||chr(8207)
      ||chr(8234)||chr(8235)||chr(8236)||chr(8237)||chr(8238)
      ||chr(8294)||chr(8295)||chr(8296)||chr(8297)||chr(65279),
    ''
  );
  v_value:=pg_catalog.regexp_replace(v_value,'[[:cntrl:]]',' ','g');
  v_value:=translate(v_value,'<>{}[]`$','        ');
  v_value:=btrim(pg_catalog.regexp_replace(
    v_value,'[[:space:]]+',' ','g'
  ));
  if v_value=''
     or octet_length(v_value)>480
     or lower(v_value) ~
       '(https?://|www\.|javascript:|[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})'
     or v_value ~ '[0-9٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹]{7,}'
     or lower(v_value) ~
       '(ignore.{0,40}(instruction|previous)|system[ ]+prompt|developer[ ]+message|تجاهل.{0,40}(تعليمات|قواعد)|تعليمات[ ]+(النظام|المطور))' then
    return case when v_fallback is null
      then null else left(v_fallback,v_limit) end;
  end if;
  return left(v_value,v_limit);
end;
$$;

-- Although these values originate in the trusted report contract, parse them
-- defensively so a malformed future report revision fails to zero rather than
-- aborting or widening the insight response.
create or replace function
  private_app.odeiry_manager_safe_nonnegative_bigint(p_value jsonb)
returns bigint
language plpgsql
immutable
set search_path=''
as $$
declare
  v_value numeric;
begin
  if p_value is null or jsonb_typeof(p_value)<>'number' then
    return 0;
  end if;
  begin
    v_value:=(p_value#>>'{}')::numeric;
  exception when others then
    return 0;
  end;
  if v_value<0
     or v_value>9223372036854775807::numeric
     or v_value<>trunc(v_value) then
    return 0;
  end if;
  return v_value::bigint;
end;
$$;

revoke all on function
  private_app.odeiry_manager_has_tenant_permission(uuid,text)
from public,anon,authenticated,service_role;
revoke all on function
  private_app.odeiry_manager_assignment_staff_metrics(
    uuid,timestamptz,timestamptz,uuid[]
  )
from public,anon,authenticated,service_role;
revoke all on function
  private_app.odeiry_manager_safe_business_label(text,text,integer)
from public,anon,authenticated,service_role;
revoke all on function
  private_app.odeiry_manager_safe_nonnegative_bigint(jsonb)
from public,anon,authenticated,service_role;

create or replace function
  public.v1_tenant_odeiry_manager_team_performance(
    p_run_id uuid,
    p_period text,
    p_dimension text
  )
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_subject_id uuid:=private_app.current_subject_id();
  v_period text:=lower(btrim(coalesce(p_period,'')));
  v_dimension text:=lower(btrim(coalesce(p_dimension,'')));
  v_tenant_id uuid;
  v_tenant_slug text;
  v_timezone text;
  v_now timestamptz:=clock_timestamp();
  v_from date;
  v_to date;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_staff_ids uuid[]:='{}'::uuid[];
  v_report jsonb;
  v_team jsonb:='{}'::jsonb;
  v_result jsonb;
begin
  if p_run_id is null
     or v_period not in ('last_7_days','last_30_days')
     or v_dimension not in (
       'overview','sales','follow_up','tasks','calls'
     ) then
    raise exception 'odeiry_manager_payload_invalid';
  end if;

  -- This UPDATE is both the authorization boundary and the atomic read-budget
  -- reservation. A concurrent third tool call cannot pass manager_count < 2.
  update core.odeiry_runs run
  set manager_analytics_count=run.manager_analytics_count+1
  from core.tenants tenant
  where run.id=p_run_id
    and run.tenant_id=tenant.id
    and tenant.status in ('trial','active')
    and run.requested_by_subject_id=v_subject_id
    and run.status in ('reserved','running')
    and run.request_context->>'assistantMode'='manager_v1'
    and run.manager_analytics_count<2
    and private_app.odeiry_manager_is_available(run.tenant_id)
    and private_app.odeiry_manager_has_tenant_permission(
      run.tenant_id,'tenant.people.read'
    )
    and private_app.odeiry_manager_has_tenant_permission(
      run.tenant_id,'tenant.reports.analytics'
    )
    and exists(
      select 1
      from core.odeiry_manager_threads marker
      where marker.tenant_id=run.tenant_id
        and marker.thread_id=run.thread_id
        and marker.owner_subject_id=v_subject_id
    )
  returning run.tenant_id,tenant.slug,coalesce(
    nullif(tenant.timezone,''),'UTC'
  ) into v_tenant_id,v_tenant_slug,v_timezone;

  if not found then
    if exists(
      select 1
      from core.odeiry_runs run
      where run.id=p_run_id
        and run.requested_by_subject_id=v_subject_id
        and run.status in ('reserved','running')
        and run.request_context->>'assistantMode'='manager_v1'
        and run.manager_analytics_count>=2
        and private_app.odeiry_manager_is_available(run.tenant_id)
        and private_app.odeiry_manager_has_tenant_permission(
          run.tenant_id,'tenant.people.read'
        )
        and private_app.odeiry_manager_has_tenant_permission(
          run.tenant_id,'tenant.reports.analytics'
        )
        and exists(
          select 1
          from core.odeiry_manager_threads marker
          where marker.tenant_id=run.tenant_id
            and marker.thread_id=run.thread_id
            and marker.owner_subject_id=v_subject_id
        )
    ) then
      raise exception 'odeiry_manager_analytics_limit';
    end if;
    raise exception 'odeiry_manager_insight_unavailable';
  end if;

  -- Keep the post-RETURNING boundary explicit as defense in depth and as a
  -- guard against future edits to the atomic reservation predicate.
  if not private_app.odeiry_manager_is_available(v_tenant_id)
     or not private_app.odeiry_manager_has_tenant_permission(v_tenant_id,'tenant.people.read')
     or not private_app.odeiry_manager_has_tenant_permission(v_tenant_id,'tenant.reports.analytics') then
    raise exception 'odeiry_manager_insight_unavailable';
  end if;

  v_to:=(v_now at time zone v_timezone)::date;
  v_from:=case when v_period='last_7_days'
    then v_to-6 else v_to-29 end;
  v_from_at:=v_from::timestamp at time zone v_timezone;
  v_to_at:=(v_to+1)::timestamp at time zone v_timezone;

  -- The report function remains the product's metric authority. Its broad
  -- response is retained inside Postgres and reduced to the allowlist below.
  v_report:=public.v5_tenant_reports_snapshot(
    v_tenant_slug,v_from,v_to,null,'employees',100,0
  );

  select coalesce(array_agg(
    staff.id order by employee.position
  ),'{}'::uuid[])
  into v_staff_ids
  from jsonb_array_elements(
    case when jsonb_typeof(v_report->'employees')='array'
      then v_report->'employees' else '[]'::jsonb end
  ) with ordinality employee(item,position)
  join people.staff_profiles staff
    on staff.id=case
      when coalesce(employee.item->>'staffId','') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (employee.item->>'staffId')::uuid
      else null
    end
   and staff.tenant_id=v_tenant_id
   and staff.employment_status='active';

  with employee_source as (
    select
      staff.id as staff_id,
      employee.position,
      employee.item,
      private_app.odeiry_manager_safe_business_label(
        staff.full_name,'موظف غير مسمى',80
      ) as display_name,
      private_app.odeiry_manager_safe_business_label(
        staff.job_title,null,80
      ) as job_title,
      private_app.odeiry_manager_safe_business_label(
        department.name_ar,null,80
      ) as department
    from jsonb_array_elements(
      case when jsonb_typeof(v_report->'employees')='array'
        then v_report->'employees' else '[]'::jsonb end
    ) with ordinality employee(item,position)
    join people.staff_profiles staff
      on staff.id=case
        when coalesce(employee.item->>'staffId','') ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (employee.item->>'staffId')::uuid
        else null
      end
     and staff.tenant_id=v_tenant_id
     and staff.employment_status='active'
    left join people.departments department
      on department.id=staff.department_id
     and department.tenant_id=v_tenant_id
  ),
  assignment_metrics as (
    select metric.*
    from private_app.odeiry_manager_assignment_staff_metrics(
      v_tenant_id,v_from_at,v_to_at,v_staff_ids
    ) metric
  ),
  employee_metrics_raw as (
    select
      employee.staff_id,
      employee.position,
      employee.display_name,
      employee.job_title,
      employee.department,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'paidContacts'
      ) as paid_contacts,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'tasksTotal'
      ) as tasks_total,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'tasksCompleted'
      ) as tasks_completed,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'tasksOnTime'
      ) as tasks_on_time,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'overdueTasks'
      ) as overdue_tasks,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'calls'
      ) as calls,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'answeredCalls'
      ) as answered_calls,
      private_app.odeiry_manager_safe_nonnegative_bigint(
        employee.item->'talkSeconds'
      ) as talk_seconds,
      greatest(0,coalesce(
        assignment.assigned_customers,0
      )) as assigned_customers,
      greatest(0,coalesce(
        assignment.assignment_operations,0
      )) as assignment_operations,
      greatest(0,coalesce(
        assignment.valid_assigned_customers,0
      )) as valid_assigned_customers,
      greatest(0,coalesce(
        assignment.contacted_customers,0
      )) as contacted_customers,
      greatest(0,coalesce(
        assignment.first_actions_on_time_customers,0
      )) as first_actions_on_time_customers
    from employee_source employee
    left join assignment_metrics assignment
      on assignment.staff_id=employee.staff_id
  ),
  employee_metrics as (
    select
      raw.staff_id,
      raw.position,
      raw.display_name,
      raw.job_title,
      raw.department,
      raw.paid_contacts,
      raw.tasks_total,
      least(raw.tasks_completed,raw.tasks_total) as tasks_completed,
      least(
        raw.tasks_on_time,
        least(raw.tasks_completed,raw.tasks_total)
      ) as tasks_on_time,
      raw.overdue_tasks,
      raw.calls,
      least(raw.answered_calls,raw.calls) as answered_calls,
      raw.talk_seconds,
      raw.assigned_customers,
      raw.assignment_operations,
      raw.valid_assigned_customers,
      raw.contacted_customers,
      raw.first_actions_on_time_customers
    from employee_metrics_raw raw
  ),
  candidate_rows as (
    select
      metric.staff_id,metric.position,metric.display_name,
      metric.job_title,metric.department,
      'sales'::text as category,
      metric.paid_contacts::numeric as metric_value,
      'count'::text as metric_unit,
      metric.paid_contacts::numeric as numerator,
      null::numeric as denominator,
      metric.paid_contacts::bigint as sample_size,
      case
        when metric.paid_contacts>=10 then 'strong'
        when metric.paid_contacts>=5 then 'initial'
        else 'insufficient'
      end as sample_status,
      jsonb_build_object(
        'paidContacts',metric.paid_contacts
      ) as supporting
    from employee_metrics metric
    where metric.paid_contacts>0

    union all

    select
      metric.staff_id,metric.position,metric.display_name,
      metric.job_title,metric.department,
      'follow_up',round(
        100.0*metric.first_actions_on_time_customers
          /nullif(metric.assigned_customers,0),1
      ),'percent',metric.first_actions_on_time_customers::numeric,
      metric.assigned_customers::numeric,metric.assigned_customers,
      case
        when metric.assigned_customers>=50 then 'strong'
        when metric.assigned_customers>=20 then 'initial'
        else 'insufficient'
      end,
      jsonb_build_object(
        'firstResponseSlaRate',round(
          100.0*metric.first_actions_on_time_customers
            /nullif(metric.assigned_customers,0),1
        ),
        'assignmentOperations',metric.assignment_operations,
        'contactedAssignedLeads',metric.contacted_customers,
        'validAssignedLeads',metric.valid_assigned_customers
      )
    from employee_metrics metric
    where metric.assigned_customers>0

    union all

    select
      metric.staff_id,metric.position,metric.display_name,
      metric.job_title,metric.department,
      'tasks',round(least(
        100.0,100.0*metric.tasks_completed/nullif(metric.tasks_total,0)
      ),1),'percent',metric.tasks_completed::numeric,
      metric.tasks_total::numeric,metric.tasks_total,
      case
        when metric.tasks_total>=30 then 'strong'
        when metric.tasks_total>=10 then 'initial'
        else 'insufficient'
      end,
      jsonb_build_object(
        'tasksTotal',metric.tasks_total,
        'tasksCompleted',metric.tasks_completed,
        'tasksOnTime',metric.tasks_on_time,
        'overdueTasks',metric.overdue_tasks,
        'taskCompletionRate',round(least(
          100.0,100.0*metric.tasks_completed/nullif(metric.tasks_total,0)
        ),1),
        'taskOnTimeRate',case when metric.tasks_completed>0
          then round(
            100.0*metric.tasks_on_time/nullif(metric.tasks_completed,0),1
          ) else null end
      )
    from employee_metrics metric
    where metric.tasks_total>0

    union all

    select
      metric.staff_id,metric.position,metric.display_name,
      metric.job_title,metric.department,
      'calls',round(
        100.0*metric.answered_calls/nullif(metric.calls,0),1
      ),'percent',metric.answered_calls::numeric,
      metric.calls::numeric,metric.calls,
      case
        when metric.calls>=50 then 'strong'
        when metric.calls>=20 then 'initial'
        else 'insufficient'
      end,
      jsonb_build_object(
        'calls',metric.calls,
        'answeredCalls',metric.answered_calls,
        'callAnswerRate',round(
          100.0*metric.answered_calls/nullif(metric.calls,0),1
        ),
        'talkSeconds',metric.talk_seconds
      )
    from employee_metrics metric
    where metric.calls>0
  ),
  requested_candidates as (
    select candidate.*
    from candidate_rows candidate
    where v_dimension='overview' or candidate.category=v_dimension
  ),
  ranked_candidates as (
    select candidate.*,
      row_number() over(
        partition by candidate.category
        order by
          case candidate.sample_status
            when 'strong' then 0
            when 'initial' then 1
            else 2
          end,
          candidate.metric_value desc,
          candidate.sample_size desc,
          candidate.numerator desc,
          candidate.staff_id
      ) as category_rank
    from requested_candidates candidate
  )
  select jsonb_build_object(
    'leaders',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'category',ranked.category,
        'displayName',ranked.display_name,
        'jobTitle',ranked.job_title,
        'department',ranked.department,
        'metricValue',ranked.metric_value,
        'metricUnit',ranked.metric_unit,
        'numerator',ranked.numerator,
        'denominator',ranked.denominator,
        'sampleSize',ranked.sample_size,
        'sampleStatus',ranked.sample_status,
        'supporting',ranked.supporting
      )) order by
        case ranked.category
          when 'sales' then 1
          when 'follow_up' then 2
          when 'tasks' then 3
          else 4
        end,
        ranked.category_rank
      )
      from ranked_candidates ranked
      where ranked.category_rank<=case
        when v_dimension='overview' then 1 else 5 end
    ),'[]'::jsonb),
    'sample',jsonb_build_object(
      'employeesConsidered',(select count(*) from employee_metrics),
      'employeesEligible',case when v_dimension='overview' then (
        select count(distinct candidate.staff_id)
        from requested_candidates candidate
      ) else (
        select count(*) from requested_candidates candidate
      ) end
    )
  ) into v_team;

  v_result:=jsonb_build_object(
    'schemaVersion',1,
    'source','odeir_live_tenant_data',
    'generatedAt',v_now,
    'period',v_period,
    'dimension',v_dimension,
    'from',v_from,
    'to',v_to,
    'timezone',v_timezone,
    -- Reconstruct the final leader objects once more at the trust boundary.
    -- This prevents an internal CTE refactor from accidentally widening the
    -- model-facing JSON contract.
    'leaders',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'category',leader.item->'category',
        'displayName',leader.item->'displayName',
        'jobTitle',leader.item->'jobTitle',
        'department',leader.item->'department',
        'metricValue',leader.item->'metricValue',
        'metricUnit',leader.item->'metricUnit',
        'numerator',leader.item->'numerator',
        'denominator',leader.item->'denominator',
        'sampleSize',leader.item->'sampleSize',
        'sampleStatus',leader.item->'sampleStatus',
        'supporting',leader.item->'supporting'
      )) order by leader.position)
      from jsonb_array_elements(
        case when jsonb_typeof(v_team->'leaders')='array'
          then v_team->'leaders' else '[]'::jsonb end
      ) with ordinality leader(item,position)
      where leader.position<=5
    ),'[]'::jsonb),
    'sample',jsonb_build_object(
      'employeesConsidered',coalesce(
        v_team#>'{sample,employeesConsidered}','0'::jsonb
      ),
      'employeesEligible',coalesce(
        v_team#>'{sample,employeesEligible}','0'::jsonb
      )
    ),
    'limitations',jsonb_build_array(
      'التصنيف حسب المعيار المختار فقط، ولا يمثل حكمًا شاملًا على الموظف.',
      'المبيعات الموثقة منسوبة إلى المالك الحالي لملف العميل، وقد لا تطابق منفذ الإغلاق.',
      'إعادة إسناد العميل خلال الفترة قد تؤثر في عينات الإسناد والمتابعة.',
      'نتائج المكالمات تعتمد على اكتمال ربط تحويلات Yeastar بالموظفين.',
      'تختلف قواعد التاريخ بين الإسناد والدفع والمهام والمكالمات داخل الفترة نفسها.'
    )
  );

  if octet_length(v_result::text)>32768 then
    raise exception 'odeiry_manager_analytics_payload_too_large';
  end if;

  perform private_app.write_audit(
    'odeiry.manager.team_performance.read',
    'odeiry_run',
    p_run_id::text,
    v_tenant_id,
    jsonb_build_object(
      'source','tenant_reports_v5_team_performance',
      'period',v_period,
      'dimension',v_dimension,
      'leaderCount',jsonb_array_length(v_result->'leaders'),
      'employeesConsidered',coalesce(
        (v_result#>>'{sample,employeesConsidered}')::integer,0
      )
    )
  );

  return v_result;
end;
$$;

revoke all on function
  public.v1_tenant_odeiry_manager_team_performance(uuid,text,text)
from public,anon,authenticated,service_role;
grant execute on function
  public.v1_tenant_odeiry_manager_team_performance(uuid,text,text)
to authenticated;

comment on function
  private_app.odeiry_manager_has_tenant_permission(uuid,text) is
'Checks a real role grant in the exact tenant and never accepts the platform-control shortcut.';

comment on function
  private_app.odeiry_manager_assignment_staff_metrics(
    uuid,timestamptz,timestamptz,uuid[]
  ) is
'Projects tenant-bound assignment events without joining customer records or returning customer data.';

comment on function
  private_app.odeiry_manager_safe_business_label(text,text,integer) is
'Sanitizes employee-facing business labels before the bounded manager-insight contract is created.';

comment on function
  private_app.odeiry_manager_safe_nonnegative_bigint(jsonb) is
'Defensively parses non-negative integer metrics from the internal report JSON contract.';

comment on function
  public.v1_tenant_odeiry_manager_team_performance(uuid,text,text) is
'Returns at most five sanitized team-performance leaders from the authenticated manager run tenant; no identifiers or customer-level data are exposed.';

commit;
