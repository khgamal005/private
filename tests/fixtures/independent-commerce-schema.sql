-- Synthetic metadata only. No production customer rows, provider keys or tokens.
create table catalog.plans(id uuid primary key default gen_random_uuid(),plan_key text unique not null,name_ar text,name_en text,description text,amount_minor bigint default 0,currency text default 'SAR',interval text default 'year',status text default 'active',is_public boolean default true,display_order integer default 100,created_at timestamptz default now(),updated_at timestamptz default now());
create table catalog.plan_features(plan_id uuid references catalog.plans(id),feature_id uuid references catalog.features(id),value jsonb,primary key(plan_id,feature_id));
create table catalog.plan_limits(plan_id uuid references catalog.plans(id),limit_key text,limit_value bigint,enforcement text,primary key(plan_id,limit_key));
create table catalog.subscriptions(id uuid primary key default gen_random_uuid(),tenant_id uuid,plan_id uuid references catalog.plans(id),status text default 'active',period_start timestamptz default now(),period_end timestamptz,cancel_at_period_end boolean default false,created_at timestamptz default now(),updated_at timestamptz default now());
create table catalog.tenant_feature_overrides(tenant_id uuid,feature_id uuid,value jsonb,primary key(tenant_id,feature_id));
create function private_app.has_platform_permission(text) returns boolean language sql as $$select current_setting('fixture.admin',true)='true'$$;
create function private_app.write_audit(text,text,text,uuid,jsonb) returns void language sql as $$insert into audit_log.events(action,resource_type,resource_id,tenant_id,context) values($1,$2,$3,$4,$5)$$;
create function private_app.addon_entitlement_v3(p_tenant_id uuid,p_feature_key text) returns jsonb language plpgsql stable as $$
declare a catalog.addon_products%rowtype; s catalog.tenant_addon_subscriptions%rowtype; included boolean; override_value jsonb;
begin
 select p.* into a from catalog.addon_products p join catalog.features f on f.id=p.feature_id where f.feature_key=p_feature_key;
 select * into s from catalog.tenant_addon_subscriptions where tenant_id=p_tenant_id and product_id=a.id and status in('active','trialing','paused') order by created_at desc limit 1;
 select o.value into override_value from catalog.tenant_feature_overrides o where o.tenant_id=p_tenant_id and o.feature_id=a.feature_id;
 select exists(select 1 from catalog.subscriptions su join catalog.plan_features pf on pf.plan_id=su.plan_id where su.tenant_id=p_tenant_id and pf.feature_id=a.feature_id and pf.value='true'::jsonb and su.status='active') into included;
 return jsonb_build_object('productKey',a.product_key,'enabled',case when override_value is not null then override_value='true'::jsonb else coalesce(included or (s.status='active' and(s.period_end is null or s.period_end>now())),false) end,'source',case when override_value is not null then 'override' when included then 'plan' else 'subscription' end,'status',case when included then 'included' else coalesce(s.status,'disabled') end,'limit',a.default_limit,'subscriptionId',s.id,'endsAt',s.period_end);
end $$;
create function private_app.marketplace_order_payload(oid uuid) returns jsonb language sql as $$
 select to_jsonb(o)||jsonb_build_object('orderNumber',o.order_number,'paymentProvider',o.payment_provider,'totalMinor',o.total_minor,'currency',o.currency,'items',(select jsonb_agg(to_jsonb(i)) from marketplace.order_items i where order_id=o.id)) from marketplace.orders o where id=oid
$$;
create function private_app.paymob_tenant_checkout_eligible_v1(uuid,text) returns boolean language sql as $$select current_setting('fixture.provider',true) is distinct from 'blocked'$$;
create function private_app.tamara_eligible_v1(uuid) returns boolean language sql as $$select current_setting('fixture.provider',true) is distinct from 'blocked'$$;
create function public.v3_tenant_marketplace_snapshot(slug text) returns jsonb language plpgsql as $$
begin
 if not exists(select 1 from core.tenants t where t.slug=$1 and private_app.has_tenant_permission(t.id,'tenant.workspace.read')) then raise exception 'forbidden';end if;
 return jsonb_build_object('addons',(select jsonb_agg(jsonb_build_object('id',id,'key',product_key,'name',name_ar,'amountMinor',amount_minor)) from catalog.addon_products),'summary',jsonb_build_object('addonProducts',18));
