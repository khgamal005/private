import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('builder pro exposes professional rows, presets and a broad module catalog',async()=>{
  const registry=await read('lib/website-builder.js');
  for(const layout of ["'1'","'1-1'","'1-2'","'2-1'","'1-1-1'","'1-2-1'","'1-1-1-1'","'1-1-1-1-1-1'"]){
    assert.match(registry,new RegExp(layout.replaceAll("'","\\'")));
  }
  for(const type of ['alert','accordion','code','callout','gallery','lottie','login','overlay','optin','menu','post','html','slider','table','tabs','rating','testimonials','video','timeline','products']){
    assert.match(registry,new RegExp(`${type}:`));
  }
  assert.match(registry,/createLayoutRow/);
  assert.match(registry,/changeLayoutRow/);
  assert.match(registry,/createSectionPreset/);
});

test('builder pro supports nested module drag and drop, inline editing and saved items',async()=>{
  const [builder,state,renderer,moduleView,inspector]=await Promise.all([
    read('components/page-builder.js'),read('components/use-page-builder.js'),
    read('components/page-document-renderer.js'),read('components/page-builder-module-view.js'),
    read('components/page-builder-inspector.js')
  ]);
  assert.match(builder,/application\/x-marktone-row-layout/);
  assert.match(builder,/application\/x-marktone-saved/);
  assert.match(builder,/Marktone Builder Pro/);
  assert.match(state,/application\/x-marktone-module/);
  assert.match(state,/handleColumnDrop/);
  assert.match(state,/moveModule/);
  assert.match(moduleView,/contentEditable/);
  assert.match(renderer,/ColumnDrop/);
  assert.match(renderer,/layoutRow/);
  assert.match(renderer,/COPY_DRAG_TYPES/);
  assert.match(renderer,/dropEffect=copySource\?'copy':'move'/);
  assert.match(renderer,/onDropAt\?\.\(normalized\.blocks\.length,event\)/);
  assert.match(inspector,/حفظ الصف في Saved/);
  assert.match(inspector,/رفع من الجهاز/);
});

test('builder pro validator protects rows, columns and nested modules',async()=>{
  const migration=await read('supabase/migrations/20260804183000_marktone_builder_pro_v2.sql');
  assert.match(migration,/builder_row_layout_invalid/);
  assert.match(migration,/builder_row_columns_invalid/);
  assert.match(migration,/builder_column_modules_invalid/);
  assert.match(migration,/builder_modules_limit/);
  assert.match(migration,/v_nested_count>240/);
  assert.match(migration,/website_builder_validate_document/);
});
