-- Knowledge Intelligence Hub v1
begin;

alter table public.knowledge_sources
  drop constraint if exists knowledge_sources_source_type_check;

alter table public.knowledge_sources
  add constraint knowledge_sources_source_type_check
  check (source_type in (
    'manual','rss','atom','json','html','api','email','upload','ai'
  ));

alter table public.knowledge_sources
  add column if not exists source_key text,
  add column if not exists feed_url text,
  add column if not exists trust_level text not null default 'official',
  add column if not exists auto_publish boolean not null default false,
  add column if not exists sync_frequency text not null default 'daily',
  add column if not exists next_sync_at timestamptz,
  add column if not exists last_status text not null default 'never',
  add column if not exists last_error text,
  add column if not exists failure_count integer not null default 0,
  add column if not exists parser_config jsonb not null default '{}'::jsonb,
  add column if not exists include_keywords text[] not null default '{}'::text[],
  add column if not exists exclude_keywords text[] not null default '{}'::text[],
  add column if not exists default_category_id uuid
    references public.knowledge_categories(id) on delete set null,
  add column if not exists default_content_type text not null default 'news',
  add column if not exists default_tags text[] not null default '{}'::text[],
  add column if not exists last_item_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.knowledge_sources
set source_key = coalesce(
  nullif(trim(source_key), ''),
  'source-' || left(id::text, 8)
);

alter table public.knowledge_sources
  alter column source_key set not null;

alter table public.knowledge_sources
  drop constraint if exists knowledge_sources_trust_level_check,
  add constraint knowledge_sources_trust_level_check
    check (trust_level in ('official','trusted','editorial')),
  drop constraint if exists knowledge_sources_sync_frequency_check,
  add constraint knowledge_sources_sync_frequency_check
    check (sync_frequency in ('manual','hourly','daily','weekly')),
  drop constraint if exists knowledge_sources_last_status_check,
  add constraint knowledge_sources_last_status_check
    check (last_status in ('never','running','success','partial','error','paused')),
  drop constraint if exists knowledge_sources_default_content_type_check,
  add constraint knowledge_sources_default_content_type_check
    check (default_content_type in (
      'news','tender','article','success_story','regulation','event','market_pulse'
    )),
  drop constraint if exists knowledge_sources_failure_count_check,
  add constraint knowledge_sources_failure_count_check
    check (failure_count >= 0),
  drop constraint if exists knowledge_sources_parser_config_check,
  add constraint knowledge_sources_parser_config_check
    check (jsonb_typeof(parser_config) = 'object');

create unique index if not exists knowledge_sources_source_key_idx
on public.knowledge_sources(source_key);

alter table public.knowledge_posts
  drop constraint if exists knowledge_posts_content_type_check,
  drop constraint if exists knowledge_posts_status_check;

alter table public.knowledge_posts
  add constraint knowledge_posts_content_type_check
  check (content_type in (
    'news','tender','article','success_story','regulation','event','market_pulse'
  )),
  add constraint knowledge_posts_status_check
  check (status in (
    'draft','imported','review','approved','scheduled',
    'published','archived','rejected'
  ));

alter table public.knowledge_posts
  add column if not exists canonical_url text,
  add column if not exists external_id text,
  add column if not exists source_fingerprint text,
  add column if not exists trust_score smallint not null default 60,
  add column if not exists relevance_score smallint not null default 50,
  add column if not exists importance_level text not null default 'normal',
  add column if not exists why_it_matters text,
  add column if not exists recommended_action text,
  add column if not exists smart_summary text,
  add column if not exists extracted_entities jsonb not null default '{}'::jsonb,
  add column if not exists source_published_at timestamptz,
  add column if not exists last_verified_at timestamptz,
  add column if not exists is_automated boolean not null default false,
  add column if not exists review_notes text,
  add column if not exists event_starts_at timestamptz,
  add column if not exists event_ends_at timestamptz,
  add column if not exists event_location text,
  add column if not exists application_url text;

