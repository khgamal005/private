-- ODEIR Social Connect V2: private, fail-closed OAuth control plane.
-- Additive only. This migration creates no tenant entitlement or rollout row
-- and never updates the legacy marketing_hub Meta connector.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('access_control.permissions') is null
     or to_regclass('access_control.roles') is null
     or to_regclass('access_control.role_permissions') is null
     or to_regclass('catalog.features') is null
     or to_regclass('catalog.addon_products') is null
     or to_regclass('catalog.addon_manifests') is null
     or to_regclass('marketing_hub.connections') is null
     or to_regclass('audit_log.events') is null
     or to_regclass('vault.secrets') is null
     or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     or to_regprocedure('private_app.set_updated_at()') is null
     or to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure('auth.uid()') is null
     or to_regprocedure('private_app.has_tenant_permission(uuid,text)') is null
     or to_regprocedure('private_app.tenant_addon_enabled(uuid,text)') is null then
    raise exception 'meta_connect_v2_missing_prerequisite';
  end if;
end;
$preflight$;

-------------------------------------------------------------------------------
-- 1. Private add-on catalog contract. No tenant subscription is created.
-------------------------------------------------------------------------------

insert into access_control.permissions (
  permission_key,module_key,name_ar,description
)
values
  (
    'tenant.meta_connect.read','marketing','عرض حالة الربط الاجتماعي',
    'عرض الحالة الصحية لربط قنوات الإعلانات والتواصل دون إظهار الأسرار'
  ),
  (
    'tenant.meta_connect.manage','marketing','إدارة الربط الاجتماعي',
    'بدء الربط الآمن وإعادة التفويض وفصل حسابات الربط الاجتماعي'
  )
on conflict (permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

insert into access_control.role_permissions (role_id,permission_key)
select distinct role.id,permission.permission_key
from access_control.roles role
cross join (
  values
    ('tenant.meta_connect.read'::text,'tenant.marketing.read'::text),
    ('tenant.meta_connect.manage'::text,'tenant.marketing.manage'::text)
) permission(permission_key,inherited_permission)
where role.scope='tenant'
  and (
    role.role_key in ('tenant_owner','tenant_admin')
    or exists (
      select 1
      from access_control.role_permissions granted
      where granted.role_id=role.id
        and granted.permission_key=permission.inherited_permission
    )
  )
on conflict do nothing;

insert into catalog.features (
  feature_key,name_ar,name_en,category,value_type,default_value,status
)
values (
  'addon.integrations.social_connect',
  'الربط الاجتماعي الموحد',
  'Social Connect',
  'addon',
  'boolean',
  'false'::jsonb,
  'beta'
)
on conflict (feature_key) do update
set name_ar=excluded.name_ar,
    name_en=excluded.name_en,
    category=excluded.category,
    value_type=excluded.value_type,
    default_value=excluded.default_value,
    status=excluded.status,
    updated_at=now();

insert into catalog.addon_products (
  product_key,feature_id,name_ar,name_en,description_ar,pricing_mode,
  amount_minor,currency,interval,trial_days,usage_metric,default_limit,
  status,sort_order,marketplace_category,badge_ar,activation_mode
)
select
  'social_connect',feature.id,'الربط الاجتماعي الموحد','Social Connect',
  'ربط إعلانات وحسابات التواصل بالمنشأة عبر تفويض آمن ومعزول لكل مستأجر.',
  'contact_sales',0,'SAR','month',0,'connected_assets',null,
  'draft',95,'integrations','خاص — تجريبي','entitlement'
from catalog.features feature
where feature.feature_key='addon.integrations.social_connect'
on conflict (product_key) do update
set feature_id=excluded.feature_id,
    name_ar=excluded.name_ar,
    name_en=excluded.name_en,
    description_ar=excluded.description_ar,
    pricing_mode=excluded.pricing_mode,
    amount_minor=excluded.amount_minor,
    currency=excluded.currency,
    interval=excluded.interval,
    trial_days=excluded.trial_days,
    usage_metric=excluded.usage_metric,
    default_limit=excluded.default_limit,
    status=excluded.status,
    sort_order=excluded.sort_order,
    marketplace_category=excluded.marketplace_category,
    badge_ar=excluded.badge_ar,
    activation_mode=excluded.activation_mode,
    updated_at=now();

insert into catalog.addon_manifests (
  product_id,manifest_version,contract_version,short_description_ar,
  long_description_ar,publisher_name,install_mode,data_policy,dependencies,
  required_permissions,configuration_schema,release_notes_ar,status,
  is_current,released_at
)
select
  product.id,'0.1.0-private',3,
  'نسخة خاصة لربط الحسابات عبر OAuth دون كشف رموز الوصول.',
  'طبقة تحكم مستقلة وآمنة للربط الاجتماعي؛ تبدأ مغلقة ولا تغيّر أي ربط قديم.',
  'Marktone','entitlement','preserve_on_disable','[]'::jsonb,
  array['tenant.meta_connect.read','tenant.meta_connect.manage']::text[],
  jsonb_build_object(
    '$schema','https://json-schema.org/draft/2020-12/schema',
    'type','object',
    'additionalProperties',false,
    'properties',jsonb_build_object()
  ),
  'مرحلة OAuth والامتثال فقط؛ لا تشمل إدارة الحملات أو ترحيل الربط القديم.',
  'draft',false,null
from catalog.addon_products product
where product.product_key='social_connect'
on conflict (product_id,manifest_version) do nothing;

-------------------------------------------------------------------------------
-- 2. Isolated storage. Browser roles receive no direct table access.
-------------------------------------------------------------------------------

create schema if not exists meta_connect_v2;
revoke all on schema meta_connect_v2 from public,anon,authenticated;

create table meta_connect_v2.rollout_targets (
  tenant_id uuid primary key references core.tenants(id) on delete restrict,
  status text not null default 'disabled'
    check (status in ('disabled','pilot')),
  capabilities text[] not null default '{}',
  approved_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(capabilities)<=12),
  check (capabilities <@ array[
    'oauth','deauthorization','data_deletion'
  ]::text[]),
  check ((status='pilot' and approved_at is not null)
      or (status='disabled'))
);

