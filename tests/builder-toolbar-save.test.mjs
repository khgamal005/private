import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('block and module toolbars expose one-click save beside delete',async()=>{
  const [builder,renderer,css,wrapper,pkg]=await Promise.all([
    source('components/page-builder.js'),
    source('components/page-document-renderer.js'),
    source('components/page-document-renderer.module.css'),
    source('components/page-builder-with-library.js'),
    source('package.json')
  ]);
  assert.match(builder,/onSaveToLibrary=\{saveToLibrary\}/);
  assert.match(builder,/setLibraryTab\('saved'\)/);
  assert.match(renderer,/onSave=\{\(\)=>onSaveToLibrary\?\.\('block',block\)\}/);
  assert.match(renderer,/onSaveToLibrary\?\.\('module',module\)/);
  assert.match(renderer,/حفظ البلوك في المحفوظات/);
  assert.match(renderer,/حفظ الموديول في المحفوظات/);
  assert.match(renderer,/☆ حفظ/);
  assert.match(css,/builder-toolbar-save-v1/);
  assert.match(wrapper,/2\.0\.0-beta\.30/);
  assert.equal(JSON.parse(pkg).version,'2.0.0-beta.30');
});
