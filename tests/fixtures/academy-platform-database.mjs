import {readFile} from 'node:fs/promises';
import {setup,call,id,login,T,ADMIN,ADMIN_AUTH} from './training-journey-database.mjs';
import {setup as governanceSetup} from './operational-governance-database.mjs';
export * from './training-journey-database.mjs';

export const MANAGER=id(8001),MANAGER_AUTH=id(8002),EDITOR=id(8003),EDITOR_AUTH=id(8004),ACADEMY_INSTRUCTOR=id(8005),ACADEMY_INSTRUCTOR_AUTH=id(8006),SITE=id(8007);
export async function academySetup({governance=false,database=null}={}){
 const db=governance?await governanceSetup({database}):await setup({learning:true,database});
 try{
  if(governance)await db.exec(await readFile(new URL('../../supabase/migrations/20260916165601_training_learning_v1.sql',import.meta.url),'utf8'));
  else await db.exec("create table academy.admission_governance_settings(tenant_id uuid,enabled boolean);create function private_app.admission_governance_enabled_v1(p_tenant_id uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from academy.admission_governance_settings where tenant_id=p_tenant_id and enabled) $$;");
  await db.exec("select set_config('fixture.addon','yes',false)");
  // These external seams model only catalogue/module discovery, without creating
  // any Odeir subscription. Authorization/learning functions are real SQL.
  await db.exec(`create schema website; create schema catalog; create schema storage;
   create table core.modules(id uuid primary key,module_key text);
   create table core.tenant_modules(tenant_id uuid,module_id uuid,enabled boolean);
   create table catalog.features(id uuid primary key,feature_key text);
   create table catalog.addon_products(id uuid,feature_id uuid,product_key text,name_ar text,currency text,amount_minor bigint,interval text,pricing_mode text);
   create table website.sites(id uuid primary key,tenant_id uuid,site_scope text,site_key text,status text,settings jsonb,theme jsonb,name_ar text,name_en text,site_slug text,primary_domain text,locale text,cms_version int,addon_status text,updated_at timestamptz,published_at timestamptz,created_at timestamptz);
   create table website.content_documents(id uuid primary key);
   create function storage.foldername(p_name text) returns text[] language sql as $$ select string_to_array(p_name,'/') $$;
   create or replace function private_app.tenant_addon_enabled(t uuid,p text) returns boolean language sql stable as $$
    select t='${T}'::uuid and p in ('addon.training.lms','module.website_cms') and coalesce(current_setting('fixture.addon',true),'yes')='yes' $$;
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/20260922123824_academy_platform_separation.sql',import.meta.url),'utf8'));
  await db.query("insert into access_control.roles(id,role_key,name_ar,scope) values($1,'academy_fixture_admin','Fixture platform administrator','platform')",[id(8010)]);
  await db.query("insert into access_control.memberships(id,subject_id,scope) values($1,$2,'platform')",[id(8011),ADMIN]);
  await db.query('insert into access_control.membership_roles(membership_id,role_id) values($1,$2)',[id(8011),id(8010)]);
  for(const permission of ['platform.control.read','platform.tenants.manage','platform.billing.manage','platform.access.manage']){
   await db.query("insert into access_control.permissions(permission_key,module_key,name_ar) values($1,'platform',$1) on conflict do nothing",[permission]);
   await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2)',[id(8010),permission]);
  }
  for(const [subject,auth,email,name] of [[MANAGER,MANAGER_AUTH,'manager@example.test','Academy manager'],[EDITOR,EDITOR_AUTH,'editor@example.test','Website editor'],[ACADEMY_INSTRUCTOR,ACADEMY_INSTRUCTOR_AUTH,'academy.instructor@example.test','Academy instructor']]){
   await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[auth,email]);
   await db.query('insert into access_control.subjects(id,auth_user_id,email,full_name) values($1,$2,$3,$4)',[subject,auth,email,name]);
  }
  await db.query("insert into website.sites(id,tenant_id,site_scope,site_key,status,addon_status) values($1,$2,'tenant','tenant:marktone','draft','active')",[SITE,T]);
  await login(db,ADMIN_AUTH);
  return db;
 }catch(error){await db.close();delete error.query;throw error;}
}
let command=8200;
export const platformAction=(db,p_action,p_payload,p_command_id=id(command++),p_slug='marktone')=>call(db,'public.v1_platform_academy_action',{p_slug,p_action,p_command_id,p_payload});
export const configure=(db,overrides={})=>platformAction(db,'configure',{expectedVersion:0,enabled:true,mode:'standalone',components:{lms:true,website:true,store:true},accessUntil:null,...overrides});
