begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- An additive release. Never migrate, reprice, expire or rewrite a tenant's
-- existing subscriptions, modules, contacts, students, documents or payments.
create function pg_temp.reef_commerce_fingerprint() returns jsonb
language sql stable set search_path='' as $$
 with r as (select id from core.tenants where slug='reef-skills'),
 f as (select id from catalog.plans where plan_key='full'), h as (
 select 'tenant' k,md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]')) v from core.tenants t where t.id in(select id from r)
 union all select 'full_plan',md5(coalesce(jsonb_agg(to_jsonb(p) order by p.id)::text,'[]')) from catalog.plans p where p.id in(select id from f)
 union all select 'full_features',md5(coalesce(jsonb_agg(to_jsonb(p) order by p.feature_id)::text,'[]')) from catalog.plan_features p where p.plan_id in(select id from f)
 union all select 'full_limits',md5(coalesce(jsonb_agg(to_jsonb(p) order by p.limit_key)::text,'[]')) from catalog.plan_limits p where p.plan_id in(select id from f)
 union all select 'subscriptions',md5(coalesce(jsonb_agg(to_jsonb(s) order by s.id)::text,'[]')) from catalog.subscriptions s where tenant_id in(select id from r)
 union all select 'addon_subscriptions',md5(coalesce(jsonb_agg(to_jsonb(s) order by s.id)::text,'[]')) from catalog.tenant_addon_subscriptions s where tenant_id in(select id from r)
 union all select 'modules',md5(coalesce(jsonb_agg(to_jsonb(s) order by s.module_id)::text,'[]')) from core.tenant_modules s where tenant_id in(select id from r)
 union all select 'overrides',md5(coalesce(jsonb_agg(to_jsonb(s) order by s.feature_id)::text,'[]')) from catalog.tenant_feature_overrides s where tenant_id in(select id from r)
 union all select 'effective_addons',md5(coalesce(jsonb_agg(jsonb_build_object('key',p.product_key,'enabled',e->'enabled','source',e->'source','status',e->'status','limit',e->'limit','subscriptionId',e->'subscriptionId','endsAt',e->'endsAt') order by p.product_key)::text,'[]'))
 from catalog.addon_products p join catalog.features ft on ft.id=p.feature_id cross join r cross join lateral(select private_app.addon_entitlement_v3(r.id,ft.feature_key) e) q
 ) select jsonb_object_agg(k,v) from h;
$$;
create temp table independent_release_guard on commit drop as
 select pg_temp.reef_commerce_fingerprint() as before_state;

-- This table is the single, public-safe commercial manifest for the release.
-- It contains no tenant information, credentials, orders or bank information.
-- Prices selected by an order are copied into its immutable commercial metadata.
create table catalog.independent_commercial_catalog_v1 (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('core','addon')),
 product_key text not null check(product_key ~ '^[a-z][a-z0-9_]{2,80}$'),
 plan_id uuid references catalog.plans(id),
 addon_product_id uuid references catalog.addon_products(id),
 name_ar text not null,
 description_ar text not null,
 monthly_amount_minor bigint not null check(monthly_amount_minor>=0),
 annual_amount_minor bigint not null check(annual_amount_minor=monthly_amount_minor*10),
 currency text not null default 'SAR' check(currency='SAR'),
 tax_rate_bps integer not null default 1500 check(tax_rate_bps between 0 and 10000),
 tax_inclusive boolean not null default false,
 profile jsonb not null default '{}'::jsonb check(jsonb_typeof(profile)='object'),
 published boolean not null default true,
 display_order integer not null,
 release_key text not null default 'independent-v1',
 created_at timestamptz not null default now(),
 unique(kind,product_key),
 unique(plan_id),unique(addon_product_id),
 check((kind='core' and plan_id is not null and addon_product_id is null)
    or(kind='addon' and addon_product_id is not null and plan_id is null))
);
alter table catalog.independent_commercial_catalog_v1 enable row level security;
revoke all on catalog.independent_commercial_catalog_v1 from public,anon,authenticated,service_role;
grant usage on schema catalog to anon,authenticated;
grant select on catalog.independent_commercial_catalog_v1 to anon,authenticated;
create policy independent_commercial_public_read on catalog.independent_commercial_catalog_v1
for select to anon,authenticated using(published);

create table catalog.independent_commerce_rollback_v1 (
 release_key text primary key,
 captured_at timestamptz not null default now(),
 addon_products_before jsonb not null,
 function_definitions jsonb not null default '{}'::jsonb,
 reef_fingerprint jsonb not null
);
alter table catalog.independent_commerce_rollback_v1 enable row level security;
revoke all on catalog.independent_commerce_rollback_v1 from public,anon,authenticated,service_role;
insert into catalog.independent_commerce_rollback_v1(release_key,addon_products_before,reef_fingerprint)
select 'independent-v1',coalesce(jsonb_agg(to_jsonb(p) order by p.product_key),'[]'),pg_temp.reef_commerce_fingerprint()
from catalog.addon_products p;

