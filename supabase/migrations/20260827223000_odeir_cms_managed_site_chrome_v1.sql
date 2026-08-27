begin;

-- Make the CMS the single source of truth for ODEIR's public header and footer.
-- Existing pages, documents and tenant sites are intentionally outside this migration.
do $$
declare
  v_site_id uuid;
  v_header_menu_id uuid;
  v_footer_menu_id uuid;
  v_information_security_page_id uuid;
  v_header_state jsonb;
  v_footer_state jsonb;
  v_page_count_before bigint;
  v_document_count_before bigint;
begin
  select site.id into v_site_id
  from website.sites site
  where site.site_key='marktone-main' and site.site_scope='platform'
  limit 1;

  if v_site_id is null then
    raise exception 'odeir_cms_managed_chrome_site_missing';
  end if;

  select menu.id into v_header_menu_id
  from website.menus menu
  where menu.site_id=v_site_id and menu.menu_key='primary' and menu.location='header'
    and menu.status='published'
  limit 1;

  select menu.id into v_footer_menu_id
  from website.menus menu
  where menu.site_id=v_site_id and menu.menu_key='footer' and menu.location='footer'
    and menu.status='published'
  limit 1;

  if v_header_menu_id is null or v_footer_menu_id is null then
    raise exception 'odeir_cms_managed_chrome_menu_missing';
  end if;

  -- Deterministic lock order prevents a menu edit from interleaving with the migration.
  perform 1
  from website.menus menu
  where menu.id in (v_header_menu_id,v_footer_menu_id)
  order by menu.id
  for update;

  perform 1
  from website.menu_items item
  where item.menu_id in (v_header_menu_id,v_footer_menu_id) and item.status<>'archived'
  order by item.id
  for update;

  if coalesce((select menu.settings->>'managedChromeVersion' from website.menus menu where menu.id=v_header_menu_id),'')='1'
     and coalesce((select menu.settings->>'managedChromeVersion' from website.menus menu where menu.id=v_footer_menu_id),'')='1' then
    return;
  end if;

  select count(*) into v_page_count_before
  from website.pages page where page.site_id=v_site_id;
  select count(*) into v_document_count_before
  from website.content_documents document where document.site_id=v_site_id;

  select coalesce(jsonb_agg(jsonb_build_array(item.label,item.href) order by item.sort_order,item.id),'[]'::jsonb)
  into v_header_state
  from website.menu_items item
  where item.menu_id=v_header_menu_id and item.status='published' and item.is_visible;

  if v_header_state<>jsonb_build_array(
    jsonb_build_array('المنصة','/#capabilities'),
    jsonb_build_array('كيف تبدأ','/#how'),
    jsonb_build_array('الحماية','/#security'),
    jsonb_build_array('الأسئلة الشائعة','/#faq')
  ) then
    raise exception 'odeir_cms_managed_chrome_header_state_changed';
  end if;

  select coalesce(jsonb_agg(jsonb_build_array(item.label,item.href) order by item.sort_order,item.id),'[]'::jsonb)
  into v_footer_state
  from website.menu_items item
  where item.menu_id=v_footer_menu_id and item.status='published' and item.is_visible;

  -- Production currently has seven footer items, while staging already has the
  -- information-security link. Both are known safe starting points.
  if not (
    v_footer_state=jsonb_build_array(
      jsonb_build_array('الرئيسية','/'),
      jsonb_build_array('التسجيل المجاني','/free-trial'),
      jsonb_build_array('سياسة الخصوصية','/p/privacy-policy'),
      jsonb_build_array('شروط الاستخدام','/p/terms-of-use'),
      jsonb_build_array('ملفات الارتباط','/p/cookie-policy'),
      jsonb_build_array('حقوق البيانات','/p/data-rights'),
      jsonb_build_array('تسجيل دخول المنشآت','/login')
    )
    or v_footer_state=jsonb_build_array(
      jsonb_build_array('الرئيسية','/'),
      jsonb_build_array('التسجيل المجاني','/free-trial'),
      jsonb_build_array('سياسة الخصوصية','/p/privacy-policy'),
      jsonb_build_array('أمن المعلومات','/p/information-security'),
      jsonb_build_array('شروط الاستخدام','/p/terms-of-use'),
      jsonb_build_array('ملفات الارتباط','/p/cookie-policy'),
      jsonb_build_array('حقوق البيانات','/p/data-rights'),
      jsonb_build_array('تسجيل دخول المنشآت','/login')
    )
  ) then
    raise exception 'odeir_cms_managed_chrome_footer_state_changed';
  end if;

  -- Keep a recoverable before-image for every item whose label, link or order changes.
  insert into website.content_revisions(
    site_id,entity_type,entity_id,revision_number,snapshot
  )
  select
    item.site_id,'menu_item',item.id,
    coalesce((
      select max(revision.revision_number)
      from website.content_revisions revision
      where revision.entity_type='menu_item' and revision.entity_id=item.id
    ),0)+1,
    to_jsonb(item)
  from website.menu_items item
  where item.menu_id in (v_header_menu_id,v_footer_menu_id)
    and item.status='published' and item.is_visible;

  update website.menu_items item
  set
    label=desired.new_label,
    mobile_label=null,
    href=desired.new_href,
    item_kind='anchor',
    target_page_id=null,
    target_article_id=null,
    parent_id=null,
    column_index=1,
    sort_order=desired.new_order,
    open_in_new_tab=false,
    is_visible=true,
    status='published'
  from (values
    ('المنصة','أول فنجان','/#morning-brief',10),
    ('كيف تبدأ','التكاملات','/#story',20),
    ('الحماية','جولة داخل أودير','/#product',30),
    ('الأسئلة الشائعة','رحلة العميل','/#journey',40)
  ) as desired(old_label,new_label,new_href,new_order)
  where item.menu_id=v_header_menu_id and item.label=desired.old_label
    and item.status='published' and item.is_visible;

  insert into website.menu_items(
    site_id,menu_id,label,href,item_kind,sort_order,is_visible,status
  )
  select v_site_id,v_header_menu_id,desired.label,desired.href,'anchor',desired.sort_order,true,'published'
  from (values
    ('متاجر أودير','/#marketplace',50),
    ('الحماية','/#security',60)
  ) as desired(label,href,sort_order)
  where not exists(
    select 1 from website.menu_items item
    where item.menu_id=v_header_menu_id and item.label=desired.label
      and item.href=desired.href and item.status='published' and item.is_visible
  );

  update website.menu_items item
  set sort_order=desired.new_order
  from (values
    ('الرئيسية',20),
    ('التسجيل المجاني',30),
    ('سياسة الخصوصية',40),
    ('أمن المعلومات',50),
    ('شروط الاستخدام',60),
    ('ملفات الارتباط',70),
    ('حقوق البيانات',80),
    ('تسجيل دخول المنشآت',90)
  ) as desired(label,new_order)
  where item.menu_id=v_footer_menu_id and item.label=desired.label
    and item.status='published' and item.is_visible;

  select page.id into v_information_security_page_id
  from website.pages page
  where page.site_id=v_site_id and page.slug='information-security' and page.status<>'archived'
  limit 1;

  if v_information_security_page_id is null then
    raise exception 'odeir_cms_managed_chrome_information_security_page_missing';
  end if;

  insert into website.menu_items(
    site_id,menu_id,label,href,item_kind,target_page_id,sort_order,is_visible,status
  )
  select
    v_site_id,v_footer_menu_id,'أمن المعلومات','/p/information-security','page',v_information_security_page_id,50,true,'published'
  where not exists(
    select 1 from website.menu_items item
    where item.menu_id=v_footer_menu_id and item.label='أمن المعلومات'
      and item.href='/p/information-security' and item.status='published' and item.is_visible
  );

  insert into website.menu_items(
    site_id,menu_id,label,href,item_kind,sort_order,is_visible,status
  )
  select
    v_site_id,v_footer_menu_id,'الأخبار والمعارف','/articles','system',10,true,'published'
  where not exists(
    select 1 from website.menu_items item
    where item.menu_id=v_footer_menu_id and item.label='الأخبار والمعارف'
      and item.href='/articles' and item.status='published' and item.is_visible
  );

  update website.menus menu
  set settings=coalesce(menu.settings,'{}'::jsonb)||jsonb_build_object(
    'managedChromeVersion',1,
    'managedChromeSource','cms',
    'managedChromeAppliedAt',now()
  )
  where menu.id in (v_header_menu_id,v_footer_menu_id);

  if (select count(*) from website.menu_items item where item.menu_id=v_header_menu_id and item.status='published' and item.is_visible)<>6 then
    raise exception 'odeir_cms_managed_chrome_header_count_invalid';
  end if;
  if (select count(*) from website.menu_items item where item.menu_id=v_footer_menu_id and item.status='published' and item.is_visible)<>9 then
    raise exception 'odeir_cms_managed_chrome_footer_count_invalid';
  end if;
  if (select count(*) from website.pages page where page.site_id=v_site_id)<>v_page_count_before
     or (select count(*) from website.content_documents document where document.site_id=v_site_id)<>v_document_count_before then
    raise exception 'odeir_cms_managed_chrome_content_changed';
  end if;
end;
$$;

commit;
