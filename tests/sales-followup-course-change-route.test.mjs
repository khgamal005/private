import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadRoute(fetch,token='synthetic-session'){
  const exports={};
  const source=readFileSync(new URL('../app/api/tenant/[action]/route.js',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const require=name=>{
    if(name==='next/headers')return {cookies:async()=>({get:()=>token?{value:token}:undefined})};
    if(name==='next/server')return {NextResponse:Response};
    if(name.endsWith('woocommerce-admissions.mjs'))return {WOO_ADMISSION_ERRORS:{}};
    if(name.endsWith('/config'))return {ACCESS_COOKIE:'session',SUPABASE_KEY:'public-test',SUPABASE_URL:'https://fixture.test'};
    throw new Error(name);
  };
  vm.runInNewContext(code,{exports,require,fetch,Response,console});
  return body=>exports.POST(new Request('https://app.test/api/tenant/record-sales-followup',{
    method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}
  }),{params:Promise.resolve({action:'record-sales-followup'})});
}

test('course replacement uses V8 and preserves old callers and session-scoped forwarding',async()=>{
  const calls=[];
  const call=loadRoute(async(url,init)=>{calls.push({url,init});return Response.json({id:'activity'});});
  const legacy={p_tenant_slug:'synthetic',p_contact_id:'contact'};
  for(const [body,version] of [
    [legacy,5],
    [{...legacy,p_course_interests:[]},6],
    [{...legacy,p_course_interests:[],p_opportunity_id:'sale'},7],
    [{...legacy,p_course_interests:[{courseId:'online'}],p_opportunity_id:'sale',p_opportunity_course_id:'online'},8]
  ]){
    const response=await call(body);assert.equal(response.status,200);
    assert.ok(calls.at(-1).url.endsWith('v2_tenant_record_sales_followup_v'+version));
    assert.equal(calls.at(-1).init.headers.Authorization,'Bearer synthetic-session');
    assert.deepEqual(JSON.parse(calls.at(-1).init.body),body);
  }
});

test('missing authentication never reaches SQL and a locked course returns an actionable error',async()=>{
  let calls=0;
  const unauthenticated=loadRoute(async()=>{calls++;return Response.json({});},null);
  assert.equal((await unauthenticated({p_opportunity_course_id:'online'})).status,401);
  assert.equal(calls,0);
  const locked=loadRoute(async()=>Response.json({message:'opportunity_course_change_unavailable'},{status:400}));
  const response=await locked({p_course_interests:[],p_opportunity_course_id:'online'});
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/بلاغ دفع أو تسجيل سابق/);
});
