import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import nextConfig from '../next.config.mjs';

function valueFor(route,key){
  return route.headers.find(header=>header.key===key)?.value;
}

test('protected pages disable proxy buffering and shared caching',async()=>{
  const routes=await nextConfig.headers();
  const protectedSources=[
    '/change-password',
    '/accept-invite',
    '/accept-platform-invite',
    '/control/:path*',
    '/tenant/:path*'
  ];
  for(const source of protectedSources){
    const route=routes.find(candidate=>candidate.source===source);
    assert.ok(route,'missing headers for '+source);
    assert.match(valueFor(route,'Cache-Control'),/private, no-store/);
    assert.equal(valueFor(route,'CDN-Cache-Control'),'no-store');
    assert.equal(valueFor(route,'X-Accel-Buffering'),'no');
  }

  const publicAuthSources=['/login','/forgot-password','/reset-password'];
  for(const source of publicAuthSources){
    const route=routes.find(candidate=>candidate.source===source);
    assert.ok(route,'missing headers for '+source);
    assert.match(valueFor(route,'Cache-Control'),/public/);
    assert.match(valueFor(route,'Cache-Control'),/s-maxage=300/);
    assert.match(valueFor(route,'Cache-Control'),/stale-if-error/);
    assert.equal(valueFor(route,'X-Accel-Buffering'),'no');
  }

  const authApi=routes.find(route=>route.source==='/api/auth/:path*');
  assert.match(valueFor(authApi,'Cache-Control'),/private, no-store/);
  assert.equal(valueFor(authApi,'CDN-Cache-Control'),'no-store');

  const global=routes.find(route=>route.source==='/:path*');
  assert.equal(valueFor(global,'X-Content-Type-Options'),'nosniff');
  assert.equal(valueFor(global,'X-Frame-Options'),'DENY');
  assert.equal(
    routes.some(route=>route.source==='/free-trial/apply'),
    false,
    'registration is rendered directly and must keep the global frame denial'
  );
});

test('every session-creating auth response explicitly disables caching',async()=>{
  const paths=[
    'app/api/auth/login/route.js',
    'app/api/auth/register-invitation/route.js',
    'app/api/auth/register-platform-invitation/route.js',
    'app/api/auth/change-password/route.js',
    'app/api/auth/request-password-reset/route.js',
    'app/api/auth/reset-password/route.js'
  ];
  for(const path of paths){
    const content=await readFile(new URL('../'+path,import.meta.url),'utf8');
    assert.match(content,/Cache-Control/,path);
    assert.match(content,/private, no-store/,path);
    assert.match(content,/CDN-Cache-Control/,path);
    assert.doesNotMatch(
      content,
      /detail:(?:error|session|await)/,
      'raw auth detail leaked by '+path
    );
  }
});

test('public login shell is prerendered while the auth API stays private',async()=>{
  const content=await readFile(
    new URL('../app/login/page.js',import.meta.url),
    'utf8'
  );
  assert.match(content,/export const revalidate=300/);
  assert.doesNotMatch(content,/force-dynamic/);
});

test('registration modal renders the form directly without weakening frame protection',async()=>{
  const [modal,styles]=await Promise.all([
    readFile(
      new URL('../components/odeir-registration-modal.tsx',import.meta.url),
      'utf8'
    ),
    readFile(
      new URL('../components/odeir-registration-modal.module.css',import.meta.url),
      'utf8'
    )
  ]);
  assert.match(modal,/FreeTrialLanding/);
  assert.match(modal,/<FreeTrialLanding registrationOnly \/>/);
  assert.doesNotMatch(modal,/<iframe|SAMEORIGIN/);
  assert.match(modal,/styles\.dialog/);
  assert.match(styles,/\.form :global\(\.trial-card\)/);
  assert.match(styles,/\.dialog\.dialog/);
  assert.match(styles,/scrollbar-width:\s*none/);
  assert.doesNotMatch(styles,/#(?:ead49a|fff9e9|84630e|876717)/i);
  assert.match(styles,/@media \(max-width: 650px\)/);
});