alter table public.knowledge_posts
  drop constraint if exists knowledge_posts_trust_score_check,
  add constraint knowledge_posts_trust_score_check
    check (trust_score between 0 and 100),
  drop constraint if exists knowledge_posts_relevance_score_check,
  add constraint knowledge_posts_relevance_score_check
    check (relevance_score between 0 and 100),
  drop constraint if exists knowledge_posts_importance_level_check,
  add constraint knowledge_posts_importance_level_check
    check (importance_level in ('low','normal','high','urgent')),
  drop constraint if exists knowledge_posts_extracted_entities_check,
  add constraint knowledge_posts_extracted_entities_check
    check (jsonb_typeof(extracted_entities) = 'object');

create index if not exists knowledge_posts_source_reference_idx
on public.knowledge_posts(source_id);

create index if not exists knowledge_posts_published_priority_idx
on public.knowledge_posts(
  status,
  is_breaking desc,
  relevance_score desc,
  published_at desc
);

create index if not exists knowledge_posts_source_fingerprint_idx
on public.knowledge_posts(source_id, source_fingerprint)
where source_id is not null and source_fingerprint is not null;

create table if not exists public.knowledge_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null
    references public.knowledge_sources(id) on delete cascade,
  trigger_type text not null
    check (trigger_type in ('scheduled','manual','retry')),
  status text not null default 'running'
    check (status in ('queued','running','success','partial','failed')),
  fetched_count integer not null default 0 check (fetched_count >= 0),
  new_count integer not null default 0 check (new_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  review_count integer not null default 0 check (review_count >= 0),
  published_count integer not null default 0 check (published_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  error_detail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_raw_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null
    references public.knowledge_sources(id) on delete cascade,
  run_id uuid
    references public.knowledge_ingestion_runs(id) on delete set null,
  external_id text,
  canonical_url text,
  title text not null,
  excerpt text,
  content text,
  cover_image_url text,
  source_published_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  detected_type text not null default 'news'
    check (detected_type in (
      'news','tender','article','success_story','regulation','event','market_pulse'
    )),
  detected_category_id uuid
    references public.knowledge_categories(id) on delete set null,
  trust_score smallint not null default 60
    check (trust_score between 0 and 100),
  relevance_score smallint not null default 50
    check (relevance_score between 0 and 100),
  why_it_matters text,
  recommended_action text,
  status text not null default 'new'
    check (status in (
      'new','duplicate','review','approved','rejected','published','error'
    )),
  post_id uuid
    references public.knowledge_posts(id) on delete set null,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, fingerprint)
);

create table if not exists public.knowledge_bookmarks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  auth_user_id uuid not null,
  post_id uuid not null
    references public.knowledge_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (tenant_id, auth_user_id, post_id)
);

create table if not exists public.knowledge_read_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  auth_user_id uuid not null,
  post_id uuid not null
    references public.knowledge_posts(id) on delete cascade,
  occurred_at timestamptz not null default now()
);

create index if not exists knowledge_ingestion_runs_source_time_idx
on public.knowledge_ingestion_runs(source_id, created_at desc);

create index if not exists knowledge_raw_items_review_idx
on public.knowledge_raw_items(status, created_at desc);

create index if not exists knowledge_raw_items_post_idx
on public.knowledge_raw_items(post_id)
where post_id is not null;

create index if not exists knowledge_bookmarks_user_idx
on public.knowledge_bookmarks(tenant_id, auth_user_id, created_at desc);

create index if not exists knowledge_read_events_post_time_idx
on public.knowledge_read_events(post_id, occurred_at desc);

drop trigger if exists knowledge_sources_set_updated_at
on public.knowledge_sources;
create trigger knowledge_sources_set_updated_at
before update on public.knowledge_sources
for each row execute function private_app.set_updated_at();

drop trigger if exists knowledge_raw_items_set_updated_at
on public.knowledge_raw_items;
create trigger knowledge_raw_items_set_updated_at
before update on public.knowledge_raw_items
for each row execute function private_app.set_updated_at();

