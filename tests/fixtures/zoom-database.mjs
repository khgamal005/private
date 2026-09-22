import {readFile} from 'node:fs/promises';
import {login,T,OTHER,ADMIN,ADMIN_AUTH,call,id} from './training-journey-database.mjs';
import {academySetup} from './academy-platform-database.mjs';
export * from './training-journey-database.mjs';
export const zoomMigration='20260922201432_zoom_accounts_resources_v1.sql';
export const migration=name=>readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
export async function zoomSetup({database=null,scheduling=false,evidence=false,recordings=false,bridges=false,lifecycle=false,recovery=false,advanced=false,webinars=false,complete=false}={}){
 if(complete)webinars=true;
 const db=await academySetup({governance:true,database});
 try{
  // Vault encryption is a platform seam. This fixture is deliberately plaintext
  // ONLY inside the disposable database, never a production replacement.
  await db.exec(`create schema vault; create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text,name text);
   create view vault.decrypted_secrets as select id,secret as decrypted_secret from vault.secrets;
   create function vault.create_secret(secret text,name text,description text,key_id uuid) returns uuid language sql as $$ insert into vault.secrets(secret,name) values($1,$2) returning id $$;
   create function vault.update_secret(id uuid,secret text,name text,description text) returns void language sql as $$ update vault.secrets set secret=$2 where id=$1 $$;
   create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('fixture.auth_user_id',true),''))::uuid $$;
   create or replace function private_app.tenant_addon_enabled(t uuid,p text) returns boolean language sql stable as $$ select p in ('addon.integration.zoom','addon.training.lms') and t in ('${T}'::uuid,'${OTHER}'::uuid) and coalesce(current_setting('fixture.zoom_addon',true),'yes')='yes' $$;
  `);
  const communication=await migration('20260728014500_training_communications_zoom_automation_v2.sql');
  const phoneStart=communication.indexOf('create or replace function private_app.normalize_training_phone');
  await db.exec(communication.slice(phoneStart,communication.indexOf('$$;',phoneStart)+3));
  await db.exec(await migration(zoomMigration));
  if(scheduling||evidence||recordings||bridges||lifecycle||recovery||advanced||webinars)await db.exec(await migration('20260922202109_zoom_scheduling_operations_v1.sql'));
  if(evidence||recordings||bridges||lifecycle||recovery||advanced||webinars)await db.exec(await migration('20260922202705_zoom_evidence_access_v1.sql'));
  if(recordings||bridges||lifecycle||recovery||advanced||webinars)await db.exec(await migration('20260922203333_zoom_recordings_reports_v1.sql'));
  if(bridges||lifecycle||recovery||advanced||webinars)await db.exec(await migration('20260922203937_zoom_provider_bridges_v1.sql'));
  if(lifecycle||recovery||advanced||webinars)await db.exec(await migration('20260922205518_zoom_lifecycle_communications_v1.sql'));
  if(recovery||advanced||webinars)await db.exec(await migration('20260922210150_zoom_recovery_retention_v1.sql'));
  if(advanced||webinars){
   // Use the canonical Odeiry table DDL; provider/runtime RPCs are exercised by
   // the repository's own Odeiry suite and injectable generation contracts.
   const ai=await migration('20260830030000_odeiry_ai_foundation_v1.sql');
   await db.exec('create schema if not exists platform;');
   await db.exec(ai.slice(ai.indexOf('create table platform.odeiry_runtime_settings'),ai.indexOf('create table platform.odeiry_knowledge_articles')));
   await db.exec("alter table academy.courses add column if not exists program_kind text check(program_kind in ('short_course','diploma'))");
   await db.exec(await migration('20260922192706_academy_course_authoring_v1.sql'));
   await db.exec(await migration('20260922210714_zoom_advanced_learning_v1.sql'));
  }
  if(webinars){
   async function fn(file,name){const source=await migration(file);const start=source.search(new RegExp('create (?:or replace )?function '+name.replaceAll('.','\\.')));if(start<0)throw Error(name);return source.slice(start,source.indexOf('$$;',start)+3).replace(/^create function/,'create or replace function');}
   const crm='20260727192319_add_operational_crm_and_work_v2.sql',identity='20260806190000_customer_identity_integrity_v1.sql';
   await db.exec(await fn(crm,'private_app.can_view_tenant_team'));
   for(const name of ['normalize_lead_phone','find_contact_by_identity','prepare_contact_identity_fields','sync_contact_identities'])await db.exec(await fn(identity,'private_app.'+name));
   await db.exec((await fn(crm,'public.v2_tenant_create_contact')).replace('public.v2_tenant_create_contact(','public.v2_tenant_create_contact_unhardened_20260806('));
   await db.exec(await fn('20260806190100_customer_identity_entrypoint_guards_v1.sql','public.v2_tenant_create_contact'));
   await db.exec(await fn('20260910143003_sales_followup_multiple_interests_v1.sql','private_app.sales_followup_contact'));
   await db.exec('create trigger zoom_fixture_contacts_prepare before insert or update of phone,whatsapp,email on sales_core.contacts for each row execute function private_app.prepare_contact_identity_fields();create trigger zoom_fixture_contacts_sync after insert or update of tenant_id,phone,whatsapp,email on sales_core.contacts for each row execute function private_app.sync_contact_identities();');
   await db.exec('create schema marketing_hub;create table marketing_hub.campaigns(id uuid primary key,tenant_id uuid not null references core.tenants(id),name text);');
   await db.exec(await migration('20260922211521_zoom_webinar_crm_v1.sql'));
  }
  if(complete){await db.exec(await migration('20260922213755_zoom_operational_completion_v1.sql'));await db.exec(await migration('20260922215415_zoom_account_replacement_v1.sql'));}
  await db.query("insert into zoom_core.settings(tenant_id,enabled,environment) values($1,true,'test'),($2,true,'test')",[T,OTHER]);
  await login(db,ADMIN_AUTH);return db;
 }catch(error){await db.close();delete error.query;throw error;}
}
export const service=(db,on=true)=>db.query("select set_config('request.jwt.claim.role',$1,false)",[on?'service_role':'authenticated']);
export async function connect(db,{account='account-A',user='host-A',mode='add',connectionId=null,state='a'.repeat(64)}={}){
 await service(db,false);await login(db,ADMIN_AUTH);
 await call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:mode,p_state_hash:state,p_connection_id:connectionId});
 const attempt=await call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:'claim',p_state_hash:state});
 await service(db);
 return call(db,'public.v1_zoom_finish_oauth',{p_attempt_id:attempt.attemptId,p_identity:{account_id:account,id:user,display_name:'Synthetic Zoom'},p_tokens:{access_token:'test-access',refresh_token:'test-refresh',expires_in:3600,scope:'meeting:write:meeting:admin'}});
}
export const hostFixture=(account,user)=>({account_id:account,id:user,display_name:'Synthetic host',status:'active',type:2,capacity:100,capabilities:{meeting:true,registration:true}});
export async function syncHost(db,connectionId,account='account-A',user='host-A'){
 await service(db);const c=(await db.query('select generation from zoom_core.connections where id=$1',[connectionId])).rows[0];
 return call(db,'public.v1_zoom_sync_hosts',{p_connection_id:connectionId,p_generation:c.generation,p_hosts:[hostFixture(account,user)],p_coverage:'complete'});
}
export {T,OTHER,ADMIN,ADMIN_AUTH,call,id};
