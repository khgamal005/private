import {readFile} from 'node:fs/promises';
import {academySetup,configure,platformAction,call,login,id,T,MANAGER,MANAGER_AUTH,ADMIN_AUTH} from './academy-platform-database.mjs';
export {call,login,id,T,MANAGER,MANAGER_AUTH};
const read=path=>readFile(new URL(`../../${path}`,import.meta.url),'utf8');
let sequence=50000;
export const nextCommand=()=>id(sequence++);
export const storeAction=(db,action,payload,commandId=nextCommand())=>call(db,'public.v1_academy_commerce_action',{p_slug:'marktone',p_action:action,p_command_id:commandId,p_payload:payload});
export const requestAction=(db,action,payload,commandId=nextCommand())=>call(db,'public.v1_academy_request_action',{p_slug:'marktone',p_action:action,p_command_id:commandId,p_payload:payload});
export async function checkoutSetup({database=null}={}){
  const db=await academySetup({governance:true,database});
  try{
    const identity=await read('supabase/migrations/20260806190000_customer_identity_integrity_v1.sql');
    await db.exec(identity.slice(identity.indexOf('create or replace function private_app.normalize_lead_phone'),identity.indexOf('revoke all on function private_app.normalize_lead_phone')));
    await db.exec("alter table academy.courses add column if not exists program_kind text check(program_kind in ('short_course','diploma'));");
    await db.exec(await read('supabase/migrations/20260922123859_academy_native_course_store.sql'));
    // Explicit isolated trial proves that no legacy Odeir subscription or staff
    // membership is needed. Only catalogue discovery is a fixture seam.
    await db.query("select set_config('fixture.addon','no',false)");
    await login(db,ADMIN_AUTH);
    const accessUntil=(await db.query("select (now()+interval '1 day')::text value")).rows[0].value;
    await configure(db,{accessUntil,reason:'Disposable concurrency fixture trial'});
    await platformAction(db,'set_member',{email:'manager@example.test',role:'manager',status:'active'});
    await db.query('insert into academy.admission_governance_settings(tenant_id,enabled) values($1,true)',[T]);
    await login(db,MANAGER_AUTH);
    await storeAction(db,'save_settings',{currency:'SAR',taxRegistered:false,taxRateBps:1500,checkoutEnabled:true,bankName:'Fixture bank',accountName:'Fixture academy',iban:'SA1234567890123456789012',refundPolicy:'Fixture approved registration and refund terms.'});
    return db;
  }catch(error){await db.close();delete error.query;throw error;}
}
export async function checkoutOffer(db,{capacity=2}={}){
  const saved=await storeAction(db,'save_offer',{title:'Concurrency course',courseCode:`RACE-${sequence}`,description:'Disposable course for actual transaction concurrency.',programKind:'short_course',learningMode:'cohort',netMinor:10000,capacity,startsAt:'2030-01-01T10:00:00Z',endsAt:'2030-02-01T10:00:00Z'});
  // Content publication has its own integration suite. A reviewed immutable
  // version is seeded here; all checkout and transfer functions are real SQL.
  await db.query("insert into academy.training_course_versions(tenant_id,course_id,version,title,learning_mode,status,policy,created_by_subject_id,reviewed_by_subject_id,published_at) values($1,$2,1,'Reviewed race content','live','published',$3,$4,$4,now())",[T,saved.courseId,JSON.stringify({minAssessmentPercent:70,minAttendancePercent:75,requireCompletedRun:false,certificateEnabled:true,termsVersion:'2026',supportEmail:'support@example.test'}),MANAGER]);
  await storeAction(db,'publish_offer',{offerId:saved.offerId,expectedVersion:1,published:true});
  return saved;
}
export async function checkoutOrder(db,offerId,number){
  const tokenHash='e'.repeat(64);
  await login(db,null);
  const order=await call(db,'public.v1_academy_store_order',{p_slug:'marktone',p_action:'create_order',p_command_id:nextCommand(),p_payload:{offerId,learner:{name:`Race learner ${number}`,phone:`050${String(number).padStart(7,'0')}`,email:`race${number}@example.test`},payerIsLearner:true,tokenHash,acceptedPolicy:true}});
  await call(db,'public.v1_academy_store_order',{p_slug:'marktone',p_action:'report_transfer',p_command_id:nextCommand(),p_payload:{orderId:order.id,tokenHash,reference:`TRANSFER-${number}`}});
  await login(db,MANAGER_AUTH);
  return order;
}
export const verificationPayload=order=>({orderId:order.id,receivedMinor:order.totalMinor,bankReference:`BANK-${order.id}`,receivedAt:new Date(Date.now()-60000).toISOString(),identityConfirmed:true});
