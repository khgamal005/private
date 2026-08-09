import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {
  TemplateRuntimeError,buildTemplateCsp,buildTemplateErrorDocument,
  normalizeTemplateEntryUrl,rewriteTemplateDocument,templateAssetBase
} from '../lib/cms-template-runtime.js';

const storage='https://gswpbwdactcstkasddta.supabase.co';
const entry=`${storage}/storage/v1/object/public/cms-template-assets/68759926-48d2-4fa8-8bbf-4311b6752d44/52e5531f-b1a6-412f-bc0b-9bb350160eea/r1/index.html`;
const root=new URL('../',import.meta.url);

function rejects(code,value=entry,origin=storage){
  assert.throws(()=>normalizeTemplateEntryUrl(value,origin),error=>error instanceof TemplateRuntimeError&&error.code===code);
}

test('accepts only the configured Supabase template entry path',()=>{
  const normalized=normalizeTemplateEntryUrl(entry,storage);
  assert.equal(normalized.href,entry);
  assert.equal(templateAssetBase(normalized),entry.replace(/index\.html$/,'') );
  rejects('template_origin_invalid',entry.replace('gswpbwdactcstkasddta','attacker'));
  rejects('template_path_invalid',`${storage}/storage/v1/object/public/other/68759926-48d2-4fa8-8bbf-4311b6752d44/52e5531f-b1a6-412f-bc0b-9bb350160eea/r1/index.html`);
  rejects('template_path_invalid',entry.replace('/index.html','/../secret.html'));
});

test('rewrites storage HTML into a real isolated runtime document',()=>{
  const input='<!doctype html><html lang="ar"><head><meta http-equiv="Content-Security-Policy" content="default-src none"><base href="https://evil.test/"><link rel="stylesheet" href="styles.css"></head><body><h1>عنوان <em>مميز</em></h1><script src="script.js"></script><script data-marktone-bridge>old()</script></body></html>';
  const output=rewriteTemplateDocument(input,entry);
  assert.match(output,new RegExp(`<base href="${entry.replace(/index\.html$/,'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}">`));
  assert.match(output,/data-marktone-runtime-bridge/);
  assert.match(output,/marktone:template-ready/);
  assert.match(output,/marktone:template-text-change/);
  assert.match(output,/data-marktone-text-id/);
  assert.doesNotMatch(output,/https:\/\/evil\.test/);
  assert.doesNotMatch(output,/old\(\)/);
  assert.match(output,/<script src="script\.js"><\/script>/);
});

test('runtime CSP keeps the app isolated while allowing normal template assets',()=>{
  const policy=buildTemplateCsp(entry);
  assert.match(policy,/script-src https: 'unsafe-inline'/);
  assert.match(policy,/style-src https: 'unsafe-inline'/);
  assert.match(policy,/font-src https: data:/);
  assert.match(policy,/connect-src 'none'/);
  assert.match(policy,/form-action 'none'/);
  assert.match(policy,/base-uri https:\/\/gswpbwdactcstkasddta\.supabase\.co/);
});

test('error document reports the failure to the parent safely',()=>{
  const output=buildTemplateErrorDocument('</script><script>alert(1)</script>');
  assert.match(output,/marktone:template-error/);
  assert.doesNotMatch(output,/<script>alert\(1\)<\/script>/);
});

test('builder renderer routes imported ZIP templates through the v2 runtime',async()=>{
  const [renderer,wrapper,client,route]=await Promise.all([
    readFile(new URL('components/page-document-renderer.js',root),'utf8'),
    readFile(new URL('components/page-builder-module-view-runtime.js',root),'utf8'),
    readFile(new URL('components/imported-template-runtime.js',root),'utf8'),
    readFile(new URL('app/api/cms/templates/runtime/route.js',root),'utf8')
  ]);
  assert.match(renderer,/page-builder-module-view-runtime/);
  assert.match(wrapper,/ImportedTemplateRuntime/);
  assert.match(client,/srcDoc=\{srcDoc\}/);
  assert.match(client,/props\.textOverrides/);
  assert.match(client,/allow-scripts allow-modals/);
  assert.match(route,/rewriteTemplateDocument/);
});
