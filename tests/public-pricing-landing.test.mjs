import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import React, {act} from 'react';

// Exercise the real client component against independently edited catalog offers.
// No production service, credential, tenant or checkout is involved.
test('pricing advisor, billing and add-on filters respect the supplied public catalog', async () => {
  const require = createRequire(import.meta.url);
  let source = await readFile(new URL('../components/public-pricing.js', import.meta.url), 'utf8');
  source = source
    .replace("import Link from 'next/link';", 'const Link=({href,children,...props})=><a href={href} {...props}>{children}</a>;')
    .replace("import {OdeirSiteHeader, OdeirSiteFooter} from './odeir-site-chrome';", 'const OdeirSiteHeader=()=>null;const OdeirSiteFooter=()=>null;')
    .replace("import styles from './public-pricing.module.css';", 'const styles=new Proxy({},{get:(_,key)=>key});');
  let code = ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
  code = code.replace(/from ['"]([^'"]+)['"]/g, (_, name) => `from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`);
  const Component = (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default;
  const dom = new JSDOM('<div id="root"></div>', {url: 'https://odeir.com/pricing'});
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const {createRoot} = await import('react-dom/client');
  const plan = (key, name, capacity, monthly, annual) => ({key, name, monthlyAmountMinor: monthly, annualAmountMinor: annual, profile: {description: 'وصف مُحدَّث من لوحة الإدارة', limits: {staff: capacity}}});
  const catalog = {
    plans: [plan('core_free', 'المجانية', 3, 0, 0), plan('core_basic', 'بداية مخصصة', 8, 9950, 149900), plan('core_professional', 'فريق مخصص', 12, 19900, 120050)],
    addons: [{key: 'whatsapp', name: 'واتساب', description: 'وصف المزود', monthlyAmountMinor: 3900, annualAmountMinor: 39000}, {key: 'templates', name: 'القوالب', monthlyAmountMinor: 0, annualAmountMinor: 0}, {key: 'future_connector', name: 'إضافة جديدة', monthlyAmountMinor: 2200, annualAmountMinor: 22000}],
  };
  const original = JSON.stringify(catalog);
  const root = createRoot(document.getElementById('root'));
  const click = async text => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === text);
    assert.ok(button, text);
    await act(() => button.click());
  };
  const setStaff = async value => {
    const input = document.getElementById('pricing-team-size');
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
    });
  };
  const recommendation = () => document.getElementById('advisor-result');
  const digits = value => value.replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 1632)).replace(/٫/g, '.').replace(/٬/g, '');
  try {
    await act(() => root.render(React.createElement(Component, {catalog})));
    assert.equal(document.querySelectorAll('h1').length, 1);
    assert.match(recommendation().textContent, /المجانية/);
    assert.equal(document.querySelector('#plan-core_free .planCta').getAttribute('href'), '/free-trial/apply');
    assert.doesNotMatch(document.body.textContent, /النسخة الكاملة/);
    await setStaff('8');
    assert.match(recommendation().textContent, /بداية مخصصة/);
    assert.equal(recommendation().querySelector('a').getAttribute('href'), '#plan-core_basic');
    assert.match(digits(document.querySelector('#plan-core_basic .price').textContent), /99.5/);
    await click('سنوي');
    assert.match(recommendation().textContent, /فريق مخصص/); // Annual editor prices can invert the cheapest qualifying offer.
    assert.match(digits(recommendation().textContent), /1200.5/);
    assert.doesNotMatch(document.querySelector('#plan-core_basic .saving').textContent, /وفّر/); // No invented annual discount.
    assert.equal(document.querySelector('#plan-core_professional .planCta').getAttribute('href'), '/login');
    await setStaff('13');
    assert.match(recommendation().textContent, /أكبر من السعات/);
    assert.equal(document.querySelectorAll('.recommended').length, 0);
    for (const invalid of ['', '0', '1.5']) {
      await setStaff(invalid);
      assert.match(recommendation().textContent, /عددًا صحيحًا/);
      assert.equal(recommendation().querySelector('strong'), null);
    }
    await click('التواصل');
    assert.equal(document.querySelectorAll('.addons article').length, 2);
    assert.doesNotMatch(document.querySelector('.addons').textContent, /إضافة جديدة/);
    assert.match(document.querySelector('.addons').textContent, /مجانية للجميع/);
    await click('كل الإضافات');
    assert.equal(document.querySelectorAll('.addons article').length, 3); // Unknown future keys stay discoverable.
    await click('شهري');
    assert.match(digits(document.querySelector('.addons').textContent), /39/);
    assert.equal(JSON.stringify(catalog), original);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
