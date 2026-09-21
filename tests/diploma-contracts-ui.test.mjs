import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function load(file) {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022}}).outputText;
  const mod = {exports: {}};
  const localRequire = name => {
    if (name.endsWith('.css')) return {__esModule: true, default: new Proxy({}, {get: (_, key) => key})};
    if (name === 'next/link') return {__esModule: true, default: ({children, ...props}) => React.createElement('a', props, children)};
    if (name.startsWith('.')) return load(resolve(dirname(file), name));
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${source}\n})`, {filename: file})(localRequire, mod, mod.exports);
  return mod.exports;
}
const Component = load(resolve(root, 'components/diploma-workspace.js')).default;
const base = {enabled: true, timezone: 'Asia/Riyadh', currency: 'SAR', collectionAutomationEnabled: false, automationContractCount: 1, schedulerAvailable: true,
  viewer: {canWrite: true, canApprove: true, canWaive: true, canClassify: false}, contracts: [], handoffs: [], courses: [], accounts: [], staff: [], invoices: [],
  selected: {id: 'contract-1', status: 'active', currentVersion: 2, learnerName: 'متدرب تجريبي', courseTitle: 'دبلوم تجريبي', totalMinor: 20000, currency: 'SAR',
    eligibility: {eligible: false, waiverApproved: false}, history: [], installments: [{id: 'first', dueOn: '2026-01-01', amountMinor: 10000, paidMinor: 0, state: 'overdue'}],
    settlementPreview: {issuedOutstandingMinor: 100, unbilledMinor: 10000, canClose: false, revision: 'financial-preview-1'}}};

async function mounted(data, run, respond = () => ({ok: true, json: async () => data})) {
  const dom = new JSDOM('<div id="root"></div>', {url: 'https://odeir.com/tenant/fixture/diplomas'}), saved = new Map();
  for (const [key, value] of Object.entries({window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true})) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  const oldFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => {const call = {url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null}; calls.push(call); return respond(call, calls);};
  const {createRoot} = await import('react-dom/client'); const app = createRoot(document.getElementById('root'));
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.includes(text));
  const click = async text => {const node = button(text); assert.ok(node); assert.equal(node.disabled, false); await act(async () => node.click());};
  const change = async (node, value) => {
    const proto = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new dom.window.Event('input', {bubbles: true})); node.dispatchEvent(new dom.window.Event('change', {bubbles: true}));});
  };
  const submit = async form => act(async () => form.dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true})));
  try {await act(async () => app.render(React.createElement(Component, {slug: 'fixture', initialData: data}))); await run({doc: document, calls, button, click, change, submit, dom});}
  finally {await act(async () => app.unmount()); globalThis.fetch = oldFetch; dom.window.close(); for (const [key, descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}}
}

test('disabled diploma rollout renders no mutation or automation control', async () => {
  await mounted({enabled: false}, async ({doc, calls}) => {assert.match(doc.body.textContent, /غير مفعلة/); assert.equal(doc.querySelectorAll('button').length, 0); assert.equal(calls.length, 0);});
});

test('admission payment exception clearly retains debt and an ambiguous network retry keeps its command identity', async () => {
  let posts = 0;
  await mounted(base, async ({doc, calls, change, submit}) => {
    assert.match(doc.body.textContent, /دون دفعة أولى مع بقاء المديونية/);
    const form = [...doc.querySelectorAll('form')].find(node => node.textContent.includes('استثناء القبول'));
    await change(form.querySelector('input'), 'قبول معتمد دون مقدم');
    await submit(form); assert.match(doc.querySelector('[role="alert"]').textContent, /انقطع الاتصال/);
    await submit(form);
    const writes = calls.filter(call => call.method === 'POST');
    assert.equal(writes.length, 2); assert.equal(writes[0].body.commandId, writes[1].body.commandId);
    assert.equal(writes[0].body.action, 'waive_first_installment'); assert.equal(writes[0].body.payload.reason, 'قبول معتمد دون مقدم');
    assert.equal(writes[0].body.payload.paymentAmountMinor, undefined);
  }, call => {if (call.method === 'POST' && ++posts === 1) throw new Error('انقطع الاتصال'); return {ok: true, json: async () => call.method === 'POST' ? {contractId: 'contract-1'} : base};});
});

test('settlement shows authoritative debt, blocks closure and sends confirmed preview revision', async () => {
  const data = {...base, selected: {...base.selected, status: 'settlement_review'}};
  await mounted(data, async ({doc, calls, button, change, submit}) => {
    const form = [...doc.querySelectorAll('form')].find(node => node.textContent.includes('تأكيد التسوية'));
    assert.equal(form.querySelector('option[value="closed"]').disabled, true);
    assert.equal(button('تأكيد التسوية').disabled, true);
    await change(form.querySelector('input:not([type="checkbox"])'), 'تحصيل الفواتير الصادرة فقط');
    await act(async () => form.querySelector('input[type="checkbox"]').click());
    await submit(form);
    const command = calls.find(call => call.method === 'POST').body;
    assert.equal(command.action, 'resolve_settlement'); assert.equal(command.payload.previewRevision, 'financial-preview-1');
    assert.equal(command.payload.confirmed, true); assert.equal(command.payload.resolution, 'collections_only');
    assert.equal(button('اعتماد استثناء القبول'), undefined);
  });
});

test('automation stays idle on load and only activates after count preview confirmation', async () => {
  await mounted(base, async ({doc, calls, button, click}) => {
    assert.equal(calls.length, 0); assert.equal(button('تفعيل المتابعة التلقائية').disabled, true);
    const section = [...doc.querySelectorAll('section')].find(node => node.querySelector('h2')?.textContent === 'المتابعة التلقائية للتحصيل');
    await act(async () => section.querySelector('input[type="checkbox"]').click()); await click('تفعيل المتابعة التلقائية');
    const command = calls.find(call => call.method === 'POST').body;
    assert.equal(command.action, 'set_collection_automation'); assert.deepEqual(command.payload, {enabled: true, confirmed: true, expectedContractCount: 1});
  });
});