alter table public.knowledge_ingestion_runs enable row level security;
alter table public.knowledge_raw_items enable row level security;
alter table public.knowledge_bookmarks enable row level security;
alter table public.knowledge_read_events enable row level security;

drop policy if exists "platform admins manage knowledge ingestion runs"
on public.knowledge_ingestion_runs;
create policy "platform admins manage knowledge ingestion runs"
on public.knowledge_ingestion_runs
for all to authenticated
using (platform.is_platform_content_admin())
with check (platform.is_platform_content_admin());

drop policy if exists "platform admins manage knowledge raw items"
on public.knowledge_raw_items;
create policy "platform admins manage knowledge raw items"
on public.knowledge_raw_items
for all to authenticated
using (platform.is_platform_content_admin())
with check (platform.is_platform_content_admin());

drop policy if exists "tenant users read own knowledge bookmarks"
on public.knowledge_bookmarks;
create policy "tenant users read own knowledge bookmarks"
on public.knowledge_bookmarks
for select to authenticated
using (
  auth_user_id = auth.uid()
  and private_app.has_tenant_permission(tenant_id, 'tenant.content.read')
);

drop policy if exists "tenant users save own knowledge bookmarks"
on public.knowledge_bookmarks;
create policy "tenant users save own knowledge bookmarks"
on public.knowledge_bookmarks
for insert to authenticated
with check (
  auth_user_id = auth.uid()
  and private_app.has_tenant_permission(tenant_id, 'tenant.content.read')
);

drop policy if exists "tenant users remove own knowledge bookmarks"
on public.knowledge_bookmarks;
create policy "tenant users remove own knowledge bookmarks"
on public.knowledge_bookmarks
for delete to authenticated
using (
  auth_user_id = auth.uid()
  and private_app.has_tenant_permission(tenant_id, 'tenant.content.read')
);

drop policy if exists "tenant users record own knowledge reads"
on public.knowledge_read_events;
create policy "tenant users record own knowledge reads"
on public.knowledge_read_events
for insert to authenticated
with check (
  auth_user_id = auth.uid()
  and private_app.has_tenant_permission(tenant_id, 'tenant.content.read')
);

revoke all on public.knowledge_ingestion_runs
from public, anon;
revoke all on public.knowledge_raw_items
from public, anon;
revoke all on public.knowledge_bookmarks
from public, anon;
revoke all on public.knowledge_read_events
from public, anon;

grant select, insert, update, delete
on public.knowledge_ingestion_runs
to authenticated, service_role;
grant select, insert, update, delete
on public.knowledge_raw_items
to authenticated, service_role;
grant select, insert, delete
on public.knowledge_bookmarks
to authenticated, service_role;
grant insert
on public.knowledge_read_events
to authenticated;
grant select, insert, update, delete
on public.knowledge_read_events
to service_role;
grant usage, select
on sequence public.knowledge_read_events_id_seq
to authenticated, service_role;

