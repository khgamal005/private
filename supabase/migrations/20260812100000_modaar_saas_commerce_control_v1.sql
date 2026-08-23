begin;

-- ODEIR SaaS commerce control v1.
-- Additive only: no tenant, Reef, subscription, order, customer or employee data is removed.

alter table catalog.plans
  add column if not exists display_order integer not null default 100,
  add column if not exists is_public boolean not null default true;

create table if not exists catalog.plan_limit_definitions (
  limit_key text primary key check (limit_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  name_ar text not null,
  description_ar text,
  unit_ar text not null,
  source_key text not null,
  enforceable boolean not null default true,
  display_order integer not null default 100,
  status text not null default 'active' check (status in ('active','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists catalog.plan_limits (
  plan_id uuid not null references catalog.plans(id) on delete cascade,
  limit_key text not null references catalog.plan_limit_definitions(limit_key) on delete restrict,
  limit_value bigint check (limit_value is null or limit_value >= 0),
  enforcement text not null default 'hard' check (enforcement in ('hard','soft')),
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (plan_id,limit_key)
);

create index if not exists catalog_plan_limits_subject_idx
  on catalog.plan_limits(updated_by_subject_id);

insert into catalog.plan_limit_definitions(
  limit_key,name_ar,description_ar,unit_ar,source_key,enforceable,display_order,status
)
values
  ('max_employees','عدد الموظفين','الحسابات النشطة والمدعوة داخل المنشأة','موظف','tenant_memberships',true,10,'active'),
  ('max_students','عدد الطلاب','إجمالي ملفات الطلاب غير المعطلة','طالب','academy_students',true,20,'active'),
  ('max_courses','عدد البرامج والدورات','إجمالي البرامج والدورات المعرفة داخل المنشأة','دورة','academy_courses',true,30,'active'),
  ('max_leads','عدد العملاء','إجمالي سجلات العملاء داخل المنشأة','عميل','sales_contacts',true,40,'active'),
  ('max_branches','عدد الفروع','عدد فروع المنشأة عند تفعيل إدارة الفروع','فرع','tenant_branches',false,50,'active'),
  ('storage_gb','مساحة التخزين','إجمالي الملفات المسموح بها للمنشأة','جيجابايت','storage_usage',false,60,'active')
on conflict (limit_key) do update
set name_ar=excluded.name_ar,
    description_ar=excluded.description_ar,
    unit_ar=excluded.unit_ar,
    source_key=excluded.source_key,
    enforceable=excluded.enforceable,
    display_order=excluded.display_order,
    status=excluded.status,
    updated_at=now();

create table if not exists catalog.addon_categories (
  id uuid primary key default gen_random_uuid(),
  category_key text not null unique check (category_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  name_ar text not null,
  description_ar text,
  icon_key text not null default 'addon',
  display_order integer not null default 100,
  status text not null default 'active' check (status in ('active','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table catalog.addon_products
  add column if not exists category_id uuid references catalog.addon_categories(id) on delete set null;

create index if not exists catalog_addon_products_category_idx
  on catalog.addon_products(category_id,sort_order);

insert into catalog.addon_categories(
  category_key,name_ar,description_ar,icon_key,display_order,status
)
values
  ('communications','التواصل والقنوات','واتساب والبريد والقنوات الموحدة','messages',10,'active'),
  ('integrations','التكاملات والمتاجر','ربط المتاجر والأنظمة الخارجية','integration',20,'active'),
  ('automation','الأتمتة والذكاء','أدوات الأتمتة والقوالب والتحليلات','automation',30,'active'),
  ('websites','المواقع والمحتوى','الموقع والمتجر والبيلدر وإدارة المحتوى','website',40,'active'),
  ('telephony','الاتصالات الهاتفية','السنترال وتقارير المكالمات','phone',50,'active'),
  ('analytics','التحليلات والقياس','الإسناد التسويقي وتحليلات الأداء','chart',60,'active')
on conflict (category_key) do update
set name_ar=excluded.name_ar,
    description_ar=excluded.description_ar,
    icon_key=excluded.icon_key,
    display_order=excluded.display_order,
    status=excluded.status,
    updated_at=now();

update catalog.addon_products product
set category_id=category.id
from catalog.addon_categories category
where product.category_id is null
  and category.category_key=case
    when product.product_key in ('whatsapp','email','zoom') then 'communications'
    when product.product_key in ('woocommerce','salla','zid','shopify','custom_store','api') then 'integrations'
    when product.product_key in ('automation','templates','delivery_analytics') then 'automation'
    when product.product_key='cms_pro' then 'websites'
    when product.product_key='yeastar' then 'telephony'
    when product.product_key='marketing_attribution' then 'analytics'
    else 'integrations'
  end;

alter table catalog.plan_limit_definitions enable row level security;
alter table catalog.plan_limits enable row level security;
alter table catalog.addon_categories enable row level security;

revoke all on table catalog.plan_limit_definitions from public,anon,authenticated;
revoke all on table catalog.plan_limits from public,anon,authenticated;
revoke all on table catalog.addon_categories from public,anon,authenticated;

create or replace function private_app.current_plan_limit(
  p_tenant_id uuid,
  p_limit_key text
)
returns jsonb
language sql
stable security definer
set search_path=''
as $$
  select coalesce((
    select jsonb_build_object(
      'planId',plan.id,
      'planKey',plan.plan_key,
      'planName',plan.name_ar,
      'limitKey',definition.limit_key,
      'limitValue',limits.limit_value,
      'enforcement',coalesce(limits.enforcement,'hard'),
      'enforceable',definition.enforceable
    )
    from catalog.subscriptions subscription
    join catalog.plans plan on plan.id=subscription.plan_id
    join catalog.plan_limit_definitions definition
      on definition.limit_key=p_limit_key and definition.status='active'
    left join catalog.plan_limits limits
      on limits.plan_id=plan.id and limits.limit_key=definition.limit_key
    where subscription.tenant_id=p_tenant_id
      and subscription.status in ('trialing','active','past_due','paused')
    order by subscription.created_at desc
    limit 1
  ),jsonb_build_object(
    'limitKey',p_limit_key,
    'limitValue',null,
    'enforcement','hard',
    'enforceable',false
  ));
$$;

create or replace function private_app.tenant_plan_usage_count(
  p_tenant_id uuid,
  p_limit_key text
)
returns bigint
language plpgsql
stable security definer
set search_path=''
as $$
declare
  v_count bigint:=0;
begin
  if p_limit_key='max_employees' then
    select count(*) into v_count
    from access_control.memberships membership
    where membership.tenant_id=p_tenant_id
      and membership.scope='tenant'
      and membership.status in ('invited','active');
  elsif p_limit_key='max_students' then
    select count(*) into v_count
    from academy.students student
    where student.tenant_id=p_tenant_id
      and student.status<>'blocked';
  elsif p_limit_key='max_courses' then
    select count(*) into v_count
    from academy.courses course
    where course.tenant_id=p_tenant_id;
  elsif p_limit_key='max_leads' then
    select count(*) into v_count
    from sales_core.contacts contact
    where contact.tenant_id=p_tenant_id;
  elsif p_limit_key='max_branches' and to_regclass('core.branches') is not null then
    execute 'select count(*) from core.branches where tenant_id=$1'
      into v_count using p_tenant_id;
  else
    v_count:=0;
  end if;
  return coalesce(v_count,0);
end;
$$;

create or replace function private_app.enforce_tenant_plan_limit(
  p_tenant_id uuid,
  p_limit_key text
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_limit jsonb;
  v_limit_value bigint;
  v_used bigint;
begin
  if p_tenant_id is null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_limit_key,0));
  v_limit:=private_app.current_plan_limit(p_tenant_id,p_limit_key);
  v_limit_value:=nullif(v_limit->>'limitValue','')::bigint;
  if v_limit_value is null
     or coalesce((v_limit->>'enforceable')::boolean,false)=false
     or coalesce(v_limit->>'enforcement','hard')='soft' then
    return;
  end if;
  v_used:=private_app.tenant_plan_usage_count(p_tenant_id,p_limit_key);
  if v_used>=v_limit_value then
    raise exception 'plan_limit_reached';
  end if;
end;
$$;

create or replace function private_app.enforce_membership_plan_limit_v4()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if tg_op='INSERT' and new.scope='tenant' and new.status in ('invited','active') then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_employees');
  elsif tg_op='UPDATE' and new.scope='tenant' and new.status in ('invited','active')
     and (old.scope<>'tenant' or old.status not in ('invited','active') or old.tenant_id is distinct from new.tenant_id) then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_employees');
  end if;
  return new;
end;
$$;

drop trigger if exists memberships_plan_limit_v4 on access_control.memberships;
create trigger memberships_plan_limit_v4
before insert or update of tenant_id,scope,status on access_control.memberships
for each row execute function private_app.enforce_membership_plan_limit_v4();

create or replace function private_app.enforce_student_plan_limit_v4()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if tg_op='INSERT' and new.status<>'blocked' then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_students');
  elsif tg_op='UPDATE' and new.status<>'blocked'
     and (old.status='blocked' or old.tenant_id is distinct from new.tenant_id) then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_students');
  end if;
  return new;
end;
$$;

drop trigger if exists students_plan_limit_v4 on academy.students;
create trigger students_plan_limit_v4
before insert or update of tenant_id,status on academy.students
for each row execute function private_app.enforce_student_plan_limit_v4();

create or replace function private_app.enforce_course_plan_limit_v4()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if tg_op='INSERT' then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_courses');
  elsif tg_op='UPDATE' and old.tenant_id is distinct from new.tenant_id then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_courses');
  end if;
  return new;
end;
$$;

drop trigger if exists courses_plan_limit_v4 on academy.courses;
create trigger courses_plan_limit_v4
before insert or update of tenant_id on academy.courses
for each row execute function private_app.enforce_course_plan_limit_v4();

create or replace function private_app.enforce_lead_plan_limit_v4()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if tg_op='INSERT' then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_leads');
  elsif tg_op='UPDATE' and old.tenant_id is distinct from new.tenant_id then
    perform private_app.enforce_tenant_plan_limit(new.tenant_id,'max_leads');
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_plan_limit_v4 on sales_core.contacts;
create trigger contacts_plan_limit_v4
before insert or update of tenant_id on sales_core.contacts
for each row execute function private_app.enforce_lead_plan_limit_v4();

create or replace function public.v4_tenant_plan_usage(p_slug text)
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
begin
  select * into v_tenant from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_access_tenant(v_tenant.id) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'tenantId',v_tenant.id,
    'limits',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',definition.limit_key,
        'name',definition.name_ar,
        'unit',definition.unit_ar,
        'used',private_app.tenant_plan_usage_count(v_tenant.id,definition.limit_key),
        'limit',(private_app.current_plan_limit(v_tenant.id,definition.limit_key)->>'limitValue')::bigint,
        'enforcement',private_app.current_plan_limit(v_tenant.id,definition.limit_key)->>'enforcement',
        'enforceable',definition.enforceable
      ) order by definition.display_order)
      from catalog.plan_limit_definitions definition
      where definition.status='active'
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function public.v4_platform_commerce_snapshot()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  return jsonb_build_object(
    'generatedAt',now(),
    'summary',jsonb_build_object(
      'planCount',(select count(*) from catalog.plans where status<>'archived'),
      'activeSubscriptions',(select count(*) from catalog.subscriptions where status='active'),
      'trialSubscriptions',(select count(*) from catalog.subscriptions where status='trialing'),
      'pastDueSubscriptions',(select count(*) from catalog.subscriptions where status='past_due'),
      'monthlyRecurringMinor',coalesce((
        select sum(case when plan.interval='month' then plan.amount_minor when plan.interval='year' then round(plan.amount_minor/12.0)::bigint else 0 end)
        from catalog.subscriptions subscription
        join catalog.plans plan on plan.id=subscription.plan_id
        where subscription.status='active'
      ),0),
      'paidRevenueMinor',(select coalesce(sum(total_minor),0) from marketplace.orders where payment_status='paid'),
      'pendingPayments',(select count(*) from marketplace.orders where payment_status='pending'),
      'serviceOrdersOpen',(select count(*) from marketplace.orders where order_kind='service' and status in ('paid','in_progress'))
    ),
    'limitDefinitions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',definition.limit_key,'name',definition.name_ar,
        'description',definition.description_ar,'unit',definition.unit_ar,
        'sourceKey',definition.source_key,'enforceable',definition.enforceable
      ) order by definition.display_order)
      from catalog.plan_limit_definitions definition where definition.status='active'
    ),'[]'::jsonb),
    'plans',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',plan.id,'key',plan.plan_key,'nameAr',plan.name_ar,'nameEn',plan.name_en,
        'description',plan.description,'amountMinor',plan.amount_minor,'currency',plan.currency,
        'interval',plan.interval,'status',plan.status,'isPublic',plan.is_public,
        'subscriberCount',(select count(*) from catalog.subscriptions subscription where subscription.plan_id=plan.id and subscription.status in ('trialing','active','past_due','paused')),
        'limits',coalesce((select jsonb_agg(jsonb_build_object(
          'key',definition.limit_key,'name',definition.name_ar,'unit',definition.unit_ar,
          'value',limits.limit_value,'enforcement',coalesce(limits.enforcement,'hard'),
          'enforceable',definition.enforceable
        ) order by definition.display_order)
        from catalog.plan_limit_definitions definition
        left join catalog.plan_limits limits on limits.plan_id=plan.id and limits.limit_key=definition.limit_key
        where definition.status='active'),'[]'::jsonb)
      ) order by plan.display_order,plan.amount_minor,plan.created_at)
      from catalog.plans plan
    ),'[]'::jsonb),
    'subscriptions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',subscription.id,'tenantId',tenant.id,'tenantName',tenant.name,'tenantSlug',tenant.slug,
        'planId',plan.id,'planKey',plan.plan_key,'planName',plan.name_ar,
        'status',subscription.status,'periodStart',subscription.period_start,
        'periodEnd',subscription.period_end,'cancelAtPeriodEnd',subscription.cancel_at_period_end
      ) order by subscription.created_at desc)
      from catalog.subscriptions subscription
      join core.tenants tenant on tenant.id=subscription.tenant_id
      join catalog.plans plan on plan.id=subscription.plan_id
    ),'[]'::jsonb),
    'tenants',coalesce((
      select jsonb_agg(jsonb_build_object('id',tenant.id,'name',tenant.name,'slug',tenant.slug,'status',tenant.status) order by tenant.name)
      from core.tenants tenant
    ),'[]'::jsonb),
    'addonCategories',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',category.id,'key',category.category_key,'name',category.name_ar,
        'description',category.description_ar,'iconKey',category.icon_key,
        'status',category.status,'productCount',(select count(*) from catalog.addon_products product where product.category_id=category.id)
      ) order by category.display_order,category.name_ar)
      from catalog.addon_categories category
    ),'[]'::jsonb),
    'addons',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',product.id,'key',product.product_key,'name',product.name_ar,
        'description',product.description_ar,'categoryId',category.id,'categoryName',category.name_ar,
        'amountMinor',product.amount_minor,'currency',product.currency,'interval',product.interval,
        'status',product.status,'pricingMode',product.pricing_mode
      ) order by coalesce(category.display_order,999),product.sort_order)
      from catalog.addon_products product
      left join catalog.addon_categories category on category.id=product.category_id
    ),'[]'::jsonb),
    'serviceCategories',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',category.id,'key',category.category_key,'name',category.name_ar,
        'description',category.description_ar,'iconKey',category.icon_key,'status',category.status,
        'productCount',(select count(*) from marketplace.service_products product where product.category_id=category.id)
      ) order by category.sort_order,category.name_ar)
      from marketplace.service_categories category
    ),'[]'::jsonb),
    'services',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',product.id,'key',product.product_key,'name',product.name_ar,'description',product.description_ar,
        'categoryId',category.id,'categoryName',category.name_ar,'pricingMode',product.pricing_mode,
        'amountMinor',product.amount_minor,'currency',product.currency,'unitLabel',product.unit_label_ar,
        'turnaroundDays',product.turnaround_days,'badge',product.badge_ar,'status',product.status
      ) order by category.sort_order,product.sort_order)
      from marketplace.service_products product
      join marketplace.service_categories category on category.id=product.category_id
    ),'[]'::jsonb),
    'orders',coalesce((
      select jsonb_agg(private_app.marketplace_order_payload(recent.id)||jsonb_build_object(
        'tenantName',recent.tenant_name,'tenantSlug',recent.tenant_slug
      ) order by recent.created_at desc)
      from (
        select orders.id,orders.created_at,tenant.name tenant_name,tenant.slug tenant_slug
        from marketplace.orders orders join core.tenants tenant on tenant.id=orders.tenant_id
        order by orders.created_at desc limit 200
      ) recent
    ),'[]'::jsonb),
    'payments',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',payment.id,'orderId',orders.id,'orderNumber',orders.order_number,
        'tenantName',tenant.name,'providerKey',payment.provider_key,
        'providerEventId',payment.provider_event_id,'reference',payment.payment_reference,
        'state',payment.state,'amountMinor',payment.amount_minor,'currency',payment.currency,
        'signatureVerified',payment.signature_verified,'processedAt',payment.processed_at
      ) order by payment.processed_at desc)
      from marketplace.payment_events payment
      join marketplace.orders orders on orders.id=payment.order_id
      join core.tenants tenant on tenant.id=orders.tenant_id
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function public.v4_platform_commerce_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_plan catalog.plans%rowtype;
  v_plan_id uuid;
  v_category_id uuid;
  v_product_id uuid;
  v_limit record;
  v_status text;
  v_interval text;
  v_amount bigint;
  v_tenant_id uuid;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_subscription_id uuid;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden'; end if;

  if p_action='save_plan' then
    v_plan_id=nullif(p_payload->>'planId','')::uuid;
    v_status=coalesce(nullif(p_payload->>'status',''),'active');
    v_interval=coalesce(nullif(p_payload->>'interval',''),'month');
    v_amount=coalesce((p_payload->>'amountMinor')::bigint,0);
    if coalesce(trim(p_payload->>'nameAr'),'')='' then raise exception 'plan_name_required'; end if;
    if v_status not in ('draft','active','archived') then raise exception 'invalid_plan_status'; end if;
    if v_interval not in ('month','year','one_time') then raise exception 'invalid_plan_interval'; end if;
    if v_amount<0 then raise exception 'invalid_plan_price'; end if;
    if v_plan_id is null then
      if coalesce(p_payload->>'planKey','')!~'^[a-z][a-z0-9_]{2,60}$' then raise exception 'invalid_plan_key'; end if;
      insert into catalog.plans(
        plan_key,name_ar,name_en,description,amount_minor,currency,interval,status,is_public,display_order
      ) values(
        p_payload->>'planKey',trim(p_payload->>'nameAr'),nullif(trim(p_payload->>'nameEn'),''),
        nullif(trim(p_payload->>'description'),''),v_amount,upper(coalesce(nullif(p_payload->>'currency',''),'SAR')),
        v_interval,v_status,coalesce((p_payload->>'isPublic')::boolean,true),coalesce((p_payload->>'displayOrder')::integer,100)
      ) returning * into v_plan;
    else
      update catalog.plans set
        name_ar=trim(p_payload->>'nameAr'),name_en=nullif(trim(p_payload->>'nameEn'),''),
        description=nullif(trim(p_payload->>'description'),''),amount_minor=v_amount,
        currency=upper(coalesce(nullif(p_payload->>'currency',''),currency)),interval=v_interval,
        status=v_status,is_public=coalesce((p_payload->>'isPublic')::boolean,is_public),
        display_order=coalesce((p_payload->>'displayOrder')::integer,display_order),updated_at=now()
      where id=v_plan_id returning * into v_plan;
      if v_plan.id is null then raise exception 'plan_not_found'; end if;
    end if;
    perform private_app.write_audit('plan.saved','plan',v_plan.id::text,null,jsonb_build_object('planKey',v_plan.plan_key));
    return jsonb_build_object('id',v_plan.id,'key',v_plan.plan_key);

  elsif p_action='save_plan_limits' then
    v_plan_id=nullif(p_payload->>'planId','')::uuid;
    if not exists(select 1 from catalog.plans where id=v_plan_id) then raise exception 'plan_not_found'; end if;
    for v_limit in
      select definition.limit_key,
             p_payload->'limits'->definition.limit_key->>'value' limit_value,
             coalesce(nullif(p_payload->'limits'->definition.limit_key->>'enforcement',''),'hard') enforcement
      from catalog.plan_limit_definitions definition where definition.status='active'
    loop
      if v_limit.enforcement not in ('hard','soft') then raise exception 'invalid_plan_limit'; end if;
      if v_limit.limit_value is not null and v_limit.limit_value<>'' and v_limit.limit_value::bigint<0 then raise exception 'invalid_plan_limit'; end if;
      insert into catalog.plan_limits(plan_id,limit_key,limit_value,enforcement,updated_by_subject_id)
      values(v_plan_id,v_limit.limit_key,
        case when v_limit.limit_value is null or v_limit.limit_value='' then null else v_limit.limit_value::bigint end,
        v_limit.enforcement,private_app.current_subject_id())
      on conflict (plan_id,limit_key) do update set
        limit_value=excluded.limit_value,enforcement=excluded.enforcement,
        updated_by_subject_id=excluded.updated_by_subject_id,updated_at=now();
    end loop;
    perform private_app.write_audit('plan.limits.saved','plan',v_plan_id::text,null,'{}'::jsonb);
    return jsonb_build_object('planId',v_plan_id,'saved',true);

  elsif p_action='set_subscription' then
    v_tenant_id=nullif(p_payload->>'tenantId','')::uuid;
    v_plan_id=nullif(p_payload->>'planId','')::uuid;
    v_status=coalesce(nullif(p_payload->>'status',''),'active');
    if v_status not in ('trialing','active','past_due','paused') then raise exception 'invalid_subscription_status'; end if;
    if not exists(select 1 from core.tenants where id=v_tenant_id) then raise exception 'tenant_not_found'; end if;
    if not exists(select 1 from catalog.plans where id=v_plan_id and status='active') then raise exception 'plan_not_found'; end if;
    v_period_start=coalesce(nullif(p_payload->>'periodStart','')::timestamptz,now());
    v_period_end=nullif(p_payload->>'periodEnd','')::timestamptz;
    if v_period_end is not null and v_period_end<=v_period_start then raise exception 'invalid_subscription_period'; end if;
    update catalog.subscriptions set status='cancelled',period_end=coalesce(period_end,now()),updated_at=now()
    where tenant_id=v_tenant_id and status in ('trialing','active','past_due','paused');
    insert into catalog.subscriptions(tenant_id,plan_id,status,period_start,period_end)
    values(v_tenant_id,v_plan_id,v_status,v_period_start,v_period_end)
    returning id into v_subscription_id;
    perform private_app.write_audit('subscription.changed','subscription',v_subscription_id::text,v_tenant_id,jsonb_build_object('planId',v_plan_id,'status',v_status));
    return jsonb_build_object('id',v_subscription_id,'tenantId',v_tenant_id);

  elsif p_action='save_addon_category' then
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    if coalesce(trim(p_payload->>'name'),'')='' then raise exception 'category_name_required'; end if;
    if v_category_id is null then
      if coalesce(p_payload->>'key','')!~'^[a-z][a-z0-9_]{2,60}$' then raise exception 'invalid_category_key'; end if;
      insert into catalog.addon_categories(category_key,name_ar,description_ar,icon_key,display_order,status)
      values(p_payload->>'key',trim(p_payload->>'name'),nullif(trim(p_payload->>'description'),''),
        coalesce(nullif(p_payload->>'iconKey',''),'addon'),coalesce((p_payload->>'displayOrder')::integer,100),'active')
      returning id into v_category_id;
    else
      update catalog.addon_categories set name_ar=trim(p_payload->>'name'),
        description_ar=nullif(trim(p_payload->>'description'),''),
        icon_key=coalesce(nullif(p_payload->>'iconKey',''),icon_key),updated_at=now()
      where id=v_category_id;
      if not found then raise exception 'category_not_found'; end if;
    end if;
    return jsonb_build_object('id',v_category_id);

  elsif p_action='assign_addon_category' then
    v_product_id=nullif(p_payload->>'productId','')::uuid;
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    if not exists(select 1 from catalog.addon_categories where id=v_category_id and status='active') then raise exception 'category_not_found'; end if;
    update catalog.addon_products set category_id=v_category_id,updated_at=now() where id=v_product_id;
    if not found then raise exception 'addon_product_not_found'; end if;
    return jsonb_build_object('id',v_product_id,'categoryId',v_category_id);

  elsif p_action='save_service_category' then
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    if coalesce(trim(p_payload->>'name'),'')='' then raise exception 'category_name_required'; end if;
    if v_category_id is null then
      if coalesce(p_payload->>'key','')!~'^[a-z][a-z0-9_]{2,60}$' then raise exception 'invalid_category_key'; end if;
      insert into marketplace.service_categories(category_key,name_ar,description_ar,icon_key,sort_order,status)
      values(p_payload->>'key',trim(p_payload->>'name'),nullif(trim(p_payload->>'description'),''),
        coalesce(nullif(p_payload->>'iconKey',''),'services'),coalesce((p_payload->>'displayOrder')::integer,100),'active')
      returning id into v_category_id;
    else
      update marketplace.service_categories set name_ar=trim(p_payload->>'name'),
        description_ar=nullif(trim(p_payload->>'description'),''),
        icon_key=coalesce(nullif(p_payload->>'iconKey',''),icon_key),updated_at=now()
      where id=v_category_id;
      if not found then raise exception 'category_not_found'; end if;
    end if;
    return jsonb_build_object('id',v_category_id);

  elsif p_action='save_service_product' then
    v_product_id=nullif(p_payload->>'productId','')::uuid;
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    v_amount=coalesce((p_payload->>'amountMinor')::bigint,0);
    if coalesce(trim(p_payload->>'name'),'')='' then raise exception 'service_name_required'; end if;
    if not exists(select 1 from marketplace.service_categories where id=v_category_id and status='active') then raise exception 'category_not_found'; end if;
    if v_product_id is null then
      if coalesce(p_payload->>'key','')!~'^[a-z][a-z0-9_]{2,80}$' then raise exception 'invalid_service_key'; end if;
      insert into marketplace.service_products(
        category_id,product_key,name_ar,description_ar,pricing_mode,amount_minor,currency,
        unit_label_ar,turnaround_days,badge_ar,status
      ) values(
        v_category_id,p_payload->>'key',trim(p_payload->>'name'),coalesce(nullif(trim(p_payload->>'description'),''),'خدمة من أودير'),
        coalesce(nullif(p_payload->>'pricingMode',''),'fixed'),v_amount,
        upper(coalesce(nullif(p_payload->>'currency',''),'SAR')),coalesce(nullif(trim(p_payload->>'unitLabel'),''),'خدمة'),
        nullif(p_payload->>'turnaroundDays','')::integer,nullif(trim(p_payload->>'badge'),''),
        coalesce(nullif(p_payload->>'status',''),'active')
      ) returning id into v_product_id;
    else
      update marketplace.service_products set category_id=v_category_id,name_ar=trim(p_payload->>'name'),
        description_ar=coalesce(nullif(trim(p_payload->>'description'),''),description_ar),
        pricing_mode=coalesce(nullif(p_payload->>'pricingMode',''),pricing_mode),amount_minor=v_amount,
        currency=upper(coalesce(nullif(p_payload->>'currency',''),currency)),
        unit_label_ar=coalesce(nullif(trim(p_payload->>'unitLabel'),''),unit_label_ar),
        turnaround_days=nullif(p_payload->>'turnaroundDays','')::integer,badge_ar=nullif(trim(p_payload->>'badge'),''),
        status=coalesce(nullif(p_payload->>'status',''),status),updated_at=now()
      where id=v_product_id;
      if not found then raise exception 'service_not_found'; end if;
    end if;
    return jsonb_build_object('id',v_product_id);
  else
    raise exception 'commerce_action_invalid';
  end if;
end;
$$;

revoke all on function private_app.current_plan_limit(uuid,text) from public,anon,authenticated;
revoke all on function private_app.tenant_plan_usage_count(uuid,text) from public,anon,authenticated;
revoke all on function private_app.enforce_tenant_plan_limit(uuid,text) from public,anon,authenticated;
revoke all on function private_app.enforce_membership_plan_limit_v4() from public,anon,authenticated;
revoke all on function private_app.enforce_student_plan_limit_v4() from public,anon,authenticated;
revoke all on function private_app.enforce_course_plan_limit_v4() from public,anon,authenticated;
revoke all on function private_app.enforce_lead_plan_limit_v4() from public,anon,authenticated;
revoke all on function public.v4_tenant_plan_usage(text) from public,anon,authenticated;
revoke all on function public.v4_platform_commerce_snapshot() from public,anon,authenticated;
revoke all on function public.v4_platform_commerce_action(text,jsonb) from public,anon,authenticated;

grant execute on function public.v4_tenant_plan_usage(text) to authenticated;
grant execute on function public.v4_platform_commerce_snapshot() to authenticated;
grant execute on function public.v4_platform_commerce_action(text,jsonb) to authenticated;

commit;
