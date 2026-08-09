begin;

create table if not exists website.template_packages (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references website.sites(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'staging' check (status in ('staging','processing','ready','failed')),
  staging_bucket text not null default 'cms-template-staging',
  staging_path text not null unique,
  asset_bucket text not null default 'cms-template-assets',
  entry_path text,
  manifest jsonb not null default '[]'::jsonb check (jsonb_typeof(manifest)='array'),
  file_count integer not null default 0 check (file_count between 0 and 250),
  total_bytes bigint not null default 0 check (total_bytes between 0 and 67108864),
  checksum text,
  error_message text,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists website_template_packages_site_created_idx
  on website.template_packages(site_id,created_at desc);
create index if not exists website_template_packages_site_status_idx
  on website.template_packages(site_id,status);

alter table website.template_packages enable row level security;
revoke all on table website.template_packages from anon,authenticated;

create or replace function public.v3_cms_storage_can_write(p_name text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare
  v_site website.sites%rowtype;
  v_site_id uuid;
begin
  if auth.uid() is null then return false; end if;
  begin
    v_site_id:=((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return false;
  end;
  select * into v_site from website.sites where id=v_site_id limit 1;
  if v_site.id is null then return false; end if;
  if v_site.site_scope='platform' then
    return private_app.has_platform_permission('platform.website.manage');
  end if;
  return private_app.cms_module_enabled(v_site.tenant_id)
    and private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.manage');
end $$;
revoke all on function public.v3_cms_storage_can_write(text) from public,anon;
grant execute on function public.v3_cms_storage_can_write(text) to authenticated;

-- Version the image bucket and its write boundary as well; runtime routes already depend on it.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values (
  'cms-assets','cms-assets',true,8388608,
  array['image/jpeg','image/png','image/webp','image/gif','image/svg+xml','image/avif']::text[]
)
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists cms_assets_insert on storage.objects;
create policy cms_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id='cms-assets' and public.v3_cms_storage_can_write(name));
drop policy if exists cms_assets_update on storage.objects;
create policy cms_assets_update on storage.objects for update to authenticated
  using (bucket_id='cms-assets' and public.v3_cms_storage_can_write(name))
  with check (bucket_id='cms-assets' and public.v3_cms_storage_can_write(name));
drop policy if exists cms_assets_delete on storage.objects;
create policy cms_assets_delete on storage.objects for delete to authenticated
  using (bucket_id='cms-assets' and public.v3_cms_storage_can_write(name));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values (
  'cms-template-staging','cms-template-staging',false,20971520,
  array['application/zip','application/x-zip-compressed']::text[]
)
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values (
  'cms-template-assets','cms-template-assets',true,20971520,
  array[
    'text/html','text/css','text/javascript','application/javascript','application/json','text/plain',
    'image/jpeg','image/png','image/gif','image/webp','image/avif','image/svg+xml','image/x-icon',
    'video/mp4','video/webm','video/ogg','audio/mpeg','audio/wav','audio/ogg','audio/mp4',
    'font/woff','font/woff2','font/ttf','font/otf','application/octet-stream'
  ]::text[]
)
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists cms_template_staging_insert on storage.objects;
create policy cms_template_staging_insert on storage.objects for insert to authenticated
  with check (bucket_id='cms-template-staging' and public.v3_cms_storage_can_write(name));
drop policy if exists cms_template_staging_select on storage.objects;
create policy cms_template_staging_select on storage.objects for select to authenticated
  using (bucket_id='cms-template-staging' and public.v3_cms_storage_can_write(name));
drop policy if exists cms_template_staging_delete on storage.objects;
create policy cms_template_staging_delete on storage.objects for delete to authenticated
  using (bucket_id='cms-template-staging' and public.v3_cms_storage_can_write(name));

drop policy if exists cms_template_assets_insert on storage.objects;
create policy cms_template_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id='cms-template-assets' and public.v3_cms_storage_can_write(name));
drop policy if exists cms_template_assets_update on storage.objects;
create policy cms_template_assets_update on storage.objects for update to authenticated
  using (bucket_id='cms-template-assets' and public.v3_cms_storage_can_write(name))
  with check (bucket_id='cms-template-assets' and public.v3_cms_storage_can_write(name));
drop policy if exists cms_template_assets_delete on storage.objects;
create policy cms_template_assets_delete on storage.objects for delete to authenticated
  using (bucket_id='cms-template-assets' and public.v3_cms_storage_can_write(name));

create or replace function public.v3_cms_template_upload_ticket(
  p_site_key text default 'marktone-main',
  p_tenant_slug text default null,
  p_name text default 'قالب مستورد',
  p_mime_type text default 'application/zip',
  p_size_bytes bigint default 0
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_template_id uuid:=gen_random_uuid();
  v_name text:=left(trim(coalesce(p_name,'')),120);
  v_path text;
begin
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  if p_size_bytes<1 or p_size_bytes>20971520 then raise exception 'template_archive_too_large'; end if;
  if lower(coalesce(p_mime_type,'')) not in ('application/zip','application/x-zip-compressed') then
    raise exception 'template_archive_type_invalid';
  end if;
  if v_name='' then v_name:='قالب مستورد'; end if;
  v_path:=v_site.id::text||'/'||v_template_id::text||'/source.zip';
  insert into website.template_packages(
    id,site_id,name,staging_path,created_by_subject_id
  ) values (
    v_template_id,v_site.id,v_name,v_path,v_subject_id
  );
  return jsonb_build_object(
    'templateId',v_template_id,'siteId',v_site.id,
    'bucket','cms-template-staging','objectPath',v_path,
    'maxBytes',20971520,'expiresIn',7200
  );
end $$;
revoke all on function public.v3_cms_template_upload_ticket(text,text,text,text,bigint) from public,anon;
grant execute on function public.v3_cms_template_upload_ticket(text,text,text,text,bigint) to authenticated;

create or replace function public.v3_cms_template_import_action(
  p_template_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_package website.template_packages%rowtype;
  v_entry_path text;
  v_expected_entry text;
  v_manifest jsonb;
  v_file_count integer;
  v_total_bytes bigint;
  v_checksum text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_package from website.template_packages where id=p_template_id for update;
  if v_package.id is null then raise exception 'template_not_found'; end if;
  perform private_app.cms_access_subject(v_package.site_id,'manage');

  if p_action='start' then
    if v_package.status='processing' and v_package.updated_at>now()-interval '5 minutes' then
      raise exception 'template_import_busy';
    end if;
    if v_package.status not in ('staging','failed','processing') then raise exception 'template_state_invalid'; end if;
    update website.template_packages set status='processing',error_message=null,updated_at=now()
    where id=v_package.id returning * into v_package;
    return jsonb_build_object(
      'templateId',v_package.id,'siteId',v_package.site_id,'name',v_package.name,
      'stagingBucket',v_package.staging_bucket,'stagingPath',v_package.staging_path,
      'assetBucket',v_package.asset_bucket
    );
  end if;

  if p_action='complete' then
    if v_package.status<>'processing' then raise exception 'template_state_invalid'; end if;
    v_entry_path:=trim(coalesce(p_payload->>'entryPath',''));
    v_expected_entry:=v_package.site_id::text||'/'||v_package.id::text||'/r1/index.html';
    if v_entry_path<>v_expected_entry then raise exception 'template_entry_invalid'; end if;
    if coalesce(p_payload->>'fileCount','')!~'^[0-9]{1,3}$' then raise exception 'template_manifest_invalid'; end if;
    if coalesce(p_payload->>'totalBytes','')!~'^[0-9]{1,8}$' then raise exception 'template_manifest_invalid'; end if;
    v_file_count:=(p_payload->>'fileCount')::integer;
    v_total_bytes:=(p_payload->>'totalBytes')::bigint;
    v_manifest:=coalesce(p_payload->'manifest','[]'::jsonb);
    v_checksum:=nullif(left(trim(coalesce(p_payload->>'checksum','')),64),'');
    if v_file_count<1 or v_file_count>250 or v_total_bytes<1 or v_total_bytes>67108864 then
      raise exception 'template_manifest_invalid';
    end if;
    if jsonb_typeof(v_manifest)<>'array' or jsonb_array_length(v_manifest)<>v_file_count then
      raise exception 'template_manifest_invalid';
    end if;
    if v_checksum is not null and v_checksum!~'^[0-9a-f]{64}$' then raise exception 'template_checksum_invalid'; end if;
    update website.template_packages set
      status='ready',entry_path=v_entry_path,manifest=v_manifest,file_count=v_file_count,
      total_bytes=v_total_bytes,checksum=v_checksum,error_message=null,updated_at=now()
    where id=v_package.id returning * into v_package;
    return jsonb_build_object(
      'templateId',v_package.id,'siteId',v_package.site_id,'name',v_package.name,
      'status',v_package.status,'assetBucket',v_package.asset_bucket,
      'entryPath',v_package.entry_path,'fileCount',v_package.file_count,
      'totalBytes',v_package.total_bytes,'checksum',v_package.checksum
    );
  end if;

  if p_action='fail' then
    if v_package.status='ready' then raise exception 'template_state_invalid'; end if;
    update website.template_packages set
      status='failed',error_message=left(coalesce(p_payload->>'message','تعذر استيراد القالب'),400),updated_at=now()
    where id=v_package.id;
    return jsonb_build_object('templateId',v_package.id,'status','failed');
  end if;
  raise exception 'template_action_invalid';
end $$;
revoke all on function public.v3_cms_template_import_action(uuid,text,jsonb) from public,anon;
grant execute on function public.v3_cms_template_import_action(uuid,text,jsonb) to authenticated;

create or replace function public.v3_cms_template_catalog(
  p_site_key text default 'marktone-main',
  p_tenant_slug text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_site website.sites%rowtype;
  v_templates jsonb;
begin
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',false);
  perform private_app.cms_access_subject(v_site.id,'manage');
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',template_row.id,'name',template_row.name,'status',template_row.status,
    'assetBucket',template_row.asset_bucket,'entryPath',template_row.entry_path,
    'fileCount',template_row.file_count,'totalBytes',template_row.total_bytes,
    'checksum',template_row.checksum,'createdAt',template_row.created_at
  ) order by template_row.created_at desc),'[]'::jsonb)
  into v_templates
  from (
    select * from website.template_packages
    where site_id=v_site.id and status='ready'
    order by created_at desc limit 60
  ) template_row;
  return jsonb_build_object('siteId',v_site.id,'templates',v_templates);
end $$;
revoke all on function public.v3_cms_template_catalog(text,text) from public,anon;
grant execute on function public.v3_cms_template_catalog(text,text) to authenticated;

commit;
