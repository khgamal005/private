-- Modaar service and add-on marketplace (applied as 20260808000722).
-- Additive only: existing tenants, memberships, customers, integrations and URLs are untouched.

create schema if not exists marketplace;

create sequence if not exists marketplace.order_number_seq start with 1001;

create table if not exists marketplace.service_categories (
  id uuid primary key default gen_random_uuid(),
  category_key text not null unique check (category_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  name_ar text not null,
  description_ar text,
  icon_key text not null default 'services',
  sort_order integer not null default 100,
  status text not null default 'active' check (status in ('active','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists marketplace.service_products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references marketplace.service_categories(id) on delete restrict,
  product_key text not null unique check (product_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  name_ar text not null,
  description_ar text not null,
  pricing_mode text not null default 'fixed' check (pricing_mode in ('fixed','from','quote')),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  unit_label_ar text not null,
  turnaround_days integer check (turnaround_days is null or turnaround_days between 0 and 365),
  badge_ar text,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('draft','beta','active','archived')),
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pricing_mode = 'quote' or amount_minor > 0)
);

alter table catalog.addon_products
  add column if not exists marketplace_category text not null default 'integrations',
  add column if not exists badge_ar text,
  add column if not exists activation_mode text not null default 'entitlement';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='catalog.addon_products'::regclass
      and conname='addon_products_activation_mode_check'
  ) then
    alter table catalog.addon_products
      add constraint addon_products_activation_mode_check
      check (activation_mode in ('entitlement','module'));
  end if;
end
$$;

create table if not exists marketplace.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default (
    'MDR-' || to_char(current_date,'YYMM') || '-' ||
    lpad(nextval('marketplace.order_number_seq')::text,6,'0')
  ),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  requested_by_subject_id uuid references access_control.subjects(id) on delete set null,
  order_kind text not null check (order_kind in ('service','addon')),
  status text not null default 'pending_payment' check (
    status in ('pending_payment','paid','in_progress','completed','cancelled','refunded')
  ),
  payment_status text not null default 'pending' check (
    payment_status in ('pending','paid','failed','refunded','waived')
  ),
  activation_state text not null default 'not_applicable' check (
    activation_state in ('not_applicable','pending','active','failed','cancelled')
  ),
  currency text not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  tax_rate_bps integer not null default 1500 check (tax_rate_bps between 0 and 10000),
  notes text,
  payment_provider text,
  payment_reference text,
  paid_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,idempotency_key),
  check (total_minor = subtotal_minor + tax_minor)
);

create table if not exists marketplace.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references marketplace.orders(id) on delete cascade,
  item_type text not null check (item_type in ('service','addon')),
  service_product_id uuid references marketplace.service_products(id) on delete restrict,
  addon_product_id uuid references catalog.addon_products(id) on delete restrict,
  product_key text not null,
  product_name_ar text not null,
  quantity integer not null default 1 check (quantity between 1 and 1000),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    (item_type='service' and service_product_id is not null and addon_product_id is null)
    or
    (item_type='addon' and addon_product_id is not null and service_product_id is null)
  ),
  check (line_total_minor = unit_amount_minor * quantity)
);

create table if not exists marketplace.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references marketplace.orders(id) on delete cascade,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  actor_subject_id uuid references access_control.subjects(id) on delete set null,
  event_type text not null,
  from_status text,
  to_status text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists marketplace.payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  provider_key text not null,
  provider_event_id text not null,
  payment_reference text,
  state text not null check (state in ('paid','failed','refunded')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  signature_verified boolean not null default false,
  payload_sha256 text,
  processed_at timestamptz not null default now(),
  unique (provider_key,provider_event_id)
);

