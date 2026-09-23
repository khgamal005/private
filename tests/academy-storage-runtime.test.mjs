import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {storageTestConfiguration,storageTestJwt} from './fixtures/academy-storage-runtime.mjs';
import {applyDeliveryMigrations,mediaAction,checkoutOffer,login,MANAGER_AUTH} from './fixtures/academy-delivery-database.mjs';
import {EDITOR_AUTH} from './fixtures/academy-platform-database.mjs';
import {startAcademyVideoUpload} from '../lib/academy-media-upload.mjs';

test('real Storage acceptance refuses non-loopback and shared database targets',()=>{
 const base={ACADEMY_STORAGE_TEST_DATABASE_URL:'postgres://fixture:fixture@127.0.0.1:5432/academy_storage',ACADEMY_STORAGE_TEST_URL:'http://127.0.0.1:5050/'};
 assert.equal(storageTestConfiguration(base).endpoint,'http://127.0.0.1:5050');
 for(const bad of ['postgres://fixture:fixture@prod.example/academy_storage','postgres://fixture:fixture@127.0.0.1/postgres','postgres://fixture:fixture@127.0.0.1/academy_storage?host=remote'])assert.throws(()=>storageTestConfiguration({...base,ACADEMY_STORAGE_TEST_DATABASE_URL:bad}));
 assert.throws(()=>storageTestConfiguration({...base,ACADEMY_STORAGE_TEST_URL:'https://example.supabase.co'}));
});

test('real Storage uploads a 64 MiB MP4 with pause/resume and enforces private object access',{
 skip:!process.env.ACADEMY_STORAGE_TEST_DATABASE_URL&&'Requires isolated real Storage CI service',timeout:180000,
},async t=>{
 const {endpoint,databaseUrl}=storageTestConfiguration();const {Client}=await import('pg');
 const client=new Client({connectionString:databaseUrl});await client.connect();t.after(()=>client.end());
 const db={query:(...args)=>client.query(...args),exec:sql=>client.query(sql),close:async()=>{}};
 const jwt=storageTestJwt('authenticated',MANAGER_AUTH),headers={Authorization:`Bearer ${jwt}`,'Content-Type':'application/json'};
 let ready=false;
 for(let i=0;i<45;i++){try{const health=await fetch(`${endpoint}/status`,{signal:AbortSignal.timeout(1000)});if(health.ok){ready=true;break;}}catch{}await delay(1000);}
 assert.ok(ready,'Storage service must start');
 // Listing buckets causes the pinned service to install its own full schema.
 const initialized=await fetch(`${endpoint}/bucket`,{headers:{Authorization:`Bearer ${storageTestJwt('service_role')}`}});
 assert.equal(initialized.status,200,await initialized.text());
 await applyDeliveryMigrations(db,{externalStorage:true});await login(db,MANAGER_AUTH);
 const offer=await checkoutOffer(db);
 const folder=await mkdtemp(join(tmpdir(),'academy-storage-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const mp4=join(folder,'lesson.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=navy:s=320x180:r=24','-t','1','-c:v','mpeg4','-movflags','+faststart','-y',mp4]);
 const original=await readFile(mp4),padding=Buffer.alloc(64*1024*1024-original.length);padding.writeUInt32BE(padding.length);padding.write('free',4,'ascii');
 const file=Buffer.concat([original,padding]);Object.assign(file,{type:'video/mp4',size:file.length,lastModified:1});
 await writeFile(mp4,file);execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name','-of','csv=p=0',mp4]);
 const ticket=await mediaAction(db,'create_upload',{courseId:offer.courseId,fileName:'lesson.mp4',mimeType:file.type,sizeBytes:file.length});
 const object=`academy-course-media/${ticket.objectPath}`;
 const signedResponse=await fetch(`${endpoint}/object/upload/sign/${object}`,{method:'POST',headers,body:'{}'});
 assert.equal(signedResponse.status,200,await signedResponse.clone().text());
 const signed=await signedResponse.json(),token=new URL(signed.url,endpoint).searchParams.get('token');assert.ok(token);
 let paused=false,upload;
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Real resumable upload timed out')),90000);
  const success=()=>{clearTimeout(timeout);resolve();},failure=error=>{clearTimeout(timeout);reject(error);};
  startAcademyVideoUpload({file,ticket:{...ticket,endpoint:`${endpoint}/upload/resumable`,token},autoStart:false,onSuccess:success,onError:failure,onProgress:percent=>{
   if(!paused&&percent>=10&&percent<90){paused=true;void upload.abort(false).then(()=>upload.start()).catch(failure);}
  }}).then(value=>{upload=value;upload.start();}).catch(failure);
 });
 assert.equal(paused,true,'A partial upload was paused and resumed');
 const stored=(await db.query('select metadata from storage.objects where bucket_id=$1 and name=$2',['academy-course-media',ticket.objectPath])).rows[0].metadata;
 assert.equal(Number(stored.size),file.length);assert.equal(stored.mimetype,'video/mp4');assert.equal(stored.cacheControl,'max-age=0');
 const finalized=await mediaAction(db,'complete_upload',{assetId:ticket.assetId});assert.equal(finalized.state,'ready');assert.equal(finalized.allowDownload,false);
 const readResponse=await fetch(`${endpoint}/object/sign/${object}`,{method:'POST',headers,body:JSON.stringify({expiresIn:5})});
 assert.equal(readResponse.status,200,await readResponse.clone().text());const read=await readResponse.json();const url=new URL(read.signedURL,endpoint);
 const full=await fetch(url);assert.equal(full.status,200);assert.match(full.headers.get('cache-control'),/max-age=0|no-cache/);
 const downloaded=Buffer.from(await full.arrayBuffer());assert.equal(createHash('sha256').update(downloaded).digest('hex'),createHash('sha256').update(file).digest('hex'));
 const ranged=await fetch(url,{headers:{Range:'bytes=0-1023'}});assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,1024);
 const denied=await fetch(`${endpoint}/object/sign/${object}`,{method:'POST',headers:{...headers,Authorization:`Bearer ${storageTestJwt('authenticated',EDITOR_AUTH)}`},body:JSON.stringify({expiresIn:300})});assert.ok(denied.status>=400);
 const overwrite=await fetch(`${endpoint}/object/upload/sign/${object}`,{method:'POST',headers,body:'{}'});assert.ok(overwrite.status>=400,'Ready assets cannot acquire another upload ticket');
 await delay(6100);const expired=await fetch(url);assert.ok(expired.status>=400,'Expired signed tokens cannot authorize the origin read');
 console.log('Verified 64 MiB MP4, actual TUS pause/resume, metadata finalization, exact bytes, range playback, private RLS, immutable object and signed-token expiry.');
});
