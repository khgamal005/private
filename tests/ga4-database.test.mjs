import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const T='10000000-0000-4000-8000-000000000001',OTHER='10000000-0000-4000-8000-000000000002',ACTOR='10000000-0000-4000-8000-000000000099',AUTH='10000000-0000-4000-8000-000000000088';
const uid=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const SCOPE=['https://www.googleapis.com/auth/adwords','https://www.googleapis.com/auth/analytics.readonly'];
const property={id:'1234',name:'Synthetic store',currency:'SAR',timezone:'Asia/Riyadh',hostname:'store.example'};
const tx={date:'2026-08-01',transactionId:'001',hostName:'store.example',sessionSource:'google',sessionMedium:'cpc',sessionGoogleAdsCustomerId:'1234567890',sessionGoogleAdsCampaignId:'9001',sessionCampaignName:'Synthetic',currencyCode:'SAR',ecommercePurchases:1,grossPurchaseRevenue:'100.00'};
const traffic={date:'2026-08-01',sessionSource:'google',sessionMedium:'cpc',sessionGoogleAdsCustomerId:'1234567890',sessionGoogleAdsCampaignId:'9001',sessions:10,engagedSessions:8,screenPageViews:20,addToCarts:3,checkouts:2,ecommercePurchases:1};
const clean={thresholded:false,otherRow:false,sampled:false,restricted:false};
const payload=(transactions=[tx])=>({transactions,traffic:[traffic],quality:{transactions:clean,traffic:clean}});
const call=async(db,name,args=[]) => (await db.query(`select public.v1_${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) data`,args)).rows[0].data;
const user=async db=>{await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.sub',$2,false),set_config('request.jwt.claim.role','authenticated',false)",[JSON.stringify({sub:AUTH,role:'authenticated'}),AUTH]);};
const service=async db=>{await db.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false),set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.role','service_role',false)");};
async function setup(){
 const db=new PGlite();for(const file of ['tests/fixtures/campaign-revenue-schema.sql','supabase/migrations/20260906204652_unified_campaign_revenue_v1.sql','tests/fixtures/google-ads-schema.sql','supabase/migrations/20260909203555_google_ads_reader_v1.sql','supabase/migrations/20260914203345_google_ads_reef_controlled_pilot.sql','tests/fixtures/ga4-schema.sql','supabase/migrations/20260915205048_google_ads_ga4_reconciliation_v1.sql']) await db.exec(await readFile(file,'utf8'));
 await db.exec(await readFile('supabase/migrations/20260917193608_ga4_independent_site_analytics_v2.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20260918060000_ga4_optional_transaction_sync.sql','utf8'));
 await db.query("insert into core.tenants(id,slug) values($1,'fixture'),($2,'other')",[T,OTHER]);await db.query('insert into access_control.subjects(id,auth_user_id) values($1,$2)',[ACTOR,AUTH]);
 await db.query("select set_config('fixture.tenant',$1,false)",[T]);await user(db);
 await db.query('insert into google_ads.rollouts(tenant_id,enabled) values($1,true)',[T]);
 await db.query("insert into google_ads.accounts(tenant_id,customer_id,name,currency,timezone,credential_version) values($1,'1234567890','Synthetic','SAR','Asia/Riyadh',1)",[T]);
 await db.query("insert into google_ads.connections(tenant_id,status,credential_version,selected_account_id,scopes,vault_secret_id) values($1,'connected',1,'1234567890',$2,vault.create_secret('synthetic-refresh','test','test'))",[T,SCOPE]);
 await db.query("insert into google_ads.campaigns(tenant_id,account_id,campaign_id,name,status) values($1,'1234567890','9001','Synthetic','enabled')",[T]);
 await db.query("insert into commerce_sync.connections values($1,$2,'https://store.example'),($3,$4,'https://other.example')",[uid(1),T,uid(2),OTHER]);return db;
}
let command=100;
const begin=(db,kind='sync')=>call(db,'tenant_google_ads_ga4_begin',['fixture',kind,uid(++command),kind==='configure'?'1234':null,kind==='configure'?uid(1):null,kind==='sync'?'2026-08-01':null,kind==='sync'?'2026-08-02':null]);
async function finish(db,run,p,success=true){await service(db);try{return await call(db,'service_google_ads_ga4_finish',[run.runId,run.leaseToken,JSON.stringify(p),success,success?null:'ga4_request_failed']);}finally{await user(db);}}
const report=(db,page=1,status='all')=>call(db,'tenant_google_ads_ga4_report',['fixture','2026-08-01','2026-08-02','2026-09-01',page,status,null]);

test('GA4 database: tenant isolation, atomic sync, exact order/payment reconciliation and history',async t=>{
 const db=await setup();t.after(()=>db.close());
 await t.test('disabled by default; same entitlement; no direct grants or cross-tenant configure',async()=>{
  assert.equal((await call(db,'tenant_google_ads_ga4_status',['fixture'])).configured,false);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_table_privilege($1,'google_ads.ga4_rows','SELECT') allowed",[role])).rows[0].allowed,false);
  await assert.rejects(call(db,'tenant_google_ads_ga4_status',['other']),/google_ads_forbidden/);
  await assert.rejects(begin(db),/ga4_not_configured/);
  const run=await begin(db,'discover');await finish(db,run,{properties:[{id:'1234',name:'Synthetic'}]});
  await assert.rejects(call(db,'tenant_google_ads_ga4_begin',['fixture','configure',uid(++command),'1234',uid(2),null,null]),/ga4_invalid_property/);
  await finish(db,await begin(db,'configure'),{property});
 });
 await t.test('exact store/transaction identity; native tax excluded from GA value comparison',async()=>{
  await db.query("insert into commerce_sync.external_entities values($1,$2,$3,'order','001',$4),($5,$6,$7,'order','001',$4)",[uid(3),T,uid(1),JSON.stringify({id:1,number:'001',total:'110.00',line_items:[{total:'100.00'}]}),uid(4),OTHER,uid(2)]);
  await db.query("insert into sales_core.commerce_order_work_items values($1,$2,$3,$4,'001','completed','SAR',11000)",[uid(5),T,uid(1),uid(3)]);
  const run=await begin(db);await finish(db,run,payload());let r=await report(db);
  assert.equal(r.summary.matchedOrders,1);assert.equal(r.summary.pendingPayments,1);assert.equal(r.rows[0].amountCheck,'consistent_item_value');assert.equal(r.rows[0].netMinor,0);
  assert.equal(r.rows[0].status,'payment_pending');assert.equal(r.coverage.complete,true);
 });
 await t.test('verified finance read from canonical source, replacement and partial refund counted once',async()=>{
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name) values($1,$2,'Synthetic only')",[uid(6),T]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,contact_id,payment_status,payment_verified_at,payment_amount_minor,metadata) values($1,$2,$3,'verified','2026-08-01',11000,'{\"currency\":\"SAR\"}')",[uid(7),T,uid(6)]);
  await db.query('insert into sales_core.commerce_admission_lines values($1,$2,$3)',[T,uid(5),uid(7)]);
  let r=await report(db);assert.equal(r.finances[0].netMinor,11000);assert.equal(r.summary.verifiedOrders,1);
  await db.query('insert into accounting_core.customer_accounts(id,tenant_id,contact_id) values($1,$2,$3)',[uid(8),T,uid(6)]);
  await db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,amount_minor,currency,status,source_type,source_id,verified_at) values($1,$2,$3,11000,'SAR','verified','registration_handoff',$4,'2026-08-01')",[uid(9),T,uid(8),uid(7)]);
  await db.query("insert into accounting_core.refunds(id,tenant_id,payment_id,amount_minor,status,completed_at) values($1,$2,$3,2000,'completed','2026-08-02')",[uid(10),T,uid(9)]);
  r=await report(db);assert.equal(r.finances[0].collectionsMinor,11000);assert.equal(r.finances[0].refundsMinor,2000);assert.equal(r.finances[0].netMinor,9000);assert.equal(r.summary.verifiedRegistrations,1);
  await finish(db,await begin(db),payload());assert.equal((await report(db)).finances[0].netMinor,9000);
 });
 await t.test('partial failure preserves previous data; malformed replacement rolls back',async()=>{
  await finish(db,await begin(db),{},false);assert.equal((await report(db)).finances[0].netMinor,9000);
  const r=await begin(db);await assert.rejects(finish(db,r,payload([{...tx,date:'2026-08-03'}])),/ga4_invalid_response/);
  assert.equal((await report(db)).summary.transactions,1);await finish(db,r,{},false);
 });
 await t.test('duplicate IDs and two aliases of same order never duplicate revenue',async()=>{
  await finish(db,await begin(db),payload([tx,{...tx,date:'2026-08-02'}]));assert.equal((await report(db)).rows[0].status,'duplicate_transaction');assert.equal((await report(db)).finances.length,0);
  await finish(db,await begin(db),payload([tx,{...tx,transactionId:'1'}]));let r=await report(db);assert.equal(r.rows.length,2);assert.ok(r.rows.every(x=>x.status==='order_reused'));assert.equal(r.finances.length,0);
  await finish(db,await begin(db),payload());
 });
 await t.test('limited data, missing campaign, refunds and unknown orders remain explicit',async()=>{
  const p=payload();p.quality={transactions:{...clean,thresholded:true},traffic:clean};await finish(db,await begin(db),p);
  let r=await report(db);assert.equal(r.rows[0].status,'limited_ga4_data');assert.equal(r.coverage.transactionDataLimited,true);
  await finish(db,await begin(db),payload([{...tx,sessionGoogleAdsCustomerId:'9999999999'}, {...tx,transactionId:'missing'}]));r=await report(db);
  assert.equal(r.summary.sessionAttributedOrders,0);assert.equal(r.summary.verifiedOrders,1);assert.equal(r.summary.unmatched,1);
  await finish(db,await begin(db),payload());
 });
 await t.test('large result keeps details paginated and reports bounded payload size',async()=>{
  const rows=Array.from({length:1000},(_,i)=>({...tx,transactionId:'synthetic-'+i}));
  await finish(db,await begin(db),payload(rows));const started=performance.now();const r=await report(db);
  assert.equal(r.totalRows,1000);assert.equal(r.rows.length,50);assert.equal(r.hasMore,true);
  assert.ok(JSON.stringify(r).length<100000);assert.ok(performance.now()-started<5000);
  const plan=await db.query("explain (analyze, format json) select public.v1_tenant_google_ads_ga4_report('fixture','2026-08-01','2026-08-02','2026-09-01',1,'all',null)");
  t.diagnostic('Synthetic 1,000-transaction report execution: '+plan.rows[0]['QUERY PLAN'][0]['Execution Time']+' ms; '+JSON.stringify(r).length+' bytes.');
  await finish(db,await begin(db),payload());
 });
 await t.test('a store URL change fences an in-flight job before reading secrets',async()=>{
  const run=await begin(db);await db.query("update commerce_sync.connections set store_url='https://changed.example' where id=$1",[uid(1)]);await service(db);
  await assert.rejects(call(db,'service_google_ads_ga4_credentials',[run.runId,run.leaseToken]),/google_ads_stale_lease/);await user(db);
  await db.query("update commerce_sync.connections set store_url='https://store.example' where id=$1",[uid(1)]);await finish(db,run,{},false);
 });
 await t.test('money and detail permissions enforced separately, revoked actor and stale leases rejected',async()=>{
  await db.query("select set_config('fixture.finance','no',false),set_config('fixture.deny','tenant.leads.read,tenant.crm.read',false)");let r=await report(db);assert.deepEqual(r.rows,[]);assert.deepEqual(r.finances,[]);assert.equal(r.summary.valueDifferences,null);
  await db.query("select set_config('fixture.finance','yes',false),set_config('fixture.deny','',false)");
  const run=await begin(db);await db.query("select set_config('fixture.deny','tenant.marketing.manage,tenant.settings.manage',false)");await service(db);
  await assert.rejects(call(db,'service_google_ads_ga4_credentials',[run.runId,run.leaseToken]),/google_ads_forbidden/);await user(db);await db.query("select set_config('fixture.deny','',false)");
  await call(db,'tenant_google_ads_ga4_disable',['fixture']);await service(db);await assert.rejects(call(db,'service_google_ads_ga4_credentials',[run.runId,run.leaseToken]),/google_ads_stale_lease/);await user(db);
  assert.equal((await report(db)).configured,false);assert.equal((await db.query('select count(*)::int n from google_ads.ga4_rows')).rows[0].n,2);
  assert.equal((await db.query('select amount_minor from accounting_core.payments')).rows[0].amount_minor,11000);
 });
});

