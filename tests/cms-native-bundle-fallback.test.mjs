import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
async function source(path){return readFile(new URL(path,root),'utf8')}

test('missing legacy native bundle falls back to index html and css',async()=>{
  const route=await source('app/api/cms/templates/native/route.js');
  assert.match(route,/isMissingStorageObject/);
  assert.match(route,/status!==400/);
  assert.match(route,/object\[ _-\]\*not/);
  assert.match(route,/buildLegacyBundle/);
  assert.match(route,/cache:'no-store'/);
});

test('template insertion asks append or replace before reading the native package',async()=>{
  const [hook,provider,client,wrapper,pkg]=await Promise.all([
    source('components/use-page-builder.js'),
    source('components/template-import-mode-provider.js'),
    source('lib/cms-native-template-client.js'),
    source('components/page-builder-with-library.js'),
    source('package.json')
  ]);
  const choose=hook.indexOf('await chooseTemplateImportMode');
  const load=hook.indexOf('await loadNativeTemplatePackage',choose);
  assert.ok(choose>=0&&load>choose);
  assert.match(provider,/pendingAnalysis/);
  assert.match(client,/templates\/native\?\$\{params\}.*cache:'no-store'/s);
  assert.match(wrapper,/2\.0\.0-beta\.29/);
  assert.match(pkg,/"version": "2\.0\.0-beta\.29"/);
});
