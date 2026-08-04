begin;

-- One shared CMS data model for Marktone and every paid tenant website.
alter table website.sites
  add column if not exists tenant_id uuid references core.tenants(id) on delete cascade,
  add column if not exists site_scope text not null default 'platform',
  add column if not exists site_slug text,
  add column if not exists primary_domain text,
  add column if not exists locale text not null default 'ar-SA',
  add column if not exists cms_version integer not null default 2,
  add column if not exists addon_status text not null default 'active';

alter table website.sites drop constraint if exists sites_site_scope_check;
alter table website.sites add constraint sites_site_scope_check check (site_scope in ('platform','tenant'));
alter table website.sites drop constraint if exists sites_addon_status_check;
alter table website.sites add constraint sites_addon_status_check check (addon_status in ('active','trial','suspended','cancelled'));
alter table website.sites drop constraint if exists sites_scope_tenant_check;
alter table website.sites add constraint sites_scope_tenant_check check (
  (site_scope='platform' and tenant_id is null)
  or (site_scope='tenant' and tenant_id is not null)
);
update website.sites set site_scope='platform',site_slug=coalesce(site_slug,'marktone') where site_key='marktone-main';
create unique index if not exists website_sites_tenant_unique_idx on website.sites(tenant_id) where site_scope='tenant' and addon_status<>'cancelled';
create index if not exists website_sites_scope_status_idx on website.sites(site_scope,addon_status,status);

alter table website.pages
  add column if not exists page_kind text not null default 'standard',
  add column if not exists parent_page_id uuid references website.pages(id) on delete set null,
  add column if not exists sort_order integer not null default 100,
  add column if not exists is_home boolean not null default false,
  add column if not exists visibility text not null default 'public',
  add column if not exists layout_settings jsonb not null default '{}'::jsonb,
  add column if not exists canonical_url text,
  add column if not exists robots text not null default 'index,follow';
alter table website.pages drop constraint if exists pages_page_kind_check;
alter table website.pages add constraint pages_page_kind_check check (page_kind in ('home','standard','landing','legal','system'));
alter table website.pages drop constraint if exists pages_visibility_check;
alter table website.pages add constraint pages_visibility_check check (visibility in ('public','unlisted','members'));
create unique index if not exists website_pages_one_home_idx on website.pages(site_id) where is_home and status<>'archived';
create index if not exists website_pages_tree_idx on website.pages(site_id,parent_page_id,sort_order,status);

alter table website.articles
  add column if not exists content jsonb not null default '{}'::jsonb,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists reading_minutes integer,
  add column if not exists canonical_url text,
  add column if not exists robots text not null default 'index,follow',
  add column if not exists scheduled_at timestamptz,
  add column if not exists visibility text not null default 'public';
alter table website.articles drop constraint if exists articles_visibility_check;
alter table website.articles add constraint articles_visibility_check check (visibility in ('public','unlisted','members'));
alter table website.articles drop constraint if exists articles_reading_minutes_check;
alter table website.articles add constraint articles_reading_minutes_check check (reading_minutes is null or reading_minutes between 1 and 240);
create index if not exists website_articles_taxonomy_idx on website.articles(site_id,category,status,published_at desc);
create index if not exists website_articles_tags_gin_idx on website.articles using gin(tags);

create table if not exists website.menus (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  menu_key text not null,
  name text not null,
  location text not null default 'custom' check (location in ('header','footer','mobile','custom')),
  description text,
  settings jsonb not null default '{}'::jsonb,
  status text not null default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id,menu_key)
);

alter table website.menu_items
  add column if not exists menu_id uuid references website.menus(id) on delete cascade,
  add column if not exists parent_id uuid references website.menu_items(id) on delete cascade,
  add column if not exists target_page_id uuid references website.pages(id) on delete set null,
  add column if not exists target_article_id uuid references website.articles(id) on delete set null,
  add column if not exists description text,
  add column if not exists icon text,
  add column if not exists badge text,
  add column if not exists image_url text,
  add column if not exists column_index smallint not null default 1,
  add column if not exists is_mega boolean not null default false,
  add column if not exists mega_settings jsonb not null default '{}'::jsonb,
  add column if not exists mobile_label text,
  add column if not exists css_class text;
alter table website.menu_items drop constraint if exists menu_items_item_kind_check;
alter table website.menu_items add constraint menu_items_item_kind_check check (item_kind in ('anchor','page','article','external','system','group'));
alter table website.menu_items drop constraint if exists menu_items_column_index_check;
alter table website.menu_items add constraint menu_items_column_index_check check (column_index between 1 and 6);
alter table website.menu_items drop constraint if exists menu_items_not_self_parent_check;
alter table website.menu_items add constraint menu_items_not_self_parent_check check (parent_id is null or parent_id<>id);
create index if not exists website_menu_items_menu_tree_idx on website.menu_items(menu_id,parent_id,column_index,sort_order,status);

