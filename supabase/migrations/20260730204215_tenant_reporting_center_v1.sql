begin;

create index if not exists lead_assignments_tenant_staff_assigned_idx
on sales_core.lead_assignments (
  tenant_id,
  assigned_staff_id,
  assigned_at desc
);

create index if not exists sales_contacts_tenant_owner_created_idx
on sales_core.contacts (
  tenant_id,
  owner_staff_id,
  created_at desc
);

create index if not exists sales_opportunities_tenant_owner_updated_idx
on sales_core.opportunities (
  tenant_id,
  owner_staff_id,
  updated_at desc
);

create or replace function public.v2_tenant_reports_snapshot_v1(
  p_slug text,
  p_from date default null,
  p_to date default null,
  p_staff_id uuid default null,
  p_report text default 'overview',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_current_staff_id uuid;
  v_target_staff_id uuid;
  v_view_team boolean := false;
  v_can_crm boolean := false;
  v_can_leads boolean := false;
  v_from_date date;
  v_to_date date;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_assignment_map jsonb := '{}'::jsonb;
  v_selected_employee jsonb;
  v_summary jsonb := '{}'::jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_campaigns jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_lead_statuses jsonb := '[]'::jsonb;
  v_pipeline_stages jsonb := '[]'::jsonb;
  v_courses jsonb := '[]'::jsonb;
  v_activity_breakdown jsonb := '[]'::jsonb;
  v_task_breakdown jsonb := '[]'::jsonb;
  v_call_breakdown jsonb := '[]'::jsonb;
  v_details jsonb := '{}'::jsonb;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
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
  if coalesce(p_report, 'overview') not in (
    'overview',
    'employees',
    'employee',
    'sales',
    'campaigns'
  ) then
    raise exception 'invalid_report_type';
  end if;

  v_from_date := coalesce(
    p_from,
    (now() at time zone v_tenant.timezone)::date - 29
  );
  v_to_date := coalesce(
    p_to,
    (now() at time zone v_tenant.timezone)::date
  );
  if v_from_date > v_to_date
     or v_to_date - v_from_date > 365 then
    raise exception 'invalid_report_period';
  end if;
  v_from_at := v_from_date::timestamp at time zone v_tenant.timezone;
  v_to_at := (v_to_date + 1)::timestamp at time zone v_tenant.timezone;

  v_current_staff_id := private_app.current_staff_id(v_tenant.id);
  v_view_team := (
    private_app.can_view_tenant_team(v_tenant.id)
    or private_app.has_platform_permission('platform.tenants.read')
  );
  v_can_crm := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.crm.read')
    or private_app.has_platform_permission('platform.tenants.read')
  );
  v_can_leads := (
    private_app.has_tenant_permission(v_tenant.id, 'tenant.leads.read')
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.analytics'
    )
    or private_app.has_platform_permission('platform.tenants.read')
  );

  if p_report = 'sales' and not v_can_crm then
    raise exception 'forbidden';
  end if;
  if p_report = 'campaigns' and not (v_can_crm or v_can_leads) then
    raise exception 'forbidden';
  end if;

  if p_staff_id is not null then
    if not exists (
      select 1
      from people.staff_profiles staff
      where staff.id = p_staff_id
        and staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
    ) then
      raise exception 'staff_not_found';
    end if;
    if not v_view_team
       and p_staff_id is distinct from v_current_staff_id then
      raise exception 'forbidden';
    end if;
    v_target_staff_id := p_staff_id;
  elsif not v_view_team then
    if v_current_staff_id is null then
      raise exception 'staff_profile_required';
    end if;
    v_target_staff_id := v_current_staff_id;
  end if;

  select coalesce(
    connection.public_config -> 'extensionAssignments',
    '{}'::jsonb
  )
  into v_assignment_map
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;
  v_assignment_map := coalesce(v_assignment_map, '{}'::jsonb);

  if v_target_staff_id is not null then
    select jsonb_build_object(
      'staffId', staff.id,
      'name', staff.full_name,
      'jobTitle', staff.job_title,
      'roleKey', staff.role_key,
      'roleLabel', case staff.role_key
        when 'tenant_owner' then 'مالك المنشأة'
        when 'tenant_admin' then 'مدير المنشأة'
        when 'executive_manager' then 'المدير التنفيذي'
        when 'sales_manager' then 'مدير المبيعات'
        when 'sales_supervisor' then 'مشرف المبيعات'
        when 'sales_user' then 'مسؤول المبيعات'
        when 'customer_service' then 'خدمة العملاء'
        when 'data_officer' then 'مسؤول البيانات'
        when 'data_analyst' then 'محلل البيانات'
        when 'training_manager' then 'مدير التدريب'
        else 'مستخدم المنشأة'
      end,
      'department', department.name_ar,
      'accountStatus', staff.account_status
    )
    into v_selected_employee
    from people.staff_profiles staff
    left join people.departments department
      on department.id = staff.department_id
    where staff.id = v_target_staff_id
      and staff.tenant_id = v_tenant.id;
  end if;

  with staff_scope as (
    select
      staff.id,
      staff.full_name,
      staff.job_title,
      staff.role_key,
      staff.account_status,
      department.name_ar as department_name
    from people.staff_profiles staff
    left join people.departments department
      on department.id = staff.department_id
    where staff.tenant_id = v_tenant.id
      and staff.employment_status = 'active'
      and (
        v_target_staff_id is null
        or staff.id = v_target_staff_id
      )
  ),
  assignment_contacts as (
    select distinct
      assignment.assigned_staff_id as staff_id,
      assignment.contact_id
    from sales_core.lead_assignments assignment
    join staff_scope staff on staff.id = assignment.assigned_staff_id
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
  ),
  assignment_stats as (
    select
      assignment.assigned_staff_id as staff_id,
      count(distinct assignment.contact_id) as leads_assigned,
      count(*) filter (
        where assignment.first_action_at is not null
      ) as first_actions,
      count(*) filter (
        where assignment.first_action_at is not null
          and assignment.first_action_at <= assignment.deadline_at
      ) as first_actions_on_time
    from sales_core.lead_assignments assignment
    join staff_scope staff on staff.id = assignment.assigned_staff_id
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
    group by assignment.assigned_staff_id
  ),
  contact_stats as (
    select
      scoped.staff_id,
      count(*) filter (
        where contact.lead_status = 'paid'
      ) as paid_contacts,
      round(avg(
        (
          (nullif(trim(contact.full_name), '') is not null)::integer
          + (
            nullif(trim(coalesce(contact.phone, '')), '') is not null
            or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
          )::integer
          + (nullif(trim(contact.source), '') is not null)::integer
          + (contact.interest_course_id is not null)::integer
          + (contact.owner_staff_id is not null)::integer
        ) * 20.0
      ), 1) as data_completeness_rate,
      count(*) filter (
        where exists (
          select 1
          from sales_core.activities activity
          where activity.tenant_id = v_tenant.id
            and activity.contact_id = contact.id
            and activity.occurred_at >= v_from_at
            and activity.occurred_at < v_to_at
        )
      ) as touched_leads
    from assignment_contacts scoped
    join sales_core.contacts contact on contact.id = scoped.contact_id
    group by scoped.staff_id
  ),
  activity_stats as (
    select
      activity.actor_staff_id as staff_id,
      count(*) as activities
    from sales_core.activities activity
    join staff_scope staff on staff.id = activity.actor_staff_id
    where activity.tenant_id = v_tenant.id
      and activity.occurred_at >= v_from_at
      and activity.occurred_at < v_to_at
    group by activity.actor_staff_id
  ),
  task_stats as (
    select
      task.assigned_staff_id as staff_id,
      count(*) as tasks_total,
      count(*) filter (
        where task.status = 'completed'
          and task.completed_at < v_to_at
      ) as tasks_completed,
      count(*) filter (
        where task.status = 'completed'
          and task.completed_at <= task.due_at
      ) as tasks_on_time,
      count(*) filter (
        where task.status in ('todo', 'in_progress')
          and task.due_at < least(v_to_at, now())
      ) as overdue_tasks
    from work_core.tasks task
    join staff_scope staff on staff.id = task.assigned_staff_id
    where task.tenant_id = v_tenant.id
      and task.due_at >= v_from_at
      and task.due_at < v_to_at
    group by task.assigned_staff_id
  ),
  opportunity_stats as (
    select
      opportunity.owner_staff_id as staff_id,
      count(*) filter (
        where opportunity.status = 'won'
      ) as won_opportunities,
      coalesce(sum(opportunity.value_minor) filter (
        where opportunity.status = 'won'
      ), 0) as won_revenue_minor
    from sales_core.opportunities opportunity
    join staff_scope staff on staff.id = opportunity.owner_staff_id
    where opportunity.tenant_id = v_tenant.id
      and opportunity.updated_at >= v_from_at
      and opportunity.updated_at < v_to_at
    group by opportunity.owner_staff_id
  ),
  payment_stats as (
    select
      contact.owner_staff_id as staff_id,
      count(distinct handoff.contact_id) as verified_sales,
      coalesce(sum(handoff.payment_amount_minor), 0)
        as realized_revenue_minor
    from academy.registration_handoffs handoff
    join sales_core.contacts contact on contact.id = handoff.contact_id
    join staff_scope staff on staff.id = contact.owner_staff_id
    where handoff.tenant_id = v_tenant.id
      and handoff.payment_status = 'verified'
      and handoff.paid_at >= v_from_at
      and handoff.paid_at < v_to_at
    group by contact.owner_staff_id
  ),
  staff_extensions as (
    select
      staff.id as staff_id,
      mapping.key as extension
    from staff_scope staff
    cross join lateral jsonb_each_text(v_assignment_map) mapping
    where mapping.value = staff.id::text
  ),
  staff_calls as (
    select distinct
      extension.staff_id,
      record.id,
      record.final_status,
      record.handling_duration_seconds
    from staff_extensions extension
    join telephony.call_records record
      on extension.extension = any(record.involved_extensions)
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
  ),
  call_stats as (
    select
      call.staff_id,
      count(*) as calls,
      count(*) filter (
        where call.final_status = 'ANSWERED'
      ) as answered_calls,
      coalesce(sum(call.handling_duration_seconds), 0) as talk_seconds
    from staff_calls call
    group by call.staff_id
  ),
  employee_rows as (
    select
      staff.id as staff_id,
      staff.full_name as name,
      staff.job_title,
      staff.role_key,
      staff.department_name,
      staff.account_status,
      coalesce(assignment.leads_assigned, 0) as leads_assigned,
      coalesce(contact.touched_leads, 0) as touched_leads,
      coalesce(activity.activities, 0) as activities,
      coalesce(contact.paid_contacts, 0) as paid_contacts,
      coalesce(opportunity.won_opportunities, 0) as won_opportunities,
      coalesce(opportunity.won_revenue_minor, 0) as won_revenue_minor,
      coalesce(payment.realized_revenue_minor, 0)
        as realized_revenue_minor,
      coalesce(task.tasks_total, 0) as tasks_total,
      coalesce(task.tasks_completed, 0) as tasks_completed,
      coalesce(task.tasks_on_time, 0) as tasks_on_time,
      coalesce(task.overdue_tasks, 0) as overdue_tasks,
      coalesce(call.calls, 0) as calls,
      coalesce(call.answered_calls, 0) as answered_calls,
      coalesce(call.talk_seconds, 0) as talk_seconds,
      case when coalesce(assignment.leads_assigned, 0) > 0 then
        round(
          least(
            100.0,
            100.0 * coalesce(contact.paid_contacts, 0)
              / assignment.leads_assigned
          ),
          1
        )
      end as conversion_rate,
      case when coalesce(task.tasks_total, 0) > 0 then
        round(100.0 * task.tasks_completed / task.tasks_total, 1)
      end as task_completion_rate,
      case when coalesce(task.tasks_completed, 0) > 0 then
        round(100.0 * task.tasks_on_time / task.tasks_completed, 1)
      end as task_on_time_rate,
      case when coalesce(call.calls, 0) > 0 then
        round(100.0 * call.answered_calls / call.calls, 1)
      end as call_answer_rate,
      contact.data_completeness_rate,
      case when coalesce(assignment.leads_assigned, 0) > 0 then
        round(
          100.0 * coalesce(assignment.first_actions_on_time, 0)
            / assignment.leads_assigned,
          1
        )
      end as first_response_sla_rate
    from staff_scope staff
    left join assignment_stats assignment on assignment.staff_id = staff.id
    left join contact_stats contact on contact.staff_id = staff.id
    left join activity_stats activity on activity.staff_id = staff.id
    left join task_stats task on task.staff_id = staff.id
    left join opportunity_stats opportunity
      on opportunity.staff_id = staff.id
    left join payment_stats payment on payment.staff_id = staff.id
    left join call_stats call on call.staff_id = staff.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'staffId', row.staff_id,
    'name', row.name,
    'jobTitle', row.job_title,
    'roleKey', row.role_key,
    'department', row.department_name,
    'accountStatus', row.account_status,
    'leadsAssigned', row.leads_assigned,
    'touchedLeads', row.touched_leads,
    'activities', row.activities,
    'paidContacts', row.paid_contacts,
    'wonOpportunities', row.won_opportunities,
    'wonRevenueMinor', row.won_revenue_minor,
    'realizedRevenueMinor', row.realized_revenue_minor,
    'tasksTotal', row.tasks_total,
    'tasksCompleted', row.tasks_completed,
    'tasksOnTime', row.tasks_on_time,
    'overdueTasks', row.overdue_tasks,
    'calls', row.calls,
    'answeredCalls', row.answered_calls,
    'talkSeconds', row.talk_seconds,
    'conversionRate', row.conversion_rate,
    'taskCompletionRate', row.task_completion_rate,
    'taskOnTimeRate', row.task_on_time_rate,
    'callAnswerRate', row.call_answer_rate,
    'dataCompletenessRate', row.data_completeness_rate,
    'firstResponseSlaRate', row.first_response_sla_rate
  ) order by
    row.realized_revenue_minor desc,
    row.paid_contacts desc,
    row.activities desc,
    row.name
  ), '[]'::jsonb)
  into v_employees
  from employee_rows row;

  with scoped_assignments as (
    select distinct
      assignment.contact_id,
      assignment.assigned_staff_id,
      assignment.first_action_at,
      assignment.deadline_at
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
      and (
        v_target_staff_id is null
        or assignment.assigned_staff_id = v_target_staff_id
      )
  ),
  assigned_quality as (
    select
      count(*) as total,
      count(*) filter (
        where contact.lead_status = 'paid'
      ) as paid,
      round(avg(
        (
          (nullif(trim(contact.full_name), '') is not null)::integer
          + (
            nullif(trim(coalesce(contact.phone, '')), '') is not null
            or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
          )::integer
          + (nullif(trim(contact.source), '') is not null)::integer
          + (contact.interest_course_id is not null)::integer
          + (contact.owner_staff_id is not null)::integer
        ) * 20.0
      ), 1) as completeness
    from scoped_assignments assignment
    join sales_core.contacts contact on contact.id = assignment.contact_id
  ),
  scoped_calls as (
    select distinct record.*
    from telephony.call_records record
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
      and (
        v_target_staff_id is null
        or exists (
          select 1
          from jsonb_each_text(v_assignment_map) mapping
          where mapping.value = v_target_staff_id::text
            and mapping.key = any(record.involved_extensions)
        )
      )
  ),
  values as (
    select
      (
        select count(*)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.created_at >= v_from_at
          and contact.created_at < v_to_at
          and (
            v_target_staff_id is null
            or contact.owner_staff_id = v_target_staff_id
          )
      ) as leads_created,
      (select total from assigned_quality) as leads_assigned,
      (select paid from assigned_quality) as assigned_paid,
      (select completeness from assigned_quality) as completeness,
      (
        select count(*)
        from sales_core.activities activity
        where activity.tenant_id = v_tenant.id
          and activity.occurred_at >= v_from_at
          and activity.occurred_at < v_to_at
          and (
            v_target_staff_id is null
            or activity.actor_staff_id = v_target_staff_id
          )
      ) as activities,
      (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.due_at >= v_from_at
          and task.due_at < v_to_at
          and (
            v_target_staff_id is null
            or task.assigned_staff_id = v_target_staff_id
          )
      ) as tasks_total,
      (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.due_at >= v_from_at
          and task.due_at < v_to_at
          and task.status = 'completed'
          and task.completed_at < v_to_at
          and (
            v_target_staff_id is null
            or task.assigned_staff_id = v_target_staff_id
          )
      ) as tasks_completed,
      (
        select count(*)
        from work_core.tasks task
        where task.tenant_id = v_tenant.id
          and task.due_at >= v_from_at
          and task.due_at < v_to_at
          and task.status in ('todo', 'in_progress')
          and task.due_at < least(v_to_at, now())
          and (
            v_target_staff_id is null
            or task.assigned_staff_id = v_target_staff_id
          )
      ) as overdue_tasks,
      (select count(*) from scoped_calls) as calls,
      (
        select count(*) from scoped_calls
        where final_status = 'ANSWERED'
      ) as answered_calls,
      (
        select coalesce(sum(handling_duration_seconds), 0)
        from scoped_calls
      ) as talk_seconds,
      (
        select count(distinct contact.id)
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.lead_status = 'paid'
          and coalesce(
            contact.payment_submitted_at,
            contact.lead_status_changed_at,
            contact.updated_at
          ) >= v_from_at
          and coalesce(
            contact.payment_submitted_at,
            contact.lead_status_changed_at,
            contact.updated_at
          ) < v_to_at
          and (
            v_target_staff_id is null
            or contact.owner_staff_id = v_target_staff_id
          )
      ) as paid_contacts,
      (
        select coalesce(sum(handoff.payment_amount_minor), 0)
        from academy.registration_handoffs handoff
        join sales_core.contacts contact on contact.id = handoff.contact_id
        where handoff.tenant_id = v_tenant.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
          and (
            v_target_staff_id is null
            or contact.owner_staff_id = v_target_staff_id
          )
      ) as realized_revenue_minor,
      (
        select coalesce(sum(opportunity.value_minor), 0)
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant.id
          and opportunity.status = 'won'
          and opportunity.updated_at >= v_from_at
          and opportunity.updated_at < v_to_at
          and (
            v_target_staff_id is null
            or opportunity.owner_staff_id = v_target_staff_id
          )
      ) as won_revenue_minor,
      (
        select coalesce(sum(opportunity.value_minor), 0)
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant.id
          and opportunity.status = 'open'
          and (
            v_target_staff_id is null
            or opportunity.owner_staff_id = v_target_staff_id
          )
      ) as pipeline_value_minor,
      (
        select count(distinct concat_ws(
          '|',
          coalesce(contact.source, ''),
          coalesce(contact.campaign_name, ''),
          coalesce(contact.ad_name, '')
        ))
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.created_at >= v_from_at
          and contact.created_at < v_to_at
          and (
            v_target_staff_id is null
            or contact.owner_staff_id = v_target_staff_id
          )
      ) as campaign_count,
      (
        select count(*)
        from sales_core.lead_assignments assignment
        where assignment.tenant_id = v_tenant.id
          and assignment.assigned_at >= v_from_at
          and assignment.assigned_at < v_to_at
          and assignment.first_action_at is not null
          and assignment.first_action_at <= assignment.deadline_at
          and (
            v_target_staff_id is null
            or assignment.assigned_staff_id = v_target_staff_id
          )
      ) as first_actions_on_time
  )
  select jsonb_build_object(
    'leadsCreated', value.leads_created,
    'leadsAssigned', value.leads_assigned,
    'activities', value.activities,
    'tasksTotal', value.tasks_total,
    'tasksCompleted', value.tasks_completed,
    'overdueTasks', value.overdue_tasks,
    'calls', value.calls,
    'answeredCalls', value.answered_calls,
    'talkSeconds', value.talk_seconds,
    'paidContacts', value.paid_contacts,
    'realizedRevenueMinor', value.realized_revenue_minor,
    'wonRevenueMinor', value.won_revenue_minor,
    'pipelineValueMinor', value.pipeline_value_minor,
    'campaignCount', value.campaign_count,
    'conversionRate', case when value.leads_created > 0 then
      round(100.0 * value.paid_contacts / value.leads_created, 1)
    end,
    'averageSaleMinor', case when value.paid_contacts > 0 then
      round(
        greatest(
          value.realized_revenue_minor,
          value.won_revenue_minor
        )::numeric / value.paid_contacts
      )::bigint
    else 0 end,
    'taskCompletionRate', case when value.tasks_total > 0 then
      round(100.0 * value.tasks_completed / value.tasks_total, 1)
    end,
    'callAnswerRate', case when value.calls > 0 then
      round(100.0 * value.answered_calls / value.calls, 1)
    end,
    'dataCompletenessRate', value.completeness,
    'firstResponseSlaRate', case when value.leads_assigned > 0 then
      round(
        100.0 * value.first_actions_on_time / value.leads_assigned,
        1
      )
    end
  )
  into v_summary
  from values value;

  with days as (
    select day::date
    from generate_series(
      v_from_date::timestamp,
      v_to_date::timestamp,
      interval '1 day'
    ) day
  ),
  assigned as (
    select
      (assignment.assigned_at at time zone v_tenant.timezone)::date as day,
      count(distinct assignment.contact_id) as total
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_at >= v_from_at
      and assignment.assigned_at < v_to_at
      and (
        v_target_staff_id is null
        or assignment.assigned_staff_id = v_target_staff_id
      )
    group by 1
  ),
  created as (
    select
      (contact.created_at at time zone v_tenant.timezone)::date as day,
      count(*) as total
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.created_at >= v_from_at
      and contact.created_at < v_to_at
      and (
        v_target_staff_id is null
        or contact.owner_staff_id = v_target_staff_id
      )
    group by 1
  ),
  activities as (
    select
      (activity.occurred_at at time zone v_tenant.timezone)::date as day,
      count(*) as total
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.occurred_at >= v_from_at
      and activity.occurred_at < v_to_at
      and (
        v_target_staff_id is null
        or activity.actor_staff_id = v_target_staff_id
      )
    group by 1
  ),
  paid as (
    select
      (
        coalesce(
          contact.payment_submitted_at,
          contact.lead_status_changed_at,
          contact.updated_at
        ) at time zone v_tenant.timezone
      )::date as day,
      count(*) as total
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.lead_status = 'paid'
      and coalesce(
        contact.payment_submitted_at,
        contact.lead_status_changed_at,
        contact.updated_at
      ) >= v_from_at
      and coalesce(
        contact.payment_submitted_at,
        contact.lead_status_changed_at,
        contact.updated_at
      ) < v_to_at
      and (
        v_target_staff_id is null
        or contact.owner_staff_id = v_target_staff_id
      )
    group by 1
  ),
  tasks as (
    select
      (task.completed_at at time zone v_tenant.timezone)::date as day,
      count(*) as total
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.status = 'completed'
      and task.completed_at >= v_from_at
      and task.completed_at < v_to_at
      and (
        v_target_staff_id is null
        or task.assigned_staff_id = v_target_staff_id
      )
    group by 1
  ),
  calls as (
    select
      (record.started_at at time zone v_tenant.timezone)::date as day,
      count(distinct record.id) as total
    from telephony.call_records record
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
      and (
        v_target_staff_id is null
        or exists (
          select 1
          from jsonb_each_text(v_assignment_map) mapping
          where mapping.value = v_target_staff_id::text
            and mapping.key = any(record.involved_extensions)
        )
      )
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', day.day,
    'leadsAssigned', coalesce(assigned.total, 0),
    'leadsCreated', coalesce(created.total, 0),
    'activities', coalesce(activities.total, 0),
    'paid', coalesce(paid.total, 0),
    'tasksCompleted', coalesce(tasks.total, 0),
    'calls', coalesce(calls.total, 0)
  ) order by day.day), '[]'::jsonb)
  into v_daily
  from days day
  left join assigned on assigned.day = day.day
  left join created on created.day = day.day
  left join activities on activities.day = day.day
  left join paid on paid.day = day.day
  left join tasks on tasks.day = day.day
  left join calls on calls.day = day.day;

  with campaign_contacts as (
    select
      contact.id,
      contact.source,
      contact.campaign_name,
      contact.ad_name,
      contact.lead_status,
      (
        (
          (nullif(trim(contact.full_name), '') is not null)::integer
          + (
            nullif(trim(coalesce(contact.phone, '')), '') is not null
            or nullif(trim(coalesce(contact.whatsapp, '')), '') is not null
          )::integer
          + (nullif(trim(contact.source), '') is not null)::integer
          + (contact.interest_course_id is not null)::integer
          + (contact.owner_staff_id is not null)::integer
        ) * 20.0
      ) as completeness,
      exists (
        select 1
        from sales_core.activities activity
        where activity.tenant_id = v_tenant.id
          and activity.contact_id = contact.id
          and activity.occurred_at >= v_from_at
          and activity.occurred_at < v_to_at
      ) as touched,
      coalesce((
        select sum(handoff.payment_amount_minor)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.contact_id = contact.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
      ), (
        select sum(opportunity.value_minor)
        from sales_core.opportunities opportunity
        where opportunity.tenant_id = v_tenant.id
          and opportunity.contact_id = contact.id
          and opportunity.status = 'won'
          and opportunity.updated_at >= v_from_at
          and opportunity.updated_at < v_to_at
      ), 0) as revenue_minor
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.created_at >= v_from_at
      and contact.created_at < v_to_at
      and (
        v_target_staff_id is null
        or contact.owner_staff_id = v_target_staff_id
      )
  ),
  rollup as (
    select
      coalesce(nullif(trim(source), ''), 'غير محدد') as source,
      coalesce(nullif(trim(campaign_name), ''), 'بدون اسم حملة')
        as campaign,
      coalesce(nullif(trim(ad_name), ''), 'بدون اسم إعلان') as ad,
      count(*) as leads,
      count(*) filter (where touched) as touched_leads,
      count(*) filter (where lead_status = 'paid') as paid_contacts,
      coalesce(sum(revenue_minor), 0) as revenue_minor,
      round(avg(completeness), 1) as completeness
    from campaign_contacts
    group by 1, 2, 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', item.source,
    'campaign', item.campaign,
    'ad', item.ad,
    'leads', item.leads,
    'touchedLeads', item.touched_leads,
    'paidContacts', item.paid_contacts,
    'conversionRate', case when item.leads > 0 then
      round(100.0 * item.paid_contacts / item.leads, 1)
    end,
    'revenueMinor', item.revenue_minor,
    'dataCompletenessRate', item.completeness
  ) order by item.paid_contacts desc, item.leads desc, item.source),
  '[]'::jsonb)
  into v_campaigns
  from rollup item;

  with rows as (
    select value as campaign
    from jsonb_array_elements(v_campaigns)
  ),
  rollup as (
    select
      campaign ->> 'source' as source,
      sum((campaign ->> 'leads')::integer) as leads,
      sum((campaign ->> 'paidContacts')::integer) as paid_contacts,
      sum((campaign ->> 'revenueMinor')::bigint) as revenue_minor
    from rows
    group by campaign ->> 'source'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', source,
    'leads', leads,
    'paidContacts', paid_contacts,
    'conversionRate', case when leads > 0 then
      round(100.0 * paid_contacts / leads, 1)
    end,
    'revenueMinor', revenue_minor
  ) order by paid_contacts desc, leads desc), '[]'::jsonb)
  into v_sources
  from rollup;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', status,
    'label', case status
      when 'new' then 'جديد'
      when 'contacted' then 'تم التواصل'
      when 'no_answer' then 'لا يرد'
      when 'interested' then 'مهتم'
      when 'very_interested' then 'مهتم جدًا'
      when 'awaiting_payment' then 'بانتظار الدفع'
      when 'paid' then 'تم الدفع'
      when 'not_interested' then 'غير مهتم'
      when 'unqualified' then 'غير مؤهل'
      when 'wrong_number' then 'رقم خاطئ'
      when 'duplicate' then 'مكرر'
      when 'cancelled' then 'ملغي'
      else status
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_lead_statuses
  from (
    select contact.lead_status as status, count(*) as total
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and (
        (
          p_report = 'employee'
          and exists (
            select 1
            from sales_core.lead_assignments assignment
            where assignment.tenant_id = v_tenant.id
              and assignment.contact_id = contact.id
              and assignment.assigned_staff_id = v_target_staff_id
              and assignment.assigned_at >= v_from_at
              and assignment.assigned_at < v_to_at
          )
        )
        or (
          p_report <> 'employee'
          and contact.created_at >= v_from_at
          and contact.created_at < v_to_at
          and (
            v_target_staff_id is null
            or contact.owner_staff_id = v_target_staff_id
          )
        )
      )
    group by contact.lead_status
  ) status_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', stage.id,
    'name', stage.name_ar,
    'key', stage.stage_key,
    'count', stats.total,
    'valueMinor', stats.value_minor
  ) order by stage.position), '[]'::jsonb)
  into v_pipeline_stages
  from sales_core.pipeline_stages stage
  join lateral (
    select
      count(*) as total,
      coalesce(sum(opportunity.value_minor), 0) as value_minor
    from sales_core.opportunities opportunity
    where opportunity.tenant_id = v_tenant.id
      and opportunity.stage_id = stage.id
      and opportunity.created_at < v_to_at
      and opportunity.updated_at >= v_from_at
      and (
        v_target_staff_id is null
        or opportunity.owner_staff_id = v_target_staff_id
      )
  ) stats on true
  where stage.tenant_id = v_tenant.id
    and stats.total > 0;

  select coalesce(jsonb_agg(jsonb_build_object(
    'courseId', course.id,
    'name', course.title_ar,
    'leads', stats.leads,
    'paidContacts', stats.paid_contacts,
    'revenueMinor', stats.revenue_minor
  ) order by stats.paid_contacts desc, stats.leads desc, course.title_ar),
  '[]'::jsonb)
  into v_courses
  from academy.courses course
  join lateral (
    select
      count(*) as leads,
      count(*) filter (
        where contact.lead_status = 'paid'
      ) as paid_contacts,
      coalesce((
        select sum(handoff.payment_amount_minor)
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.course_id = course.id
          and handoff.payment_status = 'verified'
          and handoff.paid_at >= v_from_at
          and handoff.paid_at < v_to_at
      ), 0) as revenue_minor
    from sales_core.contacts contact
    where contact.tenant_id = v_tenant.id
      and contact.interest_course_id = course.id
      and contact.created_at >= v_from_at
      and contact.created_at < v_to_at
      and (
        v_target_staff_id is null
        or contact.owner_staff_id = v_target_staff_id
      )
  ) stats on true
  where course.tenant_id = v_tenant.id
    and (stats.leads > 0 or stats.revenue_minor > 0);

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', activity_type,
    'label', case activity_type
      when 'call' then 'مكالمة'
      when 'whatsapp' then 'واتساب'
      when 'meeting' then 'اجتماع'
      when 'note' then 'ملاحظة'
      when 'offer' then 'عرض'
      when 'email' then 'بريد إلكتروني'
      else activity_type
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_activity_breakdown
  from (
    select activity.activity_type, count(*) as total
    from sales_core.activities activity
    where activity.tenant_id = v_tenant.id
      and activity.occurred_at >= v_from_at
      and activity.occurred_at < v_to_at
      and (
        v_target_staff_id is null
        or activity.actor_staff_id = v_target_staff_id
      )
    group by activity.activity_type
  ) activity_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', status,
    'label', case status
      when 'todo' then 'لم يبدأ'
      when 'in_progress' then 'قيد التنفيذ'
      when 'completed' then 'مكتمل'
      when 'cancelled' then 'ملغي'
      else status
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_task_breakdown
  from (
    select task.status, count(*) as total
    from work_core.tasks task
    where task.tenant_id = v_tenant.id
      and task.due_at >= v_from_at
      and task.due_at < v_to_at
      and (
        v_target_staff_id is null
        or task.assigned_staff_id = v_target_staff_id
      )
    group by task.status
  ) task_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', final_status,
    'label', case final_status
      when 'ANSWERED' then 'تم الرد'
      when 'NO ANSWER' then 'لا يوجد رد'
      when 'BUSY' then 'مشغول'
      when 'FAILED' then 'فشلت'
      when 'VOICEMAIL' then 'بريد صوتي'
      else final_status
    end,
    'count', total
  ) order by total desc), '[]'::jsonb)
  into v_call_breakdown
  from (
    select record.final_status, count(distinct record.id) as total
    from telephony.call_records record
    where record.tenant_id = v_tenant.id
      and record.started_at >= v_from_at
      and record.started_at < v_to_at
      and (
        v_target_staff_id is null
        or exists (
          select 1
          from jsonb_each_text(v_assignment_map) mapping
          where mapping.value = v_target_staff_id::text
            and mapping.key = any(record.involved_extensions)
        )
      )
    group by record.final_status
  ) call_rows;

  if p_report = 'employee' and v_target_staff_id is not null then
    v_details := jsonb_build_object(
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', task.id,
          'title', task.title,
          'status', task.status,
          'priority', task.priority,
          'dueAt', task.due_at,
          'completedAt', task.completed_at,
          'contactName', contact.full_name
        ) order by task.due_at desc)
        from (
          select scoped.*
          from work_core.tasks scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.assigned_staff_id = v_target_staff_id
            and scoped.due_at >= v_from_at
            and scoped.due_at < v_to_at
          order by scoped.due_at desc
          limit v_limit offset v_offset
        ) task
        left join sales_core.contacts contact on contact.id = task.contact_id
      ), '[]'::jsonb),
      'activities', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', activity.id,
          'type', activity.activity_type,
          'summary', activity.summary,
          'outcome', activity.outcome,
          'occurredAt', activity.occurred_at,
          'contactName', contact.full_name
        ) order by activity.occurred_at desc)
        from (
          select scoped.*
          from sales_core.activities scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.actor_staff_id = v_target_staff_id
            and scoped.occurred_at >= v_from_at
            and scoped.occurred_at < v_to_at
          order by scoped.occurred_at desc
          limit v_limit offset v_offset
        ) activity
        join sales_core.contacts contact on contact.id = activity.contact_id
      ), '[]'::jsonb),
      'calls', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', call.id,
          'startedAt', call.started_at,
          'callType', call.call_type,
          'finalStatus', call.final_status,
          'otherNumber', case
            when call.call_type = 'Outbound' then call.callee_number
            else call.caller_number
          end,
          'talkSeconds', call.handling_duration_seconds
        ) order by call.started_at desc)
        from (
          select distinct scoped.*
          from telephony.call_records scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.started_at >= v_from_at
            and scoped.started_at < v_to_at
            and exists (
              select 1
              from jsonb_each_text(v_assignment_map) mapping
              where mapping.value = v_target_staff_id::text
                and mapping.key = any(scoped.involved_extensions)
            )
          order by scoped.started_at desc
          limit v_limit offset v_offset
        ) call
      ), '[]'::jsonb),
      'leads', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', contact.id,
          'name', contact.full_name,
          'status', contact.lead_status,
          'source', contact.source,
          'courseName', course.title_ar,
          'assignedAt', assignment.assigned_at,
          'completenessRate', (
            (
              (nullif(trim(contact.full_name), '') is not null)::integer
              + (
                nullif(trim(coalesce(contact.phone, '')), '') is not null
                or nullif(
                  trim(coalesce(contact.whatsapp, '')),
                  ''
                ) is not null
              )::integer
              + (nullif(trim(contact.source), '') is not null)::integer
              + (contact.interest_course_id is not null)::integer
              + (contact.owner_staff_id is not null)::integer
            ) * 20.0
          )
        ) order by assignment.assigned_at desc)
        from (
          select distinct on (scoped.contact_id)
            scoped.contact_id,
            scoped.assigned_at
          from sales_core.lead_assignments scoped
          where scoped.tenant_id = v_tenant.id
            and scoped.assigned_staff_id = v_target_staff_id
            and scoped.assigned_at >= v_from_at
            and scoped.assigned_at < v_to_at
          order by scoped.contact_id, scoped.assigned_at desc
          limit v_limit offset v_offset
        ) assignment
        join sales_core.contacts contact on contact.id = assignment.contact_id
        left join academy.courses course
          on course.id = contact.interest_course_id
      ), '[]'::jsonb)
    );
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'period', jsonb_build_object(
      'from', v_from_date,
      'to', v_to_date,
      'days', v_to_date - v_from_date + 1,
      'timezone', v_tenant.timezone
    ),
    'viewer', jsonb_build_object(
      'staffId', v_current_staff_id,
      'viewTeam', v_view_team,
      'scope', case
        when v_target_staff_id is not null then 'employee'
        else 'team'
      end
    ),
    'availability', jsonb_build_object(
      'sales', v_can_crm,
      'campaigns', v_can_crm or v_can_leads,
      'team', v_view_team
    ),
    'selectedEmployee', v_selected_employee,
    'summary', v_summary,
    'employees', v_employees,
    'daily', v_daily,
    'campaigns', v_campaigns,
    'sources', v_sources,
    'leadStatuses', v_lead_statuses,
    'pipelineStages', v_pipeline_stages,
    'courses', v_courses,
    'activityBreakdown', v_activity_breakdown,
    'taskBreakdown', v_task_breakdown,
    'callBreakdown', v_call_breakdown,
    'details', v_details
  );
end;
$$;

revoke all on function public.v2_tenant_reports_snapshot_v1(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) from public, anon;

grant execute on function public.v2_tenant_reports_snapshot_v1(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) to authenticated;

comment on function public.v2_tenant_reports_snapshot_v1(
  text,
  date,
  date,
  uuid,
  text,
  integer,
  integer
) is
  'Tenant reporting center with bounded periods and role-scoped employee details.';

commit;
