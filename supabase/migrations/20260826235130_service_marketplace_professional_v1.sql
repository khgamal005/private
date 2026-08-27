-- ODEIR professional managed-services marketplace v1.
--
-- Additive only. Existing service products, the three current service orders,
-- payments, tenant data, Reef data and add-on entitlements are not rewritten.
-- Provider private contacts never leave the platform-only snapshot.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('marketplace.service_categories') is null
     or to_regclass('marketplace.service_products') is null
     or to_regclass('marketplace.orders') is null
     or to_regclass('marketplace.order_items') is null
     or to_regclass('marketplace.order_events') is null
     or to_regclass('marketplace.payment_provider_configs') is null
     or to_regclass('audit_log.events') is null then
    raise exception 'service_marketplace_missing_required_schema';
  end if;
  if to_regprocedure('public.v1_tenant_marketplace_snapshot(text)') is null
     or to_regprocedure('public.v1_tenant_marketplace_action(text,text,jsonb)') is null
     or to_regprocedure('public.v2_tenant_marketplace_snapshot(text)') is null
     or to_regprocedure('public.v2_tenant_marketplace_action(text,text,jsonb)') is null
     or to_regprocedure('public.v4_platform_commerce_snapshot()') is null
     or to_regprocedure('private_app.has_platform_permission(text)') is null
     or to_regprocedure('private_app.has_tenant_permission(uuid,text)') is null
     or to_regprocedure('private_app.write_audit(text,text,text,uuid,jsonb)') is null
     or to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure('private_app.marketplace_order_payload(uuid)') is null then
    raise exception 'service_marketplace_missing_required_function';
  end if;
  if not exists (
       select 1
       from information_schema.columns
       where table_schema = 'catalog'
         and table_name = 'addon_products'
         and column_name = 'is_marketplace_visible'
     )
     or to_regprocedure(
       'private_app.v2_tenant_marketplace_snapshot_catalog_legacy(text)'
     ) is null
     or to_regprocedure(
       'private_app.v2_tenant_marketplace_action_catalog_legacy(text,text,jsonb)'
     ) is null then
    raise exception 'service_marketplace_requires_addon_catalog_control_v1';
  end if;
  if to_regprocedure(
       'private_app.v2_tenant_marketplace_snapshot_service_legacy(text)'
     ) is not null
     or to_regprocedure(
       'private_app.v2_tenant_marketplace_action_service_legacy(text,text,jsonb)'
     ) is not null
     or to_regprocedure(
       'private_app.v1_tenant_marketplace_snapshot_service_legacy(text)'
     ) is not null
     or to_regprocedure(
       'private_app.v1_tenant_marketplace_action_service_legacy(text,text,jsonb)'
     ) is not null then
    raise exception 'service_marketplace_contract_already_wrapped';
  end if;
end;
$preflight$;

create table if not exists marketplace.service_providers (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique
    check (provider_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  provider_type text not null default 'freelancer'
    check (provider_type in (
      'lecturer','trainer','consultant','freelancer','agency','company'
    )),
  display_name_ar text not null,
  display_name_en text,
  professional_title_ar text,
  short_bio_ar text,
  bio_ar text,
  avatar_url text,
  cover_url text,
  city_ar text,
  country_code text not null default 'SA'
    check (country_code ~ '^[A-Z]{2}$'),
  nationality_ar text,
  years_experience smallint
    check (years_experience is null or years_experience between 0 and 80),
  languages text[] not null default array['العربية']::text[]
    check (cardinality(languages) between 1 and 20),
  expertise_tags text[] not null default '{}'::text[]
    check (cardinality(expertise_tags) <= 30),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','pending','verified','rejected')),
  availability_status text not null default 'available'
    check (availability_status in ('available','limited','unavailable')),
  status text not null default 'draft'
    check (status in ('draft','active','paused','archived')),
  is_featured boolean not null default false,
  display_order integer not null default 100
    check (display_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pg_catalog.length(display_name_ar) between 2 and 150),
  check (display_name_en is null or pg_catalog.length(display_name_en) <= 150),
  check (professional_title_ar is null or pg_catalog.length(professional_title_ar) <= 180),
  check (short_bio_ar is null or pg_catalog.length(short_bio_ar) <= 500),
  check (bio_ar is null or pg_catalog.length(bio_ar) <= 4000)
);

create table if not exists marketplace.service_provider_contacts (
  provider_id uuid primary key
    references marketplace.service_providers(id) on delete cascade,
  email text,
  phone text,
  whatsapp text,
  website_url text,
  linkedin_url text,
  internal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is null or pg_catalog.length(email) <= 254),
  check (phone is null or pg_catalog.length(phone) <= 40),
  check (whatsapp is null or pg_catalog.length(whatsapp) <= 40),
  check (internal_notes is null or pg_catalog.length(internal_notes) <= 4000)
);

