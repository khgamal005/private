import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const TENANT='10000000-0000-4000-8000-000000000001';
const OTHER='10000000-0000-4000-8000-000000000002';
const PROVIDER_ORDER='20000000-0000-4000-8000-000000000001';
async function database(){
 const db=new PGlite();
 await db.exec(await readFile(new URL('./fixtures/tamara-schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20260906133000_tamara_native_addon_checkout_v1.sql',import.meta.url),'utf8'));
 return db;
}
async function seed(db){
 await db.query(`select set_config('fixture.role','service_role',false),set_config('fixture.tenant',$1,false)`,[TENANT]);
 await db.query(`insert into core.tenants(id,organization_id,tenant_key,slug,name) values($1,$1,'test','tamara-fixture','Fixture'),($2,$2,'other','other-fixture','Other')`,[TENANT,OTHER]);
 const feature=(await db.query(`insert into catalog.features(feature_key,name_ar) values('module.fixture','Fixture') returning id`)).rows[0].id;
 const moduleId=(await db.query(`insert into core.modules(module_key,name_ar) values('fixture','Fixture') returning id`)).rows[0].id;
 const product=(await db.query(`insert into catalog.addon_products(product_key,feature_id,name_ar,usage_metric,interval,activation_mode) values('fixture',$1,'Fixture','none','year','module') returning id`,[feature])).rows[0].id;
 const secret=(await db.query(`insert into vault.secrets(secret,name) values('fixture-only','fixture') returning id`)).rows[0].id;
 const version=(await db.query(`insert into marketplace.tamara_credential_versions(environment,api_secret_id,notification_secret_id,source_rotated_at,webhook_id,enabled) values('sandbox',$1,$1,now(),$1,true) returning id`,[secret])).rows[0].id;
 await db.query(`insert into marketplace.payment_provider_configs(provider_key,name_ar,environment,credentials_environment) values('tamara','Tamara','sandbox','sandbox')`);
 await db.query(`insert into marketplace.tamara_tenant_rollouts(tenant_id,environment,enabled) values($1,'sandbox',true)`,[TENANT]);
 const order=(await db.query(`insert into marketplace.orders(tenant_id,order_kind,payment_provider,subtotal_minor,list_subtotal_minor,tax_minor,total_minor,idempotency_key,activation_state) values($1,'addon','tamara',10000,10000,1500,11500,'fixture-order-key','pending') returning id`,[TENANT])).rows[0].id;
 await db.query(`insert into marketplace.order_items(order_id,item_type,addon_product_id,product_key,product_name_ar,unit_amount_minor,line_total_minor) values($1,'addon',$2,'fixture','Fixture',10000,10000)`,[order,product]);
 const prepared=(await db.query(`select public.v1_tenant_tamara_prepare('tamara-fixture',$1) value`,[order])).rows[0].value;
 return {order,product,moduleId,version,id:prepared.attemptId};
}
const claim=async(db,id)=>(await db.query('select public.v1_service_tamara_claim($1) value',[id])).rows[0].value;
const observe=async(db,c,status,captured=0,refunded=0)=>(await db.query(`select public.v1_service_tamara_observe($1,$2,$3,$4) value`,[c.id,c.claim_token,{providerOrderId:PROVIDER_ORDER,status,capturedMinor:captured,refundedMinor:refunded,canceledMinor:0},(status==='authorised'?'a':status==='fully_captured'?'b':'c').repeat(64)])).rows[0].value;
async function withFixture(fn){const db=await database();try{await fn(db,await seed(db));}finally{await db.close();}}