create table meta_connect_v2.kill_switches (
  capability text primary key
    check (capability in ('oauth','deauthorization','data_deletion')),
  enabled boolean not null default false,
  changed_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  changed_at timestamptz not null default now()
);

create table meta_connect_v2.oauth_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  actor_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  actor_auth_user_id uuid not null,
  state_sha256 text not null unique
    check (state_sha256 ~ '^[a-f0-9]{64}$'),
  return_path text not null,
  status text not null default 'pending'
    check (status in ('pending','consumed','finalized','failed')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (length(return_path) between 1 and 500),
  check (left(return_path,1)='/' and left(return_path,2)<>'//'),
  check (position(E'\\' in return_path)=0),
  check (return_path !~ '[[:cntrl:]]'),
  check (expires_at>created_at and expires_at<=created_at+interval '15 minutes'),
  check ((status='pending' and consumed_at is null)
      or (status<>'pending' and consumed_at is not null))
);

create table meta_connect_v2.connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references core.tenants(id) on delete cascade,
  external_user_id text,
  status text not null default 'connected'
    check (status in (
      'connected','reauth_required','deauthorized','deletion_requested',
      'disabled','error'
    )),
  granted_scopes text[] not null default '{}',
  token_expires_at timestamptz,
  data_access_expires_at timestamptz,
  connected_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  last_authorized_at timestamptz,
  last_error_code text check (
    last_error_code is null or length(last_error_code)<=120
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (external_user_id is null or length(external_user_id) between 1 and 120),
  check (cardinality(granted_scopes)<=40)
);

create table meta_connect_v2.credential_refs (
  connection_id uuid not null
    references meta_connect_v2.connections(id) on delete cascade,
  credential_type text not null check (credential_type='user_access_token'),
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  primary key (connection_id,credential_type)
);

