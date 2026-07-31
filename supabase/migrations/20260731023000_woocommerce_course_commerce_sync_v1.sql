-- Applied migration version: 20260731023000
begin;

create schema if not exists commerce_sync;

revoke all on schema commerce_sync
from public, anon, authenticated;

alter table academy.courses
  add column regular_price_minor bigint
    check (regular_price_minor is null or regular_price_minor >= 0),
  add column sale_price_minor bigint
    check (sale_price_minor is null or sale_price_minor >= 0),
  add column sale_starts_at timestamptz,
  add column sale_ends_at timestamptz,
  add column currency_minor_digits smallint not null default 2
    check (currency_minor_digits between 0 and 4),
  add column external_source text
    check (
      external_source is null
      or external_source ~ '^[a-z][a-z0-9_-]{1,40}$'
    ),
  add column external_id text,
  add column external_url text,
  add column external_updated_at timestamptz,
  add column primary_image_url text,
  add column gallery_urls text[] not null default '{}'::text[],
  add column stock_status text
    check (
      stock_status is null
      or stock_status in ('instock', 'outofstock', 'onbackorder')
    ),
  add column stock_quantity numeric(14,3)
    check (stock_quantity is null or stock_quantity >= 0),
  add column product_type text,
  add column "virtual" boolean not null default false,
  add column downloadable boolean not null default false,
  add constraint academy_courses_sale_period_check
    check (
      sale_ends_at is null
      or sale_starts_at is null
      or sale_ends_at > sale_starts_at
    ),
  add constraint academy_courses_external_identity_check
    check (
      (external_source is null and external_id is null)
      or
      (
        external_source is not null
        and nullif(trim(external_id), '') is not null
      )
    );

create unique index academy_courses_external_identity_idx
on academy.courses (tenant_id, external_source, external_id)
where external_source is not null and external_id is not null;

create index academy_courses_woocommerce_status_idx
on academy.courses (tenant_id, status, external_updated_at desc)
where external_source = 'woocommerce';

create table commerce_sync.connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  store_url text not null
    check (
      store_url ~* '^https://[^[:space:]@?#]+(?:/[^[:space:]?#]*)?$'
    ),
  status text not null default 'draft'
    check (
      status in ('draft', 'active', 'degraded', 'error', 'disabled')
    ),
  frequency text not null default 'weekly'
    check (frequency in ('manual', 'daily', 'weekly', 'monthly')),
  match_by_sku boolean not null default false,
  sync_scope text[] not null default array[
    'products',
    'categories',
    'attributes',
    'attribute_terms',
    'variations',
    'coupons'
  ]::text[]
    check (
      cardinality(sync_scope) > 0
      and sync_scope <@ array[
        'products',
        'categories',
        'attributes',
        'attribute_terms',
        'variations',
        'coupons',
        'orders',
        'customers'
      ]::text[]
    ),
  secret_refs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(secret_refs) = 'object'),
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_error text,
  remote_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(remote_metadata) = 'object'),
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create index commerce_connections_due_idx
on commerce_sync.connections (status, next_sync_at)
where status in ('active', 'degraded');

create index commerce_connections_creator_reference_idx
on commerce_sync.connections (created_by_subject_id)
where created_by_subject_id is not null;

create index commerce_connections_updater_reference_idx
on commerce_sync.connections (updated_by_subject_id)
where updated_by_subject_id is not null;

create table commerce_sync.sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references commerce_sync.connections(id) on delete cascade,
  trigger_type text not null
    check (trigger_type in ('manual', 'scheduled')),
  scope text[] not null
    check (
      cardinality(scope) > 0
      and scope <@ array[
        'products',
        'categories',
        'attributes',
        'attribute_terms',
        'variations',
        'coupons',
        'orders',
        'customers'
      ]::text[]
    ),
  idempotency_key text not null,
  status text not null default 'running'
    check (status in ('running', 'success', 'partial', 'failed')),
  current_cursor jsonb not null default '{}'::jsonb,
  has_more boolean not null default true,
  fetched_count bigint not null default 0
    check (fetched_count >= 0),
  stored_count bigint not null default 0
    check (stored_count >= 0),
  created_count bigint not null default 0
    check (created_count >= 0),
  updated_count bigint not null default 0
    check (updated_count >= 0),
  archived_count bigint not null default 0
    check (archived_count >= 0),
  failed_count bigint not null default 0
    check (failed_count >= 0),
  stats jsonb not null default '{}'::jsonb
    check (jsonb_typeof(stats) = 'object'),
  error_detail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, idempotency_key)
);

create index commerce_sync_runs_connection_time_idx
on commerce_sync.sync_runs (connection_id, started_at desc);

create index commerce_sync_runs_tenant_time_idx
on commerce_sync.sync_runs (tenant_id, started_at desc);

create index commerce_sync_runs_running_idx
on commerce_sync.sync_runs (connection_id, started_at)
where status = 'running';

create table commerce_sync.external_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references commerce_sync.connections(id) on delete cascade,
  entity_type text not null
    check (
      entity_type in (
        'products',
        'categories',
        'attributes',
        'attribute_terms',
        'variations',
        'coupons',
        'orders',
        'customers'
      )
    ),
  external_id text not null
    check (nullif(trim(external_id), '') is not null),
  external_parent_id text,
  local_course_id uuid
    references academy.courses(id) on delete set null,
  raw_payload jsonb not null,
  remote_updated_at timestamptz,
  remote_hash text,
  sync_state text not null default 'active'
    check (sync_state in ('active', 'archived', 'error')),
  last_seen_run_id uuid
    references commerce_sync.sync_runs(id) on delete set null,
  last_synced_at timestamptz not null default now(),
  archived_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, entity_type, external_id),
  check (
    (sync_state = 'archived' and archived_at is not null)
    or sync_state <> 'archived'
  )
);

create index commerce_external_entities_tenant_type_idx
on commerce_sync.external_entities (
  tenant_id,
  entity_type,
  remote_updated_at desc
);

create index commerce_external_entities_connection_state_idx
on commerce_sync.external_entities (
  connection_id,
  entity_type,
  sync_state
);

create unique index commerce_external_entities_local_course_idx
on commerce_sync.external_entities (
  connection_id,
  entity_type,
  local_course_id
)
where entity_type = 'products' and local_course_id is not null;

create index commerce_external_entities_run_reference_idx
on commerce_sync.external_entities (last_seen_run_id)
where last_seen_run_id is not null;

create trigger commerce_connections_set_updated_at
before update on commerce_sync.connections
for each row execute function private_app.set_updated_at();

create trigger commerce_sync_runs_set_updated_at
before update on commerce_sync.sync_runs
for each row execute function private_app.set_updated_at();

create trigger commerce_external_entities_set_updated_at
before update on commerce_sync.external_entities
for each row execute function private_app.set_updated_at();

alter table commerce_sync.connections enable row level security;
alter table commerce_sync.sync_runs enable row level security;
alter table commerce_sync.external_entities enable row level security;

create or replace function private_app.can_manage_woocommerce(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.write')
    or exists (
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id = subject.id
       and membership.scope = 'tenant'
       and membership.status = 'active'
      join access_control.membership_roles membership_role
        on membership_role.membership_id = membership.id
      join access_control.roles role
        on role.id = membership_role.role_id
       and role.scope = 'tenant'
      join access_control.role_permissions role_permission
        on role_permission.role_id = role.id
      where subject.auth_user_id = auth.uid()
        and subject.status = 'active'
        and not subject.must_change_password
        and membership.tenant_id = p_tenant_id
        and role_permission.permission_key =
          'tenant.integrations.manage'
    )
  );
$$;

revoke all on function private_app.can_manage_woocommerce(uuid)
from public, anon, authenticated;

create policy commerce_connections_manage_read
on commerce_sync.connections
for select
to authenticated
using (
  private_app.can_manage_woocommerce(tenant_id)
);

