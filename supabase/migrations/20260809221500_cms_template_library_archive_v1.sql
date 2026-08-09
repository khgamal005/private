begin;

alter table website.template_packages
  add column if not exists archived_at timestamptz;

alter table website.template_packages
  add column if not exists archived_by_subject_id uuid
  references access_control.subjects(id) on delete set null;

create index if not exists website_template_packages_site_active_created_idx
  on website.template_packages(site_id,created_at desc)
  where archived_at is null;

create or replace function public.v3_cms_template_archive(
  p_template_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_package website.template_packages%rowtype;
  v_subject_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  select * into v_package
  from website.template_packages
  where id=p_template_id
  for update;

  if v_package.id is null then raise exception 'template_not_found'; end if;
  v_subject_id:=private_app.cms_access_subject(v_package.site_id,'manage');

  if v_package.status='processing' and v_package.updated_at>now()-interval '5 minutes' then
    raise exception 'template_import_busy';
  end if;

  if v_package.archived_at is null then
    update website.template_packages
    set archived_at=now(),archived_by_subject_id=v_subject_id,updated_at=now()
    where id=v_package.id
    returning * into v_package;
  end if;

  return jsonb_build_object(
    'templateId',v_package.id,
    'siteId',v_package.site_id,
    'name',v_package.name,
    'archivedAt',v_package.archived_at,
    'assetsRetained',true
  );
end $$;
revoke all on function public.v3_cms_template_archive(uuid) from public,anon;
grant execute on function public.v3_cms_template_archive(uuid) to authenticated;

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
    where site_id=v_site.id and status='ready' and archived_at is null
    order by created_at desc limit 60
  ) template_row;

  return jsonb_build_object('siteId',v_site.id,'templates',v_templates);
end $$;
revoke all on function public.v3_cms_template_catalog(text,text) from public,anon;
grant execute on function public.v3_cms_template_catalog(text,text) to authenticated;

commit;
