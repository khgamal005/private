begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- A manager activation is a child capability of the base ODEIRY assistant.
-- Keep both gates consistent in one transaction and report the authoritative
-- effective state back to the platform UI.
create or replace function public.v1_platform_odeiry_manager_configure(
  p_slug text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_setting core.odeiry_manager_settings%rowtype;
  v_base_setting core.odeiry_tenant_settings%rowtype;
  v_actor_id uuid:=private_app.current_subject_id();
  v_enabled boolean;
  v_expected_version integer;
  v_max_approved smallint;
  v_max_pending smallint;
  v_base_changed boolean:=false;
  v_now timestamptz:=clock_timestamp();
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  if p_payload is null
     or jsonb_typeof(p_payload)<>'object'
     or octet_length(p_payload::text)>4096
     or exists(
       select 1 from jsonb_object_keys(p_payload) payload_key
       where payload_key not in (
         'enabled','expectedVersion','maxApprovedMemoriesPerOwner',
         'maxPendingMemoriesPerOwner'
       )
     )
     or not p_payload ? 'enabled'
     or jsonb_typeof(p_payload->'enabled')<>'boolean' then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  begin
    v_enabled:=(p_payload->>'enabled')::boolean;
    v_expected_version:=(p_payload->>'expectedVersion')::integer;
  exception when others then
    raise exception 'odeiry_manager_payload_invalid';
  end;

  -- Always acquire the dependency lock before the child-capability lock.
  -- The standalone base configurator only takes the first lock, so this
  -- ordering cannot deadlock with it.
  if v_enabled then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:odeiry:tenant-config:'||v_tenant.id::text,0
      )
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:odeiry-manager:config:'||v_tenant.id::text,0
    )
  );
  select setting.* into v_setting
  from core.odeiry_manager_settings setting
  where setting.tenant_id=v_tenant.id
  for update;

  begin
    v_max_approved:=coalesce(
      case when p_payload ? 'maxApprovedMemoriesPerOwner'
        then (p_payload->>'maxApprovedMemoriesPerOwner')::smallint
        else v_setting.max_approved_memories_per_owner end,
      50
    );
    v_max_pending:=coalesce(
      case when p_payload ? 'maxPendingMemoriesPerOwner'
        then (p_payload->>'maxPendingMemoriesPerOwner')::smallint
        else v_setting.max_pending_memories_per_owner end,
      20
    );
  exception when others then
    raise exception 'odeiry_manager_payload_invalid';
  end;
  if v_max_approved not between 5 and 100
     or v_max_pending not between 2 and 50 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;

  -- Validate the optimistic manager version before touching the base gate.
  -- Any later failure still rolls the whole transaction back atomically.
  if v_setting.tenant_id is null then
    if v_expected_version is distinct from 0 then
      raise exception 'odeiry_manager_version_conflict';
    end if;
  elsif v_expected_version is null
        or v_expected_version<>v_setting.version then
    raise exception 'odeiry_manager_version_conflict';
  end if;

  if v_enabled then
    select setting.* into v_base_setting
    from core.odeiry_tenant_settings setting
    where setting.tenant_id=v_tenant.id
    for update;

    if v_base_setting.tenant_id is null then
      insert into core.odeiry_tenant_settings(
        tenant_id,enabled,billing_mode,shadow_soft_budget_units,
        run_rate_limit_per_minute,retention_days,version,enabled_at,
        enabled_by_subject_id,updated_by_subject_id,created_at,updated_at
      ) values (
        v_tenant.id,true,'shadow',null,12,90,1,v_now,
        v_actor_id,v_actor_id,v_now,v_now
      ) returning * into v_base_setting;
      v_base_changed:=true;
    elsif not v_base_setting.enabled then
      update core.odeiry_tenant_settings setting
      set enabled=true,
          billing_mode='shadow',
          version=setting.version+1,
          enabled_at=v_now,
          enabled_by_subject_id=v_actor_id,
          updated_by_subject_id=v_actor_id,
          updated_at=v_now
      where setting.tenant_id=v_tenant.id
      returning * into v_base_setting;
      v_base_changed:=true;
    end if;

    if v_base_changed then
      perform private_app.write_audit(
        'odeiry.tenant.configured','tenant',v_tenant.id::text,
        v_tenant.id,jsonb_build_object(
          'enabled',true,
          'billingMode','shadow',
          'shadowSoftBudgetUnits',v_base_setting.shadow_soft_budget_units,
          'softBudgetEnforced',false,
          'runRateLimitPerMinute',v_base_setting.run_rate_limit_per_minute,
          'retentionDays',v_base_setting.retention_days,
          'version',v_base_setting.version,
          'autoEnabledBy','odeiry_manager',
          'source','odeiry_manager_dependency'
        )
      );
    end if;
  else
    select setting.* into v_base_setting
    from core.odeiry_tenant_settings setting
    where setting.tenant_id=v_tenant.id;
  end if;

  if v_setting.tenant_id is null then
    insert into core.odeiry_manager_settings(
      tenant_id,enabled,max_approved_memories_per_owner,
      max_pending_memories_per_owner,version,enabled_at,
      enabled_by_subject_id,updated_by_subject_id,created_at,updated_at
    ) values (
      v_tenant.id,v_enabled,v_max_approved,v_max_pending,1,
      case when v_enabled then v_now else null end,
      case when v_enabled then v_actor_id else null end,
      v_actor_id,v_now,v_now
    ) returning * into v_setting;
  else
    update core.odeiry_manager_settings setting
    set enabled=v_enabled,
        max_approved_memories_per_owner=v_max_approved,
        max_pending_memories_per_owner=v_max_pending,
        version=setting.version+1,
        enabled_at=case when v_enabled
          then coalesce(setting.enabled_at,v_now) else null end,
        enabled_by_subject_id=case when v_enabled
          then coalesce(setting.enabled_by_subject_id,v_actor_id) else null end,
        updated_by_subject_id=v_actor_id,
        updated_at=v_now
    where setting.tenant_id=v_tenant.id
    returning * into v_setting;
  end if;

  perform private_app.write_audit(
    'odeiry.manager.configured','tenant',v_tenant.id::text,v_tenant.id,
    jsonb_build_object(
      'enabled',v_setting.enabled,
      'maxApprovedMemoriesPerOwner',
        v_setting.max_approved_memories_per_owner,
      'maxPendingMemoriesPerOwner',
        v_setting.max_pending_memories_per_owner,
      'version',v_setting.version,
      'baseAutoEnabled',v_base_changed,
      'baseVersion',coalesce(v_base_setting.version,0),
      'effectiveEnabled',(
        private_app.odeiry_manager_runtime_enabled()
        and private_app.odeiry_is_available(v_tenant.id)
        and v_setting.enabled
      )
    )
  );
  return jsonb_build_object(
    'tenantSlug',v_tenant.slug,
    'enabled',v_setting.enabled,
    'effectiveEnabled',(
      private_app.odeiry_manager_runtime_enabled()
      and private_app.odeiry_is_available(v_tenant.id)
      and v_setting.enabled
    ),
    'baseEnabled',coalesce(v_base_setting.enabled,false),
    'baseVersion',coalesce(v_base_setting.version,0),
    'baseAutoEnabled',v_base_changed,
    'maxApprovedMemoriesPerOwner',
      v_setting.max_approved_memories_per_owner,
    'maxPendingMemoriesPerOwner',
      v_setting.max_pending_memories_per_owner,
    'version',v_setting.version
  );
