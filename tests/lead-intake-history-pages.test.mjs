import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {parseLeadIntakePageRequest,validLeadIntakePage}
  from '../lib/lead-intake-page-contract.mjs';

const migration=new URL('../supabase/migrations/20260906123159_lead_intake_history_pages_v1.sql',import.meta.url);
const TENANT='10000000-0000-4000-8000-000000000001';
const OTHER='10000000-0000-4000-8000-000000000002';
const SUBJECT='20000000-0000-4000-8000-000000000001';

test('request contract rejects malformed filters and unanchored cursors',()=>{
  const valid={slug:'test-center',section:'assignments',from:'2026-08-01',to:'2026-08-31'};
  assert.equal(parseLeadIntakePageRequest(valid).p_limit,100);
  assert.equal(parseLeadIntakePageRequest({...valid,query:'  اسم  '}).p_query,'اسم');
  for(const bad of [null,[],{...valid,from:'2026-02-30'},{...valid,to:'2026-07-01'},
    {...valid,slug:'../other'},{...valid,section:'team'},
    {...valid,query:'x'.repeat(101)},{...valid,batchId:OTHER},
    {...valid,cursor:{id:OTHER,at:'2026-08-01T00:00:00Z'}}]){
    assert.equal(parseLeadIntakePageRequest(bad),null);
  }
});