create table if not exists marketplace.service_provider_courses (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null
    references marketplace.service_providers(id) on delete restrict,
  course_key text not null
    check (course_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  title_ar text not null,
  title_en text,
  summary_ar text not null,
  target_audience_ar text,
  objectives_ar text[] not null default '{}'::text[]
    check (cardinality(objectives_ar) <= 30),
  duration_hours numeric(8,2)
    check (duration_hours is null or duration_hours > 0),
  delivery_modes text[] not null default array['online']::text[]
    check (
      cardinality(delivery_modes) between 1 and 4
      and delivery_modes <@ array['online','onsite','hybrid','recorded']::text[]
    ),
  language_ar text not null default 'العربية',
  accreditation_ar text,
  image_url text,
  status text not null default 'draft'
    check (status in ('draft','active','paused','archived')),
  display_order integer not null default 100
    check (display_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, course_key),
  check (pg_catalog.length(title_ar) between 2 and 180),
  check (pg_catalog.length(summary_ar) between 10 and 2000)
);

alter table marketplace.service_products
  add column if not exists provider_id uuid
    references marketplace.service_providers(id) on delete restrict,
  add column if not exists course_id uuid
    references marketplace.service_provider_courses(id) on delete restrict,
  add column if not exists short_description_ar text,
  add column if not exists card_image_url text,
  add column if not exists marketplace_visible boolean not null default true,
  add column if not exists is_featured boolean not null default false;

comment on column marketplace.service_products.marketplace_visible is
  'Commercial discovery only. Historical orders and fulfillment remain intact.';

create table if not exists marketplace.service_packages (
  id uuid primary key default gen_random_uuid(),
  service_product_id uuid not null
    references marketplace.service_products(id) on delete restrict,
  provider_id uuid
    references marketplace.service_providers(id) on delete restrict,
  package_key text not null
    check (package_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  name_ar text not null,
  description_ar text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'SAR' check (currency ~ '^[A-Z]{3}$'),
  turnaround_days integer
    check (turnaround_days is null or turnaround_days between 0 and 365),
  included_items_ar text[] not null default '{}'::text[]
    check (cardinality(included_items_ar) <= 40),
  revisions_included smallint not null default 0
    check (revisions_included between 0 and 100),
  is_recommended boolean not null default false,
  status text not null default 'draft'
    check (status in ('draft','active','paused','archived')),
  display_order integer not null default 100
    check (display_order between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_product_id, package_key),
  check (pg_catalog.length(name_ar) between 2 and 120),
  check (description_ar is null or pg_catalog.length(description_ar) <= 1500)
);

alter table marketplace.order_items
  add column if not exists service_package_id uuid
    references marketplace.service_packages(id) on delete restrict;

create table if not exists marketplace.service_order_briefs (
  order_id uuid primary key references marketplace.orders(id) on delete cascade,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  provider_id uuid references marketplace.service_providers(id) on delete restrict,
  package_id uuid references marketplace.service_packages(id) on delete restrict,
  preferred_start_date date,
  delivery_mode text
    check (delivery_mode is null or delivery_mode in ('online','onsite','hybrid','recorded')),
  brief jsonb not null default '{}'::jsonb
    check (jsonb_typeof(brief) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pg_catalog.octet_length(brief::text) <= 20000)
);

create table if not exists marketplace.service_order_assignments (
  order_id uuid primary key references marketplace.orders(id) on delete cascade,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  provider_id uuid not null
    references marketplace.service_providers(id) on delete restrict,
  package_id uuid references marketplace.service_packages(id) on delete restrict,
  status text not null default 'pending'
    check (status in (
      'pending','assigned','accepted','declined','in_progress',
      'delivered','completed','cancelled'
    )),
  due_at timestamptz,
  assigned_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  assigned_at timestamptz,
  started_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists marketplace.service_assignment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references marketplace.orders(id) on delete cascade,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  from_provider_id uuid references marketplace.service_providers(id) on delete restrict,
  to_provider_id uuid not null references marketplace.service_providers(id) on delete restrict,
  from_status text,
  to_status text not null,
  reason text,
  actor_subject_id uuid references access_control.subjects(id) on delete set null,
  occurred_at timestamptz not null default now(),
  check (reason is null or pg_catalog.length(reason) <= 1000)
);

create table if not exists marketplace.service_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references marketplace.orders(id) on delete restrict,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  provider_id uuid not null
    references marketplace.service_providers(id) on delete restrict,
  rating smallint not null check (rating between 1 and 5),
  review_text text,
  moderation_status text not null default 'pending'
    check (moderation_status in ('pending','approved','rejected','hidden')),
  provider_response text,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (review_text is null or pg_catalog.length(review_text) <= 2000),
  check (provider_response is null or pg_catalog.length(provider_response) <= 2000)
);

create index if not exists service_providers_store_idx
  on marketplace.service_providers(status,is_featured desc,display_order,display_name_ar);
create index if not exists service_provider_courses_provider_idx
  on marketplace.service_provider_courses(provider_id,status,display_order);
create index if not exists service_products_provider_idx
  on marketplace.service_products(provider_id,status,sort_order);
create index if not exists service_products_course_idx
  on marketplace.service_products(course_id);
create index if not exists service_products_visible_store_idx
  on marketplace.service_products(category_id,is_featured desc,sort_order)
  where marketplace_visible and status in ('beta','active');
create index if not exists service_packages_product_idx
  on marketplace.service_packages(service_product_id,status,display_order);
create index if not exists service_packages_provider_idx
  on marketplace.service_packages(provider_id,status);
create index if not exists order_items_service_package_idx
  on marketplace.order_items(service_package_id);
create index if not exists service_order_briefs_tenant_idx
  on marketplace.service_order_briefs(tenant_id,created_at desc);
create index if not exists service_order_briefs_provider_idx
  on marketplace.service_order_briefs(provider_id,created_at desc);
create index if not exists service_assignments_tenant_status_idx
  on marketplace.service_order_assignments(tenant_id,status,updated_at desc);
create index if not exists service_assignments_provider_status_idx
  on marketplace.service_order_assignments(provider_id,status,due_at);
create index if not exists service_assignment_events_order_idx
  on marketplace.service_assignment_events(order_id,occurred_at desc);
create index if not exists service_assignment_events_provider_idx
  on marketplace.service_assignment_events(to_provider_id,occurred_at desc);
create index if not exists service_reviews_provider_idx
  on marketplace.service_reviews(provider_id,moderation_status,created_at desc);
create index if not exists service_reviews_tenant_idx
  on marketplace.service_reviews(tenant_id,created_at desc);

alter table marketplace.service_providers enable row level security;
alter table marketplace.service_provider_contacts enable row level security;
alter table marketplace.service_provider_courses enable row level security;
alter table marketplace.service_packages enable row level security;
alter table marketplace.service_order_briefs enable row level security;
alter table marketplace.service_order_assignments enable row level security;
alter table marketplace.service_assignment_events enable row level security;
alter table marketplace.service_reviews enable row level security;

revoke all on table marketplace.service_providers from public, anon, authenticated;
revoke all on table marketplace.service_provider_contacts from public, anon, authenticated;
revoke all on table marketplace.service_provider_courses from public, anon, authenticated;
revoke all on table marketplace.service_packages from public, anon, authenticated;
revoke all on table marketplace.service_order_briefs from public, anon, authenticated;
revoke all on table marketplace.service_order_assignments from public, anon, authenticated;
revoke all on table marketplace.service_assignment_events from public, anon, authenticated;
revoke all on table marketplace.service_reviews from public, anon, authenticated;

create or replace function private_app.service_provider_public_payload(
  p_provider_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', provider.id,
    'key', provider.provider_key,
    'type', provider.provider_type,
    'name', provider.display_name_ar,
    'nameEn', provider.display_name_en,
    'title', provider.professional_title_ar,
    'shortBio', provider.short_bio_ar,
    'bio', provider.bio_ar,
    'avatarUrl', provider.avatar_url,
    'coverUrl', provider.cover_url,
    'city', provider.city_ar,
    'countryCode', provider.country_code,
    'nationality', provider.nationality_ar,
    'yearsExperience', provider.years_experience,
    'languages', to_jsonb(provider.languages),
    'expertise', to_jsonb(provider.expertise_tags),
    'verified', provider.verification_status = 'verified',
    'verificationStatus', provider.verification_status,
    'availabilityStatus', provider.availability_status,
    'featured', provider.is_featured,
    'rating', coalesce((
      select round(avg(review.rating)::numeric, 2)
      from marketplace.service_reviews review
      where review.provider_id = provider.id
        and review.moderation_status = 'approved'
    ), 0),
    'reviewCount', (
      select count(*) from marketplace.service_reviews review
      where review.provider_id = provider.id
        and review.moderation_status = 'approved'
    ),
    'completedOrders', (
      select count(*) from marketplace.service_order_assignments assignment
      where assignment.provider_id = provider.id
        and assignment.status = 'completed'
    )
  ))
  from marketplace.service_providers provider
  where provider.id = p_provider_id
$$;

