begin;

-- Reconcile the versioned schema with the reviewed CMS v3 runtime currently in use.

-- private_app.cms_asset_action production baseline md5: 39ad6b72705244268894958624c0ff66
CREATE OR REPLACE FUNCTION private_app.cms_asset_action(p_site_id uuid, p_subject_id uuid, p_can_publish boolean, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_row jsonb;
begin
  if p_action='register-asset' then
    if coalesce((p_payload->>'sizeBytes')::bigint,0)>8388608 then raise exception 'asset_too_large'; end if;
    if p_payload->>'mimeType' not in ('image/jpeg','image/png','image/webp','image/gif','image/svg+xml','image/avif') then raise exception 'asset_type_invalid'; end if;
    if not (p_payload->>'objectPath' like p_site_id::text||'/%') then raise exception 'asset_path_invalid'; end if;
    insert into website.assets as created_asset(
      site_id,bucket_id,object_path,public_url,file_name,mime_type,size_bytes,
      width,height,alt_text,caption,metadata,created_by_subject_id
    ) values (
      p_site_id,'cms-assets',p_payload->>'objectPath',p_payload->>'publicUrl',
      left(coalesce(nullif(trim(p_payload->>'fileName'),''),'image'),255),p_payload->>'mimeType',
      coalesce((p_payload->>'sizeBytes')::bigint,0),nullif(p_payload->>'width','')::integer,
      nullif(p_payload->>'height','')::integer,nullif(trim(p_payload->>'altText'),''),
      nullif(trim(p_payload->>'caption'),''),case when jsonb_typeof(p_payload->'metadata')='object' then p_payload->'metadata' else '{}'::jsonb end,
      p_subject_id
    ) returning to_jsonb(created_asset) into v_row;

  elsif p_action='update-asset' then
    v_id:=(p_payload->>'id')::uuid;
    update website.assets asset
    set alt_text=nullif(trim(p_payload->>'altText'),''),caption=nullif(trim(p_payload->>'caption'),''),
        metadata=case when jsonb_typeof(p_payload->'metadata')='object' then asset.metadata||(p_payload->'metadata') else asset.metadata end
    where asset.id=v_id and asset.site_id=p_site_id and asset.status='active'
    returning to_jsonb(asset) into v_row;
    if v_row is null then raise exception 'asset_not_found'; end if;

  elsif p_action='archive-asset' then
    v_id:=(p_payload->>'id')::uuid;
    update website.assets asset set status='archived' where asset.id=v_id and asset.site_id=p_site_id returning to_jsonb(asset) into v_row;
    if v_row is null then raise exception 'asset_not_found'; end if;

  elsif p_action='set-submission-status' then
    v_id:=(p_payload->>'id')::uuid;
    if p_payload->>'status' not in ('new','in_progress','resolved','spam','archived') then raise exception 'submission_status_invalid'; end if;
    update website.contact_submissions submission
    set status=p_payload->>'status',handled_by_subject_id=p_subject_id,
        handled_at=case when p_payload->>'status' in ('resolved','spam','archived') then now() else submission.handled_at end
    where submission.id=v_id and submission.site_id=p_site_id
    returning to_jsonb(submission) into v_row;
    if v_row is null then raise exception 'submission_not_found'; end if;
  else
    raise exception 'cms_asset_action_invalid';
  end if;
  return v_row;
end;
$function$;

-- private_app.cms_content_action production baseline md5: 09bc878fbce1cb9838b1013ca6e63581
CREATE OR REPLACE FUNCTION private_app.cms_content_action(p_site_id uuid, p_subject_id uuid, p_can_publish boolean, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_status text;
  v_slug text;
  v_document website.content_documents%rowtype;
  v_row jsonb;
begin
  if p_action in ('create-article','update-article') then
    v_slug:=lower(trim(coalesce(p_payload->>'slug','')));
    if v_slug !~ '^[a-z0-9][a-z0-9-]{0,94}$' then raise exception 'article_slug_invalid'; end if;
    if nullif(trim(p_payload->>'title'),'') is null then raise exception 'article_title_required'; end if;
    v_status:=case when p_payload->>'status' in ('draft','published') then p_payload->>'status' else 'draft' end;
    if v_status='published' and not p_can_publish then raise exception 'publish_forbidden'; end if;
    if p_action='create-article' then
      insert into website.articles(
        site_id,slug,title,excerpt,body,content,category,author_name,cover_url,
        seo_title,seo_description,featured,status,published_at,tags,reading_minutes,
        canonical_url,robots,scheduled_at,visibility
      ) values (
        p_site_id,v_slug,trim(p_payload->>'title'),nullif(trim(p_payload->>'excerpt'),''),'','{}'::jsonb,
        nullif(trim(p_payload->>'category'),''),coalesce(nullif(trim(p_payload->>'authorName'),''),'فريق العمل'),
        nullif(trim(p_payload->>'coverUrl'),''),nullif(trim(p_payload->>'seoTitle'),''),
        nullif(trim(p_payload->>'seoDescription'),''),coalesce((p_payload->>'featured')::boolean,false),v_status,
        case when v_status='published' then now() else null end,
        case when jsonb_typeof(p_payload->'tags')='array' then array(select jsonb_array_elements_text(p_payload->'tags')) else '{}'::text[] end,
        nullif(p_payload->>'readingMinutes','')::integer,nullif(trim(p_payload->>'canonicalUrl'),''),
        coalesce(nullif(trim(p_payload->>'robots'),''),'index,follow'),
        nullif(p_payload->>'scheduledAt','')::timestamptz,
        case when p_payload->>'visibility' in ('public','unlisted','members') then p_payload->>'visibility' else 'public' end
      ) returning id into v_id;
      v_document:=private_app.cms_ensure_document(p_site_id,'article',v_id,p_subject_id);
      v_row:=jsonb_build_object('id',v_id,'documentId',v_document.id);
    else
      v_id:=(p_payload->>'id')::uuid;
      update website.articles article
      set slug=v_slug,title=trim(p_payload->>'title'),excerpt=nullif(trim(p_payload->>'excerpt'),''),
          category=nullif(trim(p_payload->>'category'),''),author_name=coalesce(nullif(trim(p_payload->>'authorName'),''),article.author_name),
          cover_url=nullif(trim(p_payload->>'coverUrl'),''),seo_title=nullif(trim(p_payload->>'seoTitle'),''),
          seo_description=nullif(trim(p_payload->>'seoDescription'),''),featured=coalesce((p_payload->>'featured')::boolean,article.featured),
          status=v_status,published_at=case when v_status='published' then coalesce(article.published_at,now()) else article.published_at end,
          tags=case when jsonb_typeof(p_payload->'tags')='array' then array(select jsonb_array_elements_text(p_payload->'tags')) else article.tags end,
          reading_minutes=nullif(p_payload->>'readingMinutes','')::integer,
          canonical_url=nullif(trim(p_payload->>'canonicalUrl'),''),robots=coalesce(nullif(trim(p_payload->>'robots'),''),article.robots),
          scheduled_at=nullif(p_payload->>'scheduledAt','')::timestamptz,
          visibility=case when p_payload->>'visibility' in ('public','unlisted','members') then p_payload->>'visibility' else article.visibility end
      where article.id=v_id and article.site_id=p_site_id and article.status<>'archived'
      returning to_jsonb(article) into v_row;
      if v_row is null then raise exception 'article_not_found'; end if;
    end if;

  elsif p_action='archive-article' then
    v_id:=(p_payload->>'id')::uuid;
    update website.articles article set status='archived' where article.id=v_id and article.site_id=p_site_id returning to_jsonb(article) into v_row;
    if v_row is null then raise exception 'article_not_found'; end if;
    update website.menu_items set status='archived',is_visible=false where site_id=p_site_id and target_article_id=v_id;

  elsif p_action in ('create-category','update-category') then
    v_slug:=lower(trim(coalesce(p_payload->>'slug','')));
    if v_slug !~ '^[a-z0-9][a-z0-9-]{0,63}$' then raise exception 'category_slug_invalid'; end if;
    if nullif(trim(p_payload->>'name'),'') is null then raise exception 'category_name_required'; end if;
    if p_action='create-category' then
      insert into website.article_categories as created_category(site_id,parent_id,name,slug,description,sort_order)
      values(p_site_id,nullif(p_payload->>'parentId','')::uuid,trim(p_payload->>'name'),v_slug,nullif(trim(p_payload->>'description'),''),coalesce((p_payload->>'sortOrder')::integer,100))
      returning to_jsonb(created_category) into v_row;
    else
      v_id:=(p_payload->>'id')::uuid;
      update website.article_categories category
      set parent_id=nullif(p_payload->>'parentId','')::uuid,name=trim(p_payload->>'name'),slug=v_slug,
          description=nullif(trim(p_payload->>'description'),''),sort_order=coalesce((p_payload->>'sortOrder')::integer,category.sort_order)
      where category.id=v_id and category.site_id=p_site_id and category.status='active'
      returning to_jsonb(category) into v_row;
      if v_row is null then raise exception 'category_not_found'; end if;
    end if;

  elsif p_action='archive-category' then
    v_id:=(p_payload->>'id')::uuid;
    update website.article_categories category set status='archived' where category.id=v_id and category.site_id=p_site_id returning to_jsonb(category) into v_row;
    if v_row is null then raise exception 'category_not_found'; end if;

  else
    raise exception 'cms_content_action_invalid';
  end if;
  return v_row;
end;
$function$;

-- private_app.cms_menu_action production baseline md5: 9f2c3d7c6f065ebe6b85998e620c8437
CREATE OR REPLACE FUNCTION private_app.cms_menu_action(p_site_id uuid, p_subject_id uuid, p_can_publish boolean, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_slug text;
  v_kind text;
  v_menu_id uuid;
  v_parent_id uuid;
  v_page_id uuid;
  v_article_id uuid;
  v_href text;
  v_row jsonb;
begin
  if p_action in ('create-menu','update-menu') then
    if nullif(trim(p_payload->>'name'),'') is null then raise exception 'menu_name_required'; end if;
    if p_action='create-menu' then
      v_slug:=lower(regexp_replace(coalesce(nullif(trim(p_payload->>'key'),''),trim(p_payload->>'name')),'[^a-zA-Z0-9_-]+','-','g'));
      insert into website.menus as created_menu(site_id,menu_key,name,location,description,settings,status)
      values(
        p_site_id,v_slug,trim(p_payload->>'name'),
        case when p_payload->>'location' in ('header','footer','mobile','custom') then p_payload->>'location' else 'custom' end,
        nullif(trim(p_payload->>'description'),''),
        case when jsonb_typeof(p_payload->'settings')='object' then p_payload->'settings' else '{}'::jsonb end,
        case when p_payload->>'status' in ('draft','published') then p_payload->>'status' else 'published' end
      ) returning to_jsonb(created_menu) into v_row;
    else
      v_id:=(p_payload->>'id')::uuid;
      update website.menus menu
      set name=trim(p_payload->>'name'),
          location=case when p_payload->>'location' in ('header','footer','mobile','custom') then p_payload->>'location' else menu.location end,
          description=nullif(trim(p_payload->>'description'),''),
          settings=case when jsonb_typeof(p_payload->'settings')='object' then menu.settings||(p_payload->'settings') else menu.settings end,
          status=case when p_payload->>'status' in ('draft','published') then p_payload->>'status' else menu.status end
      where menu.id=v_id and menu.site_id=p_site_id and menu.status<>'archived'
      returning to_jsonb(menu) into v_row;
      if v_row is null then raise exception 'menu_not_found'; end if;
    end if;

  elsif p_action='archive-menu' then
    v_id:=(p_payload->>'id')::uuid;
    if exists(select 1 from website.menus menu where menu.id=v_id and menu.site_id=p_site_id and menu.location in ('header','footer')) then raise exception 'system_menu_cannot_archive'; end if;
    update website.menus menu set status='archived' where menu.id=v_id and menu.site_id=p_site_id returning to_jsonb(menu) into v_row;
    if v_row is null then raise exception 'menu_not_found'; end if;

  elsif p_action='save-menu-item' then
    v_menu_id:=(p_payload->>'menuId')::uuid;
    if not exists(select 1 from website.menus menu where menu.id=v_menu_id and menu.site_id=p_site_id and menu.status<>'archived') then raise exception 'menu_not_found'; end if;
    v_kind:=case when p_payload->>'kind' in ('anchor','page','article','external','system','group') then p_payload->>'kind' else 'external' end;
    v_page_id:=nullif(p_payload->>'targetPageId','')::uuid;
    v_article_id:=nullif(p_payload->>'targetArticleId','')::uuid;
    v_parent_id:=nullif(p_payload->>'parentId','')::uuid;
    v_href:=private_app.cms_menu_href(p_site_id,v_kind,v_page_id,v_article_id,p_payload->>'href');
    if nullif(trim(p_payload->>'label'),'') is null then raise exception 'menu_item_label_required'; end if;
    if nullif(p_payload->>'id','') is null then
      insert into website.menu_items as created_item(
        site_id,menu_id,parent_id,label,mobile_label,href,item_kind,target_page_id,
        target_article_id,description,icon,badge,image_url,column_index,is_mega,
        mega_settings,css_class,open_in_new_tab,sort_order,is_visible,status
      ) values (
        p_site_id,v_menu_id,v_parent_id,trim(p_payload->>'label'),nullif(trim(p_payload->>'mobileLabel'),''),
        v_href,v_kind,v_page_id,v_article_id,nullif(trim(p_payload->>'description'),''),
        nullif(trim(p_payload->>'icon'),''),nullif(trim(p_payload->>'badge'),''),nullif(trim(p_payload->>'imageUrl'),''),
        least(greatest(coalesce((p_payload->>'columnIndex')::integer,1),1),6),
        coalesce((p_payload->>'isMega')::boolean,false),
        case when jsonb_typeof(p_payload->'megaSettings')='object' then p_payload->'megaSettings' else '{}'::jsonb end,
        nullif(trim(p_payload->>'cssClass'),''),coalesce((p_payload->>'openInNewTab')::boolean,false),
        coalesce((p_payload->>'sortOrder')::integer,100),coalesce((p_payload->>'isVisible')::boolean,true),
        case when p_payload->>'status' in ('draft','published') then p_payload->>'status' else 'published' end
      ) returning to_jsonb(created_item) into v_row;
    else
      v_id:=(p_payload->>'id')::uuid;
      update website.menu_items item
      set menu_id=v_menu_id,parent_id=v_parent_id,label=trim(p_payload->>'label'),
          mobile_label=nullif(trim(p_payload->>'mobileLabel'),''),href=v_href,item_kind=v_kind,
          target_page_id=v_page_id,target_article_id=v_article_id,
          description=nullif(trim(p_payload->>'description'),''),icon=nullif(trim(p_payload->>'icon'),''),
          badge=nullif(trim(p_payload->>'badge'),''),image_url=nullif(trim(p_payload->>'imageUrl'),''),
          column_index=least(greatest(coalesce((p_payload->>'columnIndex')::integer,item.column_index),1),6),
          is_mega=coalesce((p_payload->>'isMega')::boolean,item.is_mega),
          mega_settings=case when jsonb_typeof(p_payload->'megaSettings')='object' then p_payload->'megaSettings' else item.mega_settings end,
          css_class=nullif(trim(p_payload->>'cssClass'),''),open_in_new_tab=coalesce((p_payload->>'openInNewTab')::boolean,item.open_in_new_tab),
          sort_order=coalesce((p_payload->>'sortOrder')::integer,item.sort_order),
          is_visible=coalesce((p_payload->>'isVisible')::boolean,item.is_visible),
          status=case when p_payload->>'status' in ('draft','published') then p_payload->>'status' else item.status end
      where item.id=v_id and item.site_id=p_site_id and item.status<>'archived'
      returning to_jsonb(item) into v_row;
      if v_row is null then raise exception 'menu_item_not_found'; end if;
    end if;

  elsif p_action='archive-menu-item' then
    v_id:=(p_payload->>'id')::uuid;
    update website.menu_items item set status='archived',is_visible=false where item.id=v_id and item.site_id=p_site_id returning to_jsonb(item) into v_row;
    if v_row is null then raise exception 'menu_item_not_found'; end if;

  elsif p_action='move-menu-item' then
    v_id:=(p_payload->>'id')::uuid;
    v_parent_id:=nullif(p_payload->>'parentId','')::uuid;
    update website.menu_items item
    set parent_id=v_parent_id,
        column_index=least(greatest(coalesce((p_payload->>'columnIndex')::integer,item.column_index),1),6),
        sort_order=coalesce((p_payload->>'sortOrder')::integer,item.sort_order)
    where item.id=v_id and item.site_id=p_site_id and item.status<>'archived'
    returning to_jsonb(item) into v_row;
    if v_row is null then raise exception 'menu_item_not_found'; end if;
  else
    raise exception 'cms_menu_action_invalid';
  end if;
  return v_row;
end;
$function$;

-- private_app.cms_page_action production baseline md5: 28dd343f0813e7977c29c4141c110ea3
CREATE OR REPLACE FUNCTION private_app.cms_page_action(p_site_id uuid, p_subject_id uuid, p_can_publish boolean, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
  v_new_id uuid;
  v_status text;
  v_slug text;
  v_document website.content_documents%rowtype;
  v_source_document website.content_documents%rowtype;
  v_row jsonb;
begin
  if p_action in ('create-page','update-page') then
    v_slug:=lower(trim(coalesce(p_payload->>'slug','')));
    if v_slug !~ '^[a-z0-9][a-z0-9-]{0,94}$' then raise exception 'page_slug_invalid'; end if;
    if nullif(trim(p_payload->>'title'),'') is null then raise exception 'page_title_required'; end if;
    v_status:=case when p_payload->>'status' in ('draft','published') then p_payload->>'status' else 'draft' end;
    if v_status='published' and not p_can_publish then raise exception 'publish_forbidden'; end if;

    if p_action='create-page' then
      insert into website.pages(
        site_id,slug,title,menu_label,excerpt,body,content,template_key,seo_title,
        seo_description,cover_url,show_in_menu,menu_order,status,published_at,
        page_kind,parent_page_id,sort_order,visibility,layout_settings,canonical_url,robots
      ) values (
        p_site_id,v_slug,trim(p_payload->>'title'),nullif(trim(p_payload->>'menuLabel'),''),
        nullif(trim(p_payload->>'excerpt'),''),'','{}'::jsonb,'visual-builder',
        nullif(trim(p_payload->>'seoTitle'),''),nullif(trim(p_payload->>'seoDescription'),''),
        nullif(trim(p_payload->>'coverUrl'),''),coalesce((p_payload->>'showInMenu')::boolean,false),
        coalesce((p_payload->>'menuOrder')::integer,100),v_status,
        case when v_status='published' then now() else null end,
        case when p_payload->>'pageKind' in ('standard','landing','legal','system') then p_payload->>'pageKind' else 'standard' end,
        nullif(p_payload->>'parentPageId','')::uuid,coalesce((p_payload->>'sortOrder')::integer,100),
        case when p_payload->>'visibility' in ('public','unlisted','members') then p_payload->>'visibility' else 'public' end,
        case when jsonb_typeof(p_payload->'layoutSettings')='object' then p_payload->'layoutSettings' else '{}'::jsonb end,
        nullif(trim(p_payload->>'canonicalUrl'),''),coalesce(nullif(trim(p_payload->>'robots'),''),'index,follow')
      ) returning id into v_id;
      v_document:=private_app.cms_ensure_document(p_site_id,'page',v_id,p_subject_id);
      v_row:=jsonb_build_object('id',v_id,'documentId',v_document.id);
    else
      v_id:=(p_payload->>'id')::uuid;
      if not exists(select 1 from website.pages page where page.id=v_id and page.site_id=p_site_id and page.status<>'archived') then raise exception 'page_not_found'; end if;
      update website.pages page
      set slug=v_slug,title=trim(p_payload->>'title'),
          menu_label=nullif(trim(p_payload->>'menuLabel'),''),excerpt=nullif(trim(p_payload->>'excerpt'),''),
          seo_title=nullif(trim(p_payload->>'seoTitle'),''),seo_description=nullif(trim(p_payload->>'seoDescription'),''),
          cover_url=nullif(trim(p_payload->>'coverUrl'),''),show_in_menu=coalesce((p_payload->>'showInMenu')::boolean,page.show_in_menu),
          menu_order=coalesce((p_payload->>'menuOrder')::integer,page.menu_order),status=v_status,
          published_at=case when v_status='published' then coalesce(page.published_at,now()) else page.published_at end,
          page_kind=case when page.is_home then 'home' when p_payload->>'pageKind' in ('standard','landing','legal','system') then p_payload->>'pageKind' else page.page_kind end,
          parent_page_id=nullif(p_payload->>'parentPageId','')::uuid,
          sort_order=coalesce((p_payload->>'sortOrder')::integer,page.sort_order),
          visibility=case when p_payload->>'visibility' in ('public','unlisted','members') then p_payload->>'visibility' else page.visibility end,
          layout_settings=case when jsonb_typeof(p_payload->'layoutSettings')='object' then p_payload->'layoutSettings' else page.layout_settings end,
          canonical_url=nullif(trim(p_payload->>'canonicalUrl'),''),robots=coalesce(nullif(trim(p_payload->>'robots'),''),page.robots)
      where page.id=v_id
      returning to_jsonb(page) into v_row;
    end if;

  elsif p_action='duplicate-page' then
    v_id:=(p_payload->>'id')::uuid;
    if not exists(select 1 from website.pages page where page.id=v_id and page.site_id=p_site_id and page.status<>'archived') then raise exception 'page_not_found'; end if;
    select lower(regexp_replace(page.slug||'-copy-'||substr(replace(gen_random_uuid()::text,'-',''),1,5),'[^a-z0-9-]','','g')) into v_slug
    from website.pages page where page.id=v_id;
    insert into website.pages(
      site_id,slug,title,menu_label,excerpt,body,content,template_key,seo_title,
      seo_description,cover_url,show_in_menu,menu_order,status,page_kind,parent_page_id,
      sort_order,visibility,layout_settings,canonical_url,robots
    )
    select site_id,v_slug,title||' — نسخة',menu_label,excerpt,body,content,template_key,
           seo_title,seo_description,cover_url,false,menu_order,'draft',
           case when page_kind='home' then 'standard' else page_kind end,parent_page_id,
           sort_order,visibility,layout_settings,null,robots
    from website.pages where id=v_id
    returning id into v_new_id;
    select * into v_source_document from website.content_documents where site_id=p_site_id and entity_type='page' and entity_id=v_id limit 1;
    insert into website.content_documents(
      site_id,entity_type,entity_id,draft_document,created_by_subject_id,updated_by_subject_id
    ) values (
      p_site_id,'page',v_new_id,
      coalesce(v_source_document.draft_document,private_app.cms_default_document('page','نسخة صفحة','','',null)),
      p_subject_id,p_subject_id
    ) returning * into v_document;
    v_row:=jsonb_build_object('id',v_new_id,'documentId',v_document.id);

  elsif p_action='archive-page' then
    v_id:=(p_payload->>'id')::uuid;
    if exists(select 1 from website.pages page where page.id=v_id and page.site_id=p_site_id and page.is_home) then raise exception 'home_page_cannot_archive'; end if;
    update website.pages page set status='archived',show_in_menu=false where page.id=v_id and page.site_id=p_site_id returning to_jsonb(page) into v_row;
    if v_row is null then raise exception 'page_not_found'; end if;
    update website.menu_items set status='archived',is_visible=false where site_id=p_site_id and target_page_id=v_id;

  elsif p_action='set-home-page' then
    if not p_can_publish then raise exception 'publish_forbidden'; end if;
    v_id:=(p_payload->>'id')::uuid;
    if not exists(select 1 from website.pages page where page.id=v_id and page.site_id=p_site_id and page.status<>'archived') then raise exception 'page_not_found'; end if;
    update website.pages page set is_home=false,page_kind=case when page.page_kind='home' then 'standard' else page.page_kind end where page.site_id=p_site_id and page.is_home;
    update website.pages page set is_home=true,page_kind='home',status='published',published_at=coalesce(page.published_at,now()) where page.id=v_id returning to_jsonb(page) into v_row;
  else
    raise exception 'cms_page_action_invalid';
  end if;
  return v_row;
end;
$function$;

-- private_app.cms_public_menu_items production baseline md5: 4aee1021b2ed7c787fdae476eedb60b5
CREATE OR REPLACE FUNCTION private_app.cms_public_menu_items(p_site_id uuid, p_menu_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item.id,'parentId',item.parent_id,'label',item.label,
    'mobileLabel',item.mobile_label,'href',item.href,'kind',item.item_kind,
    'description',item.description,'icon',item.icon,'badge',item.badge,
    'imageUrl',item.image_url,'columnIndex',item.column_index,'isMega',item.is_mega,
    'megaSettings',item.mega_settings,'cssClass',item.css_class,
    'openInNewTab',item.open_in_new_tab,'sortOrder',item.sort_order
  ) order by item.parent_id nulls first,item.column_index,item.sort_order,item.created_at),'[]'::jsonb)
  from website.menu_items item
  join website.menus menu on menu.id=item.menu_id
  where item.site_id=p_site_id and menu.menu_key=p_menu_key
    and menu.status='published' and item.status='published' and item.is_visible
$function$;

-- public.v3_cms_action production baseline md5: 5f53b92b9e1013983e1a9eb970d2870b
CREATE OR REPLACE FUNCTION public.v3_cms_action(p_site_key text, p_tenant_slug text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_payload jsonb:=coalesce(p_payload,'{}'::jsonb);
  v_row jsonb;
  v_publish_permission boolean:=false;
  v_target text;
begin
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  perform private_app.cms_bootstrap_site(v_site.id,v_subject_id);
  v_publish_permission:=case
    when v_site.site_scope='platform' then private_app.has_platform_permission('platform.website.manage')
    else private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.publish')
  end;

  if v_action='save-site' then
    update website.sites site
    set name_ar=coalesce(nullif(trim(v_payload->>'nameAr'),''),site.name_ar),
        name_en=nullif(trim(coalesce(v_payload->>'nameEn','')),''),
        status=case when v_payload->>'status' in ('draft','published','maintenance') then v_payload->>'status' else site.status end,
        primary_domain=nullif(lower(trim(coalesce(v_payload->>'primaryDomain',''))),''),
        locale=coalesce(nullif(trim(v_payload->>'locale'),''),site.locale),
        settings=case when jsonb_typeof(v_payload->'settings')='object' then site.settings||(v_payload->'settings') else site.settings end,
        theme=case when jsonb_typeof(v_payload->'theme')='object' then site.theme||(v_payload->'theme') else site.theme end,
        published_at=case when coalesce(v_payload->>'status',site.status)='published' then coalesce(site.published_at,now()) else site.published_at end
    where site.id=v_site.id
    returning to_jsonb(site) into v_row;
  elsif v_action=any(array[
    'create-page','update-page','duplicate-page','archive-page','set-home-page'
  ]) then
    v_row:=private_app.cms_page_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  elsif v_action=any(array[
    'create-menu','update-menu','archive-menu','save-menu-item',
    'archive-menu-item','move-menu-item'
  ]) then
    v_row:=private_app.cms_menu_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  elsif v_action=any(array[
    'create-article','update-article','archive-article',
    'create-category','update-category','archive-category'
  ]) then
    v_row:=private_app.cms_content_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  elsif v_action=any(array[
    'register-asset','update-asset','archive-asset','set-submission-status'
  ]) then
    v_row:=private_app.cms_asset_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  else
    raise exception 'cms_action_invalid';
  end if;

  v_target:=coalesce(v_row->>'id',v_row->>'pageId',v_row->>'articleId',v_site.id::text);
  perform private_app.write_audit(
    'cms.'||replace(v_action,'-','.'),'cms',v_target,
    v_site.tenant_id,jsonb_build_object(
      'siteId',v_site.id,'scope',v_site.site_scope,'action',v_action
    )
  );
  return jsonb_build_object(
    'success',true,'action',v_action,'result',v_row,'siteId',v_site.id
  );
exception when unique_violation then
  raise exception 'cms_unique_value_conflict';
end;
$function$;

-- public.v3_cms_builder_action production baseline md5: 75b1f2d0a0fed25ef8464319b51cefc5
CREATE OR REPLACE FUNCTION public.v3_cms_builder_action(p_site_key text, p_tenant_slug text, p_entity_type text, p_entity_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_document website.content_documents%rowtype;
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_validated jsonb;
  v_version integer;
  v_version_id uuid;
  v_versions jsonb;
  v_can_publish boolean;
begin
  if p_entity_type not in ('page','article') then raise exception 'cms_entity_type_invalid'; end if;
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  v_document:=private_app.cms_ensure_document(v_site.id,p_entity_type,p_entity_id,v_subject_id);
  v_can_publish:=case
    when v_site.site_scope='platform' then private_app.has_platform_permission('platform.website.manage')
    else private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.publish')
  end;

  if v_action in ('save-draft','publish') then
    v_validated:=private_app.website_builder_validate_document(p_payload->'document');
    update website.content_documents document
    set draft_document=v_validated,draft_updated_at=now(),updated_by_subject_id=v_subject_id
    where document.id=v_document.id
    returning * into v_document;
    v_version:=private_app.cms_record_version(
      v_document.id,v_validated,
      case when v_action='publish' then 'published' else 'draft' end,
      case when v_action='publish' then 'نشر المحتوى' else 'حفظ مسودة' end,
      v_subject_id
    );

    if v_action='publish' then
      if not v_can_publish then raise exception 'publish_forbidden'; end if;
      update website.content_documents document
      set published_document=v_validated,published_at=now(),published_by_subject_id=v_subject_id
      where document.id=v_document.id
      returning * into v_document;
      if p_entity_type='page' then
        update website.pages page
        set content=v_validated,template_key='visual-builder',status='published',published_at=coalesce(page.published_at,now())
        where page.id=p_entity_id and page.site_id=v_site.id;
      else
        update website.articles article
        set content=v_validated,status='published',published_at=coalesce(article.published_at,now())
        where article.id=p_entity_id and article.site_id=v_site.id;
      end if;
    end if;

  elsif v_action='restore-version' then
    v_version_id:=nullif(p_payload->>'versionId','')::uuid;
    select version.document into v_validated
    from website.content_document_versions version
    where version.id=v_version_id and version.content_document_id=v_document.id
    limit 1;
    if v_validated is null then raise exception 'builder_version_not_found'; end if;
    v_validated:=private_app.website_builder_validate_document(v_validated);
    update website.content_documents document
    set draft_document=v_validated,draft_updated_at=now(),updated_by_subject_id=v_subject_id
    where document.id=v_document.id
    returning * into v_document;
    v_version:=private_app.cms_record_version(
      v_document.id,v_validated,'restored','استعادة إصدار سابق',v_subject_id
    );
  else
    raise exception 'builder_action_invalid';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',version.id,'versionNumber',version.version_number,'versionKind',version.version_kind,
    'note',version.note,'createdAt',version.created_at
  ) order by version.version_number desc),'[]'::jsonb)
  into v_versions
  from (select * from website.content_document_versions where content_document_id=v_document.id order by version_number desc limit 40) version;

  return jsonb_build_object(
    'entityId',p_entity_id,'entityType',p_entity_type,'documentId',v_document.id,
    'draftDocument',v_document.draft_document,'publishedDocument',v_document.published_document,
    'versionNumber',v_version,'versions',v_versions,'savedAt',now()
  );
end;
$function$;

-- public.v3_cms_builder_snapshot production baseline md5: 9d35c865de1ed69a3545eaadcf1d1727
CREATE OR REPLACE FUNCTION public.v3_cms_builder_snapshot(p_site_key text, p_tenant_slug text, p_entity_type text, p_entity_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_document website.content_documents%rowtype;
  v_entity jsonb;
  v_versions jsonb;
begin
  if p_entity_type not in ('page','article') then raise exception 'cms_entity_type_invalid'; end if;
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  perform private_app.cms_bootstrap_site(v_site.id,v_subject_id);
  v_document:=private_app.cms_ensure_document(v_site.id,p_entity_type,p_entity_id,v_subject_id);

  if p_entity_type='page' then
    select jsonb_build_object(
      'id',page.id,'type','page','slug',page.slug,'title',page.title,'excerpt',page.excerpt,
      'status',page.status,'isHome',page.is_home,'pageKind',page.page_kind,
      'canonicalUrl',page.canonical_url,'robots',page.robots,'coverUrl',page.cover_url,
      'updatedAt',page.updated_at,'publishedAt',page.published_at
    ) into v_entity
    from website.pages page where page.id=p_entity_id and page.site_id=v_site.id;
  else
    select jsonb_build_object(
      'id',article.id,'type','article','slug',article.slug,'title',article.title,
      'excerpt',article.excerpt,'status',article.status,'canonicalUrl',article.canonical_url,
      'robots',article.robots,'coverUrl',article.cover_url,
      'category',article.category,'authorName',article.author_name,
      'updatedAt',article.updated_at,'publishedAt',article.published_at
    ) into v_entity
    from website.articles article where article.id=p_entity_id and article.site_id=v_site.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',version.id,'versionNumber',version.version_number,'versionKind',version.version_kind,
    'note',version.note,'createdAt',version.created_at
  ) order by version.version_number desc),'[]'::jsonb)
  into v_versions
  from (select * from website.content_document_versions where content_document_id=v_document.id order by version_number desc limit 40) version;

  return jsonb_build_object(
    'context',jsonb_build_object('scope',v_site.site_scope,'siteKey',v_site.site_key,'siteId',v_site.id,'tenantSlug',p_tenant_slug),
    'entity',v_entity,'page',v_entity,
    'document',jsonb_build_object(
      'id',v_document.id,'draftDocument',v_document.draft_document,
      'publishedDocument',v_document.published_document,'draftUpdatedAt',v_document.draft_updated_at,
      'publishedAt',v_document.published_at
    ),
    'versions',v_versions
  );
