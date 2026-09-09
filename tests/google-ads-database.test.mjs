import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const T='10000000-0000-4000-8000-000000000001';
const OTHER='10000000-0000-4000-8000-000000000002';
const REEF='10000000-0000-4000-8000-000000000003';
const ACTOR='10000000-0000-4000-8000-000000000099';
const AUTH='10000000-0000-4000-8000-000000000088';
const uuid=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const account={customerId:'1234567890',name:'Synthetic advertiser',currency:'SAR',timezone:'Asia/Riyadh',loginCustomerId:null,manager:false,testAccount:false,selectable:true};
const campaigns=[{externalCampaignId:'9001',name:'Synthetic campaign',status:'ENABLED',channelType:'SEARCH'}];
const daily=[{date:'2026-08-01',externalCampaignId:'9001',costMicros:'100000000',costMinor:10000,impressions:1000,clicks:20,googleConversions:4.5,googleConversionValue:99,currency:'SAR'}];
const rpc=async(db,name,args=[],params=[])=>{
 const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');
 return (await db.query(`select public.${name}(${placeholders}) data`,params.length?params:args)).rows[0].data;
};
const tenant=async db=>{
 await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.sub',$2,false),set_config('request.jwt.claim.role','authenticated',false)",[JSON.stringify({sub:AUTH,role:'authenticated'}),AUTH]);
};
const service=async db=>{
 await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.role','service_role',false)",[JSON.stringify({role:'service_role'})]);
};
async function setup(){
 const db=new PGlite();
 for(const path of ['./fixtures/campaign-revenue-schema.sql','../supabase/migrations/20260906204652_unified_campaign_revenue_v1.sql','./fixtures/google-ads-schema.sql','../supabase/migrations/20260909203555_google_ads_reader_v1.sql'])await db.exec(await readFile(new URL(path,import.meta.url),'utf8'));
 await db.query("insert into core.tenants(id,slug) values($1,'fixture'),($2,'other'),($3,'reef-skills')",[T,OTHER,REEF]);
 await db.query('insert into access_control.subjects(id,auth_user_id) values($1,$2)',[ACTOR,AUTH]);
 await db.query("select set_config('fixture.tenant',$1,false)",[T]);await tenant(db);return db;
}
async function enable(db){await db.query('insert into google_ads.rollouts(tenant_id,enabled) values($1,true)',[T]);}
async function begin(db,n=1){return rpc(db,'v1_tenant_google_ads_begin_oauth',['fixture',String(n).padStart(64,'a'),'/tenant/fixture/reports/google-ads','B'.repeat(43)]);}
async function claim(db,n=1){return rpc(db,'v1_tenant_google_ads_claim_oauth',[String(n).padStart(64,'a'),'B'.repeat(43)]);}
async function finalize(db,x,accounts=[account]){
 await service(db);const result=await rpc(db,'v1_service_google_ads_finalize_oauth',[x.transactionId,'synthetic-refresh-token-123456789',JSON.stringify(accounts),['https://www.googleapis.com/auth/adwords']]);await tenant(db);return result;
}
async function start(db,n=1){return rpc(db,'v1_tenant_google_ads_begin_sync',['fixture','2026-08-01','2026-08-02',uuid(n)]);}
async function finish(db,r,metrics=daily,success=true){await service(db);const result=await rpc(db,'v1_service_google_ads_finish_sync',[r.runId,r.leaseToken,JSON.stringify(campaigns),JSON.stringify(metrics),success,null]);await tenant(db);return result;}
const report=db=>rpc(db,'v1_tenant_google_ads_report',['fixture','2026-08-01','2026-08-02','2026-09-05',1,'']);

