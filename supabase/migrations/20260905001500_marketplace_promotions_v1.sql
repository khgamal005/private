begin;

-- ODEIR native marketplace promotions v1.
-- Pricing is calculated and locked in PostgreSQL before any provider checkout.
-- A single permissioned operator manages campaigns; no second-person approval.

do $preflight$
begin
  if to_regclass('marketplace.orders') is null
     or to_regclass('marketplace.order_items') is null
     or to_regclass('marketplace.payment_attempts') is null
     or to_regclass('marketplace.bank_transfer_submissions') is null
     or to_regprocedure('private_app.marketplace_order_payload(uuid)') is null
     or to_regprocedure(
       'private_app.marketplace_record_payment(uuid,text,text,text,text,bigint,text,boolean,text,uuid)'
     ) is null
     or to_regprocedure(
       'public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'
     ) is null
     or to_regprocedure(
       'private_app.paymob_apply_paid_attempt_v1(uuid,text,text,text)'
     ) is null
     or to_regprocedure(
       'public.v2_tenant_marketplace_action(text,text,jsonb)'
     ) is null
     or to_regprocedure(
       'public.v2_tenant_service_marketplace_action(text,text,jsonb)'
     ) is null then
    raise exception 'marketplace_promotions_prerequisite_missing';
  end if;
  if to_regclass('marketplace.promotions') is not null
     or to_regclass('marketplace.promotion_redemptions') is not null then
    raise exception 'marketplace_promotions_partial_drift';
  end if;
end
$preflight$;

create table if not exists marketplace.promotions (
  id uuid primary key default gen_random_uuid(),
  code_key text not null unique,
  name_ar text not null,
  description_ar text,
  status text not null default 'draft' check (
    status in ('draft','active','paused','archived')
  ),
  discount_type text not null check (
    discount_type in ('percentage','fixed')
  ),
  discount_value bigint not null check (discount_value > 0),
  maximum_discount_minor bigint check (
    maximum_discount_minor is null or maximum_discount_minor > 0
  ),
  minimum_subtotal_minor bigint not null default 0 check (
    minimum_subtotal_minor >= 0
  ),
  budget_minor bigint check (budget_minor is null or budget_minor > 0),
  total_redemption_limit integer check (
    total_redemption_limit is null or total_redemption_limit > 0
  ),
  per_tenant_limit integer check (
    per_tenant_limit is null or per_tenant_limit > 0
  ),
  first_purchase_only boolean not null default false,
  currency text not null default 'SAR' check (currency = 'SAR'),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  applicable_order_kinds text[] not null default array['addon','service']::text[],
  applicable_product_keys text[] not null default '{}'::text[],
  applicable_tenant_ids uuid[] not null default '{}'::uuid[],
  applicable_payment_providers text[] not null default '{}'::text[],
  reservation_minutes integer not null default 30 check (
    reservation_minutes between 5 and 1440
  ),
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  activated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (code_key ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  check (
    (discount_type = 'percentage' and discount_value between 1 and 9999)
    or (discount_type = 'fixed' and discount_value > 0)
  ),
  check (ends_at is null or ends_at > starts_at),
  check (
    cardinality(applicable_order_kinds) between 1 and 2
    and applicable_order_kinds <@ array['addon','service']::text[]
  ),
  check (
    cardinality(applicable_payment_providers) = 0
    or applicable_payment_providers <@ array['paymob','bank_transfer']::text[]
  ),
  check (
    activated_at is null
    or (activated_by_subject_id is not null and status <> 'draft')
  )
);

create table if not exists marketplace.promotion_redemptions (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references marketplace.promotions(id) on delete restrict,
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  requested_by_subject_id uuid references access_control.subjects(id) on delete set null,
  status text not null default 'reserved' check (
    status in ('reserved','redeemed','released')
  ),
  code_key_snapshot text not null,
  terms_snapshot jsonb not null,
  base_subtotal_minor bigint not null check (base_subtotal_minor > 0),
  eligible_subtotal_minor bigint not null check (eligible_subtotal_minor > 0),
  discount_minor bigint not null check (
    discount_minor > 0 and discount_minor < base_subtotal_minor
  ),
  tax_minor_after bigint not null check (tax_minor_after >= 0),
  total_minor_after bigint not null check (total_minor_after > 0),
  currency text not null check (currency = 'SAR'),
  payment_provider_snapshot text,
  reserved_at timestamptz not null default now(),
  reservation_expires_at timestamptz not null,
  redeemed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reservation_expires_at > reserved_at),
  check (
    (status = 'reserved' and redeemed_at is null and released_at is null)
    or (status = 'redeemed' and redeemed_at is not null and released_at is null)
    or (status = 'released' and released_at is not null)
  )
);

alter table marketplace.orders
  add column if not exists list_subtotal_minor bigint,
  add column if not exists discount_minor bigint not null default 0,
  add column if not exists promotion_id uuid references marketplace.promotions(id) on delete restrict,
  add column if not exists promotion_code text;

update marketplace.orders
set list_subtotal_minor = subtotal_minor
where list_subtotal_minor is null;

alter table marketplace.orders
  alter column list_subtotal_minor set not null;

alter table marketplace.orders
  drop constraint if exists orders_promotion_pricing_integrity_v1;
alter table marketplace.orders
  add constraint orders_promotion_pricing_integrity_v1 check (
    list_subtotal_minor >= subtotal_minor
    and discount_minor = list_subtotal_minor - subtotal_minor
    and (
      (promotion_id is null and promotion_code is null and discount_minor = 0)
      or (
        promotion_id is not null
        and promotion_code is not null
        and discount_minor > 0
      )
    )
  ) not valid;
alter table marketplace.orders
  validate constraint orders_promotion_pricing_integrity_v1;

-- The existing Paymob ledger remains authoritative. Promotions only add a
-- deterministic net provider line and teach the immutable snapshot checks that
-- line items retain list prices while the order carries a separate discount.
-- Every patch is exact-count and fail-closed so schema drift cannot partially
-- modify a payment function.
do $patch_paymob_promotion_compatibility$
declare
  v_prepare text;
  v_settle text;
  v_target text;
  v_replacement text;
  v_count integer;
