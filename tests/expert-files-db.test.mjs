import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {database,identity,enable,application,adminCall} from './fixtures/service-hub-db.mjs';
const migration=await readFile(new URL('../supabase/migrations/20260917203359_expert_application_files_v1.sql',import.meta.url),'utf8');
const manifest=[{kind:'cv',name:'cv.pdf',mimeType:'application/pdf',size:50,sha256:'a'.repeat(64)},{kind:'photo',name:'photo.png',mimeType:'image/png',size:60,sha256:'b'.repeat(64)}];
async function fixture(){const db=await database();await db.exec(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated;grant select,insert,update,delete on storage.objects to anon,authenticated;`);try{await db.exec(migration);await enable(db);return db;}catch(error){await db.close();throw error;}}
async function active(db){await db.exec('reset role;update marketplace.service_hub_settings set expert_uploads_enabled=true;set role service_role');}
const reserve=async(db,id,payload=application,files=manifest)=>(await db.query('select public.v1_expert_upload_reserve($1,$2,$3) result',[id,payload,files])).rows[0].result;
async function objects(db,id){await db.exec('reset role');for(const f of manifest)await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',['expert-application-files',`${id}/${f.kind}`,{size:f.size,mimetype:f.mimeType}]);await db.exec('set role service_role');}
const finalize=async(db,id)=>(await db.query('select public.v1_expert_upload_finalize($1) result',[id])).rows[0].result;

test('file registration is gated, service-only, idempotent and atomically owned by the inserted application',async()=>{const db=await fixture();try{
 const id=crypto.randomUUID();await db.exec('set role service_role');await assert.rejects(reserve(db,id),/service_hub_not_enabled/);await active(db);
 assert.deepEqual(await reserve(db,id),{complete:false});await assert.rejects(reserve(db,id,{...application,name:'Changed Name'}),/service_upload_conflict/);
 await assert.rejects(finalize(db,id),/service_upload_incomplete/);await objects(db,id);await finalize(db,id);await finalize(db,id);assert.deepEqual(await reserve(db,id),{complete:true});
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from marketplace.expert_applications')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from marketplace.expert_application_files')).rows[0].n,2);
 const second=crypto.randomUUID();await db.exec('set role service_role');await reserve(db,second);await objects(db,second);await finalize(db,second);await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from marketplace.expert_application_files')).rows[0].n,2);assert.equal((await db.query('select status from marketplace.expert_application_uploads where id=$1',[second])).rows[0].status,'duplicate');
 for(const role of ['anon','authenticated']){await identity(db,{role});await assert.rejects(reserve(db,crypto.randomUUID()),/permission denied/);await assert.rejects(db.query('select * from marketplace.expert_application_files'),/permission denied/);await assert.rejects(db.query('select private_app.create_expert_application_v2($1)',[application]),/permission denied/);}
}finally{await db.close();}});

test('CV remains private, published portraits revoke immediately, and unrelated tenant cannot read',async()=>{const db=await fixture();try{
 await active(db);const id=crypto.randomUUID();await reserve(db,id);await objects(db,id);await finalize(db,id);
 await identity(db,{admin:true});const snapshot=await adminCall(db,'snapshot');const aid=snapshot.applications[0].id;assert.equal(snapshot.applications[0].payload.attachments.length,2);
 assert.equal((await db.query('select public.v1_platform_expert_file($1,$2) f',[aid,'cv'])).rows[0].f.name,'cv.pdf');assert.equal((await db.query('select * from storage.objects')).rows.length,2);
 const {providerId}=await adminCall(db,'approve_application',{id:aid});await db.exec('reset role');await db.query("update marketplace.service_providers set status='active' where id=$1",[providerId]);await identity(db,{admin:true});await adminCall(db,'publish_provider',{providerId,published:true});
 await identity(db,{role:'anon'});assert.equal((await db.query('select public.v1_public_expert_photo($1) f',[providerId])).rows[0].f.path,`${id}/photo`);assert.equal((await db.query('select * from storage.objects')).rows.length,1);
 await identity(db);await assert.rejects(db.query('select public.v1_platform_expert_file($1,$2)',[aid,'cv']),/forbidden/);assert.equal((await db.query('select * from storage.objects where name=$1',[`${id}/cv`])).rows.length,0);await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('expert-application-files','attack')"),/row-level security/);
 await db.exec('reset role');assert.equal((await db.query('select private_app.service_provider_public_payload($1) p',[providerId])).rows[0].p.avatarUrl,`/api/experts/photos/${providerId}`);
 await identity(db,{admin:true});await adminCall(db,'publish_provider',{providerId,published:false});await identity(db,{role:'anon'});assert.equal((await db.query('select public.v1_public_expert_photo($1) f',[providerId])).rows[0].f,null);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
}finally{await db.close();}});

test('expired reservations can be cleaned but completed attachments cannot; quotas bound storage',async()=>{const db=await fixture();try{
 await active(db);const completed=crypto.randomUUID();await reserve(db,completed);await objects(db,completed);await finalize(db,completed);
 const expired=crypto.randomUUID();await reserve(db,expired);await db.exec("reset role;update marketplace.expert_application_uploads set expires_at=now()-interval '1 day';set role service_role");
 const cleanup=(await db.query('select public.v1_expert_upload_cleanup() c')).rows[0].c;assert.deepEqual(cleanup.map(c=>c.id),[expired]);await assert.rejects(finalize(db,expired),/service_upload_expired/);await db.query('select public.v1_expert_upload_cleaned($1)',[expired]);
 for(let i=0;i<18;i++)await reserve(db,crypto.randomUUID());await assert.rejects(reserve(db,crypto.randomUUID()),/rate_limited/);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from marketplace.expert_application_files')).rows[0].n,2);
}finally{await db.close();}});
