import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverySetup,deliveryAction,mediaAction,deliveryCommand,checkoutOffer,checkoutOrder,verificationPayload,storeAction,call,login,T,MANAGER_AUTH} from './fixtures/academy-delivery-database.mjs';

test('delivery rollout defaults closed and a canonical course is required',async t=>{
 const db=await deliverySetup({enabled:false});t.after(()=>db.close());const offer=await checkoutOffer(db);
 assert.equal((await call(db,'public.v1_academy_course_delivery_snapshot',{p_slug:'marktone',p_course_id:offer.courseId})).available,false);
 await assert.rejects(mediaAction(db,'create_upload',{courseId:offer.courseId,fileName:'video.mp4',mimeType:'video/mp4',sizeBytes:100}),/academy_delivery_disabled/);
});

test('video upload receipts are immutable and finalize checks actual private storage metadata',async t=>{
 const db=await deliverySetup();t.after(()=>db.close());const offer=await checkoutOffer(db),command=deliveryCommand();
 const payload={courseId:offer.courseId,fileName:'lesson.mp4',mimeType:'video/mp4',sizeBytes:100};
 const asset=await mediaAction(db,'create_upload',payload,command);
 assert.equal(asset.allowDownload,false);assert.equal(asset.state,'pending');
 assert.deepEqual(await mediaAction(db,'create_upload',payload,command),asset);
 await assert.rejects(mediaAction(db,'create_upload',{...payload,sizeBytes:101},command),/academy_command_conflict/);
 await assert.rejects(mediaAction(db,'complete_upload',{assetId:asset.assetId}),/academy_media_not_ready/);
 await db.query("insert into storage.objects(bucket_id,name,metadata) values('academy-course-media',$1,$2)",[asset.objectPath,JSON.stringify({size:100,mimetype:'video/mp4'})]);
 const ready=await mediaAction(db,'complete_upload',{assetId:asset.assetId});assert.equal(ready.state,'ready');
 assert.equal((await mediaAction(db,'complete_upload',{assetId:asset.assetId})).state,'ready');
 await assert.rejects(call(db,'public.v1_academy_media_access',{p_slug:'marktone',p_asset_id:asset.assetId,p_download:true}),/academy_media_download_disabled/);
 await mediaAction(db,'set_download',{assetId:asset.assetId,allowDownload:true,expectedVersion:1});
 assert.equal((await call(db,'public.v1_academy_media_access',{p_slug:'marktone',p_asset_id:asset.assetId,p_download:true})).allowDownload,true);
 await login(db,null);await assert.rejects(call(db,'public.v1_academy_media_access',{p_slug:'marktone',p_asset_id:asset.assetId}),/authentication_required/);
});

test('free course approval creates a canonical zero invoice and enrollment without fictional cash',async t=>{
 const db=await deliverySetup();t.after(()=>db.close());const offer=await checkoutOffer(db);
 await deliveryAction(db,'save_offer',{courseId:offer.courseId,runId:offer.runId,learningMode:'cohort',expectedVersion:2,netMinor:0,installmentTerms:[]});
 await login(db,null);
 const order=await call(db,'public.v1_academy_store_order',{p_slug:'marktone',p_action:'create_order',p_command_id:deliveryCommand(),p_payload:{offerId:offer.offerId,learner:{name:'Free learner',phone:'0509999901',email:'free@example.test'},payerIsLearner:true,tokenHash:'c'.repeat(64),acceptedPolicy:true}});
 assert.equal(order.requiredMinor,0);
 await login(db,MANAGER_AUTH);
 const command=deliveryCommand(), payload={orderId:order.id,receivedMinor:0,identityConfirmed:true};
 const result=await storeAction(db,'verify_order',payload,command);assert.equal(result.status,'enrolled');
 assert.deepEqual(await storeAction(db,'verify_order',payload,command),result);
 assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from academy.enrollments where id=$1',[result.enrollmentId])).rows[0].n,1);
 assert.equal((await call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:result.enrollmentId})).trainingAllowed,true);
});

