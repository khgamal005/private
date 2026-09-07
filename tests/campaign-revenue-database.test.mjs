import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const T='10000000-0000-4000-8000-000000000001',O='10000000-0000-4000-8000-000000000002';
const uuid=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function setup(){
 const db=new PGlite();
 await db.exec(await readFile(new URL('./fixtures/campaign-revenue-schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20260906204652_unified_campaign_revenue_v1.sql',import.meta.url),'utf8'));
 await db.query("select set_config('fixture.tenant',$1,false)",[T]);
 await db.query("insert into core.tenants(id,slug) values($1,'fixture'),($2,'other')",[T,O]);
 await db.query('insert into access_control.subjects values(private_app.current_subject_id())');
 return db;
}
const report=async(db,mode='cohort',asOf='2026-09-05',from='2026-08-01',to='2026-08-31')=>(await db.query(
 "select public.v1_tenant_campaign_revenue_report('fixture',$1,$2,$3,$4) data",[from,to,asOf,mode])).rows[0].data;
async function seed(db){
 await db.query('insert into marketing_hub.campaign_report_rollouts values($1,true)',[T]);
 await db.query("insert into marketing_hub.ad_accounts(id,tenant_id,name,currency) values($1,$2,'Account','EGP'),($3,$4,'Other','SAR')",[uuid(90),T,uuid(91),O]);
 await db.query("insert into marketing_hub.campaigns values($1,$2,$3,'Training','meta','123'),($4,$5,$6,'Training','meta','123')",[uuid(80),T,uuid(90),uuid(81),O,uuid(91)]);
 await db.query("insert into sales_core.opportunities(id,tenant_id,contact_id,created_at) values($1,$2,$3,'2026-08-05'),($4,$2,$3,'2026-09-01')",[uuid(30),T,uuid(1),uuid(31)]);
 await db.query("insert into sales_core.contacts(id,tenant_id,full_name,source,campaign_name,created_at,lead_status) values($1,$2,'Paid lead','meta','Training','2026-08-05','paid'),($3,$2,'Wrong number','meta','Training','2026-08-06','wrong_number'),($4,$5,'Other tenant','meta','Training','2026-08-06','paid')",[uuid(1),T,uuid(2),uuid(3),O]);
 await db.query("insert into sales_core.lead_import_batches values($1,$2,'sheet.xlsx','2026-08-07')",[uuid(10),T]);
 await db.query("insert into sales_core.lead_import_rows(id,tenant_id,batch_id,row_number,source,campaign_name,full_name,created_at,raw_data) values($1,$2,$3,1,'meta','Training','Queued','2026-08-07','{\"receivedAt\":\"2026-08-04\"}')",[uuid(11),T,uuid(10)]);
 await db.query("insert into sales_core.lead_import_rows(id,tenant_id,batch_id,row_number,source,campaign_name,duplicate_contact_id,validation_status,queue_status,created_at) values($1,$2,$3,2,'meta','Training',$4,'duplicate','skipped','2026-08-08')",[uuid(12),T,uuid(10),uuid(1)]);
 await db.query("insert into academy.registration_handoffs(id,tenant_id,contact_id,opportunity_id,payment_status,payment_verified_at,payment_amount_minor,status) values($1,$2,$3,$4,'verified','2026-09-02',10000,'accepted'),($5,$2,$3,$6,'pending_verification',null,90000,'accepted')",[uuid(20),T,uuid(1),uuid(30),uuid(21),uuid(31)]);
}
test('campaign reporting reconciles source, finance, scope and replay contracts',async t=>{
 const db=await setup();
 try{
 await t.test('disabled by default; no direct access',async()=>{
  assert.equal((await report(db)).enabled,false);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_table_privilege($1,'marketing_hub.campaign_source_reviews','SELECT') ok",[role])).rows[0].ok,false);
  assert.equal((await db.query("select has_function_privilege('authenticated','private_app.campaign_origins_v1(uuid)','EXECUTE') ok")).rows[0].ok,false);
 });
 await seed(db);
 await t.test('cohort includes queue and wrong numbers, deduplicates customers and follows late verified payment',async()=>{
  const r=await report(db);assert.equal(r.summary.leads,3);assert.equal(r.summary.payers,1);assert.equal(r.summary.waiting,1);assert.equal(r.summary.duplicates,1);
  assert.equal(r.groups[0].conversion,33.33);assert.equal(r.groups[0].unqualified,1);assert.equal(r.groups[0].money[0].netMinor,10000);
  assert.equal((await report(db,'cohort','2026-08-31')).summary.payers,0);
  assert.equal((await report(db,'cash')).summary.leads,0);
 });
 await t.test('review is previewed, tenant bound, idempotent and append only',async()=>{
  const p=(await db.query("select public.v1_tenant_campaign_sources('fixture') data")).rows[0].data;
  assert.equal(p.targets.length,1);
  const rows=p.rows.map(r=>({key:r.key,token:r.token}));
  const run=(c=uuid(80),cmd=uuid(40),selected=rows)=>db.query("select public.v1_tenant_campaign_source_review('fixture',$1,$2,$3,null,'Reviewed Excel campaign') data",[cmd,selected,c]);
  await assert.rejects(run(uuid(81)),/campaign_not_found/);
  assert.equal((await run()).rows[0].data.reviewed,4);
  assert.equal((await run()).rows[0].data.replayed,true);
  await assert.rejects(run(null),/command_id_reused/);
  await assert.rejects(run(uuid(80),uuid(41)),/source_changed_refresh_preview/);
  await assert.rejects(db.query("update marketing_hub.campaign_source_reviews set reason='changed'"),/campaign_review_append_only/);
  assert.equal((await report(db)).groups[0].campaignId,uuid(80));
 });
 await t.test('accounting import replaces handoff; partial refund decreases cash, not payer count',async()=>{
  await db.query('insert into accounting_core.customer_accounts values($1,$2,$3)',[uuid(50),T,uuid(1)]);
  await db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,source_type,source_id,status,verified_at,amount_minor,currency) values($1,$2,$3,'registration_handoff',$4,'verified','2026-09-03',10000,'SAR')",[uuid(51),T,uuid(50),uuid(20)]);
  await db.query("insert into accounting_core.refunds values($1,$2,$3,'completed','2026-09-04',2000)",[uuid(52),T,uuid(51)]);
  const r=await report(db);assert.equal(r.summary.payers,1);assert.equal(r.groups[0].money[0].grossMinor,10000);assert.equal(r.groups[0].money[0].netMinor,8000);
  const cash=await report(db,'cash','2026-09-05','2026-09-01','2026-09-05');assert.equal(cash.groups[0].conversion,null);assert.equal(cash.groups[0].money[0].netMinor,8000);
 });
 await t.test('finance permissions redact amounts, not just UI; other tenants and disabled addon denied',async()=>{
  await db.query("select set_config('fixture.finance','no',false)");
  const r=await report(db);assert.equal(r.canReadMoney,false);assert.equal(r.groups[0].money,null);assert.equal(r.unattributedCash,null);
  await db.query("select set_config('fixture.finance','yes',false),set_config('fixture.tenant',$1,false)",[O]);
  await assert.rejects(report(db),/forbidden/);
  await db.query("select set_config('fixture.tenant',$1,false),set_config('fixture.addon','no',false)",[T]);
  await assert.rejects(report(db),/addon_not_enabled/);
  await db.query("select set_config('fixture.addon','yes',false)");
 });
 await t.test('invalid dates fall back explicitly; missing Meta is null, not measured zero',async()=>{
  const r=await db.query("select private_app.campaign_received_at_v1('2026-02-30','2026-08-07T00:00:00Z','Asia/Riyadh') d");
  assert.equal(new Date(r.rows[0].d).toISOString(),'2026-08-07T00:00:00.000Z');
  const meta=(await db.query("select public.v3_tenant_campaign_meta_report('fixture','2026-08-01','2026-08-31') d")).rows[0].d;
  assert.equal(meta.summary.spendMinor,null);assert.equal(meta.summary.reach,null);
 });
 await t.test('repeat purchases without source are held out; explicit opportunity source is shown separately',async()=>{
  await db.query("update academy.registration_handoffs set payment_status='verified',payment_verified_at='2026-09-04' where id=$1",[uuid(21)]);
  let r=await report(db);assert.equal(r.groups[0].money[0].netMinor,8000);assert.equal(r.groups[0].registrations,1);
  const period=await report(db,'cash','2026-09-05','2026-09-01','2026-09-05');assert.equal(period.unattributedCash[0].netMinor,90000);
  await db.query("update sales_core.opportunities set metadata=jsonb_build_object('importRowId',$1::text) where id=$2",[uuid(12),uuid(31)]);
  r=await report(db);assert.equal(r.summary.leads,3);assert.equal(r.summary.payers,1);
  assert.equal(r.additionalCash[0].netMinor,90000);assert.equal(r.additionalCash[0].customers,1);
  assert.equal(r.groups[0].money[0].netMinor,8000);
 });
 await t.test('detail paging belongs to the selected group and origin reads stay bounded at volume',async()=>{
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name,source,campaign_name,created_at) select gen_random_uuid(),$1,'Volume fixture','manual','Volume','2026-08-12' from generate_series(1,2000)",[T]);
  const started=performance.now();const r=await report(db);
  assert.equal(r.summary.leads,2003);assert.equal(r.details.length,50);
  const g=r.groups.find(g=>g.name==='Volume');
  const p=(await db.query("select public.v1_tenant_campaign_revenue_report('fixture','2026-08-01','2026-08-31','2026-09-05','cohort',null,null,null,'',1950,$1) d",[g.key])).rows[0].d;
  assert.equal(p.totalDetails,2000);assert.equal(p.details.length,50);assert.ok(p.details.every(d=>d.groupKey===g.key));
  const sources=(await db.query("select public.v1_tenant_campaign_sources('fixture',null,200) d")).rows[0].d;
  assert.equal(sources.rows.length,200);
  t.diagnostic(`2,003-customer fixture report + last detail page + source preview: ${Math.round(performance.now()-started)} ms (local, not a production SLA)`);
  await db.query('update marketing_hub.campaign_report_rollouts set enabled=false where tenant_id=$1',[T]);
  assert.equal((await report(db)).enabled,false);
  assert.equal((await db.query('select count(*)::int n from marketing_hub.campaign_source_reviews')).rows[0].n,4);
 });
 }finally{await db.close();}
});
