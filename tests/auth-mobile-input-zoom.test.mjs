import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('mobile authentication fields avoid iOS focus zoom without disabling pinch zoom',async()=>{
  const [layout,styles,loginForm]=await Promise.all([
    read('app/layout.js'),
    read('app/auth-mobile-input-fix.css'),
    read('components/login-form.js')
  ]);

  assert.match(layout,/auth-mobile-input-fix\.css/);
  assert.match(loginForm,/className="auth-form"/);
  assert.match(styles,/\.auth-page \.auth-form input/);
  assert.match(styles,/font-size:\s*16px\s*!important/);
  assert.match(styles,/touch-action:\s*manipulation/);
  assert.doesNotMatch(styles,/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i);
});
