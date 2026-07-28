begin;

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
values
  (
    'addon.integration.zoom',
    'ربط Zoom',
    'Zoom Integration',
    'addon',
    'boolean',
    'false'::jsonb,
    'beta'
  ),
  (
    'addon.communication.delivery_analytics',
    'إثبات التسليم والتحليلات',
    'Delivery Proof and Analytics',
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
  on feature.feature_key in (
    'addon.integration.zoom',
    'addon.communication.delivery_analytics'
  )
where plan.plan_key = 'full'
on conflict (plan_id, feature_id) do update
set value = excluded.value,
    updated_at = now();

create table catalog.addon_products (
  id uuid primary key default gen_random_uuid(),
  product_key text not null unique
    check (product_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  feature_id uuid not null unique
    references catalog.features(id) on delete restrict,
  name_ar text not null,
  name_en text,
  description_ar text,
  pricing_mode text not null default 'contact_sales'
    check (pricing_mode in ('contact_sales', 'fixed', 'free')),
  amount_minor bigint not null default 0
    check (amount_minor >= 0),
  currency text not null default 'SAR'
    check (currency ~ '^[A-Z]{3}$'),
  interval text not null default 'month'
    check (interval in ('month', 'year', 'one_time')),
  trial_days integer not null default 14
    check (trial_days between 0 and 90),
  usage_metric text not null
    check (usage_metric ~ '^[a-z][a-z0-9_]{2,80}$'),
  default_limit bigint
    check (default_limit is null or default_limit >= 0),
  status text not null default 'beta'
    check (status in ('draft', 'beta', 'active', 'archived')),
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table catalog.tenant_addon_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  product_id uuid not null
    references catalog.addon_products(id) on delete restrict,
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'trialing',
        'active',
        'paused',
        'cancelled',
        'expired'
      )
    ),
  source text not null default 'tenant_request'
    check (
      source in (
        'tenant_request',
        'platform',
        'billing',
        'migration'
      )
    ),
  custom_limit bigint
    check (custom_limit is null or custom_limit >= 0),
  usage_alert_percent integer not null default 80
    check (usage_alert_percent between 10 and 100),
  trial_start timestamptz,
  trial_end timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  requested_note text,
  decision_note text,
  cancel_at_period_end boolean not null default false,
  requested_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  decided_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index tenant_addons_one_current_idx
on catalog.tenant_addon_subscriptions (tenant_id, product_id)
where status in ('pending', 'trialing', 'active', 'paused');

create index tenant_addons_product_reference_idx
on catalog.tenant_addon_subscriptions (product_id);

create index tenant_addons_requester_reference_idx
on catalog.tenant_addon_subscriptions (requested_by_subject_id)
where requested_by_subject_id is not null;

create index tenant_addons_decider_reference_idx
on catalog.tenant_addon_subscriptions (decided_by_subject_id)
where decided_by_subject_id is not null;

create table catalog.addon_usage_counters (
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  product_id uuid not null
    references catalog.addon_products(id) on delete cascade,
  metric_key text not null,
  period_start date not null,
  period_end date not null,
  used_quantity bigint not null default 0
    check (used_quantity >= 0),
  reserved_quantity bigint not null default 0
    check (reserved_quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (
    tenant_id,
    product_id,
    metric_key,
    period_start
  )
);

create index addon_usage_counters_product_reference_idx
on catalog.addon_usage_counters (product_id);

create table catalog.addon_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  product_id uuid not null
    references catalog.addon_products(id) on delete cascade,
  metric_key text not null,
  idempotency_key text not null,
  source_type text not null,
  source_id text not null,
  quantity bigint not null
    check (quantity between 1 and 1000000),
  status text not null default 'reserved'
    check (status in ('reserved', 'consumed', 'released')),
  period_start date not null,
  period_end date not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, product_id, idempotency_key)
);

create index addon_usage_reservations_expiry_idx
on catalog.addon_usage_reservations (
  status,
  expires_at
)
where status = 'reserved';

create index addon_usage_reservations_product_reference_idx
on catalog.addon_usage_reservations (product_id);

create table catalog.addon_usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  product_id uuid not null
    references catalog.addon_products(id) on delete cascade,
  reservation_id uuid
    references catalog.addon_usage_reservations(id)
    on delete set null,
  metric_key text not null,
  quantity bigint not null
    check (quantity > 0),
  idempotency_key text not null,
  source_type text not null,
  source_id text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, product_id, idempotency_key)
);

create index addon_usage_events_tenant_time_idx
on catalog.addon_usage_events (
  tenant_id,
  occurred_at desc
);

create index addon_usage_events_product_reference_idx
on catalog.addon_usage_events (product_id);

create index addon_usage_events_reservation_reference_idx
on catalog.addon_usage_events (reservation_id)
where reservation_id is not null;

create trigger addon_products_set_updated_at
before update on catalog.addon_products
for each row execute function private_app.set_updated_at();