create table meta_connect_v2.callback_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('deauthorization','data_deletion')),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  external_user_sha256 text not null
    check (external_user_sha256 ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz not null,
  status text not null default 'processed'
    check (status in ('processed','duplicate','failed')),
  affected_connections integer not null default 0
    check (affected_connections>=0),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (event_type,payload_sha256)
);

create table meta_connect_v2.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  callback_event_id uuid not null unique
    references meta_connect_v2.callback_events(id) on delete restrict,
  confirmation_sha256 text not null unique
    check (confirmation_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null
    check (status in ('completed','no_data','failed')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status in ('completed','no_data') and completed_at is not null)
      or status='failed')
);

create index oauth_transactions_tenant_created_idx
on meta_connect_v2.oauth_transactions (tenant_id,created_at desc);

create index connections_external_user_idx
on meta_connect_v2.connections (external_user_id)
where external_user_id is not null;

create index callback_events_received_idx
on meta_connect_v2.callback_events (received_at desc,id);

create index callback_events_user_issued_idx
on meta_connect_v2.callback_events (external_user_sha256,issued_at desc);

do $secure_tables$
declare
  v_table text;
begin
  foreach v_table in array array[
    'rollout_targets','kill_switches','oauth_transactions','connections',
    'credential_refs','callback_events','deletion_requests'
  ] loop
    execute format(
      'alter table meta_connect_v2.%I enable row level security',v_table
    );
    execute format(
      'alter table meta_connect_v2.%I force row level security',v_table
    );
    execute format(
      'revoke all on table meta_connect_v2.%I from public,anon,authenticated',
      v_table
    );
  end loop;
end;
$secure_tables$;

create trigger meta_connect_v2_rollout_targets_updated
before update on meta_connect_v2.rollout_targets
for each row execute function private_app.set_updated_at();

create trigger meta_connect_v2_connections_updated
before update on meta_connect_v2.connections
for each row execute function private_app.set_updated_at();

insert into meta_connect_v2.kill_switches (capability,enabled)
values
  ('oauth',false),
  ('deauthorization',false),
  ('data_deletion',false)
on conflict (capability) do nothing;

-------------------------------------------------------------------------------
-- 3. User entry points: snapshot, OAuth start, and disconnect.
-------------------------------------------------------------------------------

-- All control-plane writes take the same short transaction lock. This private
-- pilot has no network work inside SQL; serializing writes also covers the
-- first connection, where SELECT FOR UPDATE cannot lock an absent row.
create or replace function meta_connect_v2.assert_oauth_allowed(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
begin
  if auth.uid() is null or private_app.current_subject_id() is null then
    raise exception 'forbidden';
  end if;
  if not exists (
    select 1 from core.tenants tenant
    where tenant.id=p_tenant_id and tenant.status in ('trial','active')
  ) then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    p_tenant_id,'tenant.meta_connect.manage'
  ) then raise exception 'forbidden'; end if;
  if not private_app.tenant_addon_enabled(
    p_tenant_id,'addon.integrations.social_connect'
  ) then raise exception 'addon_not_enabled'; end if;
  if not exists (
    select 1 from meta_connect_v2.rollout_targets rollout
    where rollout.tenant_id=p_tenant_id and rollout.status='pilot'
      and rollout.capabilities @> array['oauth']::text[]
  ) then raise exception 'meta_connect_v2_not_in_rollout'; end if;
  if not coalesce((
    select switch.enabled from meta_connect_v2.kill_switches switch
    where switch.capability='oauth'
  ),false) then raise exception 'meta_connect_v2_oauth_disabled'; end if;
  if exists (
    select 1 from marketing_hub.connections legacy
    where legacy.tenant_id=p_tenant_id and legacy.provider_key='meta'
  ) then raise exception 'legacy_meta_connection_present'; end if;
end;
$$;
revoke all on function meta_connect_v2.assert_oauth_allowed(uuid)
from public,anon,authenticated,service_role;