begin
  select pg_get_functiondef(
    'public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'::regprocedure
  ) into v_prepare;

  v_target := E'  ) line;\n  if jsonb_array_length(v_items) = 0';
  v_replacement := $promotion_paymob_items$
  ) line;
  -- ODEIR_PROMOTION_NET_PROVIDER_ITEMS_V1
  if v_order.discount_minor > 0 then
    v_items := jsonb_build_array(jsonb_build_object(
      'name','قيمة الطلب بعد الخصم',
      'amount',v_order.subtotal_minor,
      'description','ODEIR_PROMOTION_NET_SUBTOTAL',
      'quantity',1
    ));
    if v_order.tax_minor > 0 then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'name','ضريبة القيمة المضافة',
        'amount',v_order.tax_minor,
        'description','VAT',
        'quantity',1
      ));
    end if;
  end if;
  if jsonb_array_length(v_items) = 0$promotion_paymob_items$;
  v_count := (length(v_prepare)-length(replace(v_prepare,v_target,'')))
    / greatest(length(v_target),1);
  if v_count <> 1 then
    raise exception 'promotion_paymob_items_patch_target_%',v_count;
  end if;
  v_prepare := replace(v_prepare,v_target,v_replacement);

  v_target := ') <> v_attempt.subtotal_minor then';
  v_replacement := ') <> v_attempt.subtotal_minor + v_order.discount_minor then';
  v_count := (length(v_prepare)-length(replace(v_prepare,v_target,'')))
    / greatest(length(v_target),1);
  if v_count <> 1 then
    raise exception 'promotion_paymob_prepare_snapshot_patch_target_%',v_count;
  end if;
  v_prepare := replace(v_prepare,v_target,v_replacement);
  execute v_prepare;

  select pg_get_functiondef(
    'private_app.paymob_apply_paid_attempt_v1(uuid,text,text,text)'::regprocedure
  ) into v_settle;
  v_target := ') <> v_attempt.subtotal_minor then';
  v_replacement := ') <> v_attempt.subtotal_minor + v_order.discount_minor then';
  v_count := (length(v_settle)-length(replace(v_settle,v_target,'')))
    / greatest(length(v_target),1);
  if v_count <> 1 then
    raise exception 'promotion_paymob_settlement_snapshot_patch_target_%',v_count;
  end if;
  v_settle := replace(v_settle,v_target,v_replacement);
  execute v_settle;

  select pg_get_functiondef(
    'public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'::regprocedure
  ) into v_prepare;
  select pg_get_functiondef(
    'private_app.paymob_apply_paid_attempt_v1(uuid,text,text,text)'::regprocedure
  ) into v_settle;
  if position('ODEIR_PROMOTION_NET_PROVIDER_ITEMS_V1' in v_prepare) = 0
     or position(
       ') <> v_attempt.subtotal_minor + v_order.discount_minor then'
       in v_prepare
     ) = 0
     or position(
       ') <> v_attempt.subtotal_minor + v_order.discount_minor then'
       in v_settle
     ) = 0 then
    raise exception 'promotion_paymob_compatibility_postcondition_failed';
  end if;
end
$patch_paymob_promotion_compatibility$;

create or replace function private_app.marketplace_order_promotion_defaults_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.discount_minor := coalesce(new.discount_minor,0);
  if new.list_subtotal_minor is null then
    new.list_subtotal_minor := new.subtotal_minor + new.discount_minor;
  end if;
  return new;
end
$function$;

drop trigger if exists marketplace_order_promotion_defaults_v1
  on marketplace.orders;
create trigger marketplace_order_promotion_defaults_v1
before insert or update of subtotal_minor,discount_minor,list_subtotal_minor
on marketplace.orders
for each row execute function private_app.marketplace_order_promotion_defaults_v1();

create index if not exists promotions_status_window_idx
  on marketplace.promotions(status,starts_at,ends_at);
create unique index if not exists promotion_redemptions_one_open_per_order_idx
  on marketplace.promotion_redemptions(order_id)
  where status in ('reserved','redeemed');
create index if not exists promotion_redemptions_order_history_idx
  on marketplace.promotion_redemptions(order_id,created_at desc);
create index if not exists promotion_redemptions_campaign_status_idx
  on marketplace.promotion_redemptions(promotion_id,status,reservation_expires_at);
create index if not exists promotion_redemptions_tenant_campaign_idx
  on marketplace.promotion_redemptions(tenant_id,promotion_id,status);

alter table marketplace.promotions enable row level security;
alter table marketplace.promotions force row level security;
alter table marketplace.promotion_redemptions enable row level security;
alter table marketplace.promotion_redemptions force row level security;
revoke all on marketplace.promotions from public,anon,authenticated;
revoke all on marketplace.promotion_redemptions from public,anon,authenticated;

create or replace function private_app.marketplace_promotion_code_key(
  p_code text
)
returns text
language sql
immutable
strict
set search_path = ''
as $function$
  select upper(pg_catalog.btrim(p_code))
$function$;

create or replace function private_app.marketplace_promotion_attempt_active(
  p_order_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from marketplace.payment_attempts attempt
    where attempt.order_id = p_order_id
      and (
        attempt.status in (
          'creating_intention','intention_created','pending','unknown',
          'quarantined','paid'
        )
        or (
          attempt.status = 'prepared'
          and attempt.expires_at > now()
        )
        or (
          attempt.status = 'failed'
          and (
            attempt.provider_order_id is not null
            or attempt.provider_intention_id is not null
          )
          and coalesce(attempt.provider_expires_at,attempt.expires_at) > now()
        )
      )
  )
$function$;

create or replace function private_app.marketplace_promotion_transfer_active(
  p_order_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from marketplace.bank_transfer_submissions submission
    where submission.order_id = p_order_id
      and submission.status in ('pending','reviewing','approved')
  )
$function$;

create or replace function private_app.marketplace_release_expired_promotions_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row record;
  v_released integer := 0;
begin
  for v_row in
    select redemption.id,redemption.order_id,redemption.base_subtotal_minor,
           orders.tax_rate_bps,orders.tenant_id
    from marketplace.promotion_redemptions redemption
    join marketplace.orders orders on orders.id = redemption.order_id
    where redemption.status = 'reserved'
      and redemption.reservation_expires_at <= now()
      and orders.status = 'pending_payment'
      and orders.payment_status in ('pending','failed')
      and not private_app.marketplace_promotion_attempt_active(orders.id)
      and not private_app.marketplace_promotion_transfer_active(orders.id)
    order by redemption.reservation_expires_at
    for update of redemption,orders skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    update marketplace.orders
    set subtotal_minor = v_row.base_subtotal_minor,
        list_subtotal_minor = v_row.base_subtotal_minor,
        discount_minor = 0,
        tax_minor = round(
          v_row.base_subtotal_minor * v_row.tax_rate_bps / 10000.0
        )::bigint,
        total_minor = v_row.base_subtotal_minor + round(
          v_row.base_subtotal_minor * v_row.tax_rate_bps / 10000.0
        )::bigint,
        promotion_id = null,
        promotion_code = null,
        updated_at = now()
    where id = v_row.order_id;

    update marketplace.promotion_redemptions
    set status = 'released',released_at = now(),
        release_reason = 'reservation_expired',updated_at = now()
    where id = v_row.id and status = 'reserved';

    insert into marketplace.order_events(
      order_id,tenant_id,event_type,metadata
    ) values (
      v_row.order_id,v_row.tenant_id,'promotion_released',
      jsonb_build_object('reason','reservation_expired')
    );
    v_released := v_released + 1;
  end loop;
  return v_released;
end
$function$;