end $$;
create function public.v3_tenant_addon_center_snapshot(slug text) returns jsonb language sql as $$select jsonb_build_object('products',public.v3_tenant_marketplace_snapshot($1)->'addons')$$;
create function public.v3_platform_addon_center_snapshot() returns jsonb language plpgsql as $$begin if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;return jsonb_build_object('products',(select jsonb_agg(jsonb_build_object('id',id,'key',product_key,'name',name_ar)) from catalog.addon_products));end$$;
create function public.v4_platform_commerce_snapshot() returns jsonb language plpgsql as $$begin if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;return jsonb_build_object('plans',(select jsonb_agg(jsonb_build_object('id',id,'key',plan_key,'nameAr',name_ar)) from catalog.plans),'addons',(select jsonb_agg(jsonb_build_object('id',id,'key',product_key)) from catalog.addon_products),'summary','{}'::jsonb);end $$;
create function public.v4_platform_commerce_action(action text,payload jsonb) returns jsonb language plpgsql as $$declare sid uuid;begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 if action='set_subscription' then
  update catalog.subscriptions set status='cancelled' where tenant_id=(payload->>'tenantId')::uuid;
  insert into catalog.subscriptions(tenant_id,plan_id,status,period_start,period_end) values((payload->>'tenantId')::uuid,(payload->>'planId')::uuid,payload->>'status',(payload->>'periodStart')::timestamptz,(payload->>'periodEnd')::timestamptz) returning id into sid;
  return jsonb_build_object('id',sid);
 end if;
 return '{}'::jsonb;
end$$;
-- These provider projections retain the exact audited source expressions that
-- the forward migration patches; full provider flows have their own test suites.
create function public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb) returns jsonb language sql as $$
 select jsonb_build_object('billingInterval',case when item.item_type='addon' then addon.interval else null end,'amount',item.line_total_minor)
 from marketplace.order_items item join catalog.addon_products addon on addon.id=item.addon_product_id where item.order_id=$2 limit 1
$$;
create function public.v1_tenant_tamara_prepare(text,uuid) returns jsonb language sql as $$
 select jsonb_build_object('billing_interval',p.interval,'amount',i.line_total_minor) from marketplace.order_items i join catalog.addon_products p on p.id=i.addon_product_id where i.order_id=$2 limit 1
$$;
create function private_app.marketplace_record_payment(uuid,text,text,text,text,bigint,text,boolean,text,uuid) returns jsonb language plpgsql as $$
declare v_item marketplace.order_items%rowtype;v_product catalog.addon_products%rowtype;finish timestamptz;
begin
 select * into v_item from marketplace.order_items where order_id=$1 limit 1;select * into v_product from catalog.addon_products where id=v_item.addon_product_id;
 finish:=case v_product.interval when 'month' then now()+interval '1 month' when 'year' then now()+interval '1 year' end;
 return jsonb_build_object('endsAt',finish,'months',case v_product.interval when 'month' then 1 when 'year' then 12 end);
end$$;
create function public.v3_platform_bank_transfer_action(uuid,text,text,text) returns jsonb language plpgsql as $$
declare v_order marketplace.orders%rowtype;
begin
 update catalog.tenant_addon_subscriptions subscription
 set price_version_id=coalesce(subscription.price_version_id,(
 select null::uuid
 )),period_is_authoritative=true;
 return '{}'::jsonb;
end$$;
create function public.v1_tenant_marketplace_replace_payment(text,jsonb) returns jsonb language plpgsql as $$
declare payload jsonb;o marketplace.orders%rowtype;i marketplace.order_items%rowtype;
begin
 select * into o from marketplace.orders where id=($2->>'orderId')::uuid;select * into i from marketplace.order_items where order_id=o.id limit 1;
 payload:=jsonb_build_object('promotionCode',o.promotion_code);
 return payload;
end$$;
create function public.v1_tenant_marketplace_action(text,text,jsonb) returns jsonb language sql as $$select jsonb_build_object('legacy',true)$$;
create function public.v2_tenant_marketplace_action(text,text,jsonb) returns jsonb language sql as $$select jsonb_build_object('legacy',true)$$;
create function public.v1_tenant_tamara_create_order(text,jsonb) returns jsonb language sql as $$select jsonb_build_object('legacy',true)$$;
create function private_app.marketplace_apply_promotion_v1(p_tenant_id uuid,p_order_id uuid,p_code text,p_actor uuid) returns jsonb language plpgsql as $$
begin
 return jsonb_build_object('legacyPromotion',true);
end$$;
create function private_app.provision_tenant_core(text,text,text,text,text,text,text,text,text,text,uuid,jsonb) returns jsonb language sql as $$select jsonb_build_object('planKey',$6)$$;