create policy commerce_sync_runs_academy_read
on commerce_sync.sync_runs
for select
to authenticated
using (
  private_app.has_tenant_permission(tenant_id, 'tenant.academy.read')
  or private_app.can_manage_woocommerce(tenant_id)
);

create policy commerce_external_entities_academy_read
on commerce_sync.external_entities
for select
to authenticated
using (
  private_app.can_manage_woocommerce(tenant_id)
);

revoke all on all tables in schema commerce_sync
from public, anon, authenticated;

revoke all on all sequences in schema commerce_sync
from public, anon, authenticated;

alter default privileges in schema commerce_sync
revoke all on tables from public, anon, authenticated;

alter default privileges in schema commerce_sync
revoke all on sequences from public, anon, authenticated;

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
values (
  'addon.integration.woocommerce',
  'ربط WooCommerce',
  'WooCommerce Integration',
  'addon',
  'boolean',
  'false'::jsonb,
  'beta'
)
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    status = excluded.status,
    updated_at = now();

insert into catalog.plan_features (
  plan_id,
  feature_id,
  value
)
select
  plan.id,
  feature.id,
  'true'::jsonb
from catalog.plans plan
join catalog.features feature
  on feature.feature_key = 'addon.integration.woocommerce'
where plan.plan_key = 'full'
on conflict (plan_id, feature_id) do update
set value = excluded.value,
    updated_at = now();

insert into catalog.addon_products (
  product_key,
  feature_id,
  name_ar,
  name_en,
  description_ar,
  pricing_mode,
  amount_minor,
  currency,
  interval,
  trial_days,
  usage_metric,
  default_limit,
  status,
  sort_order
)
select
  'woocommerce',
  feature.id,
  'إضافة WooCommerce',
  'WooCommerce Add-on',
  'مزامنة متجر البرامج والدورات والأسعار والعروض مع WooCommerce.',
  'contact_sales',
  0,
  'SAR',
  'month',
  14,
  'woocommerce_sync_entities',
  null,
  'beta',
  80