create or replace function public.v1_tenant_meta_connect_v2_snapshot(
  p_tenant_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant_id uuid;
  v_connection meta_connect_v2.connections%rowtype;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug=p_tenant_slug
    and tenant.status in ('trial','active')
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not (
    private_app.has_tenant_permission(v_tenant_id,'tenant.meta_connect.read')
    or private_app.has_tenant_permission(v_tenant_id,'tenant.meta_connect.manage')
  ) then raise exception 'forbidden'; end if;

  select connection.* into v_connection
  from meta_connect_v2.connections connection
  where connection.tenant_id=v_tenant_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'addonEnabled',private_app.tenant_addon_enabled(
      v_tenant_id,'addon.integrations.social_connect'
    ),
    'rolloutEnabled',exists(
      select 1 from meta_connect_v2.rollout_targets rollout
      where rollout.tenant_id=v_tenant_id
        and rollout.status='pilot'
        and rollout.capabilities @> array['oauth']::text[]
    ),
    'oauthEnabled',coalesce((
      select switch.enabled from meta_connect_v2.kill_switches switch
      where switch.capability='oauth'
    ),false),
    'legacyProtected',exists(
      select 1 from marketing_hub.connections legacy
      where legacy.tenant_id=v_tenant_id and legacy.provider_key='meta'
    ),
    'status',case
      when v_connection.status='connected' and (
        v_connection.token_expires_at<=now()
        or v_connection.data_access_expires_at<=now()
      ) then 'reauth_required'
      else v_connection.status
    end,
    'grantedScopes',v_connection.granted_scopes,
    'tokenExpiresAt',v_connection.token_expires_at,
    'dataAccessExpiresAt',v_connection.data_access_expires_at,
    'lastAuthorizedAt',v_connection.last_authorized_at
  ));
end;
$$;

create or replace function public.v1_tenant_meta_connect_v2_begin_oauth(
  p_tenant_slug text,
  p_state_sha256 text,
  p_return_path text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant_id uuid;
  v_actor_subject_id uuid;
  v_transaction_id uuid;
  v_expires_at timestamptz:=now()+interval '10 minutes';
begin
  perform pg_advisory_xact_lock(hashtextextended('meta_connect_v2:control_plane',0));
  if coalesce(p_state_sha256,'') !~ '^[a-f0-9]{64}$'
     or coalesce(length(p_return_path),0) not between 1 and 500
     or left(p_return_path,1)<>'/' or left(p_return_path,2)='//'
     or position(E'\\' in p_return_path)>0
     or p_return_path ~ '[[:cntrl:]]' then
    raise exception 'invalid_oauth_request';
  end if;
  select tenant.id into v_tenant_id
  from core.tenants tenant where tenant.slug=p_tenant_slug;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  perform meta_connect_v2.assert_oauth_allowed(v_tenant_id);
  v_actor_subject_id:=private_app.current_subject_id();

  -- A newer explicit start supersedes an earlier tab or in-flight exchange.
  update meta_connect_v2.oauth_transactions
  set status='failed',consumed_at=coalesce(consumed_at,now())
  where tenant_id=v_tenant_id and status in ('pending','consumed');
  insert into meta_connect_v2.oauth_transactions (
    tenant_id,actor_subject_id,actor_auth_user_id,state_sha256,return_path,expires_at
  ) values (
    v_tenant_id,v_actor_subject_id,auth.uid(),p_state_sha256,p_return_path,v_expires_at
  ) returning id into v_transaction_id;
  perform private_app.write_audit(
    'meta_connect_v2.oauth_started','meta_connect_v2_oauth_transaction',
    v_transaction_id::text,v_tenant_id,
    jsonb_build_object('expiresAt',v_expires_at)
  );
  return jsonb_build_object('transactionId',v_transaction_id,'expiresAt',v_expires_at);
end;
$$;

create or replace function public.v1_tenant_meta_connect_v2_disconnect(
  p_tenant_slug text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant_id uuid;
  v_connection_id uuid;
  v_secret_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('meta_connect_v2:control_plane',0));
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug=p_tenant_slug
    and tenant.status in ('trial','active')
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,'tenant.meta_connect.manage'
  ) then raise exception 'forbidden'; end if;

  update meta_connect_v2.oauth_transactions
  set status='failed',consumed_at=coalesce(consumed_at,now())
  where tenant_id=v_tenant_id and status in ('pending','consumed');

  select connection.id,credential.vault_secret_id
  into v_connection_id,v_secret_id
  from meta_connect_v2.connections connection
  left join meta_connect_v2.credential_refs credential
    on credential.connection_id=connection.id
   and credential.credential_type='user_access_token'
  where connection.tenant_id=v_tenant_id
  for update of connection;

  if v_connection_id is null then
    return jsonb_build_object('status','not_connected');
  end if;

  delete from meta_connect_v2.credential_refs
  where connection_id=v_connection_id;
  if v_secret_id is not null then
    delete from vault.secrets where id=v_secret_id;
  end if;
  update meta_connect_v2.connections
  set status='disabled',granted_scopes='{}',token_expires_at=null,
      data_access_expires_at=null,last_error_code=null
  where id=v_connection_id;

  perform private_app.write_audit(
    'meta_connect_v2.disconnected','meta_connect_v2_connection',
    v_connection_id::text,v_tenant_id,
    jsonb_build_object('credentialRemoved',v_secret_id is not null)
  );
  return jsonb_build_object('status','disabled');
