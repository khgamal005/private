import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(join(root,path),'utf8');
const migration=read(
  'supabase/migrations/20260904001000_paymob_intention_live_validation_v2.sql'
);
const nextAdmin=read('app/api/platform/payment-provider-secret/route.js');
const edgeAdmin=read('supabase/functions/payment-provider-admin/index.ts');
const ui=read('components/platform-addon-console.js');
const singleOperatorMigration=read(
  'supabase/migrations/20260904223000_single_authorized_operator_policy_v1.sql'
);
const automaticRolloutMigration=read(
  'supabase/migrations/20260905170000_paymob_automatic_all_tenants_v1.sql'
);

test('Hosted Redirect administration is fixed to QuickLink with API Key and HMAC only',()=>{
  for(const source of [nextAdmin,edgeAdmin]){
    assert.match(source,/PAYMOB_SECRET_KEYS=new Set\(\['apiKey','hmacSecret'\]\)/);
    assert.match(source,/integrationPath\s*===\s*['"]quicklink['"]/i);
    assert.doesNotMatch(source,/function validPaymobLiveCredentials/i);
    assert.doesNotMatch(source,/\^sklive|sklive%/i);
    assert.doesNotMatch(source,/\^pklive|pklive%/i);
  }
  assert.match(migration,/paymob_live_credential_material_valid_v2/i);
  assert.match(migration,/p_checkout_flow\s*=\s*'quicklink'/i);
  assert.match(migration,/paymob_live_credentials_invalid/i);
  assert.match(migration,/zz_paymob_live_material_guard_v2/i);
});

test('credential save repairs configured state but never activates global Live',()=>{
  const bundle=migration.slice(
    migration.indexOf('create or replace function public.v3_service_payment_provider_bundle_action('),
    migration.indexOf('create or replace function public.v1_platform_paymob_tenant_rollout_action(')
  );
  assert.match(bundle,/when 'intention' then\s+array\['secretKey','publicKey','hmacSecret','apiKey'\]/i);
  assert.match(bundle,/when 'intention' then '\{\}'::text\[\]/i);
  assert.match(bundle,/set status = case when p_enabled then 'configured' else 'disabled' end/i);
  assert.match(bundle,/rollout_mode = 'observe_only'/i);
  assert.doesNotMatch(bundle,/set status\s*=\s*'active'|rollout_mode\s*=\s*'live'/i);
});

test('controlled Live automatically enrolls every existing and future tenant',()=>{
  assert.match(automaticRolloutMigration,/paymob_controlled_live_provider_ready_v1/i);
  assert.match(automaticRolloutMigration,/paymob_required_secret_refs_valid_v2[\s\S]*?'quicklink'/i);
  assert.match(automaticRolloutMigration,/paymob_live_credential_material_valid_v2[\s\S]*?'quicklink'/i);
  assert.match(automaticRolloutMigration,/create\s+trigger\s+zz_tenants_paymob_auto_enroll_after_insert/i);
  assert.match(automaticRolloutMigration,/after\s+insert\s+on\s+core\.tenants/i);
  assert.match(automaticRolloutMigration,/automatic_all_tenants/i);
  assert.match(automaticRolloutMigration,/v_enabled\s*<>\s*v_tenants/i);
  assert.match(automaticRolloutMigration,/paymob_automatic_rollout_prepare_patch_failed/i);
  assert.match(automaticRolloutMigration,/paymob_automatic_rollout_action_patch_failed/i);
  assert.match(automaticRolloutMigration,/position\('modaar-training-center' in v_definition\) > 0/i);
  assert.match(automaticRolloutMigration,/position\('paymob_live_canary_amount_limit' in v_definition\) > 0/i);

  assert.doesNotMatch(ui,/500 ر\.س|Reef Skills مستبعد/i);
  assert.match(ui,/automaticTenantEnrollment/i);
  assert.match(ui,/controlledLiveActive/i);
  assert.match(ui,/كل المنشآت الحالية والجديدة/i);
});

test('canonical Live events can satisfy automated evidence without manual fabrication',()=>{
  assert.match(migration,/A direct Live validation cohort is coherent/i);
  assert.match(migration,/evidence\.credential_version_id\s*=\s*v_active_id/i);
  assert.match(migration,/evidence\.environment\s*=\s*'live'/i);
  assert.match(migration,/p_environment in \('sandbox','live'\)/i);
  assert.match(migration,/v_attempt\.environment in \('sandbox','live'\)/i);
  for(const check of [
    'intention_create','webhook_hmac','paid_transaction',
    'duplicate_delivery','failed_transaction','transaction_inquiry',
    'credential_rotation_callback','refund_inquiry'
  ])assert.match(migration,new RegExp(`['"]${check}['"]`));
  assert.match(migration,/source validation still happens inside the writer/i);
});

test('historical canary evidence is preserved while the new policy is explicit and auditable',()=>{
  assert.match(migration,/live_canary_reapproval_required/i);
  assert.match(migration,/'globalLiveActivated',false/i);
  assert.match(automaticRolloutMigration,/Compatibility alias retained for older audited payment functions/i);
  assert.match(automaticRolloutMigration,/marketplace\.paymob\.automatic_tenant_rollout_enabled/i);
  assert.match(automaticRolloutMigration,/fullOperationalEvidenceStillRequired',true/i);
  assert.match(automaticRolloutMigration,/secretReturned',false/i);
  assert.doesNotMatch(automaticRolloutMigration,/update\s+marketplace\.payment_provider_configs/i);
});
