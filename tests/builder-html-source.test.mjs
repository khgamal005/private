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
  assert.match(renderer,/HtmlSandbox content=\{p\.content\} pageCss=\{pageCss\}/);
  assert.match(renderer,/sandbox="allow-same-origin"/);
  assert.match(renderer,/safeHtmlDocument\(content,pageCss,editor\)/);
  assert.match(renderer,/data-marktone-editable/);
});

test('source serializer escapes metadata and keeps custom HTML isolated',async()=>{
  const modal=await read('components/page-source-modal.js');
  assert.match(modal,/escapeHtml\(page\?\.title/);
  assert.match(modal,/<!-- Custom HTML -->/);
  assert.match(modal,/safeCssValue/);
  assert.match(modal,/ملاحظة أمان/);
});

test('builder keeps ZIP import visible and editing gestures do not hijack text',async()=>{
  const [builder,cmsPages,documentRenderer,moduleRenderer]=await Promise.all([
    read('components/page-builder.js'),
    read('components/cms-studio-pages.js'),
    read('components/page-document-renderer.js'),
    read('components/page-builder-module-view.js')
  ]);
  assert.match(builder,/استيراد ZIP/);
  assert.match(builder,/\['templates','القوالب'\]/);
  assert.match(builder,/onDrop=\{handleZipDrop\}/);
  assert.match(builder,/get\('panel'\)==='templates'/);
  assert.match(cmsPages,/استيراد قالب ZIP/);
  assert.doesNotMatch(documentRenderer,/<article[^>]*\sdraggable(?:\s|>)/);
  assert.match(documentRenderer,/className=\{styles\.dragHandle\} draggable/);
  assert.match(documentRenderer,/pageCss=\{normalized\.settings\.customCss\}/);
  assert.match(moduleRenderer,/انقر على النص واكتب مباشرة/);
});
