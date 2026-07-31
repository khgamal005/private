-- Applied migration version: 20260731123000
begin;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values (
  'tenant.integrations.manage',
  'people',
  'إدارة المزامنة والترابط',
  'ربط المتاجر وإدارة مفاتيحها واختبار الاتصال وتشغيل المزامنة.'
)
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.role_permissions (
  role_id,
  permission_key
)
select
  role.id,
  'tenant.integrations.manage'
from access_control.roles role
where role.scope = 'tenant'
  and role.role_key in ('tenant_owner', 'tenant_admin')
on conflict (role_id, permission_key) do nothing;

do $$
declare
  v_provider_count integer;
begin
  if to_regnamespace('commerce_hub') is null then
    raise exception 'commerce_hub_schema_missing';
  end if;

  if to_regprocedure(
    'public.v2_tenant_commerce_hub_snapshot(text)'
  ) is null then
    raise exception 'commerce_hub_snapshot_missing';
  end if;

  if to_regprocedure(
    'public.v2_tenant_commerce_hub_action(text,text,text,jsonb)'
  ) is null then
    raise exception 'commerce_hub_action_missing';
  end if;

  select count(*)
  into v_provider_count
  from commerce_hub.providers provider
  where provider.provider_key in (
    'woocommerce',
    'salla',
    'zid',
    'shopify',
    'custom'
  )
    and provider.status <> 'disabled';

  if v_provider_count <> 5 then
    raise exception 'commerce_hub_provider_catalog_incomplete:%',
      v_provider_count;
  end if;
end;
$$;

commit;