create table if not exists marketplace.payment_webhooks (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique,
  secret_id uuid not null,
  status text not null default 'active' check (status in ('active','disabled')),
  last_received_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketplace_orders_tenant_created_idx
  on marketplace.orders(tenant_id,created_at desc);
create index if not exists marketplace_orders_status_created_idx
  on marketplace.orders(status,created_at desc);
create index if not exists marketplace_order_items_order_idx
  on marketplace.order_items(order_id);
create index if not exists marketplace_order_events_order_created_idx
  on marketplace.order_events(order_id,created_at desc);
create index if not exists marketplace_payment_events_order_idx
  on marketplace.payment_events(order_id,processed_at desc);
create index if not exists marketplace_service_products_category_idx
  on marketplace.service_products(category_id,sort_order);

alter table marketplace.service_categories enable row level security;
alter table marketplace.service_products enable row level security;
alter table marketplace.orders enable row level security;
alter table marketplace.order_items enable row level security;
alter table marketplace.order_events enable row level security;
alter table marketplace.payment_events enable row level security;
alter table marketplace.payment_webhooks enable row level security;

revoke all on schema marketplace from public,anon,authenticated;
revoke all on all tables in schema marketplace from public,anon,authenticated;
revoke all on all sequences in schema marketplace from public,anon,authenticated;

insert into marketplace.service_categories(
  category_key,name_ar,description_ar,icon_key,sort_order,status
)
values
  ('lecturers','المحاضرون والمدربون','محاضرون ومدربون متخصصون حسب المجال والجمهور المستهدف.','lecturer',10,'active'),
  ('design','التصميم والإبداع','تصميم المواد التدريبية والحملات والهوية البصرية.','design',20,'active'),
  ('content','المحتوى والحقائب','بناء الحقائب والمحتوى التدريبي والتعليمي.','content',30,'active'),
  ('marketing','التسويق والنمو','صفحات هبوط وحملات إعلانية ومواد تحويل.','marketing',40,'active'),
  ('sales','المبيعات وخدمة العملاء','فرق مبيعات وخدمة عملاء متخصصة في قطاع التدريب.','sales',50,'active'),
  ('consulting','الاستشارات والتشغيل','استشارات تشغيل واعتماد وجودة ومؤشرات أداء.','consulting',60,'active'),
  ('technology','التقنية والمنصات','مواقع ومتاجر دورات وربط وتخصيص تقني.','technology',70,'active')
on conflict (category_key) do update
set name_ar=excluded.name_ar,
    description_ar=excluded.description_ar,
    icon_key=excluded.icon_key,
    sort_order=excluded.sort_order,
    status=excluded.status,
    updated_at=now();

insert into marketplace.service_products(
  category_id,product_key,name_ar,description_ar,pricing_mode,amount_minor,
  currency,unit_label_ar,turnaround_days,badge_ar,metadata,status,sort_order
)
select category.id,seed.product_key,seed.name_ar,seed.description_ar,
       seed.pricing_mode,seed.amount_minor,'SAR',seed.unit_label_ar,
       seed.turnaround_days,seed.badge_ar,seed.metadata,'active',seed.sort_order
from (
  values
    ('lecturers','lecturer_hour','ساعة تدريب مع محاضر متخصص','اختيار محاضر مناسب للتخصص مع مراجعة الملف وتنسيق الموعد.','from',75000,'للساعة',3,'الأكثر طلبًا','{"scope":"lecturer_matching"}'::jsonb,10),
    ('lecturers','workshop_day','يوم ورشة عمل احترافية','محاضر متخصص ليوم تدريبي حتى 6 ساعات مع تنسيق المحاور.','from',450000,'لليوم',5,null,'{"hours":6}'::jsonb,20),
    ('design','training_deck_design','تصميم عرض تدريبي احترافي','تصميم حتى 40 شريحة بهوية المنشأة ورسوم توضيحية متناسقة.','fixed',150000,'للعرض',7,'تسليم منظم','{"slides":40}'::jsonb,10),
    ('design','course_campaign_identity','هوية بصرية لحملة دورة','مفتاح بصري وإعلانات ثابتة وقوالب سوشيال متناسقة.','fixed',120000,'للحملة',5,null,'{"deliverables":8}'::jsonb,20),
    ('design','motion_video_minute','فيديو موشن جرافيك دقيقة','سيناريو بصري وتحريك احترافي لمدة تصل إلى 60 ثانية.','from',250000,'للفيديو',10,null,'{"durationSeconds":60}'::jsonb,30),
    ('content','training_bag','إعداد حقيبة تدريبية','بناء حقيبة متكاملة تشمل دليل المدرب والمتدرب والأنشطة والتقييم.','from',800000,'للحقيبة',20,'جودة أكاديمية','{"includesAssessment":true}'::jsonb,10),
    ('content','course_copywriting','كتابة محتوى صفحة دورة','صياغة عرض الدورة والمحاور والمخرجات والأسئلة الشائعة.','fixed',90000,'للدورة',4,null,'{}'::jsonb,20),
    ('marketing','landing_page','صفحة هبوط عالية التحويل','تصميم وبرمجة صفحة هبوط متجاوبة وربطها بالتتبع والنماذج.','from',350000,'للصفحة',7,'جاهزة للإعلانات','{"tracking":true}'::jsonb,10),
    ('marketing','ads_management_month','إدارة حملات إعلانية شهرية','تخطيط وتشغيل وتحسين الحملات مع تقرير أداء؛ الميزانية الإعلانية منفصلة.','fixed',700000,'شهريًا',3,'إدارة متخصصة','{"adSpendExcluded":true}'::jsonb,20),
    ('sales','sales_seat_month','مقعد مبيعات هاتفي','مسؤول مبيعات متخصص بمتابعة يومية وتقارير داخل مُدار.','fixed',230000,'للمقعد شهريًا',7,'فريق سعودي اللهجة','{"seatType":"sales"}'::jsonb,10),
    ('sales','customer_service_seat_month','مقعد خدمة عملاء','خدمة عملاء ومتابعة استفسارات المتدربين وفق إجراءات المنشأة.','fixed',250000,'للمقعد شهريًا',7,null,'{"seatType":"customer_service"}'::jsonb,20),
    ('consulting','operations_session','جلسة استشارة تشغيل ونمو','جلسة تشخيص وتشغيل مع توصيات قابلة للتنفيذ ومذكرة مختصرة.','fixed',150000,'للجلسة',3,null,'{"minutes":90}'::jsonb,10),
    ('consulting','kpi_framework','بناء منظومة مؤشرات أداء','تصميم مؤشرات الإدارات والتعريفات والمصادر ودورية القياس.','from',600000,'للمشروع',14,null,'{}'::jsonb,20),
    ('technology','course_store_website','موقع ومتجر برامج ودورات','موقع متجاوب ومتجر دورات وتتبع وربط بالعملاء ووسائل الدفع المتاحة.','from',1200000,'للمشروع',21,'حل متكامل','{"commerce":true}'::jsonb,10),
    ('technology','custom_integration','ربط تقني مخصص','تحليل وبناء ربط API أو Webhook مع نظام خارجي.','from',300000,'للربط',10,null,'{}'::jsonb,20)
) as seed(
  category_key,product_key,name_ar,description_ar,pricing_mode,amount_minor,
  unit_label_ar,turnaround_days,badge_ar,metadata,sort_order
)
join marketplace.service_categories category
  on category.category_key=seed.category_key
on conflict (product_key) do update
set category_id=excluded.category_id,
    name_ar=excluded.name_ar,
    description_ar=excluded.description_ar,
    pricing_mode=excluded.pricing_mode,
    amount_minor=excluded.amount_minor,
    currency=excluded.currency,
    unit_label_ar=excluded.unit_label_ar,
    turnaround_days=excluded.turnaround_days,
    badge_ar=excluded.badge_ar,
    metadata=excluded.metadata,
    status=excluded.status,
    sort_order=excluded.sort_order,
    updated_at=now();

update catalog.addon_products
set pricing_mode='fixed',
    amount_minor=case product_key
      when 'whatsapp' then 59000
      when 'email' then 39000
      when 'zoom' then 39000
      when 'automation' then 79000
      when 'templates' then 29000
      when 'delivery_analytics' then 49000
      when 'api' then 99000
      when 'yeastar' then 99000
      when 'woocommerce' then 69000
      when 'salla' then 69000
      when 'zid' then 69000
      when 'shopify' then 69000
      when 'custom_store' then 149000
      when 'marketing_attribution' then 99000
      else amount_minor
    end,
    marketplace_category=case
      when product_key in ('whatsapp','email','zoom','templates') then 'communications'
      when product_key in ('woocommerce','salla','zid','shopify','custom_store') then 'commerce'
      when product_key in ('automation','delivery_analytics','api') then 'automation'
      when product_key='marketing_attribution' then 'marketing'
      when product_key='yeastar' then 'telephony'
      else marketplace_category
    end,
    badge_ar=case product_key
      when 'yeastar' then 'جاهزة للربط'
      when 'marketing_attribution' then 'تحليلات موحدة'
      when 'automation' then 'توفير وقت الفريق'
      else badge_ar
    end,
    updated_at=now()
where product_key in (
  'whatsapp','email','zoom','automation','templates','delivery_analytics','api',
  'yeastar','woocommerce','salla','zid','shopify','custom_store','marketing_attribution'
);

insert into catalog.addon_products(
  product_key,feature_id,name_ar,name_en,description_ar,pricing_mode,
  amount_minor,currency,interval,trial_days,usage_metric,default_limit,
  status,sort_order,marketplace_category,badge_ar,activation_mode
)
select
  'cms_pro',feature.id,'إضافة الموقع الاحترافي','Modaar CMS Pro',
  'موقع ومتجر دورات وصفحات هبوط ومقالات وSEO من داخل مُدار.',
  'fixed',99000,'SAR','month',14,'published_pages',null,
  'active',76,'website','موقعك داخل مُدار','module'
from catalog.features feature
where feature.feature_key='module.website_cms'
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
    status=excluded.status,
    sort_order=excluded.sort_order,
    marketplace_category=excluded.marketplace_category,
    badge_ar=excluded.badge_ar,
    activation_mode=excluded.activation_mode,
    updated_at=now();

do $$
declare
  v_secret_id uuid;
begin
  if not exists (
    select 1 from marketplace.payment_webhooks
    where provider_key='marktone_hmac'
  ) then
    select vault.create_secret(
      encode(extensions.gen_random_bytes(32),'hex'),
      'marketplace_payment_webhook_secret',
      'HMAC secret for Modaar marketplace payment confirmations'
    ) into v_secret_id;
    insert into marketplace.payment_webhooks(provider_key,secret_id,status)
    values ('marktone_hmac',v_secret_id,'active');
  end if;
end
$$;

create or replace function private_app.marketplace_order_payload(p_order_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'id',orders.id,
    'orderNumber',orders.order_number,
    'tenantId',orders.tenant_id,
    'kind',orders.order_kind,
    'status',orders.status,
    'paymentStatus',orders.payment_status,
    'activationState',orders.activation_state,
    'currency',orders.currency,
    'subtotalMinor',orders.subtotal_minor,
    'taxMinor',orders.tax_minor,
    'totalMinor',orders.total_minor,
    'notes',orders.notes,
    'paymentProvider',orders.payment_provider,
    'paymentReference',orders.payment_reference,
    'paidAt',orders.paid_at,
    'createdAt',orders.created_at,
    'updatedAt',orders.updated_at,
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
$$;

create or replace function private_app.marketplace_record_payment(
  p_order_id uuid,
  p_provider_key text,
  p_provider_event_id text,
  p_payment_reference text,
  p_state text,
  p_amount_minor bigint,
  p_currency text,
  p_signature_verified boolean,
  p_payload_sha256 text,
  p_actor_subject_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_order marketplace.orders%rowtype;
  v_existing_event marketplace.payment_events%rowtype;
  v_item marketplace.order_items%rowtype;
  v_product catalog.addon_products%rowtype;
  v_module_id uuid;
  v_previous_status text;
  v_provider_key text;
  v_provider_event_id text;
  v_payment_reference text;
begin
  if not coalesce(p_signature_verified,false) then
    raise exception 'marketplace_signature_invalid';
  end if;
  if p_state<>'paid' then raise exception 'marketplace_payment_state_invalid'; end if;
  if nullif(trim(p_provider_key),'') is null
     or nullif(trim(p_provider_event_id),'') is null then
    raise exception 'marketplace_payment_event_invalid';
  end if;
  v_provider_key:=left(trim(p_provider_key),80);
  v_provider_event_id:=left(trim(p_provider_event_id),200);
  v_payment_reference:=left(nullif(trim(p_payment_reference),''),200);

  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text,0));
  select * into v_order
  from marketplace.orders orders
  where orders.id=p_order_id
  for update;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
  if p_amount_minor<>v_order.total_minor
     or upper(coalesce(p_currency,''))<>v_order.currency then
    raise exception 'marketplace_payment_amount_mismatch';
  end if;

  select * into v_existing_event
  from marketplace.payment_events event
  where event.provider_key=v_provider_key
    and event.provider_event_id=v_provider_event_id;
  if v_existing_event.id is not null then
    if v_existing_event.order_id<>v_order.id then
      raise exception 'marketplace_payment_event_reused';
    end if;
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object('duplicate',true);
  end if;

  insert into marketplace.payment_events(
    order_id,provider_key,provider_event_id,payment_reference,state,
    amount_minor,currency,signature_verified,payload_sha256
  ) values (
    v_order.id,v_provider_key,v_provider_event_id,
    v_payment_reference,'paid',p_amount_minor,
    upper(p_currency),true,left(p_payload_sha256,64)
  );

  if v_order.payment_status='paid' then
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object('duplicate',true);
  end if;
  if v_order.status in ('cancelled','refunded') then
    raise exception 'marketplace_order_not_payable';
  end if;

  v_previous_status:=v_order.status;
  update marketplace.orders
  set payment_status='paid',
      status=case when order_kind='addon' then 'completed' else 'paid' end,
      activation_state=case when order_kind='addon' then 'pending' else 'not_applicable' end,
      payment_provider=v_provider_key,
      payment_reference=v_payment_reference,
      paid_at=coalesce(paid_at,now()),
      updated_at=now()
  where id=v_order.id
  returning * into v_order;

  if v_order.order_kind='addon' then
    for v_item in
      select * from marketplace.order_items
      where order_id=v_order.id and item_type='addon'
      order by created_at
    loop
      select * into v_product
      from catalog.addon_products product
      where product.id=v_item.addon_product_id
      for share;
      if v_product.id is null then raise exception 'addon_product_not_found'; end if;

      insert into catalog.tenant_addon_subscriptions as current_subscription(
        tenant_id,product_id,status,source,period_start,period_end,
        requested_note,requested_by_subject_id,decided_by_subject_id,decision_note
      ) values (
        v_order.tenant_id,v_product.id,'active','billing',now(),
        case v_product.interval
          when 'year' then now()+interval '1 year'
          when 'one_time' then null
          else now()+interval '1 month'
        end,
        'marketplace_order:'||v_order.order_number,
        v_order.requested_by_subject_id,p_actor_subject_id,
        'activated_after_verified_payment'
      )
      on conflict (tenant_id,product_id)
        where status in ('pending','trialing','active','paused')
      do update
      set status='active',
          source='billing',
          period_start=now(),
          period_end=case v_product.interval
            when 'year' then greatest(coalesce(current_subscription.period_end,now()),now())+interval '1 year'
            when 'one_time' then null
            else greatest(coalesce(current_subscription.period_end,now()),now())+interval '1 month'
          end,
          cancel_at_period_end=false,
          requested_note='marketplace_order:'||v_order.order_number,
          requested_by_subject_id=coalesce(v_order.requested_by_subject_id,current_subscription.requested_by_subject_id),
          decided_by_subject_id=coalesce(p_actor_subject_id,current_subscription.decided_by_subject_id),
          decision_note='activated_after_verified_payment',
          updated_at=now();

      if v_product.activation_mode='module' or v_product.product_key='cms_pro' then
        select id into v_module_id
        from core.modules
        where module_key='website_cms'
        limit 1;
        if v_module_id is null then raise exception 'cms_module_not_found'; end if;
        insert into core.tenant_modules(
          tenant_id,module_id,enabled,configuration,enabled_at,updated_at
        ) values (
          v_order.tenant_id,v_module_id,true,
          jsonb_build_object('source','marketplace','orderNumber',v_order.order_number),
          now(),now()
        )
        on conflict (tenant_id,module_id) do update
        set enabled=true,
            configuration=core.tenant_modules.configuration
              || jsonb_build_object('source','marketplace','orderNumber',v_order.order_number),
            enabled_at=coalesce(core.tenant_modules.enabled_at,now()),
            updated_at=now();
      end if;
    end loop;

    update marketplace.orders
    set activation_state='active',updated_at=now()
    where id=v_order.id
    returning * into v_order;
  end if;

  insert into marketplace.order_events(
    order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata
  ) values (
    v_order.id,v_order.tenant_id,p_actor_subject_id,'payment_confirmed',
    v_previous_status,v_order.status,
    jsonb_build_object(
      'provider',v_provider_key,
      'paymentReference',v_payment_reference,
      'activationState',v_order.activation_state
    )
  );

  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_order.tenant_id,p_actor_subject_id,'marketplace.order.payment_confirmed',
    'marketplace_order',v_order.id::text,
    jsonb_build_object(
      'orderNumber',v_order.order_number,
      'kind',v_order.order_kind,
      'totalMinor',v_order.total_minor,
      'currency',v_order.currency,
      'activationState',v_order.activation_state
    )
  );

  return private_app.marketplace_order_payload(v_order.id)
    || jsonb_build_object('duplicate',false);