create or replace function private_app.marketplace_apply_promotion_v1(
  p_tenant_id uuid,
  p_order_id uuid,
  p_code text,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order marketplace.orders%rowtype;
  v_promotion marketplace.promotions%rowtype;
  v_existing marketplace.promotion_redemptions%rowtype;
  v_code text;
  v_base_subtotal bigint;
  v_eligible_subtotal bigint;
  v_discount bigint;
  v_net_subtotal bigint;
  v_tax bigint;
  v_total bigint;
  v_usage bigint;
  v_tenant_usage bigint;
  v_committed_discount bigint;
  v_terms jsonb;
begin
  perform private_app.marketplace_release_expired_promotions_v1(100);
  v_code := private_app.marketplace_promotion_code_key(p_code);
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$' then
    raise exception 'promotion_code_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('promotion:order:' || p_order_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('promotion:code:' || v_code,0));

  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = p_order_id and orders.tenant_id = p_tenant_id
  for update;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
  if exists (
    select 1 from core.tenants tenant
    where tenant.id = v_order.tenant_id
      and (tenant.slug = 'reef-skills' or tenant.tenant_key = 'tenant-reef-skills')
  ) then raise exception 'promotion_tenant_not_eligible'; end if;
  if v_order.status <> 'pending_payment'
     or v_order.payment_status not in ('pending','failed') then
    raise exception 'promotion_order_not_eligible';
  end if;
  if private_app.marketplace_promotion_attempt_active(v_order.id)
     or private_app.marketplace_promotion_transfer_active(v_order.id) then
    raise exception 'promotion_order_payment_locked';
  end if;

  select redemption.* into v_existing
  from marketplace.promotion_redemptions redemption
  where redemption.order_id = v_order.id
    and redemption.status in ('reserved','redeemed')
  order by redemption.created_at desc
  limit 1
  for update;

  if v_existing.id is not null and v_existing.status = 'redeemed' then
    raise exception 'promotion_order_already_redeemed';
  end if;
  if v_existing.id is not null and v_existing.status = 'reserved'
     and v_existing.code_key_snapshot = v_code
     and v_existing.reservation_expires_at > now() then
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object('promotionDuplicate',true);
  end if;

  v_base_subtotal := case
    when v_existing.id is not null then v_existing.base_subtotal_minor
    else v_order.list_subtotal_minor
  end;

  if v_existing.id is not null and v_existing.status = 'reserved' then
    update marketplace.promotion_redemptions
    set status = 'released',released_at = now(),
        release_reason = 'promotion_replaced',updated_at = now()
    where id = v_existing.id;
    update marketplace.orders
    set subtotal_minor = v_base_subtotal,
        list_subtotal_minor = v_base_subtotal,
        discount_minor = 0,
        tax_minor = round(v_base_subtotal * tax_rate_bps / 10000.0)::bigint,
        total_minor = v_base_subtotal
          + round(v_base_subtotal * tax_rate_bps / 10000.0)::bigint,
        promotion_id = null,promotion_code = null,updated_at = now()
    where id = v_order.id
    returning * into v_order;
  end if;

  select promotion.* into v_promotion
  from marketplace.promotions promotion
  where promotion.code_key = v_code
  for update;
  if v_promotion.id is null then raise exception 'promotion_code_not_found'; end if;
  if v_promotion.status <> 'active'
     or v_promotion.starts_at > now()
     or (v_promotion.ends_at is not null and v_promotion.ends_at <= now()) then
    raise exception 'promotion_code_inactive';
  end if;
  if v_promotion.currency <> v_order.currency then
    raise exception 'promotion_currency_mismatch';
  end if;
  if not (v_order.order_kind = any(v_promotion.applicable_order_kinds)) then
    raise exception 'promotion_scope_mismatch';
  end if;
  if cardinality(v_promotion.applicable_tenant_ids) > 0
     and not (v_order.tenant_id = any(v_promotion.applicable_tenant_ids)) then
    raise exception 'promotion_scope_mismatch';
  end if;
  if cardinality(v_promotion.applicable_payment_providers) > 0
     and (
       v_order.payment_provider is null
       or not (v_order.payment_provider = any(
         v_promotion.applicable_payment_providers
       ))
     ) then
    raise exception 'promotion_payment_provider_mismatch';
  end if;
  if v_base_subtotal < v_promotion.minimum_subtotal_minor then
    raise exception 'promotion_minimum_not_met';
  end if;
  if v_promotion.first_purchase_only and exists (
    select 1 from marketplace.orders paid_order
    where paid_order.tenant_id = v_order.tenant_id
      and paid_order.id <> v_order.id
      and paid_order.payment_status = 'paid'
  ) then
    raise exception 'promotion_first_purchase_only';
  end if;

  select coalesce(sum(item.line_total_minor),0)::bigint
  into v_eligible_subtotal
  from marketplace.order_items item
  where item.order_id = v_order.id
    and (
      cardinality(v_promotion.applicable_product_keys) = 0
      or item.product_key = any(v_promotion.applicable_product_keys)
    );
  if v_eligible_subtotal <= 0 then raise exception 'promotion_scope_mismatch'; end if;

  select count(*),
         count(*) filter (where redemption.tenant_id = v_order.tenant_id),
         coalesce(sum(redemption.discount_minor),0)
  into v_usage,v_tenant_usage,v_committed_discount
  from marketplace.promotion_redemptions redemption
  where redemption.promotion_id = v_promotion.id
    and (
      redemption.status = 'redeemed'
      or (
        redemption.status = 'reserved'
        and (
          redemption.reservation_expires_at > now()
          or private_app.marketplace_promotion_attempt_active(redemption.order_id)
          or private_app.marketplace_promotion_transfer_active(redemption.order_id)
        )
      )
    );

  if v_promotion.total_redemption_limit is not null
     and v_usage >= v_promotion.total_redemption_limit then
    raise exception 'promotion_usage_limit_reached';
  end if;
  if v_promotion.per_tenant_limit is not null
     and v_tenant_usage >= v_promotion.per_tenant_limit then
    raise exception 'promotion_tenant_limit_reached';
  end if;

  v_discount := case v_promotion.discount_type
    when 'percentage' then floor(
      v_eligible_subtotal * v_promotion.discount_value / 10000.0
    )::bigint
    else least(v_promotion.discount_value,v_eligible_subtotal)
  end;
  if v_promotion.maximum_discount_minor is not null then
    v_discount := least(v_discount,v_promotion.maximum_discount_minor);
  end if;
  v_discount := least(v_discount,v_base_subtotal - 1);
  if v_discount <= 0 then raise exception 'promotion_discount_not_applicable'; end if;
  if v_promotion.budget_minor is not null
     and v_committed_discount + v_discount > v_promotion.budget_minor then
    raise exception 'promotion_budget_exhausted';
  end if;

  v_net_subtotal := v_base_subtotal - v_discount;
  v_tax := round(v_net_subtotal * v_order.tax_rate_bps / 10000.0)::bigint;
  v_total := v_net_subtotal + v_tax;
  v_terms := jsonb_build_object(
    'schemaVersion',1,
    'code',v_promotion.code_key,
    'discountType',v_promotion.discount_type,
    'discountValue',v_promotion.discount_value,
    'maximumDiscountMinor',v_promotion.maximum_discount_minor,
    'minimumSubtotalMinor',v_promotion.minimum_subtotal_minor,
    'firstPurchaseOnly',v_promotion.first_purchase_only,
    'orderKinds',v_promotion.applicable_order_kinds,
    'productKeys',v_promotion.applicable_product_keys,
    'tenantIds',v_promotion.applicable_tenant_ids,
    'paymentProviders',v_promotion.applicable_payment_providers,
    'currency',v_promotion.currency
  );

  insert into marketplace.promotion_redemptions(
    promotion_id,order_id,tenant_id,requested_by_subject_id,status,
    code_key_snapshot,terms_snapshot,base_subtotal_minor,
    eligible_subtotal_minor,discount_minor,tax_minor_after,total_minor_after,
    currency,payment_provider_snapshot,reservation_expires_at
  ) values (
    v_promotion.id,v_order.id,v_order.tenant_id,p_actor,'reserved',
    v_promotion.code_key,v_terms,v_base_subtotal,v_eligible_subtotal,
    v_discount,v_tax,v_total,v_order.currency,v_order.payment_provider,
    now() + make_interval(mins => v_promotion.reservation_minutes)
  );

  update marketplace.orders
  set list_subtotal_minor = v_base_subtotal,
      subtotal_minor = v_net_subtotal,
      discount_minor = v_discount,
      tax_minor = v_tax,
      total_minor = v_total,
      promotion_id = v_promotion.id,
      promotion_code = v_promotion.code_key,
      updated_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into marketplace.order_events(
    order_id,tenant_id,actor_subject_id,event_type,metadata
  ) values (
    v_order.id,v_order.tenant_id,p_actor,'promotion_reserved',
    jsonb_build_object(
      'promotionId',v_promotion.id,'code',v_promotion.code_key,
      'discountMinor',v_discount,'totalMinor',v_total
    )
  );
  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_order.tenant_id,p_actor,'marketplace.promotion.reserved',
    'marketplace_order',v_order.id::text,
    jsonb_build_object(
      'promotionId',v_promotion.id,'code',v_promotion.code_key,
      'discountMinor',v_discount,'currency',v_order.currency,
      'singleAuthorizedOperator',true
    )
  );

  return private_app.marketplace_order_payload(v_order.id)
    || jsonb_build_object('promotionDuplicate',false);
