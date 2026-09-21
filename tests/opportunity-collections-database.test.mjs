import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const T='10000000-0000-4000-8000-000000000001',OTHER='10000000-0000-4000-8000-000000000002';
const id=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const attribution=(source,campaignName)=>({version:1,origin:'documented_sale_source',source,campaignName});
async function setup(){
 const db=new PGlite();
 await db.exec(await readFile(new URL('./fixtures/campaign-revenue-schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20260906204652_unified_campaign_revenue_v1.sql',import.meta.url),'utf8'));
 await db.exec(`alter table sales_core.opportunities add column owner_staff_id uuid,add column course_id uuid;
  create table private_app.fixture_cash(tenant_id uuid,event_key text,contact_id uuid,opportunity_id uuid,occurred_at timestamptz,amount_minor bigint,currency text,kind text,handoff_id uuid);
  create or replace function private_app.campaign_cash_v1(p_tenant uuid)
  returns table(event_key text,contact_id uuid,opportunity_id uuid,occurred_at timestamptz,amount_minor bigint,currency text,kind text,handoff_id uuid)
  language sql stable set search_path='' as $$select event_key,contact_id,opportunity_id,occurred_at,amount_minor,currency,kind,handoff_id from private_app.fixture_cash where tenant_id=p_tenant$$;`);
 const migration=await readFile(new URL('../supabase/migrations/20260921125610_financial_governance_v1.sql',import.meta.url),'utf8');
 const sql=migration.match(/create or replace function public\.v1_tenant_opportunity_collections[\s\S]*?grant execute on function public\.v1_tenant_opportunity_collections\(text,date,date,uuid,uuid,text\) to authenticated;/)?.[0];
 assert.ok(sql,'opportunity collection RPC must ship in financial governance migration');
 await db.exec(sql);
 const originGuard=migration.match(/alter function private_app\.campaign_cash_origin_v1\(uuid,uuid,uuid\) rename to campaign_cash_origin_before_sale_governance_v1;[\s\S]*?private_app\.campaign_cash_origin_before_sale_governance_v1\(uuid,uuid,uuid\) from public,anon,authenticated,service_role;/)?.[0];
 assert.ok(originGuard,'governed opportunity source must not fall back to acquisition');
 await db.exec(originGuard);
 await db.query("select set_config('fixture.tenant',$1,false)",[T]);
 await db.query("insert into core.tenants(id,slug) values($1,'fixture'),($2,'other')",[T,OTHER]);
 return db;
}
const report=async(db,args={})=>(await db.query("select public.v1_tenant_opportunity_collections('fixture',$1,$2,$3,$4,$5) data",[
 args.from||'2026-09-01',args.to||'2026-09-02',args.staff||null,args.course||null,args.search||null])).rows[0].data;
async function cash(db,{key,opportunity,amount=10000,currency='SAR',at='2026-09-01T08:00:00Z',tenant=T,kind='collection'}){
 await db.query('insert into private_app.fixture_cash values($1,$2,$3,$4,$5,$6,$7,$8,null)',[tenant,key,id(1),opportunity||null,at,amount,currency,kind]);
}

