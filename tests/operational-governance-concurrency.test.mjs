import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {setup} from './fixtures/operational-governance-database.mjs';
import {call,id,login,T,ADMIN,STAFF,CONTACT,COURSE,ACCOUNT} from './fixtures/training-journey-database.mjs';

const databaseUrl=process.env.GOVERNANCE_TEST_DATABASE_URL;

function disposableUrl(value){
  const parsed=new URL(value);
  assert.ok(['postgres:','postgresql:'].includes(parsed.protocol),'PostgreSQL URL required');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'Only a loopback disposable test server is permitted');
  assert.equal(parsed.pathname,'/governance_concurrency','Dedicated governance_concurrency database required');
  assert.equal(parsed.search,'','URL connection overrides are forbidden');
  assert.equal(parsed.hash,'','URL fragments are forbidden');
  return parsed.toString();
}

async function blockedBarrier(controller,pids,controllerPid){
  const deadline=performance.now()+5_000;
  while(performance.now()<deadline){
    await controller.query('select pg_stat_clear_snapshot()');
    const {rows}=await controller.query('select pid,wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=any($1::int[])',[pids]);
    const indexed=new Map(rows.map(row=>[row.pid,row]));
    const reaches=(pid,seen=new Set())=>{
      if(pid===controllerPid)return true;
      if(seen.has(pid))return false;seen.add(pid);
      return (indexed.get(pid)?.blockers||[]).some(blocker=>reaches(blocker,seen));
    };
    if(pids.every(pid=>indexed.get(pid)?.wait_event_type==='Lock'&&reaches(pid)))return;
    await yieldTurn();
  }
  throw new Error('Expected independent backends did not reach the controlled lock barrier');
}

async function transaction(client,operation){
  try{
    await client.query('begin');const value=await operation(client);await client.query('commit');
    return {ok:true,value};
  }catch(error){
    await client.query('rollback');return {ok:false,error:{code:error.code,message:error.message}};
  }
}

async function race(controller,workers,lock,operations){
  await controller.query('begin');let pending;
  try{
    await lock(controller);
    const controllerPid=(await controller.query('select pg_backend_pid() pid')).rows[0].pid;
    const pids=await Promise.all(workers.map(async worker=>(await worker.query('select pg_backend_pid() pid')).rows[0].pid));
    assert.equal(new Set([controllerPid,...pids]).size,workers.length+1,'Actual independent PostgreSQL backends required');
    pending=workers.map((worker,index)=>transaction(worker,operations[index]));
    await blockedBarrier(controller,pids,controllerPid);
    await controller.query('commit');return await Promise.all(pending);
  }finally{
    await controller.query('rollback');if(pending)await Promise.all(pending);
  }
}

const createOpportunity=(db,overrides={})=>call(db,'public.v3_tenant_create_opportunity',{
  p_tenant_slug:'marktone',p_contact_id:CONTACT,p_title:'Concurrent synthetic sale',p_course_id:COURSE,
  p_value_minor:10000,p_next_action_type:'call',p_next_action_at:'2027-10-20T08:00:00Z',
  p_command_id:id(42001),...overrides
});
const phoneLock=client=>client.query('select pg_advisory_xact_lock(hashtextextended($1,1729))',[T]);
const contactLock=client=>client.query('select pg_advisory_xact_lock(hashtextextended($1,31603))',[`${T}:${CONTACT}`]);
const accountingAction=(db,action,commandId,payload)=>call(db,'public.v1_tenant_accounting_action',{
  p_slug:'marktone',p_action:action,p_payload:{commandId,...payload}
});
const diplomaAction=(db,action,commandId,payload)=>call(db,'public.v1_tenant_diploma_action',{
  p_slug:'marktone',p_action:action,p_command_id:commandId,p_payload:payload
});