test('installment checkout snapshots the approved plan and verifies only its first due payment',async t=>{
 const db=await deliverySetup();t.after(()=>db.close());const offer=await checkoutOffer(db);
 const terms=[{amountMinor:4000,dueDays:0},{amountMinor:6000,dueDays:30}];
 await deliveryAction(db,'save_offer',{courseId:offer.courseId,runId:offer.runId,learningMode:'cohort',expectedVersion:2,netMinor:10000,installmentTerms:terms});
 await login(db,null);
 const order=await call(db,'public.v1_academy_store_order',{p_slug:'marktone',p_action:'create_order',p_command_id:deliveryCommand(),p_payload:{offerId:offer.offerId,learner:{name:'Installment learner',phone:'0509999902',email:'installment@example.test'},payerIsLearner:true,tokenHash:'d'.repeat(64),acceptedPolicy:true,paymentPlan:'installments'}});
 assert.equal(order.totalMinor,10000);assert.equal(order.requiredMinor,4000);assert.equal(order.paymentSchedule.length,2);
 await call(db,'public.v1_academy_store_order',{p_slug:'marktone',p_action:'report_transfer',p_command_id:deliveryCommand(),p_payload:{orderId:order.id,tokenHash:'d'.repeat(64),reference:'FIRST-INSTALLMENT'}});
 await login(db,MANAGER_AUTH);
 await assert.rejects(storeAction(db,'verify_order',{...verificationPayload(order),receivedMinor:10000}),/academy_received_amount_mismatch/);
 const result=await storeAction(db,'verify_order',{...verificationPayload(order),receivedMinor:4000});
 assert.equal(result.status,'enrolled');
 const access=await call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:result.enrollmentId});
 assert.equal(access.trainingAllowed,true);assert.equal(access.certificationAllowed,false);assert.equal(access.outstandingMinor,6000);
 assert.equal((await db.query('select count(*)::int n from accounting_core.payment_schedules')).rows[0].n,2);
 await deliveryAction(db,'save_offer',{courseId:offer.courseId,runId:offer.runId,learningMode:'cohort',expectedVersion:3,netMinor:10000,installmentTerms:[{amountMinor:2000,dueDays:0},{amountMinor:8000,dueDays:60}]});
 const original=(await db.query('select payment_schedule,handoff_id,invoice_id from academy.store_orders where id=$1',[order.id])).rows[0];assert.equal(original.payment_schedule[0].amountMinor,4000);
 await db.query('update academy.delivery_settings set enabled=false where tenant_id=$1',[T]);
 assert.equal((await call(db,'private_app.admission_financial_eligibility_v1',{p_tenant_id:T,p_handoff_id:original.handoff_id})).eligible,true,'rollback must preserve existing enrollment installment eligibility');
 await db.query("update accounting_core.payment_schedules set due_date=current_date-90 where invoice_id=$1 and installment_number=2",[original.invoice_id]);
 const overdue=await call(db,'private_app.training_journey_financial_access_v1',{p_enrollment_id:result.enrollmentId});
 assert.equal(overdue.trainingAllowed,true,'existing ODEIR governance continues study while collections handle arrears');
 assert.equal(overdue.automaticFinancialSuspension,false);assert.equal(overdue.certificationAllowed,false);
 assert.ok(overdue.financialWarnings.includes('installment_grace_expired'));

});

test('paid existing checkout still uses a full, verified canonical payment',async t=>{
 const db=await deliverySetup();t.after(()=>db.close());const offer=await checkoutOffer(db),order=await checkoutOrder(db,offer.offerId,999903);
 const result=await storeAction(db,'verify_order',verificationPayload(order));assert.equal(result.status,'enrolled');
 assert.equal((await db.query('select sum(amount_minor)::int total from accounting_core.payments where tenant_id=$1',[T])).rows[0].total,10000);
});
