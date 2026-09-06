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
 await db.exec(await readFile(new URL('../supabase/migrations/20260906172757_marketplace_resolved_payment_cancellation.sql',import.meta.url),'utf8'));
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
const cancel=async(db,id)=>(await db.query("select public.v1_tenant_marketplace_cancel_unpaid_order('tamara-fixture',$1) r",[{orderId:id}])).rows[0].r;
test('unstarted checkout cancels once and fences an already leased worker',()=>withFixture(async(db,f)=>{
 const c=await claim(db,f.id);
 await cancel(db,f.order);
 assert.equal((await db.query("select status from marketplace.orders where id=$1",[f.order])).rows[0].status,'cancelled');
 assert.equal((await db.query("select public.v1_service_tamara_mutation($1,$2,'create','{}') ok",[f.id,c.claim_token])).rows[0].ok,false);
 assert.equal((await cancel(db,f.order)).duplicate,true);
 assert.equal((await db.query("select count(*)::int n from marketplace.order_events where event_type='order_cancelled'")).rows[0].n,1);
}));
test('started and ambiguous attempts cannot be cancelled using a browser return',()=>withFixture(async(db,f)=>{
 await db.query("update marketplace.tamara_attempts set status='creating',create_started_at=now() where id=$1",[f.id]);
 await assert.rejects(cancel(db,f.order),/tamara_order_payment_review_hold/);
 assert.equal((await db.query('select status from marketplace.orders where id=$1',[f.order])).rows[0].status,'pending_payment');
}));
for(const kind of ['addon','service']) test(`Paymob ${kind}: unresolved attempts block cancellation; verified expiry cancels idempotently`,()=>withFixture(async(db,f)=>{
 const old=(await db.query(`insert into marketplace.orders(tenant_id,order_kind,payment_provider,subtotal_minor,tax_minor,total_minor,idempotency_key)
 values($1,'${kind}','paymob',10000,1500,11500,'paymob-cancel-fixture') returning id`,[TENANT])).rows[0].id;
 const aid=crypto.randomUUID();
 await db.query(`insert into marketplace.payment_attempts(id,tenant_id,order_id,environment,credential_version_id,idempotency_key,special_reference,status,order_number_snapshot,order_kind_snapshot,subtotal_minor,tax_minor,tax_rate_bps,amount_minor,currency,billing_contact_sha256,items_snapshot_sha256,expires_at)
 values($1,$2,$3,'sandbox',$1,'pending-key','pending-ref','pending','fixture','addon',10000,1500,1500,11500,'SAR','fixture','fixture',now()+interval '1 day')`,[aid,TENANT,old]);
 await assert.rejects(cancel(db,old),/payment_cancellation_requires_resolution/);
 await db.query("update marketplace.payment_attempts set status='failed' where id=$1",[aid]);
 await assert.rejects(cancel(db,old),/payment_cancellation_requires_resolution/);
 assert.equal((await db.query('select status from marketplace.orders where id=$1',[old])).rows[0].status,'pending_payment');
 // Provider-confirmed expiry is different from a generic failed attempt.
 await db.query("update marketplace.payment_attempts set last_error_code='provider_intention_expired_no_payment',expires_at=now()-interval '1 hour' where id=$1",[aid]);
 await db.query("update marketplace.orders set payment_status='failed' where id=$1",[old]);
 await cancel(db,old);
 const closed=(await db.query('select status,payment_status,activation_state from marketplace.orders where id=$1',[old])).rows[0];
 assert.deepEqual(closed,{status:'cancelled',payment_status:'failed',activation_state:'cancelled'});
 assert.equal((await cancel(db,old)).duplicate,true);
 assert.equal((await db.query("select count(*)::int n from marketplace.order_events where order_id=$1 and event_type='order_cancelled'",[old])).rows[0].n,1);

}));
test('other tenants and unprivileged database roles cannot cancel',()=>withFixture(async(db,f)=>{
 await db.query("select set_config('fixture.tenant',$1,false)",[OTHER]);
 await assert.rejects(cancel(db,f.order),/forbidden/);
 assert.equal((await db.query("select has_function_privilege('anon','public.v1_tenant_marketplace_cancel_unpaid_order(text,jsonb)','execute') allowed")).rows[0].allowed,false);
}));
test('authorised and captured obligations cannot be cancelled',()=>withFixture(async(db,f)=>{
 const c=await claim(db,f.id); await observe(db,c,'authorised');
 await assert.rejects(cancel(db,f.order),/tamara_order_payment_review_hold|marketplace_order_not_payable/);
 await observe(db,c,'fully_captured',11500);
 await assert.rejects(cancel(db,f.order),/marketplace_order_not_payable/);
}));
test('verified declined service can be purchased again without modifying old evidence',async()=>{
 const db=await database();try{
  const f=await service(db),c=await claim(db,f.id);await observe(db,c,'declined');
  const retry=()=>db.query("select public.v1_tenant_marketplace_replace_payment('tamara-fixture',$1) r",[{orderId:f.order,paymentProvider:'tamara'}]);
  const r=(await retry()).rows[0].r;
  assert.notEqual(r.id,f.order);assert.equal(r.paymentProvider,'tamara');
  assert.equal((await retry()).rows[0].r.id,r.id);
  assert.equal((await db.query('select provider_order_id from marketplace.tamara_attempts where id=$1',[f.id])).rows[0].provider_order_id,PROVIDER_ORDER);
  assert.equal((await db.query("select count(*)::int n from marketplace.order_events where event_type='payment_order_replaced'")).rows[0].n,1);
 }finally{await db.close();}
});

test('switching from cancelled Tamara to bank transfer keeps history and rolls back price changes',async()=>{
 const db=await database();try{
  const f=await service(db),c=await claim(db,f.id);await observe(db,c,'declined');
  // Catalog creation is outside this unit; exercise the real recovery transaction
  // against a deterministic bank-order factory, including its price contract.
  await db.exec(`create function public.v2_tenant_service_marketplace_action(text,text,jsonb) returns jsonb language plpgsql as $$
   declare oid uuid;
   begin
    insert into marketplace.orders(tenant_id,order_kind,payment_provider,subtotal_minor,tax_minor,total_minor,idempotency_key)
    values('${TENANT}','service',$3->>'paymentProvider',coalesce(nullif(current_setting('fixture.price',true),'')::bigint,11500)-1500,1500,coalesce(nullif(current_setting('fixture.price',true),'')::bigint,11500),$3->>'idempotencyKey') returning id into oid;
    return private_app.marketplace_order_payload(oid);
   end $$;`);
  const replace=()=>db.query("select public.v1_tenant_marketplace_replace_payment('tamara-fixture',$1) r",[{orderId:f.order,paymentProvider:'bank_transfer'}]);
  await db.query("select set_config('fixture.price','12000',false)");
  await assert.rejects(replace(),/payment_replacement_price_changed/);
  assert.equal((await db.query("select count(*)::int n from marketplace.orders where payment_provider='bank_transfer'")).rows[0].n,0);
  await db.query("select set_config('fixture.price','11500',false)");
  const r=(await replace()).rows[0].r;
  assert.equal(r.paymentProvider,'bank_transfer');assert.notEqual(r.id,f.order);
  assert.equal((await replace()).rows[0].r.id,r.id);
  assert.equal((await db.query('select status from marketplace.tamara_attempts where id=$1',[f.id])).rows[0].status,'cancelled');
 }finally{await db.close();}
});
