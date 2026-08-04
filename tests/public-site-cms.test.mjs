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
  assert.match(publicSite,/marktone-logo-light\.svg/);
});

test('free trial route is part of the Marktone public website',()=>{
  const page=read('app/free-trial/page.js');
  const landing=read('components/free-trial-landing.js');
  const publicSite=read('components/public-site.js');
  assert.match(page,/FreeTrialLanding/);
  assert.match(landing,/marktone-free-trial/);
  assert.match(landing,/ماركتون فلو/);
  assert.match(landing,/المؤسسة العامة للتدريب التقني والمهني/);
  assert.match(publicSite,/free-trial/);
  assert.match(publicSite,/جرّب الآن مجانًا/);
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
