import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const migration=await readFile(
  new URL('../supabase/migrations/20260905170000_paymob_all_tenants_automatic_access_v1.sql',import.meta.url),
  'utf8'
);

test('Paymob tenant access is an explicit global policy, not a tenant allow-list',()=>{
  assert.match(migration,/tenantAccessPolicy[^\n]+all_tenants/i);
  assert.match(migration,/autoEnableNewTenants[^\n]+true/i);
  assert.match(migration,/paymob_global_tenant_access_enabled_v1/i);
  assert.match(migration,/paymob_tenant_checkout_eligible_v1/i);
  assert.match(migration,/exists\s*\(select 1 from core\.tenants tenant where tenant\.id=p_tenant_id\)/i);
  assert.doesNotMatch(migration,/modaar-training-center|tenant-reef-skills|reef-skills/i);
});

test('provider readiness and the global kill switch remain mandatory',()=>{
  assert.match(migration,/provider\.status='active'/i);
  assert.match(migration,/provider\.environment=p_environment/i);
  assert.match(migration,/provider\.credentials_environment=p_environment/i);
  assert.match(migration,/provider\.rollout_mode=p_environment/i);
  assert.match(migration,/provider\.checkout_mode='redirect'/i);
  assert.match(migration,/integrationPath'='quicklink'/i);
  assert.match(migration,/paymob_required_secret_refs_valid_v2/i);
});

test('future tenants inherit access while an explicit emergency disable still wins',()=>{
  assert.match(migration,/not exists\s*\([\s\S]*payment_tenant_rollouts[\s\S]*status='disabled'/i);
  assert.match(migration,/existingTenantCount/i);
  assert.match(migration,/explicitTenantDisableSupported/i);
  assert.match(migration,/v_total<>v_eligible/i);
});

test('activation refuses unresolved or quarantined live payment attempts',()=>{
  assert.match(migration,/attempt\.status in \('creating_intention','unknown','quarantined'\)/i);
  assert.match(migration,/paymob_all_tenants_unresolved_attempts_present/i);
});
