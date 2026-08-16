-- Add an exact talk + ring duration metric to the tenant-isolated Yeastar report.
-- Yeastar total duration = routing duration + handling duration.
begin;

create or replace function public.v3_tenant_yeastar_reports_snapshot(
  p_slug text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_extension text default null,
  p_call_type text default null,
  p_status text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant_id uuid;
  v_from timestamptz := coalesce(
    p_from,
    date_trunc('day', now()) - interval '29 days'
  );
  v_to timestamptz := coalesce(p_to, now());
  v_result jsonb;
  v_personal_only boolean := false;
  v_staff_extensions text[] := '{}'::text[];
  v_total_routing_seconds bigint := 0;
  v_total_talk_and_ring_seconds bigint := 0;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not (
    private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.crm.read'
    )
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.settings.manage'
    )
  ) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_yeastar_addon_enabled(v_tenant_id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  v_result := private_app.yeastar_reports_snapshot_core_v2(
    p_slug,
    v_from,
    v_to,
    p_extension,
    p_call_type,
    p_status,
    p_limit,
    p_offset
  );

  v_personal_only := coalesce(
    (v_result #>> '{viewer,personalOnly}')::boolean,
    false
  );

  select coalesce(array_agg(extension.value), '{}'::text[])
  into v_staff_extensions
  from jsonb_array_elements_text(
    coalesce(v_result #> '{viewer,extensions}', '[]'::jsonb)
  ) extension(value);

  select
    coalesce(sum(record.routing_duration_seconds), 0)::bigint,
    coalesce(sum(
      record.routing_duration_seconds::bigint
      + record.handling_duration_seconds::bigint
    ), 0)::bigint
  into
    v_total_routing_seconds,
    v_total_talk_and_ring_seconds
  from telephony.call_records record
  where record.tenant_id = v_tenant_id
    and (
      not v_personal_only
      or record.involved_extensions && v_staff_extensions
    )
    and record.started_at >= v_from
    and record.started_at < v_to
    and (
      p_extension is null
      or p_extension = any(record.involved_extensions)
    )
    and (p_call_type is null or record.call_type = p_call_type)
    and (p_status is null or record.final_status = p_status);

  v_result := jsonb_set(
    v_result,
    '{summary}',
    coalesce(v_result -> 'summary', '{}'::jsonb)
      || jsonb_build_object(
        'totalRoutingSeconds', v_total_routing_seconds,
        'totalTalkAndRingSeconds', v_total_talk_and_ring_seconds
      ),
    true
  );

  return v_result;
end;
$function$;

revoke all on function public.v3_tenant_yeastar_reports_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) from public, anon;

grant execute on function public.v3_tenant_yeastar_reports_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) to authenticated;

comment on function public.v3_tenant_yeastar_reports_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) is
  'Paid Yeastar report with tenant-scoped exact talk, routing, and combined duration metrics.';

notify pgrst, 'reload schema';

commit;
