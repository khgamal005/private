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
  assert.match(activation,/v2_invitation_preview/);
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

test('tenant settings use v2 access invitations rather than legacy employee creation',async()=>{
  const settings=await read('../components/tenant-settings.js');
  const api=await read('../lib/api.js');
  assert.match(settings,/\/api\/platform\/invite-user/);
  assert.doesNotMatch(settings,/\/api\/crm\/create-employee/);
  assert.match(api,/v2_tenant_access_snapshot/);
  assert.match(api,/v2_platform_provisioning_snapshot/);
});