create or replace function public.v1_platform_service_marketplace_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  v_base := public.v4_platform_commerce_snapshot();
  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', now(),
    'summary', jsonb_build_object(
      'providerCount', (select count(*) from marketplace.service_providers where status <> 'archived'),
      'activeProviders', (select count(*) from marketplace.service_providers where status = 'active'),
      'verifiedProviders', (select count(*) from marketplace.service_providers where verification_status = 'verified'),
      'courseCount', (select count(*) from marketplace.service_provider_courses where status <> 'archived'),
      'publishedServices', (select count(*) from marketplace.service_products where marketplace_visible and status in ('beta','active')),
      'openServiceOrders', (select count(*) from marketplace.orders where order_kind = 'service' and status in ('paid','in_progress'))
    ),
    'serviceCategories', coalesce(v_base -> 'serviceCategories', '[]'::jsonb),
    'providers', coalesce((
      select jsonb_agg(
        private_app.service_provider_public_payload(provider.id)
        || jsonb_strip_nulls(jsonb_build_object(
          'status', provider.status,
          'displayOrder', provider.display_order,
          'updatedAt', provider.updated_at,
          'contact', jsonb_strip_nulls(jsonb_build_object(
            'email', contact.email,
            'phone', contact.phone,
            'whatsapp', contact.whatsapp,
            'websiteUrl', contact.website_url,
            'linkedinUrl', contact.linkedin_url,
            'internalNotes', contact.internal_notes
          )),
          'serviceCount', (select count(*) from marketplace.service_products product where product.provider_id = provider.id),
          'courseCount', (select count(*) from marketplace.service_provider_courses course where course.provider_id = provider.id)
        )) order by provider.is_featured desc, provider.display_order, provider.display_name_ar
      )
      from marketplace.service_providers provider
      left join marketplace.service_provider_contacts contact
        on contact.provider_id = provider.id
    ), '[]'::jsonb),
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', course.id,
        'providerId', course.provider_id,
        'providerName', provider.display_name_ar,
        'key', course.course_key,
        'title', course.title_ar,
        'titleEn', course.title_en,
        'summary', course.summary_ar,
        'targetAudience', course.target_audience_ar,
        'objectives', course.objectives_ar,
        'durationHours', course.duration_hours,
        'deliveryModes', course.delivery_modes,
        'language', course.language_ar,
        'accreditation', course.accreditation_ar,
        'imageUrl', course.image_url,
        'status', course.status,
        'displayOrder', course.display_order,
        'updatedAt', course.updated_at
      ) order by provider.display_name_ar, course.display_order, course.title_ar)
      from marketplace.service_provider_courses course
      join marketplace.service_providers provider on provider.id = course.provider_id
    ), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', product.id,
        'key', product.product_key,
        'name', product.name_ar,
        'description', product.description_ar,
        'shortDescription', product.short_description_ar,
        'categoryId', category.id,
        'categoryName', category.name_ar,
        'providerId', product.provider_id,
        'provider', case when provider.id is null then null else private_app.service_provider_public_payload(provider.id) end,
        'courseId', product.course_id,
        'courseTitle', course.title_ar,
        'pricingMode', product.pricing_mode,
        'amountMinor', product.amount_minor,
        'currency', product.currency,
        'unitLabel', product.unit_label_ar,
        'turnaroundDays', product.turnaround_days,
        'badge', product.badge_ar,
        'imageUrl', product.card_image_url,
        'marketplaceVisible', product.marketplace_visible,
        'featured', product.is_featured,
        'status', product.status,
        'displayOrder', product.sort_order,
        'updatedAt', product.updated_at,
        'packages', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', package.id,
            'key', package.package_key,
            'name', package.name_ar,
            'description', package.description_ar,
            'amountMinor', package.amount_minor,
            'currency', package.currency,
            'turnaroundDays', package.turnaround_days,
            'includedItems', package.included_items_ar,
            'revisionsIncluded', package.revisions_included,
            'recommended', package.is_recommended,
            'status', package.status,
            'displayOrder', package.display_order,
            'updatedAt', package.updated_at
          ) order by package.display_order, package.amount_minor)
          from marketplace.service_packages package
          where package.service_product_id = product.id
        ), '[]'::jsonb)
      ) order by category.sort_order, product.is_featured desc, product.sort_order)
      from marketplace.service_products product
      join marketplace.service_categories category on category.id = product.category_id
      left join marketplace.service_providers provider on provider.id = product.provider_id
      left join marketplace.service_provider_courses course on course.id = product.course_id
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(
        private_app.marketplace_order_payload(recent.id)
        || jsonb_strip_nulls(jsonb_build_object(
          'tenantName', recent.tenant_name,
          'tenantSlug', recent.tenant_slug,
          'brief', brief.brief,
          'preferredStartDate', brief.preferred_start_date,
          'deliveryMode', brief.delivery_mode,
          'providerId', assignment.provider_id,
          'providerName', provider.display_name_ar,
          'packageId', assignment.package_id,
          'assignmentStatus', assignment.status,
          'dueAt', assignment.due_at,
          'assignmentUpdatedAt', assignment.updated_at
        )) order by recent.created_at desc
      )
      from (
        select orders.id, orders.created_at, tenant.name tenant_name, tenant.slug tenant_slug
        from marketplace.orders orders
        join core.tenants tenant on tenant.id = orders.tenant_id
        where orders.order_kind = 'service'
        order by orders.created_at desc
        limit 200
      ) recent
      left join marketplace.service_order_briefs brief on brief.order_id = recent.id
      left join marketplace.service_order_assignments assignment on assignment.order_id = recent.id
      left join marketplace.service_providers provider on provider.id = assignment.provider_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v1_platform_service_marketplace_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_provider marketplace.service_providers%rowtype;
  v_course marketplace.service_provider_courses%rowtype;
  v_product marketplace.service_products%rowtype;
  v_package marketplace.service_packages%rowtype;
  v_order marketplace.orders%rowtype;
  v_assignment marketplace.service_order_assignments%rowtype;
  v_id uuid;
  v_expected_updated_at timestamptz;
  v_languages text[];
  v_expertise text[];
  v_objectives text[];
  v_delivery_modes text[];
  v_included_items text[];
  v_amount bigint;
  v_status text;
  v_previous_provider_id uuid;
  v_previous_assignment_status text;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'service_marketplace_payload_invalid';
  end if;

  if p_action = 'save_provider' then
    begin
      v_id := nullif(v_payload ->> 'providerId', '')::uuid;
      v_expected_updated_at := nullif(v_payload ->> 'expectedUpdatedAt', '')::timestamptz;
    exception when others then
      raise exception 'service_provider_invalid';
    end;
    v_languages := coalesce(array(
      select left(pg_catalog.btrim(value), 60)
      from jsonb_array_elements_text(coalesce(v_payload -> 'languages', '["العربية"]'::jsonb)) value
      where pg_catalog.btrim(value) <> ''
      limit 20
    ), array['العربية']::text[]);
    if cardinality(v_languages) = 0 then v_languages := array['العربية']::text[]; end if;
    v_expertise := array(
      select left(pg_catalog.btrim(value), 80)
      from jsonb_array_elements_text(coalesce(v_payload -> 'expertise', '[]'::jsonb)) value
      where pg_catalog.btrim(value) <> ''
      limit 30
    );
    if pg_catalog.length(pg_catalog.btrim(v_payload ->> 'name')) not between 2 and 150 then
      raise exception 'service_provider_name_required';
    end if;
    if coalesce(v_payload ->> 'type', '') not in ('lecturer','trainer','consultant','freelancer','agency','company')
       or coalesce(v_payload ->> 'status', '') not in ('draft','active','paused','archived')
       or coalesce(v_payload ->> 'verificationStatus', '') not in ('unverified','pending','verified','rejected')
       or coalesce(v_payload ->> 'availabilityStatus', '') not in ('available','limited','unavailable') then
      raise exception 'service_provider_invalid';
    end if;
    if v_id is null then
      if coalesce(v_payload ->> 'key', '') !~ '^[a-z][a-z0-9_]{2,80}$' then
        raise exception 'service_provider_key_invalid';
      end if;
      insert into marketplace.service_providers(
        provider_key, provider_type, display_name_ar, display_name_en,
        professional_title_ar, short_bio_ar, bio_ar, avatar_url, cover_url,
        city_ar, country_code, nationality_ar, years_experience, languages,
        expertise_tags, verification_status, availability_status, status,
        is_featured, display_order
      ) values(
        v_payload ->> 'key', v_payload ->> 'type', pg_catalog.btrim(v_payload ->> 'name'),
        nullif(pg_catalog.btrim(v_payload ->> 'nameEn'), ''),
        nullif(pg_catalog.btrim(v_payload ->> 'title'), ''),
        nullif(pg_catalog.btrim(v_payload ->> 'shortBio'), ''),
        nullif(pg_catalog.btrim(v_payload ->> 'bio'), ''),
        nullif(pg_catalog.btrim(v_payload ->> 'avatarUrl'), ''),
        nullif(pg_catalog.btrim(v_payload ->> 'coverUrl'), ''),
        nullif(pg_catalog.btrim(v_payload ->> 'city'), ''),
        upper(coalesce(nullif(v_payload ->> 'countryCode', ''), 'SA')),
        nullif(pg_catalog.btrim(v_payload ->> 'nationality'), ''),
        nullif(v_payload ->> 'yearsExperience', '')::smallint,
        v_languages, v_expertise, v_payload ->> 'verificationStatus',
        v_payload ->> 'availabilityStatus', v_payload ->> 'status',
        coalesce((v_payload ->> 'featured')::boolean, false),
        coalesce((v_payload ->> 'displayOrder')::integer, 100)
      ) returning * into v_provider;
    else
      select * into v_provider from marketplace.service_providers
      where id = v_id for update;
      if v_provider.id is null then raise exception 'service_provider_not_found'; end if;
      if v_expected_updated_at is null or v_provider.updated_at is distinct from v_expected_updated_at then
        raise exception 'service_provider_update_conflict';
      end if;
      update marketplace.service_providers set
        provider_type = v_payload ->> 'type',
        display_name_ar = pg_catalog.btrim(v_payload ->> 'name'),
        display_name_en = nullif(pg_catalog.btrim(v_payload ->> 'nameEn'), ''),
        professional_title_ar = nullif(pg_catalog.btrim(v_payload ->> 'title'), ''),
        short_bio_ar = nullif(pg_catalog.btrim(v_payload ->> 'shortBio'), ''),
        bio_ar = nullif(pg_catalog.btrim(v_payload ->> 'bio'), ''),
        avatar_url = nullif(pg_catalog.btrim(v_payload ->> 'avatarUrl'), ''),
        cover_url = nullif(pg_catalog.btrim(v_payload ->> 'coverUrl'), ''),
        city_ar = nullif(pg_catalog.btrim(v_payload ->> 'city'), ''),
        country_code = upper(coalesce(nullif(v_payload ->> 'countryCode', ''), country_code)),
        nationality_ar = nullif(pg_catalog.btrim(v_payload ->> 'nationality'), ''),
        years_experience = nullif(v_payload ->> 'yearsExperience', '')::smallint,
        languages = v_languages,
        expertise_tags = v_expertise,
        verification_status = v_payload ->> 'verificationStatus',
        availability_status = v_payload ->> 'availabilityStatus',
        status = v_payload ->> 'status',
        is_featured = coalesce((v_payload ->> 'featured')::boolean, false),
        display_order = coalesce((v_payload ->> 'displayOrder')::integer, display_order),
        updated_at = pg_catalog.clock_timestamp()
      where id = v_id returning * into v_provider;
    end if;
    insert into marketplace.service_provider_contacts(
      provider_id, email, phone, whatsapp, website_url, linkedin_url,
      internal_notes, updated_at
    ) values(
      v_provider.id,
      nullif(pg_catalog.btrim(v_payload #>> '{contact,email}'), ''),
      nullif(pg_catalog.btrim(v_payload #>> '{contact,phone}'), ''),
      nullif(pg_catalog.btrim(v_payload #>> '{contact,whatsapp}'), ''),
      nullif(pg_catalog.btrim(v_payload #>> '{contact,websiteUrl}'), ''),
      nullif(pg_catalog.btrim(v_payload #>> '{contact,linkedinUrl}'), ''),
      nullif(pg_catalog.btrim(v_payload #>> '{contact,internalNotes}'), ''),
      pg_catalog.clock_timestamp()
    ) on conflict (provider_id) do update set
      email = case when coalesce(v_payload -> 'contact','{}'::jsonb) ? 'email' then excluded.email else marketplace.service_provider_contacts.email end,
      phone = case when coalesce(v_payload -> 'contact','{}'::jsonb) ? 'phone' then excluded.phone else marketplace.service_provider_contacts.phone end,
      whatsapp = case when coalesce(v_payload -> 'contact','{}'::jsonb) ? 'whatsapp' then excluded.whatsapp else marketplace.service_provider_contacts.whatsapp end,
      website_url = case when coalesce(v_payload -> 'contact','{}'::jsonb) ? 'websiteUrl' then excluded.website_url else marketplace.service_provider_contacts.website_url end,
      linkedin_url = case when coalesce(v_payload -> 'contact','{}'::jsonb) ? 'linkedinUrl' then excluded.linkedin_url else marketplace.service_provider_contacts.linkedin_url end,
      internal_notes = case when coalesce(v_payload -> 'contact','{}'::jsonb) ? 'internalNotes' then excluded.internal_notes else marketplace.service_provider_contacts.internal_notes end,
      updated_at = excluded.updated_at;
    perform private_app.write_audit(
      'service.provider.saved', 'service_provider', v_provider.id::text, null,
      jsonb_build_object('providerKey', v_provider.provider_key, 'status', v_provider.status)
    );
    return jsonb_build_object('id', v_provider.id, 'updatedAt', v_provider.updated_at);

  elsif p_action = 'save_course' then
    begin
      v_id := nullif(v_payload ->> 'courseId', '')::uuid;
      v_expected_updated_at := nullif(v_payload ->> 'expectedUpdatedAt', '')::timestamptz;
      v_provider.id := nullif(v_payload ->> 'providerId', '')::uuid;
    exception when others then raise exception 'service_course_invalid'; end;
    if not exists(select 1 from marketplace.service_providers where id = v_provider.id and status <> 'archived') then
      raise exception 'service_provider_not_found';
    end if;
    if pg_catalog.length(pg_catalog.btrim(v_payload ->> 'title')) not between 2 and 180
       or pg_catalog.length(pg_catalog.btrim(v_payload ->> 'summary')) not between 10 and 2000 then
      raise exception 'service_course_invalid';
    end if;
    v_objectives := array(select left(pg_catalog.btrim(value), 240) from jsonb_array_elements_text(coalesce(v_payload -> 'objectives','[]'::jsonb)) value where pg_catalog.btrim(value) <> '' limit 30);
    v_delivery_modes := array(select value from jsonb_array_elements_text(coalesce(v_payload -> 'deliveryModes','["online"]'::jsonb)) value where value in ('online','onsite','hybrid','recorded') limit 4);
    if cardinality(v_delivery_modes) = 0 then v_delivery_modes := array['online']::text[]; end if;
    v_status := coalesce(v_payload ->> 'status', 'draft');
    if v_status not in ('draft','active','paused','archived') then raise exception 'service_course_invalid'; end if;
    if v_id is null then
      if coalesce(v_payload ->> 'key','') !~ '^[a-z][a-z0-9_]{2,80}$' then raise exception 'service_course_key_invalid'; end if;
      insert into marketplace.service_provider_courses(
        provider_id, course_key, title_ar, title_en, summary_ar,
        target_audience_ar, objectives_ar, duration_hours, delivery_modes,
        language_ar, accreditation_ar, image_url, status, display_order
      ) values(
        v_provider.id, v_payload ->> 'key', pg_catalog.btrim(v_payload ->> 'title'),
        nullif(pg_catalog.btrim(v_payload ->> 'titleEn'), ''), pg_catalog.btrim(v_payload ->> 'summary'),
        nullif(pg_catalog.btrim(v_payload ->> 'targetAudience'), ''), v_objectives,
        nullif(v_payload ->> 'durationHours', '')::numeric, v_delivery_modes,
        coalesce(nullif(pg_catalog.btrim(v_payload ->> 'language'), ''), 'العربية'),
        nullif(pg_catalog.btrim(v_payload ->> 'accreditation'), ''),
        nullif(pg_catalog.btrim(v_payload ->> 'imageUrl'), ''), v_status,
        coalesce((v_payload ->> 'displayOrder')::integer,100)
      ) returning * into v_course;
    else
      select * into v_course from marketplace.service_provider_courses where id = v_id for update;
      if v_course.id is null then raise exception 'service_course_not_found'; end if;
      if v_expected_updated_at is null or v_course.updated_at is distinct from v_expected_updated_at then raise exception 'service_course_update_conflict'; end if;
      if v_course.provider_id is distinct from v_provider.id
         and exists(
           select 1
           from marketplace.service_products product
           where product.course_id = v_course.id
         ) then
        raise exception 'service_course_provider_locked';
      end if;
      update marketplace.service_provider_courses set
        provider_id = v_provider.id, title_ar = pg_catalog.btrim(v_payload ->> 'title'),
        title_en = nullif(pg_catalog.btrim(v_payload ->> 'titleEn'), ''),
        summary_ar = pg_catalog.btrim(v_payload ->> 'summary'),
        target_audience_ar = nullif(pg_catalog.btrim(v_payload ->> 'targetAudience'), ''),
        objectives_ar = v_objectives, duration_hours = nullif(v_payload ->> 'durationHours','')::numeric,
        delivery_modes = v_delivery_modes,
        language_ar = coalesce(nullif(pg_catalog.btrim(v_payload ->> 'language'), ''), language_ar),
        accreditation_ar = nullif(pg_catalog.btrim(v_payload ->> 'accreditation'), ''),
        image_url = nullif(pg_catalog.btrim(v_payload ->> 'imageUrl'), ''),
        status = v_status, display_order = coalesce((v_payload ->> 'displayOrder')::integer, display_order),
        updated_at = pg_catalog.clock_timestamp()
      where id = v_id returning * into v_course;
    end if;
    perform private_app.write_audit('service.course.saved','service_course',v_course.id::text,null,jsonb_build_object('providerId',v_course.provider_id,'status',v_course.status));
    return jsonb_build_object('id',v_course.id,'updatedAt',v_course.updated_at);

  elsif p_action in ('save_service','save_service_product') then
    begin
      v_id := nullif(v_payload ->> 'productId','')::uuid;
      v_expected_updated_at := nullif(v_payload ->> 'expectedUpdatedAt','')::timestamptz;
      v_product.category_id := nullif(v_payload ->> 'categoryId','')::uuid;
      v_product.provider_id := nullif(v_payload ->> 'providerId','')::uuid;
      v_product.course_id := nullif(v_payload ->> 'courseId','')::uuid;
      v_amount := coalesce((v_payload ->> 'amountMinor')::bigint,0);
    exception when others then raise exception 'service_product_invalid'; end;
    if not exists(select 1 from marketplace.service_categories where id = v_product.category_id and status = 'active') then raise exception 'category_not_found'; end if;
    if v_product.provider_id is not null and not exists(select 1 from marketplace.service_providers where id = v_product.provider_id and status <> 'archived') then raise exception 'service_provider_not_found'; end if;
    if v_product.course_id is not null and not exists(select 1 from marketplace.service_provider_courses where id = v_product.course_id and provider_id = v_product.provider_id and status <> 'archived') then raise exception 'service_course_not_found'; end if;
    if pg_catalog.length(pg_catalog.btrim(v_payload ->> 'name')) not between 2 and 180 then raise exception 'service_name_required'; end if;
    if pg_catalog.length(pg_catalog.btrim(v_payload ->> 'description')) not between 10 and 4000 then raise exception 'service_description_required'; end if;
    if coalesce(v_payload ->> 'pricingMode','') not in ('fixed','from','quote') or v_amount < 0 then raise exception 'service_price_invalid'; end if;
    if (v_payload ->> 'pricingMode') <> 'quote' and v_amount = 0 then raise exception 'service_price_invalid'; end if;
    if coalesce(v_payload ->> 'status','') not in ('draft','beta','active','archived') then raise exception 'service_product_invalid'; end if;
    if v_id is null then
      if coalesce(v_payload ->> 'key','') !~ '^[a-z][a-z0-9_]{2,80}$' then raise exception 'invalid_service_key'; end if;
      insert into marketplace.service_products(
        category_id, provider_id, course_id, product_key, name_ar, description_ar,
        short_description_ar, card_image_url, pricing_mode, amount_minor, currency,
        unit_label_ar, turnaround_days, badge_ar, marketplace_visible, is_featured,
        status, sort_order
      ) values(
        v_product.category_id, v_product.provider_id, v_product.course_id,
        v_payload ->> 'key', pg_catalog.btrim(v_payload ->> 'name'), pg_catalog.btrim(v_payload ->> 'description'),
        nullif(pg_catalog.btrim(v_payload ->> 'shortDescription'), ''), nullif(pg_catalog.btrim(v_payload ->> 'imageUrl'), ''),
        v_payload ->> 'pricingMode', v_amount, upper(coalesce(nullif(v_payload ->> 'currency',''),'SAR')),
        coalesce(nullif(pg_catalog.btrim(v_payload ->> 'unitLabel'),''),'خدمة'),
        nullif(v_payload ->> 'turnaroundDays','')::integer, nullif(pg_catalog.btrim(v_payload ->> 'badge'),''),
        coalesce((v_payload ->> 'marketplaceVisible')::boolean,true), coalesce((v_payload ->> 'featured')::boolean,false),
        coalesce(nullif(v_payload ->> 'status',''),'draft'), coalesce((v_payload ->> 'displayOrder')::integer,100)
      ) returning * into v_product;
    else
      select * into v_product from marketplace.service_products where id = v_id for update;
      if v_product.id is null then raise exception 'service_not_found'; end if;
      if v_expected_updated_at is null or v_product.updated_at is distinct from v_expected_updated_at then raise exception 'service_product_update_conflict'; end if;
      update marketplace.service_products set
        category_id = nullif(v_payload ->> 'categoryId','')::uuid,
        provider_id = nullif(v_payload ->> 'providerId','')::uuid,
        course_id = nullif(v_payload ->> 'courseId','')::uuid,
        name_ar = pg_catalog.btrim(v_payload ->> 'name'),
        description_ar = pg_catalog.btrim(v_payload ->> 'description'),
        short_description_ar = nullif(pg_catalog.btrim(v_payload ->> 'shortDescription'),''),
        card_image_url = nullif(pg_catalog.btrim(v_payload ->> 'imageUrl'),''),
        pricing_mode = v_payload ->> 'pricingMode', amount_minor = v_amount,
        currency = upper(coalesce(nullif(v_payload ->> 'currency',''),currency)),
        unit_label_ar = coalesce(nullif(pg_catalog.btrim(v_payload ->> 'unitLabel'),''),unit_label_ar),
        turnaround_days = nullif(v_payload ->> 'turnaroundDays','')::integer,
        badge_ar = nullif(pg_catalog.btrim(v_payload ->> 'badge'),''),
        marketplace_visible = coalesce((v_payload ->> 'marketplaceVisible')::boolean,marketplace_visible),
        is_featured = coalesce((v_payload ->> 'featured')::boolean,is_featured),
        status = coalesce(nullif(v_payload ->> 'status',''),status),
        sort_order = coalesce((v_payload ->> 'displayOrder')::integer,sort_order),
        updated_at = pg_catalog.clock_timestamp()
      where id = v_id returning * into v_product;
    end if;
    update marketplace.service_packages
    set provider_id = v_product.provider_id,
        updated_at = pg_catalog.clock_timestamp()
    where service_product_id = v_product.id
      and provider_id is distinct from v_product.provider_id;
    perform private_app.write_audit('service.product.saved','service_product',v_product.id::text,null,jsonb_build_object('productKey',v_product.product_key,'providerId',v_product.provider_id,'visible',v_product.marketplace_visible));
    return jsonb_build_object('id',v_product.id,'updatedAt',v_product.updated_at);

  elsif p_action = 'save_package' then
    begin
      v_id := nullif(v_payload ->> 'packageId','')::uuid;
      v_expected_updated_at := nullif(v_payload ->> 'expectedUpdatedAt','')::timestamptz;
      v_product.id := nullif(v_payload ->> 'productId','')::uuid;
      v_amount := (v_payload ->> 'amountMinor')::bigint;
    exception when others then raise exception 'service_package_invalid'; end;
    select * into v_product from marketplace.service_products where id = v_product.id and status <> 'archived';
    if v_product.id is null then raise exception 'service_not_found'; end if;
    if v_amount <= 0 or pg_catalog.length(pg_catalog.btrim(v_payload ->> 'name')) not between 2 and 120 then raise exception 'service_package_invalid'; end if;
    v_included_items := array(select left(pg_catalog.btrim(value),240) from jsonb_array_elements_text(coalesce(v_payload -> 'includedItems','[]'::jsonb)) value where pg_catalog.btrim(value) <> '' limit 40);
    v_status := coalesce(v_payload ->> 'status','draft');
    if v_status not in ('draft','active','paused','archived') then raise exception 'service_package_invalid'; end if;
    if v_id is null then
      if coalesce(v_payload ->> 'key','') !~ '^[a-z][a-z0-9_]{1,60}$' then raise exception 'service_package_key_invalid'; end if;
      insert into marketplace.service_packages(
        service_product_id, provider_id, package_key, name_ar, description_ar,
        amount_minor, currency, turnaround_days, included_items_ar,
        revisions_included, is_recommended, status, display_order
      ) values(
        v_product.id, v_product.provider_id, v_payload ->> 'key', pg_catalog.btrim(v_payload ->> 'name'),
        nullif(pg_catalog.btrim(v_payload ->> 'description'),''), v_amount,
        upper(coalesce(nullif(v_payload ->> 'currency',''),'SAR')),
        nullif(v_payload ->> 'turnaroundDays','')::integer, v_included_items,
        coalesce((v_payload ->> 'revisionsIncluded')::smallint,0),
        coalesce((v_payload ->> 'recommended')::boolean,false), v_status,
        coalesce((v_payload ->> 'displayOrder')::integer,100)
      ) returning * into v_package;
    else
      select * into v_package from marketplace.service_packages where id = v_id for update;
      if v_package.id is null then raise exception 'service_package_not_found'; end if;
      if v_expected_updated_at is null or v_package.updated_at is distinct from v_expected_updated_at then raise exception 'service_package_update_conflict'; end if;
      if v_package.service_product_id is distinct from v_product.id then
        raise exception 'service_package_product_locked';
      end if;
      update marketplace.service_packages set
        provider_id = v_product.provider_id,
        name_ar = pg_catalog.btrim(v_payload ->> 'name'),
        description_ar = nullif(pg_catalog.btrim(v_payload ->> 'description'),''),
        amount_minor = v_amount, currency = upper(coalesce(nullif(v_payload ->> 'currency',''),currency)),
        turnaround_days = nullif(v_payload ->> 'turnaroundDays','')::integer,
        included_items_ar = v_included_items,
        revisions_included = coalesce((v_payload ->> 'revisionsIncluded')::smallint,revisions_included),
        is_recommended = coalesce((v_payload ->> 'recommended')::boolean,is_recommended),
        status = v_status, display_order = coalesce((v_payload ->> 'displayOrder')::integer,display_order),
        updated_at = pg_catalog.clock_timestamp()
      where id = v_id returning * into v_package;
    end if;
    perform private_app.write_audit('service.package.saved','service_package',v_package.id::text,null,jsonb_build_object('productId',v_package.service_product_id,'status',v_package.status));
    return jsonb_build_object('id',v_package.id,'updatedAt',v_package.updated_at);

  elsif p_action = 'assign_order' then
    begin
      v_order.id := (v_payload ->> 'orderId')::uuid;
      v_provider.id := (v_payload ->> 'providerId')::uuid;
      v_id := nullif(v_payload ->> 'packageId','')::uuid;
      v_expected_updated_at := nullif(v_payload ->> 'expectedUpdatedAt','')::timestamptz;
    exception when others then raise exception 'service_assignment_invalid'; end;
    select * into v_order from marketplace.orders where id = v_order.id and order_kind = 'service' for update;
    if v_order.id is null then raise exception 'marketplace_service_order_invalid'; end if;
    if v_order.status not in ('paid','in_progress') then raise exception 'service_assignment_order_not_ready'; end if;
    if not exists(select 1 from marketplace.service_providers where id = v_provider.id and status = 'active') then raise exception 'service_provider_not_available'; end if;
    select item.service_package_id into v_package.id
    from marketplace.order_items item
    where item.order_id = v_order.id
      and item.item_type = 'service'
    order by item.created_at
    limit 1;
    if v_id is not null and v_id is distinct from v_package.id then
      raise exception 'service_assignment_package_locked';
    end if;
    select * into v_assignment from marketplace.service_order_assignments where order_id = v_order.id for update;
    if v_assignment.order_id is not null and (v_expected_updated_at is null or v_assignment.updated_at is distinct from v_expected_updated_at) then raise exception 'service_assignment_update_conflict'; end if;
    v_previous_provider_id := v_assignment.provider_id;
    v_previous_assignment_status := v_assignment.status;
    insert into marketplace.service_assignment_events(
      order_id, tenant_id, from_provider_id, to_provider_id,
      from_status, to_status, reason, actor_subject_id
    ) values(
      v_order.id, v_order.tenant_id, v_previous_provider_id, v_provider.id,
      v_previous_assignment_status,
      case when v_order.status = 'in_progress' then 'in_progress' else 'assigned' end,
      left(nullif(pg_catalog.btrim(v_payload ->> 'reason'),''),1000),
      private_app.current_subject_id()
    );
    insert into marketplace.service_order_assignments(
      order_id, tenant_id, provider_id, package_id, status, due_at,
      assigned_by_subject_id, assigned_at, started_at, delivered_at,
      completed_at, updated_at
    ) values(
      v_order.id, v_order.tenant_id, v_provider.id, v_package.id,
      case when v_order.status = 'in_progress' then 'in_progress' else 'assigned' end,
      nullif(v_payload ->> 'dueAt','')::timestamptz,
      private_app.current_subject_id(), pg_catalog.clock_timestamp(),
      case when v_order.status = 'in_progress' then pg_catalog.clock_timestamp() else null end,
      null, null, pg_catalog.clock_timestamp()
    ) on conflict (order_id) do update set
      provider_id = excluded.provider_id, package_id = excluded.package_id,
      status = excluded.status, due_at = excluded.due_at,
      assigned_by_subject_id = excluded.assigned_by_subject_id,
      assigned_at = excluded.assigned_at, started_at = excluded.started_at,
      delivered_at = null, completed_at = null,
      updated_at = excluded.updated_at
    returning * into v_assignment;
    insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata)
    values(v_order.id,v_order.tenant_id,private_app.current_subject_id(),'service_provider_assigned',v_order.status,v_order.status,jsonb_build_object('providerId',v_provider.id,'packageId',v_package.id,'dueAt',v_assignment.due_at));
    perform private_app.write_audit('service.order.assigned','marketplace_order',v_order.id::text,v_order.tenant_id,jsonb_build_object('fromProviderId',v_previous_provider_id,'providerId',v_provider.id,'dueAt',v_assignment.due_at));
    return jsonb_build_object('orderId',v_order.id,'providerId',v_provider.id,'updatedAt',v_assignment.updated_at);

  elsif p_action = 'moderate_review' then
    begin v_id := (v_payload ->> 'reviewId')::uuid; exception when others then raise exception 'service_review_invalid'; end;
    v_status := coalesce(v_payload ->> 'status','');
    if v_status not in ('approved','rejected','hidden') then raise exception 'service_review_invalid'; end if;
    update marketplace.service_reviews set moderation_status = v_status, updated_at = pg_catalog.clock_timestamp() where id = v_id;
    if not found then raise exception 'service_review_not_found'; end if;
    perform private_app.write_audit('service.review.moderated','service_review',v_id::text,null,jsonb_build_object('status',v_status));
    return jsonb_build_object('id',v_id,'status',v_status);
  else
    raise exception 'service_marketplace_action_invalid';
  end if;
end;
$$;

create or replace function public.v2_tenant_service_marketplace_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_tenant_id uuid;
begin
  v_base := public.v2_tenant_marketplace_snapshot(p_slug);
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  return (
    v_base
    - 'addons'
    - 'addonCategories'
    - 'services'
    - 'orders'
    - 'categories'
    - 'summary'
  ) || jsonb_build_object(
    'schemaVersion', 2,
    'summary', jsonb_build_object(
      'serviceProviders', (
        select count(*)
        from marketplace.service_providers provider
        where provider.status = 'active'
          and exists(
            select 1
            from marketplace.service_products product
            join marketplace.service_categories category
              on category.id = product.category_id
             and category.status = 'active'
            where product.provider_id = provider.id
              and product.marketplace_visible
              and product.status in ('beta','active')
          )
      ),
      'serviceProducts', (
        select count(*) from marketplace.service_products product
        join marketplace.service_categories category
          on category.id = product.category_id
         and category.status = 'active'
        left join marketplace.service_providers provider on provider.id = product.provider_id
        where product.marketplace_visible and product.status in ('beta','active')
          and (provider.id is null or provider.status = 'active')
      ),
      'openOrders', (
        select count(*)
        from marketplace.orders orders
        where orders.tenant_id = v_tenant_id
          and orders.order_kind = 'service'
          and orders.status in ('pending_payment','paid','in_progress')
      )
    ),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', category.category_key,
        'name', category.name_ar,
        'description', category.description_ar,
        'iconKey', category.icon_key,
        'productCount', (
          select count(*)
          from marketplace.service_products product
          left join marketplace.service_providers provider
            on provider.id = product.provider_id
          where product.category_id = category.id
            and product.marketplace_visible
            and product.status in ('beta','active')
            and (provider.id is null or provider.status = 'active')
        )
      ) order by category.sort_order)
      from marketplace.service_categories category
      where category.status = 'active'
    ), '[]'::jsonb),
    'providers', coalesce((
      select jsonb_agg(private_app.service_provider_public_payload(provider.id)
        order by provider.is_featured desc, provider.display_order, provider.display_name_ar)
      from marketplace.service_providers provider
      where provider.status = 'active'
        and exists(
          select 1
          from marketplace.service_products product
          join marketplace.service_categories category
            on category.id = product.category_id
           and category.status = 'active'
          where product.provider_id = provider.id
            and product.marketplace_visible
            and product.status in ('beta','active')
        )
    ), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', product.id,
        'key', product.product_key,
        'categoryKey', category.category_key,
        'categoryName', category.name_ar,
        'name', product.name_ar,
        'description', product.description_ar,
        'shortDescription', product.short_description_ar,
        'imageUrl', product.card_image_url,
        'pricingMode', product.pricing_mode,
        'amountMinor', product.amount_minor,
        'currency', product.currency,
        'unitLabel', product.unit_label_ar,
        'turnaroundDays', product.turnaround_days,
        'badge', product.badge_ar,
        'featured', product.is_featured,
        'provider', case when provider.id is null then null else private_app.service_provider_public_payload(provider.id) end,
        'course', case when course.id is null then null else jsonb_build_object(
          'id', course.id, 'title', course.title_ar, 'summary', course.summary_ar,
          'targetAudience', course.target_audience_ar, 'objectives', course.objectives_ar,
          'durationHours', course.duration_hours, 'deliveryModes', course.delivery_modes,
          'language', course.language_ar, 'accreditation', course.accreditation_ar,
          'imageUrl', course.image_url
        ) end,
        'packages', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', package.id, 'key', package.package_key, 'name', package.name_ar,
            'description', package.description_ar, 'amountMinor', package.amount_minor,
            'currency', package.currency, 'turnaroundDays', package.turnaround_days,
            'includedItems', package.included_items_ar,
            'revisionsIncluded', package.revisions_included,
            'recommended', package.is_recommended
          ) order by package.is_recommended desc, package.display_order, package.amount_minor)
          from marketplace.service_packages package
          where package.service_product_id = product.id and package.status = 'active'
        ), '[]'::jsonb)
      )) order by category.sort_order, product.is_featured desc, product.sort_order)
      from marketplace.service_products product
      join marketplace.service_categories category on category.id = product.category_id and category.status = 'active'
      left join marketplace.service_providers provider on provider.id = product.provider_id
      left join marketplace.service_provider_courses course on course.id = product.course_id and course.status = 'active'
      where product.marketplace_visible and product.status in ('beta','active')
        and (provider.id is null or provider.status = 'active')
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(
        private_app.marketplace_order_payload(recent.id)
        || jsonb_strip_nulls(jsonb_build_object(
          'providerId', assignment.provider_id,
          'providerName', provider.display_name_ar,
          'packageId', coalesce(assignment.package_id, brief.package_id),
          'assignmentStatus', assignment.status,
          'dueAt', assignment.due_at
        ))
        order by recent.created_at desc
      )
      from (
        select orders.id, orders.created_at
        from marketplace.orders orders
        where orders.tenant_id = v_tenant_id
          and orders.order_kind = 'service'
        order by orders.created_at desc
        limit 30
      ) recent
      left join marketplace.service_order_briefs brief
        on brief.order_id = recent.id
      left join marketplace.service_order_assignments assignment
        on assignment.order_id = recent.id
      left join marketplace.service_providers provider
        on provider.id = assignment.provider_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_service_marketplace_action(
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
  v_product marketplace.service_products%rowtype;
  v_package marketplace.service_packages%rowtype;
  v_order marketplace.orders%rowtype;
  v_idempotency_key text;
  v_quantity integer;
  v_amount bigint;
  v_subtotal bigint;
  v_tax bigint;
  v_brief jsonb;
  v_result jsonb;
  v_provider_key text;
  v_payment_instructions jsonb;
begin
  select * into v_tenant from core.tenants where slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(v_tenant.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  if p_action = 'cancel_order' then
    begin
      select * into v_order
      from marketplace.orders
      where id = (p_payload ->> 'orderId')::uuid
        and tenant_id = v_tenant.id
        and order_kind = 'service';
    exception when others then
      raise exception 'marketplace_order_invalid';
    end;
    if v_order.id is null then
      raise exception 'marketplace_order_not_found';
    end if;
    v_result := public.v2_tenant_marketplace_action(p_slug,p_action,p_payload);
    update marketplace.service_order_assignments set status = 'cancelled', updated_at = pg_catalog.clock_timestamp()
    where order_id = nullif(p_payload ->> 'orderId','')::uuid;
    return v_result;
  elsif p_action = 'submit_review' then
    begin
      select * into v_order from marketplace.orders
      where id = (p_payload ->> 'orderId')::uuid and tenant_id = v_tenant.id and order_kind = 'service';
      v_quantity := (p_payload ->> 'rating')::integer;
    exception when others then raise exception 'service_review_invalid'; end;
    if v_order.id is null or v_order.status <> 'completed' or v_quantity not between 1 and 5 then raise exception 'service_review_invalid'; end if;
    insert into marketplace.service_reviews(order_id,tenant_id,provider_id,rating,review_text,created_by_subject_id)
    select v_order.id,v_tenant.id,assignment.provider_id,v_quantity,left(nullif(pg_catalog.btrim(p_payload ->> 'reviewText'),''),2000),v_actor
    from marketplace.service_order_assignments assignment where assignment.order_id = v_order.id
    on conflict (order_id) do nothing;
    if not found then raise exception 'service_review_unavailable'; end if;
    return jsonb_build_object('orderId',v_order.id,'submitted',true);
  elsif p_action <> 'create_service_order' then
    raise exception 'service_marketplace_action_invalid';
  end if;

  v_idempotency_key := left(nullif(pg_catalog.btrim(p_payload ->> 'idempotencyKey'),''),120);
  if v_idempotency_key is null then raise exception 'marketplace_idempotency_required'; end if;
  select * into v_order
  from marketplace.orders
  where tenant_id = v_tenant.id
    and idempotency_key = v_idempotency_key;
  if v_order.id is not null then
    if v_order.order_kind <> 'service' then
      raise exception 'marketplace_idempotency_conflict';
    end if;
    v_provider_key := coalesce(v_order.payment_provider,'bank_transfer');
    select provider.public_config into v_payment_instructions
    from marketplace.payment_provider_configs provider
    where provider.provider_key = v_provider_key;
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object(
        'duplicate',true,
        'paymentProvider',v_provider_key,
        'paymentInstructions',v_payment_instructions
      );
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    v_tenant.id::text||':service:idempotency:'||v_idempotency_key,0
  ));
  select * into v_order
  from marketplace.orders
  where tenant_id = v_tenant.id
    and idempotency_key = v_idempotency_key;
  if v_order.id is not null then
    if v_order.order_kind <> 'service' then
      raise exception 'marketplace_idempotency_conflict';
    end if;
    v_provider_key := coalesce(v_order.payment_provider,'bank_transfer');
    select provider.public_config into v_payment_instructions
    from marketplace.payment_provider_configs provider
    where provider.provider_key = v_provider_key;
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object(
        'duplicate',true,
        'paymentProvider',v_provider_key,
        'paymentInstructions',v_payment_instructions
      );
  end if;
  begin v_quantity := coalesce((p_payload ->> 'quantity')::integer,1); exception when others then raise exception 'marketplace_quantity_invalid'; end;
  if v_quantity not between 1 and 100 then raise exception 'marketplace_quantity_invalid'; end if;
  select product.* into v_product
  from marketplace.service_products product
  join marketplace.service_categories category
    on category.id = product.category_id
   and category.status = 'active'
  where product.product_key = lower(nullif(pg_catalog.btrim(p_payload ->> 'productKey'),''))
    and product.marketplace_visible and product.status in ('beta','active')
    and (product.provider_id is null or exists(select 1 from marketplace.service_providers provider where provider.id = product.provider_id and provider.status = 'active'));
  if v_product.id is null then raise exception 'marketplace_product_not_found'; end if;
  begin v_package.id := nullif(p_payload ->> 'packageId','')::uuid; exception when others then raise exception 'service_package_invalid'; end;
  if v_package.id is not null then
    select * into v_package from marketplace.service_packages package
    where package.id = v_package.id and package.service_product_id = v_product.id and package.status = 'active';
    if v_package.id is null then raise exception 'service_package_not_found'; end if;
    v_amount := v_package.amount_minor;
  else
    if v_product.pricing_mode = 'quote' or v_product.amount_minor <= 0 then raise exception 'service_quote_required'; end if;
    v_amount := v_product.amount_minor;
  end if;
  v_brief := coalesce(p_payload -> 'brief','{}'::jsonb);
  if jsonb_typeof(v_brief) <> 'object' or pg_catalog.octet_length(v_brief::text) > 20000 then raise exception 'service_brief_invalid'; end if;
  v_provider_key := lower(coalesce(
    nullif(pg_catalog.btrim(p_payload ->> 'paymentProvider'),''),
    'bank_transfer'
  ));
  select provider.public_config into v_payment_instructions
  from marketplace.payment_provider_configs provider
  where provider.provider_key = v_provider_key
    and provider.status = 'active'
    and provider.last_verified_at is not null
    and coalesce(v_package.currency,v_product.currency)
      = any(provider.supported_currencies);
  if not found then
    raise exception 'marketplace_payment_provider_unavailable';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_tenant.id::text||':service:product:'||v_product.product_key,0
  ));
  select orders.* into v_order from marketplace.orders orders
  join marketplace.order_items item on item.order_id = orders.id
  where orders.tenant_id = v_tenant.id and orders.status = 'pending_payment'
    and orders.payment_status = 'pending' and item.item_type = 'service'
    and item.product_key = v_product.product_key
  order by orders.created_at desc limit 1;
  if v_order.id is not null then
    v_provider_key := coalesce(v_order.payment_provider,'bank_transfer');
    select provider.public_config into v_payment_instructions
    from marketplace.payment_provider_configs provider
    where provider.provider_key = v_provider_key;
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object(
        'duplicate',true,
        'duplicateReason','pending_product_order',
        'paymentProvider',v_provider_key,
        'paymentInstructions',v_payment_instructions
      );
  end if;

  v_subtotal := v_amount * v_quantity;
  v_tax := round(v_subtotal * 0.15)::bigint;
  insert into marketplace.orders(
    tenant_id,requested_by_subject_id,order_kind,status,payment_status,
    activation_state,currency,subtotal_minor,tax_minor,total_minor,tax_rate_bps,
    payment_provider,
    notes,idempotency_key
  ) values(
    v_tenant.id,v_actor,'service','pending_payment','pending','not_applicable',
    coalesce(v_package.currency,v_product.currency),v_subtotal,v_tax,v_subtotal+v_tax,1500,
    v_provider_key,
    left(nullif(pg_catalog.btrim(p_payload ->> 'notes'),''),1000),v_idempotency_key
  ) returning * into v_order;
  insert into marketplace.order_items(
    order_id,item_type,service_product_id,service_package_id,product_key,
    product_name_ar,quantity,unit_amount_minor,line_total_minor,metadata
  ) values(
    v_order.id,'service',v_product.id,v_package.id,v_product.product_key,
    v_product.name_ar,v_quantity,v_amount,v_subtotal,
    jsonb_strip_nulls(jsonb_build_object(
      'pricingMode', case when v_package.id is null then 'catalog_price' else 'service_package' end,
      'providerId', v_product.provider_id,
      'packageId', v_package.id,
      'packageName', v_package.name_ar,
      'packageDescription', v_package.description_ar,
      'packageIncludedItems', v_package.included_items_ar,
      'packageRevisionsIncluded', v_package.revisions_included,
      'packageTurnaroundDays', v_package.turnaround_days,
      'courseId', v_product.course_id
    ))
  );
  insert into marketplace.service_order_briefs(order_id,tenant_id,provider_id,package_id,preferred_start_date,delivery_mode,brief)
  values(v_order.id,v_tenant.id,v_product.provider_id,v_package.id,nullif(p_payload ->> 'preferredStartDate','')::date,nullif(p_payload ->> 'deliveryMode',''),v_brief);
  if v_product.provider_id is not null then
    insert into marketplace.service_order_assignments(order_id,tenant_id,provider_id,package_id,status)
    values(v_order.id,v_tenant.id,v_product.provider_id,v_package.id,'pending');
  end if;
  insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,to_status,metadata)
  values(v_order.id,v_tenant.id,v_actor,'service_order_created','pending_payment',jsonb_build_object('productKey',v_product.product_key,'providerId',v_product.provider_id,'packageId',v_package.id));
  insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
  values(v_tenant.id,v_actor,'marketplace.service_order.created','marketplace_order',v_order.id::text,jsonb_build_object('orderNumber',v_order.order_number,'totalMinor',v_order.total_minor,'providerId',v_product.provider_id,'packageId',v_package.id));
  return private_app.marketplace_order_payload(v_order.id) || jsonb_build_object(
    'duplicate',false,
    'providerId',v_product.provider_id,
    'packageId',v_package.id,
    'paymentProvider',v_provider_key,
    'paymentInstructions',v_payment_instructions
  );
