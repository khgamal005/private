import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('native template renderer keeps media eager and materializes script-driven content safely',async()=>{
  const [client,section,wrapper,pkg]=await Promise.all([
    source('lib/cms-native-template-client.js'),
    source('components/native-template-section.js'),
    source('components/page-builder-with-library.js'),
    source('package.json')
  ]);
  assert.match(client,/markScriptlessScenes\(doc\)/);
  assert.match(client,/data-marktone-scriptless-scene/);
  assert.match(client,/\[data-start\]\[data-end\]/);
  assert.match(client,/height:auto!important/);
  assert.match(client,/opacity:1!important/);
  assert.match(client,/setAttribute\('loading','eager'\)/);
  assert.doesNotMatch(client,/setAttribute\('loading','lazy'\)/);
  assert.match(client,/fonts\.googleapis\.com/);
  assert.match(client,/bodyClass:safeClass/);
  assert.match(section,/template\.bodyClass/);
  assert.match(section,/template\.bodyStyle/);
  assert.match(wrapper,/2\.0\.0-beta\.29/);
  assert.equal(JSON.parse(pkg).version,'2.0.0-beta.29');
});
