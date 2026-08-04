begin;

create or replace function private_app.cms_default_document(
  p_kind text,p_title text,p_excerpt text default null,p_body text default null,p_cover_url text default null
)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'schemaVersion',1,
    'settings',jsonb_build_object('contentWidth','wide','background','#ffffff'),
    'blocks',case when p_kind='article' then jsonb_build_array(
      jsonb_build_object(
        'id','heading-'||substr(md5(coalesce(p_title,'article')),1,16),'type','heading',
        'props',jsonb_build_object('anchor','article','eyebrow','مقال','title',coalesce(p_title,'عنوان المقال'),'body',coalesce(p_excerpt,''),'level','h1'),
        'style',jsonb_build_object('variant','paper','align','right','paddingY',64,'maxWidth','reading','background','','color',''),
        'responsive',jsonb_build_object('hideDesktop',false,'hideTablet',false,'hideMobile',false)
      ),
      jsonb_build_object(
        'id','text-'||substr(md5(coalesce(p_title,'article')||'body'),1,16),'type','text',
        'props',jsonb_build_object('anchor','content','content',coalesce(p_body,''),'columns',1),
        'style',jsonb_build_object('variant','light','align','right','paddingY',48,'maxWidth','reading','background','','color',''),
        'responsive',jsonb_build_object('hideDesktop',false,'hideTablet',false,'hideMobile',false)
      )
    ) else jsonb_build_array(
      jsonb_build_object(
        'id','hero-'||substr(md5(coalesce(p_title,'page')),1,16),'type','hero',
        'props',jsonb_build_object('anchor','home','eyebrow','ماركتون','title',coalesce(p_title,'عنوان الصفحة'),'body',coalesce(p_excerpt,''),'imageUrl',coalesce(p_cover_url,''),'imageAlt',coalesce(p_title,''),'primaryLabel','تواصل معنا','primaryHref','#contact','secondaryLabel','','secondaryHref',''),
        'style',jsonb_build_object('variant','dark','align','right','paddingY',96,'maxWidth','wide','background','','color',''),
        'responsive',jsonb_build_object('hideDesktop',false,'hideTablet',false,'hideMobile',false)
      ),
      jsonb_build_object(
        'id','text-'||substr(md5(coalesce(p_title,'page')||'body'),1,16),'type','text',
        'props',jsonb_build_object('anchor','details','content',coalesce(p_body,''),'columns',1),
        'style',jsonb_build_object('variant','light','align','right','paddingY',56,'maxWidth','reading','background','','color',''),
        'responsive',jsonb_build_object('hideDesktop',false,'hideTablet',false,'hideMobile',false)
      ),
      jsonb_build_object(
        'id','contact-'||substr(md5(coalesce(p_title,'page')||'contact'),1,16),'type','contact',
        'props',jsonb_build_object('anchor','contact','eyebrow','تواصل معنا','title','دعنا نفهم احتياجك','body','اكتب نبذة قصيرة وسيتواصل معك فريق العمل.','buttonLabel','إرسال الطلب'),
        'style',jsonb_build_object('variant','light','align','right','paddingY',80,'maxWidth','wide','background','','color',''),
        'responsive',jsonb_build_object('hideDesktop',false,'hideTablet',false,'hideMobile',false)
      )
    ) end
  )
$$;
revoke all on function private_app.cms_default_document(text,text,text,text,text) from public,anon,authenticated;

create or replace function private_app.cms_record_version(
  p_document_id uuid,p_document jsonb,p_kind text,p_note text,p_subject_id uuid
)
returns integer language plpgsql security definer set search_path='' as $$
declare v_next integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('cms-document:'||p_document_id::text,0));
  select coalesce(max(version_number),0)+1 into v_next from website.content_document_versions where content_document_id=p_document_id;
  insert into website.content_document_versions(content_document_id,version_number,version_kind,document,note,created_by_subject_id)
  values(p_document_id,v_next,case when p_kind in ('draft','published','restored') then p_kind else 'draft' end,
    private_app.website_builder_validate_document(p_document),nullif(left(trim(coalesce(p_note,'')),240),''),p_subject_id);
  return v_next;