test('Google Ads isolated reader database lifecycle and reconciliation',async t=>{
 const db=await setup();t.after(()=>db.close());
 await t.test('migration is private, disabled and grants no direct access',async()=>{
  assert.equal((await rpc(db,'v1_tenant_google_ads_snapshot',['fixture'])).enabled,false);
  assert.equal((await db.query('select count(*)::int n from google_ads.rollouts')).rows[0].n,0);
  assert.equal((await db.query("select status from catalog.addon_products where product_key='google_ads_connect'")).rows[0].status,'draft');
  assert.equal((await db.query("select is_marketplace_visible from catalog.addon_products where product_key='google_ads_connect'")).rows[0].is_marketplace_visible,false);
  const surface=(await db.query("select surface_key,location_key,route_template,status from catalog.addon_surfaces")).rows[0];
  assert.deepEqual(surface,{surface_key:'tenant.google_ads',location_key:'tenant.google_ads',route_template:'/tenant/{slug}/reports/google-ads',status:'draft'});
  assert.equal((await db.query("select count(*)::int n from pg_constraint where contype='f' and confrelid='google_ads.accounts'::regclass")).rows[0].n,4);
  for(const role of ['anon','authenticated','service_role']){
   assert.equal((await db.query("select has_table_privilege($1,'google_ads.connections','SELECT') allowed",[role])).rows[0].allowed,false);
   assert.equal((await db.query("select has_table_privilege($1,'google_ads.source_reviews','INSERT') allowed",[role])).rows[0].allowed,false);
  }
  assert.equal((await db.query("select has_function_privilege('authenticated','public.v1_service_google_ads_finalize_oauth(uuid,text,jsonb,text[])','EXECUTE') allowed")).rows[0].allowed,false);
  await assert.rejects(begin(db),/google_ads_not_enabled/);
  await enable(db);
 });
 await t.test('tenant isolation, protected Reef and OAuth actor/PKCE/replay fencing',async()=>{
  await assert.rejects(rpc(db,'v1_tenant_google_ads_snapshot',['other']),/google_ads_forbidden/);
  await db.query("select set_config('fixture.tenant',$1,false)",[REEF]);
  await assert.rejects(rpc(db,'v1_tenant_google_ads_snapshot',['reef-skills']),/google_ads_protected_tenant/);
  await db.query("select set_config('fixture.tenant',$1,false)",[T]);
  await begin(db);
  await assert.rejects(rpc(db,'v1_tenant_google_ads_claim_oauth',[String(1).padStart(64,'a'),'C'.repeat(43)]),/google_ads_oauth_invalid/);
  const x=await claim(db);await assert.rejects(claim(db),/google_ads_oauth_invalid/);
  await assert.rejects(rpc(db,'v1_service_google_ads_finalize_oauth',[x.transactionId,'synthetic-refresh-token',JSON.stringify([account]),['https://www.googleapis.com/auth/adwords']]),/google_ads_service_only/);
  await finalize(db,x);await rpc(db,'v1_tenant_google_ads_select_account',['fixture',account.customerId]);
  await assert.rejects(db.query("insert into google_ads.campaigns(tenant_id,account_id,campaign_id,name,status) values($1,$2,'9002','Cross tenant attempt','enabled')",[OTHER,account.customerId]),/foreign key/);
  await assert.rejects(rpc(db,'v1_tenant_google_ads_select_account',['fixture','44444']),/google_ads_account_not_discovered/);
  const snapshot=await rpc(db,'v1_tenant_google_ads_snapshot',['fixture']);assert.equal(snapshot.accounts.length,1);assert.ok(!JSON.stringify(snapshot).includes('synthetic-refresh'));
  await db.query("select set_config('fixture.deny','tenant.marketing.manage,tenant.settings.manage',false)");
  assert.equal((await rpc(db,'v1_tenant_google_ads_snapshot',['fixture'])).accounts.length,0);
  await db.query("select set_config('fixture.deny','',false)");
 });
 await t.test('sync is idempotent; whole window commits and empty success removes stale rows',async()=>{
  const r=await start(db,1);assert.equal((await start(db,1)).duplicate,true);
  await assert.rejects(start(db,2),/google_ads_sync_in_progress/);
  await finish(db,r);let v=await report(db);assert.equal(v.summary.spendMinor,10000);assert.equal(v.summary.googleConversions,4.5);assert.equal(v.coverage.spendComplete,true);
  const empty=await start(db,3);await finish(db,empty,[]);v=await report(db);assert.equal(v.summary.spendMinor,0);assert.equal(v.coverage.missingDays,0);
  const restored=await start(db,4);await finish(db,restored);
  const failed=await start(db,5);await finish(db,failed,[],false);assert.equal((await report(db)).summary.spendMinor,10000);
 });
 await t.test('invalid partial write rolls back entire window, lease/version races rejected',async()=>{
  const r=await start(db,6);await service(db);
  await assert.rejects(rpc(db,'v1_service_google_ads_finish_sync',[r.runId,r.leaseToken,JSON.stringify(campaigns),JSON.stringify([...daily,{...daily[0],date:'2026-08-03'}]),true,null]),/google_ads_metric_invalid/);
  await tenant(db);assert.equal((await report(db)).summary.spendMinor,10000);
  await finish(db,r,[],false);
  // Cancelling OAuth leaves the existing credential version and account usable.
  await begin(db,2);const existing=await start(db,7);await finish(db,existing);
  const pending=await start(db,8);const x=await claim(db,2);await finalize(db,x);
  await service(db);await assert.rejects(rpc(db,'v1_service_google_ads_sync_credentials',[pending.runId,pending.leaseToken]),/google_ads_stale_lease/);await tenant(db);
  await begin(db,3);const stale=await claim(db,3);await rpc(db,'v1_tenant_google_ads_disconnect',['fixture']);await service(db);
  await assert.rejects(rpc(db,'v1_service_google_ads_finalize_oauth',[stale.transactionId,'synthetic-refresh-token-123456789',JSON.stringify([account]),['https://www.googleapis.com/auth/adwords']]),/google_ads_oauth_stale/);await tenant(db);
  await begin(db,4);const fresh=await claim(db,4);await finalize(db,fresh);await rpc(db,'v1_tenant_google_ads_select_account',['fixture',account.customerId]);
 });
 await t.test('manual source review uses optimistic tokens, preserves history and excludes Meta reviews',async()=>{
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name,source,created_at) values($1,$2,'Synthetic student','google','2026-08-01T08:00:00Z')",[uuid(101),T]);
  await db.query("insert into sales_core.lead_import_batches(id,tenant_id,file_name) values($1,$2,'synthetic.csv')",[uuid(100),T]);
  await db.query("insert into sales_core.lead_import_rows(id,tenant_id,batch_id,contact_id,row_number,source,campaign_name,full_name,raw_data,created_at) values($1,$2,$3,$4,1,'google','Synthetic campaign','Synthetic student','{\"receivedAt\":\"2026-08-01T08:00:00Z\"}','2026-08-01T09:00:00Z')",[uuid(102),T,uuid(100),uuid(101)]);
  const preview=await rpc(db,'v1_tenant_google_ads_sources',['fixture',0]);assert.equal(preview.rows.length,1);
  const rows=JSON.stringify(preview.rows.map(({originKey,previewToken})=>({originKey,previewToken})));
  const args=['fixture',uuid(110),'9001',rows,'Synthetic manual review'];
  assert.equal((await rpc(db,'v1_tenant_google_ads_review_sources',args)).reviewed,1);
  assert.equal((await rpc(db,'v1_tenant_google_ads_review_sources',args)).replayed,true);
  await assert.rejects(rpc(db,'v1_tenant_google_ads_review_sources',['fixture',uuid(111),'9001',rows,'Synthetic manual review']),/google_ads_source_changed_refresh_preview/);
  await assert.rejects(db.query("update google_ads.source_reviews set reason='changed'"),/google_ads_history_append_only/);
  assert.equal((await report(db)).summary.manualLeads,1);
  // A pre-existing reviewed Meta source is deliberately outside this add-on.
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name,source,created_at) values($1,$2,'Synthetic Meta student','meta','2026-08-01T08:00:00Z')",[uuid(103),T]);
  await db.query("insert into marketing_hub.campaign_source_reviews(tenant_id,command_id,command_hash,origin_key,original,evidence,received_at,date_evidence,actor_id,reason) values($1,$2,'synthetic', $3,'{\"source\":\"meta\"}','source_only','2026-08-01T08:00:00Z','system_time',$4,'Synthetic Meta baseline')",[T,uuid(112),'contact:'+uuid(103),ACTOR]);
  assert.equal((await rpc(db,'v1_tenant_google_ads_sources',['fixture',0])).rows.length,1);
  await assert.rejects(rpc(db,'v1_tenant_google_ads_review_sources',['fixture',uuid(113),'9001',JSON.stringify([{originKey:'contact:'+uuid(103),previewToken:'invented'}]),'Attempt foreign reviewed origin']),/google_ads_source_changed_refresh_preview/);
 });
 await t.test('service continuations revalidate actor permissions and protected tenant every time',async()=>{
  const r=await start(db,20);
  await db.query("select set_config('fixture.deny','tenant.marketing.manage,tenant.settings.manage',false)");await service(db);
  await assert.rejects(rpc(db,'v1_service_google_ads_sync_credentials',[r.runId,r.leaseToken]),/google_ads_forbidden/);
  assert.equal((await db.query("select current_setting('request.jwt.claims',true)::jsonb->>'role' role")).rows[0].role,'service_role');
  await db.query("select set_config('fixture.deny','',false)");await tenant(db);await finish(db,r,[],false);
  // Even a forged service-side run cannot bypass the protected slug boundary.
  await db.query("insert into google_ads.accounts(tenant_id,customer_id,name,currency,timezone,credential_version) values($1,'1234567890','Protected synthetic','SAR','Asia/Riyadh',1)",[REEF]);
  await db.query("insert into google_ads.sync_runs(tenant_id,command_id,actor_subject_id,actor_auth_user_id,account_id,credential_version,date_from,date_to) values($1,$2,$3,$4,'1234567890',1,'2026-08-01','2026-08-02')",[REEF,uuid(21),ACTOR,AUTH]);
  const reefRun=(await db.query('select id,lease_token from google_ads.sync_runs where tenant_id=$1',[REEF])).rows[0];await service(db);
  await assert.rejects(rpc(db,'v1_service_google_ads_sync_credentials',[reefRun.id,reefRun.lease_token]),/google_ads_protected_tenant/);await tenant(db);
 });
 await t.test('revoked Google authorization produces reconnect state and retains prior data',async()=>{
  const r=await start(db,30);await service(db);
  await rpc(db,'v1_service_google_ads_finish_sync',[r.runId,r.leaseToken,'[]','[]',false,'reauth_required']);await tenant(db);
  assert.equal((await rpc(db,'v1_tenant_google_ads_snapshot',['fixture'])).status,'reauth_required');
  assert.equal((await report(db)).summary.spendMinor,10000);
  assert.equal((await db.query('select count(*)::int n from vault.secrets')).rows[0].n,1);
  await assert.rejects(start(db,31),/google_ads_connection_required/);
 });
 await t.test('verified payment only, accounting replacement, refund, cutoff and finance permissions',async()=>{
  await db.query("insert into sales_core.opportunities(id,tenant_id,contact_id,created_at,metadata) values($1,$2,$3,'2026-08-02','{\"importRowId\":\"20000000-0000-4000-8000-000000000102\"}')",[uuid(120),T,uuid(101)]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,contact_id,opportunity_id,payment_status,payment_verified_at,payment_amount_minor,status) values($1,$2,$3,$4,'pending',null,50000,'accepted')",[uuid(121),T,uuid(101),uuid(120)]);
  assert.equal((await report(db)).summary.verifiedPayers,0);
  await db.query("update academy.registration_handoffs set payment_status='verified',payment_verified_at='2026-09-01T12:00:00Z' where id=$1",[uuid(121)]);
  let v=await report(db);assert.equal(v.summary.verifiedPayers,1);assert.equal(v.summary.registrations,1);assert.equal(v.summary.netCollectionsMinor,50000);assert.equal(v.campaigns[0].manualCollectionRoas,5);
  const early=await rpc(db,'v1_tenant_google_ads_report',['fixture','2026-08-01','2026-08-02','2026-08-31',1,'']);assert.equal(early.summary.verifiedPayers,0);
  await db.query('insert into accounting_core.customer_accounts(id,tenant_id,contact_id) values($1,$2,$3)',[uuid(130),T,uuid(101)]);
  await db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,source_type,source_id,status,verified_at,amount_minor,currency) values($1,$2,$3,'registration_handoff',$4,'verified','2026-09-01T12:00:00Z',50000,'SAR')",[uuid(131),T,uuid(130),uuid(121)]);
  await db.query("insert into accounting_core.refunds(id,tenant_id,payment_id,status,completed_at,amount_minor) values($1,$2,$3,'completed','2026-09-02T12:00:00Z',10000)",[uuid(132),T,uuid(131)]);
  v=await report(db);assert.equal(v.summary.netCollectionsMinor,40000);assert.equal(v.summary.verifiedPayers,1);assert.equal(v.campaigns[0].manualCollectionRoas,4);
  await db.query("select set_config('fixture.finance','no',false),set_config('fixture.deny','tenant.leads.read,tenant.crm.read',false)");
  v=await report(db);assert.equal(v.summary.netCollectionsMinor,null);assert.equal(v.campaigns[0].manualCollectionRoas,null);assert.equal(v.details,null);
  await db.query("select set_config('fixture.finance','yes',false),set_config('fixture.deny','',false)");
 });
 await t.test('deactivation fails closed without deleting history or invoking legacy storage',async()=>{
  await db.query('update google_ads.rollouts set enabled=false where tenant_id=$1',[T]);await assert.rejects(report(db),/google_ads_not_enabled/);
  assert.equal((await db.query('select count(*)::int n from google_ads.source_reviews')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from marketing_hub.daily_metrics')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from marketing_hub.campaign_source_reviews')).rows[0].n,1);
 });
});