-- Only NEW core editions receive these limits. Both legacy full and legacy free
-- rows/plan features remain byte-for-byte unchanged, including Reef's contract.
with approved(key,name,description,monthly,profile,position) as (values
('core_free','المجانية','ابدأ بتنظيم مركزك دون اشتراك.',0,'{"key":"core_free","name":"المجانية","monthlyMinor":0,"annualMinor":0,"description":"ابدأ بتنظيم مركزك مع 3 مستخدمين.","limits":{"staff":3},"routing":"current","reports":"current","addonsIncluded":false,"capacityPolicy":"staff_only_v1"}'::jsonb,10),
('core_basic','الأساسية','اجمع عمل فريقك في مكان واحد.',7900,'{"key":"core_basic","name":"الأساسية","monthlyMinor":7900,"annualMinor":79000,"description":"شغّل مركزك مع فريق حتى 5 مستخدمين.","limits":{"staff":5},"routing":"current","reports":"current","addonsIncluded":false,"capacityPolicy":"staff_only_v1"}'::jsonb,20),
('core_professional','الاحترافية','اعرف أين تتحول المتابعة إلى تسجيلات.',19900,'{"key":"core_professional","name":"الاحترافية","monthlyMinor":19900,"annualMinor":199000,"description":"وسّع فريق التشغيل حتى 10 مستخدمين.","limits":{"staff":10},"routing":"current","reports":"current","addonsIncluded":false,"capacityPolicy":"staff_only_v1"}'::jsonb,30),
('core_diamond','الماسية','رؤية أوسع وتحكم أكبر في تشغيل منشأتك.',49900,'{"key":"core_diamond","name":"الماسية","monthlyMinor":49900,"annualMinor":499000,"description":"أدر فريقًا أكبر حتى 20 مستخدمًا.","limits":{"staff":20},"routing":"current","reports":"current","addonsIncluded":false,"capacityPolicy":"staff_only_v1"}'::jsonb,40)
), inserted as (
 insert into catalog.plans(plan_key,name_ar,name_en,description,amount_minor,currency,interval,status,is_public,display_order)
 select key,name,key,description||' نسخ البرنامج مستقلة تمامًا عن الإضافات.',monthly,'SAR','month','active',true,position from approved returning *
)
insert into catalog.independent_commercial_catalog_v1(kind,product_key,plan_id,name_ar,description_ar,monthly_amount_minor,annual_amount_minor,profile,display_order)
select 'core',p.plan_key,p.id,p.name_ar,p.description,a.monthly,a.monthly*10,a.profile,a.position from inserted p join approved a on a.key=p.plan_key;

insert into catalog.plan_features(plan_id,feature_id,value)
select c.plan_id,f.id,'true'::jsonb from catalog.independent_commercial_catalog_v1 c cross join catalog.features f
where c.kind='core' and f.feature_key in ('module.crm','module.work','module.people','module.academy','module.support','module.content','module.customer_service','module.reports','module.analytics','module.integrations','module.incentives')
and not exists(select 1 from catalog.addon_products a where a.feature_id=f.id);

insert into catalog.plan_features(plan_id,feature_id,value)
select c.plan_id,f.id,to_jsonb(case when f.feature_key='limit.users' then (c.profile->'limits'->>'staff')::integer else -1 end)
from catalog.independent_commercial_catalog_v1 c cross join catalog.features f where c.kind='core' and f.feature_key in ('limit.users','limit.courses');

insert into catalog.plan_limits(plan_id,limit_key,limit_value,enforcement) select c.plan_id,'max_employees',(c.profile->'limits'->>'staff')::bigint,'hard' from catalog.independent_commercial_catalog_v1 c where kind='core';
with approved(key,name,description,monthly,category,position) as (values
('whatsapp','واتساب التشغيلي','أرسل تأكيدات التسجيل وتذكيرات المواعيد من داخل أودير. رسوم مزود الرسائل منفصلة.',3900,'communications',10),
('email','بريد المنشأة','أرسل رسائل منشأتك بقوالب واضحة وتابع نتائج التسليم. رسوم مزود البريد منفصلة.',1900,'communications',20),
('zoom','ربط الجلسات بـZoom','أنشئ اجتماعات الجلسات واربطها بالدفعات. ترخيص Zoom الخارجي منفصل.',1900,'training',30),
('salla','ربط متجر سلة','اربط طلبات متجرك برحلة العميل والمتابعة دون إعادة إدخال.',2900,'commerce',40),
('zid','ربط متجر زد','اربط طلبات متجرك برحلة العميل والمتابعة دون إعادة إدخال.',2900,'commerce',50),
('shopify','ربط متجر Shopify','اربط طلبات متجرك برحلة العميل والمتابعة دون إعادة إدخال.',2900,'commerce',60),
('woocommerce','ربط متجر WooCommerce','اربط طلبات متجرك برحلة العميل والمتابعة دون إعادة إدخال.',2900,'commerce',70),
('automation','أتمتة رحلة العميل','أنشئ قواعد الحدث والشرط والإجراء للتشغيل المتكرر دون مستويات داخل الإضافة.',2900,'automation',80),
('yeastar','متابعة المكالمات مع Yeastar','اربط مكالمات الفريق بملف العميل وتقارير المتابعة. ترخيص السنترال والمكالمات منفصلان.',4900,'telephony',90),
('marketing_attribution','ربط الإعلانات وقياس العائد','اجمع بيانات الإعلانات واربطها بالمصادر والتسجيلات والمدفوعات المؤكدة مع توضيح جودة المطابقة.',4900,'marketing',100),
('cms_pro','موقع المركز وصفحات التسجيل','أدر صفحات المركز ونماذج التسجيل ومحتواه من داخل أودير. التصميم الخاص والنطاق الخارجي منفصلان.',7900,'website',110),
('lms','تشغيل التدريب التفاعلي','شغّل الحضور والتقييم والشهادات ووظائف التدريب المتاحة دون مستويات تجارية داخل الإضافة.',9900,'training',120),
('zatca','ربط الفوترة الإلكترونية — زاتكا','هيّئ الربط وتابع معالجة الفواتير وفق المتطلبات المطبقة. لا يغني اسم الإضافة عن تحقق جاهزية المنشأة.',3900,'integrations',130),
('api','واجهة الربط للمطورين — API','اربط أدوات منشأتك عبر واجهات الربط المدعومة. الموصلات الجاهزة لا تتطلب شراء هذه الإضافة معها.',4900,'integrations',140),
('custom_store','موصل المتجر المخصص','شغّل موصل متجرك المتفق عليه. بناء موصل جديد لأول مرة خدمة منفصلة محددة النطاق.',9900,'integrations',150),
('templates','القوالب المتقدمة','خصّص القوالب والمتغيرات الآمنة. مجانية للجميع بصرف النظر عن نسخة أودير.',0,'communications',160)
)
insert into catalog.independent_commercial_catalog_v1(kind,product_key,addon_product_id,name_ar,description_ar,monthly_amount_minor,annual_amount_minor,profile,display_order)
select 'addon',p.product_key,p.id,a.name,a.description,a.monthly,a.monthly*10,
 jsonb_build_object('category',a.category,'openUsage',true,'externalFeesExcluded',true),a.position
