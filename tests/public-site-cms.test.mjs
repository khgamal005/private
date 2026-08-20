import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('public site renders from the published CMS website snapshot',()=>{
  const page=read('app/page.js');
  const publicSite=read('components/public-site.js');
  const builtPage=read('components/built-public-page.js');
  assert.match(page,/getCmsPublicSnapshot/);
  assert.match(page,/BuiltPublicPage/);
  assert.match(page,/isBuilderDocument/);
  assert.match(builtPage,/PageDocumentRenderer/);
  assert.match(publicSite,/customerLoginUrl/);
  assert.match(publicSite,/api\/public\/contact/);
  assert.match(publicSite,/OdeirBrand/);
});

test('lifetime-free program has an editable landing page and a working application route',()=>{
  const page=read('app/free-trial/page.js');
  const applyPage=read('app/free-trial/apply/page.js');
  const wrapper=read('components/lifetime-free-application.js');
  const landing=read('components/free-trial-landing.js');
  assert.match(page,/getCmsPublicSnapshot/);
  assert.match(page,/pageSlug:'free-trial'/);
  assert.match(page,/BuiltPublicPage/);
  assert.match(applyPage,/LifetimeFreeApplication/);
  assert.match(wrapper,/ابدأ مع أودير مجانًا/);
  assert.match(wrapper,/FreeTrialLanding/);
  assert.match(landing,/marktone-free-trial/);
  assert.match(landing,/المؤسسة العامة للتدريب التقني والمهني/);
});

test('company homepage migration preserves the old platform page and publishes the service portfolio',()=>{
  const migration=read('supabase/migrations/20260805001500_company_home_and_lifetime_free.sql');
  assert.match(migration,/v_trial_document:=v_current_home/);
  assert.match(migration,/برنامج ماركتون المجاني مدى الحياة/);
  assert.match(migration,/مركز الاتصال للمبيعات وخدمة العملاء/);
  assert.match(migration,/تطوير العمليات والحلول التقنية/);
  assert.match(migration,/الاستشارات الإدارية والجودة/);
  assert.match(migration,/الشراكات الدولية في التعليم والتدريب/);
  assert.match(migration,/إعداد وتطوير الحقائب التدريبية/);
  assert.match(migration,/company_home_block_count_invalid/);
  assert.match(migration,/content_document_versions/);
});

test('website management is protected by platform authentication and the CMS v3 boundary',()=>{
  const page=read('app/control/website/page.js');
  const route=read('app/api/cms/[action]/route.js');
  assert.match(page,/requirePlatform\(\)/);
  assert.match(page,/v3_cms_workspace_snapshot/);
  assert.match(page,/CmsStudio/);
  assert.match(route,/ACCESS_COOKIE/);
  assert.match(route,/v3_cms_action/);
});

test('CMS migration exposes only narrow RPC boundaries',()=>{
  const migration=read('supabase/migrations/20260803141411_marktone_public_site_cms_v1.sql');
  assert.match(migration,/create schema if not exists website/i);
  assert.match(migration,/revoke all on schema website from public, anon, authenticated/i);
  assert.match(migration,/v2_public_site_snapshot/i);
  assert.match(migration,/v2_public_site_submit_contact/i);
  assert.match(migration,/v2_platform_site_snapshot/i);
  assert.match(migration,/v2_platform_site_action/i);
  assert.match(migration,/platform\.website\.manage/i);
});

test('page menu hardening handles slug and visibility changes',()=>{
  const migration=read('supabase/migrations/20260803143208_marktone_public_site_cms_hardening_v1.sql');
  assert.match(migration,/website_sync_page_menu/i);
  assert.match(migration,/old\.slug is distinct from new\.slug/i);
  assert.match(migration,/show_in_menu/i);
});
