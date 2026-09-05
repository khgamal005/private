import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const migration=readFileSync(
  'supabase/migrations/20260905170000_paymob_automatic_all_tenants_v1.sql',
  'utf8'
);
const api=readFileSync('app/api/platform/paymob-control/route.js','utf8');
const ui=readFileSync('components/platform-addon-console.js','utf8');

test('automatic rollout is fail-closed on the verified QuickLink binding',()=>{
  assert.match(migration,/paymob_automatic_rollout_provider_not_ready/);
  assert.match(migration,/paymob_automatic_rollout_credential_not_ready/);
  assert.match(migration,/paymob_automatic_rollout_active_checkout_must_drain/);
  assert.match(migration,/public_config\s*->>\s*'integrationPath'\s*<>\s*'quicklink'/);
  assert.match(migration,/paymob_evidence_passed\([\s\S]*?'credentials'/);
  assert.match(migration,/paymob_evidence_passed\([\s\S]*?'intention_create'/);
  assert.match(migration,/paymob_required_secret_refs_valid_v2\([\s\S]*?'quicklink'/);
  assert.match(migration,/paymob_live_credential_material_valid_v2\([\s\S]*?'quicklink'/);
  assert.match(migration,/count\(\*\)[\s\S]*?status\s*=\s*'active'[\s\S]*?=\s*1/);
  assert.doesNotMatch(migration,/update\s+marketplace\.payment_provider_configs/i);
  assert.doesNotMatch(migration,/insert\s+into\s+marketplace\.payment_attempts/i);
  assert.doesNotMatch(migration,/update\s+marketplace\.orders/i);
});

test('every existing and future tenant receives an explicit automatic rollout',()=>{
  assert.match(migration,/approval_code\s*=\s*'automatic_all_tenants'/);
  assert.match(migration,/create\s+trigger\s+zz_tenants_paymob_auto_enroll_after_insert/i);
  assert.match(migration,/after\s+insert\s+on\s+core\.tenants/i);
  assert.match(migration,/insert\s+into\s+marketplace\.payment_tenant_rollouts/i);
  assert.match(migration,/from\s+core\.tenants\s+tenant[\s\S]*?cross\s+join\s+marketplace\.payment_provider_configs/i);
  assert.match(migration,/on\s+conflict\s*\(tenant_id,provider_key,environment\)\s+do\s+update/i);
  assert.match(migration,/v_enabled\s*<>\s*v_tenants/);
  assert.match(migration,/where\s+not\s+private_app\.paymob_tenant_checkout_eligible_v1/i);
});

test('automatic system enrollment does not reintroduce a second human approver',()=>{
  assert.match(migration,/approval_code\s*=\s*'automatic_all_tenants'/);
  assert.match(migration,/approved_by_subject_id\s+is\s+not\s+null[\s\S]*?or\s+approval_code\s*=\s*'automatic_all_tenants'/i);
  assert.match(migration,/null,null,null,now\(\)/);
  assert.doesNotMatch(migration,/requested_by_subject_id\s*<>\s*approved_by_subject_id/i);
});

test('legacy one-tenant canary gates are converted through explicit audited patches',()=>{
  assert.match(migration,/paymob_controlled_live_provider_ready_v1/);
  assert.match(migration,/paymob_controlled_live_eligible_v1/);
  assert.match(migration,/Compatibility alias retained for older audited payment functions/);
  assert.match(migration,/paymob_automatic_rollout_prepare_patch_failed/);
  assert.match(migration,/paymob_automatic_rollout_runtime_patch_failed/);
  assert.match(migration,/paymob_automatic_rollout_resume_patch_failed/);
  assert.match(migration,/paymob_automatic_rollout_record_patch_failed/);
  assert.match(migration,/paymob_automatic_rollout_action_patch_failed/);
  assert.match(migration,/paymob_automatic_rollout_readiness_patch_failed/);
  assert.match(migration,/paymob_automatic_rollout_tenant_delete_patch_failed/);
  assert.match(migration,/delete\s+from\s+marketplace\.payment_tenant_rollouts\s+item/);
  assert.match(migration,/paymob_live_canary_amount_limit/);
  assert.match(migration,/replace\(v_definition,v_old,''\)/);
});

test('platform API exposes only non-sensitive automatic rollout flags',()=>{
  assert.match(api,/automaticTenantEnrollment:value\.automaticTenantEnrollment===true/);
  assert.match(api,/controlledLiveActive:value\.controlledLiveActive===true/);
  assert.doesNotMatch(api,/apiKey|hmacSecret|secretKey|publicKey/);
});

test('platform UI includes Reef and explains automatic existing/future enrollment',()=>{
  const governanceStart=ui.indexOf('function PaymobGovernance');
  const governanceEnd=ui.indexOf('function Providers',governanceStart);
  assert.ok(governanceStart!==-1&&governanceEnd>governanceStart);
  const governance=ui.slice(governanceStart,governanceEnd);
  assert.doesNotMatch(governance,/tenantSlug==='reef-skills'|tenantKey==='tenant-reef-skills'/);
  assert.match(governance,/automaticTenantEnrollment/);
  assert.match(governance,/controlledLiveActive/);
  assert.match(governance,/كل المنشآت الحالية والجديدة/);
  assert.match(governance,/إيقاف المنشأة/);
});
