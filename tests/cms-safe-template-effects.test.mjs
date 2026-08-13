import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('native ZIP templates restore supported effects without executing uploaded scripts',async()=>{
  const [effects,enhanced,runtime,client]=await Promise.all([
    source('components/native-template-safe-effects.js'),
    source('components/native-template-section-enhanced.js'),
    source('components/page-builder-module-view-runtime.js'),
    source('lib/cms-native-template-client.js')
  ]);
  assert.match(runtime,/native-template-section-enhanced/);
  assert.match(runtime,/scriptCount:Number\(p\.scriptCount\)\|\|0/);
  assert.match(enhanced,/activateSafeTemplateEffects/);
  assert.match(enhanced,/Safe Effects/);
  assert.match(effects,/IntersectionObserver/);
  assert.match(effects,/data-counter/);
  assert.match(effects,/scroll-progress/);
  assert.match(effects,/menu-toggle/);
  assert.match(effects,/gears-grid/);
  assert.match(effects,/journey-active/);
  assert.match(effects,/hero-image-wrap/);
  assert.match(effects,/carousel/);
  assert.match(effects,/role="tab"/);
  assert.doesNotMatch(effects,/\beval\s*\(/);
  assert.doesNotMatch(effects,/new Function/);
  assert.doesNotMatch(effects,/createElement\(['\"]script/);
  assert.match(client,/REMOVE_TAGS='script,/);
});
