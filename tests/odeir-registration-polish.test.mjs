import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('registration modal uses the new logo and isolates Arabic typography',async()=>{
  const [modal,polish]=await Promise.all([
    read('components/odeir-registration-modal.tsx'),
    read('components/odeir-registration-polish.module.css')
  ]);

  assert.match(modal,/odeir-registration-polish\.module\.css/);
  assert.match(modal,/polish\.header/);
  assert.match(modal,/polish\.brand/);
  assert.match(modal,/polish\.form/);
  assert.match(modal,/src="\/odeir\/odeir-logo-transparent\.webp"/);
  assert.match(modal,/width=\{260\}/);
  assert.match(modal,/height=\{105\}/);

  assert.match(polish,/--registration-font:/);
  assert.match(polish,/\.free-trial-route button/);
  assert.match(polish,/font-family:\s*var\(--registration-font\)\s*!important/);
  assert.match(polish,/\.step > span/);
  assert.match(polish,/\.result-copy b/);
  assert.match(polish,/white-space:\s*normal\s*!important/);
  assert.match(polish,/font-weight:\s*700\s*!important/);
  assert.match(polish,/@media \(max-width: 650px\)/);
});