test('migration adds no rollouts and denies direct tenant/service table access',async()=>{
 const db=await database();try{
  assert.equal((await db.query('select count(*)::int n from marketplace.tamara_tenant_rollouts')).rows[0].n,0);
  for(const role of ['anon','authenticated','service_role']){
   assert.equal((await db.query(`select has_table_privilege($1,'marketplace.tamara_attempts','SELECT') allowed`,[role])).rows[0].allowed,false);
  }
  assert.equal((await db.query(`select has_function_privilege('authenticated','public.v1_service_tamara_claim(uuid)','EXECUTE') allowed`)).rows[0].allowed,false);
 }finally{await db.close();}
});
test('tenant isolation and one attempt per canonical order',async()=>withFixture(async(db,f)=>{
 const again=(await db.query(`select public.v1_tenant_tamara_prepare('tamara-fixture',$1) value`,[f.order])).rows[0].value;
 assert.equal(again.attemptId,f.id);
 await db.query(`select set_config('fixture.tenant',$1,false)`,[OTHER]);
 await assert.rejects(db.query(`select public.v1_tenant_tamara_status('tamara-fixture',$1)`,[f.id]),/forbidden/);
 await assert.rejects(db.query(`select public.v1_tenant_tamara_status('other-fixture',$1)`,[f.id]),/marketplace_order_not_found/);
}));
test('claims fence workers and each financial POST is consumed once',async()=>withFixture(async(db,f)=>{
 assert.equal((await db.query('select public.v1_service_tamara_claim() value')).rows[0].value,null);
 const c=await claim(db,f.id);assert.ok(c.claim_token);assert.equal(await claim(db,f.id),null);
 const mutate=()=>db.query(`select public.v1_service_tamara_mutation($1,$2,'create','{}') ok`,[f.id,c.claim_token]);
 assert.equal((await mutate()).rows[0].ok,true);assert.equal((await mutate()).rows[0].ok,false);
 await db.query(`update marketplace.tamara_attempts set claim_until=now()-interval '1 second' where id=$1`,[f.id]);
 const next=await claim(db,f.id);assert.notEqual(next.claim_token,c.claim_token);
 assert.equal((await db.query(`select public.v1_service_tamara_release($1,$2) ok`,[f.id,c.claim_token])).rows[0].ok,false);
 assert.equal(next.status,'creating');assert.ok(next.create_started_at);
}));
test('financial snapshot, promotion and cancellation freeze after preparation',async()=>withFixture(async(db,f)=>{
 await assert.rejects(db.query(`update marketplace.orders set subtotal_minor=11000,total_minor=12500 where id=$1`,[f.order]),/payment_locked/);
 await assert.rejects(db.query(`update marketplace.order_items set product_key='changed' where order_id=$1`,[f.order]),/snapshot_immutable/);
 await assert.rejects(db.query(`update marketplace.orders set status='cancelled' where id=$1`,[f.order]),/review_hold/);
 assert.equal((await db.query(`select private_app.marketplace_promotion_attempt_active($1) active`,[f.order])).rows[0].active,true);
}));
test('authorisation grants once; captured evidence settles once; refund reverses its source',async()=>withFixture(async(db,f)=>{
 const c=await claim(db,f.id);
 const granted=await observe(db,c,'authorised');assert.equal(granted.status,'provisioned');
 assert.equal((await db.query(`select payment_status from marketplace.orders where id=$1`,[f.order])).rows[0].payment_status,'pending');
 await observe(db,c,'authorised');
 assert.equal((await db.query(`select count(*)::int n from catalog.tenant_addon_subscriptions`)).rows[0].n,1);
 assert.equal((await observe(db,c,'fully_captured',11500)).status,'paid');
 await observe(db,c,'fully_captured',11500);
 assert.equal((await db.query(`select count(*)::int n from marketplace.payment_events`)).rows[0].n,1);
 assert.equal((await observe(db,c,'approved')).stale,true);
 assert.equal((await observe(db,c,'fully_refunded',11500,11500)).status,'refunded');
 assert.equal((await db.query(`select enabled from core.tenant_modules where tenant_id=$1`,[TENANT])).rows[0].enabled,false);
 assert.equal((await db.query(`select status from catalog.tenant_addon_subscriptions`)).rows[0].status,'cancelled');
}));
test('refund preserves a later administrator change and raises review',async()=>withFixture(async(db,f)=>{
 const c=await claim(db,f.id);await observe(db,c,'authorised');await observe(db,c,'fully_captured',11500);
 await db.query(`update catalog.tenant_addon_subscriptions set requested_note='later administrator grant' where tenant_id=$1`,[TENANT]);
 assert.equal((await observe(db,c,'fully_refunded',11500,11500)).status,'review_required');
 assert.equal((await db.query(`select status from catalog.tenant_addon_subscriptions`)).rows[0].status,'active');
 assert.equal((await db.query(`select payment_status from marketplace.orders where id=$1`,[f.order])).rows[0].payment_status,'refunded');
}));
test('new Tamara payment cannot overwrite an existing entitlement',async()=>withFixture(async(db,f)=>{
 await db.query(`insert into catalog.tenant_addon_subscriptions(tenant_id,product_id,status,source) values($1,$2,'active','platform')`,[TENANT,f.product]);
 assert.equal((await observe(db,await claim(db,f.id),'authorised')).status,'review_required');
 assert.equal((await db.query('select source from catalog.tenant_addon_subscriptions')).rows[0].source,'platform');
 assert.equal((await db.query('select count(*)::int n from marketplace.tamara_entitlement_sources')).rows[0].n,0);
}));
test('unrelated Paymob orders remain outside Tamara order/item guards',async()=>withFixture(async(db)=>{
 const order=(await db.query(`insert into marketplace.orders(tenant_id,order_kind,payment_provider,subtotal_minor,list_subtotal_minor,tax_minor,total_minor,idempotency_key) values($1,'addon','paymob',100,100,15,115,'paymob-fixture-key') returning id`,[OTHER])).rows[0].id;
 await db.query(`update marketplace.orders set notes='unchanged provider flow',status='cancelled' where id=$1`,[order]);
 assert.equal((await db.query(`select payment_provider from marketplace.orders where id=$1`,[order])).rows[0].payment_provider,'paymob');
}));
