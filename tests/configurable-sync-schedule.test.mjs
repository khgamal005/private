import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const migration=await read(
  '../supabase/migrations/20260808182149_configurable_daily_integration_sync.sql'
);
const adsEdge=await read('../supabase/functions/ads-sync/index.ts');
const wooRoute=await read('../app/api/woocommerce/[action]/route.js');
const commerceRoute=await read('../app/api/commerce/[provider]/[action]/route.js');
const marketingRoute=await read('../app/api/marketing/[provider]/[action]/route.js');
const commerceApi=await read('../lib/commerce-api.js');
const marketingApi=await read('../lib/marketing-api.js');
const wooPanel=await read('../components/woocommerce-sync-panel.js');
const commerceHub=await read('../components/commerce-integration-hub.js');
const marketingHub=await read('../components/marketing-command-center.js');

test('WooCommerce and marketing connections persist a configurable Saudi sync time',()=>{
  assert.match(migration,/alter table commerce_sync\.connections[\s\S]*sync_time_local/);
  assert.match(migration,/alter table marketing_hub\.connections[\s\S]*sync_time_local/);
  assert.match(migration,/sync_timezone text[\s\S]*default 'Asia\/Riyadh'/);
  assert.match(migration,/private_app\.sync_timezone_value/);
  assert.match(migration,/private_app\.next_scheduled_sync_at/);
  assert.match(migration,/apply_woocommerce_sync_schedule/);
  assert.match(migration,/apply_marketing_sync_schedule/);
  assert.match(migration,/v2_tenant_sync_schedule_snapshot/);
  assert.match(migration,/v2_tenant_sync_schedule_action/);
  assert.doesNotMatch(migration,/delete from/i);
});

test('schedule changes travel atomically through versioned tenant actions',()=>{
  assert.match(migration,/v3_tenant_woocommerce_action[\s\S]*v2_tenant_sync_schedule_action/);
  assert.match(migration,/v3_tenant_marketing_hub_action[\s\S]*v2_tenant_sync_schedule_action/);
  assert.match(wooRoute,/v3_tenant_woocommerce_action/);
  assert.match(commerceRoute,/v3_tenant_woocommerce_action/);
  assert.match(marketingRoute,/v3_tenant_marketing_hub_action/);
  assert.match(commerceApi,/v2_tenant_sync_schedule_snapshot/);
  assert.match(marketingApi,/v2_tenant_sync_schedule_snapshot/);
});

test('both dispatchers run frequently while due rows are safely leased',()=>{
  assert.match(migration,/v2_woocommerce_due_connections[\s\S]*for update skip locked/);
  assert.match(migration,/set next_sync_at = now\(\) \+ interval '30 minutes'/);
  assert.match(migration,/marktone-woocommerce-sync[\s\S]*'\*\/5 \* \* \* \*'/);
  assert.match(migration,/marktone-marketing-sync[\s\S]*'\*\/5 \* \* \* \*'/);
  assert.match(migration,/marketing_dispatch_secret/);
  assert.match(migration,/v2_marketing_schedule_authorize/);
  assert.match(migration,/vault\.decrypted_secrets/);
});

test('marketing scheduler authenticates through Vault and permits same-day retries',()=>{
  assert.match(adsEdge,/x-marktone-marketing-secret/);
  assert.match(adsEdge,/v2_marketing_schedule_authorize/);
  assert.match(adsEdge,/scheduled:[^`]+crypto\.randomUUID\(\)/);
  assert.doesNotMatch(adsEdge,/MARKETING_SYNC_SECRET/);
});

test('manager UIs expose daily sync time and the next planned execution',()=>{
  for(const source of [wooPanel,commerceHub,marketingHub]){
    assert.match(source,/syncTime/);
    assert.match(source,/Asia\/Riyadh/);
    assert.match(source,/type="time"/);
    assert.match(source,/موعد المزامنة/);
  }
  assert.match(commerceHub,/المزامنة القادمة/);
  assert.match(marketingHub,/المزامنة القادمة/);
  assert.match(wooPanel,/\|\|'daily'/);
  assert.match(commerceHub,/\|\|'daily'/);
});
