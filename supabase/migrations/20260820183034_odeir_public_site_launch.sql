begin;

-- Rebrand only the platform public website. Tenant workspaces and tenant data are untouched.
do $$
declare
  v_site_id uuid;
  v_home_page_id uuid;
  v_free_page_id uuid;
  v_page_id uuid;
  v_document_id uuid;
  v_primary_menu_id uuid;
  v_footer_menu_id uuid;
  v_version integer;
  v_home_document jsonb;
  v_free_document jsonb;
  v_legal_pages jsonb;
  v_legal jsonb;
  v_legal_document jsonb;
begin
  select id into v_site_id
  from website.sites
  where site_key='marktone-main'
  limit 1;

  if v_site_id is null then
    raise exception 'odeir_platform_site_not_found';
  end if;

  perform private_app.cms_bootstrap_site(v_site_id,null);

  v_home_document:=private_app.website_builder_validate_document($home$
  {
    "schemaVersion":1,
    "settings":{
      "contentWidth":"wide",
      "background":"#ffffff",
      "customCss":":root{--odeir-ink:#071f2a;--odeir-teal:#23c7b5;--odeir-soft:#eff8f6;--odeir-line:#dbe9e6}.odeir-product-hero{background:radial-gradient(circle at 12% 16%,rgba(35,199,181,.18),transparent 30%),radial-gradient(circle at 90% 8%,rgba(255,255,255,.08),transparent 22%),linear-gradient(145deg,#04171f,#0a3339)!important}.odeir-product-hero h1{font-size:clamp(46px,5.7vw,76px)!important;letter-spacing:-.035em}.odeir-product-hero .buttonRow a:first-child{background:#41dec9!important;color:#05252a!important;border-radius:12px!important}.odeir-product-hero .buttonRow a:last-child{border-radius:12px!important}.odeir-capabilities{background:#f5faf9!important}.odeir-capabilities article,.odeir-trust article{border-radius:18px!important;transition:.2s ease}.odeir-capabilities article:hover,.odeir-trust article:hover{transform:translateY(-4px)}.odeir-start{background:#fff!important}.odeir-trust{background:radial-gradient(circle at 85% 15%,rgba(35,199,181,.17),transparent 30%),linear-gradient(145deg,#061c25,#0a3940)!important}.odeir-faq{background:#f5faf9!important}.odeir-final-cta{background:linear-gradient(115deg,#0a3940,#087b73)!important}.odeir-legal-hero{min-height:420px!important;background:radial-gradient(circle at 12% 20%,rgba(35,199,181,.2),transparent 30%),linear-gradient(145deg,#04171f,#0a3940)!important}.odeir-legal-hero h1{font-size:clamp(42px,5vw,66px)!important}.odeir-legal-cards{background:#f5faf9!important}.odeir-legal-cards article{border-radius:16px!important;box-shadow:none!important}"
    },
    "blocks":[
      {
        "id":"odeir-home-hero",
        "type":"hero",
        "props":{"anchor":"home","eyebrow":"منصة تشغيل وإدارة للمنشآت التعليمية والتدريبية","title":"كل منشأتك في مكان واحد. واضحة، مترابطة، وتحت السيطرة.","body":"أودير يوحّد العملاء والمبيعات، التسجيل والدورات، المهام، الفوترة، الفريق والتقارير في مسار واحد. ابدأ مجانًا دون بطاقة بنكية.","imageUrl":"","imageAlt":"معاينة لوحة تشغيل أودير","primaryLabel":"سجّل منشأتك مجانًا","primaryHref":"/free-trial/apply","secondaryLabel":"تسجيل دخول المنشآت","secondaryHref":"/login"},
        "style":{"variant":"dark","align":"right","paddingY":100,"maxWidth":"wide","cssClass":"odeir-product-hero"},
        "responsive":{}
      },
      {
        "id":"odeir-capabilities",
        "type":"cards",
        "props":{"anchor":"capabilities","eyebrow":"منصة واحدة","title":"ما تحتاجه لتشغيل منشأتك — بلا تشتيت","body":"وحدات مترابطة تعطي كل دور شاشته، وتُبقي الإدارة على صورة واحدة للعمل.","columns":3,"items":[
          {"title":"العملاء والمبيعات","description":"من مصدر العميل والتوزيع إلى المتابعة والتحويل والتسجيل."},
          {"title":"المهام والتقويم","description":"أولويات واضحة، مواعيد، تنبيهات وتسليم موثق بين أعضاء الفريق."},
          {"title":"التسجيل والقبول","description":"ملف منظم للمتدرب وربط مباشر بالبرنامج والدفعة المطلوبة."},
          {"title":"البرامج والدورات","description":"إدارة البرامج والأسعار والدفعات والجداول من مصدر واحد."},
          {"title":"الحسابات والفوترة","description":"عروض وفواتير وتحصيل مرتبط برحلة العميل والتسجيل."},
          {"title":"التقارير والقرار","description":"مؤشرات قابلة للتفصيل حسب المنشأة والفرع والدور والفترة."}
        ]},
        "style":{"variant":"light","align":"center","paddingY":88,"maxWidth":"wide","cssClass":"odeir-capabilities"},
        "responsive":{}
      },
      {
        "id":"odeir-start-steps",
        "type":"timeline",
        "props":{"anchor":"how","eyebrow":"بداية بسيطة","title":"ثلاث خطوات وتبدأ منشأتك العمل","body":"مسار تسجيل واضح، ثم تهيئة الأدوار، ثم تشغيل يومي قابل للقياس.","items":[
          {"value":"01","title":"سجّل منشأتك","description":"ابحث عنها في السجل أو أضفها للمراجعة، ثم أدخل بيانات المسؤول."},
          {"value":"02","title":"جهّز فريقك","description":"حدّد الأدوار والصلاحيات والمسار الذي تريد البدء به."},
          {"value":"03","title":"ابدأ التشغيل","description":"تابع العملاء والمهام والتسجيل والأرقام من لوحة واحدة."}
        ]},
        "style":{"variant":"light","align":"center","paddingY":84,"maxWidth":"reading","cssClass":"odeir-start"},
        "responsive":{}
      },
      {
        "id":"odeir-trust",
        "type":"cards",
        "props":{"anchor":"security","eyebrow":"حماية ووضوح","title":"بيانات منشأتك لا تختلط بغيرها","body":"ضوابط عملية للصلاحيات والوصول والمتابعة، دون ادعاءات أو شعارات أمنية مبهمة.","columns":4,"items":[
          {"title":"عزل بيانات كل منشأة","description":"سياق مستقل يمنع ظهور بيانات منشأة داخل مساحة منشأة أخرى."},
          {"title":"صلاحيات حسب الدور","description":"كل مستخدم يصل إلى ما يحتاجه لأداء عمله فقط."},
          {"title":"سجل واضح للأنشطة","description":"تتبع للإجراءات الحساسة لدعم المراجعة والمساءلة."},
          {"title":"ضوابط ومراجعة","description":"طبقات حماية وإدارة وصول وتحديثات تُراجع مع تطور الخدمة."}
        ]},
        "style":{"variant":"dark","align":"center","paddingY":88,"maxWidth":"wide","cssClass":"odeir-trust"},
        "responsive":{}
      },
      {
        "id":"odeir-faq",
        "type":"faq",
        "props":{"anchor":"faq","eyebrow":"أسئلة سريعة","title":"قبل أن تبدأ","body":"إجابات مباشرة على أكثر الأسئلة شيوعًا.","items":[
          {"title":"هل التسجيل المجاني يحتاج بطاقة بنكية؟","description":"لا. الحساب الأساسي لا يتطلب بطاقة بنكية، وقد تتوفر إضافات أو سعات أو خدمات اختيارية مدفوعة عند الحاجة."},
          {"title":"هل يجب نقل بياناتنا الحالية فورًا؟","description":"لا. يمكنك البدء بالتهيئة الأساسية، ثم تحديد ما يلزم نقله أو ربطه وفق جاهزية المنشأة."},
          {"title":"هل بيانات المنشآت منفصلة؟","description":"نعم. الوصول مصمم حول سياق المنشأة وصلاحيات الدور لتقليل الوصول غير المصرح به ومنع اختلاط البيانات."},
          {"title":"هل يمكن تعديل الموقع من أودير؟","description":"نعم. صفحات الموقع والقوائم والسياسات قابلة للإدارة والنشر من لوحة الموقع والبيلدر المرئي."}
        ]},
        "style":{"variant":"paper","align":"right","paddingY":82,"maxWidth":"reading","cssClass":"odeir-faq"},
        "responsive":{}
      },
      {
        "id":"odeir-final-cta",
        "type":"cta",
        "props":{"anchor":"start","eyebrow":"جاهز للبدء؟","title":"سجّل منشأتك، واترك الباقي لمسار واضح.","body":"ابدأ بالحساب الأساسي، ثم وسّع أودير مع احتياج منشأتك.","buttonLabel":"سجّل منشأتك مجانًا","buttonHref":"/free-trial/apply"},
        "style":{"variant":"brand","align":"right","paddingY":72,"maxWidth":"wide","cssClass":"odeir-final-cta"},
        "responsive":{}
      }
    ]
  }
  $home$::jsonb);

  v_home_document:=jsonb_set(
    v_home_document,'{settings,customCss}',to_jsonb($identity$
      :root{--odeir-navy:#06182e;--odeir-navy-soft:#0b2949;--odeir-cyan:#13c7d1;--odeir-teal:#08b8b1;--odeir-gold:#f0c534;--odeir-paper:#f7f2e8}
      .odeir-product-hero{background:radial-gradient(circle at 14% 18%,rgba(19,199,209,.2),transparent 30%),radial-gradient(circle at 90% 6%,rgba(240,197,52,.14),transparent 26%),linear-gradient(145deg,#031326 0%,#06182e 54%,#0b2949 100%)!important}
      .odeir-product-hero h1{font-size:clamp(50px,6vw,82px)!important;line-height:1.08!important;letter-spacing:-.045em}
      .odeir-product-hero a:first-of-type{background:#f0c534!important;border-color:#f0c534!important;color:#06182e!important;border-radius:12px!important}
      .odeir-product-hero a:last-of-type{border-color:rgba(19,199,209,.55)!important;border-radius:12px!important}
      .odeir-capabilities{background:#f7f9fc!important}.odeir-capabilities article,.odeir-trust article{border-radius:18px!important;transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease}
      .odeir-capabilities article{border-color:rgba(6,24,46,.1)!important;background:#fff!important}.odeir-capabilities article:hover{transform:translateY(-4px);border-color:rgba(19,199,209,.55)!important;box-shadow:0 20px 55px rgba(6,24,46,.09)!important}
      .odeir-start{background:#f7f2e8!important}.odeir-trust{background:radial-gradient(circle at 86% 14%,rgba(19,199,209,.16),transparent 30%),radial-gradient(circle at 8% 86%,rgba(240,197,52,.09),transparent 27%),linear-gradient(145deg,#06182e,#0b2949)!important}
      .odeir-trust article:hover{transform:translateY(-4px);border-color:rgba(240,197,52,.42)!important}.odeir-faq{background:#fff!important}
      .odeir-final-cta{background:radial-gradient(circle at 12% 50%,rgba(19,199,209,.28),transparent 30%),linear-gradient(115deg,#06182e,#0b4161)!important}.odeir-final-cta a{background:#f0c534!important;color:#06182e!important;border-radius:12px!important}
    $identity$::text),true
  );

  select id into v_home_page_id
  from website.pages
  where site_id=v_site_id and is_home and status<>'archived'
  limit 1;

  if v_home_page_id is null then
    raise exception 'odeir_home_page_not_found';
  end if;

  update website.pages
  set title='أودير — منصة تشغيل وإدارة المنشآت',
      menu_label='الرئيسية',
      excerpt='منصة واحدة لإدارة العملاء والمبيعات والمهام والتسجيل والدورات والفوترة والتقارير.',
      body='',content=v_home_document,template_key='builder',page_kind='home',is_home=true,
      seo_title='أودير | منصة تشغيل وإدارة المنشآت',
      seo_description='أودير يوحّد العملاء والمبيعات والتسجيل والدورات والمهام والفوترة والتقارير في منصة واحدة.',
      status='published',visibility='public',published_at=coalesce(published_at,now()),
      canonical_url='/',robots='index,follow',updated_at=now()
  where id=v_home_page_id;

  insert into website.content_documents(
    site_id,entity_type,entity_id,schema_version,draft_document,published_document,
    draft_updated_at,published_at
  ) values(
    v_site_id,'page',v_home_page_id,1,v_home_document,v_home_document,now(),now()
  )
  on conflict(site_id,entity_type,entity_id) do update set
    schema_version=1,draft_document=excluded.draft_document,published_document=excluded.published_document,
    draft_updated_at=now(),published_at=now(),updated_at=now()
  returning id into v_document_id;

  select coalesce(max(version_number),0)+1 into v_version
  from website.content_document_versions where content_document_id=v_document_id;
  insert into website.content_document_versions(content_document_id,version_number,version_kind,document,note)
  values(v_document_id,v_version,'published',v_home_document,'إطلاق واجهة أودير العامة');

  v_free_document:=private_app.website_builder_validate_document($free$
  {
    "schemaVersion":1,
    "settings":{"contentWidth":"wide","background":"#ffffff","customCss":".odeir-free-hero{background:radial-gradient(circle at 12% 18%,rgba(35,199,181,.2),transparent 30%),linear-gradient(145deg,#04171f,#0a3940)!important}.odeir-free-cards{background:#f5faf9!important}.odeir-free-cta{background:linear-gradient(115deg,#0a3940,#087b73)!important}"},
    "blocks":[
      {"id":"odeir-free-hero","type":"hero","props":{"anchor":"free","eyebrow":"بداية بلا تعقيد","title":"ابدأ مع أودير مجانًا","body":"سجّل منشأتك في خطوات واضحة، وابدأ بالمساحة الأساسية دون بطاقة بنكية. أضف التكاملات والسعات والخدمات الاختيارية فقط عندما تحتاج إليها.","imageUrl":"","imageAlt":"أودير","primaryLabel":"سجّل منشأتك مجانًا","primaryHref":"/free-trial/apply","secondaryLabel":"تسجيل دخول المنشآت","secondaryHref":"/login"},"style":{"variant":"dark","align":"right","paddingY":92,"maxWidth":"wide","cssClass":"odeir-free-hero"},"responsive":{}},
      {"id":"odeir-free-cards","type":"cards","props":{"anchor":"included","eyebrow":"ما الذي تحصل عليه؟","title":"أساس واضح لتشغيل منشأتك","body":"تبدأ بما يلزمك اليوم، وتتوسع عند الحاجة.","columns":3,"items":[{"title":"مساحة مستقلة","description":"بيانات منشأتك وسياق فريقك وصلاحيات أدواره في مساحة واحدة."},{"title":"وحدات تشغيل أساسية","description":"العملاء والمهام والتسجيل والبرامج والتقارير وفق الخطة المتاحة."},{"title":"توسع اختياري","description":"تكاملات وسعات وخدمات احترافية يمكن إضافتها دون تعطيل المسار الأساسي."}]},"style":{"variant":"light","align":"center","paddingY":80,"maxWidth":"wide","cssClass":"odeir-free-cards"},"responsive":{}},
      {"id":"odeir-free-faq","type":"faq","props":{"anchor":"questions","eyebrow":"قبل التسجيل","title":"بوضوح","body":"","items":[{"title":"هل يلزم إدخال بطاقة بنكية؟","description":"لا، لا نطلب بطاقة بنكية لبدء التسجيل المجاني."},{"title":"ماذا يحدث بعد إرسال الطلب؟","description":"نراجع بيانات المنشأة وصفة المسؤول، ثم نرسل تفاصيل التفعيل عبر بيانات التواصل المسجلة."},{"title":"هل كل الإضافات مجانية؟","description":"الحساب الأساسي يخضع لسياسة البرنامج المعلنة، وقد تكون بعض التكاملات والسعات والخدمات الاحترافية اختيارية ومدفوعة."}]},"style":{"variant":"light","align":"right","paddingY":76,"maxWidth":"reading","cssClass":"odeir-free-faq"},"responsive":{}},
      {"id":"odeir-free-cta","type":"cta","props":{"anchor":"apply","eyebrow":"خطوتك الأولى","title":"اعثر على منشأتك وابدأ التسجيل.","body":"النموذج متعدد المراحل يحفظ وضوح الطلب ويقلل الأخطاء.","buttonLabel":"بدء تسجيل المنشأة","buttonHref":"/free-trial/apply"},"style":{"variant":"brand","align":"right","paddingY":68,"maxWidth":"wide","cssClass":"odeir-free-cta"},"responsive":{}}
    ]
  }
  $free$::jsonb);

  v_free_document:=jsonb_set(
    v_free_document,'{settings,customCss}',to_jsonb($identity$
      .odeir-free-hero{background:radial-gradient(circle at 14% 18%,rgba(19,199,209,.2),transparent 30%),radial-gradient(circle at 90% 6%,rgba(240,197,52,.13),transparent 25%),linear-gradient(145deg,#031326,#0b2949)!important}
      .odeir-free-hero a:first-of-type{background:#f0c534!important;color:#06182e!important;border-radius:12px!important}
      .odeir-free-cards{background:#f7f9fc!important}.odeir-free-cards article{border-radius:18px!important;border-color:rgba(6,24,46,.1)!important}
      .odeir-free-cta{background:linear-gradient(115deg,#06182e,#0b4161)!important}.odeir-free-cta a{background:#f0c534!important;color:#06182e!important;border-radius:12px!important}
    $identity$::text),true
  );

  insert into website.pages(
    site_id,slug,title,menu_label,excerpt,body,content,template_key,
    seo_title,seo_description,show_in_menu,menu_order,status,published_at,
    page_kind,sort_order,is_home,visibility,layout_settings,canonical_url,robots
  ) values(
    v_site_id,'free-trial','ابدأ مع أودير مجانًا','التسجيل المجاني',
    'سجّل منشأتك في أودير وابدأ بالمساحة الأساسية دون بطاقة بنكية.',
    '',v_free_document,'builder','سجّل منشأتك مجانًا | أودير',
    'ابدأ تسجيل منشأتك في أودير بخطوات واضحة ودون بطاقة بنكية.',
    false,90,'published',now(),'landing',90,false,'public','{}'::jsonb,'/free-trial','index,follow'
  )
  on conflict(site_id,slug) do update set
    title=excluded.title,menu_label=excluded.menu_label,excerpt=excluded.excerpt,body='',
    content=excluded.content,template_key='builder',seo_title=excluded.seo_title,
    seo_description=excluded.seo_description,show_in_menu=false,status='published',
    published_at=coalesce(website.pages.published_at,now()),page_kind='landing',is_home=false,
    visibility='public',canonical_url='/free-trial',robots='index,follow',updated_at=now()
  returning id into v_free_page_id;

  insert into website.content_documents(
    site_id,entity_type,entity_id,schema_version,draft_document,published_document,
    draft_updated_at,published_at
  ) values(
    v_site_id,'page',v_free_page_id,1,v_free_document,v_free_document,now(),now()
  )
  on conflict(site_id,entity_type,entity_id) do update set
    schema_version=1,draft_document=excluded.draft_document,published_document=excluded.published_document,
    draft_updated_at=now(),published_at=now(),updated_at=now()
  returning id into v_document_id;

  select coalesce(max(version_number),0)+1 into v_version
  from website.content_document_versions where content_document_id=v_document_id;
  insert into website.content_document_versions(content_document_id,version_number,version_kind,document,note)
  values(v_document_id,v_version,'published',v_free_document,'تحديث صفحة التسجيل المجاني بهوية أودير');

  v_legal_pages:=$legal$
  [
    {
      "slug":"privacy-policy",
      "menuLabel":"سياسة الخصوصية",
      "title":"سياسة الخصوصية",
      "excerpt":"كيف تجمع أودير البيانات الشخصية وتستخدمها وتحميها.",
      "seoTitle":"سياسة الخصوصية | أودير",
      "seoDescription":"تعرف على فئات البيانات التي تعالجها أودير وأغراض المعالجة وحقوق أصحاب البيانات.",
      "eyebrow":"خصوصيتك أولًا",
      "body":"تشرح هذه السياسة كيف تعالج أودير البيانات عند استخدام الموقع والمنصة. قد تعمل أودير كمتحكم في بيانات الحساب والتواصل، وكمعالج للبيانات التي تدخلها المنشأة داخل مساحتها.",
      "items":[
        {"title":"البيانات التي نجمعها","description":"بيانات الحساب والمنشأة ووسائل التواصل، والبيانات التشغيلية التي تدخلها المنشأة، وسجلات الاستخدام والأمان، وبيانات التكاملات اللازمة لتقديم الخدمة."},
        {"title":"أغراض الاستخدام","description":"إنشاء الحساب والتحقق من المنشأة، تقديم خصائص المنصة ودعمها، حماية الحسابات، تحسين الأداء، تنفيذ الالتزامات التعاقدية والنظامية، والتواصل بشأن الخدمة."},
        {"title":"أساس المعالجة","description":"تتم المعالجة بحسب الحالة لتنفيذ عقد أو طلب قبل التعاقد، أو الوفاء بالتزام نظامي، أو تحقيق مصلحة مشروعة لا تتعارض مع حقوقك، أو بناءً على موافقتك عندما تكون مطلوبة."},
        {"title":"المشاركة ومقدمو الخدمة","description":"قد نشارك الحد الأدنى اللازم مع مزودي الاستضافة والبنية والدعم والاتصالات والتكاملات المعتمدين، وبالتزامات تعاقدية تحمي السرية وتحدد غرض المعالجة."},
        {"title":"الاحتفاظ والحذف","description":"نحتفظ بالبيانات للمدة اللازمة لتقديم الخدمة والوفاء بالالتزامات وتسوية المطالبات، ثم نحذفها أو نخفي هويتها وفق معايير الاحتفاظ والنسخ الاحتياطية المتبعة."},
        {"title":"النقل خارج النطاق الجغرافي","description":"إذا تطلبت الخدمة نقل بيانات عبر الحدود، نقيّم الحاجة والضمانات والالتزامات النظامية ونستخدم مزودين وضوابط مناسبة لطبيعة البيانات."},
        {"title":"حقوقك","description":"بحسب النظام المطبق، قد تشمل حقوقك العلم والوصول والحصول على نسخة والتصحيح وطلب الإتلاف أو سحب الموافقة عندما تكون هي الأساس، مع مراعاة الاستثناءات النظامية."},
        {"title":"التحديث والتواصل","description":"قد نحدث السياسة عند تغير الخدمة أو المتطلبات. يظهر تاريخ النسخة داخل الصفحة، ويمكن تقديم استفسار أو طلب عبر قنوات التواصل المعتمدة المنشورة في الموقع أو الحساب."}
      ]
    },
    {
      "slug":"information-security",
      "menuLabel":"أمن المعلومات",
      "title":"أمن المعلومات وحماية البيانات",
      "excerpt":"نظرة واضحة على الضوابط التي تستخدمها أودير لحماية بيانات المنشآت.",
      "seoTitle":"أمن المعلومات وحماية البيانات | أودير",
      "seoDescription":"ضوابط الوصول والعزل والمراقبة والاستجابة التي تدعم حماية بيانات المنشآت في أودير.",
      "eyebrow":"حماية عملية",
      "body":"نبني الحماية على طبقات مترابطة تشمل الهوية والصلاحيات والعزل والمراقبة والاستجابة، مع مراجعة الضوابط كلما تطورت الخدمة والمخاطر.",
      "items":[
        {"title":"عزل سياق المنشأة","description":"ترتبط البيانات بسياق المنشأة، وتُطبق حدود وصول تقلل خطر ظهور بيانات منشأة في مساحة أخرى."},
        {"title":"أقل صلاحية لازمة","description":"تُمنح الصلاحيات بحسب الدور والمسؤولية، مع فصل إدارة المنصة عن إدارة المنشأة والوظائف التشغيلية."},
        {"title":"حماية الهوية والجلسات","description":"تستخدم المنصة ضوابط مصادقة وجلسات، وتقيّد العمليات الحساسة وفق هوية المستخدم وصلاحياته الحالية."},
        {"title":"حماية الاتصال والتخزين","description":"نستخدم قنوات اتصال مشفرة وطبقات حماية للتخزين والبنية وفق قدرات وإعدادات مزودي الخدمة المعتمدين."},
        {"title":"السجلات والمراقبة","description":"تُسجل أحداث تشغيلية وأمنية مناسبة لدعم التشخيص والمراجعة واكتشاف الاستخدام غير المعتاد."},
        {"title":"الاستجابة والاستمرارية","description":"نتبع مسارًا لتقييم الحوادث واحتوائها ومعالجتها والتواصل بشأنها عند اللزوم، مع نسخ احتياطية وخطط استعادة تتناسب مع الخدمة."}
      ]
    },
    {
      "slug":"terms-of-use",
      "menuLabel":"شروط الاستخدام",
      "title":"شروط الاستخدام",
      "excerpt":"الشروط المنظمة لاستخدام موقع ومنصة أودير.",
      "seoTitle":"شروط الاستخدام | أودير",
      "seoDescription":"اقرأ شروط استخدام موقع ومنصة أودير ومسؤوليات المنشأة والمستخدم.",
      "eyebrow":"استخدام واضح ومسؤول",
      "body":"باستخدامك الموقع أو المنصة، فإنك توافق على هذه الشروط وعلى السياسات المرتبطة بها. قد تخضع الخدمات المدفوعة أو المخصصة لاتفاقية طلب منفصلة تكون لها الأولوية عند التعارض.",
      "items":[
        {"title":"الأهلية والحساب","description":"يجب أن تكون مخولًا بالتصرف نيابة عن المنشأة، وأن تقدم معلومات صحيحة وتحافظ على سرية بيانات الدخول وتبلغ عن أي استخدام غير مصرح به."},
        {"title":"الاستخدام المقبول","description":"يُمنع إساءة استخدام الخدمة أو محاولة تجاوز الصلاحيات أو تعطيلها أو فحصها دون تصريح أو إدخال محتوى غير مشروع أو ينتهك حقوق الآخرين."},
        {"title":"مسؤولية بيانات المنشأة","description":"المنشأة مسؤولة عن مشروعية البيانات التي تدخلها، وصحة تعليماتها، وتحديد مستخدميها وصلاحياتهم، والحصول على الإشعارات أو الموافقات المطلوبة من أصحاب البيانات."},
        {"title":"الخدمة والتغييرات","description":"قد نطور الخصائص أو نعدلها أو نوقف جزءًا منها لأسباب تشغيلية أو أمنية أو نظامية، مع اتخاذ خطوات معقولة لتقليل الأثر وإبلاغ العملاء عند التغيير الجوهري."},
        {"title":"الخطة المجانية والإضافات","description":"تخضع حدود الحساب الأساسي والإضافات والسعات والتكاملات للأسعار والسياسات المعلنة وقت الطلب، ولا يعني التسجيل المجاني أن جميع الخدمات الحالية أو المستقبلية بلا مقابل."},
        {"title":"الملكية الفكرية","description":"تظل حقوق المنصة وتصميمها وبرمجياتها ومحتواها لأصحابها. تحتفظ المنشأة بحقوقها في بياناتها، وتمنح أودير ما يلزم تقنيًا لمعالجتها وتقديم الخدمة."},
        {"title":"التعليق والإنهاء","description":"قد يُعلق الوصول عند وجود خطر أمني أو مخالفة جوهرية أو التزام مالي مستحق، مع مراعاة الاتفاقية المطبقة وإتاحة معالجة السبب متى كان ذلك ممكنًا."},
        {"title":"المسؤولية والنظام المطبق","description":"تُحدد المسؤوليات والحدود والتعويضات وفق الاتفاقية والأنظمة الواجبة التطبيق بحسب مقر الجهة المتعاقدة ونطاق تقديم الخدمة، وبالقدر الذي يسمح به النظام."}
      ]
    },
    {
      "slug":"cookie-policy",
      "menuLabel":"سياسة ملفات الارتباط",
      "title":"سياسة ملفات الارتباط",
      "excerpt":"كيف يستخدم موقع أودير ملفات الارتباط وتقنيات التخزين المشابهة.",
      "seoTitle":"سياسة ملفات الارتباط | أودير",
      "seoDescription":"تعرف على ملفات الارتباط الضرورية والتفضيلات والتحليلات في موقع أودير.",
      "eyebrow":"خياراتك الرقمية",
      "body":"تساعد ملفات الارتباط وتقنيات التخزين المشابهة على تشغيل الموقع والجلسات بأمان وتذكر بعض التفضيلات. يختلف الاستخدام الفعلي بحسب الخصائص المفعلة في الموقع والمنصة.",
      "items":[
        {"title":"ملفات ضرورية","description":"تدعم تسجيل الدخول وأمان الجلسة وتوازن الطلبات ومنع إساءة الاستخدام. قد لا تعمل أجزاء أساسية من الخدمة دونها."},
        {"title":"ملفات التفضيلات","description":"تساعد على تذكر اللغة أو العرض أو إعدادات اختارها المستخدم، وقد يمكن حذفها من إعدادات المتصفح."},
        {"title":"القياس والتحليلات","description":"قد نستخدم قياسًا محدودًا لفهم الأداء والاستخدام وتحسين التجربة. نوضح الأدوات الاختيارية أو نطلب الموافقة عندما يقتضي النظام ذلك."},
        {"title":"الخدمات الخارجية","description":"قد تضيف بعض التكاملات ملفاتها الخاصة عند تفعيلها. تخضع هذه الملفات لسياسة المزود وإعدادات المنشأة والموافقة المطلوبة."},
        {"title":"إدارة الخيارات","description":"يمكنك التحكم في الملفات من إعدادات المتصفح أو أداة الموافقة عند توفرها. قد يؤدي حظر الملفات الضرورية إلى تعطل تسجيل الدخول أو بعض الوظائف."}
      ]
    },
    {
      "slug":"data-rights",
      "menuLabel":"حقوق البيانات",
      "title":"حقوق أصحاب البيانات",
      "excerpt":"طريقة ممارسة حقوقك المتعلقة بالبيانات الشخصية في أودير.",
      "seoTitle":"حقوق أصحاب البيانات | أودير",
      "seoDescription":"كيفية طلب الوصول أو النسخة أو التصحيح أو الإتلاف أو سحب الموافقة في أودير.",
      "eyebrow":"طلبك له مسار واضح",
      "body":"يختلف دور أودير بحسب البيانات: قد نكون متحكمًا في بيانات الحساب والتواصل، بينما تكون المنشأة غالبًا المتحكم في بيانات عملائها ومتدربيها وموظفيها داخل مساحتها.",
      "items":[
        {"title":"الحق في العلم","description":"يمكنك معرفة سبب جمع بياناتك، وأساس المعالجة، والجهات التي قد تستلمها، ومدة الاحتفاظ أو معيار تحديدها."},
        {"title":"الوصول والحصول على نسخة","description":"يمكنك طلب الاطلاع على بياناتك الشخصية والحصول على نسخة منها بصيغة مناسبة عندما يجيز النظام ذلك."},
        {"title":"التصحيح والاستكمال","description":"يمكنك طلب تصحيح البيانات غير الدقيقة أو استكمال الناقص منها، وقد نطلب مستندًا يدعم التعديل عندما يلزم."},
        {"title":"الإتلاف أو سحب الموافقة","description":"يمكنك طلب إتلاف البيانات أو سحب موافقتك عندما تكون المعالجة قائمة عليها، مع مراعاة الالتزامات والاستثناءات النظامية وحقوق الآخرين."},
        {"title":"تقديم الطلب والتحقق","description":"قدّم الطلب عبر قنوات التواصل المعتمدة في الموقع أو داخل الحساب، مع وصف البيانات والحق المطلوب. قد نتحقق من الهوية والصفة لحماية البيانات من الإفصاح غير المصرح به."},
        {"title":"طلبات تخص بيانات منشأة","description":"إذا كان طلبك متعلقًا ببيانات أدخلتها منشأة عميلة، تواصل معها أولًا بصفتها المتحكم. ندعم المنشأة في الاستجابة ضمن دورنا كمقدم خدمة ومعالج للبيانات."}
      ]
    }
  ]
  $legal$::jsonb;

  for v_legal in select value from jsonb_array_elements(v_legal_pages) loop
    v_legal_document:=private_app.website_builder_validate_document(
      jsonb_build_object(
        'schemaVersion',1,
        'settings',jsonb_build_object(
          'contentWidth','wide','background','#ffffff',
          'customCss','.odeir-legal-hero{min-height:420px!important;background:radial-gradient(circle at 12% 20%,rgba(35,199,181,.2),transparent 30%),linear-gradient(145deg,#04171f,#0a3940)!important}.odeir-legal-hero h1{font-size:clamp(42px,5vw,66px)!important}.odeir-legal-cards{background:#f5faf9!important}.odeir-legal-cards article{border-radius:16px!important;box-shadow:none!important}'
        ),
        'blocks',jsonb_build_array(
          jsonb_build_object(
            'id','legal-hero-'||replace(v_legal->>'slug','-',''),
            'type','hero',
            'props',jsonb_build_object(
              'anchor','top','eyebrow',v_legal->>'eyebrow','title',v_legal->>'title',
              'body',(v_legal->>'body')||' آخر تحديث: 20 أغسطس 2026.',
              'imageUrl','','imageAlt','','primaryLabel','العودة للرئيسية','primaryHref','/',
              'secondaryLabel','حقوق البيانات','secondaryHref','/p/data-rights'
            ),
            'style',jsonb_build_object('variant','dark','align','right','paddingY',78,'maxWidth','wide','cssClass','odeir-legal-hero'),
            'responsive','{}'::jsonb
          ),
          jsonb_build_object(
            'id','legal-cards-'||replace(v_legal->>'slug','-',''),
            'type','cards',
            'props',jsonb_build_object(
              'anchor','details','eyebrow','التفاصيل','title','ما الذي تعنيه هذه السياسة؟',
              'body','نص عملي قابل للتحديث والنشر من بيلدر موقع أودير.','columns',2,'items',v_legal->'items'
            ),
            'style',jsonb_build_object('variant','light','align','right','paddingY',76,'maxWidth','reading','cssClass','odeir-legal-cards'),
            'responsive','{}'::jsonb
          )
        )
      )
    );

    v_legal_document:=jsonb_set(
      v_legal_document,'{settings,customCss}',to_jsonb($identity$
        .odeir-legal-hero{min-height:430px!important;background:radial-gradient(circle at 12% 20%,rgba(19,199,209,.2),transparent 30%),radial-gradient(circle at 90% 10%,rgba(240,197,52,.12),transparent 24%),linear-gradient(145deg,#031326,#0b2949)!important}
        .odeir-legal-hero h1{font-size:clamp(42px,5vw,66px)!important}.odeir-legal-hero a:first-of-type{background:#f0c534!important;color:#06182e!important;border-radius:12px!important}
        .odeir-legal-cards{background:#f7f9fc!important}.odeir-legal-cards article{border-radius:16px!important;border-color:rgba(6,24,46,.1)!important;box-shadow:none!important}
      $identity$::text),true
    );

    insert into website.pages(
      site_id,slug,title,menu_label,excerpt,body,content,template_key,
      seo_title,seo_description,show_in_menu,menu_order,status,published_at,
      page_kind,sort_order,is_home,visibility,layout_settings,canonical_url,robots
    ) values(
      v_site_id,v_legal->>'slug',v_legal->>'title',v_legal->>'menuLabel',v_legal->>'excerpt',
      '',v_legal_document,'builder',v_legal->>'seoTitle',v_legal->>'seoDescription',
      false,200,'published',now(),'legal',200,false,'public','{}'::jsonb,
      '/p/'||(v_legal->>'slug'),'index,follow'
    )
    on conflict(site_id,slug) do update set
      title=excluded.title,menu_label=excluded.menu_label,excerpt=excluded.excerpt,body='',
      content=excluded.content,template_key='builder',seo_title=excluded.seo_title,
      seo_description=excluded.seo_description,show_in_menu=false,status='published',
      published_at=coalesce(website.pages.published_at,now()),page_kind='legal',is_home=false,
      visibility='public',canonical_url=excluded.canonical_url,robots='index,follow',updated_at=now()
    returning id into v_page_id;

    insert into website.content_documents(
      site_id,entity_type,entity_id,schema_version,draft_document,published_document,
      draft_updated_at,published_at
    ) values(
      v_site_id,'page',v_page_id,1,v_legal_document,v_legal_document,now(),now()
    )
    on conflict(site_id,entity_type,entity_id) do update set
      schema_version=1,draft_document=excluded.draft_document,published_document=excluded.published_document,
      draft_updated_at=now(),published_at=now(),updated_at=now()
    returning id into v_document_id;

    select coalesce(max(version_number),0)+1 into v_version
    from website.content_document_versions where content_document_id=v_document_id;
    insert into website.content_document_versions(content_document_id,version_number,version_kind,document,note)
    values(v_document_id,v_version,'published',v_legal_document,'إطلاق صفحة '||(v_legal->>'title')||' في أودير');
  end loop;

  update website.sites
  set name_ar='أودير',name_en='ODEIR',site_slug='odeir',primary_domain='odeir.com',
      theme=jsonb_build_object(
        'navy','#06182e','navySoft','#0b2949','gold','#f0c534',
        'teal','#08b8b1','cyan','#13c7d1','paper','#f7f2e8','white','#ffffff'
      ),
      settings=coalesce(settings,'{}'::jsonb)||jsonb_build_object(
        'brandKey','odeir','homeUrl','/',
        'siteTitle','أودير | منصة تشغيل وإدارة المنشآت',
        'description','منصة واحدة لإدارة العملاء والمبيعات والمهام والتسجيل والدورات والفوترة والتقارير.',
        'footerText','أودير — تشغيل أوضح وإدارة مترابطة للمنشآت.',
        'customerLoginLabel','تسجيل دخول المنشآت','customerLoginUrl','/login',
        'contactCtaLabel','سجّل منشأتك مجانًا','contactCtaUrl','/free-trial/apply',
        'freeTrialLabel','سجّل منشأتك مجانًا','freeTrialUrl','/free-trial/apply',
        'articlesTitle','مقالات ورؤى أودير',
        'articlesDescription','أفكار عملية حول التشغيل والإدارة والمبيعات والبيانات.'
      ),
      status='published',published_at=coalesce(published_at,now()),updated_at=now()
  where id=v_site_id;

  select id into v_primary_menu_id
  from website.menus
  where site_id=v_site_id and menu_key='primary'
  limit 1;

  if v_primary_menu_id is not null then
    delete from website.menu_items where menu_id=v_primary_menu_id;
    insert into website.menu_items(
      site_id,menu_id,label,href,item_kind,open_in_new_tab,sort_order,is_visible,status,description,icon
    ) values
      (v_site_id,v_primary_menu_id,'المنصة','/#capabilities','anchor',false,10,true,'published','وحدات أودير الأساسية','▦'),
      (v_site_id,v_primary_menu_id,'كيف تبدأ','/#how','anchor',false,20,true,'published','ثلاث خطوات للبدء','↗'),
      (v_site_id,v_primary_menu_id,'الحماية','/#security','anchor',false,30,true,'published','حماية البيانات والصلاحيات','◇'),
      (v_site_id,v_primary_menu_id,'الأسئلة الشائعة','/#faq','anchor',false,40,true,'published','إجابات قبل التسجيل','?');
  end if;

  select id into v_footer_menu_id
  from website.menus
  where site_id=v_site_id and menu_key='footer'
  limit 1;

  if v_footer_menu_id is not null then
    delete from website.menu_items where menu_id=v_footer_menu_id;
    insert into website.menu_items(
      site_id,menu_id,label,href,item_kind,target_page_id,open_in_new_tab,
      sort_order,is_visible,status,description
    ) values
      (v_site_id,v_footer_menu_id,'الرئيسية','/','page',v_home_page_id,false,10,true,'published','العودة إلى أودير'),
      (v_site_id,v_footer_menu_id,'التسجيل المجاني','/free-trial','page',v_free_page_id,false,15,true,'published','ابدأ مع أودير');

    insert into website.menu_items(
      site_id,menu_id,label,href,item_kind,target_page_id,open_in_new_tab,
      sort_order,is_visible,status,description
    )
    select
      v_site_id,v_footer_menu_id,legal.label,'/p/'||legal.slug,'page',page.id,false,
      legal.sort_order,true,'published','سياسات أودير'
    from website.pages page
    join (values
      ('privacy-policy','سياسة الخصوصية',20),
      ('information-security','أمن المعلومات',30),
      ('terms-of-use','شروط الاستخدام',40),
      ('cookie-policy','ملفات الارتباط',50),
      ('data-rights','حقوق البيانات',60)
    ) as legal(slug,label,sort_order) on legal.slug=page.slug
    where page.site_id=v_site_id;

    insert into website.menu_items(
      site_id,menu_id,label,href,item_kind,open_in_new_tab,sort_order,is_visible,status,description
    ) values
      (v_site_id,v_footer_menu_id,'تسجيل دخول المنشآت','/login','system',false,70,true,'published','الدخول إلى حساب المنشأة');
  end if;
end
$$;

commit;
