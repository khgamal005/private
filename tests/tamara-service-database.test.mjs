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
 await db.exec(await readFile(new URL('./fixtures/tamara-service-schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20260906153331_tamara_service_capture_v1.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('./fixtures/paymob-order-guard.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20260906163942_marketplace_unpaid_order_recovery.sql',import.meta.url),'utf8'));
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


async function service(db){
 const f=await seed(db);
 await db.query("select set_config('fixture.admin','true',false)");
 const cat=(await db.query("insert into marketplace.service_categories(category_key) values('fixture') returning id")).rows[0].id;
 await db.query("insert into marketplace.service_products(category_id,product_key,name_ar,amount_minor) values($1,'fixture_service','خدمة اختبار',10000)",[cat]);
 const r=(await db.query("select public.v1_tenant_tamara_service_create('tamara-fixture',$1) data",[{productKey:'fixture_service',paymentProvider:'tamara',quantity:1,idempotencyKey:'service-fixture-order'}])).rows[0].data;
 const a=(await db.query("select public.v1_tenant_tamara_prepare('tamara-fixture',$1) data",[r.id])).rows[0].data;
 await db.query("update marketplace.tamara_attempts set create_started_at=now() where id=$1",[a.attemptId]);
 return {order:r.id,id:a.attemptId,addon:f};
}
test('services are authorised without capture; admin delivery enables a single capture; settlement preserves service semantics',async()=>{
 const db=await database();try{
 const f=await service(db),c=await claim(db,f.id);
 assert.equal((await observe(db,c,'authorised')).status,'authorised');
 assert.equal((await db.query('select status,payment_status from marketplace.orders where id=$1',[f.order])).rows[0].status,'in_progress');
 assert.equal((await db.query("select public.v1_service_tamara_mutation($1,$2,'capture') ok",[f.id,c.claim_token])).rows[0].ok,false);
 await db.query("select set_config('fixture.admin','false',false)");
 await assert.rejects(db.query("select public.v1_platform_tamara_service_delivered($1,'delivery reference')",[f.order]),/forbidden/);
 await db.query("select set_config('fixture.admin','true',false)");
 await db.query("select public.v1_platform_tamara_service_delivered($1,'delivery reference')",[f.order]);
 assert.equal((await db.query("select public.v1_platform_tamara_service_delivered($1,'another reference') r",[f.order])).rows[0].r.duplicate,true);
 assert.equal((await db.query("select public.v1_service_tamara_mutation($1,$2,'capture') ok",[f.id,c.claim_token])).rows[0].ok,true);
 assert.equal((await db.query("select public.v1_service_tamara_mutation($1,$2,'capture') ok",[f.id,c.claim_token])).rows[0].ok,false);
 assert.equal((await observe(db,c,'fully_captured',11500)).status,'paid');
 const o=(await db.query('select status,payment_status,activation_state from marketplace.orders where id=$1',[f.order])).rows[0];
 assert.deepEqual(o,{status:'completed',payment_status:'paid',activation_state:'not_applicable'});
 assert.equal((await db.query('select count(*)::int n from catalog.tenant_addon_subscriptions')).rows[0].n,0);
 assert.equal((await observe(db,c,'fully_refunded',11500,11500)).status,'refunded');
 assert.equal((await db.query('select delivery_reference from marketplace.tamara_service_deliveries')).rows[0].delivery_reference,'delivery reference');
 }finally{await db.close();}
});
test('late services cannot be marked delivered and cancellation is consumed once',async()=>{
 const db=await database();try{
 const f=await service(db),c=await claim(db,f.id);await observe(db,c,'authorised');
 await db.query("update marketplace.tamara_attempts set create_started_at=now()-interval '20 days' where id=$1",[f.id]);
 await assert.rejects(db.query("select public.v1_platform_tamara_service_delivered($1,'late delivery')",[f.order]),/window_closed/);
 assert.equal((await db.query("select public.v1_service_tamara_mutation($1,$2,'cancel') ok",[f.id,c.claim_token])).rows[0].ok,true);
 assert.equal((await db.query("select public.v1_service_tamara_mutation($1,$2,'cancel') ok",[f.id,c.claim_token])).rows[0].ok,false);
 assert.equal((await observe(db,c,'canceled')).status,'cancelled');
 }finally{await db.close();}
});
test('provider capture without confirmed delivery enters review and cannot fake service completion',async()=>{
 const db=await database();try{const f=await service(db),c=await claim(db,f.id);assert.equal((await observe(db,c,'fully_captured',11500)).status,'review_required');assert.equal((await db.query('select payment_status from marketplace.orders where id=$1',[f.order])).rows[0].payment_status,'pending');}finally{await db.close();}
});
test('replacement keeps expired Paymob evidence, creates one Tamara order, and is isolated and idempotent',async()=>{
 const db=await database();try{
 const f=await service(db);
 const old=(await db.query("insert into marketplace.orders(tenant_id,order_kind,payment_provider,subtotal_minor,list_subtotal_minor,tax_minor,total_minor,idempotency_key) values($1,'service','paymob',10000,10000,1500,11500,'old-paymob-order') returning id",[TENANT])).rows[0].id;
 await db.query("insert into marketplace.order_items(order_id,item_type,service_product_id,product_key,product_name_ar,quantity,unit_amount_minor,line_total_minor) select $1,'service',id,'fixture_service','خدمة اختبار',1,10000,10000 from marketplace.service_products where product_key='fixture_service'",[old]);
 await db.query("insert into marketplace.service_order_briefs(order_id,tenant_id,brief) values($1,$2,'{\"goal\":\"preserve\"}')",[old,TENANT]);
 // The previous synthetic service must not be a second pending product order.
 await db.query("select set_config('odeir.tamara_verified_order_id',$1,false)",[f.order]);
 await db.query("update marketplace.orders set status='cancelled' where id=$1",[f.order]);
 const attempt=crypto.randomUUID();
 await db.query(`insert into marketplace.payment_attempts(id,tenant_id,order_id,environment,credential_version_id,idempotency_key,special_reference,status,order_number_snapshot,order_kind_snapshot,subtotal_minor,tax_minor,tax_rate_bps,amount_minor,currency,billing_contact_sha256,items_snapshot_sha256,expires_at,last_error_code,provider_order_id) values($1,$2,$3,'sandbox',$1,'old-attempt','old','pending','old','service',10000,1500,1500,11500,'SAR','fixture','fixture',now()-interval '1 day','provider_intention_expired_no_payment','fixture-provider')`,[attempt,TENANT,old]);
 const replace=()=>db.query("select public.v1_tenant_marketplace_replace_payment('tamara-fixture',$1) r",[{orderId:old,paymentProvider:'tamara'}]);
 await assert.rejects(replace(),/requires_resolution/);
 assert.equal((await db.query('select status from marketplace.orders where id=$1',[old])).rows[0].status,'pending_payment');
 await db.query("update marketplace.payment_attempts set status='failed' where id=$1",[attempt]);
 await db.query("select set_config('fixture.tenant',$1,false)",[OTHER]);await assert.rejects(replace(),/forbidden/);
 await db.query("select set_config('fixture.tenant',$1,false)",[TENANT]);
 const result=(await replace()).rows[0].r;
 assert.notEqual(result.id,old);assert.equal(result.paymentProvider,'tamara');
 assert.equal((await replace()).rows[0].r.id,result.id);
 assert.deepEqual((await db.query('select payment_provider,status from marketplace.orders where id=$1',[old])).rows[0],{payment_provider:'paymob',status:'cancelled'});
 assert.equal((await db.query('select provider_order_id from marketplace.payment_attempts where id=$1',[attempt])).rows[0].provider_order_id,'fixture-provider');
 assert.equal((await db.query('select brief from marketplace.service_order_briefs where order_id=$1',[result.id])).rows[0].brief.goal,'preserve');
 assert.equal((await db.query("select count(*)::int n from marketplace.order_events where event_type='payment_order_replaced'")).rows[0].n,1);
 }finally{await db.close();}
});

