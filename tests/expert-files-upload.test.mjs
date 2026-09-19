import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {parseExpertMultipart,validateChoices,CV_MAX,PHOTO_MAX,BODY_MAX,boundedBytes,validSignature} from '../supabase/functions/_shared/expert-files.mjs';
import {createHandler} from '../supabase/functions/expert-application-upload/handler.mjs';
import {application} from './fixtures/service-hub-db.mjs';
import {safeExpertImage} from '../lib/service-hub.mjs';
const payload={...application,expertise:'إدارة المشروعات، القيادة والإدارة'};
const pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic fixture\n%%EOF');
const image=await sharp({create:{width:2,height:2,channels:3,background:'#246'}}).png().toBuffer();
const make=(options={})=>{
 const form=new FormData();form.set('payload',JSON.stringify(options.payload||payload));form.set('requestKey',options.key||crypto.randomUUID());
 form.set('cv',new Blob([options.bytes||pdf],{type:options.type||'application/pdf'}),options.name||'cv.pdf');
 if(options.photo)form.set('photo',new Blob([image],{type:'image/png'}),'me.png');
 return new Request('https://edge.test',{method:'POST',headers:{apikey:'public-test'},body:form});
};
test('multipart validates choices, actual signatures, file limits and duplicate keys',async()=>{
 const parsed=await parseExpertMultipart(make({photo:true}));assert.equal(parsed.files.length,2);assert.equal(parsed.files[0].sha256.length,64);assert.equal(parsed.payload.email,payload.email);
 for(const options of [{bytes:new TextEncoder().encode('<html>not pdf</html>')},{type:'text/html',name:'cv.html'},{payload:{...payload,languages:'not-a-language'}},{bytes:new Uint8Array(CV_MAX+1)}])await assert.rejects(parseExpertMultipart(make(options)));
 const request=make();const form=await request.formData();form.append('cv',new Blob([pdf],{type:'application/pdf'}),'second.pdf');await assert.rejects(parseExpertMultipart(new Request('https://edge.test',{method:'POST',body:form})),/غير صالحة/);
 assert.throws(()=>validateChoices({...payload,languages:'العربية، العربية'}));assert.throws(()=>validateChoices({...payload,expertise:''}));
 assert.equal(validSignature(image,'image/png'),true);assert.equal(validSignature(image,'image/webp'),false);
 await assert.rejects(boundedBytes(new Response(new Uint8Array(BODY_MAX+1))),e=>e.status===413);assert.ok(PHOTO_MAX<CV_MAX);
});
test('portrait URLs accept only canonical local photo routes or HTTPS',()=>{
 assert.equal(safeExpertImage('/api/experts/photos/10000000-0000-4000-8000-000000000001'),'/api/experts/photos/10000000-0000-4000-8000-000000000001');
 for(const path of ['/api/platform/expert-files/secret/cv','//evil.test','javascript:alert(1)','/api/experts/photos/../../secret'])assert.equal(safeExpertImage(path),'');
});
test('upload resumes after ambiguous finalize without deleting or replacing committed bytes',async()=>{
 const calls=[],stored=new Map(),key=crypto.randomUUID();let failed=false,complete=false;
 const handler=createHandler({url:'https://db.test',secret:'private-test',publicKeys:['public-test'],defer:()=>{},fetcher:async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('v1_expert_upload_reserve'))return Response.json({complete});
  if(url.endsWith('v1_expert_upload_finalize')){if(!failed){failed=true;throw Error('network lost');}complete=true;return Response.json({received:true});}
  if(url.endsWith('v1_expert_upload_cleanup'))return Response.json([]);
  if(init.method==='POST'){if(stored.has(url))return Response.json({error:'Duplicate'},{status:400});stored.set(url,init.body);return Response.json({Key:'stored'});}
  if(url.includes('/authenticated/'))return new Response(stored.get(url.replace('/authenticated','')));
  throw Error('Unexpected call');
 }});
 assert.equal((await handler(make({key,photo:true}))).status,503);assert.equal(stored.size,2);
 assert.equal((await handler(make({key,photo:true}))).status,200);assert.equal(stored.size,2);
 const before=calls.length;assert.equal((await handler(make({key,photo:true}))).status,200);assert.equal(calls.length,before+1);
 assert.equal(calls.some(c=>c.init.method==='DELETE'),false);assert.ok(calls.filter(c=>c.url.includes('/object/')&&c.init.method==='POST').every(c=>c.init.headers['x-upsert']==='false'));
});
test('invalid API keys, files and rate limits cannot write objects; backend details remain private',async()=>{
 const calls=[];const handler=createHandler({url:'https://db.test',secret:'private-test',publicKeys:['public-test'],fetcher:async(url)=>{calls.push(url);return Response.json({message:'service_application_rate_limited',details:'private-test'},{status:400});}});
 const denied=make();denied.headers.set('apikey','wrong');assert.equal((await handler(denied)).status,401);assert.equal(calls.length,0);
 assert.equal((await handler(make({bytes:new Uint8Array([1])}))).status,415);assert.equal(calls.length,0);
 const limited=await handler(make());assert.equal(limited.status,429);assert.equal(calls.length,1);assert.ok(!(await limited.text()).includes('private-test'));
});
test('retry detects stored bytes that differ and never finalizes the reservation',async()=>{
 const calls=[];const handler=createHandler({url:'https://db.test',secret:'private-test',publicKeys:['public-test'],fetcher:async(url,init)=>{
  calls.push(url);if(url.endsWith('reserve'))return Response.json({complete:false});if(init.method==='POST')return Response.json({error:'Duplicate'},{status:409});return new Response('other bytes');
 }});assert.equal((await handler(make())).status,409);assert.equal(calls.some(c=>c.endsWith('finalize')),false);
});


test('modern secret keys use apikey only while legacy JWT keys retain bearer authentication',async()=>{
 for(const secret of ['sb_secret_fixture','legacy-jwt-fixture']){
  let headers;const handler=createHandler({url:'https://db.test',secret,publicKeys:['public-test'],fetcher:async(_url,init)=>{headers=init.headers;return Response.json({complete:true});}});
  assert.equal((await handler(make())).status,200);assert.equal(headers.apikey,secret);assert.equal(headers.Authorization,secret.startsWith('sb_secret_')?undefined:`Bearer ${secret}`);
 }
});