from approved a join catalog.addon_products p on p.product_key=a.key;

-- Compatibility cache for old annual-only clients, not a subscription mutation.
update catalog.addon_products p set name_ar=c.name_ar,description_ar=c.description_ar,amount_minor=c.annual_amount_minor,interval='year',pricing_mode=case when c.annual_amount_minor=0 then 'free' else 'fixed' end,default_limit=null,updated_at=now()
from catalog.independent_commercial_catalog_v1 c where c.kind='addon' and c.addon_product_id=p.id;

create function public.v1_public_independent_commercial_catalog() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('policy','independent-v1','currency','SAR',
 'plans',coalesce(jsonb_agg(jsonb_build_object('id',plan_id,'key',product_key,'name',name_ar,'description',description_ar,'monthlyAmountMinor',monthly_amount_minor,'annualAmountMinor',annual_amount_minor,'profile',profile) order by display_order) filter(where kind='core'),'[]'),
 'addons',coalesce(jsonb_agg(jsonb_build_object('id',addon_product_id,'key',product_key,'name',name_ar,'description',description_ar,'monthlyAmountMinor',monthly_amount_minor,'annualAmountMinor',annual_amount_minor,'profile',profile) order by display_order) filter(where kind='addon'),'[]'))
 from catalog.independent_commercial_catalog_v1 where published;
$$;
revoke all on function public.v1_public_independent_commercial_catalog() from public,anon,authenticated,service_role;
grant execute on function public.v1_public_independent_commercial_catalog() to anon,authenticated;