end $$;
revoke all on function private_app.cms_record_version(uuid,jsonb,text,text,uuid) from public,anon,authenticated;

create or replace function private_app.cms_entity_exists(p_site_id uuid,p_entity_type text,p_entity_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select case
    when p_entity_type='page' then exists(select 1 from website.pages p where p.id=p_entity_id and p.site_id=p_site_id and p.status<>'archived')
    when p_entity_type='article' then exists(select 1 from website.articles a where a.id=p_entity_id and a.site_id=p_site_id and a.status<>'archived')
    else false end
$$;
revoke all on function private_app.cms_entity_exists(uuid,text,uuid) from public,anon,authenticated;

create or replace function private_app.cms_ensure_document(
  p_site_id uuid,p_entity_type text,p_entity_id uuid,p_subject_id uuid default null
)
returns website.content_documents language plpgsql security definer set search_path='' as $$
declare v_document website.content_documents%rowtype; v_title text; v_excerpt text; v_body text; v_cover text; v_status text; v_seed jsonb;
begin
  if not private_app.cms_entity_exists(p_site_id,p_entity_type,p_entity_id) then raise exception 'cms_entity_not_found'; end if;
  select * into v_document from website.content_documents d
  where d.site_id=p_site_id and d.entity_type=p_entity_type and d.entity_id=p_entity_id limit 1;
  if v_document.id is not null then return v_document; end if;
  if p_entity_type='page' then
    select title,excerpt,body,cover_url,status into v_title,v_excerpt,v_body,v_cover,v_status from website.pages where id=p_entity_id;
  else
    select title,excerpt,body,cover_url,status into v_title,v_excerpt,v_body,v_cover,v_status from website.articles where id=p_entity_id;
  end if;
  v_seed:=private_app.cms_default_document(p_entity_type,v_title,v_excerpt,v_body,v_cover);
  insert into website.content_documents(site_id,entity_type,entity_id,draft_document,published_document,draft_updated_at,published_at,created_by_subject_id,updated_by_subject_id,published_by_subject_id)
  values(p_site_id,p_entity_type,p_entity_id,v_seed,case when v_status='published' then v_seed else null end,now(),case when v_status='published' then now() else null end,p_subject_id,p_subject_id,case when v_status='published' then p_subject_id else null end)
  returning * into v_document;
  return v_document;
end $$;
revoke all on function private_app.cms_ensure_document(uuid,text,uuid,uuid) from public,anon,authenticated;

create or replace function private_app.cms_menu_href(
  p_site_id uuid,p_item_kind text,p_target_page_id uuid,p_target_article_id uuid,p_href text
)
returns text language plpgsql stable security definer set search_path='' as $$
declare v_slug text; v_home boolean;
begin
  if p_item_kind='page' then
    select slug,is_home into v_slug,v_home from website.pages where id=p_target_page_id and site_id=p_site_id and status<>'archived' limit 1;
    if v_slug is null then raise exception 'cms_target_page_invalid'; end if;
    return case when v_home then '/' else '/p/'||v_slug end;
  elsif p_item_kind='article' then
    select slug into v_slug from website.articles where id=p_target_article_id and site_id=p_site_id and status<>'archived' limit 1;
    if v_slug is null then raise exception 'cms_target_article_invalid'; end if;
    return '/articles/'||v_slug;
  elsif p_item_kind='group' then return '#';
  end if;
  return coalesce(nullif(trim(p_href),''),'#');
end $$;
revoke all on function private_app.cms_menu_href(uuid,text,uuid,uuid,text) from public,anon,authenticated;

create or replace function private_app.cms_validate_menu_item()
returns trigger language plpgsql set search_path='' as $$
declare v_parent website.menu_items%rowtype; v_depth integer:=0; v_cursor uuid;
begin
  if new.parent_id is null then return new; end if;
  select * into v_parent from website.menu_items where id=new.parent_id limit 1;
  if v_parent.id is null or v_parent.site_id<>new.site_id or v_parent.menu_id<>new.menu_id then raise exception 'cms_menu_parent_invalid'; end if;
  v_cursor:=new.parent_id;
  while v_cursor is not null loop
    if v_cursor=new.id then raise exception 'cms_menu_cycle'; end if;
    v_depth:=v_depth+1;
    if v_depth>3 then raise exception 'cms_menu_depth_limit'; end if;
    select parent_id into v_cursor from website.menu_items where id=v_cursor;
  end loop;
  return new;
end $$;
revoke all on function private_app.cms_validate_menu_item() from public,anon,authenticated;
drop trigger if exists website_menu_item_validate_tree on website.menu_items;
create trigger website_menu_item_validate_tree before insert or update of parent_id,menu_id,site_id on website.menu_items for each row execute function private_app.cms_validate_menu_item();

create or replace function private_app.cms_bootstrap_site(p_site_id uuid,p_subject_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_site website.sites%rowtype; v_home_id uuid; v_home_document jsonb; v_primary_menu_id uuid;
begin
  select * into v_site from website.sites where id=p_site_id limit 1;
  if v_site.id is null then raise exception 'cms_site_not_found'; end if;
  insert into website.menus(site_id,menu_key,name,location,settings,status)
  values
    (v_site.id,'primary','القائمة الرئيسية','header',jsonb_build_object('megaMenu',true,'mobileStyle','drawer'),'published'),
    (v_site.id,'footer','قائمة الفوتر','footer','{}'::jsonb,'published')
  on conflict(site_id,menu_key) do nothing;
  select id into v_home_id from website.pages where site_id=v_site.id and is_home and status<>'archived' limit 1;
  if v_home_id is null then
    insert into website.pages(site_id,slug,title,menu_label,excerpt,body,content,template_key,page_kind,is_home,sort_order,show_in_menu,status,published_at)
    values(v_site.id,'home','الصفحة الرئيسية','الرئيسية',coalesce(v_site.settings->>'description','الصفحة الرئيسية للموقع'),'','{}'::jsonb,'visual-builder','home',true,0,false,case when v_site.status='published' then 'published' else 'draft' end,case when v_site.status='published' then now() else null end)
    returning id into v_home_id;
    v_home_document:=private_app.cms_default_document('page',coalesce(v_site.settings->>'siteTitle',v_site.name_ar),coalesce(v_site.settings->>'description',''),'',null);
    insert into website.content_documents(site_id,entity_type,entity_id,draft_document,published_document,draft_updated_at,published_at,created_by_subject_id,updated_by_subject_id,published_by_subject_id)
    values(v_site.id,'page',v_home_id,v_home_document,case when v_site.status='published' then v_home_document else null end,now(),case when v_site.status='published' then now() else null end,p_subject_id,p_subject_id,case when v_site.status='published' then p_subject_id else null end);
    update website.pages set content=v_home_document where id=v_home_id;
  end if;
  select id into v_primary_menu_id from website.menus where site_id=v_site.id and menu_key='primary' limit 1;
  if not exists(select 1 from website.menu_items where menu_id=v_primary_menu_id and status<>'archived') then
    insert into website.menu_items(site_id,menu_id,label,href,item_kind,target_page_id,sort_order,is_visible,status)
    values
      (v_site.id,v_primary_menu_id,'الرئيسية','/','page',v_home_id,10,true,'published'),
      (v_site.id,v_primary_menu_id,'تواصل معنا','#contact','anchor',null,100,true,'published');
  end if;
end $$;
revoke all on function private_app.cms_bootstrap_site(uuid,uuid) from public,anon,authenticated;

-- Upgrade the existing Marktone homepage to a first-class builder page.
do $$ declare v_site_id uuid; v_home_id uuid; v_doc jsonb; begin
  select id into v_site_id from website.sites where site_key='marktone-main' limit 1;
  if v_site_id is null then return; end if;
  perform private_app.cms_bootstrap_site(v_site_id,null);
  select id into v_home_id from website.pages where site_id=v_site_id and is_home and status<>'archived' limit 1;
  select jsonb_build_object(
    'schemaVersion',1,'settings',jsonb_build_object('contentWidth','wide','background','#ffffff'),
    'blocks',coalesce(jsonb_agg(jsonb_build_object(
      'id',case when section.section_type='hero' then 'hero-' when section.section_type='contact' then 'contact-' when section.section_type='partnership' then 'cta-' when section.section_type in ('metrics','impact') then 'stats-' when section.section_type='comparison' then 'columns-' else 'cards-' end||substr(replace(section.id::text,'-',''),1,16),
      'type',case when section.section_type='hero' then 'hero' when section.section_type='contact' then 'contact' when section.section_type='partnership' then 'cta' when section.section_type in ('metrics','impact') then 'stats' when section.section_type='comparison' then 'columns' else 'cards' end,
      'props',case
        when section.section_type='hero' then jsonb_build_object('anchor',section.section_key,'eyebrow',coalesce(section.eyebrow,''),'title',section.title,'body',coalesce(section.summary,section.body,''),'imageUrl',coalesce(section.media->>'imageUrl',''),'imageAlt',section.title,'primaryLabel',coalesce(section.primary_cta->>'label',''),'primaryHref',coalesce(section.primary_cta->>'href',''),'secondaryLabel',coalesce(section.secondary_cta->>'label',''),'secondaryHref',coalesce(section.secondary_cta->>'href',''))
        when section.section_type='contact' then jsonb_build_object('anchor',section.section_key,'eyebrow',coalesce(section.eyebrow,''),'title',section.title,'body',coalesce(section.summary,section.body,''),'buttonLabel','إرسال طلب التواصل')
        when section.section_type='partnership' then jsonb_build_object('anchor',section.section_key,'eyebrow',coalesce(section.eyebrow,''),'title',section.title,'body',coalesce(section.summary,section.body,''),'buttonLabel',coalesce(section.primary_cta->>'label','تواصل معنا'),'buttonHref',coalesce(section.primary_cta->>'href','#contact'))
        when section.section_type in ('metrics','impact') then jsonb_build_object('anchor',section.section_key,'eyebrow',coalesce(section.eyebrow,''),'title',section.title,'body',coalesce(section.summary,section.body,''),'columns',4,'items',coalesce(section.items,'[]'::jsonb))
        else jsonb_build_object('anchor',section.section_key,'eyebrow',coalesce(section.eyebrow,''),'title',section.title,'body',coalesce(section.summary,section.body,''),'columns',case when jsonb_array_length(coalesce(section.items,'[]'::jsonb))>=6 then 3 else 4 end,'items',coalesce(section.items,'[]'::jsonb)) end,
      'style',jsonb_build_object('variant',case when section.style_variant in ('dark','paper') then section.style_variant else 'light' end,'align','right','paddingY',case when section.section_type='hero' then 96 else 72 end,'maxWidth','wide','background','','color',''),
      'responsive',jsonb_build_object('hideDesktop',false,'hideTablet',false,'hideMobile',false)
    ) order by section.sort_order,section.created_at),'[]'::jsonb)
  ) into v_doc
  from website.sections section where section.site_id=v_site_id and section.status='published' and section.is_visible;
  if jsonb_array_length(coalesce(v_doc->'blocks','[]'::jsonb))>0 then
    insert into website.content_documents(site_id,entity_type,entity_id,draft_document,published_document,draft_updated_at,published_at)
    values(v_site_id,'page',v_home_id,v_doc,v_doc,now(),now())
    on conflict(site_id,entity_type,entity_id) do update set
      draft_document=case when jsonb_array_length(coalesce(website.content_documents.draft_document->'blocks','[]'::jsonb))=0 then excluded.draft_document else website.content_documents.draft_document end,
      published_document=coalesce(website.content_documents.published_document,excluded.published_document);
    update website.pages set content=v_doc,template_key='visual-builder',page_kind='home',is_home=true,status='published',published_at=coalesce(published_at,now()) where id=v_home_id;
  end if;
end $$;

create or replace function public.v3_cms_workspace_snapshot(p_site_key text default 'marktone-main',p_tenant_slug text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_site website.sites%rowtype; v_subject_id uuid; v_pages jsonb; v_menus jsonb; v_items jsonb; v_articles jsonb; v_assets jsonb; v_categories jsonb; v_submissions jsonb; v_can_publish boolean;
begin
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  perform private_app.cms_bootstrap_site(v_site.id,v_subject_id);
  select * into v_site from website.sites where id=v_site.id;
  v_can_publish:=case when v_site.site_scope='platform' then private_app.has_platform_permission('platform.website.manage') else private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.publish') end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'slug',p.slug,'title',p.title,'menuLabel',p.menu_label,'excerpt',p.excerpt,'coverUrl',p.cover_url,
    'pageKind',p.page_kind,'isHome',p.is_home,'parentPageId',p.parent_page_id,'sortOrder',p.sort_order,
    'visibility',p.visibility,'showInMenu',p.show_in_menu,'menuOrder',p.menu_order,'status',p.status,
    'templateKey',p.template_key,'seoTitle',p.seo_title,'seoDescription',p.seo_description,
    'canonicalUrl',p.canonical_url,'robots',p.robots,'updatedAt',p.updated_at,'publishedAt',p.published_at,
    'builder',jsonb_build_object('documentId',d.id,'blockCount',coalesce(jsonb_array_length(d.draft_document->'blocks'),0),'hasDraft',d.id is not null,'hasPublished',d.published_document is not null,'hasUnpublishedChanges',d.draft_document is distinct from d.published_document,'draftUpdatedAt',d.draft_updated_at,'publishedAt',d.published_at)
  ) order by p.is_home desc,p.sort_order,p.updated_at desc),'[]'::jsonb) into v_pages
  from website.pages p left join website.content_documents d on d.site_id=p.site_id and d.entity_type='page' and d.entity_id=p.id
  where p.site_id=v_site.id and p.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'key',m.menu_key,'name',m.name,'location',m.location,'description',m.description,'settings',m.settings,'status',m.status,'updatedAt',m.updated_at,'itemCount',(select count(*) from website.menu_items i where i.menu_id=m.id and i.status<>'archived')) order by case m.location when 'header' then 0 when 'footer' then 1 else 2 end,m.name),'[]'::jsonb) into v_menus
  from website.menus m where m.site_id=v_site.id and m.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'menuId',i.menu_id,'parentId',i.parent_id,'label',i.label,'mobileLabel',i.mobile_label,'href',i.href,'kind',i.item_kind,'targetPageId',i.target_page_id,'targetArticleId',i.target_article_id,'description',i.description,'icon',i.icon,'badge',i.badge,'imageUrl',i.image_url,'columnIndex',i.column_index,'isMega',i.is_mega,'megaSettings',i.mega_settings,'cssClass',i.css_class,'openInNewTab',i.open_in_new_tab,'sortOrder',i.sort_order,'isVisible',i.is_visible,'status',i.status) order by i.menu_id,i.parent_id nulls first,i.column_index,i.sort_order,i.created_at),'[]'::jsonb) into v_items
  from website.menu_items i where i.site_id=v_site.id and i.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'slug',a.slug,'title',a.title,'excerpt',a.excerpt,'body',a.body,'category',a.category,'tags',a.tags,
    'authorName',a.author_name,'coverUrl',a.cover_url,'featured',a.featured,'readingMinutes',a.reading_minutes,
    'status',a.status,'visibility',a.visibility,'scheduledAt',a.scheduled_at,'seoTitle',a.seo_title,
    'seoDescription',a.seo_description,'canonicalUrl',a.canonical_url,'robots',a.robots,
    'publishedAt',a.published_at,'updatedAt',a.updated_at,
    'builder',jsonb_build_object('documentId',d.id,'blockCount',coalesce(jsonb_array_length(d.draft_document->'blocks'),0),'hasDraft',d.id is not null,'hasPublished',d.published_document is not null,'hasUnpublishedChanges',d.draft_document is distinct from d.published_document,'draftUpdatedAt',d.draft_updated_at,'publishedAt',d.published_at)
  ) order by a.updated_at desc),'[]'::jsonb) into v_articles
  from website.articles a left join website.content_documents d on d.site_id=a.site_id and d.entity_type='article' and d.entity_id=a.id
  where a.site_id=v_site.id and a.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'url',x.public_url,'fileName',x.file_name,'mimeType',x.mime_type,'sizeBytes',x.size_bytes,'width',x.width,'height',x.height,'altText',x.alt_text,'caption',x.caption,'createdAt',x.created_at) order by x.created_at desc),'[]'::jsonb) into v_assets
  from (select * from website.assets where site_id=v_site.id and status='active' order by created_at desc limit 240) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'parentId',c.parent_id,'name',c.name,'slug',c.slug,'description',c.description,'sortOrder',c.sort_order) order by c.sort_order,c.name),'[]'::jsonb) into v_categories
  from website.article_categories c where c.site_id=v_site.id and c.status='active';
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'reference',s.reference_key,'name',s.name,'email',s.email,'phone',s.phone,'organization',s.organization,'message',s.message,'sourcePage',s.source_page,'status',s.status,'createdAt',s.created_at) order by s.created_at desc),'[]'::jsonb) into v_submissions
  from (select * from website.contact_submissions where site_id=v_site.id and status<>'archived' order by created_at desc limit 100) s;

  return jsonb_build_object(
    'context',jsonb_build_object('scope',v_site.site_scope,'siteKey',v_site.site_key,'siteId',v_site.id,'tenantId',v_site.tenant_id,'tenantSlug',p_tenant_slug,'canPublish',v_can_publish,'cmsVersion',v_site.cms_version,'addonStatus',v_site.addon_status),
    'site',jsonb_build_object('id',v_site.id,'siteKey',v_site.site_key,'nameAr',v_site.name_ar,'nameEn',v_site.name_en,'status',v_site.status,'settings',v_site.settings,'theme',v_site.theme,'locale',v_site.locale,'primaryDomain',v_site.primary_domain,'updatedAt',v_site.updated_at),
    'stats',jsonb_build_object('pages',(select count(*) from website.pages p where p.site_id=v_site.id and p.status<>'archived'),'publishedPages',(select count(*) from website.pages p where p.site_id=v_site.id and p.status='published'),'articles',(select count(*) from website.articles a where a.site_id=v_site.id and a.status<>'archived'),'publishedArticles',(select count(*) from website.articles a where a.site_id=v_site.id and a.status='published'),'menus',(select count(*) from website.menus m where m.site_id=v_site.id and m.status<>'archived'),'assets',(select count(*) from website.assets a where a.site_id=v_site.id and a.status='active'),'newMessages',(select count(*) from website.contact_submissions s where s.site_id=v_site.id and s.status='new')),
    'pages',v_pages,'menus',v_menus,'menuItems',v_items,'articles',v_articles,'assets',v_assets,'categories',v_categories,'submissions',v_submissions
  );
end $$;
revoke all on function public.v3_cms_workspace_snapshot(text,text) from public,anon,authenticated;
grant execute on function public.v3_cms_workspace_snapshot(text,text) to authenticated;

commit;
