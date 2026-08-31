begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Read-only platform snapshot for the per-tenant ODEIRY Manager control.
-- The existing versioned configure RPC remains the only write boundary.
create or replace function public.v1_platform_odeiry_manager_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_tenants jsonb;
begin
  if not (
    private_app.has_platform_permission('platform.tenants.manage')
    or private_app.has_platform_permission('platform.settings.manage')
  ) then
    raise exception 'forbidden';
  end if;

  select runtime.* into v_runtime
  from platform.odeiry_runtime_settings runtime
  where runtime.singleton;

  if v_runtime.singleton is null then
    raise exception 'odeiry_runtime_missing';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tenantId',tenant.id,
        'tenantSlug',tenant.slug,
        'enabled',coalesce(setting.enabled,false),
        'effectiveEnabled',(
          v_runtime.manager_enabled and coalesce(setting.enabled,false)
        ),
        'version',coalesce(setting.version,0)
      ) order by tenant.slug
    ),
    '[]'::jsonb
  ) into v_tenants
  from core.tenants tenant
  left join core.odeiry_manager_settings setting
    on setting.tenant_id=tenant.id;

  return jsonb_build_object(
    'schemaVersion',1,
    'globalEnabled',v_runtime.manager_enabled,
    'globalVersion',v_runtime.version,
    'canManage',private_app.has_platform_permission(
      'platform.settings.manage'
    ),
    'tenants',v_tenants
  );
end;
$$;

revoke all on function public.v1_platform_odeiry_manager_snapshot()
from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_odeiry_manager_snapshot()
to authenticated;

comment on function public.v1_platform_odeiry_manager_snapshot() is
'Read-only platform snapshot for audited, versioned per-tenant ODEIRY Manager controls.';

commit;
