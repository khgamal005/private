import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('all platform public content routes use the CMS v3 snapshot',async()=>{
  for(const path of ['app/p/[slug]/page.js','app/articles/page.js','app/articles/[slug]/page.js','app/free-trial/page.js']){
    const source=await read(path);
    assert.match(source,/getCmsPublicSnapshot/);
    assert.doesNotMatch(source,/getPublicSiteSnapshot/);
  }
});

test('legacy public fallback is explicit and free-trial is CMS-first',async()=>{
  const [loader,freeTrial]=await Promise.all([read('lib/cms-public.js'),read('app/free-trial/page.js')]);
  assert.match(loader,/CMS_V3_LEGACY_FALLBACK/);
  assert.match(loader,/cms_public_legacy_fallback_enabled/);
  assert.match(freeTrial,/PublicContentPage/);
  assert.match(freeTrial,/notFound\(\)/);
  assert.match(freeTrial,/CMS_V3_LEGACY_FALLBACK==='true'/);
});

test('custom HTML and imported templates use separate sandbox policies',async()=>{
  const renderer=await read('components/page-builder-module-view.js');
  assert.doesNotMatch(renderer,/dangerouslySetInnerHTML/);
  assert.match(renderer,/sandbox="allow-same-origin"/);
  assert.match(renderer,/sandbox="allow-scripts"/);
  assert.doesNotMatch(renderer,/sandbox="allow-scripts allow-same-origin"/);
  assert.match(renderer,/script-src 'none'/);
  assert.match(renderer,/safeCss\(pageCss\)/);
  assert.match(renderer,/referrerPolicy="no-referrer"/);
});

test('versioned migrations contain the full CMS v3 runtime and template boundary',async()=>{
  const [runtime,templates]=await Promise.all([
    read('supabase/migrations/20260808182900_cms_v3_runtime_reconciliation.sql'),
    read('supabase/migrations/20260808183000_cms_template_import_v1.sql')
  ]);
  for(const name of ['v3_cms_public_snapshot','v3_cms_action','v3_cms_builder_snapshot','v3_cms_builder_action','v3_cms_media_upload_ticket'])assert.match(runtime,new RegExp(name));
  assert.match(templates,/alter table website\.template_packages enable row level security/);
  assert.match(templates,/v3_cms_template_upload_ticket/);
  assert.match(templates,/v3_cms_template_import_action/);
  const catalog=templates.slice(templates.indexOf('create or replace function public.v3_cms_template_catalog'));
  assert.match(catalog,/language plpgsql security definer/);
  assert.doesNotMatch(catalog,/language plpgsql stable/);
  assert.match(catalog,/cms_resolve_site\(p_site_key,p_tenant_slug,'manage',false\)/);
  assert.match(catalog,/set search_path='' as \$\$/);
  assert.match(catalog,/end \$\$;/);
  assert.match(templates,/cms-template-staging/);
  assert.match(templates,/cms-template-assets/);
  assert.match(templates,/v3_cms_storage_can_write/);
  assert.match(templates,/cms_assets_insert/);
});
