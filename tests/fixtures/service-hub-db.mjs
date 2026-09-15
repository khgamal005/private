// Schema-only capture from ODEIR on 2026-09-15; no tenant/customer data.
// Existing authorization and provider eligibility are replaced with explicit fixture identities.
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

export const TENANT='10000000-0000-4000-8000-000000000001';
export const OTHER='10000000-0000-4000-8000-000000000002';
export const ACTOR='20000000-0000-4000-8000-000000000001';
const source=path=>readFile(new URL(path,import.meta.url),'utf8');
export async function identity(db,{admin=false,tenant=TENANT,role='authenticated'}={}){
  await db.exec('reset role');
  await db.query("select set_config('fixture.admin',$1,false),set_config('fixture.tenant',$2,false)",[String(admin),tenant]);
  await db.exec(`set role ${role==='anon'?'anon':role==='postgres'?'postgres':'authenticated'}`);
}
export async function database(){
  const db=new PGlite();
  try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema marketplace;create schema core;create schema access_control;create schema private_app;create schema audit_log;
    create sequence marketplace.order_number_seq;
    grant usage on schema public,marketplace,private_app to anon,authenticated,service_role;
    create table core.tenants(id uuid primary key,slug text unique,name text);
    create table access_control.subjects(id uuid primary key);
    insert into core.tenants values('${TENANT}','hub-fixture','Fixture A'),('${OTHER}','other-fixture','Fixture B');
    insert into access_control.subjects values('${ACTOR}');
    create function private_app.current_subject_id() returns uuid language sql stable as $$select '${ACTOR}'::uuid$$;
    create function private_app.has_tenant_permission(tid uuid,permission text) returns boolean language sql stable as $$select current_setting('fixture.tenant',true)=tid::text and coalesce(current_setting('fixture.deny',true),'')<>'true'$$;
    create function private_app.has_platform_permission(permission text) returns boolean language sql stable as $$select current_setting('fixture.admin',true)='true'$$;
    create function private_app.paymob_tenant_checkout_eligible_v1(tid uuid,environment text) returns boolean language sql stable as $$select coalesce(current_setting('fixture.payment_disabled',true),'')<>'true'$$;
    create function private_app.tamara_eligible_v1(tid uuid) returns boolean language sql stable as $$select coalesce(current_setting('fixture.payment_disabled',true),'')<>'true'$$;
    create function private_app.jsonb_has_sensitive_key(value jsonb) returns boolean language sql immutable as $$select false$$;
    create function private_app.paymob_readiness_evidence_safe_v1(value jsonb) returns boolean language sql immutable as $$select true$$;
  `);
  const tables=JSON.parse(await source('./service-hub-schema.json'));
  for(const table of tables){
    const columns=table.columns.map(c=>`"${c.name}" ${c.type}${c.default?' default '+c.default:''}${c.notnull?' not null':''}`);
    await db.exec(`create table ${table.schema}.${table.name}(${[...columns,...(table.constraints||[])].join(',')});`);
  }
  const professional=await source('../../supabase/migrations/20260826235130_service_marketplace_professional_v1.sql');
  const publicProvider=professional.slice(professional.indexOf('create or replace function private_app.service_provider_public_payload'),professional.indexOf('create or replace function public.v1_platform_service_marketplace_snapshot'));
  await db.exec(publicProvider);
  await db.exec(`create function private_app.marketplace_order_payload(oid uuid) returns jsonb language sql stable as $$select jsonb_build_object('id',id,'orderNumber',order_number,'paymentProvider',payment_provider,'totalMinor',total_minor,'status',status,'items',(select jsonb_agg(jsonb_build_object('metadata',i.metadata)) from marketplace.order_items i where i.order_id=o.id)) from marketplace.orders o where id=oid$$;`);
  await db.exec(await source('./service-hub-existing-payment.sql'));
  await db.exec(await source('../../supabase/migrations/20260915200707_service_hub_quotes_and_expert_applications_v1.sql'));
  await db.query("insert into marketplace.payment_provider_configs(provider_key,name_ar,status,last_verified_at,supported_currencies) values('bank_transfer','Fixture Bank','active',now(),array['SAR']),('paymob','Fixture Paymob','active',now(),array['SAR']),('tamara','Fixture Tamara','active',now(),array['SAR'])");
  await db.exec(await source('./paymob-order-guard.sql'));
  return db;
  }catch(error){await db.close();throw error;}
}
export const tenantCall=async(db,action,payload={},slug='hub-fixture')=>(await db.query('select public.v1_tenant_service_hub_action($1,$2,$3) data',[slug,action,payload])).rows[0].data;
export const adminCall=async(db,action,payload={})=>(await db.query('select public.v1_platform_service_hub_action($1,$2) data',[action,payload])).rows[0].data;
export const application={name:'محاضر للاختبار',type:'lecturer',title:'محاضر إدارة المشروعات',email:'expert@example.test',phone:'+966500000001',bio:'خبرة اختبارية في إدارة المشروعات وتصميم وتقديم البرامج التدريبية للمنشآت.',city:'الرياض',expertise:'إدارة المشروعات، القيادة',languages:'العربية، الإنجليزية',yearsExperience:12,portfolioUrl:'https://example.test/portfolio',consent:true};
export async function enable(db){await db.exec('reset role;update marketplace.service_hub_settings set enabled=true');}
export async function publishedExpert(db){
  await enable(db);await identity(db,{role:'anon'});
  await db.query('select public.v1_public_expert_application($1)',[application]);
  await identity(db,{admin:true});const snap=await adminCall(db,'snapshot');
  const result=await adminCall(db,'approve_application',{id:snap.applications[0].id});
  await db.exec('reset role');await db.query("update marketplace.service_providers set status='active' where id=$1",[result.providerId]);
  await identity(db,{admin:true});await adminCall(db,'publish_provider',{providerId:result.providerId,published:true});
  return result.providerId;
}
export async function quote(db,{paymentProvider='bank_transfer'}={}){
  const providerId=await publishedExpert(db);
  await db.exec('reset role');
  const cat=(await db.query("insert into marketplace.service_categories(category_key,name_ar,status) values('fixture','Fixture','active') returning id")).rows[0].id;
  const productId=(await db.query("insert into marketplace.service_products(category_id,product_key,name_ar,description_ar,unit_label_ar,provider_id,status,pricing_mode,amount_minor,marketplace_visible) values($1,'fixture_service','Fixture service','Synthetic workshop for testing','خدمة',$2,'active','quote',100,true) returning id",[cat,providerId])).rows[0].id;
  await identity(db);
  const request=await tenantCall(db,'request',{requestKey:crypto.randomUUID(),title:'برنامج للمنشأة',details:'تدريب عملي على إدارة المشروعات للفريق',deliveryMode:'online',providerId});
  await identity(db,{admin:true});
  const offer={id:request.id,version:request.version,providerId,productId,title:'عرض برنامج تدريب',scope:'تنفيذ ورشة تدريب مع المادة العلمية والتقييم',delivery:'بعد خمسة أيام من تأكيد الموعد',revisions:'مراجعة واحدة',amountMinor:10000,expiresAt:new Date(Date.now()+86400000).toISOString()};
  const offered=await adminCall(db,'offer',offer);await identity(db);
  return {request:offered,offer,providerId,productId,payload:{id:offered.id,version:offered.version,paymentProvider}};
}