end
$$;

create or replace function public.v1_tenant_marketplace_snapshot(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_can_purchase boolean;
begin
  select * into v_tenant from core.tenants where slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(v_tenant.id,'tenant.workspace.read') then
    raise exception 'forbidden';
  end if;
  v_can_purchase:=private_app.has_tenant_permission(v_tenant.id,'tenant.settings.manage');

  return jsonb_build_object(
    'generatedAt',now(),
    'viewer',jsonb_build_object('canPurchase',v_can_purchase),
    'summary',jsonb_build_object(
      'serviceProducts',(select count(*) from marketplace.service_products where status in ('beta','active')),
      'addonProducts',(select count(*) from catalog.addon_products where status in ('beta','active') and pricing_mode='fixed' and amount_minor>0),
      'activeAddons',(
        select count(*) from catalog.addon_products product
        join catalog.features feature on feature.id=product.feature_id
        where product.status in ('beta','active')
          and private_app.addon_entitlement(v_tenant.id,feature.feature_key)->>'enabled'='true'
      ),
      'openOrders',(select count(*) from marketplace.orders where tenant_id=v_tenant.id and status in ('pending_payment','paid','in_progress'))
    ),
    'categories',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',category.category_key,
        'name',category.name_ar,
        'description',category.description_ar,
        'iconKey',category.icon_key,
        'productCount',(select count(*) from marketplace.service_products product where product.category_id=category.id and product.status in ('beta','active'))
      ) order by category.sort_order)
      from marketplace.service_categories category
      where category.status='active'
    ),'[]'::jsonb),
    'services',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',product.id,
        'key',product.product_key,
        'categoryKey',category.category_key,
        'categoryName',category.name_ar,
        'name',product.name_ar,
        'description',product.description_ar,
        'pricingMode',product.pricing_mode,
        'amountMinor',product.amount_minor,
        'currency',product.currency,
        'unitLabel',product.unit_label_ar,
        'turnaroundDays',product.turnaround_days,
        'badge',product.badge_ar,
        'metadata',product.metadata
      ) order by category.sort_order,product.sort_order)
      from marketplace.service_products product
      join marketplace.service_categories category on category.id=product.category_id
      where product.status in ('beta','active') and category.status='active'
    ),'[]'::jsonb),
    'addons',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',product.id,
        'key',product.product_key,
        'featureKey',feature.feature_key,
        'categoryKey',product.marketplace_category,
        'name',product.name_ar,
        'description',product.description_ar,
        'amountMinor',product.amount_minor,
        'currency',product.currency,
        'interval',product.interval,
        'trialDays',product.trial_days,
        'badge',product.badge_ar,
        'activationMode',product.activation_mode,
        'entitlement',private_app.addon_entitlement(v_tenant.id,feature.feature_key)
      ) order by product.sort_order)
      from catalog.addon_products product
      join catalog.features feature on feature.id=product.feature_id
      where product.status in ('beta','active')
        and product.pricing_mode='fixed'
        and product.amount_minor>0
    ),'[]'::jsonb),
    'orders',coalesce((
      select jsonb_agg(private_app.marketplace_order_payload(recent.id) order by recent.created_at desc)
      from (
        select id,created_at from marketplace.orders
        where tenant_id=v_tenant.id
        order by created_at desc
        limit 30
      ) recent
    ),'[]'::jsonb)
  );
