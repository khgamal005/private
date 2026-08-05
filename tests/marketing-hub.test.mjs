import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('marketing hub isolates tenants, permissions, credentials, and raw data',async()=>{
  const [core,actions,service,snapshot,indexes]=await Promise.all([
    read('supabase/migrations/20260803020000_marketing_hub_core_v1.sql'),
    read('supabase/migrations/20260803020100_marketing_hub_tenant_actions_v1.sql'),
    read('supabase/migrations/20260803020200_marketing_hub_service_api_v1.sql'),
    read('supabase/migrations/20260803020300_marketing_hub_attribution_snapshot_v1.sql'),
    read('supabase/migrations/20260803020400_marketing_hub_fk_indexes_v1.sql')
  ]);
  for(const pattern of [
    /create schema if not exists marketing_hub/,
    /tenant\.marketing\.read/,
    /tenant\.marketing\.manage/,
    /addon\.marketing_attribution/,
    /alter table marketing_hub\.connections enable row level security/,
    /revoke all on all tables in schema marketing_hub/,
    /grant select, insert, update, delete\s+on all tables in schema marketing_hub to service_role/
  ])assert.match(core,pattern);
  assert.match(actions,/private_app\.integration_secret_upsert/);
  assert.match(actions,/'marketing:' \|\| v_provider_key \|\| ':' \|\| v_secret_key/);
  assert.doesNotMatch(actions,/grant execute[\s\S]*service_role_key/i);
  assert.match(service,/vault\.decrypted_secrets/);
  assert.match(service,/for update skip locked/);
  assert.match(service,/pg_advisory_xact_lock/);
  assert.match(snapshot,/private_app\.marketing_identity_hash/);
  assert.match(snapshot,/extensions\.digest/);
  assert.doesNotMatch(snapshot,/customerEmail'\s*,\s*contact\.email/);
  assert.equal((indexes.match(/create index if not exists/g)||[]).length,22);
  assert.match(indexes,/marketing_attributions_touchpoint_idx/);
  assert.match(indexes,/marketing_conversion_opportunity_idx/);
});

test('attribution uses CRM and every supported commerce source without double-counting revenue',async()=>{
  const sql=await read('supabase/migrations/20260803020300_marketing_hub_attribution_snapshot_v1.sql');
  for(const pattern of [
    /sales_core\.contacts/,
    /sales_core\.opportunities/,
    /academy\.registration_handoffs/,
    /commerce_hub\.external_entities/,
    /commerce_sync\.external_entities/,
    /last_non_direct/,
    /first_touch/,
    /last_touch/,
    /linear/,
    /when p_status = 'refunded' then -abs/,
    /attributionCoverageRate/,
    /currencyMismatches/
  ])assert.match(sql,pattern);
  assert.match(sql,/not exists \([\s\S]*academy\.registration_handoffs/);
  assert.match(sql,/left join lateral \([\s\S]*from marketing_hub\.campaigns candidate/);
});

test('official ad adapters are version-isolated, bounded, retryable, and read-only',async()=>{
  const [index,shared,meta,google,tiktok,snap,config]=await Promise.all([
    read('supabase/functions/ads-sync/index.ts'),
    read('supabase/functions/ads-sync/shared.ts'),
    read('supabase/functions/ads-sync/adapters/meta.ts'),
    read('supabase/functions/ads-sync/adapters/google.ts'),
    read('supabase/functions/ads-sync/adapters/tiktok.ts'),
    read('supabase/functions/ads-sync/adapters/snapchat.ts'),
    read('supabase/config.toml')
  ]);
  for(const pattern of [/MAX_ATTEMPTS/,/MAX_RESPONSE_BYTES/,/REMOTE_TIMEOUT_MS/,/retry-after/,/redirect: 'error'/]){
    assert.match(shared,pattern);
  }
  assert.match(meta,/graph\.facebook\.com/);
  assert.match(meta,/v26\.0/);
  assert.match(meta,/fields: 'id,name,currency,timezone_name,account_status'/);
  assert.doesNotMatch(meta,/account_status,business,owner/);
  assert.match(meta,/businessId: configuration\(connection, 'businessId'\)/);
  assert.match(google,/googleads\.googleapis\.com/);
  assert.match(google,/oauth2\.googleapis\.com\/token/);
  assert.match(google,/developer-token/);
  assert.match(google,/'v25'/);
  assert.doesNotMatch(google,/pageSize/);
  assert.match(google,/nextPageToken/);
  assert.match(tiktok,/business-api\.tiktok\.com\/open_api/);
  assert.match(tiktok,/report\/integrated\/get/);
  assert.match(snap,/adsapi\.snapchat\.com\/v1/);
  assert.match(snap,/accounts\.snapchat\.com\/login\/oauth2\/access_token/);
  assert.match(snap,/breakdown: 'campaign'/);
  assert.match(index,/v2_marketing_hub_store_dimensions/);
  assert.match(index,/v2_marketing_hub_store_metrics/);
  assert.match(index,/v2_marketing_hub_refresh_attribution/);
  assert.match(config,/\[functions\.ads-sync\][\s\S]*verify_jwt = false/);
  assert.doesNotMatch(`${meta}\n${google}\n${tiktok}\n${snap}`,/method:\s*'(PUT|PATCH|DELETE)'/);
});

test('commerce adapters normalize order revenue and first-party attribution signals',async()=>{
  const [shared,salla,zid,shopify,custom,woo]=await Promise.all([
    read('supabase/functions/commerce-sync/shared.ts'),
    read('supabase/functions/commerce-sync/adapters/salla.ts'),
    read('supabase/functions/commerce-sync/adapters/zid.ts'),
    read('supabase/functions/commerce-sync/adapters/shopify.ts'),
    read('supabase/functions/commerce-sync/adapters/custom.ts'),
    read('supabase/functions/woocommerce-sync/index.ts')
  ]);
  for(const pattern of [/gclid/,/gbraid/,/wbraid/,/fbclid/,/ttclid/,/sc_click_id/,/utmCampaign/]){
    assert.match(shared,pattern);
  }
  for(const source of [salla,zid,shopify,custom]){
    assert.match(source,/amountMinor/);
    assert.match(source,/customerEmail/);
    assert.match(source,/attributionFields/);
  }
  assert.match(woo,/function normalizeOrder/);
  assert.match(woo,/function orderAttribution/);
  assert.match(woo,/transform: item => normalizeOrder/);
});

test('tenant command center exposes decision metrics, connections, and protected actions',async()=>{
  const [page,component,route,shell,proxy]=await Promise.all([
    read('app/tenant/[slug]/marketing/page.js'),
    read('components/marketing-command-center.js'),
    read('app/api/marketing/[provider]/[action]/route.js'),
    read('components/workspace-shell.js'),
    read('proxy.js')
  ]);
  assert.match(page,/requireTenantPermission\(slug,'tenant\.marketing\.read'\)/);
  for(const pattern of [
    /مركز قرار الحملات/,
    /العائد على الإنفاق ROAS/,
    /تغطية الإسناد/,
    /سلامة البيانات/,
    /الحسابات الإعلانية الرسمية/,
    /المتاجر والإيراد/,
    /سياسة الإسناد/
  ])assert.match(component,pattern);
  assert.match(component,/every_6_hours/);
  assert.match(component,/ar-SA-u-ca-gregory/);
  assert.match(route,/ACCESS_COOKIE/);
  assert.match(route,/v2_tenant_marketing_hub_action/);
  assert.match(route,/\/functions\/v1\/ads-sync/);
  assert.match(route,/\[result\?\.error,result\?\.detail\]/);
  assert.match(component,/const canSync=\['active','degraded'\]\.includes\(status\)/);
  assert.match(component,/running\|\|!canSync/);
  assert.doesNotMatch(route,/SERVICE_ROLE|service_role/);
  assert.match(shell,/href:`\$\{base\}\/marketing`/);
  assert.match(proxy,/\/api\/marketing/);
});
