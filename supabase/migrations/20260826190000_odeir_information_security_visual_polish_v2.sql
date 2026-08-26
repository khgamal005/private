begin;

-- Refine the public ODEIR policy visuals without touching tenant websites or data.
do $$
declare
  v_site_id uuid;
  v_page_id uuid;
  v_document_id uuid;
  v_previous_published jsonb;
  v_existing_draft jsonb;
  v_document jsonb;
  v_css text;
  v_hero_count integer;
  v_hero_index integer;
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

  if position('/*ODEIR_SECURITY_VISUAL_POLISH_V2*/' in v_css)>0 then
    raise exception 'odeir_information_security_visual_polish_already_applied';
  end if;

  if position('.odeir-security-hero{color:#fff!important;min-height:560px!important;' in v_css)=0
     or position('.odeir-security-hero h1{color:#fff!important;max-width:' in v_css)=0
     or position('.odeir-security-hero h1+p{color:#dce8f3!important;opacity:.86!important}' in v_css)=0
     or position('.odeir-security-hero a:last-of-type{color:#fff!important;border-color:' in v_css)=0 then
    raise exception 'odeir_information_security_visual_polish_source_changed';
  end if;

  select count(*),min(item.ordinality)::integer-1
  into v_hero_count,v_hero_index
  from jsonb_array_elements(v_previous_published->'blocks')
    with ordinality as item(value,ordinality)
  where item.value->>'id'='odeir-security-hero';

  if v_hero_count<>1
     or v_previous_published#>>array['blocks',v_hero_index::text,'props','imageUrl']
        <>'/odeir/odeir-logo-dark.png'
     or v_previous_published#>>array['blocks',v_hero_index::text,'props','imageAlt']
        <>'أودير — أمن المعلومات وحماية البيانات' then
    raise exception 'odeir_information_security_visual_polish_hero_changed';
  end if;

  v_css:=v_css||$visual_css$
