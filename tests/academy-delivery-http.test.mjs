import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as requests from '../lib/training-request.mjs';
import * as media from '../lib/academy-media.mjs';
import * as people from '../lib/academy-people.mjs';
import * as delivery from '../lib/academy-delivery.mjs';
import * as commerce from '../lib/academy-commerce-policy.mjs';
import {startAcademyVideoUpload} from '../lib/academy-media-upload.mjs';
const uuid='652bc8b2-ef69-4f21-a4e9-2ce2b49c1269',url='https://fixture.supabase.co',path=`tenant/course/${uuid}.mp4`;
function route(name,handler=async()=>({saved:true}),authenticated=true){
 const calls=[],exports={};
 const source=ts.transpileModule(readFileSync(new URL(`../app/api/${name}/[action]/route.js`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInThisContext(`(function(require,exports){${source}\n})`)(name=>{
  if(name==='node:crypto')return {createHash};
  if(name==='next/headers')return {cookies:async()=>({get:()=>authenticated?{value:'server-only-session'}:undefined})};
  if(name==='next/server')return {NextResponse:Response};
  if(name.endsWith('/config'))return {ACCESS_COOKIE:'session',SUPABASE_URL:url,SUPABASE_KEY:'public-test-key'};
  if(name.endsWith('training-request.mjs'))return requests;
  if(name.endsWith('academy-media.mjs'))return media;
  if(name.endsWith('academy-people.mjs'))return people;
  if(name.endsWith('academy-delivery.mjs'))return delivery;
  if(name.endsWith('academy-commerce-policy.mjs'))return commerce;
  if(name.endsWith('training-server'))return {trainingJson:(body,status=200)=>({body,status}),trainingRpc:async(...args)=>{calls.push(args);return handler(...args);}};
  throw Error(name);
 },exports);return {...exports,calls};
}
const body=payload=>({tenantSlug:'marktone',commandId:uuid,payload});
const post=(r,action,data,origin='https://odeir.com')=>r.POST(new Request(`https://odeir.com/api/test/${action}`,{method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(data)}),{params:{action}});
const get=(r,query='')=>r.GET(new Request(`https://odeir.com/api/academy-media/${uuid}?tenantSlug=marktone${query}`),{params:{action:uuid}});

test('media boundary rejects foreign origin, tenant, malformed file and missing session before storage',async()=>{
 const r=route('academy-media'),payload={courseId:uuid,fileName:'video.mp4',mimeType:'video/mp4',sizeBytes:100};
 assert.equal((await post(r,'create_upload',body(payload),'https://foreign.test')).status,403);
 assert.equal((await post(r,'create_upload',{...body(payload),tenantSlug:'reef-skills'})).status,400);
 assert.equal((await post(r,'create_upload',body({...payload,sizeBytes:media.ACADEMY_MEDIA_MAX_BYTES+1}))).status,413);
 assert.equal((await post(r,'create_upload',body({...payload,fileName:'evil.html'}))).status,415);
 assert.equal((await post(route('academy-media',undefined,false),'create_upload',body(payload))).status,401);
 assert.equal(r.calls.length,0);
});

test('upload signing uses only the server session and returns an object-scoped TUS ticket',async t=>{
 const r=route('academy-media',async()=>({assetId:uuid,objectPath:path,bucket:media.ACADEMY_MEDIA_BUCKET,state:'pending'})),calls=[],original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async(target,options)=>{calls.push({target,options});return Response.json({url:`/object/upload/sign/academy-course-media/${path}?token=scoped-upload-ticket`});};
 const result=await post(r,'create_upload',body({courseId:uuid,fileName:'lesson.mp4',mimeType:'video/mp4',sizeBytes:100,tenantId:'foreign',actorSubjectId:uuid}));
 assert.equal(result.status,200);assert.equal(result.body.token,'scoped-upload-ticket');assert.equal(result.body.endpoint,'https://fixture.storage.supabase.co/storage/v1/upload/resumable');
 assert.equal(calls[0].options.headers.Authorization,'Bearer server-only-session');assert.equal(calls[0].options.redirect,'error');
 assert.ok(!JSON.stringify(result.body).includes('server-only-session'));assert.equal(r.calls[0][1].p_payload.actorSubjectId,undefined);
 globalThis.fetch=async()=>Response.json({url:'https://foreign.test/object/upload/sign/academy-course-media/path?token=bad'});
 assert.equal((await post(r,'create_upload',body({courseId:uuid,fileName:'lesson.mp4',mimeType:'video/mp4',sizeBytes:100}))).status,502);
});

test('private playback authorizes first, bounds URL lifetime, and cannot create a forbidden download',async t=>{
 const asset={bucket:media.ACADEMY_MEDIA_BUCKET,objectPath:path,fileName:'lesson.mp4',allowDownload:false,policyVersion:2};
 const r=route('academy-media',async(_name,args)=>{if(args.p_download)throw requests.trainingProblem('academy_media_download_disabled',403);return asset;});
 const original=globalThis.fetch;let signs=0;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async(_target,options)=>{signs++;assert.deepEqual(JSON.parse(options.body),{expiresIn:300});return Response.json({signedURL:`/object/sign/academy-course-media/${path}?token=read-ticket`});};
 const info=await get(r,'&info=1');assert.equal(info.body.policyVersion,2);assert.equal(signs,0);
 const response=await get(r);assert.equal(response.status,307);assert.match(response.headers.get('Location'),/^https:\/\/fixture.supabase.co\/storage\/v1\/object\/sign/);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
 assert.equal((await get(r,'&download=1')).status,403);assert.equal(signs,1);
});

test('resumable upload isolates fingerprints and ignores a foreign resume URL',async()=>{
 let options,started=0,resumed=null;
 class Upload {constructor(_file,input){options=input;}async findPreviousUploads(){return [{uploadUrl:'https://foreign.test/stolen'},{uploadUrl:'https://fixture.storage.supabase.co/storage/v1/upload/resumable/id'}];}resumeFromPreviousUpload(value){resumed=value;}start(){started++;}}
 const file={size:100,lastModified:42,type:'video/mp4'},ticket={endpoint:'https://fixture.storage.supabase.co/storage/v1/upload/resumable',token:'scoped',bucket:'academy-course-media',objectPath:path};
 const client=await startAcademyVideoUpload({file,ticket,UploadClass:Upload,autoStart:false});assert.equal(started,0);client.start();assert.equal(started,1);
 assert.equal(options.chunkSize,6*1024*1024);assert.equal(options.headers['x-signature'],'scoped');assert.equal(options.headers.Authorization,undefined);assert.equal(options.removeFingerprintOnSuccess,true);
 assert.match(await options.fingerprint(),new RegExp(uuid));assert.match(resumed.uploadUrl,/fixture.storage/);
 let progress;options.onProgress=undefined;
 await startAcademyVideoUpload({file,ticket,UploadClass:Upload,onProgress:value=>progress=value});options.onProgress(50,100);assert.equal(progress,50);
});

test('people invitations hash the bearer token and return the existing acceptance page',async()=>{
 const r=route('academy-people');const token='a'.repeat(64);
 const result=await post(r,'invite_instructor',body({name:'Teacher',email:'Teacher@example.test',phone:'',invitationToken:token,role:'manager',subjectId:uuid}));
 assert.equal(result.status,200);assert.equal(result.body.invitationUrl,`/academy/accept?tenant=marktone#${token}`);
 const sent=r.calls[0][1].p_payload;assert.equal(sent.tokenHash,createHash('sha256').update(token).digest('hex'));assert.equal(sent.invitationToken,undefined);assert.equal(sent.role,undefined);assert.equal(sent.subjectId,undefined);
 const denied=route('academy-people',async()=>{throw requests.trainingProblem('forbidden',403);});assert.equal((await post(denied,'add_student',body({name:'Learner',email:'a@example.test',phone:'0501111111'}))).status,403);
});

test('selling input strips identity overrides and validates exact minor-unit installment totals',async()=>{
 const r=route('academy-delivery');const payload={courseId:uuid,runId:uuid,learningMode:'cohort',expectedVersion:1,netMinor:10000,installmentTerms:[{amountMinor:5000,dueDays:0},{amountMinor:5000,dueDays:30}],published:true};
 assert.equal((await post(r,'save_offer',body(payload))).status,200);assert.equal(r.calls[0][1].p_payload.published,undefined);
 assert.equal((await post(r,'save_offer',body({...payload,netMinor:1.5}))).status,400);
 assert.equal(delivery.installmentIssues(payload.installmentTerms,10000).length,0);assert.equal(delivery.installmentIssues(payload.installmentTerms,11500).length,1);
 assert.equal(delivery.groupCourseOffers([{id:'a',courseId:uuid},{id:'b',courseId:uuid}]).length,1);
 assert.throws(()=>media.academyMediaPayload('set_download',{assetId:uuid,allowDownload:true}));
});