end;
$$;

-- Close stale generic marketplace contracts without interrupting the dedicated
-- add-on store. The existing V2 implementation remains private for add-ons;
-- service discovery and service order creation are routed through the hardened
-- service-only contracts above.
alter function public.v1_tenant_marketplace_snapshot(text)
  rename to v1_tenant_marketplace_snapshot_service_legacy;
alter function public.v1_tenant_marketplace_snapshot_service_legacy(text)
  set schema private_app;

alter function public.v1_tenant_marketplace_action(text,text,jsonb)
  rename to v1_tenant_marketplace_action_service_legacy;
alter function public.v1_tenant_marketplace_action_service_legacy(text,text,jsonb)
  set schema private_app;

alter function public.v2_tenant_marketplace_snapshot(text)
  rename to v2_tenant_marketplace_snapshot_service_legacy;
alter function public.v2_tenant_marketplace_snapshot_service_legacy(text)
  set schema private_app;

alter function public.v2_tenant_marketplace_action(text,text,jsonb)
  rename to v2_tenant_marketplace_action_service_legacy;
alter function public.v2_tenant_marketplace_action_service_legacy(text,text,jsonb)
  set schema private_app;

create or replace function public.v2_tenant_marketplace_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
begin
  v_base := private_app.v2_tenant_marketplace_snapshot_service_legacy(p_slug);
  return (v_base - 'services' - 'categories') || jsonb_build_object(
    'summary',
    coalesce(v_base -> 'summary','{}'::jsonb) - 'serviceProducts'
  );
