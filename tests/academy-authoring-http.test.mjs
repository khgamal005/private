import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as requests from '../lib/training-request.mjs';
import * as authoring from '../lib/academy-authoring.mjs';

const commandId='652bc8b2-ef69-4f21-a4e9-2ce2b49c1269';
function harness(handler=async()=>({saved:true})){
  const calls=[],exports={};
  const source=ts.transpileModule(readFileSync(new URL('../app/api/academy-authoring/[action]/route.js',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const rpc=async(...args)=>{calls.push(args);return handler(...args);};
  vm.runInThisContext(`(function(require,exports){${source}\n})`)(name=>{
    if(name.endsWith('training-request.mjs'))return requests;
    if(name.endsWith('academy-authoring.mjs'))return authoring;
    if(name.endsWith('training-server'))return {trainingJson:(body,status=200)=>({body,status}),trainingRpc:rpc};
    if(name.endsWith('academy-authoring-server'))return {getAcademyAuthoringSnapshot:async(slug,input)=>{const options=authoring.authoringSnapshotOptions(input);return rpc('v1_academy_authoring_snapshot',{p_slug:slug,p_course_id:options.courseId,p_path_id:options.pathId,p_offset:options.offset,p_path_offset:options.pathOffset,p_query:options.query});},getAcademyLearnerPaths:async(slug,input)=>rpc('v1_academy_learner_paths',{p_slug:slug,p_offset:authoring.authoringSnapshotOptions(input).offset})};
    throw Error(name);
  },exports);
  return {...exports,calls};
}
function invoke(h,action,body,origin='https://odeir.com'){
  return h.POST(new Request(`https://odeir.com/api/academy-authoring/${action}`,{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)}),{params:Promise.resolve({action})});
}
test('authoring boundary validates tenant, origin, actions, streamed limits and UUID before any RPC',async()=>{
  const h=harness(),body={tenantSlug:'marktone',commandId,payload:{title:'دورة جديدة'}};
  assert.equal((await invoke(h,'create_course',body,'https://attacker.example')).status,403);
  assert.equal((await invoke(h,'create_course',{...body,tenantSlug:'reef-skills'})).status,404);
  assert.equal((await invoke(h,'activate_ai',body)).status,404);
  assert.equal((await invoke(h,'create_course',{...body,commandId:'fake'})).status,400);
  assert.equal((await invoke(h,'create_course',{...body,payload:{title:'x'.repeat(40000)}})).status,413);
  assert.equal(h.calls.length,0);
});
test('course writes discard forged actor/tenant/status/AI secrets and sanitize nested content',async()=>{
  const h=harness(),document=authoring.createAuthoringDocument('دورة محفوظة');
  document.topics=[{id:'topic-1',title:'الأساسيات',summary:'',units:[{id:'lesson-1',title:'درس',kind:'text',body:'شرح',role:'admin',status:'published'}]}];
  const result=await invoke(h,'save_course',{tenantSlug:'marktone',commandId,role:'manager',payload:{courseId:commandId,expectedRevision:1,actorSubjectId:commandId,document:{...document,apiKey:'secret',tenantId:'foreign',published:true}}});
  assert.equal(result.status,200);
  const sent=h.calls[0][1];assert.equal(sent.p_slug,'marktone');
  assert.equal(sent.p_payload.actorSubjectId,undefined);assert.equal(sent.p_payload.document.apiKey,undefined);assert.equal(sent.p_payload.document.tenantId,undefined);
  assert.equal(sent.p_payload.document.topics[0].units[0].role,undefined);
  assert.equal(sent.p_payload.document.topics[0].units[0].required,true);
  const denied=harness(async()=>{throw requests.trainingProblem('forbidden',403);});
  assert.equal((await invoke(denied,'create_course',{tenantSlug:'marktone',commandId,payload:{title:'غير مسموح'}})).status,403);
});
test('snapshot accepts only bounded queries and identifiers, has no mutation or generation side effects',async()=>{
  const h=harness();
  assert.equal((await invoke(h,'snapshot',{tenantSlug:'marktone',payload:{query:'إدارة',offset:50,pathOffset:0,courseId:commandId}})).status,200);
  assert.deepEqual(h.calls[0],['v1_academy_authoring_snapshot',{p_slug:'marktone',p_course_id:commandId,p_path_id:null,p_offset:50,p_path_offset:0,p_query:'إدارة'}]);
  for(const payload of [{offset:-1},{offset:100001},{query:'a'.repeat(101)},{pathId:'bad'},[]])assert.equal((await invoke(h,'snapshot',{tenantSlug:'marktone',payload})).status,400);
  assert.equal(h.calls.length,1);
});
test('publication is an explicit reviewed revision, paths cannot include duplicate/foreign-shaped identifiers',()=>{
  assert.deepEqual(authoring.authoringPayload('publish_course',{courseId:commandId,expectedRevision:4,humanReviewed:'true'}),{courseId:commandId,expectedRevision:4,humanReviewed:false});
  for(const expectedRevision of [-1,0.5,'4'])assert.throws(()=>authoring.authoringPayload('publish_course',{courseId:commandId,expectedRevision}));
  assert.throws(()=>authoring.authoringPayload('save_path',{expectedRevision:0,document:{title:'مسار',courseIds:[commandId,commandId]}}));
  const doc=authoring.createAuthoringDocument('المقدمة');
  for(const value of ['javascript:alert(1)','https://name:password@example.test','https://example.test\\@evil.test'])assert.throws(()=>authoring.authoringDocument({...doc,introVideoUrl:value}));
  assert.equal(authoring.authoringSafeUrl('https://example.test/lesson'),true);
});
test('learner path request cannot supply another learner identity or alter enrollment',async()=>{
  const h=harness();
  assert.equal((await invoke(h,'learner_paths',{tenantSlug:'marktone',payload:{offset:50,subjectId:commandId,studentId:commandId,role:'manager'}})).status,200);
  assert.deepEqual(h.calls[0],['v1_academy_learner_paths',{p_slug:'marktone',p_offset:50}]);
  assert.equal((await invoke(h,'learner_paths',{tenantSlug:'marktone',payload:{offset:-1}})).status,400);
});
test('course readiness gives precise missing content/policy targets while drafts remain saveable',()=>{
  const doc=authoring.createAuthoringDocument('دورة جديدة');
  assert.ok(authoring.authoringDocument(doc));
  assert.equal(authoring.authoringPublishIssues(doc).length,4);
  doc.policy.termsVersion='v1';doc.policy.supportEmail='help@example.test';
  doc.topics=[{id:'topic',title:'تطبيق',summary:'',units:[{id:'assignment',title:'المهمة',kind:'assignment',body:'نفّذ المطلوب',required:true}]}];
  assert.deepEqual(authoring.authoringPublishIssues(doc),[]);
  doc.topics[0].units[0].body='';assert.equal(authoring.authoringPublishIssues(doc)[0].unitId,'assignment');
});