end;
$$;

revoke all on function public.v1_platform_odeiry_manager_configure(
  text,jsonb
)
from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_odeiry_manager_configure(
  text,jsonb
)
to authenticated;

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
        'enabled',coalesce(manager_setting.enabled,false),
        'effectiveEnabled',(
          v_runtime.manager_enabled
          and coalesce(manager_setting.enabled,false)
          and private_app.odeiry_is_available(tenant.id)
        ),
        'baseEnabled',coalesce(base_setting.enabled,false),
        'baseAvailable',private_app.odeiry_is_available(tenant.id),
        'baseVersion',coalesce(base_setting.version,0),
        'version',coalesce(manager_setting.version,0)
      ) order by tenant.slug
    ),
    '[]'::jsonb
  ) into v_tenants
  from core.tenants tenant
  left join core.odeiry_manager_settings manager_setting
    on manager_setting.tenant_id=tenant.id
  left join core.odeiry_tenant_settings base_setting
    on base_setting.tenant_id=tenant.id;

  return jsonb_build_object(
    'schemaVersion',2,
    'globalEnabled',v_runtime.manager_enabled,
    'baseGlobalEnabled',v_runtime.enabled,
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

comment on function public.v1_platform_odeiry_manager_configure(text,jsonb) is
'Atomically enables the base ODEIRY gate when ODEIRY Manager is enabled and returns the authoritative effective state.';

comment on function public.v1_platform_odeiry_manager_snapshot() is
'Platform snapshot for per-tenant ODEIRY Manager controls including the authoritative base ODEIRY gate.';

commit;
