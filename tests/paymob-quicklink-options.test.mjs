import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(join(root,path),'utf8');

const migration=read(
  'supabase/migrations/20260903203000_paymob_quicklink_checkout_options_v1.sql'
);
const checkout=read('supabase/functions/paymob-checkout/index.ts');
const webhook=read('supabase/functions/paymob-webhook/index.ts');
const nextCheckout=read('app/api/payments/paymob/checkout/route.js');
const returnRoute=read('app/api/payments/paymob/return/route.js');
const adminUi=read('components/platform-addon-console.js');
const picker=read('components/payment-method-picker.js');
const addonStore=read('components/marketplace-addon-store-v2.js');
const serviceStore=read('components/marketplace-store.js');

function sqlFunction(name){
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const start=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escaped}\\s*\\(`,'i'
  ).exec(migration);
  assert.ok(start,`Missing ${name}`);
  const tail=migration.slice(start.index);
  const body=/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(tail);
  assert.ok(body,`Unterminated ${name}`);
  return tail.slice(0,body.index+body[0].length);
}

test('migration adds an immutable server-side checkout route binding',()=>{
  assert.match(migration,/alter table marketplace\.paymob_credential_versions[\s\S]*?add column checkout_flow[\s\S]*?add column apple_pay_integration_id/i);
  assert.match(migration,/alter table marketplace\.payment_attempts[\s\S]*?add column checkout_flow[\s\S]*?add column payment_option[\s\S]*?add column selected_integration_id/i);
  assert.match(migration,/payment_attempt_checkout_route_v2[\s\S]*?checkout_flow\s*=\s*'intention'[\s\S]*?payment_option\s*=\s*'hosted'[\s\S]*?checkout_flow\s*=\s*'quicklink'[\s\S]*?payment_option\s+in\s*\('card','apple_pay'\)/i);
  assert.match(migration,/selected_integration_id[\s\S]*?never accepted from or returned to storefront clients/i);
});

test('tenant preparation selects Integration ID on the server and preserves idempotency',()=>{
  const prepare=sqlFunction('public.v2_tenant_paymob_prepare_checkout');
  assert.match(prepare,/public\.v1_tenant_paymob_prepare_checkout\s*\(/i);
  assert.match(prepare,/v_selected_integration_id\s*:=\s*v_version\.integration_id/i);
  assert.match(prepare,/v_selected_integration_id\s*:=\s*v_version\.apple_pay_integration_id/i);
  assert.match(prepare,/v_attempt\.payment_option\s*<>\s*v_option/i);
  assert.match(prepare,/paymob_idempotency_payment_option_conflict/i);
  assert.match(prepare,/status\s*=\s*'prepared'[\s\S]{0,100}?claim_token\s+is\s+null/i);
  assert.doesNotMatch(prepare,/p_(?:integration|merchant|owner)_id/i);
  assert.match(prepare,/'integrationIdReturned',false/i);
});

test('route changes drain open attempts and reset activation evidence',()=>{
  const finalize=sqlFunction('private_app.paymob_finalize_credential_version_v2');
  const guard=sqlFunction('private_app.v3_payment_provider_config_guard');
  for(const body of [finalize,guard]){
    assert.match(body,/payment_attempts/i);
    assert.match(body,/'prepared','creating_intention','intention_created','pending',[\s\S]{0,80}?'unknown','quarantined'/i);
    assert.match(body,/paymob_open_attempts_must_drain/i);
  }
  assert.match(guard,/new\.readiness_evidence\s*:=\s*'\{\}'::jsonb/i);
  assert.match(guard,/new\.rollout_mode\s*:=\s*'observe_only'/i);
  assert.match(guard,/new\.last_verified_at\s*:=\s*null/i);
});

test('admin route metadata supports a fail-closed Apple Pay removal',()=>{
  const bundle=sqlFunction('public.v3_service_payment_provider_bundle_action');
  assert.match(bundle,/\?\s*'integrationPath'/i);
  assert.match(bundle,/\?\s*'applePayIntegrationId'/i);
  assert.match(bundle,/jsonb_typeof\(p_public_config\s*->\s*'applePayIntegrationId'\)\s*=\s*'null'/i);
  assert.match(bundle,/v_merged_public_config\s*-\s*'applePayIntegrationId'/i);
  assert.match(migration,/payment_provider_optional_config_patch_precondition_failed/i);
  assert.match(migration,/payment_provider_optional_config_patch_verification_failed/i);
  assert.match(adminUi,/publicConfig\[configKey\]\s*=\s*null/i);
});

test('QuickLink uses the official KSA request contract and one provider mutation',()=>{
  assert.match(checkout,/PAYMOB_AUTH_URL[\s\S]*?api_key:\s*runtime\.apiKey/i);
  assert.match(checkout,/PAYMOB_QUICKLINK_URL[\s\S]*?authorization:\s*`Bearer \$\{authToken\}`/i);
  for(const field of [
    'amount_cents','expires_at','reference_id','payment_methods',
    'notification_url','is_live'
  ])assert.match(checkout,new RegExp(`\\b${field}\\b`));
  assert.equal(
    (checkout.match(/fetchTextWithTimeout\(\s*PAYMOB_QUICKLINK_URL/g)||[]).length,
    1
  );
  assert.match(checkout,/markProviderMutationStarted\(\)[\s\S]{0,120}?PAYMOB_QUICKLINK_URL/i);
  assert.doesNotMatch(checkout,/while\s*\([^)]*(?:retry|attempt)|for\s*\([^)]*(?:retry|attempt)/i);
});

test('QuickLink auth accepts every successful HTTP response including 201 Created',()=>{
  const quicklinkAuth=checkout.slice(
    checkout.indexOf('async function createQuicklinkCheckout'),
    checkout.indexOf('let authToken:',checkout.indexOf('async function createQuicklinkCheckout'))
  );
  assert.match(quicklinkAuth,/if\s*\(\s*!authResult\.response\.ok\s*\)/i);
  assert.doesNotMatch(quicklinkAuth,/authResult\.response\.status\s*!==\s*200/i);
});

test('QuickLink response is bound and persisted before redirect exposure',()=>{
  for(const binding of [
    /amountMinor\s*!==\s*prepared\.amountMinor/,
    /returnedCurrency\s*!==\s*null[\s\S]{0,60}?returnedCurrency\s*!==\s*"SAR"/,
    /referenceId\s*!==\s*prepared\.attemptId/,
    /\["created",\s*"active"\]\.includes\(state\)/,
    /returnedNotificationUrl\s*!==\s*null/,
    /returnedRedirectionUrl\s*!==\s*null/,
    /returnedExpiryMs\s*>\s*Date\.parse\(prepared\.expiresAt\)/
  ])assert.match(checkout,binding);
  assert.match(checkout,/const quicklinkRequest = new FormData\(\)/);
  assert.match(checkout,/body:\s*quicklinkRequest/);
  assert.doesNotMatch(checkout,/body:\s*JSON\.stringify\(quicklinkRequest\)/);
  assert.match(checkout,/url\.hostname\s*!==\s*"ksa\.paymob\.com"/i);
  assert.match(checkout,/\["\/flash",\s*"\/flash\/"\]\.includes\(url\.pathname\)/);
  const recordAt=checkout.indexOf('recorded = await recordIntention(');
  const responseAt=checkout.indexOf('return jsonResponse(201',recordAt);
  assert.ok(recordAt!==-1&&responseAt>recordAt);
  assert.match(nextCheckout,/quicklinkUnrestricted/);
  assert.match(nextCheckout,/quicklinkFlash/);
  assert.match(nextCheckout,/\['\/flash','\/flash\/'\]\.includes\(url\.pathname\)/);
});

test('QuickLink create accepts every successful HTTP response including 201 Created',()=>{
  const start=checkout.indexOf(
    'const responseHash = await sha256Hex(providerResult.text);'
  );
  const end=checkout.indexOf('let quicklink: JsonObject;',start);
  assert.ok(start!==-1&&end>start);
  const responseGate=checkout.slice(start,end);
  assert.match(responseGate,/if\s*\(\s*!providerResult\.response\.ok\s*\)/i);
  assert.doesNotMatch(responseGate,/providerResult\.response\.status\s*!==\s*200/i);
});

test('QuickLink KSA request uses multipart without a forged content-type boundary',()=>{
  const start=checkout.indexOf('const quicklinkRequest = new FormData();');
  const end=checkout.indexOf('const responseHash = await sha256Hex(providerResult.text);',start);
  assert.ok(start!==-1&&end>start);
  const create=checkout.slice(start,end);
  assert.doesNotMatch(create,/['"]content-type['"]:\s*['"]application\/json['"]/i);
  for(const field of [
    'amount_cents','expires_at','reference_id','payment_methods',
    'notification_url','is_live'
  ])assert.match(create,new RegExp(`quicklinkRequest\\.set\\("${field}"`));
  for(const field of ['email','full_name','phone_number','description']){
    assert.doesNotMatch(create,new RegExp(`quicklinkRequest\\.set\\("${field}"`));
  }
});

test('QuickLink static return is caller-authorized, scrubbed, and read-only',()=>{
  const resolver=sqlFunction('public.v1_tenant_paymob_resolve_return');
  assert.match(resolver,/language\s+plpgsql[\s\S]*?stable[\s\S]*?security\s+definer/i);
  assert.match(resolver,/attempt\.checkout_flow\s*=\s*'quicklink'/i);
  assert.match(resolver,/attempt\.provider_order_id\s*=\s*p_provider_order_id/i);
  assert.match(resolver,/v_match_count\s*<>\s*1/i);
  assert.match(resolver,/private_app\.has_tenant_permission\([\s\S]{0,100}?'tenant\.settings\.manage'/i);
  assert.match(resolver,/'slug',v_tenant_slug[\s\S]*?'attemptId',v_attempt_id/i);
  assert.match(resolver,/authorization is part of candidate selection/i);
  assert.doesNotMatch(resolver,/update\s|insert\s+into|delete\s+from|paymentStatus|attemptStatus/i);
  assert.match(migration,/grant execute on function public\.v1_tenant_paymob_resolve_return\(text\)\s*to authenticated/i);
  assert.match(returnRoute,/searchParams\.getAll\('order_id'\)/);
  assert.match(returnRoute,/v1_tenant_paymob_resolve_return/);
  assert.match(returnRoute,/Authorization:`Bearer \$\{token\}`/);
  assert.match(returnRoute,/status:303/);
  assert.doesNotMatch(returnRoute,/SUPABASE_(?:SERVICE_ROLE|SECRET)_KEY|success=true|payment_status|settle/i);
});

test('runtime secrets and webhook bindings are purpose-scoped twice',()=>{
  const runtime=sqlFunction('public.v1_service_paymob_runtime_config');
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  assert.match(runtime,/if v_attempt\.checkout_flow = 'quicklink'[\s\S]*?v_version\.api_key_vault_secret_id/i);
  assert.match(runtime,/else[\s\S]*?v_version\.secret_key_vault_secret_id[\s\S]*?v_version\.public_key_vault_secret_id/i);
  assert.match(runtime,/case when v_attempt\.checkout_flow = 'quicklink'[\s\S]*?'apiKey',v_api_key[\s\S]*?else jsonb_build_object\([\s\S]*?'secretKey',v_secret_key[\s\S]*?'publicKey',v_public_key/i);
  assert.match(webhook,/candidate\.applePayIntegrationId/);
  assert.match(webhook,/candidate\.historicalIntegrationIds\.includes\(transaction\.integrationId\)/);
  assert.match(webhook,/historicalIntegrationIds\.length\s*>\s*32/);
  assert.match(webhook,/matches\.length\s*!==\s*1/);
  assert.match(runtime,/'historicalIntegrationIds'[\s\S]*?attempt\.selected_integration_id/i);
  assert.match(migration,/v_historical_integration_count\s*>\s*32[\s\S]*?paymob_integration_history_limit_reached/i);
  assert.match(ingest,/v_version\.id\s*<>\s*v_attempt_version\.id/i);
  assert.match(ingest,/v_integration_id\s*<>\s*coalesce\([\s\S]{0,120}?v_attempt\.selected_integration_id/i);
  assert.match(ingest,/v_owner\s*<>\s*v_version\.owner_id/i);
});

test('storefront exposes labels and option keys, never merchant Integration IDs',()=>{
  const snapshot=sqlFunction('public.v2_tenant_marketplace_snapshot');
  assert.match(snapshot,/'paymentOptions'/i);
  assert.match(snapshot,/'card'[\s\S]{0,100}?'البطاقات ومدى'/i);
  assert.match(snapshot,/'apple_pay'[\s\S]{0,100}?'Apple Pay'/i);
  assert.match(snapshot,/'publicConfig','\{\}'::jsonb/i);
  assert.doesNotMatch(snapshot,/'publicConfig'[\s\S]{0,80}?integrationId/i);
  for(const text of [picker,addonStore,serviceStore]){
    assert.doesNotMatch(text,/32958|32957|32956|32955|33013/);
  }
  assert.match(picker,/name="paymobPaymentOption"/);
  assert.match(picker,/بطاقات مدى، Visa وMastercard/);
  assert.match(picker,/الدفع السريع من أجهزة Apple المدعومة/);
  for(const store of [addonStore,serviceStore]){
    assert.match(store,/paymentOption,/);
    assert.match(store,/<PaymobOptionPicker/);
    assert.match(store,/<PaymentMethodPicker/);
  }
});

test('admin config is a fixed Hosted Redirect adapter and Reef Skills remains excluded',()=>{
  assert.match(adminUi,/Paymob Hosted Redirect/);
  assert.match(adminUi,/const integrationPath=paymob\?'quicklink':''/);
  assert.match(adminUi,/Integration ID للبطاقات\/مدى/);
  assert.match(adminUi,/اختياري؛ اتركه فارغًا لإخفاء Apple Pay عن العميل/);
  assert.match(adminUi,/تغيير Integration ID يعيد الجاهزية إلى المراجعة/);
  assert.match(migration,/tenant\.slug\s+is\s+distinct\s+from\s+'reef-skills'/i);
  assert.match(migration,/tenant\.tenant_key\s+is\s+distinct\s+from\s+'tenant-reef-skills'/i);
  assert.match(migration,/v_tenant\.slug\s*=\s*'reef-skills'/i);
  assert.match(migration,/v_tenant\.tenant_key\s*=\s*'tenant-reef-skills'/i);
});
