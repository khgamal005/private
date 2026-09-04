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

test('Live validation is one single-operator non-Reef model tenant with a SAR 500 cap',()=>{
  assert.match(migration,/tenant\.slug\s*=\s*'modaar-training-center'/i);
  assert.match(migration,/tenant\.slug\s+is\s+distinct\s+from\s+'reef-skills'/i);
  assert.match(migration,/tenant\.tenant_key\s+is\s+distinct\s+from\s+'tenant-reef-skills'/i);
  assert.match(singleOperatorMigration,/create\s+or\s+replace\s+function\s+private_app\.paymob_live_canary_eligible_v1/i);
  const canary=singleOperatorMigration.slice(
    singleOperatorMigration.indexOf('create or replace function private_app.paymob_live_canary_eligible_v1('),
    singleOperatorMigration.indexOf('create or replace function public.v1_platform_paymob_activation_gate(')
  );
  assert.match(canary,/requested_by_subject_id\s+is\s+not\s+null/i);
  assert.match(canary,/approved_by_subject_id\s+is\s+not\s+null/i);
  assert.doesNotMatch(canary,/approved_by_subject_id\s*<>\s*rollout\.requested_by_subject_id/i);
  const tenantAction=singleOperatorMigration.slice(
    singleOperatorMigration.indexOf('create or replace function public.v1_platform_paymob_tenant_rollout_action('),
    singleOperatorMigration.indexOf('create or replace function public.v1_platform_paymob_operational_evidence_action(')
  );
  assert.match(tenantAction,/requested_by_subject_id\s*=\s*v_actor[\s\S]*?approved_by_subject_id\s*=\s*v_actor/i);
  assert.match(tenantAction,/live_canary_approved/i);
  assert.match(tenantAction,/paymob_live_canary_single_tenant_required/i);
  assert.match(migration,/v_order\.total_minor\s*>\s*50000/i);
  assert.match(migration,/paymob_live_canary_amount_limit/i);
  assert.match(ui,/liveValidationReady/i);
  assert.match(ui,/500 ر\.س/);
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

test('legacy unsafe canary is disabled and Reef remains untouched',()=>{
  assert.match(migration,/live_canary_reapproval_required/i);
  assert.match(migration,/rollout\.requested_by_subject_id is null/i);
  assert.doesNotMatch(
    migration,
    /where[^;]*(?:slug|tenant_key)\s*=\s*['"](?:reef-skills|tenant-reef-skills)['"][^;]*update/is
  );
  assert.match(migration,/'globalLiveActivated',false/i);
  assert.match(migration,/'reefSkillsExcluded',true/i);
});
