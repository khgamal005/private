import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('saved blocks and modules honor the exact top-level drop index',async()=>{
  const [hook,builder]=await Promise.all([
    source('components/use-page-builder.js'),source('components/page-builder.js')
  ]);
  assert.match(hook,/function insertSaved\(item,index\)/);
  assert.match(hook,/addBlockDefinition\(item\.data,index\)/);
  assert.match(hook,/index===undefined\?defaultTopIndex\(true\):index/);
  assert.match(hook,/if\(index===undefined\)\{[\s\S]*?currentModuleTarget/);
  assert.match(builder,/application\/x-marktone-saved-block/);
  assert.match(builder,/application\/x-marktone-saved-module/);
  assert.match(builder,/data-builder-scroll-container="true"/);
});

test('canvas uses magnetic before and after drop targets instead of appending blindly',async()=>{
  const [renderer,css,proCss]=await Promise.all([
    source('components/page-document-renderer.js'),
    source('components/page-document-renderer.module.css'),
    source('components/page-document-renderer-pro.module.css')
  ]);
  assert.match(renderer,/resolveTopDropIndex/);
  assert.match(renderer,/event\.clientY<rect\.top\+rect\.height\/2\?index:index\+1/);
  assert.match(renderer,/data-builder-drop-index/);
  assert.match(renderer,/activeTopDrop/);
  assert.match(renderer,/autoScrollBuilder/);
  assert.match(renderer,/onMoveBlock/);
  assert.doesNotMatch(renderer,/normalized\.blocks\.length,event/);
  assert.match(css,/activeDropZone/);
  assert.match(css,/dropTargetBefore/);
  assert.match(proCss,/precise-column-drop-v1/);
});

test('builder exposes large drag handles and deterministic move buttons',async()=>{
  const renderer=await source('components/page-document-renderer.js');
  assert.match(renderer,/اسحب الشريط لنقل البلوك/);
  assert.match(renderer,/رفع البلوك خطوة/);
  assert.match(renderer,/خفض البلوك خطوة/);
  assert.match(renderer,/onMoveBlock\?\.\(block\.id,-1\)/);
  assert.match(renderer,/onMoveBlock\?\.\(block\.id,1\)/);
});
