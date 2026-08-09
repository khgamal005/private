import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('builder exposes HTML source and custom HTML insertion',async()=>{
  const [builder,modal,catalog,inspector,renderer]=await Promise.all([
    read('components/page-builder.js'),
    read('components/page-source-modal.js'),
    read('lib/website-builder.js'),
    read('components/page-builder-inspector.js'),
    read('components/page-builder-module-view.js')
  ]);
  assert.match(builder,/PageSourceModal/);
  assert.match(builder,/مشاهدة سورس HTML/);
  assert.match(builder,/addBlock\('html'\)/);
  assert.match(modal,/documentToHtml/);
  assert.match(modal,/Builder JSON/);
  assert.match(modal,/نسخ السورس/);
  assert.match(modal,/إضافة كود HTML للصفحة/);
  assert.match(catalog,/html:def\('HTML \/ Text \/ Shortcode'/);
  assert.match(inspector,/type==='html'/);
  assert.match(renderer,/safeHtmlDocument\(p\.content\)/);
  assert.match(renderer,/sandbox=""/);
  assert.match(renderer,/srcDoc=\{safeHtmlDocument\(p\.content\)\}/);
});

test('source serializer escapes metadata and keeps custom HTML isolated',async()=>{
  const modal=await read('components/page-source-modal.js');
  assert.match(modal,/escapeHtml\(page\?\.title/);
  assert.match(modal,/<!-- Custom HTML -->/);
  assert.match(modal,/safeCssValue/);
  assert.match(modal,/ملاحظة أمان/);
});
