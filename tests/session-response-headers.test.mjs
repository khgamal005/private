import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import nextConfig from '../next.config.mjs';

function valueFor(route,key){
  return route.headers.find(header=>header.key===key)?.value;
}

test('auth and protected pages disable proxy buffering and shared caching',async()=>{
  const routes=await nextConfig.headers();
  const protectedSources=[
    '/login',
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

  const authApi=routes.find(route=>route.source==='/api/auth/:path*');
  assert.match(valueFor(authApi,'Cache-Control'),/private, no-store/);
  assert.equal(valueFor(authApi,'CDN-Cache-Control'),'no-store');

  const global=routes.find(route=>route.source==='/:path*');
  assert.equal(valueFor(global,'X-Content-Type-Options'),'nosniff');
  assert.equal(valueFor(global,'X-Frame-Options'),'DENY');
});

test('every session-creating auth response explicitly disables caching',async()=>{
  const paths=[
    'app/api/auth/login/route.js',
    'app/api/auth/register-invitation/route.js',
    'app/api/auth/register-platform-invitation/route.js',
    'app/api/auth/change-password/route.js'
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

test('login HTML is rendered dynamically so the CDN cannot reuse a stale shell',async()=>{
  const content=await readFile(
    new URL('../app/login/page.js',import.meta.url),
    'utf8'
  );
  assert.match(content,/export const dynamic='force-dynamic'/);
});
