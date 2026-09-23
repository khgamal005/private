import {readFile} from 'node:fs/promises';
import {checkoutSetup,call,id,T} from './academy-concurrency-database.mjs';
export * from './academy-concurrency-database.mjs';
const read=name=>readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
let sequence=140000;
export const deliveryCommand=()=>id(sequence++);
export const deliveryAction=(db,p_action,p_payload,p_command_id=deliveryCommand())=>call(db,'public.v1_academy_course_delivery_action',{p_slug:'marktone',p_action,p_command_id,p_payload});
export const mediaAction=(db,p_action,p_payload,p_command_id=deliveryCommand())=>call(db,'public.v1_academy_media_action',{p_slug:'marktone',p_action,p_command_id,p_payload});
export async function deliverySetup({enabled=true,database=null}={}) {
 const db=await checkoutSetup({database});
 let migrationName='storage fixture';
 try {
  // Storage service tables are the external seam. Authorization and object policy
  // functions are the actual migration, using the same verified Auth claims.
  await db.exec(`create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
   alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant insert,select on storage.objects to authenticated;`);
  for(const name of ['20260922192706_academy_course_authoring_v1.sql','20260923090741_academy_connected_delivery_v1.sql','20260923091646_academy_course_commerce_bridge_v1.sql','20260923092103_academy_people_management_v1.sql']) {
   migrationName=name;await db.exec(await read(name));
  }
  if(enabled) await db.query('insert into academy.delivery_settings(tenant_id,enabled) values($1,true)',[T]);
  return db;
 }catch(error){await db.close();error.message=`${migrationName}: ${error.message}`;delete error.query;throw error;}
}
