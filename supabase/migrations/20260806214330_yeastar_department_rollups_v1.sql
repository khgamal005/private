-- Add role-scoped, de-duplicated Yeastar department rollups.
begin;

create or replace function public.v4_tenant_yeastar_department_snapshot(
  p_slug text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_extension text default null,
  p_call_type text default null,
  p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_current_staff_id uuid;
  v_subject_id uuid;
  v_role_key text;
  v_is_platform boolean := false;
  v_scope_staff_ids uuid[] := '{}'::uuid[];
  v_assignment_map jsonb := '{}'::jsonb;
  v_from timestamptz := coalesce(
    p_from,
    date_trunc('day', now()) - interval '29 days'
  );
  v_to timestamptz := coalesce(p_to, now());
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  v_is_platform :=
    private_app.has_platform_permission('platform.tenants.read');

  if not (
    v_is_platform
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.crm.read'
    )
    or private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.settings.manage'
    )
  ) then
    raise exception 'forbidden';
  end if;

  if not private_app.tenant_yeastar_addon_enabled(v_tenant.id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  if v_from >= v_to or v_to - v_from > interval '366 days' then
    raise exception 'invalid_report_period';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant.id);

  select staff.role_key
  into v_role_key
  from people.staff_profiles staff
  where staff.id = v_current_staff_id
    and staff.tenant_id = v_tenant.id
    and staff.employment_status = 'active'
  limit 1;

  if v_role_key is null then
    v_subject_id := private_app.current_subject_id();

    select role.role_key
    into v_role_key
    from access_control.memberships membership
    join access_control.membership_roles membership_role
      on membership_role.membership_id = membership.id
    join access_control.roles role
      on role.id = membership_role.role_id
    where membership.tenant_id = v_tenant.id
      and membership.subject_id = v_subject_id
      and membership.status = 'active'
      and role.scope = 'tenant'
    order by private_app.tenant_role_rank(role.role_key) desc
    limit 1;
  end if;

  if v_role_key is null and v_is_platform then
    v_role_key := 'tenant_owner';
  end if;
  v_role_key := coalesce(v_role_key, 'tenant_user');

  v_scope_staff_ids := private_app.v2_metric_staff_scope(
    v_tenant.id,
    v_current_staff_id,
    v_role_key,
    v_is_platform
  );

  select connection.*
  into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  v_assignment_map := coalesce(
    v_connection.public_config -> 'extensionAssignments',
    '{}'::jsonb
  );

  return coalesce((
    with scoped_staff as (
      select
        staff.id,
        coalesce(department.id::text, 'unassigned') as department_key,
        coalesce(nullif(department.name_ar, ''), 'غير محدد')
          as department_name
      from people.staff_profiles staff
      left join people.departments department
        on department.id = staff.department_id
       and department.tenant_id = staff.tenant_id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.id = any(v_scope_staff_ids)
    ),
    staff_extensions as (
      select
        staff.id as staff_id,
        staff.department_key,
        staff.department_name,
        mapping.key as extension
      from scoped_staff staff
      cross join lateral jsonb_each_text(v_assignment_map) mapping
      where mapping.value = staff.id::text
        and (p_extension is null or mapping.key = p_extension)
    ),
    department_scope as (
      select
        extension.department_key,
        extension.department_name,
        count(distinct extension.staff_id) as staff_count,
        array_agg(distinct extension.extension order by extension.extension)
          as extensions
      from staff_extensions extension
      group by extension.department_key, extension.department_name
    ),
    department_stats as (
      select
        department.department_key,
        department.department_name,
        department.staff_count,
        department.extensions,
        count(distinct record.id) as total_calls,
        count(distinct record.id) filter (
          where record.final_status = 'ANSWERED'
        ) as answered_calls,
        count(distinct record.id) filter (
          where record.final_status in (
            'NO ANSWER',
            'ABANDONED',
            'BUSY'
          )
        ) as missed_calls,
        count(distinct record.id) filter (
          where record.call_type = 'Inbound'
        ) as inbound_calls,
        count(distinct record.id) filter (
          where record.call_type = 'Outbound'
        ) as outbound_calls,
        coalesce(sum(record.handling_duration_seconds), 0)
          as talk_seconds,
        coalesce(round(avg(record.handling_duration_seconds)), 0)
          as average_talk_seconds
      from department_scope department
      left join telephony.call_records record
        on record.tenant_id = v_tenant.id
       and record.involved_extensions && department.extensions
       and record.started_at >= v_from
       and record.started_at < v_to
       and (
         p_extension is null
         or p_extension = any(record.involved_extensions)
       )
       and (p_call_type is null or record.call_type = p_call_type)
       and (p_status is null or record.final_status = p_status)
      group by
        department.department_key,
        department.department_name,
        department.staff_count,
        department.extensions
    )
    select jsonb_agg(jsonb_build_object(
      'departmentKey', stats.department_key,
      'name', stats.department_name,
      'staffCount', stats.staff_count,
      'extensions', to_jsonb(stats.extensions),
      'calls', stats.total_calls,
      'answered', stats.answered_calls,
      'missed', stats.missed_calls,
      'inbound', stats.inbound_calls,
      'outbound', stats.outbound_calls,
      'talkSeconds', stats.talk_seconds,
      'averageTalkSeconds', stats.average_talk_seconds,
      'answerRate', case
        when stats.total_calls > 0 then round(
          100.0 * stats.answered_calls / stats.total_calls,
          1
        )
        else 0
      end
    ) order by stats.total_calls desc, stats.department_name)
    from department_stats stats
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.v4_tenant_yeastar_department_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text
) from public, anon;

grant execute on function public.v4_tenant_yeastar_department_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text
) to authenticated;

comment on function public.v4_tenant_yeastar_department_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text
) is
  'Returns role-scoped Yeastar department KPIs with each call counted once per department.';

notify pgrst, 'reload schema';

commit;
