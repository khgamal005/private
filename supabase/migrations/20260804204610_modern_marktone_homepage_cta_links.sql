begin;

do $$
declare
  v_site_id uuid;
  v_page_id uuid;
  v_document jsonb;
  v_css text;
begin
  select id into v_site_id
  from website.sites
  where site_key='marktone-main'
  limit 1;

  select id,content into v_page_id,v_document
  from website.pages
  where site_id=v_site_id
    and is_home
    and status<>'archived'
  limit 1
  for update;

  if v_page_id is null then
    raise exception 'marktone_home_page_not_found';
  end if;

  -- Public button groups are emitted as explicit anchors so the primary
  -- conversion actions remain clickable outside Builder edit mode.
  v_document:=jsonb_set(
    v_document,
    '{blocks,0,props,items,0,modules,1,type}',
    '"html"'::jsonb,
    false
  );
  v_document:=jsonb_set(
    v_document,
    '{blocks,0,props,items,0,modules,1,props}',
    jsonb_build_object(
      'anchor','',
      'content','<div class="mt-static-actions"><a class="mt-primary-action" href="/free-trial">ابدأ التجربة المجانية <span>↗</span></a><a class="mt-secondary-action" href="#contact">احجز عرضًا توضيحيًا <span>↗</span></a></div>'
    ),
    false
  );

  v_document:=jsonb_set(
    v_document,
    '{blocks,4,props,items,0,modules,1,type}',
    '"html"'::jsonb,
    false
  );
  v_document:=jsonb_set(
    v_document,
    '{blocks,4,props,items,0,modules,1,props}',
    jsonb_build_object(
      'anchor','',
      'content','<div class="mt-static-actions"><a class="mt-primary-action" href="/free-trial">شاهد المنصة عمليًا <span>↗</span></a><a class="mt-secondary-action" href="#platform">تعرّف على الوحدات <span>↗</span></a></div>'
    ),
    false
  );

  v_css:=coalesce(v_document->'settings'->>'customCss','');
  if position('.mt-static-actions{' in v_css)=0 then
    v_css:=v_css||E'\n.mt-static-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.mt-static-actions a{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 20px;border:1px solid transparent;border-radius:12px;font-size:13px;font-weight:850;text-decoration:none;transition:transform .2s ease,box-shadow .2s ease}.mt-static-actions a:hover{transform:translateY(-2px)}.mt-command-actions .mt-secondary-action{color:#fff!important;border-color:#ffffff45!important;background:transparent!important}@media(max-width:700px){.mt-static-actions{display:grid}.mt-static-actions a{width:100%}}';
  end if;
  v_document:=jsonb_set(v_document,'{settings,customCss}',to_jsonb(v_css),true);
  v_document:=private_app.website_builder_validate_document(v_document);

  update website.pages
  set content=v_document,
      updated_at=now()
  where id=v_page_id;

  update website.content_documents
  set draft_document=v_document,
      published_document=v_document,
      draft_updated_at=now(),
      published_at=now(),
      updated_at=now()
  where site_id=v_site_id
    and entity_type='page'
    and entity_id=v_page_id;
end
$$;

commit;