create trigger tenant_addons_set_updated_at
before update on catalog.tenant_addon_subscriptions
for each row execute function private_app.set_updated_at();

create trigger addon_usage_reservations_set_updated_at
before update on catalog.addon_usage_reservations
for each row execute function private_app.set_updated_at();

alter table catalog.addon_products enable row level security;
alter table catalog.tenant_addon_subscriptions enable row level security;
alter table catalog.addon_usage_counters enable row level security;
alter table catalog.addon_usage_reservations enable row level security;
alter table catalog.addon_usage_events enable row level security;

create policy addon_products_platform_read
on catalog.addon_products
for select to authenticated
using (private_app.has_platform_permission('platform.control.read'));

create policy tenant_addons_isolated_read
on catalog.tenant_addon_subscriptions
for select to authenticated
using (
  private_app.can_access_tenant(tenant_id)
  or private_app.has_platform_permission('platform.billing.manage')
);

create policy addon_usage_counters_isolated_read
on catalog.addon_usage_counters
for select to authenticated
using (
  private_app.can_access_tenant(tenant_id)
  or private_app.has_platform_permission('platform.billing.manage')
);

create policy addon_usage_events_isolated_read
on catalog.addon_usage_events
for select to authenticated
using (
  private_app.can_access_tenant(tenant_id)
  or private_app.has_platform_permission('platform.billing.manage')
);

revoke all on table catalog.addon_products
from public, anon, authenticated;

revoke all on table catalog.tenant_addon_subscriptions
from public, anon, authenticated;

revoke all on table catalog.addon_usage_counters
from public, anon, authenticated;

revoke all on table catalog.addon_usage_reservations
from public, anon, authenticated;

revoke all on table catalog.addon_usage_events
from public, anon, authenticated;

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
  source.product_key,
  feature.id,
  source.name_ar,
  source.name_en,
  source.description_ar,
  'contact_sales',
  0,
  'SAR',
  'month',
  14,
  source.usage_metric,
  null,
  'beta',
  source.sort_order
from (
  values
    (
      'whatsapp',
      'addon.integration.whatsapp',
      'إضافة واتساب',
      'WhatsApp Add-on',
      'إرسال واتساب بالقوالب المعتمدة وسجل التسليم.',
      'whatsapp_messages',
      10
    ),
    (
      'email',
      'addon.integration.email',
      'إضافة البريد',
      'Email Add-on',
      'إرسال البريد عبر Amazon SES أو Resend أو API مستقل.',
      'email_messages',
      20
    ),
    (
      'zoom',
      'addon.integration.zoom',
      'إضافة Zoom',
      'Zoom Add-on',
      'إنشاء اجتماعات الجلسات وربطها بالدفعات.',
      'zoom_meetings',
      30
    ),
    (
      'automation',
      'addon.automation.rules',
      'إضافة الأتمتة',
      'Automation Add-on',
      'قواعد حدث وشرط وإجراء مع القنوات البديلة.',
      'automation_runs',
      40
    ),
    (
      'templates',
      'addon.communication.templates',
      'إضافة القوالب المتقدمة',
      'Advanced Templates Add-on',
      'قوالب قابلة للتخصيص ومتغيرات آمنة.',
      'active_templates',
      50
    ),
    (
      'delivery_analytics',
      'addon.communication.delivery_analytics',
      'إضافة إثبات التسليم',
      'Delivery Analytics Add-on',
      'Webhooks موقعة وحالات التسليم والقراءة والتكلفة.',
      'delivery_events',
      60
    ),
    (
      'api',
      'addon.integration.api',
      'إضافة API',
      'API Add-on',
      'ربط أي مزود مستقل عبر Webhooks موقعة.',
      'api_calls',
      70
    )
) source(
  product_key,
  feature_key,
  name_ar,
  name_en,
  description_ar,
  usage_metric,
  sort_order
)
join catalog.features feature
  on feature.feature_key = source.feature_key