end
$function$;

create or replace function private_app.marketplace_remove_promotion_v1(
  p_tenant_id uuid,
  p_order_id uuid,
  p_actor uuid,
  p_reason text default 'customer_removed'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order marketplace.orders%rowtype;
  v_redemption marketplace.promotion_redemptions%rowtype;
  v_base bigint;
  v_tax bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('promotion:order:' || p_order_id::text,0));
  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = p_order_id and orders.tenant_id = p_tenant_id
  for update;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
  if v_order.status <> 'pending_payment'
     or v_order.payment_status not in ('pending','failed') then
    raise exception 'promotion_order_not_eligible';
  end if;
  if private_app.marketplace_promotion_attempt_active(v_order.id)
     or private_app.marketplace_promotion_transfer_active(v_order.id) then
    raise exception 'promotion_order_payment_locked';
  end if;
  select redemption.* into v_redemption
  from marketplace.promotion_redemptions redemption
  where redemption.order_id = v_order.id
    and redemption.status in ('reserved','redeemed')
  order by redemption.created_at desc
  limit 1
  for update;
  if v_redemption.id is null then
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object('promotionRemoved',false);
  end if;
  if v_redemption.status = 'redeemed' then
    raise exception 'promotion_order_already_redeemed';
  end if;

  v_base := v_redemption.base_subtotal_minor;
  v_tax := round(v_base * v_order.tax_rate_bps / 10000.0)::bigint;
  update marketplace.promotion_redemptions
  set status = 'released',released_at = now(),
      release_reason = left(coalesce(nullif(btrim(p_reason),''),'customer_removed'),80),
      updated_at = now()
  where id = v_redemption.id;
  update marketplace.orders
  set list_subtotal_minor = v_base,subtotal_minor = v_base,
      discount_minor = 0,tax_minor = v_tax,total_minor = v_base + v_tax,
      promotion_id = null,promotion_code = null,updated_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into marketplace.order_events(
    order_id,tenant_id,actor_subject_id,event_type,metadata
  ) values (
    v_order.id,v_order.tenant_id,p_actor,'promotion_released',
    jsonb_build_object('reason',p_reason,'code',v_redemption.code_key_snapshot)
  );
  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_order.tenant_id,p_actor,'marketplace.promotion.released',
    'marketplace_order',v_order.id::text,
    jsonb_build_object(
      'promotionId',v_redemption.promotion_id,
      'code',v_redemption.code_key_snapshot,'reason',p_reason
    )
  );
  return private_app.marketplace_order_payload(v_order.id)
    || jsonb_build_object('promotionRemoved',true);
end
$function$;

-- Promotion settlement is enforced by an order trigger, so every existing
-- signed payment path remains untouched. Any mismatch aborts the entire payment
-- transaction before an order can become paid.
create or replace function private_app.marketplace_promotion_payment_settlement_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_redemption marketplace.promotion_redemptions%rowtype;
begin
  if new.payment_status = 'paid'
     and old.payment_status is distinct from new.payment_status then
    select redemption.* into v_redemption
    from marketplace.promotion_redemptions redemption
    where redemption.order_id = new.id
      and redemption.status in ('reserved','redeemed')
    order by redemption.created_at desc
    limit 1
    for update;

    if new.promotion_id is not null then
      if v_redemption.id is null
         or v_redemption.promotion_id <> new.promotion_id
         or v_redemption.code_key_snapshot <> new.promotion_code
         or v_redemption.tenant_id <> new.tenant_id
         or v_redemption.currency <> new.currency
         or v_redemption.discount_minor <> new.discount_minor
         or v_redemption.tax_minor_after <> new.tax_minor
         or v_redemption.total_minor_after <> new.total_minor
         or v_redemption.status <> 'reserved'
         or (
           v_redemption.reservation_expires_at <= now()
           and not private_app.marketplace_promotion_attempt_active(new.id)
           and not private_app.marketplace_promotion_transfer_active(new.id)
         ) then
        raise exception 'promotion_payment_binding_mismatch';
      end if;
      update marketplace.promotion_redemptions
      set status = 'redeemed',redeemed_at = now(),updated_at = now()
      where id = v_redemption.id;
      insert into marketplace.order_events(
        order_id,tenant_id,actor_subject_id,event_type,metadata
      ) values (
        new.id,new.tenant_id,private_app.current_subject_id(),
        'promotion_redeemed',
        jsonb_build_object(
          'promotionId',v_redemption.promotion_id,
          'code',v_redemption.code_key_snapshot,
          'discountMinor',v_redemption.discount_minor
        )
      );
    elsif v_redemption.id is not null and v_redemption.status = 'reserved' then
      raise exception 'promotion_payment_binding_mismatch';
    end if;
  end if;
  return new;
end
$function$;

drop trigger if exists marketplace_promotion_payment_settlement_v1
  on marketplace.orders;
create trigger marketplace_promotion_payment_settlement_v1
before update of payment_status on marketplace.orders
for each row execute function private_app.marketplace_promotion_payment_settlement_v1();