end;
$$;

create or replace function public.v2_tenant_marketplace_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_action = 'create_order'
     and lower(pg_catalog.btrim(coalesce(p_payload ->> 'itemType',''))) = 'service' then
    return public.v2_tenant_service_marketplace_action(
      p_slug,
      'create_service_order',
      coalesce(p_payload,'{}'::jsonb) - 'itemType'
    );
  end if;
  return private_app.v2_tenant_marketplace_action_service_legacy(
    p_slug,
    p_action,
    p_payload
  );
end;
$$;

-- Compatibility contracts for an application rollback remain available, but
-- now compose the hardened add-on and service gateways instead of the unsafe
-- original V1 catalog.
create or replace function public.v1_tenant_marketplace_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
begin
  v_base := private_app.v1_tenant_marketplace_snapshot_service_legacy(p_slug);
  return v_base || jsonb_build_object(
    'services', coalesce((
      select jsonb_agg(entry order by entry ->> 'name')
      from jsonb_array_elements(coalesce(v_base -> 'services','[]'::jsonb)) entry
      join marketplace.service_products product
        on product.product_key = entry ->> 'key'
      join marketplace.service_categories category
        on category.id = product.category_id
       and category.status = 'active'
      left join marketplace.service_providers provider
        on provider.id = product.provider_id
      where product.marketplace_visible
        and product.status in ('beta','active')
        and (provider.id is null or provider.status = 'active')
    ), '[]'::jsonb),
    'addons', coalesce((
      select jsonb_agg(entry order by entry ->> 'name')
      from jsonb_array_elements(coalesce(v_base -> 'addons','[]'::jsonb)) entry
      join catalog.addon_products product
        on product.product_key = entry ->> 'key'
      where product.is_marketplace_visible
        and product.status in ('beta','active')
    ), '[]'::jsonb),
    'summary', coalesce(v_base -> 'summary','{}'::jsonb)
      || jsonb_build_object(
        'serviceProducts', (
          select count(*)
          from marketplace.service_products product
          join marketplace.service_categories category
            on category.id = product.category_id
           and category.status = 'active'
          left join marketplace.service_providers provider
            on provider.id = product.provider_id
          where product.marketplace_visible
            and product.status in ('beta','active')
            and (provider.id is null or provider.status = 'active')
        ),
        'addonProducts', (
          select count(*)
          from catalog.addon_products product
          where product.is_marketplace_visible
            and product.status in ('beta','active')
            and product.pricing_mode in ('fixed','free')
            and (product.pricing_mode = 'free' or product.amount_minor > 0)
        )
      )
  );
