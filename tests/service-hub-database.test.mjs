import test from 'node:test';
import assert from 'node:assert/strict';
import {database,identity,enable,TENANT,OTHER,tenantCall,adminCall,application,publishedExpert,quote} from './fixtures/service-hub-db.mjs';

test('new RPCs are disabled by default and anon cannot access tenant/admin data or private helpers',async()=>{
  const db=await database();try{
    await identity(db);assert.deepEqual(await tenantCall(db,'snapshot').catch(e=>({error:e.message})),{error:'service_hub_not_enabled'});
    assert.deepEqual((await db.query("select public.v1_service_hub_snapshot('hub-fixture') data")).rows[0].data,{enabled:false});
    await identity(db,{role:'anon'});
    for(const sql of ["select public.v1_service_hub_snapshot('hub-fixture')","select public.v1_platform_service_hub_action('snapshot')","select private_app.service_provider_visible_v1(null)","select * from marketplace.expert_applications"]){await assert.rejects(db.query(sql),/permission denied/);}
    await enable(db);await identity(db);await assert.rejects(adminCall(db,'snapshot'),/forbidden/);
    await db.query("select set_config('fixture.deny','true',false)");await assert.rejects(tenantCall(db,'snapshot'),/forbidden/);
  }finally{await db.close();}
});

test('public application is validated, bounded, deduplicated and reviewed into a private draft',async()=>{
  const db=await database();try{
    await enable(db);await identity(db,{role:'anon'});
    await assert.rejects(db.query('select public.v1_public_expert_application($1)',[{...application,consent:false}]),/invalid/);
    await assert.rejects(db.query('select public.v1_public_expert_application($1)',[{...application,portfolioUrl:'https://trusted.test@evil.test'}]),/invalid/);
    await assert.rejects(db.query('select public.v1_public_expert_application($1)',[{...application,languages:Array(21).fill('ع').join(',')}]),/invalid/);
    const send=payload=>db.query('select public.v1_public_expert_application($1) data',[payload]);
    assert.deepEqual((await send(application)).rows[0].data,{received:true});
    assert.deepEqual((await send({...application,email:application.email.toUpperCase(),name:'replacement'})).rows[0].data,{received:true});
    await identity(db,{admin:true});let snapshot=await adminCall(db,'snapshot');assert.equal(snapshot.applicationTotal,1);assert.equal(snapshot.applications[0].payload.name,application.name);
    const id=snapshot.applications[0].id;const {providerId}=await adminCall(db,'approve_application',{id});
    const repeat=await adminCall(db,'approve_application',{id});assert.equal(repeat.providerId,providerId);
    await identity(db);snapshot=await tenantCall(db,'snapshot');assert.equal(snapshot.expertCount,0);assert.equal(snapshot.applications,undefined);assert.equal(JSON.stringify(snapshot).includes(application.email),false);
    await identity(db,{admin:true});await assert.rejects(adminCall(db,'publish_provider',{providerId,published:true}),/not_ready/);
    await db.exec('reset role');assert.equal((await db.query('select status from marketplace.service_providers where id=$1',[providerId])).rows[0].status,'draft');
    await db.exec('update marketplace.expert_application_limits set submissions=100');await identity(db,{role:'anon'});await assert.rejects(send({...application,email:'next@example.test'}),/rate_limited/);
  }finally{await db.close();}
});

test('published zero-service experts are discoverable without exposing contacts; unpublish is reversible',async()=>{
  const db=await database();try{
    const providerId=await publishedExpert(db);await identity(db);let data=await tenantCall(db,'snapshot');
    assert.equal(data.experts.length,1);assert.equal(data.experts[0].name,application.name);assert.equal(data.experts[0].email,undefined);assert.equal(data.experts[0].phone,undefined);
    await identity(db,{tenant:OTHER});assert.equal((await tenantCall(db,'snapshot',{},'other-fixture')).experts.length,1);
    await identity(db,{admin:true});await adminCall(db,'publish_provider',{providerId,published:false});await identity(db);data=await tenantCall(db,'snapshot');assert.equal(data.expertCount,0);
  }finally{await db.close();}
});

