import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  canAccessPlatformControl,
  resolvePostLoginPath,
  safeInternalPath
} from '../lib/login-destination.mjs';
import {
  replaceDocument,
  safeDocumentPath
} from '../lib/full-document-navigation.mjs';

const platformContext={
  platformAccess:true,
  platformPermissions:['platform.control.read'],
  memberships:[{tenantSlug:'modaar-training-center'}],
  subject:{mustChangePassword:false}
};

async function source(path){
  return readFile(new URL('../'+path,import.meta.url),'utf8');
}

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
  assert.equal(safeInternalPath('/..//example.com/steal'),null);
  assert.equal(safeInternalPath('/%2e%2e//example.com/steal'),null);
  assert.equal(safeInternalPath('/control/tenants?tab=active'),'/control/tenants?tab=active');
});

test('full-document navigation accepts only same-origin paths',()=>{
  const calls=[];
  const location={replace:value=>calls.push(value)};
  assert.equal(
    replaceDocument('/control/tenants?tab=active',{
      fallback:'/control',
      location
    }),
    '/control/tenants?tab=active'
  );
  assert.equal(
    replaceDocument('https://example.com/steal',{
      fallback:'/control',
      location
    }),
    '/control'
  );
  assert.equal(safeDocumentPath('//example.com/steal','/login'),'/login');
  assert.equal(safeDocumentPath('/\\evil.example','/login'),'/login');
  assert.equal(safeDocumentPath('/..//evil.example/x','/login'),'/login');
  assert.equal(safeDocumentPath('/%2e%2e//evil.example/x','/login'),'/login');
  assert.deepEqual(calls,['/control/tenants?tab=active','/control']);
});

test('all session-changing forms use a fresh document without an RSC refresh',async()=>{
  const expectations=[
    ['components/login-form.js',/replaceDocument\(data\.next,\{fallback:'\/control'\}\)/],
    ['components/invitation-activation-form.js',/replaceDocument\(data\.next,\{/],
    ['components/platform-invitation-activation-form.js',/replaceDocument\(data\.next,\{fallback:'\/control'\}\)/],
    ['components/change-password-form.js',/replaceDocument\(data\.next,\{fallback:'\/control'\}\)/],
    ['components/reset-password-form.js',/replaceDocument\('\/login\?reset=success',\{fallback:'\/login'\}\)/]
  ];
  for(const [path,pattern] of expectations){
    const content=await source(path);
    assert.match(content,pattern,path);
    assert.doesNotMatch(content,/useRouter|router\.(?:replace|refresh)/,path);
    assert.match(content,/catch\{[\s\S]*تعذر الاتصال بالخادم/,path);
  }
});

test('login client obeys the server-authorized destination and auth responses are private',async()=>{
  const form=await source('components/login-form.js');
  const route=await source('app/api/auth/login/route.js');
  assert.match(form,/requestedNext/);
  assert.doesNotMatch(form,/requested\|\|data\.next/);
  assert.match(route,/resolvePostLoginPath/);
  assert.match(route,/Cache-Control/);
  assert.match(route,/private, no-store/);
  assert.match(route,/CDN-Cache-Control/);
});

test('session expiry and invitation login links bypass client routing',async()=>{
  const notificationCenter=await source('components/notification-center.js');
  assert.match(
    notificationCenter,
    /error\?\.status===401[\s\S]*replaceDocument\('\/login\?reason=session'\)/
  );
  assert.doesNotMatch(notificationCenter,/useRouter|router\.replace/);

  const linkFiles=[
    'components/invitation-activation-form.js',
    'components/platform-invitation-activation-form.js',
    'app/accept-invite/page.js',
    'app/accept-platform-invite/page.js'
  ];
  for(const path of linkFiles){
    const content=await source(path);
    assert.doesNotMatch(content,/import Link from 'next\/link'/,path);
    assert.match(content,/<a[^>]+href=.*\/login|<a[^>]+href="\/login"/,path);
  }
});

test('server authorization recognizes the canonical platform access flag',()=>{
  assert.equal(canAccessPlatformControl({platformAccess:true}),true);
  assert.equal(canAccessPlatformControl({
    platformPermissions:['platform.control.read']
  }),true);
  assert.equal(canAccessPlatformControl({memberships:[]}),false);
});