test('standalone GA4: explicit site binding, optional reconciliation, bounded analytics and safe migration',async t=>{
 const db=await setup();t.after(()=>db.close());
 const migration=await readFile('supabase/migrations/20260917193608_ga4_independent_site_analytics_v2.sql','utf8');
 const v2=(kind,{commandId=uid(++command),store=null,stream=null,pid='1234'}={})=>call(db,'tenant_google_ads_ga4_begin_v2',['fixture',kind,commandId,pid,store,kind==='sync'?'2026-08-01':null,kind==='sync'?'2026-08-02':null,stream]);
 await db.query('delete from commerce_sync.connections where tenant_id=$1',[T]);
 await finish(db,await begin(db,'discover'),{properties:[{id:'1234',name:'Standalone site'}]});
 await t.test('stream discovery is authorized, serialized, bounded and retry-safe',async()=>{
  await assert.rejects(v2('streams',{pid:'9999'}),/ga4_invalid_property/);
  const commandId=uid(++command),run=await v2('streams',{commandId});
  await assert.rejects(v2('streams'),/google_ads_sync_in_progress/);
  const streams=[{id:'5678',name:'Website',hostname:'store.example',providerPrivate:'not returned'}];
  const done=await finish(db,run,{streams});assert.deepEqual(done.streams,[{id:'5678',name:'Website',hostname:'store.example'}]);
  const retry=await v2('streams',{commandId});assert.equal(retry.duplicate,true);assert.deepEqual(retry.streams,done.streams);
  await assert.rejects(v2('configure',{stream:'5678',store:uid(2)}),/ga4_invalid_property/);
  await assert.rejects(v2('configure'),/ga4_stream_required/);
 });
 await t.test('binds without a store; rejects mismatched stream results and preserves repeated selection',async()=>{
  const run=await v2('configure',{stream:'5678'});
  await assert.rejects(finish(db,run,{property:{...property,streamId:'9999'}}),/ga4_invalid_response/);
  assert.equal((await call(db,'tenant_google_ads_ga4_status',['fixture'])).configured,false);
  await finish(db,run,{property:{...property,streamId:'5678'}});
  const state=await call(db,'tenant_google_ads_ga4_status',['fixture']);assert.equal(state.configured,true);assert.equal(state.property.streamId,'5678');assert.equal(state.reconciliation.enabled,false);assert.deepEqual(state.stores,[]);
  const first=(await db.query('select config_id from google_ads.ga4_settings where tenant_id=$1',[T])).rows[0].config_id;
  await finish(db,await v2('configure',{stream:'5678'}),{property:{...property,streamId:'5678'}});
  assert.equal((await db.query('select config_id from google_ads.ga4_settings where tenant_id=$1',[T])).rows[0].config_id,first);
  const empty=await report(db);assert.equal(empty.traffic.sessions,null);assert.equal(empty.summary.transactions,null);assert.equal(empty.summary.verifiedOrders,null);
 });
 await t.test('reports measured activity and bounded sources without inventing finance or unmatched orders',async()=>{
  const run=await v2('sync');await service(db);
  const context=await call(db,'service_google_ads_ga4_credentials',[run.runId,run.leaseToken]);assert.equal(context.storeUrl,null);assert.equal(context.property.streamId,'5678');await user(db);
  const p=payload();p.traffic=Array.from({length:25},(_,i)=>({...traffic,sessionSource:'source-'+String(i).padStart(2,'0')}));
  await finish(db,run,p);const r=await report(db);
  assert.equal(r.basis,'site_activity');assert.equal(r.traffic.sessions,250);assert.equal(r.coverage.complete,true);
  assert.equal(r.summary.transactions,1);assert.equal(r.summary.matchedOrders,null);assert.equal(r.summary.unmatched,null);assert.equal(r.summary.verifiedRegistrations,null);
  assert.deepEqual(r.finances,[]);assert.deepEqual(r.issues,[]);assert.deepEqual(r.rows,[]);assert.equal(r.reconciliation.enabled,false);
  assert.equal(r.trafficSourceCount,25);assert.equal(r.trafficSources.length,20);assert.ok(JSON.stringify(r).length<15000);
  await assert.rejects(call(db,'tenant_google_ads_ga4_report',['other','2026-08-01','2026-08-02']),/google_ads_forbidden/);
 });
 await t.test('a new stream gets a separate observation scope; failure preserves the prior window',async()=>{
  const before=(await db.query('select count(*)::int n from google_ads.ga4_rows where tenant_id=$1',[T])).rows[0].n;
  await finish(db,await v2('configure',{stream:'7777'}),{property:{...property,streamId:'7777'}});
  assert.equal((await report(db)).traffic.sessions,null);assert.equal((await db.query('select count(*)::int n from google_ads.ga4_rows where tenant_id=$1',[T])).rows[0].n,before);
  await finish(db,await v2('sync'),payload());await finish(db,await v2('sync'),{},false);
  assert.equal((await report(db)).traffic.sessions,10);
  await finish(db,await v2('sync'),{transactions:[],traffic:[],quality:{transactions:clean,traffic:clean}});
  const r=await report(db);assert.equal(r.traffic.sessions,0);assert.equal(r.summary.verifiedOrders,null);assert.equal(r.coverage.complete,true);
 });
 await t.test('adding/removing an optional source is tenant-bound and existing records survive migration replay',async()=>{
  await db.query("insert into commerce_sync.connections values($1,$2,'https://store.example')",[uid(1),T]);
  await finish(db,await v2('configure',{stream:'7777',store:uid(1)}),{property:{...property,streamId:'7777'}});
  assert.equal((await call(db,'tenant_google_ads_ga4_status',['fixture'])).reconciliation.connectionId,uid(1));
  assert.equal((await report(db)).reconciliation.enabled,true);
  await finish(db,await v2('configure',{stream:'7777'}),{property:{...property,streamId:'7777'}});
  assert.equal((await report(db)).reconciliation.enabled,false);
  const snapshot=async()=> (await db.query("select (select jsonb_agg(to_jsonb(s) order by tenant_id) from google_ads.ga4_settings s) settings,(select count(*) from google_ads.ga4_rows) observations,(select count(*) from commerce_sync.connections) stores")).rows;
  const before=await snapshot();await db.exec(migration);assert.deepEqual(await snapshot(),before);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'google_ads.ga4_site_summary(uuid,uuid,date,date)','EXECUTE') allowed",[role])).rows[0].allowed,false);
  for(const role of ['anon','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.v1_tenant_google_ads_ga4_begin_v2(text,text,uuid,text,uuid,date,date,text)','EXECUTE') allowed",[role])).rows[0].allowed,false);
 });
});

