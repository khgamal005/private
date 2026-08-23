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
  const [application,trial,login,brand,modal,applyPage,trialStyles,landingStyles]=await Promise.all([
    read('components/lifetime-free-application.js'),
    read('components/free-trial-landing.js'),
    read('app/login/page.js'),
    read('components/odeir-brand.js'),
    read('components/odeir-registration-modal.tsx'),
    read('app/free-trial/apply/page.js'),
    read('app/free-trial/free-trial.css'),
    read('app/odeir-landing-experience.css')
  ]);
  assert.match(application,/OdeirBrand/);
  assert.match(application,/مرحبًا بمنشأتك في أودير/);
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
  assert.match(modal,/\/free-trial\/apply\?embedded=1/);
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
  const [page,landing,styles,...journeyLogos]=await Promise.all([
    read('app/page.js'),
    read('components/odeir-landing-experience.tsx'),
    read('app/odeir-landing-experience.css'),
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
  assert.match(landing,/خذ زبدة السوق مع قهوتك/);
  assert.match(landing,/المواد العامة المنشورة/);
  assert.match(landing,/heroShellRef/);
  assert.match(landing,/className="odeir-home-hero"/);
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
  assert.match(styles,/\.hero-copy h1 \.hero-title-mobile/);
  assert.match(styles,/font-family: inherit; font-size: inherit; font-weight: inherit; line-height: inherit; letter-spacing: inherit/);
  assert.match(styles,/\.site-header \.brand-link \{ padding: 12px; \}/);
  assert.match(styles,/\.site-header \.brand \{ padding: 0 !important; gap: 0 !important; \}/);
  assert.match(styles,/\.mobile-hero-snapshot/);
  assert.match(styles,/\.morning-section/);
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
  for(const slug of ['privacy-policy','information-security','terms-of-use','cookie-policy','data-rights']){
    assert.match(content,new RegExp(`'${slug}'`));
  }
  assert.doesNotMatch(content,/supabase|TRIAL_API|core\.tenants/);
});