-- Redemption money/terms are append-only. Only bounded lifecycle transitions
-- are allowed; released records remain historical evidence.
create or replace function private_app.marketplace_promotion_redemption_integrity_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'promotion_redemption_delete_forbidden';
  end if;
  if old.status = 'redeemed' then
    raise exception 'promotion_redemption_immutable';
  end if;
  if old.promotion_id <> new.promotion_id
     or old.order_id <> new.order_id
     or old.tenant_id <> new.tenant_id
     or old.requested_by_subject_id is distinct from new.requested_by_subject_id
     or old.code_key_snapshot <> new.code_key_snapshot
     or old.terms_snapshot <> new.terms_snapshot
     or old.base_subtotal_minor <> new.base_subtotal_minor
     or old.eligible_subtotal_minor <> new.eligible_subtotal_minor
     or old.discount_minor <> new.discount_minor
     or old.tax_minor_after <> new.tax_minor_after
     or old.total_minor_after <> new.total_minor_after
     or old.currency <> new.currency
     or old.payment_provider_snapshot is distinct from new.payment_provider_snapshot
     or old.reserved_at <> new.reserved_at
     or old.reservation_expires_at <> new.reservation_expires_at
     or old.created_at <> new.created_at then
    raise exception 'promotion_redemption_immutable';
  end if;
  if old.status = 'reserved' and new.status not in ('reserved','redeemed','released') then
    raise exception 'promotion_redemption_transition_invalid';
  end if;
  if old.status = 'released' and new.status <> 'released' then
    raise exception 'promotion_redemption_transition_invalid';
  end if;
  return new;
end
$function$;

drop trigger if exists marketplace_promotion_redemption_integrity_v1
  on marketplace.promotion_redemptions;
create trigger marketplace_promotion_redemption_integrity_v1
before update or delete on marketplace.promotion_redemptions
for each row execute function private_app.marketplace_promotion_redemption_integrity_v1();

-- Release capacity automatically when an unpaid order is cancelled. A refund
-- deliberately does not restore promo capacity because the discount was used.
create or replace function private_app.marketplace_promotion_order_status_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'cancelled' and old.status is distinct from new.status then
    update marketplace.promotion_redemptions
    set status = 'released',released_at = now(),
        release_reason = 'order_cancelled',updated_at = now()
    where order_id = new.id and status = 'reserved';
  end if;
  return new;
end
$function$;

drop trigger if exists marketplace_promotion_order_status_v1
  on marketplace.orders;
create trigger marketplace_promotion_order_status_v1
after update of status on marketplace.orders
for each row execute function private_app.marketplace_promotion_order_status_v1();

-- Reject bank-transfer evidence if a promotion reservation has expired or its
-- immutable amount binding does not match the order being submitted.
create or replace function private_app.marketplace_promotion_transfer_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order marketplace.orders%rowtype;
  v_redemption marketplace.promotion_redemptions%rowtype;
begin
  select orders.* into v_order
  from marketplace.orders orders where orders.id = new.order_id for update;
  if v_order.id is null or v_order.tenant_id <> new.tenant_id then
    raise exception 'marketplace_order_not_found';
  end if;
  if new.amount_minor <> v_order.total_minor or new.currency <> v_order.currency then
    raise exception 'marketplace_payment_amount_mismatch';
  end if;
  if v_order.promotion_id is not null then
    select redemption.* into v_redemption
    from marketplace.promotion_redemptions redemption
    where redemption.order_id = v_order.id
      and redemption.status = 'reserved'
    order by redemption.created_at desc
    limit 1
    for update;
    if v_redemption.id is null
       or v_redemption.reservation_expires_at <= now()
       or v_redemption.promotion_id <> v_order.promotion_id
       or v_redemption.code_key_snapshot <> v_order.promotion_code
       or v_redemption.discount_minor <> v_order.discount_minor
       or v_redemption.tax_minor_after <> v_order.tax_minor
       or v_redemption.total_minor_after <> v_order.total_minor
       or v_redemption.payment_provider_snapshot is distinct from 'bank_transfer' then
      raise exception 'promotion_reservation_expired';
    end if;
  end if;
  return new;
end
$function$;

drop trigger if exists marketplace_promotion_transfer_guard_v1
  on marketplace.bank_transfer_submissions;
create trigger marketplace_promotion_transfer_guard_v1
before insert on marketplace.bank_transfer_submissions
for each row execute function private_app.marketplace_promotion_transfer_guard_v1();

-- Extend the canonical payload without exposing campaign targeting or usage
-- internals. The code and discount shown here are already bound to the order.
create or replace function private_app.marketplace_order_payload(p_order_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_build_object(
    'id',orders.id,
    'orderNumber',orders.order_number,
    'tenantId',orders.tenant_id,
    'kind',orders.order_kind,
    'status',orders.status,
    'paymentStatus',orders.payment_status,
    'activationState',orders.activation_state,
    'currency',orders.currency,
    'listSubtotalMinor',orders.list_subtotal_minor,
    'subtotalMinor',orders.subtotal_minor,
    'discountMinor',orders.discount_minor,
    'taxMinor',orders.tax_minor,
    'totalMinor',orders.total_minor,
    'notes',orders.notes,
    'paymentProvider',orders.payment_provider,
    'paymentReference',orders.payment_reference,
    'paidAt',orders.paid_at,
    'createdAt',orders.created_at,
    'updatedAt',orders.updated_at,
    'promotion',case when orders.promotion_id is null then null else (
      select jsonb_build_object(
        'id',redemption.promotion_id,
        'code',redemption.code_key_snapshot,
        'status',redemption.status,
        'discountMinor',redemption.discount_minor,
        'reservedUntil',redemption.reservation_expires_at,
        'redeemedAt',redemption.redeemed_at
      )
      from marketplace.promotion_redemptions redemption
      where redemption.order_id = orders.id
        and redemption.status in ('reserved','redeemed')
      order by redemption.created_at desc
      limit 1
    ) end,
    'items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',item.id,
        'type',item.item_type,
        'productKey',item.product_key,
        'name',item.product_name_ar,
        'quantity',item.quantity,
        'unitAmountMinor',item.unit_amount_minor,
        'lineTotalMinor',item.line_total_minor,
        'metadata',item.metadata
      ) order by item.created_at)
      from marketplace.order_items item
      where item.order_id=orders.id
    ),'[]'::jsonb)
  )
  from marketplace.orders orders
  where orders.id=p_order_id
$function$;

-- Additive tenant RPCs keep the existing marketplace actions untouched.
-- When a code is supplied during checkout, order creation and reservation share
-- one PostgreSQL transaction and therefore either both commit or both roll back.
create or replace function public.v1_tenant_marketplace_promotion_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_order_id uuid;
begin
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();
  begin
    v_order_id := (p_payload ->> 'orderId')::uuid;
  exception when others then
    raise exception 'marketplace_order_invalid';
  end;
  if p_action = 'apply_promotion' then
    return private_app.marketplace_apply_promotion_v1(
      v_tenant.id,v_order_id,p_payload ->> 'code',v_actor
    );
  elsif p_action = 'remove_promotion' then
    return private_app.marketplace_remove_promotion_v1(
      v_tenant.id,v_order_id,v_actor,'customer_removed'
    );
  end if;
  raise exception 'promotion_action_invalid';
end
$function$;