test('optional transaction sync: explicit availability, atomic failure and database-enforced reconciliation mode',async t=>{
 const db=await setup();t.after(()=>db.close());
 await finish(db,await begin(db,'discover'),{properties:[{id:'1234',name:'Independent site'}]});
 const configure=store=>call(db,'tenant_google_ads_ga4_begin_v2',['fixture','configure',uid(++command),'1234',store,null,null,'5678']);
 await finish(db,await configure(null),{property:{...property,streamId:'5678'}});
 const sitePayload=()=>({transactions:[],traffic:[traffic],quality:{transactions:{...clean,status:'not_requested'},traffic:clean}});
 const run=await begin(db);
 await assert.rejects(finish(db,run,{...sitePayload(),transactions:[tx]}),/ga4_invalid_response/);
 assert.equal((await report(db)).traffic.sessions,null);
 const done=await finish(db,run,sitePayload());assert.equal(done.transactionRows,null);
 let r=await report(db);
 assert.equal(r.coverage.complete,true);assert.equal(r.coverage.transactionReportAvailable,false);
 assert.equal(r.coverage.transactionDataLimited,false);assert.equal(r.coverage.trafficDataLimited,false);
 assert.equal(r.traffic.sessions,10);assert.equal(r.traffic.purchases,1);assert.equal(r.summary.transactions,null);
 assert.equal(r.summary.verifiedOrders,null);assert.deepEqual(r.rows,[]);assert.deepEqual(r.finances,[]);
 await finish(db,await begin(db),{},false);assert.equal((await report(db)).traffic.sessions,10);
 await finish(db,await begin(db),{...sitePayload(),traffic:[]});r=await report(db);
 assert.equal(r.traffic.sessions,0);assert.equal(r.traffic.purchases,0);assert.equal(r.summary.transactions,null);
 await finish(db,await configure(uid(1)),{property:{...property,streamId:'5678'}});
 const matchedRun=await begin(db);
 await assert.rejects(finish(db,matchedRun,sitePayload()),/ga4_invalid_response/);
 assert.equal((await report(db)).coverage.complete,false);
 await finish(db,matchedRun,payload());assert.equal((await report(db)).summary.transactions,1);
 const snapshot=async()=> (await db.query("select (select jsonb_agg(to_jsonb(s) order by tenant_id) from google_ads.ga4_settings s) settings,(select count(*) from google_ads.ga4_rows) observations,(select count(*) from commerce_sync.connections) stores")).rows;
 const before=await snapshot();await db.exec(await readFile('supabase/migrations/20260918060000_ga4_optional_transaction_sync.sql','utf8'));assert.deepEqual(await snapshot(),before);
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'google_ads.ga4_site_summary(uuid,uuid,date,date)','EXECUTE') allowed",[role])).rows[0].allowed,false);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'public.v1_service_google_ads_ga4_finish(uuid,uuid,jsonb,boolean,text)','EXECUTE') allowed",[role])).rows[0].allowed,false);
});
