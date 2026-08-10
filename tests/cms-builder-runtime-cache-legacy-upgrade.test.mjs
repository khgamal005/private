import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('builder runtime is versioned and authenticated builder routes are never cached',async()=>{
  const [wrapper,config,platformRoute,tenantRoute,pkg]=await Promise.all([
    source('components/page-builder-with-library.js'),source('next.config.mjs'),
    source('app/control/website/builder/[entityType]/[entityId]/page.js'),
    source('app/tenant/[slug]/website/builder/[entityType]/[entityId]/page.js'),
    source('package.json')
  ]);
  assert.match(wrapper,/BUILDER_RUNTIME_VERSION='2\.0\.0-beta\.28'/);
  assert.match(wrapper,/marktone-builder-runtime-badge/);
  assert.match(wrapper,/window\.location\.replace/);
  assert.match(config,/private, no-store, no-cache/);
  assert.match(config,/\/control\/website\/builder/);
  assert.match(config,/\/tenant\/:slug\/website\/builder/);
  assert.match(platformRoute,/fetchCache='force-no-store'/);
  assert.match(tenantRoute,/fetchCache='force-no-store'/);
  assert.equal(JSON.parse(pkg).version,'2.0.0-beta.29');
});

test('legacy one-column ZIP widgets can be upgraded into native sections',async()=>{
  const [hook,builder]=await Promise.all([source('components/use-page-builder.js'),source('components/page-builder.js')]);
  assert.match(hook,/upgradeLegacyTemplates/);
  assert.match(hook,/extractUpgradeableLegacyTemplate/);
  assert.match(hook,/createNativeTemplateBlocks/);
  assert.match(hook,/widgetKey==='imported-template'/);
  assert.match(builder,/ترقية القالب الآن/);
  assert.match(builder,/legacyUpgradeBar/);
});