end
$$;

create or replace function public.v1_tenant_marketplace_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_item_type text;
  v_product_key text;
  v_quantity integer;
  v_idempotency_key text;
  v_amount_minor bigint;
  v_name text;
  v_service_id uuid;
  v_addon_id uuid;
  v_feature_key text;
  v_subtotal bigint;
  v_tax bigint;
  v_order marketplace.orders%rowtype;
begin
  select * into v_tenant from core.tenants where slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(v_tenant.id,'tenant.settings.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();

  if p_action='create_order' then
    v_item_type:=lower(nullif(trim(p_payload->>'itemType'),''));
    v_product_key:=lower(nullif(trim(p_payload->>'productKey'),''));
    v_idempotency_key:=left(nullif(trim(p_payload->>'idempotencyKey'),''),120);
    if v_item_type not in ('service','addon') or v_product_key is null then
      raise exception 'marketplace_product_invalid';
    end if;
    if v_idempotency_key is null then raise exception 'marketplace_idempotency_required'; end if;
    begin
      v_quantity:=coalesce((p_payload->>'quantity')::integer,1);
    exception when others then
      raise exception 'marketplace_quantity_invalid';
    end;
    if v_quantity<1 or v_quantity>100 then raise exception 'marketplace_quantity_invalid'; end if;
    if v_item_type='addon' and v_quantity<>1 then raise exception 'marketplace_quantity_invalid'; end if;

    select * into v_order from marketplace.orders
    where tenant_id=v_tenant.id and idempotency_key=v_idempotency_key;
    if v_order.id is not null then
      return private_app.marketplace_order_payload(v_order.id)
        || jsonb_build_object('duplicate',true);
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      v_tenant.id::text||':'||v_item_type||':'||v_product_key,0
    ));
    select * into v_order from marketplace.orders
    where tenant_id=v_tenant.id and idempotency_key=v_idempotency_key;
    if v_order.id is not null then
      return private_app.marketplace_order_payload(v_order.id)
        || jsonb_build_object('duplicate',true);
    end if;

    if v_item_type='service' then
      select product.id,product.amount_minor,product.name_ar
      into v_service_id,v_amount_minor,v_name
      from marketplace.service_products product
      where product.product_key=v_product_key
        and product.status in ('beta','active')
        and product.pricing_mode in ('fixed','from')
        and product.amount_minor>0;
      if v_service_id is null then raise exception 'marketplace_product_not_found'; end if;
    else
      select product.id,product.amount_minor,product.name_ar,feature.feature_key
      into v_addon_id,v_amount_minor,v_name,v_feature_key
      from catalog.addon_products product
      join catalog.features feature on feature.id=product.feature_id
      where product.product_key=v_product_key
        and product.status in ('beta','active')
        and product.pricing_mode='fixed'
        and product.amount_minor>0;
      if v_addon_id is null then raise exception 'marketplace_product_not_found'; end if;
      if coalesce((private_app.addon_entitlement(v_tenant.id,v_feature_key)->>'enabled')::boolean,false) then
        raise exception 'addon_already_enabled';
      end if;
    end if;

    select orders.* into v_order
    from marketplace.orders orders
    join marketplace.order_items item on item.order_id=orders.id
    where orders.tenant_id=v_tenant.id
      and orders.status='pending_payment'
      and orders.payment_status='pending'
      and item.item_type=v_item_type
      and item.product_key=v_product_key
    order by orders.created_at desc
    limit 1;
    if v_order.id is not null then
      return private_app.marketplace_order_payload(v_order.id)
        || jsonb_build_object('duplicate',true,'duplicateReason','pending_product_order');
    end if;

    v_subtotal:=v_amount_minor*v_quantity;
    v_tax:=round(v_subtotal*0.15)::bigint;
    insert into marketplace.orders(
      tenant_id,requested_by_subject_id,order_kind,status,payment_status,
      activation_state,currency,subtotal_minor,tax_minor,total_minor,tax_rate_bps,
      notes,idempotency_key
    ) values (
      v_tenant.id,v_actor,v_item_type,'pending_payment','pending',
      case when v_item_type='addon' then 'pending' else 'not_applicable' end,
      'SAR',v_subtotal,v_tax,v_subtotal+v_tax,1500,
      left(nullif(trim(p_payload->>'notes'),''),1000),v_idempotency_key
    ) returning * into v_order;

    insert into marketplace.order_items(
      order_id,item_type,service_product_id,addon_product_id,product_key,
      product_name_ar,quantity,unit_amount_minor,line_total_minor,metadata
    ) values (
      v_order.id,v_item_type,v_service_id,v_addon_id,v_product_key,
      v_name,v_quantity,v_amount_minor,v_subtotal,
      jsonb_build_object('pricingMode','catalog_price')
    );

    insert into marketplace.order_events(
      order_id,tenant_id,actor_subject_id,event_type,to_status,metadata
    ) values (
      v_order.id,v_tenant.id,v_actor,'order_created','pending_payment',
      jsonb_build_object('itemType',v_item_type,'productKey',v_product_key)
    );
    insert into audit_log.events(
      tenant_id,actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_tenant.id,v_actor,'marketplace.order.created','marketplace_order',v_order.id::text,
      jsonb_build_object('orderNumber',v_order.order_number,'kind',v_item_type,'totalMinor',v_order.total_minor)
    );
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object('duplicate',false);
  elsif p_action='cancel_order' then
    begin
      select * into v_order from marketplace.orders
      where id=(p_payload->>'orderId')::uuid and tenant_id=v_tenant.id
      for update;
    exception when others then
      raise exception 'marketplace_order_invalid';
    end;
    if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
    if v_order.payment_status<>'pending' or v_order.status<>'pending_payment' then
      raise exception 'marketplace_order_not_cancellable';
    end if;
    update marketplace.orders
    set status='cancelled',activation_state='cancelled',updated_at=now()
    where id=v_order.id
    returning * into v_order;
    insert into marketplace.order_events(
      order_id,tenant_id,actor_subject_id,event_type,from_status,to_status
    ) values (v_order.id,v_tenant.id,v_actor,'order_cancelled','pending_payment','cancelled');
    insert into audit_log.events(
      tenant_id,actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_tenant.id,v_actor,'marketplace.order.cancelled','marketplace_order',v_order.id::text,
      jsonb_build_object('orderNumber',v_order.order_number)
    );
    return private_app.marketplace_order_payload(v_order.id);
  else
    raise exception 'marketplace_action_invalid';
  end if;
