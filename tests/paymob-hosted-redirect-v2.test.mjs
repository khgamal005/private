import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=path=>readFileSync(join(root,path),'utf8');
const migration=source(
  'supabase/migrations/20260904150000_paymob_hosted_redirect_required_secrets_v2.sql'
);
const ui=source('components/platform-addon-console.js');
const edge=source('supabase/functions/payment-provider-admin/index.ts');
const route=source('app/api/platform/payment-provider-secret/route.js');

test('Hosted Redirect validates required secrets by name instead of counting optional Vault rows',()=>{
  assert.match(migration,/paymob_required_secret_refs_valid_v2/i);
  assert.match(migration,/'apiKey'::text,api_key_vault_secret_id/i);
  assert.match(migration,/'hmacSecret'::text,hmac_vault_secret_id/i);
  assert.match(migration,/'secretKey'::text,secret_key_vault_secret_id[\s\S]{0,100}?p_checkout_flow\s*=\s*'intention'/i);
  assert.match(migration,/'publicKey'::text,public_key_vault_secret_id[\s\S]{0,100}?p_checkout_flow\s*=\s*'intention'/i);
  assert.equal(
    [...migration.matchAll(/or not private_app\.paymob_required_secret_refs_valid_v2\(/gi)].length,
    3
  );
  for(const fn of [
    'v1_service_paymob_runtime_config',
    'v1_service_paymob_resume_checkout',
    'v1_service_paymob_record_intention'
  ])assert.match(migration,new RegExp(fn));
  const recordPatch=migration.slice(
    migration.indexOf("'public.v1_service_paymob_record_intention"),
    migration.indexOf("paymob_record_required_secret_patch_target_missing")
  );
  assert.match(
    recordPatch,
    /v_bound_secret_count\s*<>\s*\([\s\S]{0,140}?\)\s*then[\s\S]{0,260}?or not private_app\.paymob_required_secret_refs_valid_v2\([\s\S]{0,140}?\)\s*then/i
  );
});

test('Hosted Redirect migration is replay-safe and fails closed on partial drift',()=>{
  assert.match(migration,/deliberately replay-safe/i);
  assert.match(migration,/v_helper_count\s*=\s*0/i);
  for(const gate of ['runtime','resume','record']){
    assert.match(
      migration,
      new RegExp(`paymob_${gate}_required_secret_patch_target_missing`,'i')
    );
    assert.match(
      migration,
      new RegExp(`paymob_${gate}_required_secret_patch_conflict`,'i')
    );
    assert.match(
      migration,
      new RegExp(`paymob_${gate}_required_secret_patch_postcondition_failed`,'i')
    );
  }
  assert.match(migration,/v_helper_count\s*<>\s*1/i);
  assert.doesNotMatch(migration,/drop\s+(?:function|table)|truncate\s+table/i);
});

test('Paymob administration exposes one fixed QuickLink route and only API Key plus HMAC',()=>{
  assert.match(ui,/PAYMOB_REQUIRED_SECRET_KEYS=\['apiKey','hmacSecret'\]/);
  assert.match(ui,/const integrationPath=paymob\?'quicklink':''/);
  assert.match(ui,/Paymob Hosted Redirect/);
  const modal=ui.slice(ui.indexOf('function ProviderModal'),ui.indexOf('function Modal'));
  assert.doesNotMatch(modal,/<option value="intention">/);
  assert.doesNotMatch(modal,/setIntegrationPath/);
  for(const ingress of [edge,route]){
    assert.match(ingress,/PAYMOB_SECRET_KEYS=new Set\(\['apiKey','hmacSecret'\]\)/);
    assert.match(ingress,/integrationPath\s*===\s*['"]quicklink['"]/);
    assert.doesNotMatch(ingress,/function validPaymobLiveCredentials/);
  }
});

test('Hosted Redirect keeps server-side money truth and signed callback governance intact',()=>{
  const checkout=source('supabase/functions/paymob-checkout/index.ts');
  const webhook=source('supabase/functions/paymob-webhook/index.ts');
  assert.match(checkout,/v2_tenant_paymob_prepare_checkout/);
  assert.match(checkout,/new FormData\(\)/);
  assert.match(checkout,/recordIntention/);
  assert.match(webhook,/verifyPaymobTransactionHmac/);
  assert.match(webhook,/v1_service_paymob_ingest_verified_transaction/);
  assert.match(migration,/payment_provider_secret_refs/);
  assert.match(migration,/vault\.decrypted_secrets/);
});