end;
$$;

create or replace function public.v1_tenant_marketplace_action(
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
  v_product_key text;
  v_idempotency_key text;
begin
  if p_action = 'create_order'
     and lower(pg_catalog.btrim(coalesce(p_payload ->> 'itemType',''))) = 'service' then
    return public.v2_tenant_service_marketplace_action(
      p_slug,
      'create_service_order',
      coalesce(p_payload,'{}'::jsonb) - 'itemType'
    );
  end if;
  if p_action = 'create_order'
     and lower(pg_catalog.btrim(coalesce(p_payload ->> 'itemType',''))) = 'addon' then
    select tenant.* into v_tenant
    from core.tenants tenant
    where tenant.slug = p_slug
    limit 1;
    if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
    if not private_app.has_tenant_permission(
      v_tenant.id,'tenant.settings.manage'
    ) then raise exception 'forbidden'; end if;
    v_idempotency_key := left(nullif(
      pg_catalog.btrim(p_payload ->> 'idempotencyKey'),''
    ),120);
    if v_idempotency_key is not null
       and exists(
         select 1
         from marketplace.orders orders
         where orders.tenant_id = v_tenant.id
           and orders.idempotency_key = v_idempotency_key
       ) then
      return private_app.v1_tenant_marketplace_action_service_legacy(
        p_slug,p_action,p_payload
      );
    end if;
    v_product_key := lower(nullif(
      pg_catalog.btrim(p_payload ->> 'productKey'),''
    ));
    if not exists(
      select 1
      from catalog.addon_products product
      where product.product_key = v_product_key
        and product.is_marketplace_visible
        and product.status in ('beta','active')
        and product.pricing_mode = 'fixed'
        and product.amount_minor > 0
    ) then raise exception 'marketplace_product_not_found'; end if;
  end if;
  return private_app.v1_tenant_marketplace_action_service_legacy(
    p_slug,p_action,p_payload
  );
end;
$$;

create or replace function private_app.sync_service_assignment_order_status_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.order_kind <> 'service' or new.status is not distinct from old.status then return new; end if;
  update marketplace.service_order_assignments set
    status = case
      when new.status in ('cancelled','refunded') then 'cancelled'
      when new.status = 'in_progress' then 'in_progress'
      when new.status = 'completed' then 'completed'
      else status
    end,
    started_at = case when new.status = 'in_progress' then coalesce(started_at,pg_catalog.clock_timestamp()) else started_at end,
    completed_at = case when new.status = 'completed' then coalesce(completed_at,pg_catalog.clock_timestamp()) else completed_at end,
    updated_at = pg_catalog.clock_timestamp()
  where order_id = new.id;
  return new;
end;
$$;

do $trigger$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'marketplace.orders'::regclass
      and trigger.tgname = 'sync_service_assignment_order_status_v1'
      and not trigger.tgisinternal
  ) then
    create trigger sync_service_assignment_order_status_v1
    after update of status on marketplace.orders
    for each row execute function private_app.sync_service_assignment_order_status_v1();
  end if;