end
$$;

create or replace function public.v1_platform_marketplace_snapshot()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  return jsonb_build_object(
    'generatedAt',now(),
    'summary',jsonb_build_object(
      'totalOrders',(select count(*) from marketplace.orders),
      'pendingPayment',(select count(*) from marketplace.orders where status='pending_payment'),
      'paidServices',(select count(*) from marketplace.orders where order_kind='service' and status in ('paid','in_progress')),
      'activatedAddons',(select count(*) from marketplace.orders where order_kind='addon' and activation_state='active'),
      'revenueMinor',(select coalesce(sum(total_minor),0) from marketplace.orders where payment_status='paid')
    ),
    'webhook',coalesce((
      select jsonb_build_object(
        'providerKey',webhook.provider_key,
        'status',webhook.status,
        'lastReceivedAt',webhook.last_received_at,
        'configured',true
      ) from marketplace.payment_webhooks webhook
      where webhook.provider_key='marktone_hmac'
    ),jsonb_build_object('configured',false)),
    'orders',coalesce((
      select jsonb_agg(
        private_app.marketplace_order_payload(recent.id)
        || jsonb_build_object('tenantName',recent.tenant_name,'tenantSlug',recent.tenant_slug)
        order by recent.created_at desc
      )
      from (
        select orders.id,orders.created_at,tenant.name tenant_name,tenant.slug tenant_slug
        from marketplace.orders orders
        join core.tenants tenant on tenant.id=orders.tenant_id
        order by orders.created_at desc
        limit 100
      ) recent
    ),'[]'::jsonb),
    'services',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',product.product_key,'name',product.name_ar,'categoryName',category.name_ar,
        'amountMinor',product.amount_minor,'currency',product.currency,
        'unitLabel',product.unit_label_ar,'status',product.status
      ) order by category.sort_order,product.sort_order)
      from marketplace.service_products product
      join marketplace.service_categories category on category.id=product.category_id
    ),'[]'::jsonb),
    'addons',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',product.product_key,'name',product.name_ar,'amountMinor',product.amount_minor,
        'currency',product.currency,'interval',product.interval,'status',product.status
      ) order by product.sort_order)
      from catalog.addon_products product
      where product.status in ('beta','active') and product.pricing_mode='fixed'
    ),'[]'::jsonb)
  );