test('opportunity collections use sale evidence, protected finance access and cash dates',async t=>{
 const db=await setup();
 try{
  await t.test('requires campaign permission, addon, rollout and accounting report access',async()=>{
   await assert.rejects(report(db),/campaign_report_not_enabled/);
   await db.query('insert into marketing_hub.campaign_report_rollouts values($1,true)',[T]);
   for(const setting of ['fixture.finance','fixture.addon']){
    await db.query('select set_config($1,$2,false)',[setting,'no']);
    await assert.rejects(report(db),setting==='fixture.finance'?/forbidden/:/addon_not_enabled/);
    await db.query('select set_config($1,$2,false)',[setting,'yes']);
   }
   await db.query("select set_config('fixture.deny','tenant.reports.campaigns',false)");
   await assert.rejects(report(db),/forbidden/);
   await db.query("select set_config('fixture.deny','',false)");
   for(const role of ['anon','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.v1_tenant_opportunity_collections(text,date,date,uuid,uuid,text)','EXECUTE') ok",[role])).rows[0].ok,false);
   assert.equal((await db.query("select has_function_privilege('authenticated','public.v1_tenant_opportunity_collections(text,date,date,uuid,uuid,text)','EXECUTE') ok")).rows[0].ok,true);
   await assert.rejects(report(db,{from:'2024-01-01',to:'2025-01-01'}),/campaign_report_filter_invalid/);
  });
  await t.test('repeat sales have their own source and unknown never inherits contact acquisition',async()=>{
   await db.query("insert into sales_core.contacts(id,tenant_id,source,campaign_name) values($1,$2,'meta','Original acquisition')",[id(1),T]);
   await db.query('insert into sales_core.opportunities(id,tenant_id,contact_id,owner_staff_id,course_id,metadata) values($1,$2,$3,$4,$5,$6),($7,$2,$3,$8,$9,$10)',[
    id(10),T,id(1),id(30),id(40),{attribution:attribution('google','Repeat course')},id(11),id(31),id(41),{attribution:{version:1,origin:'unattributed'}}]);
   await cash(db,{key:'handoff:'+id(50),opportunity:id(10)});
   await cash(db,{key:'handoff:'+id(51),opportunity:id(11),amount:20000});
   await cash(db,{key:'payment:'+id(52),amount:5000,currency:'EGP'});
   await cash(db,{key:'other:'+id(50),opportunity:id(10),amount:999999,tenant:OTHER});
   const result=await report(db);
   assert.equal(result.opportunities,2);assert.equal(result.unlinkedEvents,1);assert.equal(result.groups.length,2);
   assert.equal(result.groups.find(g=>g.documented).campaignName,'Repeat course');
   assert.equal(result.groups.find(g=>!g.documented).source,null);
   assert.deepEqual(result.totals.map(m=>[m.currency,m.netMinor]),[['EGP',5000],['SAR',30000]]);
   assert.equal(result.roas,null);assert.equal(result.leads,undefined);
   assert.doesNotMatch(JSON.stringify(result),/Original acquisition/);
  });
  await t.test('payment snapshot survives source edits and refund uses same source; allocation to another sale uses its source',async()=>{
   await db.query('insert into accounting_core.payments(id,tenant_id,metadata) values($1,$2,$3)',[id(60),T,{opportunityId:id(10),attribution:attribution('google','Snapshot campaign')}]);
   await db.query("insert into accounting_core.refunds(id,tenant_id,payment_id,status,completed_at,amount_minor) values($1,$2,$3,'completed','2026-09-02T08:00:00Z',3000)",[id(61),T,id(60)]);
   await cash(db,{key:'payment:'+id(60)+':allocation:'+id(62),opportunity:id(10),amount:8000});
   await cash(db,{key:'refund:'+id(61),opportunity:id(10),amount:-3000,kind:'refund'});
   await cash(db,{key:'payment:'+id(60)+':allocation:'+id(63),opportunity:id(11),amount:4000});
   const result=await report(db,{search:'Snapshot'});
   assert.equal(result.groups.length,1);assert.equal(result.groups[0].opportunities,1);
   assert.deepEqual(result.totals,[{currency:'SAR',grossMinor:8000,refundMinor:3000,netMinor:5000}]);
   assert.equal((await report(db)).groups.find(g=>!g.documented).money.find(m=>m.currency==='SAR').netMinor,24000);
   const filtered=await report(db,{staff:id(30),course:id(40)});
   assert.equal(filtered.opportunities,1);assert.equal(filtered.unlinkedEvents,0);assert.equal(filtered.totals[0].netMinor,15000);
  });
  await t.test('acquisition origin keeps legacy linkage and excludes governed sale attribution',async()=>{
   await db.query("insert into sales_core.contacts(id,tenant_id,source,campaign_name) values($1,$2,'meta','Legacy acquisition')",[id(80),T]);
   await db.query("insert into sales_core.opportunities(id,tenant_id,contact_id,created_at) values($1,$2,$3,'2026-08-01')",[id(81),T,id(80)]);
   const origin=async()=>(await db.query('select private_app.campaign_cash_origin_v1($1,$2,$3) origin',[T,id(80),id(81)])).rows[0].origin;
   assert.equal(await origin(),'contact:'+id(80));
   await db.query("update sales_core.opportunities set metadata=$1 where id=$2",[{attribution:{origin:'unattributed',version:1}},id(81)]);
   assert.equal(await origin(),null);
   await db.query("update sales_core.opportunities set metadata=$1 where id=$2",[{attribution:attribution('google','New source')},id(81)]);
   assert.equal(await origin(),null);
   for(const fn of ['campaign_cash_origin_v1','campaign_cash_origin_before_sale_governance_v1'])assert.equal((await db.query(`select has_function_privilege('authenticated','private_app.${fn}(uuid,uuid,uuid)','EXECUTE') ok`)).rows[0].ok,false);
  });
  await t.test('uses inclusive tenant-local dates and guards tenant scope',async()=>{
   await db.query('insert into sales_core.opportunities(id,tenant_id,metadata) values($1,$2,$3)',[id(70),T,{attribution:attribution('direct','Boundary')}]);
   for(const [i,at] of ['2026-08-31T20:59:59Z','2026-08-31T21:00:00Z','2026-09-01T20:59:59Z','2026-09-01T21:00:00Z'].entries())await cash(db,{key:'boundary:'+i,opportunity:id(70),amount:100,at});
   const result=await report(db,{from:'2026-09-01',to:'2026-09-01',search:'Boundary'});
   assert.equal(result.totals[0].netMinor,200);assert.equal(result.groups[0].events,2);
   await db.query("select set_config('fixture.tenant',$1,false)",[OTHER]);
   await assert.rejects(report(db),/forbidden/);
  });
 }finally{await db.close();}
});
