-- Knowledge Intelligence Hub policy, index, and source hardening.
begin;

-- Avoid overlapping permissive SELECT policies while preserving public reads
-- and unrestricted platform-editor access to draft content.
drop policy if exists "public reads active knowledge categories"
on public.knowledge_categories;
drop policy if exists "platform admins manage knowledge categories"
on public.knowledge_categories;
drop policy if exists "anonymous reads active knowledge categories"
on public.knowledge_categories;
drop policy if exists "authenticated reads visible knowledge categories"
on public.knowledge_categories;
drop policy if exists "platform admins insert knowledge categories"
on public.knowledge_categories;
drop policy if exists "platform admins update knowledge categories"
on public.knowledge_categories;
drop policy if exists "platform admins delete knowledge categories"
on public.knowledge_categories;

create policy "anonymous reads active knowledge categories"
on public.knowledge_categories
for select to anon
using (is_active);

create policy "authenticated reads visible knowledge categories"
on public.knowledge_categories
for select to authenticated
using (
  is_active
  or platform.is_platform_content_admin()
);

create policy "platform admins insert knowledge categories"
on public.knowledge_categories
for insert to authenticated
with check (platform.is_platform_content_admin());

create policy "platform admins update knowledge categories"
on public.knowledge_categories
for update to authenticated
using (platform.is_platform_content_admin())
with check (platform.is_platform_content_admin());

create policy "platform admins delete knowledge categories"
on public.knowledge_categories
for delete to authenticated
using (platform.is_platform_content_admin());

drop policy if exists "public reads published knowledge posts"
on public.knowledge_posts;
drop policy if exists "platform admins manage knowledge posts"
on public.knowledge_posts;
drop policy if exists "anonymous reads published knowledge posts"
on public.knowledge_posts;
drop policy if exists "authenticated reads visible knowledge posts"
on public.knowledge_posts;
drop policy if exists "platform admins insert knowledge posts"
on public.knowledge_posts;
drop policy if exists "platform admins update knowledge posts"
on public.knowledge_posts;
drop policy if exists "platform admins delete knowledge posts"
on public.knowledge_posts;

create policy "anonymous reads published knowledge posts"
on public.knowledge_posts
for select to anon
using (
  status = 'published'
  and (published_at is null or published_at <= now())
  and (expires_at is null or expires_at > now())
);

create policy "authenticated reads visible knowledge posts"
on public.knowledge_posts
for select to authenticated
using (
  (
    status = 'published'
    and (published_at is null or published_at <= now())
    and (expires_at is null or expires_at > now())
  )
  or platform.is_platform_content_admin()
);

create policy "platform admins insert knowledge posts"
on public.knowledge_posts
for insert to authenticated
with check (platform.is_platform_content_admin());

create policy "platform admins update knowledge posts"
on public.knowledge_posts
for update to authenticated
using (platform.is_platform_content_admin())
with check (platform.is_platform_content_admin());

create policy "platform admins delete knowledge posts"
on public.knowledge_posts
for delete to authenticated
using (platform.is_platform_content_admin());

-- Use init-plan-safe auth lookups on high-frequency tenant interaction tables.
drop policy if exists "tenant users read own knowledge bookmarks"
on public.knowledge_bookmarks;
create policy "tenant users read own knowledge bookmarks"
on public.knowledge_bookmarks
for select to authenticated
using (
  auth_user_id = (select auth.uid())
  and private_app.has_tenant_permission(
    tenant_id,
    'tenant.content.read'
  )
);

drop policy if exists "tenant users save own knowledge bookmarks"
on public.knowledge_bookmarks;
create policy "tenant users save own knowledge bookmarks"
on public.knowledge_bookmarks
for insert to authenticated
with check (
  auth_user_id = (select auth.uid())
  and private_app.has_tenant_permission(
    tenant_id,
    'tenant.content.read'
  )
);

drop policy if exists "tenant users remove own knowledge bookmarks"
on public.knowledge_bookmarks;
create policy "tenant users remove own knowledge bookmarks"
on public.knowledge_bookmarks
for delete to authenticated
using (
  auth_user_id = (select auth.uid())
  and private_app.has_tenant_permission(
    tenant_id,
    'tenant.content.read'
  )
);

drop policy if exists "tenant users record own knowledge reads"
on public.knowledge_read_events;
create policy "tenant users record own knowledge reads"
on public.knowledge_read_events
for insert to authenticated
with check (
  auth_user_id = (select auth.uid())
  and private_app.has_tenant_permission(
    tenant_id,
    'tenant.content.read'
  )
);

-- Cover new foreign-key access paths used by cleanup and reporting.
create index if not exists knowledge_sources_default_category_idx
on public.knowledge_sources(default_category_id)
where default_category_id is not null;

create index if not exists knowledge_raw_items_run_idx
on public.knowledge_raw_items(run_id)
where run_id is not null;

create index if not exists knowledge_raw_items_category_idx
on public.knowledge_raw_items(detected_category_id)
where detected_category_id is not null;

create index if not exists knowledge_bookmarks_post_idx
on public.knowledge_bookmarks(post_id);

create index if not exists knowledge_read_events_tenant_time_idx
on public.knowledge_read_events(tenant_id, occurred_at desc);

-- Use verified public listing pages and conservative path filters.
update public.knowledge_sources
set
  feed_url = 'https://www.hrsd.gov.sa/media-center/news',
  source_type = 'html',
  default_category_id = (
    select id
    from public.knowledge_categories
    where slug = 'training-news'
  ),
  default_content_type = 'news',
  parser_config = '{
    "maxItems": 12,
    "linkPattern": "^/media-center/news/[^/?#]+"
  }'::jsonb,
  next_sync_at = now(),
  last_status = 'never',
  last_error = null,
  updated_at = now()
where source_key = 'hrsd-official-rss';

update public.knowledge_sources
set
  feed_url = 'https://nelc.gov.sa/ar/media-center/news',
  parser_config = '{
    "maxItems": 12,
    "linkPattern": "^/(?:ar|en)/media-center/news/[^/?#]+"
  }'::jsonb,
  next_sync_at = now(),
  last_status = 'never',
  last_error = null,
  updated_at = now()
where source_key = 'nelc-official-news';

update public.knowledge_sources
set
  feed_url = 'https://www.monshaat.gov.sa/ar',
  parser_config = '{
    "maxItems": 12,
    "linkPattern": "^/ar/node/[0-9]+$"
  }'::jsonb,
  next_sync_at = now(),
  last_status = 'never',
  last_error = null,
  updated_at = now()
where source_key = 'monshaat-official-news';

commit;
