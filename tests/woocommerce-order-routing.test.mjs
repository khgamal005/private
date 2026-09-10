import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const migration=await read(
  '../supabase/migrations/20260812140000_woocommerce_order_task_routing_v1.sql'
);
const edge=await read('../supabase/functions/woocommerce-sync/index.ts');
const api=await read('../lib/api.js');
const route=await read('../app/api/tenant/[action]/route.js');
const workspace=await read('../components/lead-intake-workspace.js');

test('every newly-seen WooCommerce order has one deterministic task ledger',()=>{
  assert.match(migration,/create table sales_core\.commerce_order_work_items/i);
  assert.match(migration,/unique \(connection_id, external_order_id\)/i);
  assert.match(migration,/unique \(external_entity_id\)/i);
  assert.match(migration,/woocommerce-order-/i);
  assert.match(migration,/on conflict \(tenant_id, task_key\) do update/i);
  assert.match(migration,/task\.status in \('todo', 'in_progress'\)/i);
  assert.doesNotMatch(migration,/lead_import_rows/i);
});

test('routing is atomic with the durable order page checkpoint',()=>{
  assert.match(
    migration,
    /v_result := public\.v2_woocommerce_store_batch[\s\S]+if p_entity_type = 'orders'[\s\S]+private_app\.route_woocommerce_order_batch[\s\S]+checkpoint_seq = v_next_seq/i
  );
  assert.match(migration,/p_next_cursor ->> 'v' is distinct from '2'/i);
  assert.match(migration,/clock_timestamp\(\)/i);
  assert.match(migration,/\* \* \* \* \*/);
  assert.match(edge,/v3_woocommerce_store_batch_and_yield/);
});

test('cutover prevents an automatic historical task flood',()=>{
  assert.match(migration,/enabled_at timestamptz not null/i);
  assert.match(
    migration,
    /v_work_item\.id is null[\s\S]+coalesce\(v_order_created_at, v_entity\.created_at\)[\s\S]+< v_settings\.enabled_at[\s\S]+continue/i
  );
  assert.match(migration,/'historicalBackfillEnabled', false/i);
  assert.doesNotMatch(migration,/reef-skills/i);
  assert.doesNotMatch(migration,/update\s+academy\.courses/i);
});

test('queue and automatic routing cover all order statuses',()=>{
  for(const token of [
    "'queue'","'auto_fair'","'auto_online'",
    "'awaiting_distribution'","'assigned'","'queue_fallback'",
    "'existing_owner'","'fair'","'online_only'"
  ])assert.match(migration,new RegExp(token));
  assert.match(migration,/v_order_status :=/i);
  assert.doesNotMatch(
    migration,
    /v_order_status\s+in\s*\(\s*'completed'\s*,\s*'processing'\s*\)\s+then\s+continue/i
  );
});

test('sales managers and data officers can operate a tenant-isolated queue',()=>{
  assert.match(migration,/'tenant\.commerce_orders\.distribute'/i);
  assert.match(migration,/'sales_manager'/i);
  assert.match(migration,/'data_officer'/i);
  assert.match(migration,/private_app\.has_tenant_permission/i);
  assert.match(migration,/private_app\.can_access_tenant\(tenant_id\)/i);
  assert.match(migration,/where work_item\.tenant_id = v_tenant\.id/i);
  assert.match(migration,/revoke all on function private_app\.route_woocommerce_order_batch/i);
});

test('queue snapshot and actions match the tenant workspace contract',()=>{
  for(const token of [
    "'configured'","'canRoute'","'mode'",
    "'slaMinutes'","'awaitingDistribution'","'assigned'",
    "'errors'","'total'","'canOwnQueue'","'canReceiveOrders'",
    "'activeOrderTasks'","'routingStrategy'","'assigneeName'",
    "'minorDigits'"
  ])assert.match(migration,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'));
  assert.match(migration,/p_payload \? 'itemIds'/i);
  assert.match(migration,/p_payload ->> 'slaMinutes'/i);
  assert.match(migration,/v_action = 'assign'/i);
  assert.match(migration,/v_action = 'auto_distribute'/i);
  assert.match(migration,/v_action = 'set_routing'/i);
});

test('application exposes the order queue without weakening existing lead intake',()=>{
  assert.match(api,/v3_tenant_commerce_order_queue_snapshot/);
  assert.match(route,/'woocommerce-order-routing':'v4_tenant_commerce_order_action'/);
  assert.match(workspace,/طلبات WooCommerce/);
  assert.match(workspace,/كل طلب جديد يُنشئ مهمة واحدة مهما كانت حالته/);
  assert.match(workspace,/auto_distribute/);
  assert.match(workspace,/set_routing/);
  assert.match(workspace,/itemIds:selectedOrders/);
});