create table if not exists website.content_documents (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  entity_type text not null check (entity_type in ('page','article')),
  entity_id uuid not null,
  schema_version integer not null default 1 check (schema_version=1),
  draft_document jsonb not null default jsonb_build_object(
    'schemaVersion',1,'settings',jsonb_build_object('contentWidth','wide','background','#ffffff'),'blocks','[]'::jsonb
  ),
  published_document jsonb,
  draft_updated_at timestamptz not null default now(),
  published_at timestamptz,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  published_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id,entity_type,entity_id)
);
create table if not exists website.content_document_versions (
  id uuid primary key default gen_random_uuid(),
  content_document_id uuid not null references website.content_documents(id) on delete cascade,
  version_number integer not null,
  version_kind text not null default 'draft' check (version_kind in ('draft','published','restored')),
  document jsonb not null,
  note text,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(content_document_id,version_number)
);
create index if not exists website_content_documents_entity_idx on website.content_documents(site_id,entity_type,entity_id);
create index if not exists website_content_document_versions_history_idx on website.content_document_versions(content_document_id,version_number desc);

create table if not exists website.assets (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  bucket_id text not null default 'cms-assets',
  object_path text not null,
  public_url text not null,
  file_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/gif','image/svg+xml','image/avif')),
  size_bytes bigint not null default 0 check (size_bytes between 0 and 8388608),
  width integer,
  height integer,
  alt_text text,
  caption text,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','archived')),
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bucket_id,object_path)
);
create index if not exists website_assets_site_date_idx on website.assets(site_id,status,created_at desc);

create table if not exists website.article_categories (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  parent_id uuid references website.article_categories(id) on delete set null,
  name text not null,
  slug text not null,
  description text,
  sort_order integer not null default 100,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id,slug)
);

-- Touch timestamps and close all direct table access.
do $$ declare v_table text; begin
  foreach v_table in array array['menus','content_documents','assets','article_categories'] loop
    execute format('drop trigger if exists website_touch_updated_at on website.%I',v_table);
    execute format('create trigger website_touch_updated_at before update on website.%I for each row execute function private_app.website_touch_updated_at()',v_table);
  end loop;
end $$;
alter table website.menus enable row level security;
alter table website.content_documents enable row level security;
alter table website.content_document_versions enable row level security;
alter table website.assets enable row level security;
alter table website.article_categories enable row level security;
revoke all on table website.menus from public,anon,authenticated;
revoke all on table website.content_documents from public,anon,authenticated;
revoke all on table website.content_document_versions from public,anon,authenticated;
revoke all on table website.assets from public,anon,authenticated;
revoke all on table website.article_categories from public,anon,authenticated;

-- Paid add-on catalogue and friendly permissions.
insert into core.modules(module_key,name_ar,name_en,description,enabled_by_default,status)
values('website_cms','الموقع ومنشئ الصفحات','Website & CMS','نظام إدارة محتوى احترافي ومصمم صفحات وقوائم ومقالات ووسائط',false,'active')
on conflict(module_key) do update set name_ar=excluded.name_ar,name_en=excluded.name_en,description=excluded.description,status='active';
insert into catalog.features(feature_key,name_ar,name_en,category,value_type,default_value,status)
values('module.website_cms','إضافة الموقع الاحترافي','Professional Website CMS','module','boolean','false'::jsonb,'active')
on conflict(feature_key) do update set name_ar=excluded.name_ar,name_en=excluded.name_en,category=excluded.category,value_type=excluded.value_type,status='active';
insert into access_control.permissions(permission_key,module_key,name_ar,description)
values
  ('tenant.website.read','website_cms','عرض الموقع','عرض الصفحات والمقالات والقوائم ووسائط الموقع'),
  ('tenant.website.manage','website_cms','إدارة الموقع','إنشاء وتعديل الصفحات والمقالات والقوائم والوسائط'),
  ('tenant.website.publish','website_cms','نشر الموقع','نشر المسودات وتغيير الصفحة الرئيسية واستعادة الإصدارات')
on conflict(permission_key) do update set module_key=excluded.module_key,name_ar=excluded.name_ar,description=excluded.description;
insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role cross join access_control.permissions permission
where role.scope='tenant'
  and role.role_key in ('tenant_owner','tenant_admin','executive_manager')
  and permission.permission_key in ('tenant.website.read','tenant.website.manage','tenant.website.publish')
