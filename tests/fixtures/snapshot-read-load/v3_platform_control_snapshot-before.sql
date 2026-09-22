CREATE OR REPLACE FUNCTION public.v3_platform_control_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_snapshot jsonb;
  v_tenants jsonb := '[]'::jsonb;
begin
  v_snapshot := public.v2_platform_control_snapshot_v2();

  select coalesce(jsonb_agg(
    member.item || jsonb_build_object(
      'overdueTasks', (
        select count(*)
        from work_core.tasks task
        join core.tenants tenant
          on tenant.id = task.tenant_id
        left join pg_catalog.pg_timezone_names zone
          on zone.name = nullif(tenant.timezone, '')
        where task.tenant_id = nullif(
            member.item ->> 'id',
            ''
          )::uuid
          and task.status not in ('completed', 'cancelled')
          and (
            (
              private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < (
                (
                  now() at time zone coalesce(zone.name, 'UTC')
                )::date::timestamp at time zone coalesce(zone.name, 'UTC')
              )
            )
            or (
              not private_app.customer_followup_uses_day_policy_v1(
                task.contact_id,
                task.metadata ->> 'source'
              )
              and task.due_at < now()
            )
          )
      )
    ) order by member.position
  ), '[]'::jsonb)
  into v_tenants
  from jsonb_array_elements(
    coalesce(v_snapshot -> 'tenants', '[]'::jsonb)
  ) with ordinality member(item, position);

  return jsonb_set(v_snapshot, '{tenants}', v_tenants, true);
end;
$function$