create or replace function public.v1_tenant_marketplace_create_order_with_promotion(
  p_slug text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_result jsonb;
  v_order_id uuid;
  v_code text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'marketplace_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();
  v_code := nullif(pg_catalog.btrim(p_payload ->> 'promotionCode'),'');
  if v_code is null then raise exception 'promotion_code_invalid'; end if;
  v_result := public.v2_tenant_marketplace_action(
    p_slug,'create_order',p_payload - 'promotionCode'
  );
  begin
    v_order_id := coalesce(
      nullif(v_result ->> 'id',''),nullif(v_result ->> 'orderId','')
    )::uuid;
  exception when others then
    raise exception 'marketplace_order_result_invalid';
  end;
  return private_app.marketplace_apply_promotion_v1(
    v_tenant.id,v_order_id,v_code,v_actor
  ) || jsonb_build_object(
    'duplicate',coalesce((v_result ->> 'duplicate')::boolean,false)
  );
end
$function$;

create or replace function public.v1_tenant_service_marketplace_create_order_with_promotion(
  p_slug text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_result jsonb;
  v_order_id uuid;
  v_code text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'marketplace_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();
  v_code := nullif(pg_catalog.btrim(p_payload ->> 'promotionCode'),'');
  if v_code is null then raise exception 'promotion_code_invalid'; end if;
  v_result := public.v2_tenant_service_marketplace_action(
    p_slug,'create_service_order',p_payload - 'promotionCode'
  );
  begin
    v_order_id := coalesce(
      nullif(v_result ->> 'id',''),nullif(v_result ->> 'orderId','')
    )::uuid;
  exception when others then
    raise exception 'marketplace_order_result_invalid';
  end;
  return private_app.marketplace_apply_promotion_v1(
    v_tenant.id,v_order_id,v_code,v_actor
  ) || jsonb_build_object(
    'duplicate',coalesce((v_result ->> 'duplicate')::boolean,false)
  );
end
$function$;

-- Guard every Paymob attempt at the ledger boundary rather than replacing
-- the mature checkout RPC. This covers both initial preparation and resume.
create or replace function private_app.marketplace_promotion_payment_attempt_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order marketplace.orders%rowtype;
  v_redemption marketplace.promotion_redemptions%rowtype;
  v_payment_providers text[];
begin
  select orders.* into v_order
  from marketplace.orders orders where orders.id = new.order_id for update;
  if v_order.id is null or v_order.tenant_id <> new.tenant_id then
    raise exception 'marketplace_order_not_found';
  end if;
  if new.amount_minor <> v_order.total_minor
     or new.currency <> v_order.currency then
    raise exception 'marketplace_payment_amount_mismatch';
  end if;
  if v_order.promotion_id is not null then
    select redemption.* into v_redemption
    from marketplace.promotion_redemptions redemption
    where redemption.order_id = v_order.id
      and redemption.status in ('reserved','redeemed')
    order by redemption.created_at desc
    limit 1
    for update;
    select coalesce(array_agg(value),'{}'::text[]) into v_payment_providers
    from jsonb_array_elements_text(
      coalesce(v_redemption.terms_snapshot -> 'paymentProviders','[]'::jsonb)
    ) value;
    if v_redemption.id is null
       or v_redemption.promotion_id <> v_order.promotion_id
       or v_redemption.code_key_snapshot <> v_order.promotion_code
       or v_redemption.discount_minor <> v_order.discount_minor
       or v_redemption.tax_minor_after <> v_order.tax_minor
       or v_redemption.total_minor_after <> v_order.total_minor
       or (
         v_redemption.status = 'reserved'
         and v_redemption.reservation_expires_at <= now()
         and not private_app.marketplace_promotion_attempt_active(v_order.id)
       )
       or (
         v_redemption.status = 'redeemed'
         and (
           v_order.payment_status not in ('paid','refunded')
           or new.status not in ('paid','refunded')
         )
       )
       or (
         cardinality(v_payment_providers) > 0
         and not ('paymob' = any(v_payment_providers))
       ) then
      raise exception 'promotion_reservation_expired';
    end if;
  end if;
  return new;
end
$function$;

drop trigger if exists marketplace_promotion_payment_attempt_guard_v1
  on marketplace.payment_attempts;
create trigger marketplace_promotion_payment_attempt_guard_v1
before insert or update of status,amount_minor,currency
on marketplace.payment_attempts
for each row execute function private_app.marketplace_promotion_payment_attempt_guard_v1();

-- Platform campaign management: one permissioned operator acts directly.
create or replace function public.v1_platform_marketplace_promotions_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  return jsonb_build_object(
    'generatedAt',now(),
    'summary',jsonb_build_object(
      'total',(select count(*) from marketplace.promotions),
      'active',(select count(*) from marketplace.promotions where status='active'),
      'reserved',(select count(*) from marketplace.promotion_redemptions where status='reserved'),
      'redeemed',(select count(*) from marketplace.promotion_redemptions where status='redeemed'),
      'discountMinor',(select coalesce(sum(discount_minor),0) from marketplace.promotion_redemptions where status='redeemed'),
      'revenueMinor',(select coalesce(sum(total_minor_after),0) from marketplace.promotion_redemptions where status='redeemed')
    ),
    'promotions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',promotion.id,'code',promotion.code_key,
        'name',promotion.name_ar,'description',promotion.description_ar,
        'status',promotion.status,'discountType',promotion.discount_type,
        'discountValue',promotion.discount_value,
        'maximumDiscountMinor',promotion.maximum_discount_minor,
        'minimumSubtotalMinor',promotion.minimum_subtotal_minor,
        'budgetMinor',promotion.budget_minor,
        'totalRedemptionLimit',promotion.total_redemption_limit,
        'perTenantLimit',promotion.per_tenant_limit,
        'firstPurchaseOnly',promotion.first_purchase_only,
        'currency',promotion.currency,'startsAt',promotion.starts_at,
        'endsAt',promotion.ends_at,'orderKinds',promotion.applicable_order_kinds,
        'productKeys',promotion.applicable_product_keys,
        'tenantIds',promotion.applicable_tenant_ids,
        'paymentProviders',promotion.applicable_payment_providers,
        'reservationMinutes',promotion.reservation_minutes,
        'createdAt',promotion.created_at,'updatedAt',promotion.updated_at,
        'usage',jsonb_build_object(
          'reserved',(select count(*) from marketplace.promotion_redemptions r where r.promotion_id=promotion.id and r.status='reserved'),
          'redeemed',(select count(*) from marketplace.promotion_redemptions r where r.promotion_id=promotion.id and r.status='redeemed'),
          'released',(select count(*) from marketplace.promotion_redemptions r where r.promotion_id=promotion.id and r.status='released'),
          'discountMinor',(select coalesce(sum(r.discount_minor),0) from marketplace.promotion_redemptions r where r.promotion_id=promotion.id and r.status='redeemed'),
          'revenueMinor',(select coalesce(sum(r.total_minor_after),0) from marketplace.promotion_redemptions r where r.promotion_id=promotion.id and r.status='redeemed')
        )
      ) order by promotion.created_at desc)
      from marketplace.promotions promotion
    ),'[]'::jsonb),
    'tenants',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',tenant.id,'name',tenant.name,'slug',tenant.slug
      ) order by tenant.name)
      from core.tenants tenant
      where tenant.slug is distinct from 'reef-skills'
    ),'[]'::jsonb),
    'products',coalesce((
      select jsonb_agg(product order by product ->> 'name')
      from (
        select jsonb_build_object(
          'key',addon.product_key,'name',addon.name_ar,'kind','addon'
        ) product
        from catalog.addon_products addon
        where addon.status in ('beta','active')
        union all
        select jsonb_build_object(
          'key',service.product_key,'name',service.name_ar,'kind','service'
        ) product
        from marketplace.service_products service
        where service.status in ('beta','active')
      ) products
    ),'[]'::jsonb)
  );
