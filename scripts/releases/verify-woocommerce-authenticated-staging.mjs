import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

// Release-only test. Fixed STAGING target. No production endpoint, forged JWT,
// SET ROLE, customer impersonation, migration execution or credential artifact.
const REF='pzflscqwfkixclmjyran',SUPABASE=`https://${REF}.supabase.co`,ORIGIN='http://127.0.0.1:4727';
const token=process.env.ODEIR_STAGING_MANAGEMENT_TOKEN;
const evidence={success:false,stagingProject:REF,productionRequests:0,checks:[],fixturesQuarantined:false};
const users=[];let secret,publishable,server,seeded=false,phase='authorization',failure;
const ids=Object.fromEntries(['tenant','organization','buyer','course','run1','run2','connection','entity','task','work','department','handoff'].map(key=>[key,randomUUID()]));
const slug=`qa-woo-auth-${randomUUID().replaceAll('-','')}`;
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const json=value=>`${q(JSON.stringify(value))}::jsonb`;
const mask=value=>{if(value)console.log(`::add-mask::${value}`);};
async function request(url,options={}){
 const response=await fetch(url,{...options,signal:AbortSignal.timeout(30000)});
 let data;try{data=await response.json();}catch{throw new Error(`${phase}: invalid response (${response.status})`);}
 if(!response.ok)throw new Error(`${phase}: HTTP ${response.status}`);
 return data;
}
const management=(path,body)=>request(`https://api.supabase.com/v1/projects/${REF}${path}`,{
 method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const sql=query=>management('/database/query',{query});
const auth=(path,body,method='POST')=>request(`${SUPABASE}/auth/v1/${path}`,{
 method,headers:{apikey:secret,Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function app(action,body,cookie,expected=200){
 const response=await fetch(`${ORIGIN}/api/tenant/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN,'Sec-Fetch-Site':'same-origin',Cookie:cookie},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,expected,`${phase}: app status`);
 const data=await response.json();return data.data??data;
}
async function login(user){
 const response=await fetch(`${ORIGIN}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:JSON.stringify({email:user.email,password:user.password}),signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,200,`${phase}: genuine password login`);
 const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const access=cookie.match(/(?:^|; )mt_access=([^;]+)/)?.[1];assert.ok(access,`${phase}: session cookie`);mask(access);
 return {cookie,access};
}
const snapshot=async session=>request(`${SUPABASE}/rest/v1/rpc/v3_tenant_admissions_snapshot`,{method:'POST',headers:{apikey:publishable,Authorization:`Bearer ${session.access}`,'Content-Type':'application/json'},body:JSON.stringify({p_slug:slug})});
try{
 assert.ok(token,'Staging management credential is unavailable; no data was changed.');mask(token);
 const project=await management('');assert.equal(project.id??project.ref,REF);assert.match(project.name,/staging/i);
 const installed=await sql("select to_regprocedure('public.v1_tenant_woocommerce_save_beneficiaries(text,uuid,text,uuid,jsonb)') is not null as ready");
 assert.equal(installed[0].ready,true,'Reviewed migration must be installed on staging first.');
 const keys=await management('/api-keys?reveal=true');
 secret=keys.find(key=>key.type==='secret')?.api_key||keys.find(key=>key.name==='service_role')?.api_key;
 publishable=keys.find(key=>key.type==='publishable')?.api_key||keys.find(key=>key.name==='anon')?.api_key;
 assert.ok(secret&&publishable,'Staging Auth credentials unavailable.');mask(secret);mask(publishable);
 phase='create isolated Auth accounts';
 for(const role of ['sales_user','sales_manager','customer_service']){
  const password=randomBytes(30).toString('base64url');mask(password);
  const email=`${role}-${slug}@example.com`;
  const user=await auth('admin/users',{email,password,email_confirm:true,user_metadata:{full_name:`QA ${role}`,qaRun:slug}});
  assert.match(user.id,/^[0-9a-f-]{36}$/i);users.push({id:user.id,email,password,role,subject:randomUUID(),membership:randomUUID(),staff:randomUUID()});
 }
 phase='seed isolated business fixture';
 const seller=users[0],registrar=users[2];
 await sql(`begin;
 insert into core.organizations(id,organization_key,legal_name,display_name,metadata) values(${q(ids.organization)},${q(slug)},'QA WooCommerce','QA WooCommerce',${json({qaRun:slug})});
 insert into core.tenants(id,organization_id,tenant_key,slug,name,status,settings) values(${q(ids.tenant)},${q(ids.organization)},${q(slug)},${q(slug)},'QA WooCommerce authenticated','active',${json({qaRun:slug})});
 insert into people.departments(id,tenant_id,department_key,name_ar) values(${q(ids.department)},${q(ids.tenant)},'admissions','التسجيل والقبول');
 ${users.map(u=>`insert into access_control.subjects(id,auth_user_id,email,full_name,status,must_change_password) values(${q(u.subject)},${q(u.id)},${q(u.email)},${q('QA '+u.role)},'active',false);
 insert into access_control.memberships(id,subject_id,tenant_id,scope,status) values(${q(u.membership)},${q(u.subject)},${q(ids.tenant)},'tenant','active');
 insert into access_control.membership_roles(membership_id,role_id) select ${q(u.membership)}::uuid,id from access_control.roles where scope='tenant' and tenant_id is null and role_key=${q(u.role)};
 insert into people.staff_profiles(id,tenant_id,membership_id,full_name,job_title,role_key,department_id,account_status) values(${q(u.staff)},${q(ids.tenant)},${q(u.membership)},${q('QA '+u.role)},'QA',${q(u.role)},${u.role==='customer_service'?q(ids.department):'null'},'active');`).join('\n')}
 insert into academy.courses(id,tenant_id,course_code,title_ar,category) values(${q(ids.course)},${q(ids.tenant)},'QA-CAPM','اختبار المستفيدين','QA');
 insert into academy.course_runs(id,tenant_id,course_id,run_code,title,delivery_mode,status,capacity,starts_at) values(${q(ids.run1)},${q(ids.tenant)},${q(ids.course)},'QA-A','دفعة اختبار أولى','online','open',1,now()+interval '10 days'),(${q(ids.run2)},${q(ids.tenant)},${q(ids.course)},'QA-B','دفعة اختبار ثانية','online','open',2,now()+interval '20 days');
 insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id) values(${q(ids.buyer)},${q(ids.tenant)},'صاحب طلب اختبار','0500000101',${q(seller.staff)});
 insert into commerce_sync.connections(id,tenant_id,store_url,status,frequency) values(${q(ids.connection)},${q(ids.tenant)},'https://example.invalid','disabled','manual');
 insert into commerce_sync.external_entities(id,tenant_id,connection_id,entity_type,external_id,raw_payload) values(${q(ids.entity)},${q(ids.tenant)},${q(ids.connection)},'orders','99999991',${json({id:99999991,status:'completed',currency:'SAR',total:'1398.60',refunds:[],_marktone:{paidAt:'2026-09-11T10:00:00Z'},line_items:[{id:101,name:'QA CAPM',product_id:101,variation_id:0,quantity:2,total:'1398.60',total_tax:'0.00'}]})});
 insert into sales_core.commerce_order_routing_settings(tenant_id,enabled_at) values(${q(ids.tenant)},now()-interval '2 days') on conflict(tenant_id) do nothing;
 insert into work_core.tasks(id,tenant_id,task_key,title,status,assigned_staff_id,contact_id,due_at,metadata) values(${q(ids.task)},${q(ids.tenant)},'qa-woo','طلب اختبار مستفيدين','todo',${q(seller.staff)},${q(ids.buyer)},now()+interval '1 day','{"source":"woocommerce_order"}');
 insert into sales_core.commerce_order_work_items(id,tenant_id,connection_id,external_entity_id,external_order_id,order_number,order_status,payment_state,amount_minor,paid_at,task_id,contact_id,assigned_staff_id,routing_state) values(${q(ids.work)},${q(ids.tenant)},${q(ids.connection)},${q(ids.entity)},'99999991','99999991','completed','paid',139860,'2026-09-11T10:00:00Z',${q(ids.task)},${q(ids.buyer)},${q(seller.staff)},'assigned');
 insert into sales_core.commerce_admission_rollouts(tenant_id,enabled,enabled_at) values(${q(ids.tenant)},true,now()-interval '1 day');
 insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,assigned_staff_id,status,payment_status,payment_verified_at,payment_amount_minor,payment_reference) values(${q(ids.handoff)},${q(ids.tenant)},'qa-legacy',${q(ids.buyer)},${q(ids.course)},${q(registrar.staff)},'in_review','verified',now(),139860,'99999991');
 commit;`);seeded=true;
 phase='start staging-connected Next server';
 const childEnv={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',SUPABASE_URL:SUPABASE,NEXT_PUBLIC_SUPABASE_URL:SUPABASE,SUPABASE_PUBLISHABLE_KEY:publishable,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:publishable};
 server=spawn('node',['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','4727'],{env:childEnv,stdio:'ignore'});
 let ready=false;for(let n=0;n<90;n++){assert.equal(server.exitCode,null,'Next exited');try{const r=await fetch(`${ORIGIN}/login`,{signal:AbortSignal.timeout(2000)});if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}assert.ok(ready,'Next did not start');
 const sessions=[];for(const user of users)sessions.push(await login(user));const [sales,manager,admission]=sessions;
 evidence.checks.push('genuine-password-login-three-roles');
 phase='ordinary historical enrollment';
 await app('update-admission',{p_tenant_slug:slug,p_handoff_id:ids.handoff,p_action:'complete',p_course_run_id:ids.run1},admission.cookie);
 const before=(await sql(`select to_jsonb(e) as enrollment,h.payment_amount_minor,h.payment_reported_at,h.completed_at,h.course_run_id from academy.enrollments e join academy.registration_handoffs h on h.id=e.handoff_id where e.tenant_id=${q(ids.tenant)} and h.id=${q(ids.handoff)}`))[0];assert.ok(before?.enrollment);
 phase='beneficiary save and replay';
 const getContext=()=>app('woocommerce-admission-context',{p_tenant_slug:slug,p_task_id:ids.task},sales.cookie);
 let ctx=await getContext();assert.ok(ctx.blockers.includes('woocommerce_beneficiaries_required'));
 const save={action:'save',p_tenant_slug:slug,p_task_id:ids.task,p_expected_revision:ctx.revision,p_command_id:randomUUID(),p_lines:[{lineId:'101',beneficiaries:[{contactId:ids.buyer},{name:'مستفيد اختبار ثان',phone:'0500000102'}]}]};
 assert.equal((await app('woocommerce-beneficiaries',save,sales.cookie)).count,2);
 assert.equal((await app('woocommerce-beneficiaries',save,sales.cookie)).replayed,true);
 ctx=await getContext();assert.equal(ctx.beneficiariesValid,true);
 const lines=[{lineId:'101',courseId:ids.course,handoffId:ids.handoff}];
 phase='manager review and sales handoff';
 await app('woocommerce-admission-action',{p_tenant_slug:slug,p_task_id:ids.task,p_action:'review',p_expected_revision:ctx.revision,p_command_id:randomUUID(),p_lines:lines,p_reason:'مطابقة طلب الاختبار مع التسجيل السابق دون تكرار الدفع'},manager.cookie);
 ctx=await getContext();assert.equal(ctx.reviewValid,true);
 assert.equal((await app('woocommerce-admission-action',{p_tenant_slug:slug,p_task_id:ids.task,p_action:'complete',p_expected_revision:ctx.revision,p_command_id:randomUUID(),p_lines:lines},sales.cookie)).completed,true);
 evidence.checks.push('save-idempotency','historical-payment-review','manager-to-sales-handoff');
 phase='real admissions read';
 let item=(await snapshot(admission)).cases.find(row=>row.id===ids.handoff);assert.equal(item.beneficiaries.length,2);assert.equal(item.originalStatus,'completed');assert.equal(item.status,'in_review');
 const old=item.beneficiaries.find(seat=>seat.contactId===ids.buyer),pending=item.beneficiaries.find(seat=>!seat.enrollmentId);assert.equal(old.enrollmentId,before.enrollment.id);assert.ok(pending);
 const enrollment={action:'enroll',p_tenant_slug:slug,p_handoff_id:ids.handoff,p_expected_revision:item.beneficiaryRevision,p_command_id:randomUUID(),p_seats:[{id:pending.id,courseRunId:ids.run1}]};
 phase='sales denied and full batch rejected';
 await app('woocommerce-beneficiaries',enrollment,sales.cookie,403);
 await app('woocommerce-beneficiaries',enrollment,admission.cookie,400);
 phase='enrollment and replay';enrollment.p_seats[0].courseRunId=ids.run2;
 const result=await app('woocommerce-beneficiaries',enrollment,admission.cookie);assert.equal(result.enrolled,1);assert.equal(result.remaining,0);
 assert.equal((await app('woocommerce-beneficiaries',enrollment,admission.cookie)).replayed,true);
 item=(await snapshot(admission)).cases.find(row=>row.id===ids.handoff);assert.equal(item.status,'completed');assert.ok(item.beneficiaries.every(seat=>seat.enrollmentId));
 const after=(await sql(`select to_jsonb(e) as enrollment,h.payment_amount_minor,h.payment_reported_at,h.completed_at,h.course_run_id from academy.enrollments e join academy.registration_handoffs h on h.id=e.handoff_id where e.tenant_id=${q(ids.tenant)} and e.id=${q(before.enrollment.id)}`))[0];assert.deepEqual(after,before,'Historical enrollment and financial fields must remain unchanged');
 const counts=(await sql(`select (select count(*)::int from academy.enrollments where tenant_id=${q(ids.tenant)}) as enrollments,(select count(*)::int from academy.registration_handoffs where tenant_id=${q(ids.tenant)}) as payments,(select sum(payment_amount_minor)::bigint from academy.registration_handoffs where tenant_id=${q(ids.tenant)}) as amount`))[0];assert.equal(counts.enrollments,2);assert.equal(counts.payments,1);assert.equal(Number(counts.amount),139860);
 evidence.checks.push('sales-cannot-enroll','capacity-guard','independent-batches','enroll-idempotency','historical-rows-unchanged','one-payment-139860-minor-two-learners');evidence.success=true;
}catch(error){failure=new Error(`${phase}: ${error.message}`);evidence.failedPhase=phase;evidence.success=false;}
finally{
 server?.kill('SIGTERM');
 let cleanup=true;
 if(seeded){try{await sql(`begin;update access_control.memberships set status='revoked' where tenant_id=${q(ids.tenant)};update core.tenants set status='closed' where id=${q(ids.tenant)} and slug=${q(slug)} and settings->>'qaRun'=${q(slug)};commit;`);}catch{cleanup=false;}}
 for(const user of users){try{await auth(`admin/users/${user.id}`,{ban_duration:'876000h'},'PUT');}catch{cleanup=false;}}
 evidence.fixturesQuarantined=cleanup;evidence.success=evidence.success&&cleanup;
 await writeFile('/tmp/woocommerce-authenticated-staging-evidence.json',JSON.stringify(evidence,null,2));
 if(!cleanup&&!failure)failure=new Error('Fixture quarantine failed; release remains blocked.');
}
if(failure)throw failure;
console.log('Authenticated staging HTTP checks passed. No production requests. Temporary accounts disabled; synthetic history retained only in closed staging tenant.');