end;
$function$;

-- public.v3_cms_media_upload_ticket production baseline md5: 9987d9950c1d3f419c6405acb1654aac
CREATE OR REPLACE FUNCTION public.v3_cms_media_upload_ticket(p_site_key text, p_tenant_slug text, p_file_name text, p_mime_type text, p_size_bytes bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_ext text;
  v_safe_name text;
  v_path text;
begin
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  perform private_app.cms_access_subject(v_site.id,'manage');
  if p_size_bytes<1 or p_size_bytes>8388608 then raise exception 'asset_too_large'; end if;
  v_ext:=case p_mime_type
    when 'image/jpeg' then 'jpg' when 'image/png' then 'png'
    when 'image/webp' then 'webp' when 'image/gif' then 'gif'
    when 'image/svg+xml' then 'svg' when 'image/avif' then 'avif'
    else null end;
  if v_ext is null then raise exception 'asset_type_invalid'; end if;
  v_safe_name:=left(regexp_replace(lower(coalesce(p_file_name,'image')),'[^a-z0-9_-]+','-','g'),70);
  v_path:=v_site.id::text||'/'||to_char(now(),'YYYY/MM')||'/'||
          substr(replace(gen_random_uuid()::text,'-',''),1,18)||'-'||
          coalesce(nullif(trim(both '-' from v_safe_name),''),'image')||'.'||v_ext;
  return jsonb_build_object(
    'siteId',v_site.id,'bucket','cms-assets','objectPath',v_path,
    'maxBytes',8388608,'mimeType',p_mime_type
  );
end;
$function$;

-- public.v3_cms_public_snapshot production baseline md5: 23b125875204045b176a4f44c2a08003
CREATE OR REPLACE FUNCTION public.v3_cms_public_snapshot(p_site_key text DEFAULT 'marktone-main'::text, p_page_slug text DEFAULT NULL::text, p_article_slug text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_home jsonb;
  v_page jsonb;
  v_article jsonb;
  v_pages jsonb;
  v_articles jsonb;
  v_primary jsonb;
  v_footer jsonb;
begin
  select * into v_site
  from website.sites site
  where site.site_key=coalesce(nullif(trim(p_site_key),''),'marktone-main')
    and site.status='published' and site.addon_status in ('active','trial')
  limit 1;
  if v_site.id is null then return jsonb_build_object('available',false); end if;

  v_primary:=private_app.cms_public_menu_items(v_site.id,'primary');
  v_footer:=private_app.cms_public_menu_items(v_site.id,'footer');

  select jsonb_build_object(
    'id',page.id,'slug',page.slug,'title',page.title,'excerpt',page.excerpt,
    'coverUrl',page.cover_url,'seoTitle',page.seo_title,'seoDescription',page.seo_description,
    'canonicalUrl',page.canonical_url,'robots',page.robots,'publishedAt',page.published_at,
    'content',coalesce(document.published_document,page.content)
  ) into v_home
  from website.pages page
  left join website.content_documents document
    on document.site_id=page.site_id and document.entity_type='page' and document.entity_id=page.id
  where page.site_id=v_site.id and page.is_home and page.status='published'
    and page.visibility in ('public','unlisted')
  limit 1;

  if nullif(trim(coalesce(p_page_slug,'')),'') is not null then
    select jsonb_build_object(
      'id',page.id,'slug',page.slug,'title',page.title,'excerpt',page.excerpt,
      'body',page.body,'coverUrl',page.cover_url,'seoTitle',page.seo_title,
      'seoDescription',page.seo_description,'canonicalUrl',page.canonical_url,
      'robots',page.robots,'publishedAt',page.published_at,
      'content',coalesce(document.published_document,page.content)
    ) into v_page
    from website.pages page
    left join website.content_documents document
      on document.site_id=page.site_id and document.entity_type='page' and document.entity_id=page.id
    where page.site_id=v_site.id and page.slug=lower(trim(p_page_slug))
      and page.status='published' and not page.is_home and page.visibility in ('public','unlisted')
    limit 1;
  end if;

  if nullif(trim(coalesce(p_article_slug,'')),'') is not null then
    select jsonb_build_object(
      'id',article.id,'slug',article.slug,'title',article.title,'excerpt',article.excerpt,
      'body',article.body,'category',article.category,'tags',article.tags,
      'authorName',article.author_name,'coverUrl',article.cover_url,
      'seoTitle',article.seo_title,'seoDescription',article.seo_description,
      'canonicalUrl',article.canonical_url,'robots',article.robots,
      'readingMinutes',article.reading_minutes,'publishedAt',article.published_at,
      'content',coalesce(document.published_document,article.content)
    ) into v_article
    from website.articles article
    left join website.content_documents document
      on document.site_id=article.site_id and document.entity_type='article' and document.entity_id=article.id
    where article.site_id=v_site.id and article.slug=lower(trim(p_article_slug))
      and article.status='published' and article.visibility in ('public','unlisted')
      and coalesce(article.scheduled_at,article.published_at,now())<=now()
    limit 1;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',page.id,'slug',page.slug,'title',page.title,'excerpt',page.excerpt,
    'coverUrl',page.cover_url,'updatedAt',page.updated_at
  ) order by page.is_home desc,page.sort_order,page.title),'[]'::jsonb)
  into v_pages
  from website.pages page
  where page.site_id=v_site.id and page.status='published' and page.visibility='public';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',article.id,'slug',article.slug,'title',article.title,'excerpt',article.excerpt,
    'category',article.category,'tags',article.tags,'authorName',article.author_name,
    'coverUrl',article.cover_url,'featured',article.featured,
    'readingMinutes',article.reading_minutes,'publishedAt',article.published_at
  ) order by article.featured desc,article.published_at desc nulls last),'[]'::jsonb)
  into v_articles
  from (select * from website.articles where site_id=v_site.id and status='published' and visibility='public' and coalesce(scheduled_at,published_at,now())<=now() order by featured desc,published_at desc nulls last limit 24) article;

  return jsonb_build_object(
    'available',true,
    'site',jsonb_build_object(
      'id',v_site.id,'key',v_site.site_key,'nameAr',v_site.name_ar,'nameEn',v_site.name_en,
      'settings',v_site.settings,'theme',v_site.theme,'locale',v_site.locale,
      'primaryDomain',v_site.primary_domain,'updatedAt',v_site.updated_at
    ),
    'menu',v_primary,'footerMenu',v_footer,'homePage',v_home,
    'page',v_page,'article',v_article,'pages',v_pages,'articles',v_articles,
    'sections','[]'::jsonb
  );
