begin;
do $$
declare
  v_site_id uuid;
  v_page_id uuid;
  v_document jsonb;
begin
  select id into v_site_id from website.sites where site_key='marktone-main' limit 1;
  select id into v_page_id from website.pages where site_id=v_site_id and is_home and status<>'archived' limit 1;
  if v_page_id is null then raise exception 'marktone_home_page_not_found'; end if;

  select content into v_document from website.pages where id=v_page_id for update;
  v_document:=jsonb_set(
    coalesce(v_document,'{}'::jsonb),
    '{blocks}',
    coalesce(v_document->'blocks','[]'::jsonb)||$blocks$[{"id":"row-faq","type":"columns","props":{"anchor":"faq","row":true,"layoutKey":"1","gap":18,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[{"id":"col-faq","width":"1fr","modules":[{"id":"faq-home","type":"faq","props":{"anchor":"","eyebrow":"الأسئلة الشائعة","title":"إجابات واضحة قبل أن تبدأ","body":"","items":[{"title":"هل ماركتون نظام فقط أم خدمة تشغيل أيضًا؟","description":"ماركتون منصة SaaS متخصصة، ويمكن إضافة خدمات التشغيل والتسويق والمبيعات والاستشارات حسب احتياج المنشأة."},{"title":"هل يمكن الربط مع المتجر الحالي؟","description":"نعم، بُنيت المنصة لتدعم التكامل مع المتاجر والقنوات المختلفة، وتُفعّل الموصلات المناسبة وفق إعدادات كل منشأة."},{"title":"هل أستطيع تحديد صلاحيات كل موظف؟","description":"نعم، يمكن إنشاء أدوار مخصصة وتحديد الشاشات والعمليات التي يراها وينفذها كل موظف."},{"title":"هل الموقع الإلكتروني قابل للتعديل؟","description":"نعم، يتضمن النظام CMS وMarktone Builder لإنشاء الصفحات والمقالات والقوائم وصفحات الهبوط وتعديلها بصريًا."},{"title":"هل يمكن البدء بوحدة واحدة؟","description":"نعم، يمكنك البدء بالوحدات الأكثر أهمية ثم توسيع الاستخدام دون تغيير النظام أو إعادة نقل البيانات."},{"title":"كيف تبدأ التجربة المجانية؟","description":"سجّل بيانات المنشأة، اختر احتياجك الأساسي، ثم سيُجهز حسابك لتجربة المسار المناسب."}]},"style":{"variant":"light","align":"right","paddingY":0,"maxWidth":"reading","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"mt-faq"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}],"style":{"background":"","color":"","padding":0,"gap":14,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}]},"style":{"variant":"paper","align":"center","paddingY":85,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"mt-faq-row"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},{"id":"row-contact","type":"columns","props":{"anchor":"contact","row":true,"layoutKey":"1-1","gap":22,"fullWidth":false,"minHeight":0,"verticalAlign":"stretch","items":[{"id":"col-final-cta","width":"1fr","modules":[{"id":"cta-final","type":"cta","props":{"anchor":"","eyebrow":"ابدأ من اليوم","title":"حوّل مركزك من عمليات متفرقة إلى منظومة تعمل معًا","body":"ابدأ تجربة ماركتون، أو شاركنا التحدي الحالي لنقترح مسارًا مناسبًا وواضحًا.","buttonLabel":"ابدأ التجربة المجانية","buttonHref":"/free-trial"},"style":{"variant":"brand","align":"right","paddingY":0,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"mt-final-cta"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}],"style":{"background":"","color":"","padding":0,"gap":14,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}},{"id":"col-contact-form","width":"1fr","modules":[{"id":"contact-home","type":"contact","props":{"anchor":"","eyebrow":"تواصل معنا","title":"دعنا نفهم احتياج مركزك","body":"اكتب نبذة قصيرة عن التحدي أو الوحدة التي تهمك، وسيتواصل معك فريق ماركتون.","buttonLabel":"إرسال الطلب"},"style":{"variant":"light","align":"right","paddingY":0,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"mt-contact-card"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}],"style":{"background":"","color":"","padding":0,"gap":14,"borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","verticalAlign":"stretch"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}]},"style":{"variant":"light","align":"right","paddingY":75,"maxWidth":"wide","background":"","color":"","borderColor":"","borderWidth":0,"borderRadius":0,"shadow":"none","animation":"none","animationDelay":0,"cssClass":"mt-contact-row"},"responsive":{"hideDesktop":false,"hideTablet":false,"hideMobile":false}}]$blocks$::jsonb,
    true
  );
  v_document:=private_app.website_builder_validate_document(v_document);

  update website.pages set content=v_document,updated_at=now() where id=v_page_id;
  update website.content_documents
  set draft_document=v_document,published_document=v_document,
      draft_updated_at=now(),published_at=now(),updated_at=now()
  where site_id=v_site_id and entity_type='page' and entity_id=v_page_id;
end
$$;
commit;
