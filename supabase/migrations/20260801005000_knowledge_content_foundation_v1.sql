-- Portable Knowledge content foundation for clean environments.
begin;

create schema if not exists platform;

do $outer$
begin
  if to_regprocedure('platform.is_platform_content_admin()') is null then
    execute $function$
      create function platform.is_platform_content_admin()
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select auth.uid() is not null
          and private_app.has_platform_permission('platform.control.write')
      $body$
    $function$;
  end if;
end;
$outer$;

revoke all on function platform.is_platform_content_admin()
from public, anon;
grant execute on function platform.is_platform_content_admin()
to authenticated;

create table if not exists public.knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_url text,
  source_type text not null default 'manual'
    constraint knowledge_sources_source_type_check
    check (source_type in ('manual','rss','api','scraper','ai')),
  is_active boolean not null default true,
  requires_review boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  excerpt text,
  content text,
  cover_image_url text,
  category_id uuid
    references public.knowledge_categories(id) on delete set null,
  content_type text not null default 'news'
    constraint knowledge_posts_content_type_check
    check (content_type in (
      'news','tender','article','success_story','regulation'
    )),
  status text not null default 'draft'
    constraint knowledge_posts_status_check
    check (status in (
      'imported','review','approved','scheduled','published','archived'
    )),
  source_id uuid
    references public.knowledge_sources(id) on delete set null,
  source_name text,
  source_url text,
  is_featured boolean not null default false,
  is_breaking boolean not null default false,
  published_at timestamptz,
  expires_at timestamptz,
  tags text[] not null default '{}'::text[],
  target_roles text[] not null default '{}'::text[],
  target_tenants text[] not null default '{}'::text[],
  tender_authority text,
  tender_number text,
  tender_deadline timestamptz,
  tender_region text,
  tender_value numeric,
  tender_status text,
  created_by uuid,
  reviewed_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_categories_order_idx
on public.knowledge_categories(is_active, sort_order, name);

create index if not exists knowledge_posts_public_feed_idx
on public.knowledge_posts(
  status,
  is_featured desc,
  published_at desc,
  created_at desc
);

create index if not exists knowledge_posts_category_idx
on public.knowledge_posts(category_id, status, published_at desc);

create index if not exists knowledge_posts_source_idx
on public.knowledge_posts(source_id, created_at desc);

drop trigger if exists knowledge_posts_set_updated_at
on public.knowledge_posts;
create trigger knowledge_posts_set_updated_at
before update on public.knowledge_posts
for each row execute function private_app.set_updated_at();

alter table public.knowledge_categories enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.knowledge_posts enable row level security;

drop policy if exists "public reads active knowledge categories"
on public.knowledge_categories;
create policy "public reads active knowledge categories"
on public.knowledge_categories
for select to anon, authenticated
using (is_active);

drop policy if exists "public reads published knowledge posts"
on public.knowledge_posts;
create policy "public reads published knowledge posts"
on public.knowledge_posts
for select to anon, authenticated
using (
  status = 'published'
  and (published_at is null or published_at <= now())
  and (expires_at is null or expires_at > now())
);

drop policy if exists "platform admins manage knowledge categories"
on public.knowledge_categories;
create policy "platform admins manage knowledge categories"
on public.knowledge_categories
for all to authenticated
using (platform.is_platform_content_admin())
with check (platform.is_platform_content_admin());

drop policy if exists "platform admins manage knowledge sources"
on public.knowledge_sources;
create policy "platform admins manage knowledge sources"
on public.knowledge_sources
for all to authenticated
using (platform.is_platform_content_admin())
with check (platform.is_platform_content_admin());

drop policy if exists "platform admins manage knowledge posts"
on public.knowledge_posts;
create policy "platform admins manage knowledge posts"
on public.knowledge_posts
for all to authenticated
using (platform.is_platform_content_admin())
with check (platform.is_platform_content_admin());

revoke all on public.knowledge_categories
from public, anon, authenticated;
revoke all on public.knowledge_sources
from public, anon, authenticated;
revoke all on public.knowledge_posts
from public, anon, authenticated;

grant select on public.knowledge_categories
to anon, authenticated;
grant select on public.knowledge_posts
to anon, authenticated;
grant insert, update, delete
on public.knowledge_categories
to authenticated;
grant select, insert, update, delete
on public.knowledge_sources
to authenticated;
grant insert, update, delete
on public.knowledge_posts
to authenticated;
grant select, insert, update, delete
on public.knowledge_categories, public.knowledge_sources, public.knowledge_posts
to service_role;

insert into public.knowledge_categories(
  name,
  slug,
  description,
  sort_order,
  is_active
)
values
  (
    'أخبار قطاع التدريب',
    'training-news',
    'أخبار الجهات التنظيمية والمراكز والمعاهد والشراكات والبرامج.',
    10,
    true
  ),
  (
    'المنافسات والفرص',
    'tenders-opportunities',
    'طلبات العروض ودعوات التأهيل والمشروعات المرتبطة بالتدريب والتعليم.',
    20,
    true
  ),
  (
    'مقالات معرفية',
    'knowledge-articles',
    'أدلة ومقالات عملية تساعد على تشغيل وتسويق وإدارة مراكز التدريب.',
    30,
    true
  ),
  (
    'قصص وتجارب ملهمة',
    'success-stories',
    'تجارب ودراسات حالة وقصص نجاح من قطاع التدريب.',
    40,
    true
  ),
  (
    'تنبيهات وتشريعات',
    'alerts-regulations',
    'التحديثات التنظيمية والتنبيهات التي قد تؤثر على تشغيل المنشآت.',
    50,
    true
  ),
  (
    'فعاليات ومبادرات',
    'events-initiatives',
    'المؤتمرات والملتقيات والبرامج والمبادرات الداعمة للقطاع.',
    60,
    true
  ),
  (
    'نبض السوق',
    'market-pulse',
    'إشارات واتجاهات تساعد مراكز التدريب على اتخاذ قرارات أفضل.',
    70,
    true
  )
on conflict (slug) do update
set
  name = excluded.name,
  description = coalesce(
    public.knowledge_categories.description,
    excluded.description
  ),
  sort_order = excluded.sort_order,
  is_active = true;

commit;