on conflict (product_key) do update
set feature_id = excluded.feature_id,
    name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    description_ar = excluded.description_ar,
    usage_metric = excluded.usage_metric,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function private_app.addon_entitlement(
  p_tenant_id uuid,
  p_feature_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_feature catalog.features%rowtype;
  v_product catalog.addon_products%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_override boolean;
  v_plan_enabled boolean;
  v_default_enabled boolean;
  v_enabled boolean := false;
  v_source text := 'none';
  v_status text := 'disabled';
  v_limit bigint;
  v_period_start date := date_trunc('month', now())::date;
  v_period_end date :=
    (date_trunc('month', now()) + interval '1 month')::date;
  v_used bigint := 0;
  v_reserved bigint := 0;
begin
  select * into v_feature
  from catalog.features feature
  where feature.feature_key = p_feature_key
  limit 1;
  if v_feature.id is null then
    return jsonb_build_object(
      'enabled', false,
      'source', 'missing',
      'status', 'disabled'
    );
  end if;

  select * into v_product
  from catalog.addon_products product
  where product.feature_id = v_feature.id
  limit 1;

  select (override.value #>> '{}')::boolean
  into v_override
  from catalog.tenant_feature_overrides override
  where override.tenant_id = p_tenant_id
    and override.feature_id = v_feature.id
  limit 1;

  select * into v_subscription
  from catalog.tenant_addon_subscriptions subscription
  where subscription.tenant_id = p_tenant_id
    and subscription.product_id = v_product.id
    and subscription.status in (
      'pending',
      'trialing',
      'active',
      'paused'
    )
  order by subscription.created_at desc
  limit 1;

  select (plan_feature.value #>> '{}')::boolean
  into v_plan_enabled
  from catalog.subscriptions subscription
  join catalog.plan_features plan_feature
    on plan_feature.plan_id = subscription.plan_id
  where subscription.tenant_id = p_tenant_id
    and subscription.status in ('trialing', 'active')
    and plan_feature.feature_id = v_feature.id
  order by subscription.created_at desc
  limit 1;

  begin
    v_default_enabled := (v_feature.default_value #>> '{}')::boolean;
  exception when others then
    v_default_enabled := false;
  end;

  if v_override is not null then
    v_enabled := v_override;
    v_source := 'override';
    v_status := case when v_override then 'active' else 'disabled' end;
  elsif coalesce(v_plan_enabled, false) then
    v_enabled := true;
    v_source := 'plan';
    v_status := 'included';
  elsif v_subscription.status = 'active' then
    v_enabled := true;
    v_source := 'subscription';
    v_status := 'active';
  elsif v_subscription.status = 'trialing'
        and coalesce(v_subscription.trial_end, now()) >= now() then
    v_enabled := true;
    v_source := 'subscription';
    v_status := 'trialing';
  elsif v_subscription.status is not null then
    v_source := 'subscription';
    v_status := v_subscription.status;
  elsif coalesce(v_default_enabled, false) then
    v_enabled := true;
    v_source := 'default';
    v_status := 'active';
  end if;

  v_limit := coalesce(
    v_subscription.custom_limit,
    v_product.default_limit
  );

  if v_product.usage_metric = 'automation_runs' then
    select count(*) into v_used
    from automation_engine.runs run
    where run.tenant_id = p_tenant_id
      and run.created_at >= v_period_start;
  elsif v_product.usage_metric = 'active_templates' then
    select count(*) into v_used
    from communication_hub.message_templates template
    where template.tenant_id = p_tenant_id
      and template.status = 'active';
  elsif v_product.usage_metric = 'delivery_events' then
    select count(*) into v_used
    from communication_hub.delivery_events event
    where event.tenant_id = p_tenant_id
      and event.occurred_at >= v_period_start;
  elsif v_product.id is not null then
    select
      coalesce(counter.used_quantity, 0),
      coalesce(counter.reserved_quantity, 0)
    into v_used, v_reserved
    from catalog.addon_usage_counters counter
    where counter.tenant_id = p_tenant_id
      and counter.product_id = v_product.id
      and counter.metric_key = v_product.usage_metric
      and counter.period_start = v_period_start;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'enabled', v_enabled,
    'source', v_source,
    'status', v_status,
    'featureKey', v_feature.feature_key,
    'productId', v_product.id,
    'productKey', v_product.product_key,
    'metricKey', v_product.usage_metric,
    'limit', v_limit,
    'used', coalesce(v_used, 0),
    'reserved', coalesce(v_reserved, 0),
    'remaining', case
      when v_limit is null then null
      else greatest(v_limit - coalesce(v_used, 0)
        - coalesce(v_reserved, 0), 0)
    end,
    'periodStart', v_period_start,
    'periodEnd', v_period_end,
    'trialEnd', v_subscription.trial_end,
    'subscriptionId', v_subscription.id
  ));
end;
$$;

revoke all on function private_app.addon_entitlement(uuid, text)
from public, anon, authenticated;

create or replace function private_app.tenant_addon_enabled(
  p_tenant_id uuid,
  p_feature_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      private_app.addon_entitlement(
        p_tenant_id,
        p_feature_key
      ) ->> 'enabled'
    )::boolean,
    false
  );
$$;

revoke all on function private_app.tenant_addon_enabled(uuid, text)
from public, anon, authenticated;

create or replace function private_app.finalize_addon_reservation(
  p_reservation_id uuid,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation catalog.addon_usage_reservations%rowtype;
begin
  if p_reservation_id is null then
    return jsonb_build_object('status', 'not_reserved');
  end if;
  if p_outcome not in ('consumed', 'released') then
    raise exception 'invalid_usage_outcome';
  end if;

  select * into v_reservation
  from catalog.addon_usage_reservations reservation
  where reservation.id = p_reservation_id
  for update;
  if v_reservation.id is null then
    raise exception 'usage_reservation_not_found';
  end if;
  if v_reservation.status <> 'reserved' then
    return jsonb_build_object(
      'reservationId', v_reservation.id,
      'status', v_reservation.status,
      'duplicate', true
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_reservation.tenant_id::text
      || ':' || v_reservation.product_id::text
      || ':' || v_reservation.metric_key
      || ':' || v_reservation.period_start::text,
    0
  ));

  update catalog.addon_usage_counters
  set reserved_quantity = greatest(
        reserved_quantity - v_reservation.quantity,
        0
      ),
      used_quantity = used_quantity + case
        when p_outcome = 'consumed'
          then v_reservation.quantity
        else 0
      end,
      updated_at = now()
  where tenant_id = v_reservation.tenant_id
    and product_id = v_reservation.product_id
    and metric_key = v_reservation.metric_key
    and period_start = v_reservation.period_start;

  update catalog.addon_usage_reservations
  set status = p_outcome,
      completed_at = now()
  where id = v_reservation.id
  returning * into v_reservation;

  if p_outcome = 'consumed' then
    insert into catalog.addon_usage_events (
      tenant_id,
      product_id,
      reservation_id,
      metric_key,
      quantity,
      idempotency_key,
      source_type,
      source_id
    )
    values (
      v_reservation.tenant_id,
      v_reservation.product_id,
      v_reservation.id,
      v_reservation.metric_key,
      v_reservation.quantity,
      v_reservation.idempotency_key,
      v_reservation.source_type,
      v_reservation.source_id
    )
    on conflict (tenant_id, product_id, idempotency_key)
    do nothing;
  end if;

  return jsonb_build_object(
    'reservationId', v_reservation.id,
    'status', v_reservation.status,
    'quantity', v_reservation.quantity,
    'duplicate', false
  );
end;
$$;

revoke all on function private_app.finalize_addon_reservation(uuid, text)
from public, anon, authenticated;

create or replace function public.v2_addon_usage_reserve(
  p_secret text,
  p_tenant_id uuid,
  p_feature_key text,
  p_metric_key text,
  p_idempotency_key text,
  p_source_type text,
  p_source_id text,
  p_quantity bigint default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entitlement jsonb;
  v_product_id uuid;
  v_metric_key text;
  v_limit bigint;
  v_period_start date := date_trunc('month', now())::date;
  v_period_end date :=
    (date_trunc('month', now()) + interval '1 month')::date;
  v_counter catalog.addon_usage_counters%rowtype;
  v_reservation catalog.addon_usage_reservations%rowtype;
  v_expired catalog.addon_usage_reservations%rowtype;
begin
  if not private_app.training_automation_secret_valid(p_secret) then
    raise exception 'forbidden';
  end if;
  if p_quantity < 1 or p_quantity > 1000000 then
    raise exception 'invalid_usage_quantity';
  end if;
  if nullif(trim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 240 then
    raise exception 'invalid_usage_idempotency_key';
  end if;

  v_entitlement := private_app.addon_entitlement(
    p_tenant_id,
    p_feature_key
  );
  if not coalesce((v_entitlement ->> 'enabled')::boolean, false) then
    raise exception 'addon_not_enabled';
  end if;
  v_product_id := (v_entitlement ->> 'productId')::uuid;
  v_metric_key := v_entitlement ->> 'metricKey';
  if v_product_id is null
     or v_metric_key <> p_metric_key then
    raise exception 'invalid_addon_usage_metric';
  end if;
  v_limit := nullif(v_entitlement ->> 'limit', '')::bigint;

  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text
      || ':' || v_product_id::text
      || ':' || v_metric_key
      || ':' || v_period_start::text,
    0
  ));

  for v_expired in
    select *
    from catalog.addon_usage_reservations reservation
    where reservation.tenant_id = p_tenant_id
      and reservation.product_id = v_product_id
      and reservation.metric_key = v_metric_key
      and reservation.period_start = v_period_start
      and reservation.status = 'reserved'
      and reservation.expires_at < now()
    for update
  loop
    update catalog.addon_usage_reservations
    set status = 'released',
        completed_at = now()
    where id = v_expired.id;
    update catalog.addon_usage_counters
    set reserved_quantity = greatest(
          reserved_quantity - v_expired.quantity,
          0
        ),
        updated_at = now()
    where tenant_id = p_tenant_id
      and product_id = v_product_id
      and metric_key = v_metric_key
      and period_start = v_period_start;
  end loop;

  insert into catalog.addon_usage_counters (
    tenant_id,
    product_id,
    metric_key,
    period_start,
    period_end
  )
  values (
    p_tenant_id,
    v_product_id,
    v_metric_key,
    v_period_start,
    v_period_end
  )
  on conflict (
    tenant_id,
    product_id,
    metric_key,
    period_start
  ) do nothing;

  select * into v_counter
  from catalog.addon_usage_counters counter
  where counter.tenant_id = p_tenant_id
    and counter.product_id = v_product_id
    and counter.metric_key = v_metric_key
    and counter.period_start = v_period_start
  for update;

  select * into v_reservation
  from catalog.addon_usage_reservations reservation
  where reservation.tenant_id = p_tenant_id
    and reservation.product_id = v_product_id
    and reservation.idempotency_key = p_idempotency_key
  for update;

  if v_reservation.status in ('reserved', 'consumed') then
    return jsonb_build_object(
      'reservationId', v_reservation.id,
      'status', v_reservation.status,
      'duplicate', true,
      'limit', v_limit,
      'used', v_counter.used_quantity,
      'reserved', v_counter.reserved_quantity
    );
  end if;

  if v_limit is not null
     and v_counter.used_quantity
       + v_counter.reserved_quantity
       + p_quantity > v_limit then
    raise exception 'addon_usage_limit_reached';
  end if;

  update catalog.addon_usage_counters
  set reserved_quantity = reserved_quantity + p_quantity,
      updated_at = now()
  where tenant_id = p_tenant_id
    and product_id = v_product_id
    and metric_key = v_metric_key
    and period_start = v_period_start
  returning * into v_counter;

  if v_reservation.id is null then
    insert into catalog.addon_usage_reservations (
      tenant_id,
      product_id,
      metric_key,
      idempotency_key,
      source_type,
      source_id,
      quantity,
      status,
      period_start,
      period_end,
      expires_at
    )
    values (
      p_tenant_id,
      v_product_id,
      v_metric_key,
      p_idempotency_key,
      p_source_type,
      p_source_id,
      p_quantity,
      'reserved',
      v_period_start,
      v_period_end,
      now() + interval '20 minutes'
    )
    returning * into v_reservation;
  else
    update catalog.addon_usage_reservations
    set status = 'reserved',
        quantity = p_quantity,
        source_type = p_source_type,
        source_id = p_source_id,
        expires_at = now() + interval '20 minutes',
        completed_at = null
    where id = v_reservation.id
    returning * into v_reservation;
  end if;

  return jsonb_build_object(
    'reservationId', v_reservation.id,
    'status', v_reservation.status,
    'duplicate', false,
    'limit', v_limit,
    'used', v_counter.used_quantity,
    'reserved', v_counter.reserved_quantity
  );
end;
$$;

revoke execute on function public.v2_addon_usage_reserve(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  bigint
) from public, anon, authenticated;

grant execute on function public.v2_addon_usage_reserve(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  bigint
) to service_role;

create or replace function public.v2_training_automation_complete_job_v3(
  p_secret text,
  p_job_id uuid,
  p_result_state text,
  p_external_id text default null,
  p_external_url text default null,
  p_error text default null,
  p_provider_connection_id uuid default null,
  p_provider_key text default null,
  p_usage_reservation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_usage jsonb;
begin
  v_result := public.v2_training_automation_complete_job_v2(
    p_secret,
    p_job_id,
    p_result_state,
    p_external_id,
    p_external_url,
    p_error,
    p_provider_connection_id,
    p_provider_key
  );
  v_usage := private_app.finalize_addon_reservation(
    p_usage_reservation_id,
    case
      when p_result_state in ('sent', 'ready') then 'consumed'
      else 'released'
    end
  );
  return v_result || jsonb_build_object('usage', v_usage);
end;
$$;

create or replace function public.v2_automation_complete_message_v2(
  p_secret text,
  p_job_id uuid,
  p_result_state text,
  p_external_id text default null,
  p_external_url text default null,
  p_error text default null,
  p_provider_connection_id uuid default null,
  p_provider_key text default null,
  p_usage_reservation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_usage jsonb;
begin
  v_result := public.v2_automation_complete_message(
    p_secret,
    p_job_id,
    p_result_state,
    p_external_id,
    p_external_url,
    p_error,
    p_provider_connection_id,
    p_provider_key
  );
  v_usage := private_app.finalize_addon_reservation(
    p_usage_reservation_id,
    case
      when p_result_state = 'sent' then 'consumed'
      else 'released'
    end
  );
  return v_result || jsonb_build_object('usage', v_usage);
end;
$$;

revoke execute on function public.v2_training_automation_complete_job_v3(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid
) from public, anon, authenticated;

revoke execute on function public.v2_automation_complete_message_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid
) from public, anon, authenticated;

grant execute on function public.v2_training_automation_complete_job_v3(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid
) to service_role;

grant execute on function public.v2_automation_complete_message_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid
) to service_role;

create or replace function public.v2_tenant_automation_studio_snapshot_v2(
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  if not private_app.tenant_addon_enabled(
    v_tenant_id,
    'addon.automation.rules'
  ) then
    return jsonb_build_object(
      'locked', true,
      'featureKey', 'addon.automation.rules',
      'viewer', jsonb_build_object('canManage', false),
      'summary', jsonb_build_object(
        'activeRules', 0,
        'pendingEvents', 0,
        'queuedMessages', 0,
        'previewRules', 0
      ),
      'rules', '[]'::jsonb,
      'recentRuns', '[]'::jsonb
    );
  end if;
  return public.v2_tenant_automation_studio_snapshot(p_slug);
end;
$$;

create or replace function public.v2_tenant_automation_studio_action_v2(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.tenant_addon_enabled(
    v_tenant_id,
    'addon.automation.rules'
  ) then raise exception 'addon_not_enabled'; end if;
  return public.v2_tenant_automation_studio_action(
    p_slug,
    p_action,
    p_payload
  );
end;
$$;

create or replace function public.v2_tenant_delivery_analytics_snapshot_v2(
  p_slug text,
  p_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  if not private_app.tenant_addon_enabled(
    v_tenant_id,
    'addon.communication.delivery_analytics'
  ) then
    return jsonb_build_object(
      'locked', true,
      'featureKey', 'addon.communication.delivery_analytics',
      'days', least(greatest(coalesce(p_days, 30), 1), 90),
      'viewer', jsonb_build_object('canManage', false),
      'summary', jsonb_build_object(
        'messages', 0,
        'deliveryRate', 0,
        'delivered', 0,
        'read', 0,
        'failed', 0,
        'costMinor', 0,
        'currency', 'SAR'
      ),
      'channels', '[]'::jsonb,
      'webhooks', '[]'::jsonb,
      'recentEvents', '[]'::jsonb
    );
  end if;
  return public.v2_tenant_delivery_analytics_snapshot(
    p_slug,
    p_days
  );
end;
$$;

create or replace function public.v2_tenant_delivery_analytics_action_v2(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.tenant_addon_enabled(
    v_tenant_id,
    'addon.communication.delivery_analytics'
  ) then raise exception 'addon_not_enabled'; end if;
  return public.v2_tenant_delivery_analytics_action(
    p_slug,
    p_action,
    p_payload
  );
end;
$$;

revoke execute on function
  public.v2_tenant_automation_studio_snapshot_v2(text)
from public, anon;

revoke execute on function
  public.v2_tenant_automation_studio_action_v2(text, text, jsonb)
from public, anon;

revoke execute on function
  public.v2_tenant_delivery_analytics_snapshot_v2(text, integer)
from public, anon;

revoke execute on function
  public.v2_tenant_delivery_analytics_action_v2(text, text, jsonb)
from public, anon;

grant execute on function
  public.v2_tenant_automation_studio_snapshot_v2(text)
to authenticated;

grant execute on function
  public.v2_tenant_automation_studio_action_v2(text, text, jsonb)
to authenticated;

grant execute on function
  public.v2_tenant_delivery_analytics_snapshot_v2(text, integer)
to authenticated;

grant execute on function
  public.v2_tenant_delivery_analytics_action_v2(text, text, jsonb)
to authenticated;

create or replace function public.v2_tenant_addon_center_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object('canManage', true),
    'summary', jsonb_build_object(
      'products', (select count(*) from catalog.addon_products
        where status in ('beta', 'active')),
      'enabled', (
        select count(*)
        from catalog.addon_products product
        join catalog.features feature on feature.id = product.feature_id
        where product.status in ('beta', 'active')
          and private_app.tenant_addon_enabled(
            v_tenant.id,
            feature.feature_key
          )
      ),
      'pending', (
        select count(*)
        from catalog.tenant_addon_subscriptions subscription
        where subscription.tenant_id = v_tenant.id
          and subscription.status = 'pending'
      ),
      'trialing', (
        select count(*)
        from catalog.tenant_addon_subscriptions subscription
        where subscription.tenant_id = v_tenant.id
          and subscription.status = 'trialing'
      )
    ),
    'products', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', product.id,
          'key', product.product_key,
          'featureKey', feature.feature_key,
          'name', product.name_ar,
          'description', product.description_ar,
          'pricingMode', product.pricing_mode,
          'amountMinor', product.amount_minor,
          'currency', product.currency,
          'interval', product.interval,
          'trialDays', product.trial_days,
          'metricKey', product.usage_metric,
          'defaultLimit', product.default_limit,
          'status', product.status,
          'entitlement',
            private_app.addon_entitlement(
              v_tenant.id,
              feature.feature_key
            )
        )
        order by product.sort_order
      )
      from catalog.addon_products product
      join catalog.features feature on feature.id = product.feature_id
      where product.status in ('beta', 'active')
    ), '[]'::jsonb),
    'recentUsage', coalesce((
      select jsonb_agg(usage_row.payload order by usage_row.occurred_at desc)
      from (
        select
          usage.occurred_at,
          jsonb_build_object(
            'id', usage.id,
            'productKey', product.product_key,
            'name', product.name_ar,
            'metricKey', usage.metric_key,
            'quantity', usage.quantity,
            'sourceType', usage.source_type,
            'occurredAt', usage.occurred_at
          ) as payload
        from catalog.addon_usage_events usage
        join catalog.addon_products product
          on product.id = usage.product_id
        where usage.tenant_id = v_tenant.id
        order by usage.occurred_at desc
        limit 30
      ) usage_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_addon_center_action(
  p_slug text,
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
  v_actor uuid;
  v_product catalog.addon_products%rowtype;
  v_feature catalog.features%rowtype;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_entitlement jsonb;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  select product.* into v_product
  from catalog.addon_products product
  where product.product_key = p_payload ->> 'productKey'
    and product.status in ('beta', 'active');
  if v_product.id is null then raise exception 'addon_product_not_found'; end if;
  select * into v_feature
  from catalog.features feature
  where feature.id = v_product.feature_id;
  v_entitlement := private_app.addon_entitlement(
    v_tenant.id,
    v_feature.feature_key
  );

  if p_action = 'request_trial' then
    if coalesce((v_entitlement ->> 'enabled')::boolean, false) then
      raise exception 'addon_already_enabled';
    end if;
    if v_product.trial_days = 0 then
      raise exception 'addon_trial_unavailable';
    end if;
    insert into catalog.tenant_addon_subscriptions (
      tenant_id,
      product_id,
      status,
      source,
      requested_note,
      requested_by_subject_id
    )
    values (
      v_tenant.id,
      v_product.id,
      'pending',
      'tenant_request',
      left(nullif(trim(p_payload ->> 'note'), ''), 500),
      v_actor
    )
    on conflict (tenant_id, product_id)
      where status in ('pending', 'trialing', 'active', 'paused')
    do update
    set requested_note = excluded.requested_note,
        requested_by_subject_id = excluded.requested_by_subject_id,
        updated_at = now()
    returning * into v_subscription;
  elsif p_action = 'cancel_request' then
    update catalog.tenant_addon_subscriptions subscription
    set status = 'cancelled',
        decision_note = 'cancelled_by_tenant'
    where subscription.tenant_id = v_tenant.id
      and subscription.product_id = v_product.id
      and subscription.status = 'pending'
    returning * into v_subscription;
    if v_subscription.id is null then
      raise exception 'addon_request_not_found';
    end if;
  else
    raise exception 'invalid_addon_action';
  end if;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_tenant.id,
    v_actor,
    'catalog.addon.' || p_action,
    'tenant_addon_subscription',
    v_subscription.id::text,
    jsonb_build_object(
      'productKey', v_product.product_key,
      'status', v_subscription.status
    )
  );

  return jsonb_build_object(
    'subscriptionId', v_subscription.id,
    'productKey', v_product.product_key,
    'status', v_subscription.status
  );
end;
$$;

create or replace function public.v2_platform_addon_center_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'summary', jsonb_build_object(
      'products', (select count(*) from catalog.addon_products
        where status in ('beta', 'active')),
      'pendingRequests', (
        select count(*)
        from catalog.tenant_addon_subscriptions
        where status = 'pending'
      ),
      'trialing', (
        select count(*)
        from catalog.tenant_addon_subscriptions
        where status = 'trialing'
      ),
      'activeStandalone', (
        select count(*)
        from catalog.tenant_addon_subscriptions
        where status = 'active'
      )
    ),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', product.id,
        'key', product.product_key,
        'featureKey', feature.feature_key,
        'name', product.name_ar,
        'description', product.description_ar,
        'pricingMode', product.pricing_mode,
        'amountMinor', product.amount_minor,
        'currency', product.currency,
        'interval', product.interval,
        'trialDays', product.trial_days,
        'metricKey', product.usage_metric,
        'defaultLimit', product.default_limit,
        'status', product.status
      ) order by product.sort_order)
      from catalog.addon_products product
      join catalog.features feature on feature.id = product.feature_id
    ), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', subscription.id,
        'tenantId', tenant.id,
        'tenantName', tenant.name,
        'tenantSlug', tenant.slug,
        'productKey', product.product_key,
        'productName', product.name_ar,
        'status', subscription.status,
        'source', subscription.source,
        'customLimit', subscription.custom_limit,
        'trialEnd', subscription.trial_end,
        'periodEnd', subscription.period_end,
        'requestedNote', subscription.requested_note,
        'decisionNote', subscription.decision_note,
        'createdAt', subscription.created_at
      ) order by
        case subscription.status when 'pending' then 0 else 1 end,
        subscription.created_at desc)
      from catalog.tenant_addon_subscriptions subscription
      join catalog.addon_products product
        on product.id = subscription.product_id
      join core.tenants tenant on tenant.id = subscription.tenant_id
      where subscription.status <> 'expired'
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_platform_addon_center_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_subscription catalog.tenant_addon_subscriptions%rowtype;
  v_product catalog.addon_products%rowtype;
  v_decision text;
  v_limit bigint;
