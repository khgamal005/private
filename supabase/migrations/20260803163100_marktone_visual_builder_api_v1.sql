begin;

create or replace function public.v2_platform_page_builder_snapshot(
  p_page_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject_id uuid;
  v_page website.pages%rowtype;
  v_site website.sites%rowtype;
  v_document website.page_documents%rowtype;
  v_empty jsonb:=jsonb_build_object(
    'schemaVersion',1,
    'settings',jsonb_build_object('contentWidth','wide','background','#ffffff'),
    'blocks','[]'::jsonb
  );
begin
  v_subject_id:=private_app.website_admin_subject();

  select page.* into v_page
  from website.pages page
  where page.id=p_page_id
    and page.status<>'archived'
  limit 1;
  if v_page.id is null then raise exception 'page_not_found'; end if;

  select site.* into v_site
  from website.sites site
  where site.id=v_page.site_id
  limit 1;

  select document.* into v_document
  from website.page_documents document
  where document.page_id=v_page.id
  limit 1;

  return jsonb_build_object(
    'page',jsonb_build_object(
      'id',v_page.id,'slug',v_page.slug,'title',v_page.title,
      'excerpt',v_page.excerpt,'status',v_page.status,
      'templateKey',v_page.template_key,'content',v_page.content,
      'updatedAt',v_page.updated_at,'publishedAt',v_page.published_at
    ),
    'site',jsonb_build_object(
      'id',v_site.id,'nameAr',v_site.name_ar,'nameEn',v_site.name_en,
      'settings',v_site.settings,'theme',v_site.theme
    ),
    'document',jsonb_build_object(
      'id',v_document.id,
      'draftDocument',coalesce(v_document.draft_document,v_page.content,v_empty),
      'publishedDocument',v_document.published_document,
      'draftUpdatedAt',v_document.draft_updated_at,
      'publishedAt',v_document.published_at
    ),
    'versions',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',version.id,
          'versionNumber',version.version_number,
          'versionKind',version.version_kind,
          'note',version.note,
          'createdAt',version.created_at
        ) order by version.version_number desc
      )
      from (
        select history.*
        from website.page_document_versions history
        where history.page_document_id=v_document.id
        order by history.version_number desc
        limit 30
      ) version
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.v2_platform_page_builder_snapshot(uuid)
from public,anon,authenticated;
grant execute on function public.v2_platform_page_builder_snapshot(uuid)
to authenticated;

create or replace function public.v2_platform_page_builder_action(
  p_action text,
  p_page_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_payload jsonb:=coalesce(p_payload,'{}'::jsonb);
  v_subject_id uuid;
  v_page website.pages%rowtype;
  v_document website.page_documents%rowtype;
  v_validated jsonb;
  v_version_id uuid;
  v_version_number integer;
  v_result_versions jsonb;
begin
  v_subject_id:=private_app.website_admin_subject();

  select page.* into v_page
  from website.pages page
  where page.id=p_page_id and page.status<>'archived'
  limit 1
  for update;
  if v_page.id is null then raise exception 'page_not_found'; end if;

  select document.* into v_document
  from website.page_documents document
  where document.page_id=v_page.id
  limit 1
  for update;

  if v_action in ('save-draft','publish') then
    v_validated:=private_app.website_builder_validate_document(v_payload->'document');

    insert into website.page_documents as document(
      site_id,page_id,schema_version,draft_document,draft_updated_at,
      created_by_subject_id,updated_by_subject_id
    ) values (
      v_page.site_id,v_page.id,1,v_validated,now(),v_subject_id,v_subject_id
    )
    on conflict (page_id) do update
    set draft_document=excluded.draft_document,
        draft_updated_at=now(),
        updated_by_subject_id=v_subject_id
    returning document.* into v_document;

    v_version_number:=private_app.website_builder_record_version(
      v_document.id,
      v_validated,
      case when v_action='publish' then 'published' else 'draft' end,
      case when v_action='publish' then 'نشر الصفحة' else 'حفظ يدوي للمسودة' end,
      v_subject_id
    );

    if v_action='publish' then
      update website.page_documents document
      set published_document=v_validated,
          published_at=now(),
          published_by_subject_id=v_subject_id
      where document.id=v_document.id
      returning document.* into v_document;

      update website.pages page
      set content=v_validated,
          template_key='visual-builder',
          status='published',
          published_at=coalesce(page.published_at,now())
      where page.id=v_page.id
      returning page.* into v_page;

      update website.menu_items menu
      set status='published',
          is_visible=true,
          label=coalesce(v_page.menu_label,v_page.title,menu.label)
      where v_page.show_in_menu
        and menu.site_id=v_page.site_id
        and menu.item_kind='page'
        and menu.href='/p/'||v_page.slug;
    else
      update website.pages page
      set template_key='visual-builder'
      where page.id=v_page.id
      returning page.* into v_page;
    end if;

  elsif v_action='restore-version' then
    if nullif(v_payload->>'versionId','') is null then
      raise exception 'builder_version_not_found';
    end if;
    v_version_id:=(v_payload->>'versionId')::uuid;
    select history.document into v_validated
    from website.page_document_versions history
    join website.page_documents document
      on document.id=history.page_document_id
    where history.id=v_version_id
      and document.page_id=v_page.id
    limit 1;
    if v_validated is null then raise exception 'builder_version_not_found'; end if;
    v_validated:=private_app.website_builder_validate_document(v_validated);

    insert into website.page_documents as document(
      site_id,page_id,schema_version,draft_document,draft_updated_at,
      created_by_subject_id,updated_by_subject_id
    ) values (
      v_page.site_id,v_page.id,1,v_validated,now(),v_subject_id,v_subject_id
    )
    on conflict (page_id) do update
    set draft_document=excluded.draft_document,
        draft_updated_at=now(),
        updated_by_subject_id=v_subject_id
    returning document.* into v_document;

    v_version_number:=private_app.website_builder_record_version(
      v_document.id,v_validated,'restored','استعادة إصدار سابق',v_subject_id
    );
  else
    raise exception 'builder_action_invalid';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',version.id,
      'versionNumber',version.version_number,
      'versionKind',version.version_kind,
      'note',version.note,
      'createdAt',version.created_at
    ) order by version.version_number desc
  ),'[]'::jsonb)
  into v_result_versions
  from (
    select history.*
    from website.page_document_versions history
    where history.page_document_id=v_document.id
    order by history.version_number desc
    limit 30
  ) version;

  return jsonb_build_object(
    'pageId',v_page.id,
    'status',v_page.status,
    'draftDocument',v_document.draft_document,
    'publishedDocument',v_document.published_document,
    'versionNumber',v_version_number,
    'versions',v_result_versions,
    'savedAt',now()
  );
end;
$$;

revoke all on function public.v2_platform_page_builder_action(text,uuid,jsonb)
from public,anon,authenticated;
grant execute on function public.v2_platform_page_builder_action(text,uuid,jsonb)
to authenticated;

commit;