create or replace function public.v2_tenant_knowledge_snapshot(
  p_slug text,
  p_search text default null,
  p_category uuid default null,
  p_content_type text default null,
  p_only_saved boolean default false,
  p_limit integer default 60,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_limit integer := greatest(1, least(coalesce(p_limit, 60), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_posts jsonb;
  v_categories jsonb;
  v_stats jsonb;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
    and tenant.status = 'active';

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if auth.uid() is null or not (
    private_app.has_platform_permission('platform.control.write')
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.content.read'
    )
  ) then
    raise exception 'forbidden';
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(category) order by category.sort_order, category.name),
    '[]'::jsonb
  )
  into v_categories
  from public.knowledge_categories category
  where category.is_active;

  select coalesce(jsonb_agg(item order by sort_breaking desc, sort_relevance desc, sort_featured desc, sort_time desc), '[]'::jsonb)
  into v_posts
  from (
    select
      to_jsonb(post)
      || jsonb_build_object(
        'knowledge_categories',
        case
          when category.id is null then null
          else jsonb_build_object(
            'id', category.id,
            'name', category.name,
            'slug', category.slug
          )
        end,
        'is_saved',
        exists (
          select 1
          from public.knowledge_bookmarks bookmark
          where bookmark.tenant_id = v_tenant_id
            and bookmark.auth_user_id = auth.uid()
            and bookmark.post_id = post.id
        )
      ) as item,
      post.is_breaking as sort_breaking,
      post.relevance_score as sort_relevance,
      post.is_featured as sort_featured,
      coalesce(
        post.source_published_at,
        post.published_at,
        post.created_at
      ) as sort_time
    from public.knowledge_posts post
    left join public.knowledge_categories category
      on category.id = post.category_id
    where post.status = 'published'
      and (
        post.published_at is null
        or post.published_at <= now()
      )
      and (
        post.expires_at is null
        or post.expires_at > now()
      )
      and (
        coalesce(cardinality(post.target_tenants), 0) = 0
        or p_slug = any(post.target_tenants)
      )
      and (
        p_category is null
        or post.category_id = p_category
      )
      and (
        nullif(trim(coalesce(p_content_type, '')), '') is null
        or post.content_type = p_content_type
      )
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or concat_ws(
          ' ',
          post.title,
          post.excerpt,
          post.smart_summary,
          post.why_it_matters,
          post.source_name,
          array_to_string(post.tags, ' ')
        ) ilike '%' || trim(p_search) || '%'
      )
      and (
        not coalesce(p_only_saved, false)
        or exists (
          select 1
          from public.knowledge_bookmarks bookmark
          where bookmark.tenant_id = v_tenant_id
            and bookmark.auth_user_id = auth.uid()
            and bookmark.post_id = post.id
        )
      )
    order by
      post.is_breaking desc,
      post.relevance_score desc,
      post.is_featured desc,
      coalesce(
        post.source_published_at,
        post.published_at,
        post.created_at
      ) desc
    limit v_limit
    offset v_offset
  ) ranked;

  select jsonb_build_object(
    'total',
    count(*) filter (
      where post.status = 'published'
        and (post.expires_at is null or post.expires_at > now())
    ),
    'activeTenders',
    count(*) filter (
      where post.status = 'published'
        and post.content_type = 'tender'
        and (
          post.tender_deadline is null
          or post.tender_deadline >= current_date
        )
    ),
    'closingSoon',
    count(*) filter (
      where post.status = 'published'
        and post.content_type = 'tender'
        and post.tender_deadline between current_date and current_date + 7
    ),
    'important',
    count(*) filter (
      where post.status = 'published'
        and (
          post.is_breaking
          or post.importance_level in ('high','urgent')
          or post.relevance_score >= 80
        )
    ),
    'saved',
    (
      select count(*)
      from public.knowledge_bookmarks bookmark
      where bookmark.tenant_id = v_tenant_id
        and bookmark.auth_user_id = auth.uid()
    ),
    'lastUpdatedAt',
    max(
      coalesce(
        post.last_verified_at,
        post.source_published_at,
        post.published_at,
        post.updated_at
      )
    ) filter (where post.status = 'published')
  )
  into v_stats
  from public.knowledge_posts post;

  return jsonb_build_object(
    'posts', v_posts,
    'categories', v_categories,
    'stats', coalesce(v_stats, '{}'::jsonb),
    'generatedAt', now()
  );
end;
$$;

revoke all on function public.v2_tenant_knowledge_snapshot(
  text, text, uuid, text, boolean, integer, integer
)
from public, anon;
grant execute on function public.v2_tenant_knowledge_snapshot(
  text, text, uuid, text, boolean, integer, integer
)
to authenticated;