begin
  if not private_app.has_platform_permission(
    'platform.billing.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  begin
    select * into v_subscription
    from catalog.tenant_addon_subscriptions subscription
    where subscription.id =
      (p_payload ->> 'subscriptionId')::uuid
    for update;
  exception when others then
    raise exception 'invalid_addon_subscription';
  end;
  if v_subscription.id is null then
    raise exception 'addon_subscription_not_found';
  end if;
  select * into v_product
  from catalog.addon_products product
  where product.id = v_subscription.product_id;

  if p_payload ? 'customLimit'
     and p_payload ->> 'customLimit' is not null then
    begin
      v_limit := (p_payload ->> 'customLimit')::bigint;
      if v_limit < 0 then raise exception 'invalid_addon_limit'; end if;
    exception when invalid_text_representation then
      raise exception 'invalid_addon_limit';
    end;
  else
    v_limit := v_subscription.custom_limit;
  end if;

  if p_action = 'decide_request' then
    if v_subscription.status <> 'pending' then
      raise exception 'addon_request_not_pending';
    end if;
    v_decision := p_payload ->> 'decision';
    if v_decision = 'approve_trial' then
      update catalog.tenant_addon_subscriptions
      set status = 'trialing',
          source = 'platform',
          custom_limit = v_limit,
          trial_start = now(),
          trial_end = now() + make_interval(
            days => v_product.trial_days
          ),
          period_start = now(),
          period_end = now() + make_interval(
            days => v_product.trial_days
          ),
          decision_note = left(
            nullif(trim(p_payload ->> 'note'), ''),
            500
          ),
          decided_by_subject_id = v_actor
      where id = v_subscription.id
      returning * into v_subscription;
    elsif v_decision = 'approve_active' then
      update catalog.tenant_addon_subscriptions
      set status = 'active',
          source = 'platform',
          custom_limit = v_limit,
          period_start = now(),
          period_end = case v_product.interval
            when 'year' then now() + interval '1 year'
            when 'one_time' then null
            else now() + interval '1 month'
          end,
          decision_note = left(
            nullif(trim(p_payload ->> 'note'), ''),
            500
          ),
          decided_by_subject_id = v_actor
      where id = v_subscription.id
      returning * into v_subscription;
    elsif v_decision = 'reject' then
      update catalog.tenant_addon_subscriptions
      set status = 'cancelled',
          decision_note = coalesce(
            left(nullif(trim(p_payload ->> 'note'), ''), 500),
            'rejected_by_platform'
          ),
          decided_by_subject_id = v_actor
      where id = v_subscription.id
      returning * into v_subscription;
    else
      raise exception 'invalid_addon_decision';
    end if;
  elsif p_action = 'set_limit' then
    if v_subscription.status not in (
      'trialing',
      'active',
      'paused'
    ) then raise exception 'invalid_addon_subscription_status'; end if;
    update catalog.tenant_addon_subscriptions
    set custom_limit = v_limit,
        decided_by_subject_id = v_actor
    where id = v_subscription.id
    returning * into v_subscription;
  elsif p_action in ('pause', 'resume', 'cancel') then
    update catalog.tenant_addon_subscriptions
    set status = case
          when p_action = 'pause' then 'paused'
          when p_action = 'resume' then 'active'
          else 'cancelled'
        end,
        decided_by_subject_id = v_actor,
        decision_note = left(
          nullif(trim(p_payload ->> 'note'), ''),
          500
        )
    where id = v_subscription.id
    returning * into v_subscription;
  else
    raise exception 'invalid_addon_action';
  end if;

  insert into audit_log.events (
    actor_subject_id,
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_actor,
    v_subscription.tenant_id,
    'catalog.addon.platform_' || p_action,
    'tenant_addon_subscription',
    v_subscription.id::text,
    jsonb_build_object(
      'productKey', v_product.product_key,
      'status', v_subscription.status,
      'customLimit', v_subscription.custom_limit
    )
  );

  return jsonb_build_object(
    'subscriptionId', v_subscription.id,
    'status', v_subscription.status,
    'customLimit', v_subscription.custom_limit
  );
end;
$$;

revoke execute on function public.v2_tenant_addon_center_snapshot(text)
from public, anon;

revoke execute on function public.v2_tenant_addon_center_action(
  text,
  text,
  jsonb
) from public, anon;

revoke execute on function public.v2_platform_addon_center_snapshot()
from public, anon;

revoke execute on function public.v2_platform_addon_center_action(
  text,
  jsonb
) from public, anon;

grant execute on function public.v2_tenant_addon_center_snapshot(text)
to authenticated;

grant execute on function public.v2_tenant_addon_center_action(
  text,
  text,
  jsonb
) to authenticated;

grant execute on function public.v2_platform_addon_center_snapshot()
to authenticated;

grant execute on function public.v2_platform_addon_center_action(
  text,
  jsonb
) to authenticated;

comment on table catalog.addon_products is
'Independently sellable add-ons linked to existing feature entitlement keys without duplicating modules.';

comment on table catalog.addon_usage_reservations is
'Crash-safe, idempotent quota reservation before an external provider call.';

comment on table catalog.addon_usage_events is
'Finalized usage ledger; simulations and failed provider calls are released rather than billed.';

commit;
