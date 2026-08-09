import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);

async function source(path){return readFile(new URL(path,root),'utf8')}

test('native template sections remove page-shell scroll containers and synthetic builder chrome',async()=>{
  const [compiler,runtime,builder,hook]=await Promise.all([
    source('lib/cms-native-template-client.js'),
    source('components/native-template-section.js'),
    source('components/page-builder.js'),
    source('components/use-page-builder.js')
  ]);
  assert.match(compiler,/data-marktone-native-shell/);
  assert.match(compiler,/data-marktone-native-content/);
  assert.match(compiler,/overflow:visible!important/);
  assert.match(runtime,/normalizeNativeLayout/);
  assert.match(runtime,/scrollHeight>element\.clientHeight/);
  assert.match(builder,/!nativeTemplateCanvas&&<div className=\{styles\.liveHeader\}/);
  assert.match(builder,/!nativeTemplateCanvas&&<div className=\{styles\.liveFooter\}/);
  assert.match(hook,/normalizeEditorDocument/);
  assert.match(hook,/isEmptyLayoutRow/);
});

test('uploaded templates can be removed from the library without breaking existing pages',async()=>{
  const [route,migration,builder]=await Promise.all([
    source('app/api/cms/templates/delete/route.js'),
    source('supabase/migrations/20260809221500_cms_template_library_archive_v1.sql'),
    source('components/page-builder.js')
  ]);
  assert.match(route,/v3_cms_template_archive/);
  assert.match(route,/assetsRetained/);
  assert.match(migration,/archived_at is null/);
  assert.match(migration,/create or replace function public\.v3_cms_template_archive/);
  assert.match(builder,/\/api\/cms\/templates\/delete/);
  assert.match(builder,/templateDeleteButton/);
});
