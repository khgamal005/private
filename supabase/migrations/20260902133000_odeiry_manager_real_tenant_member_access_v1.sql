begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- A platform operator who also has a real active membership and the exact
-- manager permission in this tenant is a tenant member for this capability.
-- Platform-only preview remains denied because both predicates below are
-- tenant-bound and must succeed for the requested tenant id.
create or replace function private_app.odeiry_manager_can_use(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select auth.uid() is not null
    and private_app.support_is_active_tenant_member(p_tenant_id)
    and exists(
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
       and membership.tenant_id=p_tenant_id
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id
       and role.scope='tenant'
       and (role.tenant_id is null or role.tenant_id=p_tenant_id)
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
       and role_permission.permission_key='tenant.odeiry_manager.use'
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
    )
$$;

revoke all on function private_app.odeiry_manager_can_use(uuid)
from public,anon,authenticated,service_role;

create or replace function public.v3_tenant_odeiry_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_setting core.odeiry_tenant_settings%rowtype;
  v_manager_setting core.odeiry_manager_settings%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_available boolean:=false;
  v_access_mode text;
  v_manager_allowed boolean:=false;
  v_manager_available boolean:=false;
  v_manager_review_available boolean:=false;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240 then
    raise exception 'odeiry_slug_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_subject_id is null
     or not private_app.odeiry_is_active_tenant_member(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  v_access_mode:=case
    when private_app.support_is_active_tenant_member(v_tenant.id)
      then 'tenant_member'
    when private_app.odeiry_is_platform_operator(v_tenant.id)
      then 'platform_operator'
    else null end;
  if v_access_mode is null then raise exception 'forbidden'; end if;
  select runtime.* into v_runtime
  from platform.odeiry_runtime_settings runtime where runtime.singleton;
  select setting.* into v_setting
  from core.odeiry_tenant_settings setting
  where setting.tenant_id=v_tenant.id;
  select setting.* into v_manager_setting
  from core.odeiry_manager_settings setting
  where setting.tenant_id=v_tenant.id;
  v_available:=coalesce(v_runtime.enabled,false)
    and coalesce(v_setting.enabled,false)
    and coalesce(v_runtime.billing_mode,'shadow')='shadow'
    and coalesce(v_setting.billing_mode,'shadow')='shadow';
  v_manager_allowed:=v_access_mode='tenant_member'
    and private_app.odeiry_manager_can_use(v_tenant.id);
  v_manager_available:=v_available
    and coalesce(v_runtime.manager_enabled,false)
    and v_manager_allowed
    and coalesce(v_manager_setting.enabled,false);
  v_manager_review_available:=v_manager_allowed and exists(
    select 1
    from core.odeiry_manager_memories memory
    where memory.tenant_id=v_tenant.id
      and memory.owner_subject_id=v_subject_id
  );
  return jsonb_build_object(
    'schemaVersion',1,'generatedAt',now(),
    'available',v_available,
    'enabled',coalesce(v_setting.enabled,false),
    'globalEnabled',coalesce(v_runtime.enabled,false),
    'mode',v_access_mode,
    'reason',case
      when not coalesce(v_runtime.enabled,false) then 'globally_disabled'
      when not coalesce(v_setting.enabled,false) then 'tenant_disabled'
      else null end,
    'billing',jsonb_build_object(
      'mode','shadow','billable',false,
      'softBudgetUnits',v_setting.shadow_soft_budget_units,
      'softBudgetEnforced',false
    ),
    'limits',jsonb_build_object(
      'maxInputChars',coalesce(v_runtime.max_input_chars,12000),
      'maxResponseChars',coalesce(v_runtime.max_response_chars,24000),
      'maxKnowledgeResults',coalesce(v_runtime.max_knowledge_results,6),
      'runsPerMinute',coalesce(v_setting.run_rate_limit_per_minute,12)
    ),
    'manager',jsonb_build_object(
      'allowed',v_manager_allowed,
      'globalEnabled',coalesce(v_runtime.manager_enabled,false),
      'enabled',coalesce(v_manager_setting.enabled,false),
      'available',v_manager_available,
      'reviewAvailable',v_manager_review_available,
      'reason',case
        when not v_manager_allowed then 'permission_required'
        when not v_available then 'odeiry_unavailable'
        when not coalesce(v_runtime.manager_enabled,false)
          then 'manager_globally_disabled'
        when not coalesce(v_manager_setting.enabled,false)
          then 'manager_disabled'
        else null end,
      'limits',jsonb_build_object(
        'analyticsReadsPerRun',2,
        'contextMemories',8,
        'maxApprovedMemoriesPerOwner',coalesce(
          v_manager_setting.max_approved_memories_per_owner,50
        ),
        'maxPendingMemoriesPerOwner',coalesce(
          v_manager_setting.max_pending_memories_per_owner,20
        )
      )
    )
  );
end;
$$;

revoke all on function public.v3_tenant_odeiry_snapshot(text)
from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_odeiry_snapshot(text)
to authenticated;

comment on function private_app.odeiry_manager_can_use(uuid) is
'Requires an active tenant membership and tenant.odeiry_manager.use in the exact tenant; platform-only preview remains denied.';

comment on function public.v3_tenant_odeiry_snapshot(text) is
'Tenant ODEIRY snapshot that treats dual platform/tenant users as tenant members only when exact tenant manager entitlement exists.';

commit;
