import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('visual builder stores isolated drafts and published documents',async()=>{
  const [core,api]=await Promise.all([
    read('supabase/migrations/20260803163000_marktone_visual_builder_core_v1.sql'),
    read('supabase/migrations/20260803163100_marktone_visual_builder_api_v1.sql')
  ]);
  const migration=`${core}\n${api}`;
  assert.match(migration,/create table if not exists website\.page_documents/);
  assert.match(migration,/draft_document jsonb/);
  assert.match(migration,/published_document jsonb/);
  assert.match(migration,/create table if not exists website\.page_document_versions/);
  assert.match(migration,/website_builder_validate_document/);
  assert.match(migration,/jsonb_array_length\(v_blocks\)>80/);
  assert.match(migration,/revoke all on table website\.page_documents/);
  assert.match(migration,/v2_platform_page_builder_snapshot/);
  assert.match(migration,/v2_platform_page_builder_action/);
});

test('builder supports components, responsive controls, history and safe publish',async()=>{
  const [registry,builderMain,builderState,builderInspector,renderer,route]=await Promise.all([
    read('lib/website-builder.js'),
    read('components/page-builder.js'),
    read('components/use-page-builder.js'),
    read('components/page-builder-inspector.js'),
    read('components/page-document-renderer.js'),
    read('app/api/platform/website-builder/[action]/route.js')
  ]);
  const builder=`${builderMain}\n${builderState}\n${builderInspector}`;
  for(const type of ['hero','text','image','cards','stats','columns','faq','contact','spacer']){
    assert.match(registry,new RegExp(`${type}:`));
  }
  assert.match(builder,/application\/x-marktone-new-block/);
  assert.match(builder,/save-draft/);
  assert.match(builder,/restore-version/);
  assert.match(builder,/hideMobile/);
  assert.match(builder,/Ctrl \+ S/);
  assert.match(renderer,/PageDocumentRenderer/);
  assert.match(renderer,/data-hide-mobile/);
  assert.match(route,/ACCESS_COOKIE/);
  assert.match(route,/v2_platform_page_builder_action/);
});

test('published visual pages render through the public Marktone shell',async()=>{
  const [page,built]=await Promise.all([
    read('app/p/[slug]/page.js'),
    read('components/built-public-page.js')
  ]);
  assert.match(page,/isBuilderDocument/);
  assert.match(page,/BuiltPublicPage/);
  assert.match(built,/marktone-logo-light\.svg/);
  assert.match(built,/PageDocumentRenderer/);
  assert.match(built,/دخول العملاء/);
});