from catalog.features feature
where feature.feature_key = 'addon.integration.woocommerce'
on conflict (product_key) do update
set feature_id = excluded.feature_id,
    name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description_ar = excluded.description_ar,
    usage_metric = excluded.usage_metric,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function private_app.woocommerce_store_url(
  p_store_url text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_url text;
begin
  v_url := regexp_replace(trim(coalesce(p_store_url, '')), '/+$', '');

  if length(v_url) not between 12 and 2048
     or v_url !~* '^https://[^[:space:]@?#]+(?:/[^[:space:]?#]*)?$'
     or v_url ~ '[\\]'
     or v_url ~* '^https://(localhost|localhost\.|[^/]+\.localhost)(:|/|$)'
     or v_url ~* '^https://(0\.|10\.|127\.|169\.254\.|192\.168\.)([0-9.]*)(:|/|$)'
     or v_url ~* '^https://172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+(:|/|$)'
     or v_url ~* '^https://100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9.]+(:|/|$)'
     or v_url ~* '^https://\[(::1|f[cd][0-9a-f:]*|fe8[0-9a-f:]*)(\]|:)'
     or v_url ~* '^https://[^/]+\.(local|internal)(:|/|$)' then
    raise exception 'woocommerce_public_https_url_required';
  end if;

  return v_url;
end;
$$;

create or replace function private_app.woocommerce_sync_scope(
  p_scope jsonb
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_scope text[];
begin
  if p_scope is null or jsonb_typeof(p_scope) <> 'array' then
    raise exception 'woocommerce_invalid_sync_scope';
  end if;

  select coalesce(
    array_agg(normalized.scope_value order by normalized.scope_value),
    '{}'::text[]
  )
  into v_scope
  from (
    select distinct lower(trim(item.value)) as scope_value
    from jsonb_array_elements_text(p_scope) item(value)
    where nullif(trim(item.value), '') is not null
  ) normalized;

  if cardinality(v_scope) = 0
     or not (
       v_scope <@ array[
         'products',
         'categories',
         'attributes',
         'attribute_terms',
         'variations',
         'coupons',
         'orders',
         'customers'
       ]::text[]
     ) then
    raise exception 'woocommerce_invalid_sync_scope';
  end if;

  return v_scope;
end;
$$;

create or replace function private_app.woocommerce_try_timestamptz(
  p_value text
)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(trim(p_value), '') is null then return null; end if;
  return p_value::timestamptz;
exception
  when invalid_datetime_format or datetime_field_overflow then
    return null;
end;
$$;

create or replace function private_app.woocommerce_try_bigint(
  p_value text
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(trim(p_value), '') !~ '^[0-9]+$' then return null; end if;
  return p_value::bigint;
exception
  when numeric_value_out_of_range then
    return null;
end;
$$;

create or replace function private_app.woocommerce_try_numeric(
  p_value text
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(trim(p_value), '') !~ '^[0-9]+([.][0-9]+)?$' then
    return null;
  end if;
  return p_value::numeric;
exception
  when numeric_value_out_of_range then
    return null;
end;
$$;

create or replace function private_app.woocommerce_next_sync(
  p_frequency text,
  p_from timestamptz
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'daily' then p_from + interval '1 day'
    when 'weekly' then p_from + interval '7 days'
    when 'monthly' then p_from + interval '1 month'
    else null
  end;
$$;

revoke all on function private_app.woocommerce_store_url(text)
from public, anon, authenticated;
revoke all on function private_app.woocommerce_sync_scope(jsonb)
from public, anon, authenticated;
revoke all on function private_app.woocommerce_try_timestamptz(text)
from public, anon, authenticated;
revoke all on function private_app.woocommerce_try_bigint(text)
from public, anon, authenticated;
revoke all on function private_app.woocommerce_try_numeric(text)
from public, anon, authenticated;
revoke all on function private_app.woocommerce_next_sync(text, timestamptz)
from public, anon, authenticated;

create or replace function public.v2_tenant_woocommerce_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection commerce_sync.connections%rowtype;
  v_last_run commerce_sync.sync_runs%rowtype;
  v_can_manage boolean;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.academy.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_can_manage := private_app.can_manage_woocommerce(v_tenant.id);

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.tenant_id = v_tenant.id
  limit 1;

  if v_connection.id is not null then
    select *
    into v_last_run
    from commerce_sync.sync_runs run
    where run.connection_id = v_connection.id
    order by run.started_at desc
    limit 1;
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'tenantId', v_tenant.id,
    'canManage', v_can_manage,
    'featureEnabled', private_app.tenant_addon_enabled(
      v_tenant.id,
      'addon.integration.woocommerce'
    ),
    'configured', v_connection.id is not null,
    'connection',
      case
        when v_connection.id is null then null
        else jsonb_build_object(
          'connectionId', v_connection.id,
          'storeUrl', v_connection.store_url,
          'status', v_connection.status,
          'frequency', v_connection.frequency,
          'syncFrequency', v_connection.frequency,
          'matchBySku', v_connection.match_by_sku,
          'syncScope', to_jsonb(v_connection.sync_scope),
          'configuredSecrets', (
            select coalesce(
              jsonb_agg(secret.key order by secret.key),
              '[]'::jsonb
            )
            from jsonb_each_text(v_connection.secret_refs) secret
          ),
          'lastCheckedAt', v_connection.last_checked_at,
          'lastSyncedAt', v_connection.last_synced_at,
          'nextSyncAt', v_connection.next_sync_at,
          'lastError', v_connection.last_error,
          'remoteMetadata', v_connection.remote_metadata
        )
      end,
    'counts', jsonb_build_object(
      'products', coalesce((
        select count(*)
        from commerce_sync.external_entities entity
        where entity.connection_id = v_connection.id
          and entity.entity_type = 'products'
          and entity.sync_state <> 'archived'
      ), 0),
      'courses', coalesce((
        select count(*)
        from commerce_sync.external_entities entity
        where entity.connection_id = v_connection.id
          and entity.entity_type = 'products'
          and entity.local_course_id is not null
          and entity.sync_state <> 'archived'
      ), 0),
      'coupons', coalesce((
        select count(*)
        from commerce_sync.external_entities entity
        where entity.connection_id = v_connection.id
          and entity.entity_type = 'coupons'
          and entity.sync_state <> 'archived'
      ), 0),
      'orders', coalesce((
        select count(*)
        from commerce_sync.external_entities entity
        where entity.connection_id = v_connection.id
          and entity.entity_type = 'orders'
          and entity.sync_state <> 'archived'
      ), 0),
      'customers', coalesce((
        select count(*)
        from commerce_sync.external_entities entity
        where entity.connection_id = v_connection.id
          and entity.entity_type = 'customers'
          and entity.sync_state <> 'archived'
      ), 0)
    ),
    'recentRuns', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'runId', recent.id,
          'trigger', recent.trigger_type,
          'scope', to_jsonb(recent.scope),
          'status', recent.status,
          'fetchedCount', recent.fetched_count,
          'storedCount', recent.stored_count,
          'createdCount', recent.created_count,
          'updatedCount', recent.updated_count,
          'archivedCount', recent.archived_count,
          'failedCount', recent.failed_count,
          'error', recent.error_detail,
          'startedAt', recent.started_at,
          'finishedAt', recent.finished_at
        )
        order by recent.started_at desc
      )
      from (
        select run.*
        from commerce_sync.sync_runs run
        where run.connection_id = v_connection.id
        order by run.started_at desc
        limit 8
      ) recent
    ), '[]'::jsonb),
    'lastSync',
      case
        when v_last_run.id is null then null
        else jsonb_build_object(
          'runId', v_last_run.id,
          'trigger', v_last_run.trigger_type,
          'scope', to_jsonb(v_last_run.scope),
          'status', v_last_run.status,
          'cursor', v_last_run.current_cursor,
          'hasMore', v_last_run.has_more,
          'fetchedCount', v_last_run.fetched_count,
          'storedCount', v_last_run.stored_count,
          'createdCount', v_last_run.created_count,
          'updatedCount', v_last_run.updated_count,
          'archivedCount', v_last_run.archived_count,
          'failedCount', v_last_run.failed_count,
          'stats', v_last_run.stats,
          'errorDetail', v_last_run.error_detail,
          'startedAt', v_last_run.started_at,
          'finishedAt', v_last_run.finished_at
        )
      end,
    'courses', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', course.id,
          'courseCode', course.course_code,
          'nameAr', course.title_ar,
          'nameEn', course.title_en,
          'category', course.category,
          'description', course.description,
          'deliveryMode', course.delivery_mode,
          'durationHours', course.duration_hours,
          'durationDays', course.duration_days,
          'priceMinor', course.price_minor,
          'regularPriceMinor', course.regular_price_minor,
          'salePriceMinor', course.sale_price_minor,
          'saleStartsAt', course.sale_starts_at,
          'saleEndsAt', course.sale_ends_at,
          'currency', course.currency,
          'currencyMinorDigits', course.currency_minor_digits,
          'certificationCode', course.certification_code,
          'status', course.status,
          'externalSource', course.external_source,
          'externalId', course.external_id,
          'externalUrl', course.external_url,
          'externalUpdatedAt', course.external_updated_at,
          'primaryImageUrl', course.primary_image_url,
          'galleryUrls', to_jsonb(course.gallery_urls),
          'stockStatus', course.stock_status,
          'stockQuantity', course.stock_quantity,
          'productType', course.product_type,
          'virtual', course."virtual",
          'downloadable', course.downloadable,
          'updatedAt', course.updated_at
        )
        order by course.title_ar
      )
      from academy.courses course
      where course.tenant_id = v_tenant.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_woocommerce_action(
  p_tenant_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection commerce_sync.connections%rowtype;
  v_actor_subject_id uuid;
  v_store_url text;
  v_frequency text;
  v_match_by_sku boolean;
  v_scope text[];
  v_secret_refs jsonb;
  v_secret_value text;
  v_existing_secret_id uuid;
  v_saved_secret_id uuid;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_manage_woocommerce(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  v_actor_subject_id := private_app.current_subject_id();
  if v_actor_subject_id is null then raise exception 'forbidden'; end if;

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.tenant_id = v_tenant.id
  for update;

  if p_action = 'save' then
    if not private_app.tenant_addon_enabled(
      v_tenant.id,
      'addon.integration.woocommerce'
    ) then
      raise exception 'integration_addon_not_enabled';
    end if;

    v_store_url := private_app.woocommerce_store_url(
      p_payload ->> 'storeUrl'
    );
    v_frequency := lower(coalesce(
      nullif(trim(p_payload ->> 'syncFrequency'), ''),
      nullif(trim(p_payload ->> 'frequency'), ''),
      coalesce(v_connection.frequency, 'weekly')
    ));
    if v_frequency not in ('manual', 'daily', 'weekly', 'monthly') then
      raise exception 'woocommerce_invalid_frequency';
    end if;
    v_match_by_sku := case
      when jsonb_typeof(p_payload -> 'matchBySku') = 'boolean'
        then (p_payload ->> 'matchBySku')::boolean
      else coalesce(v_connection.match_by_sku, false)
    end;

    v_scope := private_app.woocommerce_sync_scope(
      case
        when jsonb_typeof(p_payload -> 'syncScope') = 'array'
          then p_payload -> 'syncScope'
        when v_connection.id is not null
          then to_jsonb(v_connection.sync_scope)
        else jsonb_build_array(
          'products',
          'categories',
          'attributes',
          'attribute_terms',
          'variations',
          'coupons'
        )
      end
    );

    insert into commerce_sync.connections (
      tenant_id,
      store_url,
      status,
      frequency,
      match_by_sku,
      sync_scope,
      next_sync_at,
      last_error,
      created_by_subject_id,
      updated_by_subject_id
    )
    values (
      v_tenant.id,
      v_store_url,
      'draft',
      v_frequency,
      v_match_by_sku,
      v_scope,
      null,
      null,
      v_actor_subject_id,
      v_actor_subject_id
    )
    on conflict (tenant_id) do update
    set store_url = excluded.store_url,
        status = 'draft',
        frequency = excluded.frequency,
        match_by_sku = excluded.match_by_sku,
        sync_scope = excluded.sync_scope,
        next_sync_at = null,
        last_error = null,
        updated_by_subject_id = excluded.updated_by_subject_id
    returning * into v_connection;

    v_secret_refs := coalesce(v_connection.secret_refs, '{}'::jsonb);

    v_secret_value := nullif(trim(
      p_payload #>> '{secrets,consumerKey}'
    ), '');
    if v_secret_value is not null then
      begin
        v_existing_secret_id :=
          nullif(v_secret_refs ->> 'consumerKey', '')::uuid;
      exception when invalid_text_representation then
        v_existing_secret_id := null;
      end;
      if v_existing_secret_id is not null
         and not exists (
           select 1
           from vault.secrets secret
           where secret.id = v_existing_secret_id
             and secret.name =
               'integration:' || v_tenant.id::text
               || ':' || v_connection.id::text
               || ':woocommerceConsumerKey'
         ) then
        v_existing_secret_id := null;
      end if;
      v_saved_secret_id := private_app.integration_secret_upsert(
        v_tenant.id,
        v_connection.id,
        'woocommerceConsumerKey',
        v_secret_value,
        v_existing_secret_id
      );
      v_secret_refs := jsonb_set(
        v_secret_refs,
        '{consumerKey}',
        to_jsonb(v_saved_secret_id::text),
        true
      );
    end if;

    v_secret_value := nullif(trim(
      p_payload #>> '{secrets,consumerSecret}'
    ), '');
    if v_secret_value is not null then
      begin
        v_existing_secret_id :=
          nullif(v_secret_refs ->> 'consumerSecret', '')::uuid;
      exception when invalid_text_representation then
        v_existing_secret_id := null;
      end;
      if v_existing_secret_id is not null
         and not exists (
           select 1
           from vault.secrets secret
           where secret.id = v_existing_secret_id
             and secret.name =
               'integration:' || v_tenant.id::text
               || ':' || v_connection.id::text
               || ':woocommerceConsumerSecret'
         ) then
        v_existing_secret_id := null;
      end if;
      v_saved_secret_id := private_app.integration_secret_upsert(
        v_tenant.id,
        v_connection.id,
        'woocommerceConsumerSecret',
        v_secret_value,
        v_existing_secret_id
      );
      v_secret_refs := jsonb_set(
        v_secret_refs,
        '{consumerSecret}',
        to_jsonb(v_saved_secret_id::text),
        true
      );
    end if;

    if not (v_secret_refs ? 'consumerKey')
       or not (v_secret_refs ? 'consumerSecret') then
      raise exception 'woocommerce_credentials_required';
    end if;

    update commerce_sync.connections
    set secret_refs = v_secret_refs
    where id = v_connection.id
    returning * into v_connection;

    insert into core.integrations (
      tenant_id,
      system_type,
      display_name,
      status,
      configuration
    )
    values (
      v_tenant.id,
      'woocommerce',
      'WooCommerce',
      'draft',
      jsonb_build_object(
        'connectionId', v_connection.id,
        'storeUrl', v_connection.store_url,
        'frequency', v_connection.frequency,
        'matchBySku', v_connection.match_by_sku,
        'syncScope', to_jsonb(v_connection.sync_scope)
      )
    )
    on conflict (tenant_id, system_type, display_name) do update
    set status = excluded.status,
        configuration = excluded.configuration,
        last_checked_at = null,
        updated_at = now();

    perform private_app.write_audit(
      'commerce.woocommerce.settings_saved',
      'commerce_connection',
      v_connection.id::text,
      v_tenant.id,
      jsonb_build_object(
        'storeUrl', v_connection.store_url,
        'frequency', v_connection.frequency,
        'matchBySku', v_connection.match_by_sku,
        'syncScope', to_jsonb(v_connection.sync_scope)
      )
    );

    return jsonb_build_object(
      'connectionId', v_connection.id,
      'status', v_connection.status,
      'storeUrl', v_connection.store_url,
      'frequency', v_connection.frequency,
      'matchBySku', v_connection.match_by_sku,
      'syncScope', to_jsonb(v_connection.sync_scope),
      'configuredSecrets',
        jsonb_build_array('consumerKey', 'consumerSecret')
    );
  elsif p_action = 'disable' then
    if v_connection.id is null then
      raise exception 'integration_connection_not_found';
    end if;

    update commerce_sync.connections
    set status = 'disabled',
        next_sync_at = null,
        last_error = null,
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection.id;

    update core.integrations
    set status = 'disabled',
        last_checked_at = now(),
        updated_at = now()
    where tenant_id = v_tenant.id
      and system_type = 'woocommerce'
      and display_name = 'WooCommerce';

    perform private_app.write_audit(
      'commerce.woocommerce.disabled',
      'commerce_connection',
      v_connection.id::text,
      v_tenant.id,
      jsonb_build_object('storeUrl', v_connection.store_url)
    );

    return jsonb_build_object(
      'connectionId', v_connection.id,
      'status', 'disabled'
    );
  else
    raise exception 'invalid_woocommerce_action';
  end if;
end;
$$;

create or replace function public.v2_tenant_woocommerce_authorize(
  p_tenant_slug text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection commerce_sync.connections%rowtype;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if p_action not in ('test_connection', 'sync_now') then
    raise exception 'invalid_woocommerce_action';
  end if;
  if not private_app.can_manage_woocommerce(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_addon_enabled(
    v_tenant.id,
    'addon.integration.woocommerce'
  ) then
    raise exception 'integration_addon_not_enabled';
  end if;

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.status <> 'disabled'
  limit 1;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;
  if not (v_connection.secret_refs ? 'consumerKey')
     or not (v_connection.secret_refs ? 'consumerSecret') then
    raise exception 'woocommerce_credentials_required';
  end if;
  if p_action = 'sync_now'
     and v_connection.status not in ('active', 'degraded') then
    raise exception 'woocommerce_connection_test_required';
  end if;

  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'connectionId', v_connection.id,
    'action', p_action
  );
end;
$$;

create or replace function public.v2_woocommerce_connection_configuration(
  p_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_consumer_key_id uuid;
  v_consumer_secret_id uuid;
  v_consumer_key text;
  v_consumer_secret text;
begin
  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
    and connection.status <> 'disabled'
  limit 1;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  begin
    v_consumer_key_id :=
      nullif(v_connection.secret_refs ->> 'consumerKey', '')::uuid;
    v_consumer_secret_id :=
      nullif(v_connection.secret_refs ->> 'consumerSecret', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'woocommerce_credentials_required';
  end;

  select secret.decrypted_secret
  into v_consumer_key
  from vault.decrypted_secrets secret
  where secret.id = v_consumer_key_id
    and secret.name =
      'integration:' || v_connection.tenant_id::text
      || ':' || v_connection.id::text
      || ':woocommerceConsumerKey'
  limit 1;

  select secret.decrypted_secret
  into v_consumer_secret
  from vault.decrypted_secrets secret
  where secret.id = v_consumer_secret_id
    and secret.name =
      'integration:' || v_connection.tenant_id::text
      || ':' || v_connection.id::text
      || ':woocommerceConsumerSecret'
  limit 1;

  if nullif(v_consumer_key, '') is null
     or nullif(v_consumer_secret, '') is null then
    raise exception 'woocommerce_credentials_required';
  end if;

  return jsonb_build_object(
    'tenantId', v_connection.tenant_id,
    'connectionId', v_connection.id,
    'storeUrl', v_connection.store_url,
    'status', v_connection.status,
    'frequency', v_connection.frequency,
    'matchBySku', v_connection.match_by_sku,
    'syncScope', to_jsonb(v_connection.sync_scope),
    'consumerKey', v_consumer_key,
    'consumerSecret', v_consumer_secret,
    'lastSyncedAt', v_connection.last_synced_at,
    'remoteMetadata', v_connection.remote_metadata
  );
end;
$$;

create or replace function public.v2_woocommerce_start_sync(
  p_connection_id uuid,
  p_trigger text,
  p_scope jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_scope text[];
  v_idempotency_key text;
begin
  if p_trigger not in ('manual', 'scheduled') then
    raise exception 'woocommerce_invalid_sync_trigger';
  end if;

  v_idempotency_key := nullif(trim(p_idempotency_key), '');
  if v_idempotency_key is null
     or length(v_idempotency_key) > 200 then
    raise exception 'woocommerce_invalid_idempotency_key';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_connection_id::text, 0)
  );

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
    and connection.status in ('active', 'degraded')
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;
  if not private_app.tenant_addon_enabled(
    v_connection.tenant_id,
    'addon.integration.woocommerce'
  ) then
    raise exception 'integration_addon_not_enabled';
  end if;

  update commerce_sync.sync_runs run
  set status = 'failed',
      has_more = false,
      error_detail = 'sync_lease_expired',
      finished_at = now()
  where run.connection_id = v_connection.id
    and run.status = 'running'
    and run.updated_at < now() - interval '20 minutes';

  v_scope := case
    when p_scope is null or p_scope = 'null'::jsonb
      then v_connection.sync_scope
    else private_app.woocommerce_sync_scope(p_scope)
  end;

  if not (v_scope <@ v_connection.sync_scope) then
    raise exception 'woocommerce_scope_not_enabled';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.connection_id = v_connection.id
    and run.idempotency_key = v_idempotency_key
  limit 1;

  if v_run.id is not null then
    return jsonb_build_object(
      'runId', v_run.id,
      'duplicate', true,
      'status', v_run.status
    );
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.connection_id = v_connection.id
    and run.status = 'running'
  order by run.started_at desc
  limit 1;

  if v_run.id is not null then
    return jsonb_build_object(
      'runId', v_run.id,
      'duplicate', true,
      'status', v_run.status
    );
  end if;

  insert into commerce_sync.sync_runs (
    tenant_id,
    connection_id,
    trigger_type,
    scope,
    idempotency_key,
    status
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    p_trigger,
    v_scope,
    v_idempotency_key,
    'running'
  )
  returning * into v_run;

  update commerce_sync.connections
  set last_error = null
  where id = v_connection.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'duplicate', false,
    'status', v_run.status
  );
end;
$$;

create or replace function public.v2_woocommerce_store_batch(
  p_connection_id uuid,
  p_run_id uuid,
  p_entity_type text,
  p_items jsonb,
  p_cursor jsonb,
  p_has_more boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_item jsonb;
  v_normalized jsonb;
  v_entity_type text;
  v_external_id text;
  v_external_parent_id text;
  v_remote_updated_at timestamptz;
  v_remote_hash text;
  v_archived boolean;
  v_local_course_id uuid;
  v_course academy.courses%rowtype;
  v_course_is_linked boolean;
  v_candidate_ids uuid[];
  v_course_code text;
  v_resolved_course_code text;
  v_title_ar text;
  v_title_en text;
  v_category text;
  v_description text;
  v_delivery_mode text;
  v_duration_hours numeric;
  v_duration_days_bigint bigint;
  v_regular_price bigint;
  v_sale_price bigint;
  v_current_price bigint;
  v_sale_starts_at timestamptz;
  v_sale_ends_at timestamptz;
  v_currency text;
  v_currency_minor_digits bigint;
  v_external_url text;
  v_primary_image_url text;
  v_gallery_urls text[];
  v_stock_status text;
  v_stock_quantity numeric;
  v_product_type text;
  v_virtual boolean;
  v_downloadable boolean;
  v_course_status text;
  v_fetched bigint := 0;
  v_stored bigint := 0;
  v_created bigint := 0;
  v_updated bigint := 0;
  v_archived_count bigint := 0;
  v_failed bigint := 0;
begin
  v_entity_type := lower(trim(coalesce(p_entity_type, '')));
  if v_entity_type not in (
    'products',
    'categories',
    'attributes',
    'attribute_terms',
    'variations',
    'coupons',
    'orders',
    'customers'
  ) then
    raise exception 'woocommerce_invalid_entity_type';
  end if;
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 1000 then
    raise exception 'woocommerce_invalid_batch';
  end if;

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
    and connection.status in ('active', 'degraded')
  limit 1;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    raise exception 'sync_run_not_running';
  end if;
  if not (v_entity_type = any(v_run.scope)) then
    raise exception 'woocommerce_entity_outside_run_scope';
  end if;

  for v_item in
    select item.value
    from jsonb_array_elements(p_items) item(value)
  loop
    v_fetched := v_fetched + 1;

    if jsonb_typeof(v_item) <> 'object' then
      v_failed := v_failed + 1;
      continue;
    end if;

    v_normalized := case
      when jsonb_typeof(v_item -> '_marktone') = 'object'
        then v_item -> '_marktone'
      else '{}'::jsonb
    end;
    v_external_id := nullif(trim(coalesce(
      v_normalized ->> 'externalId',
      v_item ->> 'id'
    )), '');

    if v_external_id is null or length(v_external_id) > 255 then
      v_failed := v_failed + 1;
      continue;
    end if;

    v_external_parent_id := nullif(trim(coalesce(
      v_normalized ->> 'externalParentId',
      v_item ->> 'parent_id'
    )), '');
    v_remote_updated_at := private_app.woocommerce_try_timestamptz(
      coalesce(
        v_normalized ->> 'externalUpdatedAt',
        v_item ->> 'date_modified_gmt',
        v_item ->> 'date_modified'
      )
    );
    v_remote_hash := coalesce(
      nullif(v_normalized ->> 'remoteHash', ''),
      md5(v_item::text)
    );
    v_archived := lower(coalesce(
      v_normalized ->> 'archived',
      'false'
    )) in ('true', '1', 'yes')
      or lower(coalesce(
        v_normalized ->> 'status',
        v_item ->> 'status',
        ''
      )) in ('archived', 'trash', 'deleted');

    insert into commerce_sync.external_entities (
      tenant_id,
      connection_id,
      entity_type,
      external_id,
      external_parent_id,
      raw_payload,
      remote_updated_at,
      remote_hash,
      sync_state,
      last_seen_run_id,
      last_synced_at,
      archived_at,
      last_error
    )
    values (
      v_connection.tenant_id,
      v_connection.id,
      v_entity_type,
      v_external_id,
      v_external_parent_id,
      v_item,
      v_remote_updated_at,
      v_remote_hash,
      case when v_archived then 'archived' else 'active' end,
      v_run.id,
      now(),
      case when v_archived then now() else null end,
      null
    )
    on conflict (connection_id, entity_type, external_id) do update
    set external_parent_id = excluded.external_parent_id,
        raw_payload = excluded.raw_payload,
        remote_updated_at = excluded.remote_updated_at,
        remote_hash = excluded.remote_hash,
        sync_state = excluded.sync_state,
        last_seen_run_id = excluded.last_seen_run_id,
        last_synced_at = excluded.last_synced_at,
        archived_at = excluded.archived_at,
        last_error = null
    returning local_course_id into v_local_course_id;

    v_stored := v_stored + 1;

    if v_entity_type <> 'products' then
      continue;
    end if;

    begin
      v_course := null;
      v_course_is_linked := false;
      v_candidate_ids := null;
      v_course_code := nullif(trim(coalesce(
        v_normalized ->> 'courseCode',
        v_normalized ->> 'sku',
        v_item ->> 'sku'
      )), '');
      if v_course_code is not null then
        v_course_code := left(v_course_code, 180);
      end if;

      v_title_ar := nullif(trim(coalesce(
        v_normalized ->> 'titleAr',
        v_normalized ->> 'title',
        v_item ->> 'name'
      )), '');
      if v_title_ar is null or length(v_title_ar) < 2 then
        v_title_ar := 'WooCommerce ' || v_external_id;
      end if;
      v_title_en := nullif(trim(
        v_normalized ->> 'titleEn'
      ), '');
      v_category := nullif(trim(coalesce(
        v_normalized ->> 'category',
        v_normalized #>> '{primaryCategory,name}',
        v_normalized #>> '{categoryNames,0}'
      )), '');
      v_description := coalesce(
        v_normalized ->> 'description',
        v_normalized ->> 'plainDescription',
        v_normalized ->> 'plainShortDescription',
        v_item ->> 'description'
      );

      v_delivery_mode := lower(coalesce(
        v_normalized ->> 'deliveryMode',
        ''
      ));
      if v_delivery_mode not in ('online', 'onsite', 'hybrid') then
        v_delivery_mode := null;
      end if;

      v_duration_hours := private_app.woocommerce_try_numeric(
        coalesce(
          v_normalized ->> 'durationHours',
          substring(
            v_normalized ->> 'duration'
            from '[0-9]+([.][0-9]+)?'
          )
        )
      );
      if v_duration_hours is not null and v_duration_hours <= 0 then
        v_duration_hours := null;
      end if;

      v_duration_days_bigint := private_app.woocommerce_try_bigint(
        v_normalized ->> 'durationDays'
      );
      if v_duration_days_bigint is not null
         and (
           v_duration_days_bigint = 0
           or v_duration_days_bigint > 2147483647
         ) then
        v_duration_days_bigint := null;
      end if;

      v_regular_price := private_app.woocommerce_try_bigint(
        v_normalized ->> 'regularPriceMinor'
      );
      v_sale_price := private_app.woocommerce_try_bigint(
        v_normalized ->> 'salePriceMinor'
      );
      v_current_price := private_app.woocommerce_try_bigint(
        v_normalized ->> 'priceMinor'
      );
      v_sale_starts_at := private_app.woocommerce_try_timestamptz(
        coalesce(
          v_normalized ->> 'saleStartsAt',
          v_item ->> 'date_on_sale_from_gmt',
          v_item ->> 'date_on_sale_from'
        )
      );
      v_sale_ends_at := private_app.woocommerce_try_timestamptz(
        coalesce(
          v_normalized ->> 'saleEndsAt',
          v_item ->> 'date_on_sale_to_gmt',
          v_item ->> 'date_on_sale_to'
        )
      );
      if v_sale_starts_at is not null
         and v_sale_ends_at is not null
         and v_sale_ends_at <= v_sale_starts_at then
        v_sale_ends_at := null;
      end if;

      v_currency := upper(coalesce(
        nullif(trim(v_normalized ->> 'currency'), ''),
        ''
      ));
      if v_currency !~ '^[A-Z]{3}$' then
        raise exception 'woocommerce_currency_required';
      end if;
      v_currency_minor_digits := private_app.woocommerce_try_bigint(
        v_normalized ->> 'currencyMinorDigits'
      );
      if v_currency_minor_digits is null
         or v_currency_minor_digits > 4 then
        raise exception 'woocommerce_currency_scale_required';
      end if;

      v_external_url := nullif(trim(coalesce(
        v_normalized ->> 'externalUrl',
        v_item ->> 'permalink'
      )), '');
      if v_external_url is not null
         and v_external_url !~* '^https://[^[:space:]]+$' then
        v_external_url := null;
      end if;

      v_primary_image_url := nullif(trim(coalesce(
        v_normalized ->> 'primaryImageUrl',
        v_normalized ->> 'imageUrl'
      )), '');
      if v_primary_image_url is not null
         and v_primary_image_url !~* '^https://[^[:space:]]+$' then
        v_primary_image_url := null;
      end if;

      v_gallery_urls := '{}'::text[];
      if jsonb_typeof(v_normalized -> 'galleryUrls') = 'array' then
        select coalesce(
          array_agg(image.value order by image.position),
          '{}'::text[]
        )
        into v_gallery_urls
        from jsonb_array_elements_text(
          v_normalized -> 'galleryUrls'
        ) with ordinality image(value, position)
        where image.value ~* '^https://[^[:space:]]+$';
      end if;

      v_stock_status := lower(coalesce(
        v_normalized ->> 'stockStatus',
        v_item ->> 'stock_status',
        ''
      ));
      if v_stock_status not in (
        'instock',
        'outofstock',
        'onbackorder'
      ) then
        v_stock_status := null;
      end if;

      v_stock_quantity := private_app.woocommerce_try_numeric(
        coalesce(
          v_normalized ->> 'stockQuantity',
          v_item ->> 'stock_quantity'
        )
      );
      if v_stock_quantity is not null
         and v_stock_quantity > 99999999999.999 then
        v_stock_quantity := null;
      end if;

      v_product_type := lower(coalesce(
        nullif(trim(v_normalized ->> 'productType'), ''),
        nullif(trim(v_item ->> 'type'), ''),
        'simple'
      ));
      if v_product_type !~ '^[a-z][a-z0-9_-]{0,40}$' then
        v_product_type := 'simple';
      end if;

      v_virtual := lower(coalesce(
        v_normalized ->> 'virtual',
        v_item ->> 'virtual',
        'false'
      )) in ('true', '1', 'yes');
      v_downloadable := lower(coalesce(
        v_normalized ->> 'downloadable',
        v_item ->> 'downloadable',
        'false'
      )) in ('true', '1', 'yes');
      v_course_status := case
        when v_archived then 'archived'
        when lower(coalesce(
          v_normalized ->> 'status',
          v_item ->> 'status',
          'publish'
        )) in ('publish', 'active') then 'active'
        else 'draft'
      end;

      if v_local_course_id is not null then
        select *
        into v_course
        from academy.courses course
        where course.id = v_local_course_id
          and course.tenant_id = v_connection.tenant_id
        limit 1;
      end if;

      if v_course.id is null then
        select *
        into v_course
        from academy.courses course
        where course.tenant_id = v_connection.tenant_id
          and course.external_source = 'woocommerce'
          and course.external_id = v_external_id
        limit 1;
      end if;

      if v_course.id is null
         and v_connection.match_by_sku
         and v_course_code is not null then
        select array_agg(course.id order by course.created_at)
        into v_candidate_ids
        from academy.courses course
        where course.tenant_id = v_connection.tenant_id
          and lower(course.course_code) = lower(v_course_code)
          and (
            course.external_source is null
            or (
              course.external_source = 'woocommerce'
              and course.external_id = v_external_id
            )
          )
          and not exists (
            select 1
            from commerce_sync.external_entities mapped
            where mapped.connection_id = v_connection.id
              and mapped.entity_type = 'products'
              and mapped.local_course_id = course.id
              and mapped.external_id <> v_external_id
          );

        if cardinality(v_candidate_ids) = 1 then
          select *
          into v_course
          from academy.courses course
          where course.id = v_candidate_ids[1];
        end if;
      end if;

      v_course_is_linked := v_course.id is not null and (
        v_course.external_source is null
        or coalesce(
          v_course.metadata #>> '{woocommerce,origin}',
          ''
        ) = 'linked'
      );

      if v_course.id is null then
        v_resolved_course_code := v_course_code;
        if v_resolved_course_code is null
           or exists (
             select 1
             from academy.courses course
             where course.tenant_id = v_connection.tenant_id
               and lower(course.course_code) =
                 lower(v_resolved_course_code)
           ) then
          v_resolved_course_code :=
            'WC-'
            || substr(replace(v_connection.id::text, '-', ''), 1, 8)
            || '-'
            || substr(md5(v_external_id), 1, 16);
        end if;

        insert into academy.courses (
          tenant_id,
          course_code,
          title_ar,
          title_en,
          category,
          description,
          delivery_mode,
          duration_hours,
          duration_days,
          price_minor,
          regular_price_minor,
          sale_price_minor,
          sale_starts_at,
          sale_ends_at,
          currency,
          currency_minor_digits,
          status,
          external_source,
          external_id,
          external_url,
          external_updated_at,
          primary_image_url,
          gallery_urls,
          stock_status,
          stock_quantity,
          product_type,
          "virtual",
          downloadable,
          metadata
        )
        values (
          v_connection.tenant_id,
          v_resolved_course_code,
          v_title_ar,
          v_title_en,
          coalesce(v_category, 'WooCommerce'),
          v_description,
          coalesce(v_delivery_mode, 'online'),
          v_duration_hours,
          v_duration_days_bigint::integer,
          coalesce(v_current_price, v_sale_price, v_regular_price),
          v_regular_price,
          v_sale_price,
          v_sale_starts_at,
          v_sale_ends_at,
          v_currency,
          v_currency_minor_digits::smallint,
          v_course_status,
          'woocommerce',
          v_external_id,
          v_external_url,
          v_remote_updated_at,
          v_primary_image_url,
          v_gallery_urls,
          v_stock_status,
          v_stock_quantity,
          v_product_type,
          v_virtual,
          v_downloadable,
          jsonb_build_object(
            'woocommerce',
            jsonb_build_object(
              'connectionId', v_connection.id,
              'origin', 'imported',
              'sku', v_course_code,
              'lastSyncedAt', now()
            )
          )
        )
        returning * into v_course;

        v_created := v_created + 1;
      else
        v_resolved_course_code := v_course.course_code;
        if not v_course_is_linked
           and v_course.external_source = 'woocommerce'
           and v_course_code is not null
           and not exists (
             select 1
             from academy.courses other_course
             where other_course.tenant_id = v_connection.tenant_id
               and other_course.id <> v_course.id
               and lower(other_course.course_code) =
                 lower(v_course_code)
           ) then
          v_resolved_course_code := v_course_code;
        end if;

        update academy.courses course
        set course_code = case
              when v_course_is_linked then course.course_code
              else v_resolved_course_code
            end,
            title_ar = case
              when v_course_is_linked then course.title_ar
              else v_title_ar
            end,
            title_en = case
              when v_course_is_linked then course.title_en
              else coalesce(v_title_en, course.title_en)
            end,
            category = case
              when v_course_is_linked then course.category
              else coalesce(v_category, course.category)
            end,
            description = case
              when v_course_is_linked then course.description
              else coalesce(v_description, course.description)
            end,
            delivery_mode = case
              when v_course_is_linked then course.delivery_mode
              else coalesce(v_delivery_mode, course.delivery_mode)
            end,
            duration_hours = case
              when v_course_is_linked then course.duration_hours
              else coalesce(v_duration_hours, course.duration_hours)
            end,
            duration_days = case
              when v_course_is_linked then course.duration_days
              else coalesce(
                v_duration_days_bigint::integer,
                course.duration_days
              )
            end,
            price_minor = coalesce(
              v_current_price,
              v_sale_price,
              v_regular_price,
              course.price_minor
            ),
            regular_price_minor = coalesce(
              v_regular_price,
              course.regular_price_minor
            ),
            sale_price_minor = v_sale_price,
            sale_starts_at = v_sale_starts_at,
            sale_ends_at = v_sale_ends_at,
            currency = v_currency,
            currency_minor_digits =
              v_currency_minor_digits::smallint,
            status = case
              when v_course_is_linked then course.status
              else v_course_status
            end,
            external_source = 'woocommerce',
            external_id = v_external_id,
            external_url = v_external_url,
            external_updated_at = v_remote_updated_at,
            primary_image_url = v_primary_image_url,
            gallery_urls = v_gallery_urls,
            stock_status = v_stock_status,
            stock_quantity = v_stock_quantity,
            product_type = v_product_type,
            "virtual" = v_virtual,
            downloadable = v_downloadable,
            metadata = course.metadata || jsonb_build_object(
              'woocommerce',
              jsonb_build_object(
                'connectionId', v_connection.id,
                'origin', case
                  when v_course_is_linked then 'linked'
                  else 'imported'
                end,
                'sku', v_course_code,
                'lastSyncedAt', now()
              )
            )
        where course.id = v_course.id
        returning * into v_course;

        v_updated := v_updated + 1;
      end if;

      update commerce_sync.external_entities entity
      set local_course_id = v_course.id,
          sync_state = case
            when v_archived then 'archived'
            else 'active'
          end,
          archived_at = case
            when v_archived then coalesce(entity.archived_at, now())
            else null
          end,
          last_error = null
      where entity.connection_id = v_connection.id
        and entity.entity_type = 'products'
        and entity.external_id = v_external_id;

      if v_archived then
        v_archived_count := v_archived_count + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      update commerce_sync.external_entities entity
      set sync_state = 'error',
          archived_at = null,
          last_error = left(sqlstate || ':' || sqlerrm, 1000)
      where entity.connection_id = v_connection.id
        and entity.entity_type = 'products'
        and entity.external_id = v_external_id;
    end;
  end loop;

  update commerce_sync.sync_runs run
  set current_cursor = coalesce(p_cursor, '{}'::jsonb),
      has_more = coalesce(p_has_more, false),
      fetched_count = run.fetched_count + v_fetched,
      stored_count = run.stored_count + v_stored,
      created_count = run.created_count + v_created,
      updated_count = run.updated_count + v_updated,
      archived_count = run.archived_count + v_archived_count,
      failed_count = run.failed_count + v_failed
  where run.id = v_run.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'entityType', v_entity_type,
    'fetchedCount', v_fetched,
    'storedCount', v_stored,
    'createdCount', v_created,
    'updatedCount', v_updated,
    'archivedCount', v_archived_count,
    'failedCount', v_failed,
    'cursor', coalesce(p_cursor, '{}'::jsonb),
    'hasMore', coalesce(p_has_more, false)
  );
end;
$$;

create or replace function public.v2_woocommerce_complete_sync(
  p_connection_id uuid,
  p_run_id uuid,
  p_stats jsonb,
  p_remote_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_status text;
  v_fetched bigint;
  v_stored bigint;
  v_created bigint;
  v_updated bigint;
  v_archived bigint;
  v_reconciled_archived bigint := 0;
  v_failed bigint;
  v_metadata jsonb;
begin
  if p_stats is not null and jsonb_typeof(p_stats) <> 'object' then
    raise exception 'woocommerce_invalid_sync_stats';
  end if;
  if p_remote_metadata is not null
     and jsonb_typeof(p_remote_metadata) <> 'object' then
    raise exception 'woocommerce_invalid_remote_metadata';
  end if;

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;

  v_fetched := greatest(
    v_run.fetched_count,
    coalesce(
      private_app.woocommerce_try_bigint(p_stats ->> 'fetchedCount'),
      v_run.fetched_count
    )
  );
  v_stored := greatest(
    v_run.stored_count,
    coalesce(
      private_app.woocommerce_try_bigint(p_stats ->> 'storedCount'),
      v_run.stored_count
    )
  );
  v_created := greatest(
    v_run.created_count,
    coalesce(
      private_app.woocommerce_try_bigint(p_stats ->> 'createdCount'),
      v_run.created_count
    )
  );
  v_updated := greatest(
    v_run.updated_count,
    coalesce(
      private_app.woocommerce_try_bigint(p_stats ->> 'updatedCount'),
      v_run.updated_count
    )
  );
  v_archived := greatest(
    v_run.archived_count,
    coalesce(
      private_app.woocommerce_try_bigint(p_stats ->> 'archivedCount'),
      v_run.archived_count
    )
  );
  v_failed := greatest(
    v_run.failed_count,
    coalesce(
      private_app.woocommerce_try_bigint(p_stats ->> 'failedCount'),
      v_run.failed_count
    )
  );

  if v_failed = 0 then
    update commerce_sync.external_entities entity
    set sync_state = 'archived',
        archived_at = coalesce(entity.archived_at, now()),
        last_synced_at = now(),
        last_error = null
    where entity.connection_id = v_connection.id
      and entity.entity_type = any(v_run.scope)
      and entity.last_seen_run_id is distinct from v_run.id
      and entity.sync_state <> 'archived';

    get diagnostics v_reconciled_archived = row_count;
    v_archived := v_archived + v_reconciled_archived;

    update academy.courses course
    set status = 'archived'
    where course.tenant_id = v_connection.tenant_id
      and course.external_source = 'woocommerce'
      and coalesce(
        course.metadata #>> '{woocommerce,origin}',
        'imported'
      ) <> 'linked'
      and exists (
        select 1
        from commerce_sync.external_entities entity
        where entity.connection_id = v_connection.id
          and entity.entity_type = 'products'
          and entity.local_course_id = course.id
          and entity.sync_state = 'archived'
      );
  end if;

  v_status := case when v_failed > 0 then 'partial' else 'success' end;
  v_metadata := coalesce(p_remote_metadata, '{}'::jsonb);

  update commerce_sync.sync_runs run
  set status = v_status,
      has_more = false,
      fetched_count = v_fetched,
      stored_count = v_stored,
      created_count = v_created,
      updated_count = v_updated,
      archived_count = v_archived,
      failed_count = v_failed,
      stats = coalesce(p_stats, '{}'::jsonb),
      error_detail = case
        when v_failed > 0 then 'sync_completed_with_item_errors'
        else null
      end,
      finished_at = now()
  where run.id = v_run.id;

  update commerce_sync.connections connection
  set status = case
        when v_status = 'success' then 'active'
        else 'degraded'
      end,
      last_checked_at = now(),
      last_synced_at = case
        when v_status = 'success' then now()
        else connection.last_synced_at
      end,
      next_sync_at = private_app.woocommerce_next_sync(
        connection.frequency,
        now()
      ),
      last_error = case
        when v_status = 'success' then null
        else 'sync_completed_with_item_errors'
      end,
      remote_metadata = connection.remote_metadata || v_metadata
  where connection.id = v_connection.id;

  update core.integrations
  set status = case
        when v_status = 'success' then 'active'
        else 'degraded'
      end,
      last_checked_at = now(),
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'woocommerce'
    and display_name = 'WooCommerce';

  return jsonb_build_object(
    'runId', v_run.id,
    'status', v_status,
    'duplicate', false,
    'fetchedCount', v_fetched,
    'storedCount', v_stored,
    'createdCount', v_created,
    'updatedCount', v_updated,
    'archivedCount', v_archived,
    'failedCount', v_failed
  );
end;
$$;

create or replace function public.v2_woocommerce_fail_sync(
  p_connection_id uuid,
  p_run_id uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_error text;
begin
  v_error := left(coalesce(
    nullif(trim(p_error), ''),
    'woocommerce_sync_failed'
  ), 2000);

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;

  update commerce_sync.sync_runs run
  set status = 'failed',
      has_more = false,
      error_detail = v_error,
      finished_at = now()
  where run.id = v_run.id;

  update commerce_sync.connections connection
  set status = case
        when connection.status in ('active', 'degraded') then 'degraded'
        else 'error'
      end,
      last_checked_at = now(),
      next_sync_at = private_app.woocommerce_next_sync(
        connection.frequency,
        now()
      ),
      last_error = v_error
  where connection.id = v_connection.id;

  update core.integrations
  set status = 'degraded',
      last_checked_at = now(),
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'woocommerce'
    and display_name = 'WooCommerce';

  return jsonb_build_object(
    'runId', v_run.id,
    'status', 'failed',
    'duplicate', false
  );
end;
$$;

create or replace function public.v2_woocommerce_test_complete(
  p_connection_id uuid,
  p_success boolean,
  p_remote_metadata jsonb,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_status text;
  v_error text;
  v_metadata jsonb;
begin
  if p_remote_metadata is not null
     and jsonb_typeof(p_remote_metadata) <> 'object' then
    raise exception 'woocommerce_invalid_remote_metadata';
  end if;

  v_metadata := coalesce(p_remote_metadata, '{}'::jsonb);
  v_error := case
    when p_success then null
    else left(coalesce(
      nullif(trim(p_error), ''),
      'woocommerce_connection_test_failed'
    ), 2000)
  end;

  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
    and connection.status <> 'disabled'
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  v_status := case
    when p_success then 'active'
    when v_connection.status in ('active', 'degraded') then 'degraded'
    else 'error'
  end;

  update commerce_sync.connections connection
  set status = v_status,
      last_checked_at = now(),
      next_sync_at = case
        when p_success then private_app.woocommerce_next_sync(
          connection.frequency,
          now()
        )
        else null
      end,
      last_error = v_error,
      remote_metadata = connection.remote_metadata || v_metadata
  where connection.id = v_connection.id;

  update core.integrations
  set status = v_status,
      last_checked_at = now(),
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'woocommerce'
    and display_name = 'WooCommerce';

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'success', p_success,
    'status', v_status,
    'error', v_error
  );
end;
$$;

do $secret$
begin
  if not exists (
    select 1
    from vault.secrets secret
    where secret.name = 'woocommerce_dispatch_secret'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'woocommerce_dispatch_secret',
      'Authorizes the scheduled WooCommerce synchronization dispatcher.'
    );
  end if;
end;
$secret$;

create or replace function public.v2_woocommerce_schedule_authorize(
  p_secret text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets secret
    where secret.name = 'woocommerce_dispatch_secret'
      and secret.decrypted_secret = p_secret
  );
$$;

create or replace function public.v2_woocommerce_due_connections()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('connectionId', connection.id)
      order by connection.next_sync_at nulls first, connection.id
    ),
    '[]'::jsonb
  )
  from (
    select due.*
    from commerce_sync.connections due
    where due.status in ('active', 'degraded')
      and due.frequency <> 'manual'
      and (
        due.next_sync_at is null
        or due.next_sync_at <= now()
      )
      and due.secret_refs ? 'consumerKey'
      and due.secret_refs ? 'consumerSecret'
      and private_app.tenant_addon_enabled(
        due.tenant_id,
        'addon.integration.woocommerce'
      )
    order by due.next_sync_at nulls first, due.id
    limit 5
  ) connection;
$$;

revoke execute on function
  public.v2_tenant_woocommerce_snapshot(text)
from public, anon;
revoke execute on function
  public.v2_tenant_woocommerce_action(text, text, jsonb)
from public, anon;
revoke execute on function
  public.v2_tenant_woocommerce_authorize(text, text)
from public, anon;

revoke execute on function
  public.v2_woocommerce_connection_configuration(uuid)
from public, anon, authenticated;
revoke execute on function
  public.v2_woocommerce_start_sync(uuid, text, jsonb, text)
from public, anon, authenticated;
revoke execute on function
  public.v2_woocommerce_store_batch(
    uuid,
    uuid,
    text,
    jsonb,
    jsonb,
    boolean
  )
from public, anon, authenticated;
revoke execute on function
  public.v2_woocommerce_complete_sync(uuid, uuid, jsonb, jsonb)
from public, anon, authenticated;
revoke execute on function
  public.v2_woocommerce_fail_sync(uuid, uuid, text)
from public, anon, authenticated;
revoke execute on function
  public.v2_woocommerce_test_complete(uuid, boolean, jsonb, text)
from public, anon, authenticated;
revoke execute on function
  public.v2_woocommerce_schedule_authorize(text)
from public, anon, authenticated;
revoke execute on function
  public.v2_woocommerce_due_connections()
from public, anon, authenticated;

grant execute on function
  public.v2_tenant_woocommerce_snapshot(text)
to authenticated;
grant execute on function
  public.v2_tenant_woocommerce_action(text, text, jsonb)
to authenticated;
grant execute on function
  public.v2_tenant_woocommerce_authorize(text, text)
to authenticated;

grant execute on function
  public.v2_woocommerce_connection_configuration(uuid)
to service_role;
grant execute on function
  public.v2_woocommerce_start_sync(uuid, text, jsonb, text)
to service_role;
grant execute on function
  public.v2_woocommerce_store_batch(
    uuid,
    uuid,
    text,
    jsonb,
    jsonb,
    boolean
  )
to service_role;
grant execute on function
  public.v2_woocommerce_complete_sync(uuid, uuid, jsonb, jsonb)
to service_role;
grant execute on function
  public.v2_woocommerce_fail_sync(uuid, uuid, text)
to service_role;
grant execute on function
  public.v2_woocommerce_test_complete(uuid, boolean, jsonb, text)
to service_role;
grant execute on function
  public.v2_woocommerce_schedule_authorize(text)
to service_role;
grant execute on function
  public.v2_woocommerce_due_connections()
to service_role;

do $schedule$
declare
  v_job_id bigint;
begin
  select job.jobid
  into v_job_id
  from cron.job job
  where job.jobname = 'marktone-woocommerce-sync'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'marktone-woocommerce-sync',
    '0 * * * *',
    $command$
      select net.http_post(
        url :=
          'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
          || 'woocommerce-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-marktone-woocommerce-secret',
          (
            select secret.decrypted_secret
            from vault.decrypted_secrets secret
            where secret.name = 'woocommerce_dispatch_secret'
          )
        ),
        body := jsonb_build_object(
          'action', 'scheduled_sync',
          'requestedAt', now()
        ),
        timeout_milliseconds := 60000
      ) as request_id;
    $command$
  );
end;
$schedule$;

comment on schema commerce_sync is
'Tenant-isolated WooCommerce connections, raw entity mirrors, and sync history.';
comment on table commerce_sync.connections is
'One WooCommerce store connection per tenant; credential values live only in Vault.';
comment on table commerce_sync.external_entities is
'Idempotent raw WooCommerce entity mirror with optional local course mapping.';
comment on function public.v2_tenant_woocommerce_snapshot(text) is
'Academy-readable WooCommerce settings, run status, and course commerce fields without decrypted secrets.';
comment on function public.v2_woocommerce_connection_configuration(uuid) is
'Service-only WooCommerce execution configuration, including Vault-decrypted credentials.';

commit;