end;
$trigger$;

revoke all on function private_app.service_provider_public_payload(uuid) from public, anon, authenticated;
revoke all on function private_app.sync_service_assignment_order_status_v1() from public, anon, authenticated;
revoke all on function public.v1_platform_service_marketplace_snapshot() from public, anon, authenticated;
revoke all on function public.v1_platform_service_marketplace_action(text,jsonb) from public, anon, authenticated;
revoke all on function public.v2_tenant_service_marketplace_snapshot(text) from public, anon, authenticated;
revoke all on function public.v2_tenant_service_marketplace_action(text,text,jsonb) from public, anon, authenticated;
revoke all on function public.v1_tenant_marketplace_snapshot(text) from public, anon, authenticated;
revoke all on function public.v1_tenant_marketplace_action(text,text,jsonb) from public, anon, authenticated;
revoke all on function private_app.v2_tenant_marketplace_snapshot_service_legacy(text) from public, anon, authenticated;
revoke all on function private_app.v2_tenant_marketplace_action_service_legacy(text,text,jsonb) from public, anon, authenticated;
revoke all on function private_app.v1_tenant_marketplace_snapshot_service_legacy(text) from public, anon, authenticated;
revoke all on function private_app.v1_tenant_marketplace_action_service_legacy(text,text,jsonb) from public, anon, authenticated;
revoke all on function public.v2_tenant_marketplace_snapshot(text) from public, anon, authenticated;
revoke all on function public.v2_tenant_marketplace_action(text,text,jsonb) from public, anon, authenticated;

grant execute on function public.v1_platform_service_marketplace_snapshot() to authenticated;
grant execute on function public.v1_platform_service_marketplace_action(text,jsonb) to authenticated;
grant execute on function public.v2_tenant_service_marketplace_snapshot(text) to authenticated;
grant execute on function public.v2_tenant_service_marketplace_action(text,text,jsonb) to authenticated;
grant execute on function public.v2_tenant_marketplace_snapshot(text) to authenticated;
grant execute on function public.v2_tenant_marketplace_action(text,text,jsonb) to authenticated;
grant execute on function public.v1_tenant_marketplace_snapshot(text) to authenticated;
grant execute on function public.v1_tenant_marketplace_action(text,text,jsonb) to authenticated;

commit;
