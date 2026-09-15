import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const migration=await readFile(new URL('supabase/migrations/20260808000722_marktone_marketplace_v1.sql',root),'utf8');
const marketplaceIndexes=await readFile(new URL('supabase/migrations/20260808000940_marktone_marketplace_fk_indexes_v1.sql',root),'utf8');
const tenantStore=await readFile(new URL('components/marketplace-store.js',root),'utf8');
const platformStore=await readFile(new URL('components/platform-marketplace.js',root),'utf8');
const tenantApi=await readFile(new URL('app/api/tenant/[action]/route.js',root),'utf8');
const platformApi=await readFile(new URL('app/api/platform/[action]/route.js',root),'utf8');
const workspaceShell=await readFile(new URL('components/workspace-shell.js',root),'utf8');
const edgeWebhook=await readFile(new URL('supabase/functions/marketplace-payment-webhook/index.ts',root),'utf8');

test('marketplace data plane is additive and isolated behind RPCs',()=>{
  assert.match(migration,/Additive only: existing tenants, memberships, customers, integrations and URLs are untouched/);
  for(const table of [
    'service_categories','service_products','orders','order_items',
    'order_events','payment_events','payment_webhooks'
  ]){
    assert.match(migration,new RegExp(`create table if not exists marketplace\\.${table} \\(`));
    assert.match(migration,new RegExp(`alter table marketplace\\.${table} enable row level security`));
  }
  assert.match(migration,/revoke all on schema marketplace from public,anon,authenticated/);
  assert.doesNotMatch(migration,/grant\s+(?:all|select|insert|update|delete)\s+on\s+(?:table\s+)?marketplace\./i);
  assert.match(migration,/security definer\s+set search_path=''/g);
  assert.match(migration,/grant execute on function public\.v1_tenant_marketplace_snapshot\(text\) to authenticated/);
  assert.match(migration,/grant execute on function public\.v1_platform_marketplace_action\(text,jsonb\) to authenticated/);
});

test('catalog includes the requested service sections and explicit prices',()=>{
  for(const category of ['lecturers','design','content','marketing','sales','consulting','technology']){
    assert.match(migration,new RegExp(`'${category}'`));
  }
  for(const product of [
    'lecturer_hour','workshop_day','training_deck_design','course_campaign_identity',
    'motion_video_minute','training_bag','course_copywriting','landing_page',
    'ads_management_month','sales_seat_month','customer_service_seat_month',
    'operations_session','kpi_framework','course_store_website','custom_integration'
  ]){
    assert.match(migration,new RegExp(`'${product}'`));
  }
  for(const addon of [
    'whatsapp','email','zoom','automation','templates','delivery_analytics','api',
    'yeastar','woocommerce','salla','zid','shopify','custom_store','marketing_attribution','cms_pro'
  ]){
    assert.match(migration,new RegExp(`'${addon}'`));
  }
  assert.match(migration,/tax_rate_bps integer not null default 1500/);
  assert.match(migration,/v_tax:=round\(v_subtotal\*0\.15\)::bigint/);
});

test('order creation and payment processing are idempotent',()=>{
  assert.match(migration,/unique \(tenant_id,idempotency_key\)/);
  assert.match(migration,/unique \(provider_key,provider_event_id\)/);
  assert.match(migration,/pg_advisory_xact_lock\(hashtextextended\(p_order_id::text,0\)\)/);
  assert.match(migration,/v_tenant\.id::text\|\|':'\|\|v_item_type\|\|':'\|\|v_product_key/);
  assert.match(migration,/duplicateReason','pending_product_order/);
  assert.match(migration,/p_amount_minor<>v_order\.total_minor/);
  assert.match(migration,/upper\(coalesce\(p_currency,''\)\)<>v_order\.currency/);
  assert.match(migration,/v_provider_event_id:=left\(trim\(p_provider_event_id\),200\)/);
  assert.match(tenantStore,/requestKey:idempotencyKey\(\)/);
  assert.match(tenantStore,/idempotencyKey:checkout\.requestKey/);
});

test('marketplace foreign keys have covering indexes',()=>{
  for(const index of [
    'marketplace_orders_requested_by_subject_idx',
    'marketplace_order_items_service_product_idx',
    'marketplace_order_items_addon_product_idx',
    'marketplace_order_events_tenant_idx',
    'marketplace_order_events_actor_subject_idx'
  ]){
    assert.match(marketplaceIndexes,new RegExp(`create index if not exists ${index}`));
  }
});

test('a verified add-on payment activates only the purchasing tenant',()=>{
  assert.match(migration,/insert into catalog\.tenant_addon_subscriptions as current_subscription/);
  assert.match(migration,/v_order\.tenant_id,v_product\.id,'active','billing'/);
  assert.match(migration,/activated_after_verified_payment/);
  assert.match(migration,/if v_product\.activation_mode='module' or v_product\.product_key='cms_pro'/);
  assert.match(migration,/insert into core\.tenant_modules/);
  assert.match(migration,/set activation_state='active'/);
  assert.match(migration,/tenant\.settings\.manage/);
  assert.match(migration,/platform\.billing\.manage/);
});

test('payment webhook authenticates the untouched raw body with a rotated Vault secret',()=>{
  assert.match(migration,/vault\.create_secret/);
  assert.match(migration,/vault\.update_secret/);
  assert.match(migration,/p_timestamp\|\|'\.'\|\|p_raw_body/);
  assert.match(migration,/extensions\.hmac\(/);
  assert.match(migration,/abs\(extract\(epoch from \(now\(\)-v_received_at\)\)\)>300/);
  assert.match(migration,/coalesce\(auth\.jwt\(\)->>'role',''\)<>'service_role'/);
  assert.match(migration,/grant execute on function public\.v1_marketplace_payment_webhook_receive\(text,text,text\) to service_role/);
  assert.match(edgeWebhook,/x-marktone-timestamp/);
  assert.match(edgeWebhook,/x-marktone-signature/);
  assert.match(edgeWebhook,/p_raw_body:rawBody/);
  assert.match(edgeWebhook,/MAX_BODY_BYTES=64\*1024/);
  assert.match(edgeWebhook,/SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(edgeWebhook,/marketplace_payment_webhook_secret/i);
});

test('tenant and platform stores are wired through permission-checked APIs',()=>{
  assert.match(tenantApi,/'marketplace':'v1_tenant_marketplace_action'/);
  assert.match(platformApi,/'marketplace':'v1_platform_marketplace_action'/);
  assert.match(workspaceShell,/href:`\$\{base\}\/services-store`/);
  assert.match(workspaceShell,/href:`\$\{base\}\/addons-store`/);
  assert.match(workspaceShell,/\/control\/marketplace/);
  assert.match(tenantStore,/الانتقال إلى متجر الإضافات/);
  assert.match(platformStore,/تفعيل تلقائي/);
  assert.match(platformStore,/rotate_webhook_secret/);
});
