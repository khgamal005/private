import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const routePath=new URL('../app/api/auth/logout/route.js',import.meta.url);

test('logout keeps the browser on the public origin',async()=>{
  const route=await readFile(routePath,'utf8');
  const exports={};
  const source=ts.transpileModule(route,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  class ResponseStub{constructor(body,options){Object.assign(this,options);this.cookies={set(){}};}}
  vm.runInNewContext(source,{exports,require:name=>name==='next/server'?{NextResponse:ResponseStub}:name==='next/headers'?{cookies:async()=>({get(){}})}:{ACCESS_COOKIE:'access',REFRESH_COOKIE:'refresh'}});
  for(const [workspace,destination] of [['academy','/academy/login'],['odeir','/login'],['https://evil.example','/login']]){
    const response=await exports.POST(new Request('http://0.0.0.0:3000/api/auth/logout',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({workspace})}));
    assert.equal(response.status,303);assert.equal(response.headers.Location,destination);
  }
  const trainingResponse=await exports.POST(new Request('http://0.0.0.0:3000/api/auth/logout',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({workspace:'training',trainingWorkspace:'academy',tenant:'marktone',role:'instructor'})}));
  assert.equal(trainingResponse.headers.Location,'/training/login?tenant=marktone&workspace=academy&role=instructor');
  const unsafeTrainingResponse=await exports.POST(new Request('http://0.0.0.0:3000/api/auth/logout',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({workspace:'training',trainingWorkspace:'academy',tenant:'//evil.example',role:'learner'})}));
  assert.equal(unsafeTrainingResponse.headers.Location,'/training/login?role=learner');
});

test('logout expires both authentication cookies',async()=>{
  const route=await readFile(routePath,'utf8');

  assert.ok(route.includes("cookies.set(ACCESS_COOKIE,''"));
  assert.ok(route.includes("cookies.set(REFRESH_COOKIE,''"));
  assert.ok(route.includes('maxAge:0'));
});