end;
$$;

-------------------------------------------------------------------------------
-- 4. Authenticated OAuth claim; service-only finalization and legal callbacks.
-------------------------------------------------------------------------------

create or replace function public.v1_tenant_meta_connect_v2_claim_oauth(
  p_state_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_transaction meta_connect_v2.oauth_transactions%rowtype;
  v_tenant_slug text;
begin
  perform pg_advisory_xact_lock(hashtextextended('meta_connect_v2:control_plane',0));
  if coalesce(p_state_sha256,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_oauth_state';
  end if;
  select transaction.* into v_transaction
  from meta_connect_v2.oauth_transactions transaction
  where transaction.state_sha256=p_state_sha256
    and transaction.status='pending' and transaction.expires_at>now()
  for update;
  if v_transaction.id is null then raise exception 'oauth_state_invalid_or_used'; end if;
  if auth.uid() is null
     or auth.uid() is distinct from v_transaction.actor_auth_user_id
     or private_app.current_subject_id() is distinct from v_transaction.actor_subject_id then
    raise exception 'forbidden';
  end if;
  perform meta_connect_v2.assert_oauth_allowed(v_transaction.tenant_id);
  update meta_connect_v2.oauth_transactions
  set status='consumed',consumed_at=now() where id=v_transaction.id;
  select tenant.slug into v_tenant_slug
  from core.tenants tenant where tenant.id=v_transaction.tenant_id;
  return jsonb_build_object(
    'transactionId',v_transaction.id,'tenantId',v_transaction.tenant_id,
    'tenantSlug',v_tenant_slug,'actorSubjectId',v_transaction.actor_subject_id,
    'returnPath',v_transaction.return_path
  );
end;
$$;

create or replace function public.v1_service_meta_connect_v2_finalize_oauth(
  p_transaction_id uuid,
  p_external_user_id text,
  p_external_user_sha256 text,
  p_access_token text,
  p_granted_scopes text[],
  p_token_expires_at timestamptz,
  p_data_access_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_transaction meta_connect_v2.oauth_transactions%rowtype;
  v_connection_id uuid;
  v_old_secret_id uuid;
  v_new_secret_id uuid;
  v_original_claims text:=current_setting('request.jwt.claims',true);
  v_original_sub text:=current_setting('request.jwt.claim.sub',true);
begin
  perform pg_advisory_xact_lock(hashtextextended('meta_connect_v2:control_plane',0));
  if coalesce(p_external_user_id,'') !~ '^[A-Za-z0-9_-]{1,120}$'
     or coalesce(p_external_user_sha256,'') !~ '^[a-f0-9]{64}$'
     or coalesce(length(p_access_token),0) not between 32 and 8192
     or not coalesce(p_granted_scopes,'{}') @> array['ads_read']::text[]
     or not coalesce(p_granted_scopes,'{}') <@ array['ads_read','public_profile','email']::text[]
     or array_position(p_granted_scopes,null) is not null
     or p_token_expires_at is null or p_token_expires_at<=now()
     or (p_data_access_expires_at is not null and p_data_access_expires_at<=now()) then
    raise exception 'invalid_meta_token_contract';
  end if;
  select transaction.* into v_transaction
  from meta_connect_v2.oauth_transactions transaction
  where transaction.id=p_transaction_id and transaction.status='consumed'
    and transaction.expires_at>now()
    and transaction.consumed_at>now()-interval '5 minutes'
  for update;
  if v_transaction.id is null then raise exception 'oauth_transaction_invalid'; end if;

  -- Re-evaluate today's authorization for the actor captured at authenticated
  -- start. Minimal server-owned claims, never user metadata or supplied claims.
  perform set_config('request.jwt.claim.sub',v_transaction.actor_auth_user_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',v_transaction.actor_auth_user_id,'role','authenticated'
  )::text,true);
  if private_app.current_subject_id() is distinct from v_transaction.actor_subject_id then
    raise exception 'forbidden';
  end if;
  perform meta_connect_v2.assert_oauth_allowed(v_transaction.tenant_id);
  perform set_config('request.jwt.claims',coalesce(v_original_claims,''),true);
  perform set_config('request.jwt.claim.sub',coalesce(v_original_sub,''),true);

  -- This also covers a callback received before the first connection exists.
  -- Meta times are whole seconds; same-second revocation wins conservatively.
  if exists (
    select 1 from meta_connect_v2.callback_events event
    where event.external_user_sha256=p_external_user_sha256
      and event.issued_at>=date_trunc('second',v_transaction.created_at)
  ) then raise exception 'oauth_authorization_revoked'; end if;

  select connection.id,credential.vault_secret_id
  into v_connection_id,v_old_secret_id
  from meta_connect_v2.connections connection
  left join meta_connect_v2.credential_refs credential
    on credential.connection_id=connection.id
   and credential.credential_type='user_access_token'
  where connection.tenant_id=v_transaction.tenant_id
  for update of connection;

  select vault.create_secret(
    p_access_token,
    'meta-connect-v2:'||v_transaction.tenant_id::text||':'||gen_random_uuid()::text,
    'ODEIR Meta Connect V2 encrypted user access token.',
    null
  ) into v_new_secret_id;

  if v_connection_id is null then
    insert into meta_connect_v2.connections (
      tenant_id,external_user_id,status,granted_scopes,token_expires_at,
      data_access_expires_at,connected_by_subject_id,last_authorized_at
    ) values (
      v_transaction.tenant_id,p_external_user_id,'connected',
      array(select distinct unnest(p_granted_scopes) order by 1),
      p_token_expires_at,p_data_access_expires_at,
      v_transaction.actor_subject_id,v_transaction.created_at
    ) returning id into v_connection_id;
  else
    update meta_connect_v2.connections
    set external_user_id=p_external_user_id,status='connected',
        granted_scopes=array(select distinct unnest(p_granted_scopes) order by 1),
        token_expires_at=p_token_expires_at,
        data_access_expires_at=p_data_access_expires_at,
        connected_by_subject_id=v_transaction.actor_subject_id,
        last_authorized_at=v_transaction.created_at,last_error_code=null
    where id=v_connection_id;
  end if;

  insert into meta_connect_v2.credential_refs (
    connection_id,credential_type,vault_secret_id,rotated_at
  ) values (
    v_connection_id,'user_access_token',v_new_secret_id,
    case when v_old_secret_id is null then null else now() end
  )
  on conflict (connection_id,credential_type) do update
  set vault_secret_id=excluded.vault_secret_id,rotated_at=now();

  if v_old_secret_id is not null and v_old_secret_id<>v_new_secret_id then
    delete from vault.secrets where id=v_old_secret_id;
  end if;

  insert into audit_log.events (
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_transaction.tenant_id,v_transaction.actor_subject_id,
    'meta_connect_v2.connected','meta_connect_v2_connection',
    v_connection_id::text,
    jsonb_build_object(
      'grantedScopes',array(select distinct unnest(p_granted_scopes) order by 1),
      'tokenExpiresAt',p_token_expires_at,
      'dataAccessExpiresAt',p_data_access_expires_at,
      'secretReturned',false
    )
  );
  update meta_connect_v2.oauth_transactions
  set status='finalized' where id=v_transaction.id;
  return jsonb_build_object('status','connected','secretReturned',false);
exception when others then
  if v_new_secret_id is not null then
    delete from vault.secrets where id=v_new_secret_id;
  end if;
  raise;
end;
$$;

create or replace function public.v1_service_meta_connect_v2_process_callback(
  p_event_type text,
  p_external_user_id text,
  p_external_user_sha256 text,
  p_payload_sha256 text,
  p_issued_at timestamptz,
  p_confirmation_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event_id uuid;
  v_affected integer:=0;
  v_connection_ids uuid[]:='{}';
  v_secret_ids uuid[]:='{}';
  v_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended('meta_connect_v2:control_plane',0));
  if coalesce(p_event_type,'') not in ('deauthorization','data_deletion')
     or coalesce(p_external_user_id,'') !~ '^[A-Za-z0-9_-]{1,120}$'
     or coalesce(p_external_user_sha256,'') !~ '^[a-f0-9]{64}$'
     or coalesce(p_payload_sha256,'') !~ '^[a-f0-9]{64}$'
     or p_issued_at is null or p_issued_at>now()+interval '60 seconds'
     or (p_event_type='data_deletion'
       and coalesce(p_confirmation_sha256,'') !~ '^[a-f0-9]{64}$') then
    raise exception 'invalid_callback_contract';
  end if;
  if not coalesce((
    select switch.enabled from meta_connect_v2.kill_switches switch
    where switch.capability=p_event_type
  ),false) then raise exception 'meta_connect_v2_callback_disabled'; end if;

  insert into meta_connect_v2.callback_events (
    event_type,payload_sha256,external_user_sha256,issued_at,status
  ) values (
    p_event_type,p_payload_sha256,p_external_user_sha256,p_issued_at,'processed'
  )
  on conflict (event_type,payload_sha256) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    select request.status into v_status
    from meta_connect_v2.deletion_requests request
    join meta_connect_v2.callback_events event on event.id=request.callback_event_id
    where event.event_type=p_event_type and event.payload_sha256=p_payload_sha256;
    return jsonb_build_object(
      'status',coalesce(v_status,'duplicate'),'affectedConnections',0
    );
  end if;

  select
    coalesce(array_agg(distinct connection.id),'{}'),
    coalesce(array_agg(credential.vault_secret_id)
      filter (where credential.vault_secret_id is not null),'{}')
  into v_connection_ids,v_secret_ids
  from meta_connect_v2.connections connection
  left join meta_connect_v2.credential_refs credential
    on credential.connection_id=connection.id
  where connection.external_user_id=p_external_user_id
    and (connection.last_authorized_at is null
      or date_trunc('second',connection.last_authorized_at)<=p_issued_at);

  -- Do not let an already-started exchange restore a revoked credential.
  update meta_connect_v2.oauth_transactions transaction
  set status='failed',consumed_at=coalesce(transaction.consumed_at,now())
  where transaction.status in ('pending','consumed')
    and date_trunc('second',transaction.created_at)<=p_issued_at
    and transaction.tenant_id in (
      select connection.tenant_id from meta_connect_v2.connections connection
      where connection.id=any(v_connection_ids)
    );

  delete from meta_connect_v2.credential_refs credential
  where credential.connection_id=any(v_connection_ids);
  if cardinality(v_secret_ids)>0 then
    delete from vault.secrets where id=any(v_secret_ids);
  end if;

  if p_event_type='data_deletion' then
    update meta_connect_v2.connections
    set status='deletion_requested',external_user_id=null,
        granted_scopes='{}',token_expires_at=null,
        data_access_expires_at=null,last_error_code=null
    where id=any(v_connection_ids);
  else
    update meta_connect_v2.connections
    set status='deauthorized',granted_scopes='{}',token_expires_at=null,
        data_access_expires_at=null,last_error_code=null
    where id=any(v_connection_ids);
  end if;
  get diagnostics v_affected=row_count;

  update meta_connect_v2.callback_events
  set affected_connections=v_affected,processed_at=now()
  where id=v_event_id;

  if p_event_type='data_deletion' then
    v_status:=case when v_affected>0 then 'completed' else 'no_data' end;
    insert into meta_connect_v2.deletion_requests (
      callback_event_id,confirmation_sha256,status,completed_at
    ) values (v_event_id,p_confirmation_sha256,v_status,now());
  else
    v_status:='processed';
  end if;

  insert into audit_log.events (
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  )
  select connection.tenant_id,null,
    'meta_connect_v2.'||p_event_type,
    'meta_connect_v2_connection',connection.id::text,
    jsonb_build_object(
      'callbackEventId',v_event_id,
      'credentialRemoved',true,
      'personalIdentifierRemoved',p_event_type='data_deletion'
    )
  from meta_connect_v2.connections connection
  where connection.id=any(v_connection_ids);

  return jsonb_build_object(
    'status',v_status,'affectedConnections',v_affected
  );
end;
$$;

create or replace function public.v1_service_meta_connect_v2_deletion_status(
  p_confirmation_sha256 text
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select coalesce((
    select jsonb_build_object(
      'status',request.status,
      'requestedAt',request.requested_at,
      'completedAt',request.completed_at
    )
    from meta_connect_v2.deletion_requests request
    where request.confirmation_sha256=p_confirmation_sha256
  ),jsonb_build_object('status','not_found'));
$$;

-------------------------------------------------------------------------------
-- 5. Explicit grants. Service functions cannot be reached by browser roles.
-------------------------------------------------------------------------------

revoke execute on function public.v1_tenant_meta_connect_v2_snapshot(text)
from public,anon,authenticated;
revoke execute on function public.v1_tenant_meta_connect_v2_begin_oauth(
  text,text,text
) from public,anon,authenticated;
revoke execute on function public.v1_tenant_meta_connect_v2_disconnect(text)
from public,anon,authenticated;

grant execute on function public.v1_tenant_meta_connect_v2_snapshot(text)
to authenticated;
grant execute on function public.v1_tenant_meta_connect_v2_begin_oauth(
  text,text,text
) to authenticated;
grant execute on function public.v1_tenant_meta_connect_v2_disconnect(text)
to authenticated;

revoke execute on function public.v1_tenant_meta_connect_v2_claim_oauth(text)
from public,anon,authenticated;
revoke execute on function public.v1_service_meta_connect_v2_finalize_oauth(
  uuid,text,text,text,text[],timestamptz,timestamptz
) from public,anon,authenticated;
revoke execute on function public.v1_service_meta_connect_v2_process_callback(
  text,text,text,text,timestamptz,text
) from public,anon,authenticated;
revoke execute on function public.v1_service_meta_connect_v2_deletion_status(text)
from public,anon,authenticated;

grant execute on function public.v1_tenant_meta_connect_v2_claim_oauth(text)
to authenticated;
grant execute on function public.v1_service_meta_connect_v2_finalize_oauth(
  uuid,text,text,text,text[],timestamptz,timestamptz
) to service_role;
grant execute on function public.v1_service_meta_connect_v2_process_callback(
  text,text,text,text,timestamptz,text
) to service_role;
grant execute on function public.v1_service_meta_connect_v2_deletion_status(text)
to service_role;

comment on schema meta_connect_v2 is
'Private fail-closed ODEIR Social Connect V2 control plane; never exposed through the Data API.';
comment on table meta_connect_v2.credential_refs is
'Vault references only. Plaintext provider credentials are forbidden.';
comment on table meta_connect_v2.callback_events is
'Idempotent compliance callback journal. Raw signed requests are never stored.';

commit;
