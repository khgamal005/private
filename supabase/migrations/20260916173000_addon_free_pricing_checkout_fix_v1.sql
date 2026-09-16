begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Additive commercial pricing history. Existing orders and subscriptions keep
-- their immutable snapshots; this records only administrator price changes.
create table if not exists catalog.independent_addon_price_revisions_v1 (
  id uuid primary key default gen_random_uuid(),
  addon_product_id uuid not null references catalog.addon_products(id)
    on delete restrict,
  offer_id uuid not null references catalog.independent_commercial_catalog_v1(id)
    on delete restrict,
  actor_subject_id uuid not null references access_control.subjects(id)
    on delete restrict,
  before_value jsonb,
  after_value jsonb not null check (jsonb_typeof(after_value) = 'object'),
  reason text not null check (length(reason) between 3 and 500),
  created_at timestamptz not null default now()
);
create index if not exists independent_addon_price_revisions_product_idx
  on catalog.independent_addon_price_revisions_v1(addon_product_id, created_at desc);
alter table catalog.independent_addon_price_revisions_v1 enable row level security;
alter table catalog.independent_addon_price_revisions_v1 force row level security;
revoke all on catalog.independent_addon_price_revisions_v1
  from public, anon, authenticated, service_role;

-- New marketplace products must remain editable even before their first
-- commercial offer is configured. Tenant checkout still fails closed until a
-- published offer exists.
create or replace function public.v4_platform_addon_center_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_base jsonb;
  v_products jsonb;
begin
  v_base := private_app.v3_platform_addon_center_snapshot_before_independent_v1();
  select coalesce(
    jsonb_agg(
      case
        when product.value ->> 'key' in ('delivery_analytics','social_connect')
          then private_app.independent_addon_payload_v1(product.value)
               || jsonb_build_object('pricingConfigured', false)
        when offer.id is not null
          then private_app.independent_addon_payload_v1(product.value)
               || jsonb_build_object('pricingConfigured', true)
        else product.value || jsonb_build_object(
          'independent', true,
          'pricingConfigured', false,
          'monthlyAmountMinor', null,
          'annualAmountMinor', null,
          'commercialPolicy', 'independent-v1'
        )
      end
      order by product.ordinality
    ),
    '[]'::jsonb
  )
  into v_products
  from jsonb_array_elements(coalesce(v_base -> 'products','[]'::jsonb))
       with ordinality product(value, ordinality)
  left join catalog.independent_commercial_catalog_v1 offer
    on offer.kind = 'addon'
   and offer.product_key = product.value ->> 'key';
  return jsonb_set(v_base, '{products}', v_products)
    || jsonb_build_object('commercialPolicy','independent-v1');
end
$function$;

revoke all on function public.v4_platform_addon_center_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.v4_platform_addon_center_snapshot()
  to authenticated;