test('real PostgreSQL serializes governance identity, sales tasks, seats, queue claims, money and contract revisions',{
  skip:!databaseUrl&&'Requires explicit disposable loopback GOVERNANCE_TEST_DATABASE_URL',timeout:90_000
},async t=>{
  const {Client}=await import('pg'); // Pinned CI-only driver; never application credentials.
  const connectionString=disposableUrl(databaseUrl);const clients=[];
  t.after(async()=>Promise.allSettled(clients.map(client=>client.end())));
  for(const label of ['controller','worker-a','worker-b']){
    const client=new Client({connectionString,application_name:`governance-concurrency-${label}`,
      connectionTimeoutMillis:5_000,statement_timeout:15_000,lock_timeout:10_000});
    clients.push(client);await client.connect();
  }
  const [controller,...workers]=clients;
  assert.equal((await controller.query('select current_database() name')).rows[0].name,'governance_concurrency');
  assert.equal((await controller.query("select count(*)::int n from pg_namespace where nspname in ('academy','access_control','sales_core','work_core','accounting_core','core')")).rows[0].n,0,
    'Refusing to overwrite an existing database; provide a fresh disposable service');
  const db={query:(sql,params)=>controller.query(sql,params),exec:sql=>controller.query(sql),close:async()=>{}};
  await setup({database:db});
  for(const worker of workers){await login(worker);await worker.query("select set_config('fixture.addon','no',false)");}
  await db.query("insert into sales_core.pipeline_stages(tenant_id,stage_key,name_ar) values($1,'new_lead','New synthetic sale')",[T]);

  await t.test('two differently formatted primary phones create exactly one canonical customer',async()=>{
    const contacts=[id(42100),id(42101)];const phone=['0558880001','+966 55 888 0001'];
    const results=await race(controller,workers,phoneLock,contacts.map((contact,index)=>client=>client.query(
      "insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id) values($1,$2,'Synthetic phone race',$3,$4) returning id",
      [contact,T,phone[index],STAFF])));
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>!result.ok&&result.error.code==='23505').length,1,JSON.stringify(results));
    assert.equal((await db.query('select count(*)::int n from sales_core.contacts where id=any($1::uuid[])',[contacts])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from sales_core.contact_identities where tenant_id=$1 and identity_type='phone' and identity_value='966558880001'",[T])).rows[0].n,1);
  });

  await t.test('a primary phone and an additional phone cannot claim the same identity concurrently',async()=>{
    const results=await race(controller,workers,phoneLock,[
      client=>client.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id) values($1,$2,'Synthetic cross-slot race','0558880002',$3) returning id",[id(42102),T,STAFF]),
      client=>client.query("insert into sales_core.contact_identities(tenant_id,contact_id,identity_type,identity_value,source_slot,is_alias) values($1,$2,'phone','966558880002','additional_phone',true) returning id",[T,CONTACT])
    ]);
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>!result.ok&&result.error.code==='23505').length,1,JSON.stringify(results));
    assert.equal((await db.query("select count(*)::int n from sales_core.contact_identities where tenant_id=$1 and identity_type='phone' and identity_value='966558880002'",[T])).rows[0].n,1);
  });

  await t.test('simultaneous retries of one opportunity command commit one opportunity and one task',async()=>{
    const results=await race(controller,workers,contactLock,workers.map(()=>client=>createOpportunity(client)));
    assert.equal(results.filter(result=>result.ok).length,2,JSON.stringify(results));
    assert.equal(results[0].value.id,results[1].value.id);
    assert.equal(results.filter(result=>result.value.replayed===true).length,1);
    assert.equal((await db.query("select count(*)::int n from sales_core.opportunities where tenant_id=$1 and metadata->>'creationCommandId'=$2",[T,id(42001)])).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from work_core.tasks where tenant_id=$1 and contact_id=$2 and status in ('todo','in_progress') and metadata->>'source'='opportunity_next_action'",[T,CONTACT])).rows[0].n,1);
  });

  await t.test('concurrent purchases for separate programs reuse one earliest customer task',async()=>{
    const courses=[id(42011),id(42012)];
    for(let index=0;index<courses.length;index++)await db.query("insert into academy.courses(id,tenant_id,course_code,title_ar,category) values($1,$2,$3,'Synthetic concurrent program','Training')",[courses[index],T,`RACE-PROGRAM-${index}`]);
    const results=await race(controller,workers,contactLock,courses.map((course,index)=>client=>createOpportunity(client,{
      p_course_id:course,p_command_id:id(42020+index),p_next_action_at:index===0?'2027-10-03T08:00:00Z':'2027-10-02T08:00:00Z'
    })));
    assert.equal(results.filter(result=>result.ok).length,2,JSON.stringify(results));
    assert.equal(results[0].value.taskId,results[1].value.taskId);
    const tasks=(await db.query("select id,opportunity_id,due_at from work_core.tasks where tenant_id=$1 and contact_id=$2 and status in ('todo','in_progress') and metadata->>'source'='opportunity_next_action'",[T,CONTACT])).rows;
    assert.equal(tasks.length,1);assert.equal(tasks[0].opportunity_id,results[1].value.id);
    assert.equal(tasks[0].due_at.toISOString(),'2027-10-02T08:00:00.000Z');
  });

  await t.test('allocation and refund cannot concurrently consume the same verified payment',async()=>{
    const invoice=id(42400);
    await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,customer_name_snapshot,subtotal_minor,total_minor,currency) values($1,$2,'invoice','GOV-RACE-INVOICE','issued',$3,'Synthetic payer',10000,10000,'SAR')",[invoice,T,ACCOUNT]);
    const {paymentId}=await accountingAction(db,'record_payment',id(42401),{
      customerAccountId:ACCOUNT,amountMinor:10000,currency:'SAR',method:'cash',receivedAt:'2026-09-01T12:00:00Z',
      externalReference:'synthetic-governance-race',verifyNow:true
    });
    const commands=[id(42402),id(42403)];
    const results=await race(controller,workers,client=>client.query('select id from accounting_core.payments where tenant_id=$1 and id=$2 for update',[T,paymentId]),[
      client=>accountingAction(client,'allocate_payment',commands[0],{paymentId,invoiceId:invoice,amountMinor:10000}),
      client=>accountingAction(client,'request_refund',commands[1],{paymentId,amountMinor:10000,effect:'credit_transfer',reason:'Synthetic future registration credit'})
    ]);
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    const loser=results.find(result=>!result.ok);
    assert.match(loser.error.message,/^(refund_invoice_required|payment_allocation_exceeds_available)$/);
    const conservation=(await db.query(`select p.amount_minor::int received,
      (select coalesce(sum(a.amount_minor),0)::int from accounting_core.payment_allocations a where a.tenant_id=p.tenant_id and a.payment_id=p.id) allocated,
      (select coalesce(sum(r.amount_minor),0)::int from accounting_core.refunds r where r.tenant_id=p.tenant_id and r.payment_id=p.id and r.invoice_id is null and r.status in ('requested','approved','completed')) reserved
      from accounting_core.payments p where p.tenant_id=$1 and p.id=$2`,[T,paymentId])).rows[0];
    assert.equal(conservation.received,10000);
    assert.equal(conservation.allocated+conservation.reserved,conservation.received);
    assert.equal(BigInt(await call(db,'private_app.accounting_payment_available_v1',{p_tenant:T,p_payment:paymentId})),0n);
    assert.equal((await db.query('select count(*)::int n from accounting_core.commands where tenant_id=$1 and command_id=any($2::uuid[])',[T,commands])).rows[0].n,1,'Failed competing command must roll back its audit and command row');
  });

  await t.test('same-version diploma reschedules append exactly one revision and preserve the original schedule',async()=>{
    const course=id(42500),handoff=id(42501);
    await db.query("insert into academy.courses(id,tenant_id,course_code,title_ar,category) values($1,$2,'GOV-RACE-DIPLOMA','Synthetic concurrent diploma','Training')",[course,T]);
    await call(db,'public.v1_tenant_classify_program',{p_slug:'marktone',p_course_id:course,p_kind:'diploma',p_expected_kind:null,p_command_id:id(42509)});
    await db.query('insert into academy.diploma_settings(tenant_id,enabled) values($1,true)',[T]);
    await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id) values($1,$2,'GOV-RACE-DIPLOMA-HANDOFF',$3,$4)",[handoff,T,CONTACT,course]);
    const plan=[{id:id(42510),dueOn:'2027-01-01',amountMinor:10000},{id:id(42511),dueOn:'2027-02-01',amountMinor:10000}];
    const {contractId}=await diplomaAction(db,'create',id(42502),{
      handoffId:handoff,payerAccountId:ACCOUNT,collectionOwnerId:STAFF,startsOn:'2027-01-01',totalMinor:20000,currency:'SAR',installments:plan
    });
    await diplomaAction(db,'approve',id(42503),{contractId,expectedVersion:1});
    const commands=[id(42504),id(42505)],dates=['2027-03-01','2027-04-01'];
    // Admissions and contracts both lock handoff before contract. Holding the
    // same first row verifies the real lock order without introducing a cycle.
    const results=await race(controller,workers,client=>client.query('select id from academy.registration_handoffs where tenant_id=$1 and id=$2 for update',[T,handoff]),
      dates.map((date,index)=>client=>diplomaAction(client,'reschedule',commands[index],{
        contractId,expectedVersion:1,reason:'Synthetic approved schedule adjustment',installments:[plan[0],{...plan[1],dueOn:date}]
      })));
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>!result.ok&&result.error.message==='diploma_changed').length,1,JSON.stringify(results));
    assert.equal((await db.query('select current_version from academy.diploma_contracts where tenant_id=$1 and id=$2',[T,contractId])).rows[0].current_version,2);
    const history=(await db.query('select version,id,due_on::text,amount_minor::int from academy.diploma_installments where tenant_id=$1 and contract_id=$2 order by version,position',[T,contractId])).rows;
    assert.equal(history.length,4);
    assert.deepEqual(history.slice(0,2),plan.map(item=>({version:1,id:item.id,due_on:item.dueOn,amount_minor:item.amountMinor})));
    assert.equal(history[3].due_on,dates[results.findIndex(result=>result.ok)]);
    assert.equal((await db.query('select count(*)::int n from academy.diploma_schedule_versions where tenant_id=$1 and contract_id=$2',[T,contractId])).rows[0].n,2);
    assert.equal((await db.query("select count(*)::int n from academy.diploma_events where tenant_id=$1 and contract_id=$2 and kind='reschedule'",[T,contractId])).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from academy.diploma_commands where tenant_id=$1 and command_id=any($2::uuid[])',[T,commands])).rows[0].n,1);
  });

  await t.test('the governed enrollment trigger admits only one concurrent claim on a final seat',async()=>{
    await db.query('insert into academy.admission_governance_settings(tenant_id,enabled,finance_owner_staff_id,placement_owner_staff_id,approved_by_subject_id) values($1,true,$2,$2,$3)',[T,STAFF,ADMIN]);
    await db.query("update academy.courses set program_kind='short_course' where id=$1",[COURSE]);
    const run=id(42200);await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,title,delivery_mode,status,capacity) values($1,$2,$3,'GOV-RACE-LAST-SEAT','Synthetic final seat','hybrid','open',1)",[run,T,COURSE]);
    const candidates=[];
    for(let index=0;index<2;index++){
      const contact=id(42210+index),student=id(42220+index),handoff=id(42230+index);
      await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone) values($1,$2,'Synthetic seat claimant',$3)",[contact,T,`055889000${index}`]);
      await db.query("insert into academy.students(id,tenant_id,student_key,student_number,contact_id,full_name) values($1,$2,$3,$3,$4,'Synthetic seat claimant')",[student,T,`SEAT-${index}`,contact]);
      await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,course_run_id) values($1,$2,$3,$4,$5,$6)",[handoff,T,`SEAT-HANDOFF-${index}`,contact,COURSE,run]);
      await db.query("insert into academy.admission_governance_exceptions(tenant_id,kind,handoff_id,agreed_course_id,reason,approved_by_subject_id) values($1,'payment_waiver',$2,$3,'Synthetic approved waiver for concurrency test',$4)",[T,handoff,COURSE,ADMIN]);
      candidates.push({student,handoff});
    }
    const results=await race(controller,workers,client=>client.query('select id from academy.course_runs where id=$1 for update',[run]),
      candidates.map(({student,handoff},index)=>client=>client.query("insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id,status) values($1,$2,$3,$4,$5,$6,'confirmed') returning id",[T,`SEAT-ENROLLMENT-${index}`,handoff,student,COURSE,run])));
    assert.equal(results.filter(result=>result.ok).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>!result.ok&&result.error.message==='course_run_full').length,1,JSON.stringify(results));
    assert.equal((await db.query("select count(*)::int n from academy.enrollments where tenant_id=$1 and course_run_id=$2 and status in ('confirmed','active','completed')",[T,run])).rows[0].n,1);
  });

  await t.test('actual queue workers skip a claimed row and process separate admissions once',async()=>{
    // All rows in this database are synthetic. Remove setup events so the two
    // controlled admissions are the complete queue for this contention proof.
    await db.query('delete from academy.admission_governance_queue');
    const handoffs=[id(42310),id(42311)];
    for(let index=0;index<2;index++){
      const contact=id(42300+index);
      await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone) values($1,$2,'Synthetic queued learner',$3)",[contact,T,`055887000${index}`]);
      await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id) values($1,$2,$3,$4,$5)",[handoffs[index],T,`QUEUE-HANDOFF-${index}`,contact,COURSE]);
      await call(db,'private_app.queue_admission_governance_v1',{p_tenant_id:T,p_handoff_id:handoffs[index]});
      await db.query("update academy.admission_governance_queue set retry_at=now()-($2::int*interval '1 second') where handoff_id=$1",[handoffs[index],2-index]);
    }
    // Test-only instrumentation pauses the first worker at a real readiness
    // write, after its production queue SELECT ... FOR UPDATE SKIP LOCKED.
    // No production function is replaced or made to return a synthetic result.
    await db.exec(`create schema governance_test_control;
      create function governance_test_control.pause_first_readiness() returns trigger language plpgsql as $$begin
        if new.handoff_id='${handoffs[0]}'::uuid then perform pg_advisory_xact_lock(423999);end if;return new;end $$;
      create trigger pause_first_readiness before insert on academy.admission_readiness for each row execute function governance_test_control.pause_first_readiness();`);
    let first;
    await controller.query('begin');
    try{
      await controller.query('select pg_advisory_xact_lock(423999)');
      const controllerPid=(await controller.query('select pg_backend_pid() pid')).rows[0].pid;
      const workerPid=(await workers[0].query('select pg_backend_pid() pid')).rows[0].pid;
      first=transaction(workers[0],worker=>call(worker,'private_app.process_admission_governance_queue_v1',{p_limit:1}));
      await blockedBarrier(controller,[workerPid],controllerPid);
      const second=await transaction(workers[1],worker=>call(worker,'private_app.process_admission_governance_queue_v1',{p_limit:1}));
      assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.value.processed,1);assert.equal(second.value.failed,0);
      assert.deepEqual((await controller.query('select handoff_id from academy.admission_governance_queue')).rows.map(row=>row.handoff_id),[handoffs[0]]);
      assert.equal((await controller.query('select count(*)::int n from academy.admission_readiness where handoff_id=$1',[handoffs[1]])).rows[0].n,1);
      await controller.query('commit');const firstResult=await first;
      assert.equal(firstResult.ok,true,JSON.stringify(firstResult));assert.equal(firstResult.value.processed,1);assert.equal(firstResult.value.failed,0);
    }finally{
      await controller.query('rollback');if(first)await first;
      await db.exec('drop trigger pause_first_readiness on academy.admission_readiness;drop schema governance_test_control cascade;');
    }
    assert.equal((await db.query('select count(*)::int n from academy.admission_governance_queue')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from academy.admission_readiness where handoff_id=any($1::uuid[])',[handoffs])).rows[0].n,2);
    assert.equal((await db.query("select count(*)::int n from work_core.tasks where tenant_id=$1 and task_key=any($2::text[])",[T,handoffs.map(value=>`registration-${value}`)])).rows[0].n,2);
  });
});
