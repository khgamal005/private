begin;

create or replace function public.v3_tenant_lead_intake_export_v1(
  p_slug text,
  p_section text default 'assignments',
  p_from date default null,
  p_to date default null,
  p_quality text default null,
  p_source text default null,
  p_campaign text default null,
  p_batch_id uuid default null,
  p_validation text default null,
  p_query text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_section text := lower(coalesce(
    nullif(trim(p_section), ''),
    'assignments'
  ));
  v_quality text := nullif(trim(p_quality), '');
  v_source text := nullif(trim(p_source), '');
  v_campaign text := nullif(trim(p_campaign), '');
  v_query text := nullif(lower(trim(p_query)), '');
  v_phone_query text := regexp_replace(
    coalesce(p_query, ''),
    '[^0-9]',
    '',
    'g'
  );
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_result jsonb;
begin
  if v_section not in ('assignments', 'team') then
    return public.v2_tenant_lead_intake_export_v1(
      p_slug,
      p_section,
      p_from,
      p_to,
      p_quality,
      p_source,
      p_campaign,
      p_batch_id,
      p_validation,
      p_query
    );
  end if;

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
    'tenant.leads.read'
  ) then
    raise exception 'forbidden';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'invalid_report_range';
  end if;
  if v_section = 'team'
     and not private_app.has_tenant_permission(
       v_tenant.id,
       'tenant.leads.distribute'
     ) then
    raise exception 'forbidden';
  end if;

  v_from_at := case when p_from is null then null
    else p_from::timestamp at time zone v_tenant.timezone
  end;
  v_to_at := case when p_to is null then null
    else (p_to + 1)::timestamp at time zone v_tenant.timezone
  end;

  if v_section = 'assignments' then
    with filtered_events as (
      select event.*
      from private_app.v3_assignment_events(
        v_tenant.id,
        v_from_at,
        v_to_at,
        null
      ) event
      where (
          v_quality is null
          or event.lead_quality = v_quality
          or event.lead_status = v_quality
        )
        and (v_source is null or event.source = v_source)
        and (v_campaign is null or event.campaign_name = v_campaign)
        and (
          v_query is null
          or lower(event.contact_name) like '%' || v_query || '%'
          or (
            v_phone_query <> ''
            and regexp_replace(
              coalesce(event.phone, ''),
              '[^0-9]',
              '',
              'g'
            ) like '%' || v_phone_query || '%'
          )
        )
    )
    select jsonb_build_object(
      'metricContract', 'assignment-events-v1',
      'dateBasis', 'assigned_at',
      'reconciliation', jsonb_build_object(
        'assignmentOperations', count(*),
        'assignedCustomers', count(distinct event.contact_id),
        'validAssignedCustomers', count(distinct event.contact_id) filter (
          where private_app.v3_metric_is_valid_assigned_contact(
            event.contact_status,
            event.lead_status,
            event.lead_quality
          )
        )
      ),
      'assignments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'معرف عملية الإسناد', event_row.assignment_id,
          'العميل', event_row.contact_name,
          'رقم الجوال', event_row.phone,
          'المصدر', event_row.source,
          'الحملة', event_row.campaign_name,
          'مجموعة الإعلانات', event_row.ad_set_name,
          'الإعلان', event_row.ad_name,
          'المسؤول', assignee.full_name,
          'تم الإسناد بواسطة', coalesce(
            assigner.full_name,
            'إدارة المنشأة'
          ),
          'طريقة التوزيع', event_row.assignment_strategy,
          'حالة الإسناد', event_row.assignment_status,
          'تاريخ الإسناد', event_row.assigned_at,
          'موعد أول متابعة', event_row.deadline_at,
          'تاريخ أول استجابة', event_row.first_action_at,
          'زمن الاستجابة بالدقائق', case
            when event_row.first_action_at is null then null
            else round((extract(epoch from (
              event_row.first_action_at - event_row.assigned_at
            )) / 60)::numeric, 1)
          end,
          'حالة العميل', event_row.lead_status,
          'جودة الصف', event_row.lead_quality,
          'صالح بعد المعالجة',
            private_app.v3_metric_is_valid_assigned_contact(
              event_row.contact_status,
              event_row.lead_status,
              event_row.lead_quality
            ),
          'متأخر', (
            event_row.assignment_status = 'active'
            and event_row.first_action_at is null
            and event_row.deadline_at < now()
          )
        ) order by event_row.assigned_at desc, event_row.assignment_id)
        from filtered_events event_row
        join people.staff_profiles assignee
          on assignee.id = event_row.assigned_staff_id
        left join people.staff_profiles assigner
          on assigner.id = event_row.assigned_by_staff_id
      ), '[]'::jsonb)
    )
    into v_result
    from filtered_events event;

    return v_result;
  end if;

  select jsonb_build_object(
    'metricContract', 'assignment-events-v1',
    'dateBasis', 'assigned_at',
    'team', coalesce(jsonb_agg(jsonb_build_object(
      'الموظف', staff.full_name,
      'المسمى الوظيفي', staff.job_title,
      'قناة البيع', coalesce(profile.sales_channel, 'online'),
      'متاح للتوزيع', coalesce(profile.eligible_for_leads, false),
      'السعة اليومية', coalesce(profile.daily_capacity, 50),
      'الوزن', coalesce(profile.weight, 1),
      'إجمالي الإسنادات المطابقة', metrics.assignment_operations,
      'عمليات الإسناد المطابقة', metrics.assignment_operations,
      'العملاء المسندون المطابقون', metrics.assigned_customers,
      'العملاء الصالحون بعد المعالجة', metrics.valid_customers,
      'تم التواصل', metrics.contacted_customers,
      'بانتظار أول تواصل', metrics.active_assignments,
      'متأخر', metrics.overdue_assignments,
      'متوسط أول استجابة بالدقائق',
        metrics.average_first_response_minutes,
      'آخر إسناد', profile.last_assigned_at
    ) order by staff.full_name), '[]'::jsonb)
  )
  into v_result
  from people.staff_profiles staff
  left join sales_core.sales_assignment_profiles profile
    on profile.staff_id = staff.id
   and profile.tenant_id = staff.tenant_id
  left join lateral (
    select
      count(*)::bigint as assignment_operations,
      count(distinct event.contact_id)::bigint as assigned_customers,
      count(distinct event.contact_id) filter (
        where private_app.v3_metric_is_valid_assigned_contact(
          event.contact_status,
          event.lead_status,
          event.lead_quality
        )
      )::bigint as valid_customers,
      count(distinct event.contact_id) filter (
        where event.first_action_at is not null
      )::bigint as contacted_customers,
      count(*) filter (
        where event.assignment_status = 'active'
          and event.first_action_at is null
      )::bigint as active_assignments,
      count(*) filter (
        where event.assignment_status = 'active'
          and event.first_action_at is null
          and event.deadline_at < now()
      )::bigint as overdue_assignments,
      round((avg(
        extract(epoch from (
          event.first_action_at - event.assigned_at
        )) / 60
      ) filter (
        where event.first_action_at is not null
      ))::numeric, 1) as average_first_response_minutes
    from private_app.v3_assignment_events(
      v_tenant.id,
      v_from_at,
      v_to_at,
      array[staff.id]
    ) event
    where (
        v_quality is null
        or event.lead_quality = v_quality
        or event.lead_status = v_quality
      )
      and (v_source is null or event.source = v_source)
      and (v_campaign is null or event.campaign_name = v_campaign)
  ) metrics on true
  where staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
    and staff.role_key in (
      'sales_user',
      'sales_supervisor',
      'sales_manager'
    );

  return v_result;
end;
$$;

revoke all on function public.v3_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
)
from public, anon, authenticated;

grant execute on function public.v3_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
)
to authenticated, service_role;

comment on function public.v3_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
) is
'Lead-intake XLSX dataset. Assignment search by customer name or phone now matches the visible distribution log while retaining assignment-events-v1 reconciliation.';

notify pgrst, 'reload schema';

commit;