/*ODEIR_SECURITY_VISUAL_POLISH_V2*/
.odeir-security-hero>div:last-child{position:relative!important;isolation:isolate;overflow:hidden!important;background-image:radial-gradient(circle at 50% 48%,rgba(19,199,209,.16),transparent 34%),radial-gradient(circle,rgba(255,255,255,.07) 1px,transparent 1.5px)!important;background-position:center!important;background-size:cover,18px 18px!important}
.odeir-security-hero>div:last-child:before{content:'';position:absolute;z-index:2;left:50%;bottom:42px;width:min(290px,72%);height:190px;transform:translateX(-50%);border:1px solid rgba(19,199,209,.5);border-radius:28px 28px 38px 38px;background:radial-gradient(circle at 50% 86%,#f0c534 0 6px,rgba(240,197,52,.24) 7px,transparent 14px),url('/odeir/odeir-logo-transparent.webp') center 48%/72% auto no-repeat,linear-gradient(150deg,rgba(11,41,73,.98),rgba(3,19,38,.98));box-shadow:inset 0 1px rgba(255,255,255,.14),inset 0 -22px 44px rgba(0,0,0,.18),0 28px 65px rgba(0,0,0,.28)}
.odeir-security-hero>div:last-child:after{content:'';position:absolute;z-index:1;top:38px;left:50%;width:148px;height:138px;transform:translateX(-50%);border:18px solid rgba(19,199,209,.72);border-bottom:0;border-radius:90px 90px 0 0;background:linear-gradient(180deg,rgba(19,199,209,.08),transparent);box-shadow:0 -1px rgba(255,255,255,.24),inset 0 10px 24px rgba(0,0,0,.18)}
.odeir-security-hero h1+p{color:#dce8f3!important;opacity:.92!important}
.odeir-security-scope h2,.odeir-security-principles h2,.odeir-security-controls h2,.odeir-security-incidents h2,.odeir-security-frameworks h2,.odeir-security-faq h2,.odeir-security-related h2{color:#0b2949!important}
.odeir-security-scope>div:first-child>p:last-child,.odeir-security-principles>div:first-child>p:last-child,.odeir-security-controls>div:first-child>p:last-child,.odeir-security-incidents>div:first-child>p:last-child,.odeir-security-frameworks>div:first-child>p:last-child,.odeir-security-faq>div:first-child>p:last-child,.odeir-security-related>div:first-child>p:last-child{color:#4c657b!important;opacity:1!important;line-height:1.9!important}
.odeir-security-scope>div:first-child>p:first-child,.odeir-security-principles>div:first-child>p:first-child,.odeir-security-controls>div:first-child>p:first-child,.odeir-security-incidents>div:first-child>p:first-child,.odeir-security-frameworks>div:first-child>p:first-child,.odeir-security-faq>div:first-child>p:first-child,.odeir-security-related>div:first-child>p:first-child{color:#806400!important}
.odeir-security-principles>div:last-child,.odeir-security-controls>div:last-child,.odeir-security-data>div:last-child,.odeir-security-frameworks>div:last-child,.odeir-security-related>div:last-child{gap:18px!important;align-items:stretch!important}
.odeir-security-principles article{min-height:218px!important;padding:28px 25px 26px!important;border:1px solid rgba(6,24,46,.1)!important;border-radius:22px!important;background:linear-gradient(180deg,#fff,#f7fbfd)!important;box-shadow:0 18px 48px rgba(6,24,46,.075)!important}
.odeir-security-principles article:before{inset:0 0 auto 0!important;width:100%!important;height:4px!important;background:linear-gradient(90deg,#13c7d1,#08b8b1,#f0c534)!important}
.odeir-security-principles article strong{display:grid!important;place-items:center;width:52px;height:52px;margin-bottom:22px;border-radius:16px;background:#06182e!important;color:#f0c534!important;font-size:15px!important;letter-spacing:.08em;box-shadow:0 10px 22px rgba(6,24,46,.18)}
.odeir-security-principles article h3{color:#0b2949!important;font-size:20px!important;margin-bottom:10px!important}
.odeir-security-principles article p{color:#496279!important;font-size:14px!important;line-height:1.85!important}
.odeir-security-controls>div:last-child{grid-template-columns:repeat(2,minmax(0,1fr))!important}
.odeir-security-controls article,.odeir-security-frameworks article,.odeir-security-related article{padding:27px!important;border:1px solid rgba(6,24,46,.105)!important;border-radius:22px!important;background:linear-gradient(160deg,#fff 0%,#f8fbfd 100%)!important;box-shadow:0 18px 48px rgba(6,24,46,.07)!important}
.odeir-security-controls article{min-height:205px!important}
.odeir-security-frameworks article{display:flex!important;min-height:260px!important;flex-direction:column!important}
.odeir-security-related article{display:flex!important;min-height:196px!important;flex-direction:column!important}
.odeir-security-controls article:nth-child(even),.odeir-security-frameworks article:nth-child(even),.odeir-security-related article:nth-child(even){background:linear-gradient(160deg,#fff 0%,#f1fbfa 100%)!important}
.odeir-security-controls article>span:first-child,.odeir-security-frameworks article>span:first-child,.odeir-security-related article>span:first-child,.odeir-security-data article>span:first-child{display:grid!important;place-items:center;width:46px;height:46px;margin-bottom:23px;border:1px solid rgba(8,184,177,.22);border-radius:15px;background:#eafaf9!important;color:#067f80!important;font-size:17px!important}
.odeir-security-controls article>small,.odeir-security-frameworks article>small,.odeir-security-related article>small,.odeir-security-data article>small{position:absolute;top:29px;left:27px;color:#60788e!important;font-size:11px!important;font-weight:900!important;letter-spacing:.14em}
.odeir-security-controls article h3,.odeir-security-frameworks article h3,.odeir-security-related article h3{color:#0b2949!important;font-size:18px!important;line-height:1.55!important}
.odeir-security-controls article p,.odeir-security-frameworks article p,.odeir-security-related article p{color:#496279!important;font-size:14px!important;line-height:1.85!important}
.odeir-security-frameworks article a,.odeir-security-related article a{display:inline-flex!important;align-items:center;gap:6px;margin-top:auto!important;padding-top:16px;color:#076f70!important;text-decoration:none!important}
.odeir-security-data{color:#fff!important;background:radial-gradient(circle at 85% 12%,rgba(19,199,209,.15),transparent 28%),linear-gradient(145deg,#04172d,#0b2949)!important}
.odeir-security-data>div:first-child h2{color:#fff!important;text-shadow:0 1px 20px rgba(0,0,0,.2)}
.odeir-security-data>div:first-child>p:first-child{color:#f0c534!important}
.odeir-security-data>div:first-child>p:last-child{color:#dce8f3!important;opacity:.9!important;line-height:1.9!important}
.odeir-security-data article{min-height:205px!important;padding:27px!important;border:1px solid rgba(255,255,255,.14)!important;border-radius:22px!important;background:linear-gradient(145deg,rgba(255,255,255,.09),rgba(255,255,255,.045))!important;box-shadow:inset 0 1px rgba(255,255,255,.08),0 18px 48px rgba(0,0,0,.12)!important}
.odeir-security-data article>span:first-child{border-color:rgba(19,199,209,.35)!important;background:rgba(19,199,209,.13)!important;color:#79ece8!important}
.odeir-security-data article>small{color:#f0c534!important}
.odeir-security-data article h3{color:#fff!important;font-size:19px!important}
.odeir-security-data article p{color:#dce8f3!important;opacity:.88!important;font-size:14px!important;line-height:1.9!important}
.odeir-security-incidents>div:last-child{display:grid!important;gap:13px!important}
.odeir-security-incidents article{display:grid!important;grid-template-columns:58px minmax(0,1fr)!important;align-items:start!important;gap:18px!important;min-height:104px;padding:22px!important;border:1px solid rgba(6,24,46,.095)!important;border-radius:18px!important;background:#fff!important;box-shadow:0 14px 36px rgba(6,24,46,.055)!important}
.odeir-security-incidents article>strong{display:grid!important;place-items:center;width:54px;height:54px;border-radius:16px!important;background:linear-gradient(145deg,#06182e,#0b2949)!important;color:#f0c534!important;font-size:13px!important;box-shadow:0 10px 24px rgba(6,24,46,.18)}
.odeir-security-incidents article h3{color:#0b2949!important;font-size:17px!important;margin-bottom:5px!important}
.odeir-security-incidents article p{color:#506a80!important;font-size:13.5px!important;line-height:1.85!important}
.odeir-security-responsibility-heading h2,.odeir-security-responsibility-heading>div>p:last-child{color:#fff!important}
.odeir-security-responsibility-heading>div>p:first-child{color:#f0c534!important}
.odeir-security-responsibility>div{overflow:hidden;border:1px solid rgba(255,255,255,.16)!important;border-radius:22px!important;background:rgba(255,255,255,.045)!important;box-shadow:0 24px 70px rgba(0,0,0,.18)}
.odeir-security-responsibility>div>h3{padding:22px 24px;margin:0!important;color:#f0c534!important;background:rgba(255,255,255,.035)!important}
.odeir-security-responsibility th{padding:17px!important;background:#0d345b!important;color:#f0c534!important;font-size:13px!important}
.odeir-security-responsibility td{padding:17px!important;color:#dce8f3!important;font-size:13px!important;line-height:1.9!important}
.odeir-security-faq details{overflow:hidden!important;border:1px solid rgba(6,24,46,.1)!important;border-radius:16px!important;background:#fff!important;box-shadow:0 10px 28px rgba(6,24,46,.035)}
.odeir-security-faq summary{min-height:62px!important;padding:14px 17px!important}
.odeir-security-faq summary>span:first-child{color:#15334f!important;font-weight:800!important}
.odeir-security-faq summary>span:last-child{display:grid!important;place-items:center;width:34px;height:34px;border-radius:11px;background:#06182e!important;color:#f0c534!important;font-size:18px!important}
.odeir-security-faq details>p{padding:0 18px 18px!important;color:#4d667d!important;line-height:1.9!important}
.odeir-security-framework-note>div{color:#24435e!important}
.odeir-security-legal-note>div{color:#3f566b!important}
@media(max-width:900px){.odeir-security-principles>div:last-child,.odeir-security-controls>div:last-child,.odeir-security-frameworks>div:last-child{grid-template-columns:repeat(2,minmax(0,1fr))!important}.odeir-security-hero>div:last-child:before{width:235px;height:165px;bottom:36px}.odeir-security-hero>div:last-child:after{top:34px;width:126px;height:118px;border-width:15px}}
@media(max-width:620px){.odeir-security-hero>div:last-child{min-height:280px!important}.odeir-security-hero>div:last-child:before{width:215px;height:148px;bottom:28px;border-radius:23px 23px 30px 30px}.odeir-security-hero>div:last-child:after{top:31px;width:112px;height:100px;border-width:14px}.odeir-security-principles>div:last-child,.odeir-security-controls>div:last-child,.odeir-security-data>div:last-child,.odeir-security-frameworks>div:last-child,.odeir-security-related>div:last-child{grid-template-columns:1fr!important}.odeir-security-principles article,.odeir-security-controls article,.odeir-security-data article,.odeir-security-frameworks article,.odeir-security-related article{min-height:0!important;padding:23px!important}.odeir-security-controls article>small,.odeir-security-data article>small,.odeir-security-frameworks article>small,.odeir-security-related article>small{top:25px;left:23px}.odeir-security-incidents article{grid-template-columns:50px minmax(0,1fr)!important;gap:14px!important;padding:18px!important}.odeir-security-incidents article>strong{width:48px;height:48px;border-radius:14px!important}.odeir-security-responsibility td,.odeir-security-responsibility th{padding:13px!important}}
@media(prefers-reduced-motion:reduce){.odeir-security-controls article,.odeir-security-frameworks article,.odeir-security-related article{transition:none!important}}
$visual_css$;

  v_document:=jsonb_set(
    v_previous_published,
    '{settings,customCss}',
    to_jsonb(v_css),
    false
  );
  v_document:=jsonb_set(
    v_document,
    array['blocks',v_hero_index::text,'props','imageUrl'],
    to_jsonb('/odeir/odeir-logo-transparent.webp'::text),
    false
  );
  v_document:=jsonb_set(
    v_document,
    array['blocks',v_hero_index::text,'props','imageAlt'],
    to_jsonb('قفل أمني يحمل شعار أودير'::text),
    false
  );
  v_document:=private_app.website_builder_validate_document(v_document);

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
    'سياسة أمن المعلومات — ضبط البطاقات والتباين ورسم القفل الأمني',null
  );
end
$$;

commit;