test('tenant quote access is isolated, versions are checked, repeated acceptance creates one immutable canonical order',async()=>{
  const db=await database();try{
    const {request,payload,offer,productId}=await quote(db);
    await identity(db,{tenant:OTHER});assert.equal((await tenantCall(db,'snapshot',{},'other-fixture')).requests.length,0);
    await assert.rejects(tenantCall(db,'accept',payload,'other-fixture'),/not_found/);
    await identity(db);await assert.rejects(tenantCall(db,'accept',{...payload,version:1}),/conflict/);
    const [order,duplicate]=await Promise.all([tenantCall(db,'accept',payload),tenantCall(db,'accept',payload)]);assert.equal(order.id,duplicate.id);assert.equal(duplicate.duplicate,true);assert.equal(order.totalMinor,11500);
    await identity(db,{admin:true});await assert.rejects(adminCall(db,'offer',{...offer,version:3}),/conflict/);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int n from marketplace.orders')).rows[0].n,1);
    assert.equal((await db.query('select private_app.service_quote_order_matches_v1($1) matches',[order.id])).rows[0].matches,true);
    await db.query('update marketplace.service_products set amount_minor=99999 where id=$1',[productId]);
    await assert.rejects(db.query('update marketplace.orders set total_minor=2 where id=$1',[order.id]),/quote_payment_locked/);
    await assert.rejects(db.query('update marketplace.order_items set unit_amount_minor=3 where order_id=$1',[order.id]),/quote_payment_locked/);
    await assert.rejects(db.query('delete from marketplace.order_items where order_id=$1',[order.id]),/quote_payment_locked/);
    await db.query("update marketplace.orders set status='in_progress' where id=$1",[order.id]);
    await identity(db);await assert.rejects(db.query("select public.v1_tenant_marketplace_replace_payment('hub-fixture',$1)",[{orderId:order.id,paymentProvider:'tamara'}]),/quote_payment_locked/);
    const key=crypto.randomUUID();await tenantCall(db,'order_note',{orderId:order.id,message:'متابعة تنفيذ البرنامج',requestKey:key});await tenantCall(db,'order_note',{orderId:order.id,message:'متابعة تنفيذ البرنامج',requestKey:key});assert.equal((await tenantCall(db,'order_thread',{orderId:order.id})).updates.length,1);
    await identity(db,{tenant:OTHER});await assert.rejects(tenantCall(db,'order_thread',{orderId:order.id},'other-fixture'),/not_found/);await assert.rejects(tenantCall(db,'order_note',{orderId:order.id,message:'محاولة عابرة',requestKey:crypto.randomUUID()},'other-fixture'),/not_found/);
    await db.exec('reset role');assert.equal((await db.query('select tenant_id from marketplace.service_requests where id=$1',[request.id])).rows[0].tenant_id,TENANT);
  }finally{await db.close();}
});

test('unavailable payment and expired quote fail atomically, request retries retain their identity',async()=>{
  const db=await database();try{
    const {request,payload}=await quote(db,{paymentProvider:'paymob'});
    const req={requestKey:crypto.randomUUID(),title:'خدمة مخصصة',details:'تفاصيل الخدمة الاختبارية للمنشأة',deliveryMode:'online'};
    const a=await tenantCall(db,'request',req),b=await tenantCall(db,'request',req);assert.equal(a.id,b.id);
    await db.query("select set_config('fixture.payment_disabled','true',false)");await assert.rejects(tenantCall(db,'accept',payload),/provider_unavailable/);
    await db.query("select set_config('fixture.payment_disabled','false',false)");await db.exec('reset role');await db.query("update marketplace.service_requests set expires_at=now()-interval '1 second' where id=$1",[request.id]);
    await identity(db);await assert.rejects(tenantCall(db,'accept',payload),/expired/);await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from marketplace.orders')).rows[0].n,0);
  }finally{await db.close();}
});

test('Paymob keeps its existing checks and admits only authoritative accepted quotation snapshots',async()=>{
  const db=await database();try{
    const {payload}=await quote(db,{paymentProvider:'paymob'});const order=await tenantCall(db,'accept',payload);
    await db.exec('reset role');assert.equal((await db.query('select private_app.service_quote_order_matches_v1($1) matches',[order.id])).rows[0].matches,true);
    assert.equal((await db.query('select private_app.service_quote_order_matches_v1($1) matches',[crypto.randomUUID()])).rows[0].matches,false);
    const def=(await db.query("select pg_get_functiondef('public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'::regprocedure) def")).rows[0].def;
    for(const invariant of ['paymob_service_fixed_package_required','paymob_billing_contact_invalid','paymob_readiness_evidence_stale','paymob_order_payment_review_hold','private_app.service_quote_order_matches_v1(v_order.id)'])assert.ok(def.includes(invariant));
    await assert.rejects(db.query("update marketplace.orders set payment_status='paid' where id=$1",[order.id]),/paymob_verified_receipt_required/);
  }finally{await db.close();}
});
