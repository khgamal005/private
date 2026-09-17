import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('tenant provisioning captures owner, plan, and domain atomically',async()=>{
  const form=await read('../components/platform-tenants.js');
  const route=await read('../app/api/platform/[action]/route.js');
  assert.match(form,/p_owner_name:values\.owner_name/);
  assert.match(form,/p_owner_email:values\.owner_email/);
  assert.match(form,/p_hostname:normalizeHostname/);
  assert.match(form,/p_plan_key:values\.plan_key/);
  assert.match(route,/'provision-tenant':'v2_platform_provision_tenant'/);
  assert.match(route,/'invite-user':'v2_tenant_invite_user'/);
});

test('invitation activation never relies on a public service key',async()=>{
  const registration=await read('../app/api/auth/register-invitation/route.js');
  const activation=await read('../supabase/functions/tenant-invitation-activation/index.ts');
  const config=await read('../lib/config.js');
  assert.match(registration,/tenant-invitation-activation/);
  assert.match(registration,/SUPABASE_KEY/);
  assert.match(activation,/v1_invitation_activation_preflight/);
  const activationMigration=await read('../supabase/migrations/20260917194438_staff_account_activation_v1.sql');
  assert.match(activationMigration,/preview:=public\.v2_invitation_preview\(p_token\)/);
  assert.match(activationMigration,/enforce_tenant_plan_limit\(i\.tenant_id,'max_employees'\)/);
  assert.match(activation,/v2_accept_tenant_invitation/);
  assert.match(activation,/SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(`${registration}\n${config}`,/service.role|service_role|secret.key|SUPABASE_SECRET/i);
});

test('login can accept an invitation before resolving workspace access',async()=>{
  const login=await read('../app/api/auth/login/route.js');
  const tokenIndex=login.indexOf('v2_accept_tenant_invitation');
  const contextIndex=login.indexOf('v2_current_user_context');
  assert.ok(tokenIndex>0);
  assert.ok(contextIndex>tokenIndex);
});

test('staff accounts become active only after confirmed invitation acceptance',async()=>{
  const reconciliation=await read('../supabase/migrations/20260729180500_reconcile_staff_auth_activation.sql');
  assert.match(reconciliation,/and u\.email_confirmed_at is not null/);
  assert.match(reconciliation,/account_status = case[\s\S]*when v_auth_confirmed then 'active'[\s\S]*else 'invited'/);
  assert.match(reconciliation,/update people\.staff_profiles[\s\S]*account_status = 'active'[\s\S]*v_invitation\.email/);
  assert.match(reconciliation,/set account_status = 'invited'[\s\S]*u\.email_confirmed_at is null/);
});

test('tenant settings use v2 access invitations rather than legacy employee creation',async()=>{
  const settings=await read('../components/tenant-settings.js');
  const api=await read('../lib/api.js');
  assert.match(settings,/\/api\/platform\/invite-user/);
  assert.doesNotMatch(settings,/\/api\/crm\/create-employee/);
  assert.match(api,/v2_tenant_access_snapshot/);
  assert.match(api,/v2_platform_provisioning_snapshot/);
});
