begin;

create or replace function public.v1_tenant_lead_reassignment_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_is_data_officer boolean;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.leads.read'
  ) then
    raise exception 'forbidden';
  end if;

  select exists (
    select 1
    from access_control.subjects subject
    join access_control.memberships membership
      on membership.subject_id = subject.id
     and membership.tenant_id = v_tenant_id
     and membership.scope = 'tenant'
     and membership.status = 'active'
    join access_control.membership_roles membership_role
      on membership_role.membership_id = membership.id
    join access_control.roles role
      on role.id = membership_role.role_id
     and role.scope = 'tenant'
     and role.role_key = 'data_officer'
    where subject.auth_user_id = auth.uid()
      and subject.status = 'active'
      and not subject.must_change_password
  ) into v_is_data_officer;

  return jsonb_build_object(
    'schemaVersion', 'lead-reassignment-v1',
    'viewer', jsonb_build_object(
      'isDataOfficer', v_is_data_officer,
      'canReassign', private_app.has_tenant_permission(
        v_tenant_id,
        'tenant.leads.reassign'
      )
    )
  );
end;
$$;

revoke all on function public.v1_tenant_lead_reassignment_snapshot(text)
from public, anon, authenticated;

grant execute on function public.v1_tenant_lead_reassignment_snapshot(text)
to authenticated, service_role;

comment on function public.v1_tenant_lead_reassignment_snapshot(text) is
'Returns explicit data-officer screen identity and server-authorized reassignment capability.';

notify pgrst, 'reload schema';

commit;