end;
$function$;

revoke all on function private_app.cms_page_action(uuid,uuid,boolean,text,jsonb) from public,anon,authenticated;
revoke all on function private_app.cms_menu_action(uuid,uuid,boolean,text,jsonb) from public,anon,authenticated;
revoke all on function private_app.cms_content_action(uuid,uuid,boolean,text,jsonb) from public,anon,authenticated;
revoke all on function private_app.cms_asset_action(uuid,uuid,boolean,text,jsonb) from public,anon,authenticated;
revoke all on function private_app.cms_public_menu_items(uuid,text) from public,anon,authenticated;
revoke all on function public.v3_cms_public_snapshot(text,text,text) from public,anon,authenticated;
grant execute on function public.v3_cms_public_snapshot(text,text,text) to anon,authenticated,service_role;
revoke all on function public.v3_cms_action(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.v3_cms_action(text,text,text,jsonb) to authenticated,service_role;
revoke all on function public.v3_cms_builder_snapshot(text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.v3_cms_builder_snapshot(text,text,text,uuid) to authenticated,service_role;
revoke all on function public.v3_cms_builder_action(text,text,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.v3_cms_builder_action(text,text,text,uuid,text,jsonb) to authenticated,service_role;
revoke all on function public.v3_cms_media_upload_ticket(text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.v3_cms_media_upload_ticket(text,text,text,text,bigint) to authenticated,service_role;

commit;