create or replace function public.v2_tenant_knowledge_action(
  p_slug text,
  p_action text,
  p_post_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_saved boolean;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
    and tenant.status = 'active';

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if auth.uid() is null or not (
    private_app.has_platform_permission('platform.control.write')
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.content.read'
    )
  ) then
    raise exception 'forbidden';
  end if;

  if not exists (
    select 1
    from public.knowledge_posts post
    where post.id = p_post_id
      and post.status = 'published'
  ) then
    raise exception 'knowledge_post_not_found';
  end if;

  case p_action
    when 'save' then
      insert into public.knowledge_bookmarks(
        tenant_id,
        auth_user_id,
        post_id
      )
      values (
        v_tenant_id,
        auth.uid(),
        p_post_id
      )
      on conflict (tenant_id, auth_user_id, post_id)
      do nothing;
    when 'unsave' then
      delete from public.knowledge_bookmarks bookmark
      where bookmark.tenant_id = v_tenant_id
        and bookmark.auth_user_id = auth.uid()
        and bookmark.post_id = p_post_id;
    when 'read' then
      insert into public.knowledge_read_events(
        tenant_id,
        auth_user_id,
        post_id
      )
      values (
        v_tenant_id,
        auth.uid(),
        p_post_id
      );
    else
      raise exception 'knowledge_action_not_supported';
  end case;

  select exists (
    select 1
    from public.knowledge_bookmarks bookmark
    where bookmark.tenant_id = v_tenant_id
      and bookmark.auth_user_id = auth.uid()
      and bookmark.post_id = p_post_id
  )
  into v_saved;

  return jsonb_build_object(
    'ok', true,
    'saved', v_saved
  );
end;
$$;

revoke all on function public.v2_tenant_knowledge_action(
  text, text, uuid
)
from public, anon;
grant execute on function public.v2_tenant_knowledge_action(
  text, text, uuid
)
to authenticated;

create or replace function public.knowledge_ingestion_validate_secret(
  p_secret text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets secret
    where secret.name = 'knowledge_ingestion_secret'
      and secret.decrypted_secret = p_secret
  );
$$;

revoke all on function public.knowledge_ingestion_validate_secret(text)
from public, anon, authenticated;
grant execute on function public.knowledge_ingestion_validate_secret(text)
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
  description = excluded.description,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

