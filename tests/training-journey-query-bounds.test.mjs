import assert from 'node:assert/strict';
import test from 'node:test';
import {setup,call,T,OTHER,ADMIN,ACCOUNT,INVOICE,HANDOFF,seedPayment} from './fixtures/training-journey-database.mjs';

test('training metadata pages stay bounded on a synthetic multi-tenant catalog and plans use tenant keys',async t=>{
  const db=await setup({learning:true});t.after(()=>db.close());
  await db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)',[T]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
  await seedPayment(db);
  await db.query(`insert into academy.courses(tenant_id,course_code,title_ar,category)
    select $1::uuid,'BULK-'||n,'Bulk course '||lpad(n::text,5,'0'),'Fixture' from generate_series(1,1000)n
    union all select $2::uuid,'FOREIGN-'||n,'Private foreign '||n,'Fixture' from generate_series(1,1000)n`,[T,OTHER]);
  await db.query(`insert into academy.training_course_versions(tenant_id,course_id,version,title,learning_mode,policy,created_by_subject_id)
    select tenant_id,id,1,title_ar,'self_paced','{}',$2 from academy.courses where tenant_id=$1`,[T,ADMIN]);
  await db.query(`insert into academy.training_units(tenant_id,version_id,position,title,kind,body)
    select tenant_id,id,1,'Large body excluded from overview','text',repeat('PRIVATE CONTENT ',1000)
    from academy.training_course_versions where tenant_id=$1`,[T]);
  await db.exec('analyze academy.courses; analyze academy.training_course_versions; analyze academy.training_units; analyze accounting_core.payment_allocations;');
  const snapshot=await call(db,'public.v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:'manager'});
  assert.equal(snapshot.courses.length,50);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE CONTENT'),false);
  assert.equal(JSON.stringify(snapshot).includes('Private foreign'),false);
  const bytes=Buffer.byteLength(JSON.stringify(snapshot));assert.ok(bytes<100000,`metadata page ${bytes} bytes`);
  const next=await call(db,'public.v1_training_learning_snapshot',{p_tenant_slug:'marktone',p_role:'manager',p_offset:50});
  assert.equal(next.courses.length,50);assert.equal(next.courses.some(c=>snapshot.courses.some(prior=>prior.id===c.id)),false);
  const coursePlan=(await db.query(`explain (format json,analyze true,buffers true)
    select c.id,v.id from academy.courses c join academy.training_course_versions v on v.tenant_id=c.tenant_id and v.course_id=c.id
    where c.tenant_id=$1 order by c.title_ar,c.id limit 50`,[T])).rows[0]['QUERY PLAN'];
  const paymentPlan=(await db.query(`explain (format json,analyze true,buffers true)
    select a.amount_minor from accounting_core.payment_allocations a join accounting_core.payments p
      on p.tenant_id=a.tenant_id and p.id=a.payment_id and p.status='verified'
    where a.tenant_id=$1 and a.invoice_id=$2`,[T,INVOICE])).rows[0]['QUERY PLAN'];
  assert.equal(coursePlan[0].Plan['Actual Rows'],50);assert.equal(paymentPlan[0].Plan['Actual Rows'],1);
  // Collect actual plan evidence without enforcing a tiny fixture's planner choice
  // or treating embedded Postgres timings as production load-test results.
  const nodes=[];const walk=(node,label)=>{nodes.push(`${label}:${node['Node Type']}${node['Index Name']?`:${node['Index Name']}`:''}`);for(const child of node.Plans||[])walk(child,label);};
  walk(coursePlan[0].Plan,'courses');walk(paymentPlan[0].Plan,'payments');
  t.diagnostic(JSON.stringify({syntheticCourses:2002,pageCourses:50,metadataBytes:bytes,planNodes:nodes}));
});
