import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('ODEIR homepage loads the Saudi typography layer and mobile tuning',async()=>{
  const [layout,styles]=await Promise.all([
    read('app/layout.js'),
    read('app/odeir-saudi-typography.css')
  ]);

  assert.match(layout,/import '\.\/odeir-saudi-typography\.css';/);
  assert.match(layout,/family=Tajawal:wght@400;500;600;700;800;900/);
  assert.match(styles,/--odeir-saudi-font:\s*"Tajawal"/);
  assert.match(styles,/\.hero-copy h1\.hero-heading--operating-system[\s\S]*font-weight:\s*800/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]*font-size:\s*clamp\(31px, 8\.2vw, 34px\)/);
  assert.match(styles,/\.hero-copy > p\.hero-manifesto-body[\s\S]*line-height:\s*1\.9/);
});