create function private_app.independent_addon_payload_v1(p_item jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare c catalog.independent_commercial_catalog_v1%rowtype;
begin
 if p_item->>'key' in ('delivery_analytics','social_connect') then
  return p_item||jsonb_build_object('componentOnly',true,'amountMinor',0,'monthlyAmountMinor',0,'annualAmountMinor',0,
   'price',jsonb_build_object('amountMinor',0,'currency','SAR','interval','year','pricingMode','free'),
   'actions',coalesce(p_item->'actions','{}')||jsonb_build_object('canCheckout',false,'canRenew',false,'canRequestTrial',false));
 end if;
 select * into c from catalog.independent_commercial_catalog_v1 where kind='addon' and product_key=p_item->>'key' and published;
 if c.id is null then return p_item; end if;
 return p_item||jsonb_build_object('name',c.name_ar,'description',c.description_ar,
  'pricingMode',case when c.annual_amount_minor=0 then 'free' else 'fixed' end,
  'amountMinor',c.annual_amount_minor,'monthlyAmountMinor',c.monthly_amount_minor,'annualAmountMinor',c.annual_amount_minor,
  'interval','year','currency',c.currency,'taxRateBps',c.tax_rate_bps,'taxInclusive',c.tax_inclusive,
  'commercialPolicy',c.release_key,'independent',true,'openUsage',true,
  'price',jsonb_build_object('offerId',c.id,'source','independent_commercial_catalog_v1','amountMinor',c.annual_amount_minor,'monthlyAmountMinor',c.monthly_amount_minor,'annualAmountMinor',c.annual_amount_minor,'currency',c.currency,'interval','year','taxInclusive',c.tax_inclusive,'taxRateBps',c.tax_rate_bps,'pricingMode',case when c.annual_amount_minor=0 then 'free' else 'fixed' end));
end $$;
revoke all on function private_app.independent_addon_payload_v1(jsonb) from public,anon,authenticated,service_role;

alter function public.v3_tenant_marketplace_snapshot(text) rename to v3_tenant_marketplace_snapshot_before_independent_v1;
alter function public.v3_tenant_marketplace_snapshot_before_independent_v1(text) set schema private_app;
revoke all on function private_app.v3_tenant_marketplace_snapshot_before_independent_v1(text) from public,anon,authenticated,service_role;
create function public.v4_tenant_marketplace_snapshot(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b jsonb; a jsonb;
begin
 -- The original RPC performs tenant workspace permission checks.
 b:=private_app.v3_tenant_marketplace_snapshot_before_independent_v1(p_slug);
 select coalesce(jsonb_agg(private_app.independent_addon_payload_v1(value) order by ordinality),'[]') into a
 from jsonb_array_elements(coalesce(b->'addons','[]')) with ordinality x(value,ordinality)
 where value->>'key' not in ('delivery_analytics','social_connect');
 return jsonb_set(jsonb_set(b,'{addons}',a),'{summary,addonProducts}',to_jsonb(jsonb_array_length(a)))
  ||jsonb_build_object('commercialPolicy','independent-v1','billingCycles',jsonb_build_array('month','year'),'promotionsEnabled',false);
end $$;
revoke all on function public.v4_tenant_marketplace_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.v4_tenant_marketplace_snapshot(text) to authenticated;
create function public.v3_tenant_marketplace_snapshot(p_slug text) returns jsonb language sql stable security definer set search_path='' as $$select public.v4_tenant_marketplace_snapshot(p_slug)$$;
revoke all on function public.v3_tenant_marketplace_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_marketplace_snapshot(text) to authenticated;


alter function public.v3_tenant_addon_center_snapshot(text) rename to v3_tenant_addon_center_snapshot_before_independent_v1;
alter function public.v3_tenant_addon_center_snapshot_before_independent_v1(text) set schema private_app;
revoke all on function private_app.v3_tenant_addon_center_snapshot_before_independent_v1(text) from public,anon,authenticated,service_role;
create function public.v4_tenant_addon_center_snapshot(p_slug text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b jsonb; a jsonb;
begin
 b:=private_app.v3_tenant_addon_center_snapshot_before_independent_v1(p_slug);
 select coalesce(jsonb_agg(private_app.independent_addon_payload_v1(value) order by ordinality),'[]') into a
 from jsonb_array_elements(coalesce(b->'products','[]')) with ordinality x(value,ordinality);
 return jsonb_set(b,'{products}',a)||jsonb_build_object('commercialPolicy','independent-v1');
end $$;
revoke all on function public.v4_tenant_addon_center_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.v4_tenant_addon_center_snapshot(text) to authenticated;
create function public.v3_tenant_addon_center_snapshot(p_slug text) returns jsonb language sql stable security definer set search_path='' as $$select public.v4_tenant_addon_center_snapshot(p_slug)$$;
revoke all on function public.v3_tenant_addon_center_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_addon_center_snapshot(text) to authenticated;


alter function public.v3_platform_addon_center_snapshot() rename to v3_platform_addon_center_snapshot_before_independent_v1;
alter function public.v3_platform_addon_center_snapshot_before_independent_v1() set schema private_app;
revoke all on function private_app.v3_platform_addon_center_snapshot_before_independent_v1() from public,anon,authenticated,service_role;
create function public.v4_platform_addon_center_snapshot() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b jsonb; a jsonb;
begin
 b:=private_app.v3_platform_addon_center_snapshot_before_independent_v1();
 select coalesce(jsonb_agg(private_app.independent_addon_payload_v1(value) order by ordinality),'[]') into a
 from jsonb_array_elements(coalesce(b->'products','[]')) with ordinality x(value,ordinality);
 return jsonb_set(b,'{products}',a)||jsonb_build_object('commercialPolicy','independent-v1');
end $$;
revoke all on function public.v4_platform_addon_center_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.v4_platform_addon_center_snapshot() to authenticated;
create function public.v3_platform_addon_center_snapshot() returns jsonb language sql stable security definer set search_path='' as $$select public.v4_platform_addon_center_snapshot()$$;
revoke all on function public.v3_platform_addon_center_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.v3_platform_addon_center_snapshot() to authenticated;


-- Each newly assigned core contract records its own cycle without adding even
-- a nullable column to Reef's existing subscription row.
create table catalog.independent_core_subscription_terms_v1 (
 subscription_id uuid primary key references catalog.subscriptions(id),
 catalog_offer_id uuid not null references catalog.independent_commercial_catalog_v1(id),
 billing_interval text not null check(billing_interval in ('month','year')),
 quoted_amount_minor bigint not null check(quoted_amount_minor>=0),
 currency text not null default 'SAR' check(currency='SAR'),
 created_at timestamptz not null default now()
);
create index independent_core_terms_offer_idx on catalog.independent_core_subscription_terms_v1(catalog_offer_id);
alter table catalog.independent_core_subscription_terms_v1 enable row level security;
revoke all on catalog.independent_core_subscription_terms_v1 from public,anon,authenticated,service_role;

alter function public.v4_platform_commerce_snapshot() rename to v4_platform_commerce_snapshot_before_independent_v1;
alter function public.v4_platform_commerce_snapshot_before_independent_v1() set schema private_app;
revoke all on function private_app.v4_platform_commerce_snapshot_before_independent_v1() from public,anon,authenticated,service_role;
create function public.v5_platform_commerce_snapshot() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b jsonb; p jsonb; l jsonb; a jsonb; subs jsonb; recurring bigint;
begin
 b:=private_app.v4_platform_commerce_snapshot_before_independent_v1();
 select coalesce(jsonb_agg(x.value||jsonb_build_object('independentEdition',true,'annualAmountMinor',c.annual_amount_minor,'monthlyAmountMinor',c.monthly_amount_minor,'commercialProfile',c.profile,'addonsIncluded',false) order by c.display_order),'[]') into p
 from jsonb_array_elements(b->'plans') x(value) join catalog.independent_commercial_catalog_v1 c on c.kind='core' and c.plan_id=(x.value->>'id')::uuid and c.published;
 select coalesce(jsonb_agg(x.value||jsonb_build_object('legacyContract',true,'readOnly',true)),'[]') into l
 from jsonb_array_elements(b->'plans') x(value) where not exists(select 1 from catalog.independent_commercial_catalog_v1 c where c.kind='core' and c.plan_id=(x.value->>'id')::uuid);
 select coalesce(jsonb_agg(private_app.independent_addon_payload_v1(value) order by ordinality),'[]') into a from jsonb_array_elements(b->'addons') with ordinality x(value,ordinality);
 select coalesce(jsonb_agg(x.value||jsonb_build_object('billingInterval',st.billing_interval,'quotedAmountMinor',st.quoted_amount_minor) order by x.ordinality),'[]') into subs
 from jsonb_array_elements(coalesce(b->'subscriptions','[]')) with ordinality x(value,ordinality)
 left join catalog.independent_core_subscription_terms_v1 st on st.subscription_id=(x.value->>'id')::uuid;
 select coalesce(sum(case when st.subscription_id is not null then case st.billing_interval when 'year' then round(st.quoted_amount_minor/12.0)::bigint else st.quoted_amount_minor end
 else case pl.interval when 'year' then round(pl.amount_minor/12.0)::bigint when 'month' then pl.amount_minor else 0 end end),0) into recurring
 from catalog.subscriptions su join catalog.plans pl on pl.id=su.plan_id left join catalog.independent_core_subscription_terms_v1 st on st.subscription_id=su.id where su.status='active';
 return b||jsonb_build_object('plans',p,'legacyPlans',l,'addons',a,'subscriptions',subs,'commercialPolicy','independent-v1','summary',(b->'summary')||jsonb_build_object('planCount',jsonb_array_length(p),'monthlyRecurringMinor',recurring));
end $$;
revoke all on function public.v5_platform_commerce_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.v5_platform_commerce_snapshot() to authenticated;
create function public.v4_platform_commerce_snapshot() returns jsonb language sql stable security definer set search_path='' as $$select public.v5_platform_commerce_snapshot()$$;
revoke all on function public.v4_platform_commerce_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.v4_platform_commerce_snapshot() to authenticated;


alter function public.v4_platform_commerce_action(text,jsonb) rename to v4_platform_commerce_action_before_independent_v1;
alter function public.v4_platform_commerce_action_before_independent_v1(text,jsonb) set schema private_app;
revoke all on function private_app.v4_platform_commerce_action_before_independent_v1(text,jsonb) from public,anon,authenticated,service_role;

create function public.v5_platform_commerce_action(p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c catalog.independent_commercial_catalog_v1%rowtype; r jsonb; payload jsonb:=p_payload; cycle text; started timestamptz;
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden'; end if;
 if p_action='set_subscription' then
  if exists(select 1 from core.tenants where id=nullif(p_payload->>'tenantId','')::uuid and slug='reef-skills') then raise exception 'reef_contract_protected'; end if;
  select * into c from catalog.independent_commercial_catalog_v1 where kind='core' and plan_id=nullif(p_payload->>'planId','')::uuid and published;
  if c.id is null then raise exception 'commercial_plan_not_available'; end if;
  cycle:=coalesce(p_payload->>'billingInterval','month');
  if cycle not in ('month','year') then raise exception 'invalid_billing_interval'; end if;
  started:=coalesce(nullif(p_payload->>'periodStart','')::timestamptz,now());
  payload:=payload||jsonb_build_object('periodStart',started,'periodEnd',case when c.monthly_amount_minor=0 then null else started+case cycle when 'year' then interval '1 year' else interval '1 month' end end);
  r:=private_app.v4_platform_commerce_action_before_independent_v1(p_action,payload);
  insert into catalog.independent_core_subscription_terms_v1(subscription_id,catalog_offer_id,billing_interval,quoted_amount_minor) values((r->>'id')::uuid,c.id,cycle,case cycle when 'year' then c.annual_amount_minor else c.monthly_amount_minor end);
  return r||jsonb_build_object('billingInterval',cycle,'addonsUnchanged',true);
 elsif p_action in ('save_plan','save_plan_limits') and exists(select 1 from catalog.plans where id=nullif(p_payload->>'planId','')::uuid and plan_key='full') then
  raise exception 'legacy_plan_contract_protected';
 elsif p_action in ('save_plan','save_plan_limits') and exists(select 1 from catalog.independent_commercial_catalog_v1 where kind='core' and plan_id=nullif(p_payload->>'planId','')::uuid) then
  -- Approved edition changes require a versioned commercial release, not a
  -- partial update that drifts the monthly price away from its annual option.
  raise exception 'commercial_catalog_versioned_update_required';
 end if;
 return private_app.v4_platform_commerce_action_before_independent_v1(p_action,payload);
end $$;
revoke all on function public.v5_platform_commerce_action(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v5_platform_commerce_action(text,jsonb) to authenticated;
create function public.v4_platform_commerce_action(p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb language sql security definer set search_path='' as $$select public.v5_platform_commerce_action(p_action,p_payload)$$;
revoke all on function public.v4_platform_commerce_action(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v4_platform_commerce_action(text,jsonb) to authenticated;

-- Derive technical components from the license they support. Reef deliberately
-- returns the old resolver untouched, so its exact source/status stay stable.
alter function private_app.addon_entitlement_v3(uuid,text) rename to addon_entitlement_before_independent_v1;
revoke all on function private_app.addon_entitlement_before_independent_v1(uuid,text) from public,anon,authenticated,service_role;
create function private_app.addon_entitlement_v3(p_tenant_id uuid,p_feature_key text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b jsonb; key text; allowed boolean:=false;
begin
 b:=private_app.addon_entitlement_before_independent_v1(p_tenant_id,p_feature_key);
 if exists(select 1 from core.tenants where id=p_tenant_id and slug='reef-skills') then return b; end if;
 key:=b->>'productKey';
 if b->>'source'='override' then return b; end if;
 if key='templates' then allowed:=true;
 elsif key='delivery_analytics' then
  allowed:=coalesce((private_app.addon_entitlement_before_independent_v1(p_tenant_id,'addon.integration.whatsapp')->>'enabled')::boolean,false)
    or coalesce((private_app.addon_entitlement_before_independent_v1(p_tenant_id,'addon.integration.email')->>'enabled')::boolean,false);
 elsif key='social_connect' then
  allowed:=coalesce((private_app.addon_entitlement_before_independent_v1(p_tenant_id,'addon.marketing_attribution')->>'enabled')::boolean,false)
    or coalesce((private_app.addon_entitlement_before_independent_v1(p_tenant_id,'addon.integration.whatsapp')->>'enabled')::boolean,false);
 end if;
 if allowed then b:=b||jsonb_build_object('enabled',true,'status','active','source',case when key='templates' then 'free' else 'component' end); end if;
 if exists(select 1 from catalog.independent_commercial_catalog_v1 where kind='addon' and product_key=key) or key in ('delivery_analytics','social_connect') then
  b:=(b-'limit'-'remaining')||jsonb_build_object('openUsage',true);
 end if;
 return b;
end $$;
revoke all on function private_app.addon_entitlement_v3(uuid,text) from public,anon,authenticated,service_role;

-- The only priced input is an offer selected on the server. Caller supplied
-- prices, taxes, plan names, limits and claimed payment success are ignored.
create function public.v4_tenant_independent_addon_order(p_slug text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t core.tenants%rowtype; p catalog.addon_products%rowtype; c catalog.independent_commercial_catalog_v1%rowtype;
 o marketplace.orders%rowtype; i marketplace.order_items%rowtype; provider marketplace.payment_provider_configs%rowtype;
 actor uuid; cycle text; v_provider_key text; request_key text; amount bigint; subtotal bigint; tax bigint; feature_key text;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null then raise exception 'tenant_not_found'; end if;
 if not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 if jsonb_typeof(p_payload)<>'object' or p_payload->>'itemType' is distinct from 'addon' then raise exception 'marketplace_product_invalid'; end if;
 if nullif(btrim(p_payload->>'promotionCode'),'') is not null then raise exception 'addon_promotions_not_available'; end if;
 cycle:=coalesce(p_payload->>'billingInterval','year');
 if cycle not in ('month','year') then raise exception 'invalid_billing_interval'; end if;
 if coalesce(p_payload->>'quantity','1')<>'1' then raise exception 'marketplace_quantity_invalid'; end if;
 request_key:=p_payload->>'idempotencyKey';
 if request_key is null or request_key !~ '^[A-Za-z0-9_-]{16,120}$' then raise exception 'marketplace_idempotency_required'; end if;
 v_provider_key:=coalesce(p_payload->>'paymentProvider','bank_transfer');
 if v_provider_key not in ('bank_transfer','paymob','tamara') then raise exception 'marketplace_payment_provider_unavailable'; end if;
 actor:=private_app.current_subject_id();
 perform pg_advisory_xact_lock(hashtextextended(t.id::text||':addon:idempotency:'||request_key,0));
 select * into o from marketplace.orders where tenant_id=t.id and idempotency_key=request_key for update;
 if o.id is not null then
  select * into i from marketplace.order_items where order_id=o.id limit 1;
  if o.order_kind<>'addon' or i.product_key is distinct from p_payload->>'productKey' or o.payment_provider is distinct from v_provider_key
     or coalesce(i.metadata->>'billingInterval','year')<>cycle then raise exception 'marketplace_idempotency_conflict'; end if;
  return private_app.marketplace_order_payload(o.id)||jsonb_build_object('duplicate',true,'billingInterval',cycle,'paymentProvider',o.payment_provider);
 end if;
 select product.* into p from catalog.addon_products product where product.product_key=p_payload->>'productKey' and product.status in ('beta','active') and product.is_marketplace_visible for share;
 if p.id is null then raise exception 'marketplace_product_not_found'; end if;
 select * into c from catalog.independent_commercial_catalog_v1 where kind='addon' and addon_product_id=p.id and published for share;
 if c.id is null or c.monthly_amount_minor<=0 then raise exception 'marketplace_product_not_found'; end if;
 select f.feature_key into feature_key from catalog.features f where f.id=p.feature_id;
 if coalesce((private_app.addon_entitlement_v3(t.id,feature_key)->>'enabled')::boolean,false) then raise exception 'addon_already_enabled'; end if;
 select * into provider from marketplace.payment_provider_configs where payment_provider_configs.provider_key=v_provider_key;
 if provider.provider_key is null then raise exception 'marketplace_payment_provider_unavailable'; end if;
 if v_provider_key='paymob' then
  if not private_app.paymob_tenant_checkout_eligible_v1(t.id,provider.environment) then raise exception 'paymob_tenant_rollout_required'; end if;
 elsif v_provider_key='tamara' then
  if not private_app.tamara_eligible_v1(t.id) then raise exception 'marketplace_payment_provider_unavailable'; end if;
 elsif provider.status<>'active' or provider.last_verified_at is null or not('SAR'=any(provider.supported_currencies)) then
  raise exception 'marketplace_payment_provider_unavailable';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(t.id::text||':addon:'||p.product_key,0));
 if v_provider_key='tamara' and exists(select 1 from catalog.tenant_addon_subscriptions where tenant_id=t.id and product_id=p.id and status in ('pending','trialing','active','paused')) then raise exception 'tamara_existing_license_requires_resolution';end if;
 select orders.* into o from marketplace.orders orders join marketplace.order_items item on item.order_id=orders.id
 where orders.tenant_id=t.id and orders.status='pending_payment' and orders.payment_status='pending' and item.addon_product_id=p.id order by orders.created_at desc limit 1 for update of orders;
 if o.id is not null then
  select * into i from marketplace.order_items where order_id=o.id limit 1;
  if o.payment_provider is distinct from v_provider_key or coalesce(i.metadata->>'billingInterval','year')<>cycle then raise exception 'existing_addon_order_requires_resolution'; end if;
  return private_app.marketplace_order_payload(o.id)||jsonb_build_object('duplicate',true,'duplicateReason','pending_product_order','billingInterval',cycle,'paymentProvider',o.payment_provider);
 end if;
 amount:=case cycle when 'month' then c.monthly_amount_minor else c.annual_amount_minor end;
 if c.tax_inclusive then subtotal:=round(amount/(1+c.tax_rate_bps/10000.0));tax:=amount-subtotal;
 else subtotal:=amount;tax:=round(subtotal*c.tax_rate_bps/10000.0);end if;
 insert into marketplace.orders(tenant_id,requested_by_subject_id,order_kind,status,payment_status,activation_state,currency,subtotal_minor,list_subtotal_minor,discount_minor,tax_minor,total_minor,tax_rate_bps,payment_provider,notes,idempotency_key)
 values(t.id,actor,'addon','pending_payment','pending','pending',c.currency,subtotal,subtotal,0,tax,subtotal+tax,c.tax_rate_bps,v_provider_key,left(nullif(btrim(p_payload->>'notes'),''),1000),request_key) returning * into o;
 insert into marketplace.order_items(order_id,item_type,addon_product_id,product_key,product_name_ar,quantity,unit_amount_minor,line_total_minor,metadata)
 values(o.id,'addon',p.id,p.product_key,c.name_ar,1,subtotal,subtotal,jsonb_build_object('commercialPolicy','independent-v1','offerId',c.id,'billingInterval',cycle,'termMonths',case cycle when 'month' then 1 else 12 end,'quotedAmountMinor',amount,'taxRateBps',c.tax_rate_bps,'taxInclusive',c.tax_inclusive,'externalFeesExcluded',true));
 insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,to_status,metadata) values(o.id,t.id,actor,'order_created','pending_payment',jsonb_build_object('productKey',p.product_key,'billingInterval',cycle,'commercialPolicy','independent-v1'));
 perform private_app.write_audit('marketplace.order.created','marketplace_order',o.id::text,t.id,jsonb_build_object('orderNumber',o.order_number,'billingInterval',cycle,'totalMinor',o.total_minor));
 return private_app.marketplace_order_payload(o.id)||jsonb_build_object('duplicate',false,'billingInterval',cycle,'paymentProvider',v_provider_key);
end $$;
revoke all on function public.v4_tenant_independent_addon_order(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v4_tenant_independent_addon_order(text,jsonb) to authenticated;

-- Keep a reversible copy of each changed routine. Fail closed on source drift;
-- a partial or accidental replacement must roll back this whole migration.
create function pg_temp.patch_commerce_function(sig text,needle text,replacement text,expected integer default 1) returns void
language plpgsql set search_path='' as $$
declare src text; count_matches integer;
begin
 if to_regprocedure(sig) is null then raise exception 'commercial_release_missing_function: %',sig; end if;
 src:=pg_get_functiondef(to_regprocedure(sig));
 count_matches:=(length(src)-length(replace(src,needle,'')))/length(needle);
 if count_matches<>expected then raise exception 'commercial_release_source_drift: % (%)',sig,count_matches; end if;
 update catalog.independent_commerce_rollback_v1 set function_definitions=function_definitions||jsonb_build_object(sig,src) where release_key='independent-v1' and not(function_definitions?sig);
 execute replace(src,needle,replacement);
end $$;

-- All three payment providers now freeze and fulfil the ORDER's chosen cycle.
-- Existing attempts retain their existing snapshot; old orders without this
-- release metadata keep the original annual-product fallback.
select pg_temp.patch_commerce_function('public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)',
 'then addon.interval else null',
 'then coalesce(item.metadata->>''billingInterval'',addon.interval) else null');
select pg_temp.patch_commerce_function('public.v1_tenant_tamara_prepare(text,uuid)',
 '''billing_interval'',p.interval',
 '''billing_interval'',coalesce(i.metadata->>''billingInterval'',p.interval)');
select pg_temp.patch_commerce_function('private_app.marketplace_record_payment(uuid,text,text,text,text,bigint,text,boolean,text,uuid)',
 'case v_product.interval',
 'case coalesce(v_item.metadata->>''billingInterval'',v_product.interval)',2);
-- Apply both halves atomically: an intermediate CASE would not compile.
do $bank_patch$
declare sig text:='public.v3_platform_bank_transfer_action(uuid,text,text,text)'; src text;
 a text:='price_version_id=coalesce(subscription.price_version_id,('; b text:=')),period_is_authoritative=true';
begin
 src:=pg_get_functiondef(to_regprocedure(sig));
 if (length(src)-length(replace(src,a,'')))/length(a)<>1 or (length(src)-length(replace(src,b,'')))/length(b)<>1 then raise exception 'commercial_release_source_drift: %',sig;end if;
 update catalog.independent_commerce_rollback_v1 set function_definitions=function_definitions||jsonb_build_object(sig,src) where release_key='independent-v1';
 src:=replace(src,a,'price_version_id=case when exists(select 1 from marketplace.order_items ci where ci.order_id=v_order.id and ci.metadata->>''commercialPolicy''=''independent-v1'') then null else coalesce(subscription.price_version_id,(');
 src:=replace(src,b,')) end,period_is_authoritative=true');
 execute src;
end $bank_patch$;
select pg_temp.patch_commerce_function('public.v1_tenant_marketplace_replace_payment(text,jsonb)',
 '''promotionCode'',o.promotion_code);',
 '''promotionCode'',o.promotion_code,''billingInterval'',coalesce(i.metadata->>''billingInterval'',''year''));');

-- Make every previously public add-on order entry point use the same server
-- quote. Service checkout and all non-create actions keep their audited paths.
alter function public.v1_tenant_marketplace_action(text,text,jsonb) rename to v1_tenant_marketplace_action_before_independent_v1;
alter function public.v1_tenant_marketplace_action_before_independent_v1(text,text,jsonb) set schema private_app;
revoke all on function private_app.v1_tenant_marketplace_action_before_independent_v1(text,text,jsonb) from public,anon,authenticated,service_role;
create function public.v1_tenant_marketplace_action(p_slug text,p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_action='create_order' and p_payload->>'itemType'='addon' and p_payload->>'productKey' in ('delivery_analytics','social_connect') then raise exception 'addon_component_not_sold_separately';end if;
 if p_action='create_order' and p_payload->>'itemType'='addon' and exists(select 1 from catalog.independent_commercial_catalog_v1 where kind='addon' and product_key=p_payload->>'productKey') then
  return public.v4_tenant_independent_addon_order(p_slug,p_payload);
 end if;
 return private_app.v1_tenant_marketplace_action_before_independent_v1(p_slug,p_action,p_payload);
end $$;
revoke all on function public.v1_tenant_marketplace_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_marketplace_action(text,text,jsonb) to authenticated;
alter function public.v2_tenant_marketplace_action(text,text,jsonb) rename to v2_tenant_marketplace_action_before_independent_v1;
alter function public.v2_tenant_marketplace_action_before_independent_v1(text,text,jsonb) set schema private_app;
revoke all on function private_app.v2_tenant_marketplace_action_before_independent_v1(text,text,jsonb) from public,anon,authenticated,service_role;
create function public.v2_tenant_marketplace_action(p_slug text,p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_action='create_order' and p_payload->>'itemType'='addon' and p_payload->>'productKey' in ('delivery_analytics','social_connect') then raise exception 'addon_component_not_sold_separately';end if;
 if p_action='create_order' and p_payload->>'itemType'='addon' and exists(select 1 from catalog.independent_commercial_catalog_v1 where kind='addon' and product_key=p_payload->>'productKey') then
  return public.v4_tenant_independent_addon_order(p_slug,p_payload);
 end if;
 return private_app.v2_tenant_marketplace_action_before_independent_v1(p_slug,p_action,p_payload);
end $$;
revoke all on function public.v2_tenant_marketplace_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v2_tenant_marketplace_action(text,text,jsonb) to authenticated;
alter function public.v1_tenant_tamara_create_order(text,jsonb) rename to v1_tenant_tamara_create_order_before_independent_v1;
alter function public.v1_tenant_tamara_create_order_before_independent_v1(text,jsonb) set schema private_app;
revoke all on function private_app.v1_tenant_tamara_create_order_before_independent_v1(text,jsonb) from public,anon,authenticated,service_role;
create function public.v1_tenant_tamara_create_order(p_slug text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_payload->>'paymentProvider' is distinct from 'tamara' then raise exception 'marketplace_payment_provider_mismatch';end if;
 if p_payload->>'productKey' in ('delivery_analytics','social_connect') then raise exception 'addon_component_not_sold_separately';end if;
 if exists(select 1 from catalog.independent_commercial_catalog_v1 where kind='addon' and product_key=p_payload->>'productKey') then
  return public.v4_tenant_independent_addon_order(p_slug,p_payload);
 end if;
 return private_app.v1_tenant_tamara_create_order_before_independent_v1(p_slug,p_payload);
end $$;
revoke all on function public.v1_tenant_tamara_create_order(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_tamara_create_order(text,jsonb) to authenticated;

-- Promotions cannot be reintroduced with a crafted RPC after checkout.
-- Existing historical discounted orders and service purchases remain valid.
select pg_temp.patch_commerce_function('private_app.marketplace_apply_promotion_v1(uuid,uuid,text,uuid)',
 'begin',
 E'begin\n if exists(select 1 from marketplace.order_items where order_id=p_order_id and item_type=''addon'' and metadata->>''commercialPolicy''=''independent-v1'') then raise exception ''addon_promotions_not_available''; end if;',1);

-- Default NEW registrations to the new perpetual free edition. No current
-- tenant is migrated and the legacy free/full plans are not edited or deleted.
alter function private_app.provision_tenant_core(text,text,text,text,text,text,text,text,text,text,uuid,jsonb) rename to provision_tenant_core_before_independent_v1;
revoke all on function private_app.provision_tenant_core_before_independent_v1(text,text,text,text,text,text,text,text,text,text,uuid,jsonb) from public,anon,authenticated,service_role;
create function private_app.provision_tenant_core(p_display_name text,p_legal_name text,p_slug text,p_country_code text,p_timezone text,p_plan_key text,p_owner_name text,p_owner_email text,p_hostname text,p_link_policy text,p_invited_by_subject_id uuid,p_tenant_settings jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 return private_app.provision_tenant_core_before_independent_v1(p_display_name,p_legal_name,p_slug,p_country_code,p_timezone,
  case when coalesce(nullif(btrim(p_plan_key),''),'free')='free' then 'core_free' else p_plan_key end,
  p_owner_name,p_owner_email,p_hostname,p_link_policy,p_invited_by_subject_id,p_tenant_settings);
end $$;
revoke all on function private_app.provision_tenant_core(text,text,text,text,text,text,text,text,text,text,uuid,jsonb) from public,anon,authenticated,service_role;

-- A separate source-of-truth ledger for new licenses; old yearly price-version
-- rows stay intact for historical contracts and Reef. No tenant row is copied.
create table catalog.independent_addon_license_terms_v1 (
 order_item_id uuid primary key references marketplace.order_items(id),
 subscription_id uuid not null references catalog.tenant_addon_subscriptions(id),
 offer_id uuid not null references catalog.independent_commercial_catalog_v1(id),
 billing_interval text not null check(billing_interval in ('month','year')),
 quoted_amount_minor bigint not null check(quoted_amount_minor>=0),
 created_at timestamptz not null default now()
);
create index independent_addon_terms_subscription_idx on catalog.independent_addon_license_terms_v1(subscription_id);
create index independent_addon_terms_offer_idx on catalog.independent_addon_license_terms_v1(offer_id);
alter table catalog.independent_addon_license_terms_v1 enable row level security;
revoke all on catalog.independent_addon_license_terms_v1 from public,anon,authenticated,service_role;
create function private_app.record_independent_addon_license_terms_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.marketplace_order_id is null then return new; end if;
 insert into catalog.independent_addon_license_terms_v1(order_item_id,subscription_id,offer_id,billing_interval,quoted_amount_minor)
 select i.id,new.id,(i.metadata->>'offerId')::uuid,i.metadata->>'billingInterval',(i.metadata->>'quotedAmountMinor')::bigint
 from marketplace.order_items i join marketplace.orders o on o.id=i.order_id
 where i.order_id=new.marketplace_order_id and o.tenant_id=new.tenant_id and i.addon_product_id=new.product_id and i.metadata->>'commercialPolicy'='independent-v1'
 on conflict(order_item_id) do nothing;
 return new;
end $$;
revoke all on function private_app.record_independent_addon_license_terms_v1() from public,anon,authenticated,service_role;
create trigger record_independent_addon_terms after insert or update of marketplace_order_id on catalog.tenant_addon_subscriptions
for each row execute function private_app.record_independent_addon_license_terms_v1();

-- Release assertions are deliberately blocking, not advisory.
do $$
begin
 if (select count(*) from catalog.independent_commercial_catalog_v1 where kind='core')<>4
  or (select count(*) from catalog.independent_commercial_catalog_v1 where kind='addon')<>16 then raise exception 'commercial_catalog_incomplete';end if;
 if exists(select 1 from catalog.independent_commercial_catalog_v1 c join catalog.plan_features pf on pf.plan_id=c.plan_id join catalog.addon_products a on a.feature_id=pf.feature_id where c.kind='core') then raise exception 'core_addon_coupling_detected';end if;
 if (select before_state from independent_release_guard) is distinct from pg_temp.reef_commerce_fingerprint() then raise exception 'reef_protected_state_changed';end if;
end $$;
notify pgrst,'reload schema';
commit;
