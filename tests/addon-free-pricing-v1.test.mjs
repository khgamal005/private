import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const ROOT=process.cwd();
const read=path=>readFileSync(resolve(ROOT,path),'utf8');
const migration=read('supabase/migrations/20260916173000_addon_free_pricing_checkout_fix_v1.sql');
const consoleSource=read('components/platform-addon-console.js');
const platformRoute=read('app/api/platform/[action]/route.js');
const tenantStore=read('components/marketplace-addon-store-v2.js');

test('independent add-on pricing accepts a first-class free offer without zero-value checkout',()=>{
  assert.match(migration,/p_action\s*=\s*'set_independent_price'/);
  assert.match(migration,/v_mode\s+not in\s*\('free','fixed'\)/);
  assert.match(migration,/v_mode\s*=\s*'free'\s+and\s+v_monthly\s*<>\s*0/);
  assert.match(migration,/v_mode\s*=\s*'fixed'\s+and\s+v_monthly\s*<\s*1/);
  assert.match(migration,/annual_amount_minor\s*=\s*v_annual/);
  assert.match(migration,/pricing_mode\s*=\s*v_mode/);
  assert.match(tenantStore,/action\('activate_free_addon'/);
  assert.doesNotMatch(tenantStore,/create_order[\s\S]{0,400}pricingMode==='free'/);
});

test('Google Kit receives a published free offer and no Reef or historical commerce rows are rewritten',()=>{
  assert.match(migration,/product\.product_key\s*=\s*'google_ads_connect'/);
  assert.match(migration,/0,\s*0,\s*'SAR'/);
  assert.match(migration,/pricing_mode\s*=\s*'free'/);
  assert.doesNotMatch(migration,/update\s+catalog\.tenant_addon_subscriptions/i);
  assert.doesNotMatch(migration,/update\s+marketplace\.orders/i);
  assert.doesNotMatch(migration,/update\s+marketplace\.payment_attempts/i);
  assert.doesNotMatch(migration,/reef-skills/i);
});

test('pricing editor exposes free and paid choices with optimistic conflict protection',()=>{
  assert.match(consoleSource,/<option value="free">مجانية<\/option>/);
  assert.match(consoleSource,/set_independent_price/);
  assert.match(consoleSource,/expectedOfferId/);
  assert.match(consoleSource,/expectedMonthlyAmountMinor/);
  assert.match(consoleSource,/confirmed:true/);
  assert.match(consoleSource,/لن ينشئ أودير طلبًا أو محاولة دفع بقيمة صفر/);
  assert.match(platformRoute,/addon_price_version_conflict/);
});

test('pricing changes are permission checked, audited and append-only',()=>{
  assert.match(migration,/has_platform_permission\('platform\.billing\.manage'\)/);
  assert.match(migration,/independent_addon_price_revisions_v1/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/force row level security/);
  assert.match(migration,/catalog\.addon\.price\.updated/);
  assert.match(migration,/historicalOrdersUnchanged',\s*true/);
});
