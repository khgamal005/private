import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const routePath=new URL('../app/api/auth/logout/route.js',import.meta.url);

test('logout keeps the browser on the public origin',async()=>{
  const route=await readFile(routePath,'utf8');

  assert.ok(route.includes("Location:'/login'"));
  assert.ok(route.includes('status:303'));
  assert.ok(!route.includes("new URL('/login',req.url)"));
});

test('logout expires both authentication cookies',async()=>{
  const route=await readFile(routePath,'utf8');

  assert.ok(route.includes("cookies.set(ACCESS_COOKIE,''"));
  assert.ok(route.includes("cookies.set(REFRESH_COOKIE,''"));
  assert.ok(route.includes('maxAge:0'));
});
