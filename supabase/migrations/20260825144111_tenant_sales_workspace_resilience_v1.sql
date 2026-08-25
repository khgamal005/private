begin;

set local lock_timeout = '2s';

create index if not exists sales_contacts_workspace_order_idx
on sales_core.contacts (
  tenant_id,
  next_action_at asc nulls last,
  created_at desc,
  id desc
);

create index if not exists sales_contacts_owner_workspace_order_idx
on sales_core.contacts (
  tenant_id,
  owner_staff_id,
  next_action_at asc nulls last,
  created_at desc,
  id desc
);

create index if not exists registration_handoffs_workspace_order_idx
on academy.registration_handoffs (
  tenant_id,
  created_at desc,
  id desc
);

create or replace function public.v1_tenant_sales_workspace_snapshot(
  p_slug text,
  p_limit integer default 80,
  p_query text default null,
  p_filter text default 'all',
  p_from date default null,
  p_to date default null,
  p_focus_contact_id uuid default null,
  p_include_auxiliary boolean default true,
  p_after_next_action_at timestamptz default null,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_after_next_action_is_null boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '4s'
as $function$
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
$function$;

revoke all on function public.v1_tenant_sales_workspace_snapshot(
  text,
  integer,
  text,
  text,
  date,
  date,
  uuid,
  boolean,
  timestamptz,
  timestamptz,
  uuid,
  boolean
) from public, anon, authenticated;

grant execute on function public.v1_tenant_sales_workspace_snapshot(
  text,
  integer,
  text,
  text,
  date,
  date,
  uuid,
  boolean,
  timestamptz,
  timestamptz,
  uuid,
  boolean
) to authenticated, service_role;

comment on function public.v1_tenant_sales_workspace_snapshot(
  text,
  integer,
  text,
  text,
  date,
  date,
  uuid,
  boolean,
  timestamptz,
  timestamptz,
  uuid,
  boolean
) is
'Bounded, permission-scoped sales workspace with exact counters, keyset contact pagination, and capped auxiliary lists.';

notify pgrst, 'reload schema';

commit;
