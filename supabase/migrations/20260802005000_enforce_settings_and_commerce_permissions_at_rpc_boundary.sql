alter function public.v2_tenant_access_snapshot(text)
  rename to v2_tenant_access_snapshot_unchecked;

revoke all on function public.v2_tenant_access_snapshot_unchecked(text)
  from public, anon, authenticated;

create function public.v2_tenant_access_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
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
    'tenant.users.manage'
  ) then
    raise exception 'forbidden';
  end if;

  return public.v2_tenant_access_snapshot_unchecked(p_slug);
end;
$$;

revoke all on function public.v2_tenant_access_snapshot(text) from public, anon;
grant execute on function public.v2_tenant_access_snapshot(text) to authenticated, service_role;

alter function public.v2_tenant_commerce_hub_snapshot(text)
  rename to v2_tenant_commerce_hub_snapshot_unchecked;

revoke all on function public.v2_tenant_commerce_hub_snapshot_unchecked(text)
  from public, anon, authenticated;

create function public.v2_tenant_commerce_hub_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.can_manage_commerce_hub(v_tenant_id) then
    raise exception 'forbidden';
  end if;

  return public.v2_tenant_commerce_hub_snapshot_unchecked(p_slug);
end;
$$;

revoke all on function public.v2_tenant_commerce_hub_snapshot(text) from public, anon;
grant execute on function public.v2_tenant_commerce_hub_snapshot(text) to authenticated, service_role;