end
$function$;

create or replace function public.v1_platform_marketplace_promotion_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_id uuid;
  v_existing marketplace.promotions%rowtype;
  v_saved marketplace.promotions%rowtype;
  v_code text;
  v_name text;
  v_description text;
  v_status text;
  v_discount_type text;
  v_discount_value bigint;
  v_maximum_discount bigint;
  v_minimum_subtotal bigint;
  v_budget bigint;
  v_total_limit integer;
  v_tenant_limit integer;
  v_first_only boolean;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_order_kinds text[];
  v_product_keys text[];
  v_tenant_ids uuid[];
  v_payment_providers text[];
  v_reservation_minutes integer;
  v_has_history boolean;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;

  if p_action = 'save_promotion' then
    begin
      v_id := nullif(p_payload ->> 'id','')::uuid;
      v_discount_value := (p_payload ->> 'discountValue')::bigint;
      v_maximum_discount := nullif(p_payload ->> 'maximumDiscountMinor','')::bigint;
      v_minimum_subtotal := coalesce(nullif(p_payload ->> 'minimumSubtotalMinor','')::bigint,0);
      v_budget := nullif(p_payload ->> 'budgetMinor','')::bigint;
      v_total_limit := nullif(p_payload ->> 'totalRedemptionLimit','')::integer;
      v_tenant_limit := nullif(p_payload ->> 'perTenantLimit','')::integer;
      v_first_only := coalesce((p_payload ->> 'firstPurchaseOnly')::boolean,false);
      v_starts_at := coalesce(nullif(p_payload ->> 'startsAt','')::timestamptz,now());
      v_ends_at := nullif(p_payload ->> 'endsAt','')::timestamptz;
      v_reservation_minutes := coalesce((p_payload ->> 'reservationMinutes')::integer,30);
      select coalesce(array_agg(distinct value order by value),'{}'::text[])
        into v_order_kinds
      from jsonb_array_elements_text(coalesce(p_payload -> 'orderKinds','["addon","service"]'::jsonb)) value;
      select coalesce(array_agg(distinct lower(btrim(value)) order by lower(btrim(value))),'{}'::text[])
        into v_product_keys
      from jsonb_array_elements_text(coalesce(p_payload -> 'productKeys','[]'::jsonb)) value
      where btrim(value) <> '';
      select coalesce(array_agg(distinct value::uuid order by value::uuid),'{}'::uuid[])
        into v_tenant_ids
      from jsonb_array_elements_text(coalesce(p_payload -> 'tenantIds','[]'::jsonb)) value;
      select coalesce(array_agg(distinct lower(btrim(value)) order by lower(btrim(value))),'{}'::text[])
        into v_payment_providers
      from jsonb_array_elements_text(coalesce(p_payload -> 'paymentProviders','[]'::jsonb)) value
      where btrim(value) <> '';
    exception when others then
      raise exception 'promotion_payload_invalid';
    end;
    v_code := private_app.marketplace_promotion_code_key(p_payload ->> 'code');
    v_name := btrim(coalesce(p_payload ->> 'name',''));
    v_description := nullif(btrim(p_payload ->> 'description'),'');
    v_status := lower(btrim(coalesce(p_payload ->> 'status','draft')));
    v_discount_type := lower(btrim(coalesce(p_payload ->> 'discountType','')));

    if v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'
       or length(v_name) not between 2 and 160
       or v_status not in ('draft','active','paused','archived')
       or v_discount_type not in ('percentage','fixed')
       or v_discount_value <= 0
       or (v_discount_type='percentage' and v_discount_value >= 10000)
       or v_minimum_subtotal < 0
       or (v_maximum_discount is not null and v_maximum_discount <= 0)
       or (v_budget is not null and v_budget <= 0)
       or (v_total_limit is not null and v_total_limit <= 0)
       or (v_tenant_limit is not null and v_tenant_limit <= 0)
       or v_reservation_minutes not between 5 and 1440
       or cardinality(v_order_kinds) = 0
       or not (v_order_kinds <@ array['addon','service']::text[])
       or not (v_payment_providers <@ array['paymob','bank_transfer']::text[])
       or (v_ends_at is not null and v_ends_at <= v_starts_at) then
      raise exception 'promotion_payload_invalid';
    end if;
    if exists (
      select 1 from unnest(v_tenant_ids) target(id)
      where not exists (
        select 1 from core.tenants tenant
        where tenant.id = target.id and tenant.slug is distinct from 'reef-skills'
      )
    ) then raise exception 'promotion_tenant_scope_invalid'; end if;
    if exists (
      select 1 from unnest(v_product_keys) target(product_key)
      where not exists (
        select 1 from catalog.addon_products addon
        where addon.product_key = target.product_key
        union all
        select 1 from marketplace.service_products service
        where service.product_key = target.product_key
      )
    ) then raise exception 'promotion_product_scope_invalid'; end if;

    if v_id is null then
      insert into marketplace.promotions(
        code_key,name_ar,description_ar,status,discount_type,discount_value,
        maximum_discount_minor,minimum_subtotal_minor,budget_minor,
        total_redemption_limit,per_tenant_limit,first_purchase_only,
        starts_at,ends_at,applicable_order_kinds,applicable_product_keys,
        applicable_tenant_ids,applicable_payment_providers,reservation_minutes,
        created_by_subject_id,updated_by_subject_id,activated_by_subject_id,
        activated_at
      ) values (
        v_code,v_name,v_description,v_status,v_discount_type,v_discount_value,
        v_maximum_discount,v_minimum_subtotal,v_budget,v_total_limit,
        v_tenant_limit,v_first_only,v_starts_at,v_ends_at,v_order_kinds,
        v_product_keys,v_tenant_ids,v_payment_providers,v_reservation_minutes,
        v_actor,v_actor,case when v_status='active' then v_actor else null end,
        case when v_status='active' then now() else null end
      ) returning * into v_saved;
    else
      select promotion.* into v_existing
      from marketplace.promotions promotion where promotion.id = v_id for update;
      if v_existing.id is null then raise exception 'promotion_not_found'; end if;
      select exists (
        select 1 from marketplace.promotion_redemptions redemption
        where redemption.promotion_id = v_existing.id
      ) into v_has_history;
      if v_has_history and (
        v_existing.code_key <> v_code
        or v_existing.discount_type <> v_discount_type
        or v_existing.discount_value <> v_discount_value
        or v_existing.maximum_discount_minor is distinct from v_maximum_discount
        or v_existing.minimum_subtotal_minor <> v_minimum_subtotal
        or v_existing.budget_minor is distinct from v_budget
        or v_existing.total_redemption_limit is distinct from v_total_limit
        or v_existing.per_tenant_limit is distinct from v_tenant_limit
        or v_existing.first_purchase_only <> v_first_only
        or v_existing.starts_at <> v_starts_at
        or v_existing.applicable_order_kinds <> v_order_kinds
        or v_existing.applicable_product_keys <> v_product_keys
        or v_existing.applicable_tenant_ids <> v_tenant_ids
        or v_existing.applicable_payment_providers <> v_payment_providers
        or v_existing.reservation_minutes <> v_reservation_minutes
      ) then raise exception 'promotion_terms_locked'; end if;
      update marketplace.promotions
      set code_key = v_code,name_ar = v_name,description_ar = v_description,
          status = v_status,discount_type = v_discount_type,
          discount_value = v_discount_value,
          maximum_discount_minor = v_maximum_discount,
          minimum_subtotal_minor = v_minimum_subtotal,budget_minor = v_budget,
          total_redemption_limit = v_total_limit,per_tenant_limit = v_tenant_limit,
          first_purchase_only = v_first_only,starts_at = v_starts_at,
          ends_at = v_ends_at,applicable_order_kinds = v_order_kinds,
          applicable_product_keys = v_product_keys,
          applicable_tenant_ids = v_tenant_ids,
          applicable_payment_providers = v_payment_providers,
          reservation_minutes = v_reservation_minutes,
          updated_by_subject_id = v_actor,
          activated_by_subject_id = case
            when v_status='active' and activated_by_subject_id is null then v_actor
            else activated_by_subject_id end,
          activated_at = case
            when v_status='active' and activated_at is null then now()
            else activated_at end,
          updated_at = now()
      where id = v_existing.id returning * into v_saved;
    end if;

    insert into audit_log.events(
      actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_actor,'marketplace.promotion.saved','promotion',v_saved.id::text,
      jsonb_build_object(
        'code',v_saved.code_key,'status',v_saved.status,
        'discountType',v_saved.discount_type,
        'singleAuthorizedOperator',true
      )
    );
    return jsonb_build_object(
      'id',v_saved.id,'code',v_saved.code_key,'status',v_saved.status,
      'updatedAt',v_saved.updated_at
    );

  elsif p_action = 'set_status' then
    begin v_id := (p_payload ->> 'id')::uuid;
    exception when others then raise exception 'promotion_payload_invalid'; end;
    v_status := lower(btrim(coalesce(p_payload ->> 'status','')));
    if v_status not in ('active','paused','archived') then
      raise exception 'promotion_status_invalid';
    end if;
    select promotion.* into v_existing
    from marketplace.promotions promotion where promotion.id = v_id for update;
    if v_existing.id is null then raise exception 'promotion_not_found'; end if;
    if v_status='active' and (
      v_existing.ends_at is not null and v_existing.ends_at <= now()
    ) then raise exception 'promotion_code_inactive'; end if;
    update marketplace.promotions
    set status = v_status,updated_by_subject_id = v_actor,
        activated_by_subject_id = case when v_status='active' then v_actor else activated_by_subject_id end,
        activated_at = case when v_status='active' then coalesce(activated_at,now()) else activated_at end,
        updated_at = now()
    where id = v_id returning * into v_saved;
    insert into audit_log.events(
      actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_actor,'marketplace.promotion.status_changed','promotion',v_saved.id::text,
      jsonb_build_object('code',v_saved.code_key,'status',v_saved.status)
    );
    return jsonb_build_object(
      'id',v_saved.id,'code',v_saved.code_key,'status',v_saved.status,
      'updatedAt',v_saved.updated_at
    );

  elsif p_action = 'delete_draft' then
    begin v_id := (p_payload ->> 'id')::uuid;
    exception when others then raise exception 'promotion_payload_invalid'; end;
    select promotion.* into v_existing
    from marketplace.promotions promotion where promotion.id = v_id for update;
    if v_existing.id is null then raise exception 'promotion_not_found'; end if;
    if v_existing.status <> 'draft'
       or exists (
         select 1 from marketplace.promotion_redemptions redemption
         where redemption.promotion_id = v_existing.id
       ) then raise exception 'promotion_delete_forbidden'; end if;
    delete from marketplace.promotions where id = v_existing.id;
    insert into audit_log.events(
      actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_actor,'marketplace.promotion.deleted','promotion',v_existing.id::text,
      jsonb_build_object('code',v_existing.code_key)
    );
    return jsonb_build_object('id',v_existing.id,'deleted',true);
  else
    raise exception 'promotion_action_invalid';
  end if;