end
$$;

create or replace function public.v1_platform_marketplace_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_order marketplace.orders%rowtype;
  v_target_status text;
  v_previous_status text;
  v_secret text;
  v_webhook marketplace.payment_webhooks%rowtype;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();

  if p_action='confirm_payment' then
    begin
      select * into v_order from marketplace.orders
      where id=(p_payload->>'orderId')::uuid;
    exception when others then
      raise exception 'marketplace_order_invalid';
    end;
    if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
    return private_app.marketplace_record_payment(
      v_order.id,'platform_manual',
      'manual:'||v_order.id::text||':'||coalesce(p_payload->>'reference',extract(epoch from clock_timestamp())::text),
      coalesce(nullif(trim(p_payload->>'reference'),''),'platform-confirmed'),
      'paid',v_order.total_minor,v_order.currency,true,
      encode(extensions.digest(convert_to(v_order.id::text||clock_timestamp()::text,'utf8'),'sha256'),'hex'),
      v_actor
    );
  elsif p_action='update_service_status' then
    begin
      select * into v_order from marketplace.orders
      where id=(p_payload->>'orderId')::uuid
      for update;
    exception when others then
      raise exception 'marketplace_order_invalid';
    end;
    if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
    if v_order.order_kind<>'service' or v_order.payment_status<>'paid' then
      raise exception 'marketplace_service_order_invalid';
    end if;
    v_target_status:=p_payload->>'status';
    if v_target_status not in ('in_progress','completed') then
      raise exception 'marketplace_status_invalid';
    end if;
    if not (
      (v_order.status='paid' and v_target_status='in_progress')
      or (v_order.status='in_progress' and v_target_status='completed')
    ) then
      raise exception 'marketplace_status_transition_invalid';
    end if;
    v_previous_status:=v_order.status;
    update marketplace.orders
    set status=v_target_status,updated_at=now()
    where id=v_order.id
    returning * into v_order;
    insert into marketplace.order_events(
      order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata
    ) values (
      v_order.id,v_order.tenant_id,v_actor,'service_status_changed',
      v_previous_status,v_target_status,
      jsonb_build_object('note',left(nullif(trim(p_payload->>'note'),''),500))
    );
    return private_app.marketplace_order_payload(v_order.id);
  elsif p_action='rotate_webhook_secret' then
    select * into v_webhook from marketplace.payment_webhooks
    where provider_key='marktone_hmac' for update;
    if v_webhook.id is null then raise exception 'marketplace_webhook_not_found'; end if;
    v_secret:=encode(extensions.gen_random_bytes(32),'hex');
    perform vault.update_secret(
      v_webhook.secret_id,v_secret,'marketplace_payment_webhook_secret',
      'HMAC secret for Modaar marketplace payment confirmations'
    );
    update marketplace.payment_webhooks
    set status='active',last_error=null,updated_at=now()
    where id=v_webhook.id;
    insert into audit_log.events(
      actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_actor,'marketplace.webhook.secret_rotated','payment_webhook',v_webhook.id::text,
      jsonb_build_object('providerKey',v_webhook.provider_key)
    );
    return jsonb_build_object(
      'providerKey',v_webhook.provider_key,
      'secret',v_secret,
      'shownOnce',true,
      'endpointPath','/functions/v1/marketplace-payment-webhook'
    );
  else
    raise exception 'marketplace_action_invalid';
  end if;
