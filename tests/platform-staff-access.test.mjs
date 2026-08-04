import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('platform staff access has isolated roles, invitations and guarded RPCs',async()=>{
  const migration=await read('supabase/migrations/20260804193000_platform_staff_roles_permissions_v1.sql');
  for(const pattern of [
    /access_control\.platform_invitations/,
    /platform\.content\.manage/,
    /platform\.settings\.manage/,
    /platform_website_manager/,
    /platform_tenants_manager/,
    /platform_access_manager/,
    /v2_platform_access_snapshot/,
    /v2_platform_access_action/,
    /v2_platform_invitation_preview/,
    /v2_accept_platform_invitation/,
    /cannot_suspend_last_access_manager/,
    /revoke all on table access_control\.platform_invitations/
  ])assert.match(migration,pattern);
});

test('platform navigation and routes are driven by explicit permissions',async()=>{
  const [shell,auth,layout,tenants,billing,content,website,settings,team]=await Promise.all([
    read('components/workspace-shell.js'),
    read('lib/server-auth.js'),
    read('app/control/layout.js'),
    read('app/control/tenants/page.js'),
    read('app/control/subscriptions/page.js'),
    read('app/control/content/page.js'),
    read('app/control/website/layout.js'),
    read('app/control/settings/page.js'),
    read('app/control/team/page.js')
  ]);
  assert.match(shell,/platform\.tenants\.manage/);
  assert.match(shell,/platform\.website\.manage/);
  assert.match(shell,/platform\.access\.manage/);
  assert.match(shell,/\/control\/team/);
  assert.match(auth,/requirePlatformPermission/);
  assert.match(auth,/requireAnyPlatformPermission/);
  assert.match(layout,/platformPermissions/);
  assert.match(tenants,/platform\.tenants\.manage/);
  assert.match(billing,/platform\.billing\.manage/);
  assert.match(content,/platform\.content\.manage/);
  assert.match(website,/platform\.website\.manage/);
  assert.match(settings,/platform\.settings\.manage/);
  assert.match(team,/PlatformAccessManager/);
});

test('platform access UI supports employees, custom roles and safe invitations',async()=>{
  const [manager,route,login,loginApi,activation,edge]=await Promise.all([
    read('components/platform-access-manager.js'),
    read('app/api/platform/access/route.js'),
    read('components/login-form.js'),
    read('app/api/auth/login/route.js'),
    read('app/accept-platform-invite/page.js'),
    read('supabase/functions/platform-invitation-activation/index.ts')
  ]);
  for(const action of [
    'invite_employee','update_employee','suspend_employee','activate_employee',
    'create_role','update_role','delete_role','renew_invitation','revoke_invitation'
  ])assert.match(manager,new RegExp(action));
  assert.match(manager,/مسؤول الموقع الإلكتروني/);
  assert.match(manager,/مسؤول إدارة المنشآت/);
  assert.match(route,/v2_platform_access_action/);
  assert.match(login,/platformInvite/);
  assert.match(loginApi,/v2_accept_platform_invitation/);
  assert.match(activation,/v2_platform_invitation_preview/);
  assert.match(edge,/v2_accept_platform_invitation/);
});