end
$function$;

-- Strict grants. All campaign and redemption tables remain RPC-only.
revoke all on function private_app.marketplace_order_promotion_defaults_v1()
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_code_key(text)
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_attempt_active(uuid)
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_transfer_active(uuid)
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_release_expired_promotions_v1(integer)
  from public,anon,authenticated;
revoke all on function private_app.marketplace_apply_promotion_v1(uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_remove_promotion_v1(uuid,uuid,uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_payment_settlement_v1()
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_redemption_integrity_v1()
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_order_status_v1()
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_transfer_guard_v1()
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_promotion_payment_attempt_guard_v1()
  from public,anon,authenticated,service_role;
revoke all on function private_app.marketplace_order_payload(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_marketplace_promotion_action(text,text,jsonb)
  from public,anon,service_role;
revoke all on function public.v1_tenant_marketplace_create_order_with_promotion(text,jsonb)
  from public,anon,service_role;
revoke all on function public.v1_tenant_service_marketplace_create_order_with_promotion(text,jsonb)
  from public,anon,service_role;
revoke all on function public.v1_platform_marketplace_promotions_snapshot()
  from public,anon,service_role;
revoke all on function public.v1_platform_marketplace_promotion_action(text,jsonb)
  from public,anon,service_role;

grant execute on function private_app.marketplace_release_expired_promotions_v1(integer)
  to service_role;
grant execute on function public.v1_tenant_marketplace_promotion_action(text,text,jsonb)
  to authenticated;
grant execute on function public.v1_tenant_marketplace_create_order_with_promotion(text,jsonb)
  to authenticated;
grant execute on function public.v1_tenant_service_marketplace_create_order_with_promotion(text,jsonb)
  to authenticated;
grant execute on function public.v1_platform_marketplace_promotions_snapshot()
  to authenticated;
grant execute on function public.v1_platform_marketplace_promotion_action(text,jsonb)
  to authenticated;

do $schedule$
declare
  v_job_id bigint;
begin
  if to_regnamespace('cron') is not null then
    select jobid into v_job_id
    from cron.job
    where jobname = 'marketplace-promotion-reservation-cleanup-v1'
    limit 1;
    if v_job_id is not null then
      perform cron.unschedule(v_job_id);
    end if;
    perform cron.schedule(
      'marketplace-promotion-reservation-cleanup-v1',
      '*/5 * * * *',
      $cron$select private_app.marketplace_release_expired_promotions_v1(200);$cron$
    );
  end if;
end
$schedule$;

comment on table marketplace.promotions is
  'Native ODEIR marketplace campaigns. One authorized operator; server-side pricing.';
comment on table marketplace.promotion_redemptions is
  'Immutable promotion reservations and redemptions bound to one marketplace order.';
comment on function public.v1_platform_marketplace_promotion_action(text,jsonb) is
  'Direct single-operator campaign management with permission, validation and audit gates.';

commit;
