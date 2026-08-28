begin;

-- ODEIR public privacy page only. Tenant workspaces and operational records are not touched.
do $$
declare
  v_site_id uuid;
  v_page_id uuid;
  v_document_id uuid;
  v_version integer;
  v_document jsonb;
begin
  select id into v_site_id
  from website.sites
  where site_key='marktone-main'
  limit 1;

  if v_site_id is null then
    raise exception 'odeir_platform_site_not_found';
  end if;

  v_document := private_app.website_builder_validate_document($privacy${"schemaVersion":1,"settings":{"contentWidth":"wide","background":"#ffffff","customCss":""},"blocks":[{"id":"odeir-privacy-hero","type":"hero","props":{"anchor":"top","eyebrow":"سياسة الخصوصية وحوكمة البيانات","title":"بياناتك تحت إدارة واضحة… من لحظة جمعها حتى تسليمها أو حذفها.","body":"توضح هذه السياسة كيف تتعامل منصة أودير مع البيانات الشخصية وبيانات المنشآت، والأدوار النظامية لكل طرف، وحقوق أصحاب البيانات، وما يحدث للبيانات عند إلغاء الحساب أو انتهاء الخدمة. تاريخ آخر تحديث والنفاذ: 28 أغسطس 2026.","imageUrl":"","imageAlt":"حماية وخصوصية البيانات في أودير","primaryLabel":"قدّم طلبًا متعلقًا ببياناتك","primaryHref":"/p/data-rights","secondaryLabel":"شروط الاستخدام والاشتراك","secondaryHref":"/p/terms-of-use"},"style":{"variant":"dark","align":"right","paddingY":96,"maxWidth":"wide","cssClass":"odeir-policy-hero"},"responsive":{}},{"id":"odeir-privacy-toc","type":"toc","props":{"anchor":"contents","title":"في هذه الصفحة","items":[{"title":"من المسؤول عن البيانات؟","href":"#roles"},{"title":"البيانات التي نعالجها","href":"#data"},{"title":"أغراض المعالجة","href":"#purposes"},{"title":"دورة حياة البيانات","href":"#lifecycle"},{"title":"التسليم أو الحذف","href":"#exit"},{"title":"حقوق أصحاب البيانات","href":"#rights"},{"title":"الأسئلة الشائعة","href":"#questions"}]},"style":{"variant":"light","align":"right","paddingY":22,"maxWidth":"wide","cssClass":"odeir-legal-toc"},"responsive":{}},{"id":"odeir-privacy-principles","type":"stats","props":{"anchor":"principles","eyebrow":"التزامنا العملي","title":"أربع قواعد تحكم معالجة البيانات","body":"لا نكتفي بعبارة «نحترم خصوصيتك»؛ بل نحدد الغرض، ونقلل البيانات، ونضبط الوصول، ونوفر مسارًا واضحًا للطلبات.","columns":4,"items":[{"value":"لا بيع","title":"لا نبيع البيانات الشخصية","description":"ولا نستخدم بيانات المنشأة للإعلانات الموجهة لحسابنا."},{"value":"أقل قدر","title":"تقليل البيانات","description":"نعالج القدر اللازم لتشغيل الخدمة والوفاء بالالتزامات."},{"value":"غرض محدد","title":"استخدام منضبط","description":"لا نغيّر الغرض على نحو غير متوافق دون أساس نظامي مناسب."},{"value":"طلب واضح","title":"حقوق قابلة للممارسة","description":"الوصول والنسخة والتصحيح والإتلاف وسحب الموافقة وفق الحالة والنظام."}]},"style":{"variant":"light","align":"center","paddingY":76,"maxWidth":"wide","cssClass":"odeir-policy-principles"},"responsive":{}},{"id":"odeir-privacy-roles","type":"cards","props":{"anchor":"roles","eyebrow":"من المسؤول عن ماذا؟","title":"الأدوار تختلف بحسب نوع البيانات","body":"تحديد الدور مهم لأن الطلب والمسؤولية النظامية قد تكون على أودير أو على المنشأة بحسب مصدر البيانات والغرض من معالجتها.","columns":3,"items":[{"title":"أودير كمتحكم","description":"تكون أودير متحكمًا في بيانات إنشاء الحساب، ممثل المنشأة، التعاقد والفوترة، الدعم، أمن الخدمة، التواصل التشغيلي وقياس أداء المنصة."},{"title":"أودير كمعالج","description":"تعالج أودير، بالنيابة عن المنشأة ووفق تعليماتها، بيانات العملاء والمتدربين والموظفين والمبيعات والبرامج والمستندات التي تدخلها المنشأة إلى مساحتها."},{"title":"المنشأة ومديرها كمتحكم","description":"المنشأة ومديرها مسؤولان عن مشروعية جمع بياناتهم، الإشعارات والموافقات، صحة التعليمات، تحديد الصلاحيات، المحتوى، وطلبات أصحاب البيانات المرتبطة بخدمات المنشأة."}]},"style":{"variant":"light","align":"right","paddingY":84,"maxWidth":"wide","cssClass":"odeir-policy-roles"},"responsive":{}},{"id":"odeir-privacy-data","type":"cards","props":{"anchor":"data","eyebrow":"خريطة البيانات","title":"ما البيانات التي قد نعالجها؟","body":"تختلف الفئات الفعلية بحسب الوحدات والإضافات والتكاملات التي تختارها المنشأة.","columns":3,"items":[{"title":"الحساب والهوية","description":"الاسم، بيانات التواصل، صفة ممثل المنشأة، بيانات تسجيل الدخول والتحقق، وسجل الموافقات ذات الصلة."},{"title":"المنشأة والفريق","description":"اسم المنشأة وفروعها، بيانات المستخدمين والأدوار والصلاحيات والإعدادات وسجلات الدعوات والإدارة."},{"title":"البيانات التشغيلية","description":"بيانات العملاء والمتدربين والموظفين والفرص والمبيعات والمهام والبرامج والحضور والفواتير والمرفقات التي تدخلها المنشأة."},{"title":"التكاملات والاتصالات","description":"البيانات اللازمة لربط المتاجر والإعلانات والبريد والرسائل والمكالمات والدفع ومنصات التدريب، بحسب ما تفعّله المنشأة."},{"title":"الفوترة والدعم","description":"الخطة والطلبات والمدفوعات والفواتير والمراسلات وتذاكر الدعم والملاحظات اللازمة لتقديم الخدمة."},{"title":"الاستخدام والأمان","description":"عنوان الشبكة ونوع الجهاز والمتصفح والجلسات والأحداث وسجلات التدقيق والأخطاء والمؤشرات اللازمة للحماية والتشخيص."}]},"style":{"variant":"light","align":"right","paddingY":84,"maxWidth":"wide","cssClass":"odeir-policy-data"},"responsive":{}},{"id":"odeir-privacy-bases","type":"cards","props":{"anchor":"purposes","eyebrow":"الأغراض والأسس","title":"لماذا نستخدم البيانات؟","body":"تُحدد قاعدة المعالجة وفق نوع البيانات والعلاقة مع صاحبها والقواعد واجبة التطبيق.","columns":3,"items":[{"title":"تقديم الخدمة والتعاقد","description":"إنشاء الحساب، التحقق، تشغيل الوحدات، تنفيذ الطلب، الفوترة، الدعم، وإدارة العلاقة التعاقدية أو ما يسبقها."},{"title":"الأمن ومنع الإساءة","description":"حماية الحسابات والبنية، التحقيق في الأعطال والحوادث، منع الاحتيال، فرض الصلاحيات، والاحتفاظ بسجلات لازمة للمساءلة."},{"title":"الالتزامات النظامية","description":"الامتثال للطلبات الملزمة والاحتفاظ بالسجلات التي توجبها الأنظمة وتسوية النزاعات وحماية الحقوق القانونية."},{"title":"المصلحة المشروعة","description":"تحسين الاعتمادية وتجربة الاستخدام وقياس الأداء وتطوير الخدمة، بشرط ألا تتغلب هذه المصلحة على حقوق أصحاب البيانات."},{"title":"الموافقة عند الحاجة","description":"تُطلب الموافقة عندما تكون الأساس المناسب، ويمكن سحبها دون أن يؤثر ذلك في مشروعية المعالجة السابقة أو أي أساس آخر قائم."},{"title":"حدود الاستخدام المستقبلي","description":"لا نبيع بيانات المنشأة، ولا نستخدم محتواها لتدريب نماذج عامة لحسابنا أو لغرض جديد غير متوافق إلا بموافقة صريحة أو اتفاق مستقل أو أساس نظامي يجيز ذلك."}]},"style":{"variant":"dark","align":"right","paddingY":90,"maxWidth":"wide","cssClass":"odeir-policy-bases"},"responsive":{}},{"id":"odeir-privacy-lifecycle","type":"timeline","props":{"anchor":"lifecycle","eyebrow":"دورة حياة البيانات","title":"من الجمع إلى الإتلاف","body":"لكل مرحلة ضوابطها، ولا يعني بقاء نسخة احتياطية تشغيلية أن البيانات متاحة للاستخدام العادي.","items":[{"value":"01","title":"الجمع والإدخال","description":"نجمع البيانات منك مباشرة أو من المنشأة أو من التكامل الذي تفعّله، ونقصرها على ما يلزم للغرض المعلن."},{"value":"02","title":"التخزين والوصول","description":"تُخزن البيانات لدى بنية سحابية ومزودين معتمدين، ويُقيد الوصول وفق الدور والحاجة والسجلات الأمنية."},{"value":"03","title":"المشاركة والمعالجون الفرعيون","description":"قد نشارك الحد الأدنى اللازم مع مزودي الاستضافة والاتصالات والدفع والدعم والتكاملات بموجب التزامات تحصر الغرض وتحمي السرية."},{"value":"04","title":"النقل عبر الحدود","description":"عند وجود معالجة أو استضافة خارج المملكة، نراعي المتطلبات النظامية والضمانات المناسبة وتقليل البيانات وتقييم المخاطر بحسب الحالة."},{"value":"05","title":"الاحتفاظ والإنهاء","description":"نحتفظ بالبيانات للمدة اللازمة للخدمة أو العقد أو النظام. وبعد الإنهاء تُسلّم نسخة آمنة أو يبدأ الحذف وفق خيار العميل، مع استثناء ما يلزم الاحتفاظ به نظامًا."},{"value":"06","title":"الإتلاف والنسخ الاحتياطية","description":"يتم الحذف بطريقة تحد من الاسترجاع، وتبقى النسخ الاحتياطية المعزولة حتى تنتهي دورتها الفنية دون إعادتها للاستخدام التشغيلي إلا للاستعادة المصرح بها."}]},"style":{"variant":"paper","align":"right","paddingY":88,"maxWidth":"reading","cssClass":"odeir-policy-lifecycle"},"responsive":{}},{"id":"odeir-privacy-exit","type":"linkBlock","props":{"anchor":"exit","icon":"↗","eyebrow":"عند إلغاء الحساب أو انتهاء الخدمة","title":"الاختيار لك: تسليم آمن للبيانات أو حذف نهائي","body":"يجوز للمنشأة إلغاء الخدمة أو طلب حذف بياناتها في أي وقت عبر القنوات المعتمدة. بعد التحقق من هوية وصلاحية مقدم الطلب، تتيح أودير — بحسب الإمكانات الفنية ونطاق الخطة — تصديرًا منظمًا وآمنًا للبيانات أو تبدأ الحذف النهائي بناءً على خيار المنشأة. قد نحتفظ مؤقتًا بقدر محدود إذا أوجب النظام أو كان لازمًا لإثبات الحقوق أو منع الاحتيال، مع تقييد الوصول إليه وإتلافه عند انتهاء السبب.","linkLabel":"راجع مسار حقوق البيانات","href":"/p/data-rights"},"style":{"variant":"light","align":"right","paddingY":58,"maxWidth":"reading","cssClass":"odeir-policy-exit"},"responsive":{}},{"id":"odeir-privacy-rights","type":"cards","props":{"anchor":"rights","eyebrow":"حقوق أصحاب البيانات","title":"طلباتك لها مسار واضح","body":"تخضع الاستجابة للتحقق من الهوية والصفة، وللاستثناءات والالتزامات النظامية، وقد نحيل الطلب إلى المنشأة عندما تكون هي المتحكم.","columns":4,"items":[{"title":"العلم والوصول","description":"معرفة أساس الجمع والغرض والفئات والجهات المستلمة، وطلب الوصول إلى البيانات التي نتحكم بها."},{"title":"الحصول على نسخة","description":"طلب نسخة مقروءة وواضحة وبصيغة إلكترونية شائعة عندما ينطبق الحق ولا يمس حقوق الآخرين."},{"title":"التصحيح والاستكمال","description":"تصحيح البيانات غير الدقيقة أو استكمال الناقص أو تحديث القديم، مع إخطار الجهات ذات الصلة عند اللزوم."},{"title":"الإتلاف أو سحب الموافقة","description":"طلب الإتلاف أو سحب الموافقة عندما تكون هي الأساس الوحيد، ما لم يوجد سبب نظامي مشروع للاحتفاظ أو المعالجة."}]},"style":{"variant":"light","align":"right","paddingY":84,"maxWidth":"wide","cssClass":"odeir-policy-rights"},"responsive":{}},{"id":"odeir-privacy-faq","type":"faq","props":{"anchor":"questions","eyebrow":"أسئلة مهمة","title":"تفاصيل لا نتركها مبهمة","body":"إجابات مباشرة عن المسؤولية، الطلبات، التكاملات، والحذف.","items":[{"title":"من يجيب عن طلب بيانات عميل أو متدرب داخل منشأة؟","description":"تكون المنشأة غالبًا هي المتحكم في هذه البيانات؛ لذلك يُقدّم الطلب إليها أولًا. تدعم أودير المنشأة فنيًا في تنفيذ التعليمات المشروعة ضمن دورها كمعالج."},{"title":"هل يستطيع مدير المنشأة طلب حذف جميع بيانات المساحة؟","description":"نعم، بعد التحقق من هويته وصلاحيته ومن عدم وجود مانع نظامي أو نزاع قائم. قد يتعذر التراجع عن الحذف بعد بدء التنفيذ وانتهاء مهلة الاسترداد الفنية المعلنة."},{"title":"هل تتوقف كل المعالجة فور الإلغاء؟","description":"يتوقف الاستخدام التشغيلي وفق مسار الإنهاء، بينما قد تستمر معالجة محدودة لإتمام التصدير أو الإغلاق أو الوفاء بالتزام نظامي أو إطفاء النسخ الاحتياطية ضمن دورتها."},{"title":"هل تخضع التكاملات الخارجية لهذه السياسة فقط؟","description":"لا. عند تفعيل خدمة خارجية قد تطبق سياسة وشروط مزودها أيضًا، وتتحمل المنشأة مسؤولية اختيار التكامل وإعداداته ومشروعية البيانات المرسلة إليه."},{"title":"ماذا يحدث عند حادثة أمنية؟","description":"نقيّم الواقعة ونحتويها ونعالجها، ونخطر الجهة المختصة أو المتأثرين عندما تستوجب الأنظمة ذلك وبالمعلومات المتاحة دون إضعاف التحقيق أو الأمن."},{"title":"هل يمكن تحديث هذه السياسة؟","description":"نعم عند تغير الخدمة أو المتطلبات. ننشر تاريخ النسخة الجديدة، ونقدم إشعارًا مناسبًا عندما يكون التغيير جوهريًا، ولا نطبق غرضًا جديدًا غير متوافق دون أساس مناسب."}]},"style":{"variant":"light","align":"right","paddingY":82,"maxWidth":"reading","cssClass":"odeir-policy-faq"},"responsive":{}},{"id":"odeir-privacy-cta","type":"cta","props":{"anchor":"request","eyebrow":"طلب خصوصية أو استفسار","title":"لا ترسل بيانات حساسة في رسالة عامة.","body":"استخدم مسار حقوق البيانات أو قنوات الدعم الرسمية، أو راسل hello@marktone.sa. سنطلب فقط ما يلزم للتحقق من الهوية والصفة وحماية الطلب.","buttonLabel":"فتح صفحة حقوق البيانات","buttonHref":"/p/data-rights"},"style":{"variant":"brand","align":"right","paddingY":72,"maxWidth":"wide","cssClass":"odeir-policy-cta"},"responsive":{}}]}$privacy$::jsonb);

  update website.pages
  set title='سياسة الخصوصية وحوكمة البيانات',
      menu_label='سياسة الخصوصية',
      excerpt='كيف تجمع أودير البيانات وتستخدمها وتحميها، وما يحدث لها عند الإلغاء أو انتهاء الخدمة.',
      body='',
      content=v_document,
      template_key='builder',
      seo_title='سياسة الخصوصية وحوكمة البيانات | أودير',
      seo_description='تعرف على أدوار أودير والمنشأة، فئات البيانات وأغراض المعالجة، حقوق أصحاب البيانات، وخيارات التصدير أو الحذف عند الإنهاء.',
      status='published',
      visibility='public',
      page_kind='legal',
      canonical_url='/p/privacy-policy',
      robots='index,follow',
      published_at=coalesce(published_at,now()),
      updated_at=now()
  where site_id=v_site_id and slug='privacy-policy' and status<>'archived'
  returning id into v_page_id;

  if v_page_id is null then
    raise exception 'odeir_privacy_page_not_found';
  end if;

  insert into website.content_documents(
    site_id,entity_type,entity_id,schema_version,draft_document,published_document,
    draft_updated_at,published_at
  ) values(
    v_site_id,'page',v_page_id,1,v_document,v_document,now(),now()
  )
  on conflict(site_id,entity_type,entity_id) do update set
    schema_version=1,
    draft_document=excluded.draft_document,
    published_document=excluded.published_document,
    draft_updated_at=now(),
    published_at=now(),
    updated_at=now()
  returning id into v_document_id;

  select coalesce(max(version_number),0)+1 into v_version
  from website.content_document_versions
  where content_document_id=v_document_id;

  insert into website.content_document_versions(
    content_document_id,version_number,version_kind,document,note
  ) values(
    v_document_id,v_version,'published',v_document,
    'تحديث محتوى سياسة الخصوصية وحوكمة البيانات وخيارات التصدير والحذف'
  );
end
$$;

commit;
