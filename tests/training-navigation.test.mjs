import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {trainingOperationsAccess,trainingOperationsHref,TRAINING_JOURNEY_VIEWS} from '../lib/training-navigation.mjs';
import {interactiveTrainingAccess} from '../lib/interactive-training-access.mjs';
const tenantId='3d185482-b916-49cc-b868-b6dfdb93eba8';
const subjectId='61000000-0000-4000-8000-000000000006';
function fixture(permissions=['tenant.accounting.read']){return {
 slug:'marktone',context:{subject:{id:subjectId,status:'active'},memberships:[{tenantId,tenantSlug:'marktone',status:'active',permissions}]},
 addonAccess:{tenantId,tenantSlug:'marktone',enabledProductKeys:['lms']}
};}

test('accounting and admissions staff discover their operational pages without gaining prototype or authoring rights',()=>{
 for(const permission of ['tenant.accounting.read','tenant.admissions.read','tenant.admissions.write']){
  const input=fixture([permission]);const access=trainingOperationsAccess(input);
  assert.equal(access.enabled,true);assert.equal(access.canManageLearning,false);
  assert.deepEqual(access.views.map(v=>v.key),['dashboard','admissions','tasks']);
  assert.equal(interactiveTrainingAccess(input).enabled,false);
 }
 const manager=trainingOperationsAccess(fixture(['tenant.academy.write','tenant.admissions.write']));
 assert.equal(manager.canManage,true);assert.equal(manager.canManageLearning,true);assert.deepEqual(manager.views,TRAINING_JOURNEY_VIEWS);
 assert.equal(trainingOperationsAccess(fixture(['tenant.academy.read'])).enabled,false);
});

test('operational navigation still requires exact tenant identity, active authenticated staff and the LMS entitlement',()=>{
 const cases=[
  x=>{x.slug='reefskills';},x=>{x.context.subject.id=null;},x=>{x.context.subject.status='inactive';},
  x=>{x.context.subject.mustChangePassword=true;},x=>{x.context.memberships=[];},
  x=>{x.context.memberships[0].status='suspended';},x=>{x.context.memberships[0].tenantId=subjectId;},
  x=>{x.context.memberships[0].tenantSlug='reefskills';},x=>{x.addonAccess.tenantId=subjectId;},
  x=>{x.addonAccess.tenantSlug='reefskills';},x=>{x.addonAccess.enabledProductKeys=[];},
  x=>{x.addonAccess.enabledProductKeys='lms';},x=>{x.context.memberships[0].permissions=[];}
 ];
 for(const change of cases){const input=fixture();change(input);assert.equal(trainingOperationsAccess(input).enabled,false);}
 const platform=fixture([]);platform.context.platformAccess=true;platform.context.memberships=[];
 assert.equal(trainingOperationsAccess(platform).canManage,true);
 platform.addonAccess.enabledProductKeys=[];assert.equal(trainingOperationsAccess(platform).enabled,false);
 assert.equal(trainingOperationsHref('reefskills','admissions'),null);
 assert.equal(trainingOperationsHref('marktone','javascript:bad'),null);
 assert.equal(trainingOperationsHref('marktone','admissions'),'/tenant/marktone/lms/operations?view=admissions');
});

test('the operations route validates the requested view against actual staff access before loading a snapshot',async()=>{
 const source=readFileSync(new URL('../app/tenant/[slug]/lms/operations/page.js',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 let current=fixture();let reads=0;
 const exported={};
 const mocks={
  'next/navigation':{notFound:()=>{throw new Error('not_found');}},
  '../../../../../components/training-journey-workspace':{default:'workspace'},
  '../../../../../lib/server-auth':{requireTenantAddon:async()=>({...current.context,addonAccess:current.addonAccess})},
  '../../../../../lib/training-snapshot':{getTrainingSnapshot:async()=>{reads++;return {role:'manager'};}},
  '../../../../../lib/academy-legacy':{redirectLegacyAcademy:async()=>{}},
  '../../../../../lib/training-request.mjs':{TRAINING_PILOT_SLUG:'marktone'},
  '../../../../../lib/training-navigation.mjs':{trainingOperationsAccess,isTrainingJourneyView:key=>TRAINING_JOURNEY_VIEWS.some(v=>v.key===key)},
  '../../../../../lib/interactive-training-access.mjs':{interactiveTrainingAccess},
  'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key})}
 };
 vm.runInNewContext(code,{exports:exported,require:key=>{if(!(key in mocks))throw Error(key);return mocks[key];}});
 const page=exported.default;
 const result=await page({params:Promise.resolve({slug:'marktone'}),searchParams:Promise.resolve({view:'admissions'})});
 assert.equal(result.props.initialView,'admissions');assert.equal(result.key,'marktone:admissions');assert.equal(reads,1);
 assert.equal(result.props.canPreviewDevelopment,false);
 await assert.rejects(page({params:{slug:'marktone'},searchParams:{view:'courses'}}),/not_found/);assert.equal(reads,1);
 await assert.rejects(page({params:{slug:'reefskills'},searchParams:{view:'admissions'}}),/not_found/);assert.equal(reads,1);
 current=fixture(['tenant.academy.write']);
 const course=await page({params:{slug:'marktone'},searchParams:{view:'courses'}});assert.equal(course.props.initialView,'courses');
 assert.equal(course.props.canPreviewDevelopment,false);
 current=fixture(['tenant.academy.read','tenant.academy.write']);
 assert.equal((await page({params:{slug:'marktone'},searchParams:{view:'courses'}})).props.canPreviewDevelopment,true);
});

test('the actual navigation RPC admits an accounting-only employee and denies the same employee after membership revocation',async()=>{
 const {setup,call,T,INSTRUCTOR,INSTRUCTOR_AUTH,id,login}=await import('./fixtures/training-journey-database.mjs');
 const db=await setup();
 try{
  await db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)',[T]);
  await db.query('delete from access_control.role_permissions where role_id=$1',[id(22)]);
  await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.accounting.read')",[id(22)]);
  await login(db,INSTRUCTOR_AUTH);
  assert.equal((await call(db,'public.v1_training_journey_navigation',{p_slug:'marktone'})).enabled,true);
  await db.query("update access_control.memberships set status='suspended' where subject_id=$1",[INSTRUCTOR]);
  assert.equal((await call(db,'public.v1_training_journey_navigation',{p_slug:'marktone'})).enabled,false);
 }finally{await db.close();}
});