create or replace function public.v1_platform_independent_addon_price_update(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_product_id uuid;
  v_expected_offer_id uuid;
  v_product catalog.addon_products%rowtype;
  v_offer catalog.independent_commercial_catalog_v1%rowtype;
  v_saved catalog.independent_commercial_catalog_v1%rowtype;
  v_mode text;
  v_monthly bigint;
  v_annual bigint;
  v_reason text;
  v_before jsonb;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  if jsonb_typeof(p_payload) <> 'object'
     or coalesce((p_payload ->> 'confirmed')::boolean, false) is not true then
    raise exception 'addon_price_payload_invalid';
  end if;
  begin
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_expected_offer_id := nullif(p_payload ->> 'expectedOfferId','')::uuid;
    v_monthly := coalesce((p_payload ->> 'monthlyAmountMinor')::bigint, 0);
  exception when others then
    raise exception 'addon_price_payload_invalid';
  end;
  v_mode := lower(btrim(coalesce(p_payload ->> 'pricingMode','')));
  v_reason := btrim(coalesce(p_payload ->> 'reason',''));
  if v_mode not in ('free','fixed')
     or length(v_reason) not between 3 and 500
     or v_monthly < 0
     or v_monthly > 999999999
     or (v_mode = 'free' and v_monthly <> 0)
     or (v_mode = 'fixed' and v_monthly < 1) then
    raise exception 'addon_price_payload_invalid';
  end if;
  v_annual := case when v_mode = 'free' then 0 else v_monthly * 10 end;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;

  perform pg_advisory_xact_lock(
    hashtextextended('independent-addon-price:' || v_product_id::text, 0)
  );
  select product.* into v_product
  from catalog.addon_products product
  where product.id = v_product_id
    and product.status in ('beta','active')
  for update;
  if v_product.id is null then raise exception 'marketplace_product_not_found'; end if;
  if v_product.product_key in ('delivery_analytics','social_connect') then
    raise exception 'addon_component_not_sold_separately';
  end if;

  select offer.* into v_offer
  from catalog.independent_commercial_catalog_v1 offer
  where offer.kind = 'addon' and offer.addon_product_id = v_product.id
  for update;
  if (v_offer.id is null and v_expected_offer_id is not null)
     or (v_offer.id is not null and v_offer.id is distinct from v_expected_offer_id)
     or (v_offer.id is not null and (
       coalesce((p_payload ->> 'expectedMonthlyAmountMinor')::bigint, -1)
         is distinct from v_offer.monthly_amount_minor
       or coalesce((p_payload ->> 'expectedAnnualAmountMinor')::bigint, -1)
         is distinct from v_offer.annual_amount_minor
     )) then
    raise exception 'addon_price_version_conflict';
  end if;

  if v_offer.id is null then
    insert into catalog.independent_commercial_catalog_v1(
      kind, product_key, addon_product_id, name_ar, description_ar,
      monthly_amount_minor, annual_amount_minor, currency, tax_rate_bps,
      tax_inclusive, profile, published, display_order, release_key
    ) values (
      'addon', v_product.product_key, v_product.id, v_product.name_ar,
      coalesce(nullif(btrim(v_product.description_ar),''), v_product.name_ar),
      v_monthly, v_annual, 'SAR', 1500, false,
      jsonb_build_object(
        'category', coalesce(v_product.marketplace_category, 'integrations'),
        'openUsage', true,
        'externalFeesExcluded', true
      ),
      true, coalesce(v_product.sort_order, 100), 'independent-v1'
    )
    returning * into v_saved;
  else
    v_before := jsonb_build_object(
      'pricingMode', case when v_offer.monthly_amount_minor = 0 then 'free' else 'fixed' end,
      'monthlyAmountMinor', v_offer.monthly_amount_minor,
      'annualAmountMinor', v_offer.annual_amount_minor,
      'published', v_offer.published
    );
    update catalog.independent_commercial_catalog_v1
    set monthly_amount_minor = v_monthly,
        annual_amount_minor = v_annual,
        currency = 'SAR',
        published = true,
        name_ar = v_product.name_ar,
        description_ar = coalesce(
          nullif(btrim(v_product.description_ar),''), v_product.name_ar
        )
    where id = v_offer.id
    returning * into v_saved;
  end if;

  update catalog.addon_products
  set pricing_mode = v_mode,
      amount_minor = v_annual,
      currency = 'SAR',
      interval = 'year',
      updated_at = now()
  where id = v_product.id;

  insert into catalog.independent_addon_price_revisions_v1(
    addon_product_id, offer_id, actor_subject_id,
    before_value, after_value, reason
  ) values (
    v_product.id, v_saved.id, v_actor, v_before,
    jsonb_build_object(
      'pricingMode', v_mode,
      'monthlyAmountMinor', v_monthly,
      'annualAmountMinor', v_annual,
      'published', true
    ),
    v_reason
  );
  perform private_app.write_audit(
    'catalog.addon.price.updated',
    'addon_product',
    v_product.id::text,
    null,
    jsonb_build_object(
      'productKey', v_product.product_key,
      'pricingMode', v_mode,
      'monthlyAmountMinor', v_monthly,
      'annualAmountMinor', v_annual,
      'historicalOrdersUnchanged', true
    )
  );
  return jsonb_build_object(
    'id', v_saved.id,
    'productId', v_product.id,
    'productKey', v_product.product_key,
    'pricingMode', v_mode,
    'monthlyAmountMinor', v_monthly,
    'annualAmountMinor', v_annual,
    'published', true
  );
end
$function$;

revoke all on function public.v1_platform_independent_addon_price_update(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_independent_addon_price_update(jsonb)
  to authenticated;

-- Extend the existing platform gateway without changing any legacy action.
alter function public.v3_platform_addon_center_action(text, jsonb)
  rename to v3_platform_addon_center_action_before_free_pricing_v1;
alter function public.v3_platform_addon_center_action_before_free_pricing_v1(text, jsonb)
  set schema private_app;
revoke all on function
  private_app.v3_platform_addon_center_action_before_free_pricing_v1(text, jsonb)
from public, anon, authenticated, service_role;

create function public.v3_platform_addon_center_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_action = 'set_independent_price' then
    return public.v1_platform_independent_addon_price_update(p_payload);
  end if;
  return private_app.v3_platform_addon_center_action_before_free_pricing_v1(
    p_action, p_payload
  );
end
$function$;

revoke all on function public.v3_platform_addon_center_action(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.v3_platform_addon_center_action(text, jsonb)
  to authenticated;

-- Google Kit was visible but had no independent offer, so both monthly and
-- annual quotes were unavailable. It launches as a real free add-on and uses
-- the existing idempotent activate_free_addon flow (never a zero-value order).
insert into catalog.independent_commercial_catalog_v1(
  kind, product_key, addon_product_id, name_ar, description_ar,
  monthly_amount_minor, annual_amount_minor, currency, tax_rate_bps,
  tax_inclusive, profile, published, display_order, release_key
)
select
  'addon', product.product_key, product.id, product.name_ar,
  coalesce(nullif(btrim(product.description_ar),''), product.name_ar),
  0, 0, 'SAR', 1500, false,
  jsonb_build_object(
    'category', coalesce(product.marketplace_category, 'analytics'),
    'openUsage', true,
    'externalFeesExcluded', true
  ),
  true, coalesce(product.sort_order, 100), 'independent-v1'
from catalog.addon_products product
where product.product_key = 'google_ads_connect'
  and product.status in ('beta','active')
on conflict do nothing;

update catalog.addon_products product
set pricing_mode = 'free',
    amount_minor = 0,
    currency = 'SAR',
    interval = 'year',
    updated_at = now()
where product.product_key = 'google_ads_connect'
  and exists (
    select 1
    from catalog.independent_commercial_catalog_v1 offer
    where offer.addon_product_id = product.id
      and offer.monthly_amount_minor = 0
      and offer.annual_amount_minor = 0
      and offer.published
  );

notify pgrst, 'reload schema';
commit;
