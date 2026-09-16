import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Google Kit is a display rename preserving entitlement, billing, activation and navigation',async()=>{
 const db=new PGlite();
 try{
  for(const path of ['tests/fixtures/campaign-revenue-schema.sql','supabase/migrations/20260906204652_unified_campaign_revenue_v1.sql','tests/fixtures/google-ads-schema.sql','supabase/migrations/20260909203555_google_ads_reader_v1.sql'])await db.exec(await readFile(path,'utf8'));
  const snapshot=async()=> (await db.query(`select jsonb_build_object(
   'products',(select jsonb_agg(to_jsonb(p)-array['name_ar','name_en','description_ar']) from catalog.addon_products p),
   'features',(select jsonb_agg(to_jsonb(f)-array['name_ar','name_en']) from catalog.features f),
   'manifests',(select jsonb_agg(to_jsonb(m)-array['short_description_ar','long_description_ar']) from catalog.addon_manifests m),
   'surfaces',(select jsonb_agg(to_jsonb(s)-array['title_ar','description_ar']) from catalog.addon_surfaces s),
   'rollouts',(select count(*) from google_ads.rollouts),
   'connections',(select count(*) from google_ads.connections)) as data`)).rows[0].data;
  const before=await snapshot();
  const migration=await readFile('supabase/migrations/20260915235010_google_kit_display_identity.sql','utf8');
  await db.exec(migration);
  assert.deepEqual(await snapshot(),before);
  assert.equal((await db.query("select name_ar from catalog.addon_products where product_key='google_ads_connect'")).rows[0].name_ar,'Google Kit');
  assert.equal((await db.query("select name_en from catalog.features where feature_key='addon.integrations.google_ads_connect'")).rows[0].name_en,'Google Kit');
  assert.equal((await db.query("select title_ar from catalog.addon_surfaces where surface_key='tenant.google_ads'")).rows[0].title_ar,'Google Kit');
  await db.exec(migration);
  assert.deepEqual(await snapshot(),before);
 }finally{await db.close();}
});

test('Google Kit report heading uses the new product name without changing the Google Ads source label',async()=>{
 const source=await readFile('components/google-ads-connect.js','utf8');
 assert.match(source,/<h1 dir="ltr">Google Kit<\/h1>/);
 assert.match(source,/إضافة Google Kit/);
 assert.match(source,/المصدر: Google Ads/);
 assert.doesNotMatch(source,/إضافة إعلانات جوجل/);
 const ga4=await readFile('components/google-ga4-report.js','utf8');
 assert.match(ga4,/ضمن إضافة Google Kit/);
 assert.match(ga4,/اشتراك Google Kit/);
 assert.doesNotMatch(ga4,/إضافة إعلانات جوجل|اشتراك إضافة جوجل/);
});
