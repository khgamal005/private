begin;

-- Correct the policy hero contrast without touching tenant websites or data.
do $$
declare
  v_site_id uuid;
  v_page_id uuid;
  v_document_id uuid;
  v_previous_published jsonb;
  v_existing_draft jsonb;
  v_document jsonb;
  v_css text;
  v_preserve_draft boolean;
begin
  select
    site.id,page.id,document.id,
    document.published_document,document.draft_document
  into
    v_site_id,v_page_id,v_document_id,
    v_previous_published,v_existing_draft
  from website.sites site
  join website.pages page on page.site_id=site.id
  join website.content_documents document
    on document.site_id=site.id
   and document.entity_type='page'
   and document.entity_id=page.id
  where site.site_key='marktone-main'
    and site.site_scope='platform'
    and site.tenant_id is null
    and page.slug='information-security'
    and page.page_kind='legal'
    and page.status<>'archived'
  limit 1
  for update of document;

  if v_site_id is null or v_previous_published is null then
    raise exception 'odeir_information_security_page_not_found';
  end if;

  -- Keep the same document -> page lock order used by the publication migration.
  perform 1
  from website.pages page
  where page.id=v_page_id
    and page.site_id=v_site_id
    and page.slug='information-security'
    and page.page_kind='legal'
    and page.status<>'archived'
  for update;

  if not found then
    raise exception 'odeir_information_security_page_changed';
  end if;

  v_css:=coalesce(v_previous_published#>>'{settings,customCss}','');

  if position('.odeir-security-hero{min-height:560px!important;' in v_css)=0
     or position('.odeir-security-hero h1{max-width:' in v_css)=0
     or position('.odeir-security-hero p{max-width:760px}' in v_css)=0
     or position('.odeir-security-hero a:last-of-type{border-color:' in v_css)=0 then
    raise exception 'odeir_information_security_contrast_source_changed';
  end if;

  v_css:=replace(
    v_css,
    '.odeir-security-hero{min-height:560px!important;',
    '.odeir-security-hero{color:#fff!important;min-height:560px!important;'
  );
  v_css:=replace(
    v_css,
    '.odeir-security-hero h1{max-width:',
    '.odeir-security-hero h1{color:#fff!important;max-width:'
  );
  v_css:=replace(
    v_css,
    '.odeir-security-hero p{max-width:760px}',
    '.odeir-security-hero p{max-width:760px}.odeir-security-hero h1+p{color:#dce8f3!important;opacity:.86!important}'
  );
  v_css:=replace(
    v_css,
    '.odeir-security-hero a:last-of-type{border-color:',
    '.odeir-security-hero a:last-of-type{color:#fff!important;border-color:'
  );

  v_document:=private_app.website_builder_validate_document(
    jsonb_set(
      v_previous_published,
      '{settings,customCss}',
      to_jsonb(v_css),
      false
    )
  );

  v_preserve_draft:=v_existing_draft is not null
    and v_existing_draft is distinct from v_previous_published;

  update website.pages
  set content=v_document,updated_at=now()
  where id=v_page_id and site_id=v_site_id;

  update website.content_documents
  set published_document=v_document,
      draft_document=case
        when v_preserve_draft then draft_document else v_document
      end,
      draft_updated_at=case
        when v_preserve_draft then draft_updated_at else now()
      end,
      published_at=now(),updated_at=now()
  where id=v_document_id
    and site_id=v_site_id
    and entity_type='page'
    and entity_id=v_page_id;

  perform private_app.cms_record_version(
    v_document_id,v_document,'published',
    'سياسة أمن المعلومات — تحسين تباين العنوان والأزرار',null
  );
end
$$;

commit;
