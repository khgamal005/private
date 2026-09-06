-- Isolated local PostgreSQL fixture. Vault is a test double with fake values;
-- these stubs do not replace a production schema or exercise Vault encryption.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema core;
create schema access_control;
create schema catalog;
create schema marketing_hub;
create schema audit_log;
create schema vault;
create schema private_app;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$$;
create table core.tenants(id uuid primary key,slug text unique,status text);
create table access_control.subjects(
  id uuid primary key,auth_user_id uuid,status text,must_change_password boolean default false
);
create table access_control.permissions(
  permission_key text primary key,module_key text,name_ar text,description text
);
create table access_control.roles(id uuid primary key,role_key text,scope text);
create table access_control.role_permissions(
  role_id uuid,permission_key text,primary key(role_id,permission_key)
);
create table access_control.tenant_memberships(
  id uuid primary key,tenant_id uuid,subject_id uuid,status text
);
create table access_control.membership_roles(membership_id uuid,role_id uuid);
create table private_app.test_entitlements(tenant_id uuid primary key,enabled boolean);
create function private_app.current_subject_id() returns uuid language sql stable as $$
  select s.id from access_control.subjects s
  where auth.uid() is not null and s.auth_user_id=auth.uid() and s.status='active' limit 1;
$$;
create function private_app.has_tenant_permission(p_tenant_id uuid,p_permission text)
returns boolean language sql stable as $$
  select auth.uid() is not null and exists (
    select 1 from access_control.subjects s
    join access_control.tenant_memberships m on m.subject_id=s.id
    join access_control.membership_roles mr on mr.membership_id=m.id
    join access_control.roles r on r.id=mr.role_id
    join access_control.role_permissions rp on rp.role_id=r.id
    join core.tenants t on t.id=m.tenant_id
    where s.auth_user_id=auth.uid() and s.status='active' and not s.must_change_password
      and m.status='active' and m.tenant_id=p_tenant_id and r.scope='tenant'
      and t.status in ('trial','active') and rp.permission_key=p_permission
  );
$$;
create function private_app.tenant_addon_enabled(p_tenant_id uuid,p_feature text)
returns boolean language sql stable as $$
  select p_feature='addon.integrations.social_connect' and coalesce((
    select enabled from private_app.test_entitlements where tenant_id=p_tenant_id
  ),false);
$$;
create function private_app.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at=now();return new;end;$$;
create table catalog.features(
  id uuid primary key default gen_random_uuid(),feature_key text unique,name_ar text,
  name_en text,category text,value_type text,default_value jsonb,status text,updated_at timestamptz
);
create table catalog.addon_products(
  id uuid primary key default gen_random_uuid(),product_key text unique,feature_id uuid,
  name_ar text,name_en text,description_ar text,pricing_mode text,amount_minor bigint,
  currency text,interval text,trial_days integer,usage_metric text,default_limit bigint,
  status text,sort_order integer,marketplace_category text,badge_ar text,activation_mode text,
  updated_at timestamptz
);
create table catalog.addon_manifests(
  product_id uuid,manifest_version text,contract_version integer,short_description_ar text,
  long_description_ar text,publisher_name text,install_mode text,data_policy text,
  dependencies jsonb,required_permissions text[],configuration_schema jsonb,
  release_notes_ar text,status text,is_current boolean,released_at timestamptz,
  unique(product_id,manifest_version)
);
create table marketing_hub.connections(
  id uuid primary key default gen_random_uuid(),tenant_id uuid,provider_key text,status text,
  unique(tenant_id,provider_key)
);
create table audit_log.events(
  id uuid primary key default gen_random_uuid(),tenant_id uuid,actor_subject_id uuid,
  action text,resource_type text,resource_id text,context jsonb
);
create function private_app.write_audit(text,text,text,uuid,jsonb) returns void language sql as $$
  insert into audit_log.events(action,resource_type,resource_id,tenant_id,context)
  values($1,$2,$3,$4,$5);
$$;
create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text,name text);
create function vault.create_secret(text,text,text,uuid) returns uuid language plpgsql as $$
declare result uuid;begin
  insert into vault.secrets(secret,name) values($1,$2) returning id into result;
  return result;
end;$$;
insert into core.tenants values
  ('10000000-0000-0000-0000-000000000001','demo','active'),
  ('10000000-0000-0000-0000-000000000002','other','active'),
  ('10000000-0000-0000-0000-000000000003','legacy-fixture','active');
insert into access_control.subjects(id,auth_user_id,status) values
  ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','active'),
  ('20000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002','active');
insert into access_control.roles values
  ('40000000-0000-0000-0000-000000000001','tenant_owner','tenant');
insert into access_control.tenant_memberships values
  ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','active'),
  ('50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','active'),
  ('50000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','active');
insert into access_control.membership_roles select id,'40000000-0000-0000-0000-000000000001'
from access_control.tenant_memberships;
insert into private_app.test_entitlements select id,true from core.tenants;
insert into marketing_hub.connections(tenant_id,provider_key,status)
values('10000000-0000-0000-0000-000000000003','meta','reauth_required');