insert into public.knowledge_sources(
  source_key,
  name,
  base_url,
  feed_url,
  source_type,
  trust_level,
  is_active,
  requires_review,
  auto_publish,
  sync_frequency,
  next_sync_at,
  parser_config,
  include_keywords,
  exclude_keywords,
  default_category_id,
  default_content_type,
  default_tags,
  last_status
)
values
  (
    'hrsd-official-rss',
    'وزارة الموارد البشرية والتنمية الاجتماعية',
    'https://www.hrsd.gov.sa',
    'https://www.hrsd.gov.sa/rss.xml',
    'rss',
    'official',
    true,
    true,
    false,
    'hourly',
    now(),
    '{"maxItems": 30}'::jsonb,
    array[
      'تدريب','مهارات','تعليم','توظيف','عمل',
      'موارد بشرية','شهادة مهنية','تطوير'
    ],
    array['وظائف داخلية'],
    (
      select id
      from public.knowledge_categories
      where slug = 'alerts-regulations'
    ),
    'regulation',
    array['وزارة الموارد البشرية','مصدر رسمي'],
    'never'
  ),
  (
    'nelc-official-news',
    'المركز الوطني للتعليم الإلكتروني',
    'https://nelc.gov.sa',
    'https://nelc.gov.sa',
    'html',
    'official',
    true,
    true,
    false,
    'daily',
    now(),
    '{
      "maxItems": 12,
      "linkPattern": "(?:/ar)?/(?:news|media-center/news)/"
    }'::jsonb,
    array[
      'تعليم إلكتروني','تدريب إلكتروني','اعتماد',
      'ترخيص','منصة','محتوى رقمي'
    ],
    '{}'::text[],
    (
      select id
      from public.knowledge_categories
      where slug = 'training-news'
    ),
    'news',
    array['التعليم الإلكتروني','مصدر رسمي'],
    'never'
  ),
  (
    'tvtc-official-news',
    'المؤسسة العامة للتدريب التقني والمهني',
    'https://tvtc.gov.sa',
    'https://tvtc.gov.sa/ar/MediaCenter/News/Pages/default.aspx',
    'html',
    'official',
    true,
    true,
    false,
    'daily',
    now(),
    '{
      "maxItems": 12,
      "linkPattern": "/ar/MediaCenter/News/Pages/[^/]+\\.aspx"
    }'::jsonb,
    array[
      'تدريب','معهد','مركز تدريب','اعتماد','برنامج',
      'مهارات','شراكة','توظيف'
    ],
    '{}'::text[],
    (
      select id
      from public.knowledge_categories
      where slug = 'training-news'
    ),
    'news',
    array['التدريب التقني والمهني','مصدر رسمي'],
    'never'
  ),
  (
    'monshaat-official-news',
    'منشآت',
    'https://www.monshaat.gov.sa',
    'https://www.monshaat.gov.sa/ar/news',
    'html',
    'official',
    true,
    true,
    false,
    'daily',
    now(),
    '{
      "maxItems": 10,
      "linkPattern": "/ar/node/\\d+"
    }'::jsonb,
    array[
      'تدريب','تعليم','مهارات','دعم','منشآت صغيرة',
      'تحول رقمي','موارد بشرية','فعالية'
    ],
    '{}'::text[],
    (
      select id
      from public.knowledge_categories
      where slug = 'events-initiatives'
    ),
    'event',
    array['منشآت','مبادرات','مصدر رسمي'],
    'never'
  ),
  (
    'etimad-competitions',
    'منصة اعتماد — المنافسات',
    'https://monafasat.etimad.sa',
    'https://monafasat.etimad.sa',
    'manual',
    'official',
    false,
    true,
    false,
    'manual',
    null,
    '{
      "note": "يُفعّل بعد اعتماد نقطة وصول مستقرة أو تكامل رسمي."
    }'::jsonb,
    array[
      'تدريب','تعليم إلكتروني','تطوير محتوى','موارد بشرية',
      'استشارات','مراكز اتصال','تحول رقمي'
    ],
    '{}'::text[],
    (
      select id
      from public.knowledge_categories
      where slug = 'tenders-opportunities'
    ),
    'tender',
    array['منافسات حكومية','اعتماد'],
    'paused'
  )
on conflict (source_key) do update
set
  name = excluded.name,
  base_url = excluded.base_url,
  feed_url = excluded.feed_url,
  source_type = excluded.source_type,
  trust_level = excluded.trust_level,
  requires_review = excluded.requires_review,
  auto_publish = excluded.auto_publish,
  sync_frequency = excluded.sync_frequency,
  parser_config = excluded.parser_config,
  include_keywords = excluded.include_keywords,
  exclude_keywords = excluded.exclude_keywords,
  default_category_id = excluded.default_category_id,
  default_content_type = excluded.default_content_type,
  default_tags = excluded.default_tags,
  updated_at = now();

do $$
begin
  if not exists (
    select 1
    from vault.secrets secret
    where secret.name = 'knowledge_ingestion_secret'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'knowledge_ingestion_secret',
      'Authorizes the scheduled Marktone Knowledge Intelligence ingestion.'
    );
  end if;
end;
$$;

do $$
declare
  v_job_id bigint;
begin
  select jobid
  into v_job_id
  from cron.job
  where jobname = 'marktone-knowledge-ingestion';

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'marktone-knowledge-ingestion',
    '*/30 * * * *',
    $job$
      select net.http_post(
        url :=
          'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
          || 'knowledge-ingest',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-marktone-knowledge-secret',
          (
            select secret.decrypted_secret
            from vault.decrypted_secrets secret
            where secret.name = 'knowledge_ingestion_secret'
          )
        ),
        body := jsonb_build_object(
          'trigger', 'scheduled',
          'requestedAt', now()
        ),
        timeout_milliseconds := 60000
      ) as request_id;
    $job$
  );
end;
$$;

commit;
