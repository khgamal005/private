import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('follow-up result can open the approved customer history beside the live form',async()=>{
  const [modal,history,layout,css]=await Promise.all([
    read('components/sales-followup-modal.js'),
    read('components/customer-history-drawer.js'),
    read('app/layout.js'),
    read('app/followup-split-history.css')
  ]);

  assert.match(modal,/dynamic\([\s\S]*customer-history-drawer/);
  assert.match(modal,/historyOpen/);
  assert.match(modal,/سجل العميل/);
  assert.match(modal,/mt-followup-modal-layer/);
  assert.match(modal,/CustomerHistoryDrawer/);
  assert.match(modal,/canEdit=\{false\}/);
  assert.match(history,/سجل العميل الكامل/);
  assert.match(css,/\.mt-followup-modal-layer\.is-split/);
  assert.match(css,/left:0;[\s\S]*right:auto;[\s\S]*width:52vw/);
  assert.match(css,/\.mt-customer-history-backdrop\{[\s\S]*display:none/);
  assert.match(css,/@media \(max-width:1180px\)/);
  assert.match(layout,/followup-split-history\.css/);
});
