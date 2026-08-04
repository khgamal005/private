begin;
do $$
declare
  v_site_id uuid;
  v_page_id uuid;
  v_document_id uuid;
  v_primary_menu_id uuid;
  v_document jsonb;
  v_version integer;
begin
  select id into v_site_id from website.sites where site_key='marktone-main' limit 1;
  select id,content into v_page_id,v_document
  from website.pages
  where site_id=v_site_id and is_home and status<>'archived'
  limit 1;

  if v_page_id is null then raise exception 'marktone_home_page_not_found'; end if;
  v_document:=private_app.website_builder_validate_document(v_document);

  if jsonb_array_length(coalesce(v_document->'blocks','[]'::jsonb))<>12 then
    raise exception 'marktone_homepage_block_count_invalid';
  end if;

  update website.pages
  set content=v_document,status='published',published_at=now(),updated_at=now()
  where id=v_page_id;

  update website.content_documents
  set schema_version=1,draft_document=v_document,published_document=v_document,
      draft_updated_at=now(),published_at=now(),updated_at=now()
  where site_id=v_site_id and entity_type='page' and entity_id=v_page_id
  returning id into v_document_id;

  select coalesce(max(version_number),0)+1 into v_version
  from website.content_document_versions
  where content_document_id=v_document_id;

  insert into website.content_document_versions(
    content_document_id,version_number,version_kind,document,note,created_by_subject_id
  ) values(
    v_document_id,v_version,'published',v_document,
    'إعادة تصميم الصفحة الرئيسية لماركتون — إصدار 2026',null
  );

  select id into v_primary_menu_id
  from website.menus
  where site_id=v_site_id and location='header'
  order by case when menu_key='primary' then 0 else 1 end
  limit 1;

  if v_primary_menu_id is not null then
    delete from website.menu_items where menu_id=v_primary_menu_id;
    insert into website.menu_items(
      site_id,menu_id,label,href,item_kind,open_in_new_tab,
      sort_order,is_visible,status,description,icon
    ) values
      (v_site_id,v_primary_menu_id,'الرئيسية','#home','anchor',false,10,true,'published','الصفحة الرئيسية','⌂'),
      (v_site_id,v_primary_menu_id,'الحلول','#solutions','anchor',false,20,true,'published','حلول ماركتون المتكاملة','◇'),
      (v_site_id,v_primary_menu_id,'المنصة','#platform','anchor',false,30,true,'published','وحدات المنصة','▦'),
      (v_site_id,v_primary_menu_id,'كيف تعمل؟','#how','anchor',false,40,true,'published','خطوات البدء','↗'),
      (v_site_id,v_primary_menu_id,'لماذا ماركتون؟','#why','anchor',false,50,true,'published','ما يميز ماركتون','✦'),
      (v_site_id,v_primary_menu_id,'الأسئلة الشائعة','#faq','anchor',false,60,true,'published','إجابات قبل البدء','?'),
      (v_site_id,v_primary_menu_id,'تواصل معنا','#contact','anchor',false,70,true,'published','تواصل مع فريق ماركتون','✉');
  end if;
end
$$;
commit;
