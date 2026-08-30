begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regprocedure(
       'private_app.support_is_active_tenant_member(uuid)'
     ) is null
     or to_regprocedure(
       'private_app.has_platform_permission(text)'
     ) is null
     or to_regprocedure(
       'private_app.can_access_tenant(uuid)'
     ) is null
     or to_regprocedure(
       'private_app.odeiry_is_active_tenant_member(uuid)'
     ) is null
     or to_regprocedure(
       'public.v3_tenant_odeiry_snapshot(text)'
     ) is null then
    raise exception 'odeiry_platform_operator_missing_foundation';
  end if;
end;
$preflight$;

-- Platform access is deliberately narrower than general tenant inspection:
-- the caller must hold both the ODEIRY configuration permission and the
-- existing tenant-access permission. Tenant membership remains unchanged.
create or replace function private_app.odeiry_is_platform_operator(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and private_app.has_platform_permission('platform.settings.manage')
    and private_app.can_access_tenant(p_tenant_id)
$$;

revoke all on function private_app.odeiry_is_platform_operator(uuid)
from public,anon,authenticated,service_role;

-- Keep the original helper signature because every ODEIRY RPC and RLS policy
-- already depends on it. It now represents an authorized ODEIRY actor:
-- either an active tenant member or a tightly scoped platform operator.
create or replace function private_app.odeiry_is_active_tenant_member(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    private_app.support_is_active_tenant_member(p_tenant_id)
    or private_app.odeiry_is_platform_operator(p_tenant_id)
  )
$$;

revoke all on function
  private_app.odeiry_is_active_tenant_member(uuid)
from public,anon,authenticated,service_role;

create or replace function public.v3_tenant_odeiry_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_setting core.odeiry_tenant_settings%rowtype;
  v_subject_id uuid := private_app.current_subject_id();
  v_available boolean := false;
  v_access_mode text;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,'')) > 240 then
    raise exception 'odeiry_slug_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if v_subject_id is null
     or not private_app.odeiry_is_active_tenant_member(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  v_access_mode := case
    when private_app.support_is_active_tenant_member(v_tenant.id)
      then 'tenant_member'
    when private_app.odeiry_is_platform_operator(v_tenant.id)
      then 'platform_operator'
    else null
  end;
  if v_access_mode is null then
    raise exception 'forbidden';
  end if;

  select runtime.* into v_runtime
  from platform.odeiry_runtime_settings runtime
  where runtime.singleton;
  select setting.* into v_setting
  from core.odeiry_tenant_settings setting
  where setting.tenant_id = v_tenant.id;
  v_available := coalesce(v_runtime.enabled,false)
    and coalesce(v_setting.enabled,false)
    and coalesce(v_runtime.billing_mode,'shadow') = 'shadow'
    and coalesce(v_setting.billing_mode,'shadow') = 'shadow';

  return jsonb_build_object(
    'schemaVersion',1,
    'generatedAt',now(),
    'available',v_available,
    'enabled',coalesce(v_setting.enabled,false),
    'globalEnabled',coalesce(v_runtime.enabled,false),
    'mode',v_access_mode,
    'reason',case
      when not coalesce(v_runtime.enabled,false) then 'globally_disabled'
      when not coalesce(v_setting.enabled,false) then 'tenant_disabled'
      else null
    end,
    'billing',jsonb_build_object(
      'mode','shadow',
      'billable',false,
      'softBudgetUnits',v_setting.shadow_soft_budget_units,
      'softBudgetEnforced',false
    ),
    'limits',jsonb_build_object(
      'maxInputChars',coalesce(v_runtime.max_input_chars,12000),
      'maxResponseChars',coalesce(v_runtime.max_response_chars,24000),
      'maxKnowledgeResults',coalesce(
        v_runtime.max_knowledge_results,6
      ),
      'runsPerMinute',coalesce(v_setting.run_rate_limit_per_minute,12)
    )
  );
end;
$$;

revoke all on function public.v3_tenant_odeiry_snapshot(text)
from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_odeiry_snapshot(text)
to authenticated;

comment on function private_app.odeiry_is_platform_operator(uuid) is
'True only for an authenticated platform operator with settings management and explicit tenant access.';

comment on function private_app.odeiry_is_active_tenant_member(uuid) is
'Compatibility ODEIRY access gate: active tenant member or tightly scoped platform operator; it never creates membership.';

comment on function public.v3_tenant_odeiry_snapshot(text) is
'Minimal ODEIRY availability gate for tenant members and scoped platform operators; returns access mode without history.';

commit;
