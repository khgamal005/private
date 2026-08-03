import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('public site renders from the published website snapshot',()=>{
  const page=read('app/page.js');
  const publicSite=read('components/public-site.js');
  assert.match(page,/getPublicSiteSnapshot/);
  assert.match(publicSite,/customerLoginUrl/);
  assert.match(publicSite,/api\/public\/contact/);
  assert.match(publicSite,/marktone-logo-light\.svg/);
});

test('website management is protected by platform authentication',()=>{
  const page=read('app/control/website/page.js');
  const route=read('app/api/platform/website/[action]/route.js');
  assert.match(page,/requirePlatform\(\)/);
  assert.match(page,/v2_platform_site_snapshot/);
  assert.match(route,/ACCESS_COOKIE/);
  assert.match(route,/v2_platform_site_action/);
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