on conflict do nothing;
insert into catalog.plan_features(plan_id,feature_id,value)
select plan.id,feature.id,'true'::jsonb
from catalog.plans plan join catalog.features feature on feature.feature_key='module.website_cms'
where plan.plan_key='full'
on conflict(plan_id,feature_id) do update set value='true'::jsonb,updated_at=now();
insert into core.tenant_modules(tenant_id,module_id,enabled,enabled_at)
select subscription.tenant_id,module.id,true,now()
from catalog.subscriptions subscription
join catalog.plans plan on plan.id=subscription.plan_id and plan.plan_key='full'
join core.modules module on module.module_key='website_cms'
where subscription.status in ('trialing','active','past_due')
on conflict(tenant_id,module_id) do update set enabled=true,enabled_at=coalesce(core.tenant_modules.enabled_at,now()),updated_at=now();

create or replace function private_app.cms_module_enabled(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select tm.enabled from core.tenant_modules tm join core.modules m on m.id=tm.module_id where tm.tenant_id=p_tenant_id and m.module_key='website_cms' limit 1),false)
$$;
revoke all on function private_app.cms_module_enabled(uuid) from public,anon,authenticated;

create or replace function private_app.cms_access_subject(p_site_id uuid,p_permission text default 'manage')
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_site website.sites%rowtype; v_subject_id uuid; v_permission text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_site from website.sites where id=p_site_id limit 1;
  if v_site.id is null then raise exception 'cms_site_not_found'; end if;
  select subject.id into v_subject_id from access_control.subjects subject
  where subject.auth_user_id=auth.uid() and subject.status='active' and not subject.must_change_password limit 1;
  if v_subject_id is null then raise exception 'account_not_linked'; end if;
  if v_site.site_scope='platform' then
    if not private_app.has_platform_permission('platform.website.manage') then raise exception 'forbidden'; end if;
    return v_subject_id;
  end if;
  if not private_app.cms_module_enabled(v_site.tenant_id) then raise exception 'cms_addon_required'; end if;
  v_permission:=case lower(coalesce(p_permission,'manage')) when 'read' then 'tenant.website.read' when 'publish' then 'tenant.website.publish' else 'tenant.website.manage' end;
  if not private_app.has_tenant_permission(v_site.tenant_id,v_permission) then raise exception 'forbidden'; end if;
  return v_subject_id;
end $$;
revoke all on function private_app.cms_access_subject(uuid,text) from public,anon,authenticated;

create or replace function private_app.cms_resolve_site(
  p_site_key text default 'marktone-main',p_tenant_slug text default null,
  p_permission text default 'manage',p_create boolean default true
)
returns website.sites language plpgsql security definer set search_path='' as $$
declare v_site website.sites%rowtype; v_tenant core.tenants%rowtype;
begin
  if nullif(trim(coalesce(p_tenant_slug,'')),'') is null then
    select * into v_site from website.sites where site_key=coalesce(nullif(trim(p_site_key),''),'marktone-main') and site_scope='platform' limit 1;
    if v_site.id is null then raise exception 'cms_site_not_found'; end if;
    perform private_app.cms_access_subject(v_site.id,p_permission); return v_site;
  end if;
  select * into v_tenant from core.tenants where slug=lower(trim(p_tenant_slug)) limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.cms_module_enabled(v_tenant.id) then raise exception 'cms_addon_required'; end if;
  select * into v_site from website.sites where tenant_id=v_tenant.id and site_scope='tenant' and addon_status<>'cancelled' limit 1;
  if v_site.id is null and p_create then
    insert into website.sites(tenant_id,site_scope,site_key,site_slug,name_ar,name_en,status,settings,theme,locale,cms_version,addon_status)
    values(v_tenant.id,'tenant','tenant:'||v_tenant.slug,v_tenant.slug,v_tenant.name,null,'draft',
      jsonb_build_object('siteTitle',v_tenant.name,'description','الموقع الرسمي لـ '||v_tenant.name,'customerLoginLabel','دخول العملاء','customerLoginUrl','/login','contactCtaLabel','تواصل معنا','contactCtaUrl','#contact','footerText',v_tenant.name),
      jsonb_build_object('navy','#06182e','navySoft','#0b2949','gold','#e6b34e','paper','#f7f2e8','white','#ffffff'),
      coalesce(v_tenant.default_locale,'ar-SA'),2,'active') returning * into v_site;
  end if;
  if v_site.id is null then raise exception 'cms_site_not_found'; end if;
  perform private_app.cms_access_subject(v_site.id,p_permission); return v_site;
end $$;
revoke all on function private_app.cms_resolve_site(text,text,text,boolean) from public,anon,authenticated;

commit;