end
$$;

create or replace function public.v1_marketplace_payment_webhook_receive(
  p_timestamp text,
  p_signature text,
  p_raw_body text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_webhook marketplace.payment_webhooks%rowtype;
  v_secret text;
  v_expected text;
  v_provided text;
  v_received_at timestamptz;
  v_payload jsonb;
  v_order_id uuid;
  v_amount bigint;
  v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
  select * into v_webhook from marketplace.payment_webhooks
  where provider_key='marktone_hmac' and status='active' limit 1;
  if v_webhook.id is null then raise exception 'forbidden'; end if;
  if p_timestamp !~ '^[0-9]{10}$' then raise exception 'forbidden'; end if;
  v_received_at:=to_timestamp(p_timestamp::double precision);
  if abs(extract(epoch from (now()-v_received_at)))>300 then raise exception 'forbidden'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id=v_webhook.secret_id;
  if v_secret is null then raise exception 'forbidden'; end if;
  v_expected:=encode(extensions.hmac(
    convert_to(p_timestamp||'.'||p_raw_body,'utf8'),convert_to(v_secret,'utf8'),'sha256'
  ),'hex');
  v_provided:=lower(replace(coalesce(p_signature,''),'sha256=',''));
  if extensions.digest(v_expected,'sha256')<>extensions.digest(v_provided,'sha256') then
    raise exception 'forbidden';
  end if;
  begin
    v_payload:=p_raw_body::jsonb;
    v_order_id:=(v_payload->>'orderId')::uuid;
    v_amount:=(v_payload->>'amountMinor')::bigint;
  exception when others then
    raise exception 'marketplace_payment_payload_invalid';
  end;
  v_result:=private_app.marketplace_record_payment(
    v_order_id,
    left(coalesce(nullif(trim(v_payload->>'provider'),''),'marktone_hmac'),80),
    left(nullif(trim(v_payload->>'eventId'),''),200),
    left(nullif(trim(v_payload->>'paymentReference'),''),200),
    lower(v_payload->>'state'),v_amount,upper(v_payload->>'currency'),true,
    encode(extensions.digest(convert_to(p_raw_body,'utf8'),'sha256'),'hex'),null
  );
  update marketplace.payment_webhooks
  set last_received_at=now(),last_error=null,updated_at=now()
  where id=v_webhook.id;
  return v_result;
end
$$;

revoke all on function private_app.marketplace_order_payload(uuid) from public,anon,authenticated;
revoke all on function private_app.marketplace_record_payment(uuid,text,text,text,text,bigint,text,boolean,text,uuid) from public,anon,authenticated;
revoke all on function public.v1_tenant_marketplace_snapshot(text) from public,anon;
revoke all on function public.v1_tenant_marketplace_action(text,text,jsonb) from public,anon;
revoke all on function public.v1_platform_marketplace_snapshot() from public,anon;
revoke all on function public.v1_platform_marketplace_action(text,jsonb) from public,anon;
revoke all on function public.v1_marketplace_payment_webhook_receive(text,text,text) from public,anon,authenticated;

grant execute on function public.v1_tenant_marketplace_snapshot(text) to authenticated;
grant execute on function public.v1_tenant_marketplace_action(text,text,jsonb) to authenticated;
grant execute on function public.v1_platform_marketplace_snapshot() to authenticated;
grant execute on function public.v1_platform_marketplace_action(text,jsonb) to authenticated;
grant execute on function public.v1_marketplace_payment_webhook_receive(text,text,text) to service_role;
