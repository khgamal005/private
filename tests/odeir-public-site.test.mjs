import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('ODEIR launch migration publishes the concise builder-managed public site',async()=>{
  const migration=await read('supabase/migrations/20260820183034_odeir_public_site_launch.sql');
  assert.match(migration,/name_ar='أودير',name_en='ODEIR'/);
  assert.match(migration,/primary_domain='odeir\.com'/);
  assert.match(migration,/سجّل منشأتك مجانًا/);
  assert.match(migration,/تسجيل دخول المنشآت/);
  assert.match(migration,/website\.content_documents/);
  assert.match(migration,/page_kind='legal'/);
  for(const slug of ['privacy-policy','information-security','terms-of-use','cookie-policy','data-rights']){
    assert.match(migration,new RegExp(`"slug":"${slug}"`));
  }
  assert.doesNotMatch(migration,/core\.tenants|reef_skills|شركة ريف/);
});

test('ODEIR registration and authentication entry points carry the new identity',async()=>{
  const [application,trial,login,brand,modal,modalStyles,applyPage,trialStyles,landingStyles]=await Promise.all([
    read('components/lifetime-free-application.js'),
    read('components/free-trial-landing.js'),
    read('app/login/page.js'),
    read('components/odeir-brand.js'),
    read('components/odeir-registration-modal.tsx'),
    read('components/odeir-registration-modal.module.css'),
    read('app/free-trial/apply/page.js'),
    read('app/free-trial/free-trial.css'),
    read('app/odeir-landing-experience.css')
  ]);
  assert.match(application,/OdeirBrand/);
  assert.match(trial,/مرحبًا بمنشأتك في أودير/);
  assert.match(application,/registrationOnly=\{embedded\}/);
  assert.match(trial,/aria-label="تسجيل منشأة في أودير"/);
  assert.match(trial,/registrationOnly/);
  assert.match(trial,/اعثر على منشأتك/);
  assert.doesNotMatch(trial,/ريف|reef/i);
  assert.match(login,/تسجيل دخول المنشآت \| أودير/);
  assert.match(brand,/inverse\?'\/odeir\/odeir-logo-dark\.png':'\/odeir\/odeir-logo-official\.png'/);
  assert.match(brand,/أودير ODEIR/);
  assert.match(modal,/createPortal/);
  assert.match(modal,/role="dialog"/);
  assert.match(modal,/event\.key === "Escape"/);
  assert.match(modal,/FreeTrialLanding/);
  assert.match(modal,/<FreeTrialLanding registrationOnly \/>/);
  assert.doesNotMatch(modal,/<iframe|\/free-trial\/apply\?embedded=1/);
  assert.match(modal,/styles\.layer/);
  assert.match(modal,/styles\.dialog/);
  assert.match(modal,/styles\.footer/);
  assert.match(modalStyles,/\.form :global\(\.trial-card\)/);
  assert.match(modalStyles,/\.dialog\.dialog/);
  assert.match(modalStyles,/overflow:\s*visible\s*!important/);
  assert.match(modalStyles,/scrollbar-width:\s*none/);
  assert.match(modalStyles,/--trial-accent:\s*#0b8f8b/);
  assert.match(modalStyles,/registration-only-hero span\)[\s\S]*color:\s*inherit\s*!important/);
  assert.match(modalStyles,/\.close\.close:focus-visible[\s\S]*rgba\(124,\s*229,\s*223,/);
  assert.doesNotMatch(modalStyles,/#(?:d5ae58|ead49a|fff9e9|84630e|876717)/i);
  assert.match(modalStyles,/@media \(max-width: 650px\)/);
  assert.match(applyPage,/searchParams/);
  assert.match(applyPage,/embedded=\{query\?\.embedded==='1'\}/);
  assert.match(trialStyles,/Registration flow clarity and embedded modal surface/);
  assert.match(landingStyles,/\.registration-modal-layer/);
  assert.match(landingStyles,/@media \(max-width: 620px\)[\s\S]+\.registration-modal-dialog/);
});

test('ODEIR production homepage uses the interactive, builder-backed landing experience',async()=>{
  const integrationLogoNames=[
    'salla-color.svg','zid-color.svg','shopify.svg','woocommerce-color.svg','other-stores.svg',
    'meta-color.svg','instagram-color.svg','google-ads-color.svg','snapchat-color.svg','tiktok-color.svg','x-color.svg',
    'yeastar-color.svg','salesforce-color.svg','hubspot-color.svg','zoho-crm-color.svg',
    'tvtc-color.svg','mnar-color.svg','nelc-color.svg','zatca-color.svg',
    'zoom-color.svg','google-meet-color.svg','whatsapp-color.svg','lms.svg','certified-instructors.svg'
  ];
  const [page,landing,styles,layout,...journeyLogos]=await Promise.all([
    read('app/page.js'),
    read('components/odeir-landing-experience.tsx'),
    read('app/odeir-landing-experience.css'),
    read('app/layout.js'),
    ...integrationLogoNames.map(name=>read(`public/integrations/${name}`))
  ]);
  assert.match(page,/OdeirLandingExperience/);
  assert.match(page,/landingCms\(snapshot,home\)/);
  assert.match(page,/snapshot\?\.articles/);
  assert.match(page,/readingMinutes:article\.readingMinutes/);
  for(const blockId of ['odeir-home-hero','odeir-capabilities','odeir-trust','odeir-faq','odeir-final-cta']){
    assert.match(page,new RegExp(blockId));
  }
  assert.match(landing,/تجربة توضيحية · بيانات افتراضية/);
  assert.match(landing,/سلة/);
  assert.match(landing,/زد/);
  assert.match(landing,/WooCommerce/);
  assert.match(landing,/بيانات منشأتك/);
  assert.match(landing,/id="morning-brief"/);
  assert.match(landing,/اعرف أين توجد الفرصة/);
  assert.match(landing,/المناقصات والمنافسات ذات الصلة بالتعليم والتدريب/);
  assert.match(landing,/الفرصة التي لا تصل لصاحب القرار في وقتها/);
  assert.match(landing,/المواد العامة المنشورة/);
  assert.match(landing,/function MarketplaceShowcase/);
  assert.match(landing,/id="marketplace"/);
  assert.match(landing,/خدمات بضمان ماركتون/);
  assert.match(landing,/ماذا يعني ضمان ماركتون؟/);
  for(const category of ['المحاضرون والمدربون','التصميم والإبداع','المحتوى والحقائب','التسويق والنمو','المبيعات وخدمة العملاء','الاستشارات والتشغيل','التقنية والمنصات']){
    assert.match(landing,new RegExp(category));
  }
  for(const method of ['تحويل بنكي','تمارا','Paymob','مدى','VISA','Mastercard']){
    assert.match(landing,new RegExp(method));
  }
  assert.match(landing,/function PaymentMethodLogo/);
  assert.match(landing,/className={`payment-logo payment-logo--\${method\.kind}`} role="img" aria-label=\{method\.label\}/);
  assert.match(landing,/marketplace-payment-logo-card/);
  assert.doesNotMatch(landing,/className=\{method\.className\}[^>]*>\{method\.label\}<\/span>/);
  for(const officialLogo of [
    'cdn.prod.website-files.com/67c184892f7a84b971ff49d9/68931b49f2808979578bdc64_tamara-text-logo-black-en.svg',
    'paymob.com/images/paymobLogo.png',
    'www.sama.gov.sa/ar-sa/payment/PublishingImages/mada-logo.svg',
    'cdn.visa.com/v2/assets/images/logos/visa/blue/logo.png',
    'www.mastercard.com/content/dam/mccom/shared/header/ma_symbol.svg'
  ]) assert.match(landing,new RegExp(officialLogo.replaceAll('/','\\/')));
  assert.match(landing,/loading="lazy" decoding="async" referrerPolicy="no-referrer"/);
  assert.doesNotMatch(landing,/tamara-symbol|paymob-symbol|mada-signal|mastercard-red|mastercard-orange/);
  assert.doesNotMatch(landing,/تعرض هذه الوسائل لتوضيح الخيارات التي يمكن إتاحتها|marketplace-availability-note/);
  assert.match(landing,/<RoleSwitcher \/>[\s\S]*<MarketplaceShowcase onRegister=\{openRegistration\} \/>[\s\S]*<SecuritySection cms=\{cms\} kickerNumber="07" \/>/);
  assert.match(landing,/بيانات منشأتك… أمانة تُدار بمسؤولية/);
  assert.match(landing,/نظام حماية البيانات الشخصية ولائحته التنفيذية/);
  assert.match(landing,/تدابير تنظيمية وإدارية وتقنية/);
  assert.doesNotMatch(landing,/مضمونة 100%|متوافقون بالكامل|معتمدون من سدايا/);
  assert.match(landing,/heroShellRef/);
  assert.match(landing,/className="odeir-home-hero"/);
  assert.match(landing,/function HeroSnapshot/);
  assert.match(landing,/<aside className="hero-snapshot"[^>]+aria-label="لوحة تشغيل توضيحية"/);
  assert.match(landing,/const OPERATING_SYSTEM_HERO = \{/);
  assert.match(landing,/عرفنا أين تنجح المنشآت… وأين تتعطل\. ثم بنينا أودير\./);
  assert.match(landing,/أودير منظومة تشغيل حديثة بُنيت من خبرة حقيقية بما ينجح في السوق/);
  assert.match(landing,/معايير واضحة لكل وظيفة ومهمة ومسار/);
  assert.match(landing,/شاهد كيف تعمل المنظومة/);
  assert.match(landing,/defaults\.includes\(text\) \? polished : text/);
  assert.match(landing,/className="hero-title hero-title--operating-system"/);
  assert.match(landing,/className="hero-title-insight">عرفنا أين تنجح المنشآت…/);
  assert.match(landing,/className="hero-title-friction">وأين <em>تتعطل\.<\/em>/);
  assert.match(landing,/className="hero-title-accent hero-title-resolution">ثم بنينا أودير\./);
  assert.doesNotMatch(landing,/hero-title-(?:desktop|mobile)|MobileHeroSnapshot|<DashboardWindow hero \/>|className="hero-visual"/);
  assert.match(landing,/OdeirRegistrationModal/);
  assert.match(landing,/openRegistrationFromLink/);
  assert.match(landing,/registrationOpen/);
  assert.doesNotMatch(landing,/className="hero"/);
  for(const logo of integrationLogoNames.map(name=>`/integrations/${name}`)){
    assert.match(landing,new RegExp(logo.replaceAll('/','\\/')));
  }
  for(const asset of journeyLogos) assert.match(asset,/<svg[^>]+viewBox=/);
  for(const category of ['commerce','ads','sales','admissions','trainees']) assert.match(landing,new RegExp(`key: "${category}"`));
  for(const platform of ['Shopify','Google Ads','Snapchat','TikTok','Yeastar','Salesforce','HubSpot','Zoho CRM','منصة منار','المركز الوطني للتعليم الإلكتروني','هيئة الزكاة والضريبة والجمارك','Google Meet','WhatsApp Business','محاضرون معتمدون']) assert.match(landing,new RegExp(platform));
  assert.match(landing,/role="tablist" aria-label="أقسام التكامل"/);
  assert.match(landing,/className={`journey-network journey-network--\${activeCategory\.sources\.length}`}/);
  assert.match(landing,/className="journey-network-map"/);
  assert.match(landing,/className="core-orbit core-orbit--outer"/);
  assert.match(landing,/onPointerEnter=\{\(\) => setActiveNode\(index\)\}/);
  assert.match(landing,/عرض الجهات يوضح مواءمة مسارات التشغيل مع متطلباتها/);
  assert.match(landing,/لا يعني شراكة أو اعتمادًا رسميًا/);
  assert.match(landing,/أسماء وشعارات المنصات مملوكة لأصحابها/);
  assert.doesNotMatch(landing,/<i>☎<\/i>|source--wa(?:[\s"'])/);
  assert.match(styles,/\.odeir-experience \.hero-shell/);
  assert.match(styles,/\.odeir-experience \.odeir-home-hero/);
  assert.match(styles,/\.hero-copy h1 \.hero-title/);
  assert.match(styles,/font-family: inherit; font-size: inherit; font-weight: inherit; line-height: inherit; letter-spacing: inherit/);
  assert.match(layout,/family=Alexandria:wght@700/);
  assert.match(styles,/\.hero-copy h1\.hero-heading--operating-system \{ max-width: 760px; font-family: "Alexandria"/);
  assert.match(styles,/font-size: clamp\(40px, 4vw, 58px\); font-weight: 700; line-height: 1\.28; letter-spacing: 0/);
  assert.match(styles,/\.hero-title-friction em::after/);
  assert.match(styles,/\.hero-title-resolution::before/);
  assert.match(styles,/\.hero-copy > p\.hero-manifesto-body/);
  assert.match(styles,/\.site-header \.brand-link \{ padding: 12px; \}/);
  assert.match(styles,/\.site-header \.brand \{ padding: 0 !important; gap: 0 !important; \}/);
  assert.match(styles,/grid-template-columns: minmax\(500px, 1\.08fr\) minmax\(420px, \.92fr\)/);
  assert.match(styles,/\.hero-snapshot \{ position: relative; overflow: hidden; width: min\(100%, 570px\)/);
  assert.match(styles,/\.hero-snapshot \{ width: min\(620px, 100%\); margin: 0 auto; \}/);
  assert.match(styles,/\.hero-snapshot \{ width: 100%; padding: 16px;/);
  assert.match(styles,/@media \(min-width: 921px\)[\s\S]*\.odeir-home-hero \{[\s\S]*padding-inline: clamp\(32px, 4vw, 58px\);[\s\S]*background: transparent;[\s\S]*box-shadow: none;/);
  assert.match(styles,/\.hero-copy h1 \{ font-size: clamp\(41\.6px, 4vw, 59\.2px\); \}/);
  assert.match(styles,/\.final-cta h2 \{ font-size: clamp\(38\.4px, 4\.8vw, 65\.6px\); \}/);
  assert.match(styles,/@media \(min-width: 921px\) and \(max-width: 1180px\)[\s\S]*\.hero-copy h1 \{ font-size: clamp\(36px, 4\.24vw, 51\.2px\); \}/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]*\.odeir-home-hero \{ width: 100%; padding: 34px 20px 52px;/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]*\.hero-copy h1 \{ max-width: 390px; margin: 15px 0 17px; font-size: clamp\(34px, 9\.4vw, 40px\);/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]*\.hero-copy h1\.hero-heading--operating-system \{ max-width: 390px; font-size: clamp\(30px, 8\.5vw, 36px\)/);
  assert.doesNotMatch(styles,/hero-title-(?:desktop|mobile)|mobile-hero-snapshot|dashboard-window--hero|hero-orbit|floating-event|floating-result/);
  assert.match(styles,/\.morning-section/);
  assert.match(styles,/\.marketplace-section/);
  assert.match(styles,/\.marketplace-showcase/);
  assert.match(styles,/\.marketplace-payment-methods/);
  assert.match(styles,/\.marketplace-payment-logo-card/);
  assert.match(styles,/\.payment-logo--tamara/);
  assert.match(styles,/\.payment-logo--paymob/);
  assert.match(styles,/\.payment-logo--mada/);
  assert.match(styles,/\.payment-logo--visa/);
  assert.match(styles,/\.payment-logo--mastercard/);
  assert.doesNotMatch(styles,/tamara-symbol|paymob-symbol|mada-signal|mastercard-red|mastercard-orange|marketplace-availability-note/);
  assert.match(styles,/@keyframes marketplace-orbit/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]*\.service-category-cloud \{ margin-top: 24px; grid-template-columns: 1fr;/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]*\.addon-marketplace-item \{ position: static; width: 100%;/);
  assert.match(styles,/\.security-legal-note/);
  assert.match(styles,/\.security-links/);
  assert.match(styles,/\.journey-network-map/);
  assert.match(styles,/\.journey-category-tabs/);
  assert.match(styles,/scroll-snap-type: x mandatory/);
  assert.match(styles,/touch-action: manipulation/);
  assert.match(styles,/@keyframes network-signal/);
  assert.match(styles,/@keyframes core-breathe/);
  assert.match(styles,/@keyframes node-swap-in/);
  assert.match(styles,/\.network-node--position-5/);
  assert.match(styles,/\.network-node-label/);
  assert.doesNotMatch(styles,/@scope/);
  assert.doesNotMatch(landing,/ريف|reef/i);
  assert.doesNotMatch(page,/knowledge\/feed|tenantSlug|reef/i);
});

test('builder runtime renders the ODEIR product preview without changing generic tenant heroes',async()=>{
  const renderer=await read('components/page-builder-module-view.js');
  assert.match(renderer,/includes\('odeir-product-hero'\)/);
  assert.match(renderer,/odeirProductShell/);
  assert.match(renderer,/بيانات توضيحية/);
  assert.match(renderer,/<ButtonRow p=\{p\} editor=\{editor\}/);
});

test('the isolated design preview is static, noindex, and includes all policy routes',async()=>{
  const [home,legal,content]=await Promise.all([
    read('app/odeir-preview/page.js'),
    read('app/odeir-preview/[slug]/page.js'),
    read('lib/odeir-preview-content.js')
  ]);
  assert.match(home,/BuiltPublicPage/);
  assert.match(home,/index:false/);
  assert.match(legal,/dynamicParams=false/);
  assert.match(content,/#06182e/);
  assert.match(content,/#13c7d1/);
  assert.match(content,/#f0c534/);
  assert.match(content,/بيانات منشأتك… أمانة تُدار بمسؤولية/);
  assert.match(content,/نظام حماية البيانات الشخصية ولائحته التنفيذية/);
  for(const slug of ['privacy-policy','information-security','terms-of-use','cookie-policy','data-rights']){
    assert.match(content,new RegExp(`'${slug}'`));
  }
  assert.doesNotMatch(content,/supabase|TRIAL_API|core\.tenants/);
});
