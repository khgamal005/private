import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  canAccessPlatformControl,
  resolvePostLoginPath,
  safeInternalPath
} from '../lib/login-destination.mjs';

const platformContext={
  platformAccess:true,
  platformPermissions:['platform.control.read'],
  memberships:[{tenantSlug:'modaar-training-center'}],
  subject:{mustChangePassword:false}
};

test('platform owner always lands in platform control after a normal login',()=>{
  assert.equal(resolvePostLoginPath({context:platformContext}),'/control');
  assert.equal(resolvePostLoginPath({
    context:platformContext,
    requestedNext:'/tenant/modaar-training-center/tasks'
  }),'/control');
  assert.equal(resolvePostLoginPath({
    context:platformContext,
    requestedNext:'/control/tenants'
  }),'/control/tenants');
});

test('tenant users can only resume a route for one of their memberships',()=>{
  const context={
    platformAccess:false,
    platformPermissions:[],
    memberships:[{tenantSlug:'reef-skills'}],
    subject:{mustChangePassword:false}
  };
  assert.equal(resolvePostLoginPath({
    context,
    requestedNext:'/tenant/reef-skills/tasks?view=month'
  }),'/tenant/reef-skills/tasks?view=month');
  assert.equal(resolvePostLoginPath({
    context,
    requestedNext:'/tenant/modaar-training-center'
  }),'/tenant/reef-skills');
  assert.equal(resolvePostLoginPath({
    context,
    requestedNext:'/control'
  }),'/tenant/reef-skills');
});

test('password-change and invitation destinations keep their priority',()=>{
  assert.equal(resolvePostLoginPath({
    context:{...platformContext,subject:{mustChangePassword:true}},
    acceptedTenantInvitation:{tenantSlug:'reef-skills'}
  }),'/change-password');
  assert.equal(resolvePostLoginPath({
    context:platformContext,
    acceptedTenantInvitation:{tenantSlug:'reef-skills'}
  }),'/tenant/reef-skills');
  assert.equal(resolvePostLoginPath({
    context:platformContext,
    acceptedPlatformInvitation:{accepted:true}
  }),'/control');
});

test('external and malformed next values are rejected',()=>{
  assert.equal(safeInternalPath('https://example.com/steal'),null);
  assert.equal(safeInternalPath('//example.com/steal'),null);
  assert.equal(safeInternalPath('/control/tenants?tab=active'),'/control/tenants?tab=active');
});

test('login client obeys the server-authorized destination',async()=>{
  const form=await readFile(
    new URL('../components/login-form.js',import.meta.url),
    'utf8'
  );
  const route=await readFile(
    new URL('../app/api/auth/login/route.js',import.meta.url),
    'utf8'
  );
  assert.match(form,/requestedNext/);
  assert.match(form,/router\.replace\(data\.next\|\|'\/control'\)/);
  assert.doesNotMatch(form,/requested\|\|data\.next/);
  assert.match(route,/resolvePostLoginPath/);
  assert.match(route,/Cache-Control','private, no-store/);
});

test('server authorization recognizes the canonical platform access flag',()=>{
  assert.equal(canAccessPlatformControl({platformAccess:true}),true);
  assert.equal(canAccessPlatformControl({
    platformPermissions:['platform.control.read']
  }),true);
  assert.equal(canAccessPlatformControl({memberships:[]}),false);
});
