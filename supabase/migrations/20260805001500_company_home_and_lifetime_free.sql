begin;

do $$
declare
  v_site_id uuid;
  v_home_page_id uuid;
  v_free_page_id uuid;
  v_home_document_id uuid;
  v_free_document_id uuid;
  v_primary_menu_id uuid;
  v_current_home jsonb;
  v_trial_document jsonb;
  v_company_document jsonb;
  v_version integer;
begin
  select id into v_site_id
  from website.sites
  where site_key='marktone-main'
  limit 1;

  if v_site_id is null then
    raise exception 'marktone_main_site_not_found';
  end if;

  select id,content into v_home_page_id,v_current_home
  from website.pages
  where site_id=v_site_id and is_home and status<>'archived'
  limit 1;

  if v_home_page_id is null then
    raise exception 'marktone_home_page_not_found';
  end if;

  -- Move the current platform-focused homepage into a dedicated lifetime-free program page.
  v_trial_document:=v_current_home;
  v_trial_document:=replace(v_trial_document::text,'منصة التشغيل والنمو المتخصصة لقطاع التدريب','البرنامج المجاني لمنشآت التدريب')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'شغّل مركزك. نمِّ مبيعاتك. واتخذ القرار','شغّل مركزك مجانًا. نمِّ مبيعاتك. واتخذ القرار')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'من مكان واحد.','مدى الحياة.')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'ابدأ التجربة المجانية','ابدأ مجانًا مدى الحياة')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'تجربة مجانية بدون بطاقة','مجاني مدى الحياة بدون بطاقة')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'شاهد المنصة عمليًا','فعّل حسابك المجاني')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'ابدأ تجربة ماركتون، أو شاركنا التحدي الحالي لنقترح مسارًا مناسبًا وواضحًا.','ابدأ استخدام ماركتون مجانًا مدى الحياة، ثم أضف الخدمات والتكاملات فقط عندما تحتاج إليها.')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'ابدأ من اليوم','مجاني مدى الحياة')::jsonb;
  v_trial_document:=replace(v_trial_document::text,'/free-trial','/free-trial/apply')::jsonb;
  v_trial_document:=jsonb_set(
    v_trial_document,
    '{settings,customCss}',
    to_jsonb(coalesce(v_trial_document->'settings'->>'customCss','')||E'\n.mt-home-hero-row:after{content:"مجاني مدى الحياة";position:absolute;top:108px;left:5%;z-index:3;padding:9px 14px;border-radius:999px;background:#ffc928;color:#06182e;font-size:11px;font-weight:950;box-shadow:0 14px 35px rgba(255,201,40,.26)}\n.mt-home-hero-heading p:last-child:after{content:" الحساب الأساسي بلا رسوم اشتراك أو مدة انتهاء، مع إضافات اختيارية عند الحاجة.";color:#087f7a;font-weight:800}\n@media(max-width:700px){.mt-home-hero-row:after{top:92px;left:16px}}'),
    true
  );
  v_trial_document:=private_app.website_builder_validate_document(v_trial_document);

  select id into v_free_page_id
  from website.pages
  where site_id=v_site_id and slug='free-trial' and status<>'archived'
  limit 1;

  if v_free_page_id is null then
    insert into website.pages(
      site_id,slug,title,menu_label,excerpt,body,content,template_key,
      seo_title,seo_description,show_in_menu,menu_order,status,published_at,
      page_kind,sort_order,is_home,visibility,layout_settings,canonical_url,robots
    ) values(
      v_site_id,'free-trial','برنامج ماركتون المجاني','البرنامج المجاني',
      'برنامج تشغيل أساسي مجاني لمنشآت التدريب دون بطاقة بنكية أو مدة انتهاء.',
      '',v_trial_document,'builder',
      'برنامج ماركتون المجاني مدى الحياة',
      'شغّل مركزك وأدر العملاء والمهام والتسجيل والدورات والتقارير بحساب أساسي مجاني مدى الحياة.',
      false,90,'published',now(),'landing',90,false,'public','{}'::jsonb,'/free-trial','index,follow'
    ) returning id into v_free_page_id;
  else
    update website.pages
    set title='برنامج ماركتون المجاني',menu_label='البرنامج المجاني',
        excerpt='برنامج تشغيل أساسي مجاني لمنشآت التدريب دون بطاقة بنكية أو مدة انتهاء.',
        content=v_trial_document,template_key='builder',
        seo_title='برنامج ماركتون المجاني مدى الحياة',
        seo_description='شغّل مركزك وأدر العملاء والمهام والتسجيل والدورات والتقارير بحساب أساسي مجاني مدى الحياة.',
        status='published',published_at=now(),page_kind='landing',visibility='public',
        canonical_url='/free-trial',robots='index,follow',updated_at=now()
    where id=v_free_page_id;
  end if;

  select id into v_free_document_id
  from website.content_documents
  where site_id=v_site_id and entity_type='page' and entity_id=v_free_page_id
  limit 1;

  if v_free_document_id is null then
    insert into website.content_documents(
      site_id,entity_type,entity_id,schema_version,draft_document,published_document,
      draft_updated_at,published_at
    ) values(
      v_site_id,'page',v_free_page_id,1,v_trial_document,v_trial_document,now(),now()
    ) returning id into v_free_document_id;
  else
    update website.content_documents
    set schema_version=1,draft_document=v_trial_document,published_document=v_trial_document,
        draft_updated_at=now(),published_at=now(),updated_at=now()
    where id=v_free_document_id;
  end if;

  select coalesce(max(version_number),0)+1 into v_version
  from website.content_document_versions
  where content_document_id=v_free_document_id;

  insert into website.content_document_versions(
    content_document_id,version_number,version_kind,document,note
  ) values(
    v_free_document_id,v_version,'published',v_trial_document,
    'نقل تصميم المنصة إلى صفحة البرنامج المجاني مدى الحياة'
  );

  -- New company-services homepage, based on the service portfolio published on marktone.sa.
  v_company_document:=private_app.website_builder_validate_document($doc$
  {
    "schemaVersion":1,
    "settings":{
      "contentWidth":"wide",
      "background":"#02050b",
      "customCss":":root{--co-black:#02050b;--co-navy:#061426;--co-navy2:#0a213b;--co-teal:#08b8b1;--co-cyan:#20c6cf;--co-yellow:#ffc928;--co-white:#f8fbff;--co-muted:#9cafc2;--co-line:rgba(255,255,255,.10)}html{scroll-behavior:smooth}.company-hero{position:relative;overflow:hidden;padding:148px 0 105px!important;background:radial-gradient(circle at 8% 12%,rgba(8,184,177,.20),transparent 28%),radial-gradient(circle at 90% 8%,rgba(255,201,40,.12),transparent 24%),linear-gradient(140deg,#010309 0%,#061426 55%,#020710 100%)!important;color:#fff!important}.company-hero:before{content:\"\";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:54px 54px;mask-image:linear-gradient(to bottom,#000,transparent 80%)}.company-hero>div{position:relative;z-index:1}.company-hero-copy{padding:0!important}.company-hero-copy p:first-child{display:inline-flex!important;padding:8px 13px!important;border:1px solid rgba(32,198,207,.34);background:rgba(8,184,177,.11);color:#6fe8e1!important;border-radius:999px;font-size:10px!important;font-weight:950!important}.company-hero-copy h1{color:#fff!important;font-size:clamp(48px,5.4vw,78px)!important;line-height:1.12!important;letter-spacing:-.045em!important;max-width:760px}.company-hero-copy span{display:block!important;color:var(--co-yellow)!important;font-size:clamp(31px,3.8vw,54px)!important;margin-top:8px!important}.company-hero-copy p:last-child{color:#b4c4d2!important;font-size:17px!important;line-height:1.95!important;max-width:720px}.company-actions{display:flex;gap:11px;flex-wrap:wrap;margin:26px 0 18px}.company-actions a{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:0 22px;border-radius:12px;text-decoration:none;font-size:12px;font-weight:900}.company-actions a:first-child{background:linear-gradient(135deg,var(--co-teal),#087d9a);color:#fff;box-shadow:0 17px 38px rgba(8,184,177,.22)}.company-actions a:last-child{border:1px solid rgba(255,255,255,.20);color:#fff;background:rgba(255,255,255,.04)}.company-chips{display:flex;gap:9px;flex-wrap:wrap}.company-chips span{display:inline-flex!important;margin:0!important;padding:8px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.045);color:#9fb2c4!important;font-size:9px!important}.company-visual{padding:0!important}.company-orbit{position:relative;min-height:520px;border:1px solid rgba(255,255,255,.11);border-radius:30px;background:radial-gradient(circle at 50% 48%,rgba(8,184,177,.18),transparent 30%),rgba(255,255,255,.035);box-shadow:0 42px 110px rgba(0,0,0,.36);overflow:hidden}.company-orbit:before,.company-orbit:after{content:\"\";position:absolute;border:1px solid rgba(32,198,207,.18);border-radius:50%;inset:14%}.company-orbit:after{inset:27%;border-color:rgba(255,201,40,.20)}.company-core{position:absolute;inset:50% auto auto 50%;transform:translate(-50%,-50%);width:150px;height:150px;border-radius:42px;display:grid;place-items:center;background:linear-gradient(145deg,#0b2949,#03101f);border:1px solid rgba(255,255,255,.14);box-shadow:0 25px 65px #0008;z-index:3}.company-core b{font-size:53px;color:#fff}.company-core small{font-size:9px;color:#70e4de;letter-spacing:.12em}.company-node{position:absolute;z-index:4;min-width:126px;padding:13px;border-radius:14px;background:#07182b;border:1px solid rgba(255,255,255,.12);box-shadow:0 14px 40px rgba(0,0,0,.25);display:grid;gap:3px}.company-node b{font-size:10px;color:#fff}.company-node small{font-size:8px;color:#8fa6ba}.company-node i{font-style:normal;color:var(--co-yellow);font-size:16px}.n1{top:9%;right:12%}.n2{top:13%;left:9%}.n3{top:43%;right:3%}.n4{top:45%;left:3%}.n5{bottom:10%;right:13%}.n6{bottom:8%;left:12%}.company-strip{padding:28px 0!important;background:#020710!important;border-top:1px solid var(--co-line);border-bottom:1px solid var(--co-line)}.company-strip-content{padding:0!important}.company-strip-content .statsGrid article{border-color:rgba(255,255,255,.10)!important}.company-strip-content strong{color:var(--co-yellow)!important}.company-strip-content h3{color:#fff!important}.company-strip-content p{color:#8095a8!important}.company-about{padding:105px 0!important;background:linear-gradient(180deg,#071426,#030812)!important;color:#fff!important}.company-about-copy{padding:0!important}.company-about-copy h2{color:#fff!important;font-size:clamp(38px,4vw,58px)!important}.company-about-copy p:first-child{color:var(--co-teal)!important}.company-about-copy p:last-child{color:#a9bbca!important;font-size:16px!important;line-height:1.95!important}.company-manifesto{height:100%;border-radius:24px;padding:30px;background:linear-gradient(145deg,rgba(255,255,255,.07),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.11);display:grid;gap:18px}.company-manifesto>span{color:var(--co-yellow);font-size:10px;font-weight:900}.company-manifesto h3{font-size:28px;line-height:1.35;margin:0}.company-manifesto p{color:#a6b8c7;line-height:1.85;margin:0}.company-manifesto div{display:grid;grid-template-columns:1fr 1fr;gap:9px}.company-manifesto div span{padding:12px;border-radius:11px;background:rgba(255,255,255,.05);font-size:9px;color:#c3d1dc}.company-services{padding:110px 0!important;background:#f5f8fb!important}.company-section-title{padding:0 0 28px!important}.company-section-title h2{font-size:clamp(38px,4.2vw,60px)!important;color:#061426!important}.company-section-title p:first-child{color:#087f7a!important;font-weight:950!important}.company-section-title p:last-child{color:#61758a!important;line-height:1.9!important;max-width:780px;margin-inline:auto}.company-services-grid{padding:0!important}.company-services-grid article{min-height:245px!important;border-radius:20px!important;border:1px solid #dfe8ef!important;background:#fff!important;box-shadow:0 15px 45px rgba(5,31,55,.06)!important;transition:.25s!important}.company-services-grid article:hover{transform:translateY(-6px)!important;border-color:#9ddfd9!important;box-shadow:0 28px 70px rgba(5,31,55,.12)!important}.company-services-grid article>span:first-child{color:var(--co-teal)!important}.company-services-grid article h3{font-size:19px!important;color:#071d37!important}.company-services-grid article p{color:#687c8e!important;line-height:1.75!important}.company-method{padding:105px 0!important;background:#fff!important}.company-method-timeline{padding:10px 0!important}.company-method-timeline strong{background:linear-gradient(135deg,var(--co-teal),#087d9a)!important;color:#fff!important}.company-method-timeline h3{color:#071d37!important}.company-method-timeline p{color:#667b8e!important}.company-system{padding:105px 0!important;background:radial-gradient(circle at 86% 16%,rgba(8,184,177,.14),transparent 28%),linear-gradient(140deg,#01040a,#071a30)!important;color:#fff!important}.company-system-title{padding:0!important}.company-system-title h2{color:#fff!important;font-size:clamp(40px,4.5vw,62px)!important}.company-system-title p:first-child{color:var(--co-yellow)!important}.company-system-title p:last-child{color:#a9bac8!important;line-height:1.9!important}.company-system-title span{color:var(--co-teal)!important}.company-flow{border-radius:25px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.11);padding:24px;display:grid;gap:10px}.company-flow article{display:grid;grid-template-columns:44px 1fr auto;gap:12px;align-items:center;padding:14px;border-radius:13px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.075)}.company-flow i{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;background:rgba(8,184,177,.13);color:#62e1da;font-style:normal;font-weight:900}.company-flow b{display:block;font-size:11px}.company-flow span{font-size:8px;color:#91a7ba}.company-flow em{font-style:normal;font-size:8px;color:#ffc928}.company-stats{padding:48px 0!important;background:#020710!important;color:#fff!important}.company-stats .statsGrid article{border-color:rgba(255,255,255,.10)!important}.company-stats strong{color:var(--co-yellow)!important}.company-stats h3{color:#fff!important}.company-stats p{color:#8599aa!important}.company-free{padding:90px 0!important;background:linear-gradient(120deg,#08b8b1,#087f93)!important}.company-free-card{padding:0!important}.company-free-card>div{border-radius:27px!important;background:linear-gradient(135deg,#061426,#02050b)!important;box-shadow:0 30px 85px rgba(0,0,0,.25)!important}.company-free-card h2{font-size:clamp(36px,4vw,54px)!important}.company-free-card a{background:var(--co-yellow)!important;color:#061426!important;border-radius:12px!important}.company-faq{padding:100px 0!important;background:#f5f8fb!important}.company-faq-list{padding:0!important}.company-faq-list details{background:#fff!important;border:1px solid #dfe8ef!important;border-radius:14px!important;margin-bottom:9px!important}.company-faq-list summary{padding:18px!important;color:#071d37!important;font-weight:850!important}.company-faq-list details p{padding:0 18px 18px!important;color:#687c8e!important}.company-contact{padding:100px 0!important;background:radial-gradient(circle at 10% 90%,rgba(255,201,40,.12),transparent 24%),linear-gradient(145deg,#02050b,#07182b)!important;color:#fff!important}.company-contact-cta{padding:0!important}.company-contact-cta>div{height:100%!important;border-radius:25px!important;background:linear-gradient(135deg,#0a2947,#04101e)!important;border:1px solid rgba(255,255,255,.10)!important}.company-contact-cta h2{font-size:clamp(38px,4vw,56px)!important}.company-contact-cta a{background:var(--co-yellow)!important;color:#061426!important}.company-contact-form{padding:0!important}.company-contact-form>div{border-radius:25px!important;background:#fff!important;box-shadow:0 28px 80px rgba(0,0,0,.25)!important}.company-contact-form h2{color:#071d37!important}@media(max-width:1050px){.company-hero{padding-top:125px!important}.company-orbit{min-height:440px}.company-node{min-width:105px}.company-flow article{grid-template-columns:40px 1fr}.company-flow em{display:none}}@media(max-width:700px){.company-hero{padding:112px 0 70px!important}.company-hero-copy h1{font-size:43px!important}.company-hero-copy span{font-size:29px!important}.company-orbit{min-height:410px}.company-node{min-width:96px;padding:10px}.company-node small{display:none}.company-actions{display:grid}.company-actions a{width:100%}.company-about,.company-services,.company-method,.company-system,.company-free,.company-faq,.company-contact{padding:70px 0!important}.company-manifesto div{grid-template-columns:1fr}.company-flow{padding:14px}}"
    },
    "blocks":[
      {
        "id":"row-company-hero",
        "type":"columns",
        "props":{"anchor":"home","row":true,"layoutKey":"1-1","gap":54,"fullWidth":false,"minHeight":620,"verticalAlign":"center","items":[
          {"id":"col-company-copy","width":"1fr","modules":[
            {"id":"heading-company-hero","type":"fancyHeading","props":{"anchor":"","eyebrow":"MARKTONE — EDUCATION GROWTH PARTNER","title":"نحوّل الطموح التعليمي إلى منظومة تعمل وتنمو","accent":"من التشخيص إلى النتائج.","body":"ماركتون شركة سعودية متخصصة تجمع الاستشارات والتسويق والمبيعات والتقنية والتشغيل في شراكة واحدة صُممت لواقع المؤسسات التعليمية ومراكز التدريب."},"style":{"variant":"dark","align":"right","paddingY":8,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":0,"cssClass":"company-hero-copy"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
            {"id":"html-company-actions","type":"html","props":{"anchor":"","content":"<div class=\"company-actions\"><a href=\"#services\">استكشف خدماتنا <span>↗</span></a><a href=\"#contact\">احجز جلسة تشخيص <span>↗</span></a></div>"},"style":{"variant":"dark","align":"right","paddingY":4,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":120,"cssClass":"company-actions-wrap"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
            {"id":"html-company-chips","type":"html","props":{"anchor":"","content":"<div class=\"company-chips\"><span>خبرة قطاعية تتجاوز 20 عامًا</span><span>حلول متكاملة تحت مظلة واحدة</span><span>فهم محلي بمعايير عالمية</span></div>"},"style":{"variant":"dark","align":"right","paddingY":2,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":220,"cssClass":"company-chips-wrap"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":12,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"center"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
          {"id":"col-company-visual","width":"1fr","modules":[
            {"id":"html-company-orbit","type":"html","props":{"anchor":"","content":"<div class=\"company-orbit\"><div class=\"company-core\"><b>M</b><small>ONE GROWTH SYSTEM</small></div><span class=\"company-node n1\"><i>↗</i><b>التسويق والنمو</b><small>استقطاب وقياس</small></span><span class=\"company-node n2\"><i>◎</i><b>مركز الاتصال</b><small>مبيعات وخدمة عملاء</small></span><span class=\"company-node n3\"><i>▦</i><b>التشغيل والتقنية</b><small>أنظمة وأتمتة</small></span><span class=\"company-node n4\"><i>✦</i><b>الاستشارات والجودة</b><small>حوكمة وISO 21001</small></span><span class=\"company-node n5\"><i>◇</i><b>الشراكات الدولية</b><small>جامعات وبرامج</small></span><span class=\"company-node n6\"><i>⌁</i><b>الحقائب التدريبية</b><small>تطوير علمي ومهني</small></span></div>"},"style":{"variant":"dark","align":"right","paddingY":0,"maxWidth":"full","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"zoom","animationDelay":120,"cssClass":"company-visual"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"center"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"dark","align":"right","paddingY":70,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-hero"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-strip",
        "type":"columns",
        "props":{"anchor":"","row":true,"layoutKey":"1","gap":0,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[
          {"id":"col-company-strip","width":"1fr","modules":[
            {"id":"stats-company-strip","type":"stats","props":{"anchor":"","eyebrow":"","title":"","body":"","columns":4,"items":[{"value":"تشخيص","title":"نفهم قبل أن نقترح","description":"السوق، الفريق، العمليات والبيانات"},{"value":"تصميم","title":"نبني الحل المناسب","description":"لا باقات جامدة ولا قوالب عامة"},{"value":"تنفيذ","title":"نشارك في التشغيل","description":"من الخطة إلى أرض الواقع"},{"value":"قياس","title":"نطوّر بالأرقام","description":"مؤشرات وتقارير وتحسين مستمر"}]},"style":{"variant":"dark","align":"center","paddingY":12,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-strip-content"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"dark","align":"center","paddingY":24,"maxWidth":"full","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-strip"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-about",
        "type":"columns",
        "props":{"anchor":"about","row":true,"layoutKey":"1-1","gap":45,"fullWidth":false,"minHeight":0,"verticalAlign":"center","items":[
          {"id":"col-company-about-copy","width":"1fr","modules":[
            {"id":"heading-company-about","type":"heading","props":{"anchor":"","eyebrow":"من نحن؟","title":"ليست مجموعة خدمات منفصلة؛ بل منظومة نجاح مترابطة","body":"بخبرة تمتد لأكثر من عقدين في التعليم والتدريب، أدركنا أن المؤسسة لا تنمو بالتسويق وحده، ولا بالتقنية وحدها. النجاح يحدث عندما تتكامل الاستراتيجية والناس والعمليات والبيانات في اتجاه واحد.","level":"h2"},"style":{"variant":"dark","align":"right","paddingY":10,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":0,"cssClass":"company-about-copy"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":12,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"center"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
          {"id":"col-company-manifesto","width":"1fr","modules":[
            {"id":"html-company-manifesto","type":"html","props":{"anchor":"","content":"<div class=\"company-manifesto\"><span>وعد ماركتون</span><h3>نفهم مؤسستك أولًا، ثم نبني حولها الحل.</h3><p>نبدأ من التحدي الحقيقي، نحدد الأولويات، ثم نجمع الخبرات والأدوات المناسبة بدل بيع خدمة منفصلة لا تعالج أصل المشكلة.</p><div><span>شركة سعودية متخصصة</span><span>خبرة تعليمية عميقة</span><span>تشغيل وتقنية معًا</span><span>شراكة طويلة المدى</span></div></div>"},"style":{"variant":"dark","align":"right","paddingY":0,"maxWidth":"full","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"slide-left","animationDelay":100,"cssClass":"company-manifesto-wrap"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"dark","align":"right","paddingY":80,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-about"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-services",
        "type":"columns",
        "props":{"anchor":"services","row":true,"layoutKey":"1","gap":18,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[
          {"id":"col-company-services","width":"1fr","modules":[
            {"id":"heading-company-services","type":"heading","props":{"anchor":"","eyebrow":"خدمات متكاملة للمؤسسات التعليمية","title":"ستة مسارات تعمل معًا لتحريك النمو","body":"يمكنك البدء من مسار واحد، أو بناء برنامج تحول متكامل يجمع الاستشارة والتنفيذ والتقنية والقياس تحت إدارة واحدة.","level":"h2"},"style":{"variant":"light","align":"center","paddingY":10,"maxWidth":"reading","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-section-title"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
            {"id":"cards-company-services","type":"cards","props":{"anchor":"","eyebrow":"","title":"","body":"","columns":3,"items":[
              {"title":"مركز الاتصال للمبيعات وخدمة العملاء","description":"فرق مدربة لقطاع التعليم تتولى التواصل والمتابعة والتحويل وخدمة المتدربين وفق مؤشرات أداء واضحة.","href":"#contact"},
              {"title":"تطوير العمليات والحلول التقنية","description":"ميكنة العمليات، أنظمة CRM وERP، أتمتة المهام، منصات التعلم وربط البيانات في مسار واحد.","href":"#contact"},
              {"title":"التسويق التفاعلي والإلكتروني","description":"استراتيجية وحملات ومحتوى وصفحات هبوط وفعاليات تربط الاستحواذ بالمبيعات والنتيجة النهائية.","href":"#contact"},
              {"title":"الاستشارات الإدارية والجودة","description":"هياكل تنظيمية، إجراءات تشغيل، مؤشرات أداء، حوكمة ودعم التأهيل لمعايير ISO 21001 التعليمية.","href":"#contact"},
              {"title":"الشراكات الدولية في التعليم والتدريب","description":"تعاون أكاديمي وبرامج دولية وتبادل وتخييم واعتمادات عبر شبكة علاقات عالمية واسعة.","href":"#contact"},
              {"title":"إعداد وتطوير الحقائب التدريبية","description":"تطوير علمي ومهني للحقائب والبرامج وفق الفئة المستهدفة والمعايير المناسبة لكل نوع تدريب.","href":"#contact"}
            ]},"style":{"variant":"light","align":"right","paddingY":8,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-services-grid"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":15,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"light","align":"center","paddingY":90,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-services"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-method",
        "type":"columns",
        "props":{"anchor":"method","row":true,"layoutKey":"1","gap":18,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[
          {"id":"col-company-method","width":"1fr","modules":[
            {"id":"heading-company-method","type":"heading","props":{"anchor":"","eyebrow":"منهجية العمل","title":"نبدأ بالفهم، لا ببيع الحل","body":"كل مشروع يمر بمراحل واضحة تجعل القرار مبنيًا على الواقع، والتنفيذ مرتبطًا بمسؤوليات ومؤشرات يمكن قياسها.","level":"h2"},"style":{"variant":"light","align":"center","paddingY":10,"maxWidth":"reading","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-section-title"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
            {"id":"timeline-company-method","type":"timeline","props":{"anchor":"","eyebrow":"","title":"","items":[
              {"value":"01","title":"التحليل والتشخيص","description":"فهم الأهداف والإمكانات والتحديات، وتحليل العمليات والتسويق والمبيعات والمنافسين."},
              {"value":"02","title":"تقرير التحسين والتطوير","description":"تحديد الفجوات والأولويات وبناء خطة متكاملة بالمسؤوليات والمدة ومؤشرات النجاح."},
              {"value":"03","title":"تنفيذ الحلول المناسبة","description":"تجميع الخبرات والخدمات والتقنيات اللازمة وتنفيذها دون فصل بين الأقسام."},
              {"value":"04","title":"القياس والتحسين المستمر","description":"تقارير دورية، مراجعة المؤشرات، تطوير الاستراتيجية ونقل المعرفة إلى فريق المؤسسة."}
            ]},"style":{"variant":"light","align":"right","paddingY":12,"maxWidth":"reading","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-method-timeline"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":15,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"light","align":"center","paddingY":90,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-method"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-system",
        "type":"columns",
        "props":{"anchor":"why","row":true,"layoutKey":"1-1","gap":48,"fullWidth":false,"minHeight":470,"verticalAlign":"center","items":[
          {"id":"col-company-system-title","width":"1fr","modules":[
            {"id":"heading-company-system","type":"fancyHeading","props":{"anchor":"","eyebrow":"لماذا ماركتون؟","title":"لأن المشكلة غالبًا ليست في قسم واحد","accent":"بل في الفجوات بين الأقسام.","body":"نربط التسويق بالمبيعات، والمبيعات بالتسجيل، والتشغيل بالبيانات، والاستراتيجية بالتنفيذ؛ حتى تتحرك المؤسسة كمنظومة واحدة بدل جزر منفصلة."},"style":{"variant":"dark","align":"right","paddingY":8,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":0,"cssClass":"company-system-title"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":12,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"center"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
          {"id":"col-company-flow","width":"1fr","modules":[
            {"id":"html-company-flow","type":"html","props":{"anchor":"","content":"<div class=\"company-flow\"><article><i>01</i><div><b>الاستراتيجية</b><span>أهداف واختيارات وأولويات</span></div><em>توجّه</em></article><article><i>02</i><div><b>التسويق والمبيعات</b><span>استقطاب وتحويل وتجربة عميل</span></div><em>نمو</em></article><article><i>03</i><div><b>التشغيل والتقنية</b><span>إجراءات وأنظمة وأتمتة</span></div><em>كفاءة</em></article><article><i>04</i><div><b>الجودة والبيانات</b><span>قياس وحوكمة وتحسين مستمر</span></div><em>استدامة</em></article></div>"},"style":{"variant":"dark","align":"right","paddingY":0,"maxWidth":"full","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"slide-left","animationDelay":120,"cssClass":"company-flow-wrap"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"center"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"dark","align":"right","paddingY":85,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-system"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-stats",
        "type":"columns",
        "props":{"anchor":"","row":true,"layoutKey":"1","gap":0,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[
          {"id":"col-company-stats","width":"1fr","modules":[
            {"id":"stats-company-main","type":"stats","props":{"anchor":"","eyebrow":"خبرة واتصال عالمي","title":"قوة متخصصة لخدمة قطاع التعليم والتدريب","body":"أرقام تعبّر عن نطاق الخبرة والشبكة، وليست بديلًا عن قياس نتائج كل مشروع على حدة.","columns":4,"items":[{"value":"20+","title":"عامًا من الخبرة","description":"في التعليم والتدريب والتشغيل"},{"value":"1500+","title":"جهة ضمن الشبكة الدولية","description":"جامعات ومؤسسات وعلاقات عالمية"},{"value":"6","title":"مسارات خدمة متكاملة","description":"من التسويق حتى الجودة والشراكات"},{"value":"360°","title":"رؤية واحدة للمؤسسة","description":"استراتيجية وتنفيذ وتقنية وقياس"}]},"style":{"variant":"dark","align":"center","paddingY":18,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-stats"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"dark","align":"center","paddingY":38,"maxWidth":"full","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-stats-row"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-free",
        "type":"columns",
        "props":{"anchor":"free-program","row":true,"layoutKey":"1","gap":0,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[
          {"id":"col-company-free","width":"1fr","modules":[
            {"id":"cta-company-free","type":"cta","props":{"anchor":"","eyebrow":"برنامج ماركتون المجاني","title":"ابدأ تشغيل منشأتك مجانًا مدى الحياة","body":"الحساب الأساسي للبرنامج بلا رسوم اشتراك أو مدة انتهاء. أضف التكاملات والسعات وخدمات التشغيل الاحترافية فقط عندما تحتاج إليها.","buttonHref":"/free-trial","buttonLabel":"اكتشف البرنامج المجاني"},"style":{"variant":"brand","align":"right","paddingY":0,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":0,"cssClass":"company-free-card"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"brand","align":"right","paddingY":70,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-free"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-faq",
        "type":"columns",
        "props":{"anchor":"faq","row":true,"layoutKey":"1","gap":18,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[
          {"id":"col-company-faq","width":"1fr","modules":[
            {"id":"faq-company-main","type":"faq","props":{"anchor":"","eyebrow":"أسئلة شائعة","title":"قبل أن تبدأ الشراكة","body":"","items":[
              {"title":"هل ماركتون شركة خدمات أم شركة تقنية؟","description":"ماركتون شريك تشغيل ونمو يجمع الخدمات المتخصصة والتقنية والاستشارات. يمكن التعاقد على مسار واحد أو برنامج متكامل حسب التحدي."},
              {"title":"هل الخدمات مخصصة فقط لمراكز التدريب؟","description":"التركيز الأساسي على المعاهد ومراكز التدريب والمؤسسات التعليمية، لأن فرقنا ونماذج العمل والمصطلحات مبنية على خبرة هذا القطاع."},
              {"title":"هل يمكن البدء بالتشخيص فقط؟","description":"نعم. يمكن بدء التعاون بجلسة وتحليل وتقرير أولويات، ثم اتخاذ قرار مستقل بشأن التنفيذ."},
              {"title":"هل تنفذون الحل أم تقدمون توصيات فقط؟","description":"نقدّم الاستشارة والتنفيذ والمتابعة، ويمكننا تشغيل مسارات مثل التسويق ومركز الاتصال والتقنية بالتعاون مع فريق المنشأة."},
              {"title":"ما الفرق بين خدمات الشركة والبرنامج المجاني؟","description":"خدمات الشركة تشمل الخبراء والتنفيذ والتشغيل والاستشارات. البرنامج المجاني أداة تشغيل أساسية يمكن للمنشأة استخدامها ذاتيًا مدى الحياة، مع إضافات اختيارية."}
            ]},"style":{"variant":"light","align":"right","paddingY":0,"maxWidth":"reading","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-faq-list"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"paper","align":"center","paddingY":85,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-faq"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      },
      {
        "id":"row-company-contact",
        "type":"columns",
        "props":{"anchor":"contact","row":true,"layoutKey":"1-1","gap":22,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[
          {"id":"col-company-contact-cta","width":"1fr","modules":[
            {"id":"cta-company-contact","type":"cta","props":{"anchor":"","eyebrow":"تقهو معنا","title":"كوب قهوة قد يكون بداية تحول حقيقي","body":"حدثنا عن طموح منشأتك والتحدي الحالي. سنساعدك على تحديد نقطة البداية والمسار الذي يستحق الاستثمار أولًا.","buttonHref":"mailto:hello@marktone.sa","buttonLabel":"راسل فريق ماركتون"},"style":{"variant":"dark","align":"right","paddingY":0,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":0,"cssClass":"company-contact-cta"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},
          {"id":"col-company-contact-form","width":"1fr","modules":[
            {"id":"contact-company-main","type":"contact","props":{"anchor":"","eyebrow":"تواصل معنا","title":"دعنا نفهم التحدي أولًا","body":"اكتب نبذة عن المنشأة والهدف أو المشكلة الحالية، وسيتواصل معك الفريق لترتيب الخطوة المناسبة.","buttonLabel":"إرسال طلب التواصل"},"style":{"variant":"light","align":"right","paddingY":0,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"fade-up","animationDelay":100,"cssClass":"company-contact-form"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
          ],"style":{"background":"","color":"","padding":0,"gap":0,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}
        ]},
        "style":{"variant":"dark","align":"right","paddingY":80,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"company-contact"},
        "responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}
      }
    ]
  }
  $doc$::jsonb);

  if jsonb_array_length(v_company_document->'blocks')<>10 then
    raise exception 'company_home_block_count_invalid';
  end if;

  update website.pages
  set title='ماركتون — شريك التشغيل والنمو للمؤسسات التعليمية',
      menu_label='الرئيسية',
      excerpt='خدمات متكاملة للتسويق والمبيعات والتشغيل والتقنية والاستشارات والشراكات الدولية لقطاع التعليم والتدريب.',
      body='',content=v_company_document,template_key='builder',
      seo_title='ماركتون | خدمات تشغيل ونمو متكاملة للمؤسسات التعليمية',
      seo_description='ماركتون شركة سعودية متخصصة تقدم التسويق ومركز الاتصال والحلول التقنية والاستشارات والجودة والشراكات الدولية وتطوير الحقائب للمؤسسات التعليمية.',
      status='published',published_at=now(),canonical_url='/',robots='index,follow',updated_at=now()
  where id=v_home_page_id;

  select id into v_home_document_id
  from website.content_documents
  where site_id=v_site_id and entity_type='page' and entity_id=v_home_page_id
  limit 1;

  if v_home_document_id is null then
    insert into website.content_documents(
      site_id,entity_type,entity_id,schema_version,draft_document,published_document,
      draft_updated_at,published_at
    ) values(
      v_site_id,'page',v_home_page_id,1,v_company_document,v_company_document,now(),now()
    ) returning id into v_home_document_id;
  else
    update website.content_documents
    set schema_version=1,draft_document=v_company_document,published_document=v_company_document,
        draft_updated_at=now(),published_at=now(),updated_at=now()
    where id=v_home_document_id;
  end if;

  select coalesce(max(version_number),0)+1 into v_version
  from website.content_document_versions
  where content_document_id=v_home_document_id;

  insert into website.content_document_versions(
    content_document_id,version_number,version_kind,document,note
  ) values(
    v_home_document_id,v_version,'published',v_company_document,
    'إعادة هيكلة الصفحة الرئيسية لخدمات شركة ماركتون'
  );

  update website.sites
  set theme=jsonb_build_object(
        'navy','#020814','navySoft','#07152a','gold','#ffc928',
        'teal','#08b8b1','cyan','#20c6cf','paper','#f5f8fb','white','#ffffff'
      ),
      settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object(
        'siteTitle','ماركتون | شريك التشغيل والنمو للمؤسسات التعليمية',
        'description','شركة سعودية متخصصة في خدمات التسويق والمبيعات والتشغيل والتقنية والاستشارات لقطاع التعليم والتدريب.',
        'footerText','ماركتون — شريك تشغيل ونمو متخصص للمؤسسات التعليمية ومراكز التدريب.',
        'contactCtaLabel','احجز جلسة تشخيص',
        'contactCtaUrl','#contact',
        'freeTrialLabel','البرنامج المجاني مدى الحياة',
        'freeTrialUrl','/free-trial'
      ),
      updated_at=now()
  where id=v_site_id;

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
      (v_site_id,v_primary_menu_id,'الرئيسية','/#home','anchor',false,10,true,'published','الصفحة الرئيسية','⌂'),
      (v_site_id,v_primary_menu_id,'من نحن','/#about','anchor',false,20,true,'published','تعرف على ماركتون','M'),
      (v_site_id,v_primary_menu_id,'خدماتنا','/#services','anchor',false,30,true,'published','الخدمات المتكاملة','◇'),
      (v_site_id,v_primary_menu_id,'منهجية العمل','/#method','anchor',false,40,true,'published','من التشخيص إلى التحسين','↗'),
      (v_site_id,v_primary_menu_id,'لماذا ماركتون','/#why','anchor',false,50,true,'published','قيمة المنظومة المتكاملة','✦'),
      (v_site_id,v_primary_menu_id,'البرنامج المجاني','/free-trial','anchor',false,60,true,'published','برنامج تشغيل مجاني مدى الحياة','∞'),
      (v_site_id,v_primary_menu_id,'تواصل معنا','/#contact','anchor',false,70,true,'published','تواصل مع فريق ماركتون','✉');
  end if;
end
$$;

commit;