test('full-history SQL is isolated, read-only, and paginates beyond old limits',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec(`
    create schema auth; create schema core; create schema people;
    create schema sales_core; create schema private_app;
    create role anon; create role authenticated;
    create function public.test_uuid(v text) returns uuid language sql immutable as $$
      select (substr(h,1,12)||'4'||substr(h,14,3)||'8'||substr(h,18))::uuid
      from (select md5(v) h) hashed$$;
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('test.subject',true),'')::uuid$$;
    create table core.tenants(id uuid primary key,slug text unique,timezone text);
    create table private_app.test_permissions(subject_id uuid,tenant_id uuid);
    create function private_app.has_tenant_permission(id uuid, permission text)
      returns boolean language sql stable as $$select permission='tenant.leads.read'
      and exists(select 1 from private_app.test_permissions p
      where p.subject_id=auth.uid() and p.tenant_id=id)$$;
    create table people.staff_profiles(id uuid primary key,tenant_id uuid,full_name text);
    create table sales_core.contacts(id uuid primary key,tenant_id uuid,full_name text,
      phone text,whatsapp text,source text,campaign_name text,ad_name text,
      status text,lead_status text,lead_quality text,created_at timestamptz);
    create table sales_core.lead_import_batches(id uuid primary key,tenant_id uuid,
      batch_key text,file_name text,source text,campaign_name text,ad_set_name text,
      ad_name text,status text,total_rows integer,valid_rows integer,duplicate_rows integer,
      invalid_rows integer,distributed_rows integer,imported_by_staff_id uuid,
      last_distributed_by_staff_id uuid,last_distribution_strategy text,
      last_deadline_at timestamptz,distributed_at timestamptz,created_at timestamptz);
    create table sales_core.lead_import_rows(id uuid primary key,tenant_id uuid,batch_id uuid,
      row_number integer,full_name text,organization_name text,phone text,whatsapp text,
      email text,source text,campaign_name text,ad_set_name text,ad_name text,program_name text,
      validation_status text,validation_errors text[],duplicate_kind text,
      duplicate_contact_id uuid,queue_status text,contact_id uuid,normalized_phone text,
      normalized_whatsapp text,created_at timestamptz);
    create table sales_core.lead_assignments(id uuid primary key,tenant_id uuid,batch_id uuid,
      import_row_id uuid,contact_id uuid,assigned_staff_id uuid,assigned_by_staff_id uuid,
      assignment_strategy text,status text,assigned_at timestamptz,deadline_at timestamptz,
      first_action_at timestamptz,metadata jsonb default '{}',created_at timestamptz);
    insert into core.tenants values('${TENANT}','test-center','Asia/Riyadh'),
      ('${OTHER}','other-center','Asia/Riyadh');
    insert into private_app.test_permissions values('${SUBJECT}','${TENANT}');
    insert into people.staff_profiles values('${SUBJECT}','${TENANT}','موظف تجريبي');
    insert into sales_core.lead_import_batches
      (id,tenant_id,file_name,source,campaign_name,status,created_at,valid_rows,distributed_rows)
      select public.test_uuid('batch-'||i),'${TENANT}','ملف تجريبي '||i,'meta','حملة أغسطس',
        'ready','2026-08-01 10:00:00+03'::timestamptz+(i%27)*interval '1 day',100,0
      from generate_series(1,120) i;
    insert into sales_core.contacts
      select public.test_uuid('contact-'||i),'${TENANT}','عميل تجريبي '||i,
        '05'||lpad(i::text,8,'0'),null,'changed-source','changed-campaign',null,
        'active',case when i%5=0 then 'no_answer' else 'new' end,'unrated',
        case when i<=3213 then '2026-08-01 10:00:00+03' else '2026-09-01 10:00:00+03' end::timestamptz
      from generate_series(1,4213) i;
    insert into sales_core.lead_import_rows
      (id,tenant_id,batch_id,row_number,full_name,phone,normalized_phone,source,campaign_name,
        validation_status,validation_errors,queue_status,contact_id,created_at)
      select public.test_uuid('row-'||i),'${TENANT}',public.test_uuid('batch-'||(1+i%120)),i,
        'عميل تجريبي '||i,'05'||lpad(i::text,8,'0'),'9665'||lpad(i::text,8,'0'),
        case when i%2=0 then 'meta' else 'google' end,'حملة أغسطس',
        'valid','{}',case when i<=2106 or i>3213 then 'assigned' else 'awaiting_distribution' end,
        public.test_uuid('contact-'||i),
        case when i<=3213 then '2026-08-01 10:00:00+03' else '2026-09-01 10:00:00+03' end::timestamptz
          +(i%27)*interval '1 day'
      from generate_series(1,4213) i;
    -- Make September rows and assignments historical relative to the real clock.
    update sales_core.lead_import_rows set created_at='2026-09-02 10:00:00+03'
      where created_at>='2026-09-01';
    insert into sales_core.lead_assignments
      (id,tenant_id,batch_id,import_row_id,contact_id,assigned_staff_id,assignment_strategy,
        status,assigned_at,created_at,first_action_at)
      select public.test_uuid('assignment-'||i),'${TENANT}',public.test_uuid('batch-'||(1+i%120)),
        public.test_uuid('row-'||i),public.test_uuid('contact-'||i),'${SUBJECT}','fair','active',
        case when i<=2106 then '2026-08-01 10:00:00+03' else '2026-09-02 10:00:00+03' end::timestamptz,
        case when i<=2106 then '2026-08-01 10:00:00+03' else '2026-09-02 10:00:00+03' end::timestamptz,
        '2026-09-03 10:00:00+03'::timestamptz
      from generate_series(1,4056) i where i<=2106 or i>3213;
    create index on sales_core.lead_assignments(tenant_id,import_row_id);
    insert into sales_core.lead_import_rows(id,tenant_id,batch_id,full_name,created_at)
      values(public.test_uuid('other-row'),'${OTHER}',public.test_uuid('batch-1'),'عميل سري','2026-08-01');
    select set_config('test.subject','${SUBJECT}',false);
  `);
  await db.exec(await readFile(migration,'utf8'));
  const page=async(section,options={})=>{
    const args={p_slug:'test-center',p_section:section,...options};
    const keys=Object.keys(args);
    const sql=`select public.v1_tenant_lead_intake_page(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as data`;
    return (await db.query(sql,keys.map(k=>args[k]))).rows[0].data;
  };
  const fingerprint=async()=>{
    const result={};
    for(const table of ['contacts','lead_import_rows','lead_import_batches','lead_assignments']){
      result[table]=(await db.query(`select md5(string_agg(to_jsonb(t)::text,',' order by id)) as value from sales_core.${table} t`)).rows[0].value;
    }
    return result;
  };
  const before=await fingerprint();
  await t.test('August is outside the old initial windows',async()=>{
    for(const [table,date,limit] of [['lead_assignments','assigned_at',500],['lead_import_rows','created_at',750]]){
      const {rows}=await db.query(`select count(*)::int as n from
        (select ${date} from sales_core.${table} where tenant_id=$1 order by ${date} desc limit ${limit}) x
        where ${date}<'2026-09-01 00:00:00+03'`,[TENANT]);
      assert.equal(rows[0].n,0);
    }
  });
  await t.test('all 2106 August assignments are reachable once, including tied timestamps',async()=>{
    const seen=new Set();let cursor=null,anchor=null,count=0;
    do{
      const data=await page('assignments',{p_from:'2026-08-01',p_to:'2026-08-31',
        p_after_id:cursor?.id||null,p_after_at:cursor?.at||null,p_anchor:anchor,
        p_include_total:!cursor});
      assert.equal(validLeadIntakePage(data,'assignments'),true);
      if(!cursor){assert.equal(data.total,2106);anchor=data.anchor}
      else assert.equal(data.total,null);
      for(const row of data.records){assert.ok(!seen.has(row.id));seen.add(row.id)}
      count++;cursor=data.nextCursor;
    }while(cursor);
    assert.equal(seen.size,2106);assert.equal(count,22);
  });
  await t.test('queue paging, exact totals, waiting-only and old batches',async()=>{
    const data=await page('queue',{p_from:'2026-08-01',p_to:'2026-08-31'});
    assert.equal(data.total,3213);assert.equal(data.records.length,100);
    const seen=new Set(data.records.map(r=>r.id));let cursor=data.nextCursor;
    while(cursor){
      const next=await page('queue',{p_from:'2026-08-01',p_to:'2026-08-31',p_anchor:data.anchor,
        p_after_at:cursor.at,p_after_id:cursor.id,p_include_total:false});
      assert.equal(validLeadIntakePage(next,'queue'),true);
      for(const row of next.records){assert.ok(!seen.has(row.id));seen.add(row.id)}
      cursor=next.nextCursor;
    }
    assert.equal(seen.size,3213);
    const waiting=await page('queue',{p_from:'2026-08-01',p_to:'2026-08-31',p_validation:'awaiting'});
    assert.equal(waiting.total,1107);
    assert.ok(waiting.records.every(r=>r.queueStatus==='awaiting_distribution'));
    const batches=await page('batches',{p_from:'2026-08-01',p_to:'2026-08-31'});
    assert.equal(batches.total,120);assert.equal(batches.hasMore,true);
    const last=await page('batches',{p_after_id:batches.nextCursor.id,p_after_at:batches.nextCursor.at,p_anchor:batches.anchor});
    assert.equal(last.records.length,20);
    const old=await page('queue',{p_batch_id:last.records[0].id});
    assert.ok(old.total>0);assert.ok(old.records.every(r=>r.batchId===last.records[0].id));
  });
  await t.test('assignment filters match original attribution and assigned_at, not response date',async()=>{
    const result=await page('assignments',{p_from:'2026-08-01',p_to:'2026-08-31',p_source:'meta',p_campaign:'حملة أغسطس'});
    assert.equal(result.total,1053);
    assert.ok(result.records.every(r=>r.source==='meta'&&r.campaignName==='حملة أغسطس'));
    assert.equal((await page('assignments',{p_from:'2026-09-03',p_to:'2026-09-03'})).total,0);
    const laterResponse=await page('queue',{p_from:'2026-09-03',p_to:'2026-09-03'});
    assert.ok(laterResponse.total>0);
  });
  await t.test('search supports partial phone, Arabic digits, names and quality',async()=>{
    assert.equal((await page('assignments',{p_query:'عميل تجريبي 2106'})).total,1);
    assert.equal((await page('assignments',{p_query:'٠٠٢١٠٦'})).total,1);
    assert.equal((await page('queue',{p_query:'٠٠٢١٠٦'})).total,1);
    const qualified=await page('assignments',{p_quality:'no_answer'});
    assert.ok(qualified.total>0);assert.ok(qualified.records.every(r=>r.leadStatus==='no_answer'));
  });
  await t.test('timezone boundaries are inclusive by Riyadh day and exclusive at next midnight',async()=>{
    assert.equal((await page('assignments',{p_from:'2026-07-31',p_to:'2026-07-31'})).total,0);
    assert.equal((await page('assignments',{p_from:'2026-08-01',p_to:'2026-08-01'})).total,2106);
    await db.exec('begin');
    try{
      for(const [i,instant] of ['2026-07-31 20:59:59.999999Z','2026-07-31 21:00:00Z',
        '2026-08-31 20:59:59.999999Z','2026-08-31 21:00:00Z'].entries()){
        await db.query(`update sales_core.lead_assignments set assigned_at=$1
          where id=public.test_uuid($2)`,[instant,'assignment-'+(i+1)]);
      }
      const august=await page('assignments',{p_from:'2026-08-01',p_to:'2026-08-31'});
      assert.equal(august.total,2104);
      assert.equal((await page('assignments',{p_from:'2026-07-31',p_to:'2026-07-31'})).total,1);
      assert.equal((await page('assignments',{p_from:'2026-08-31',p_to:'2026-08-31'})).total,1);
    }finally{await db.exec('rollback')}
  });
  await t.test('an anchored traversal excludes a later import',async()=>{
    const first=await page('queue',{p_from:'2026-08-01',p_to:'2026-08-31'});
    await db.exec('begin');
    try{
      await db.query(`insert into sales_core.lead_import_rows
        (id,tenant_id,batch_id,full_name,created_at) values(public.test_uuid('late-row'),$1,
        public.test_uuid('batch-1'),'سجل جديد',$2::timestamptz+interval '1 second')`,[TENANT,first.anchor]);
      const anchored=await page('queue',{p_anchor:first.anchor});
      assert.equal(anchored.total,4213);
      assert.ok(anchored.records.every(r=>r.name!=='سجل جديد'));
    }finally{await db.exec('rollback')}
  });
  await t.test('foreign tenant, missing login and malformed direct RPC calls fail closed',async()=>{
    await assert.rejects(page('queue',{p_slug:'other-center'}),/forbidden/);
    assert.equal((await page('queue',{p_query:'عميل سري'})).total,0);
    await assert.rejects(page('queue',{p_limit:101}),/invalid_page_request/);
    await assert.rejects(page('queue',{p_after_id:OTHER}),/invalid_page_request/);
    await assert.rejects(page('queue',{p_from:'2026-09-01',p_to:'2026-08-01'}),/invalid_page_request/);
    await db.exec("select set_config('test.subject','',false)");
    await assert.rejects(page('queue'),/forbidden/);
    await db.exec(`select set_config('test.subject','${SUBJECT}',false)`);
    const signature='public.v1_tenant_lead_intake_page(text,text,date,date,text,text,text,text,uuid,text,integer,timestamptz,timestamptz,uuid,boolean)';
    const privileges=(await db.query(`select has_function_privilege('anon',$1,'execute') as anon,
      has_function_privilege('authenticated',$1,'execute') as authenticated`,[signature])).rows[0];
    assert.deepEqual(privileges,{anon:false,authenticated:true});
  });
  assert.deepEqual(await fingerprint(),before,'reads must not modify any business records');
});
