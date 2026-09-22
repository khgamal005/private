import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {academySetup,configure,platformAction,call,login,id,T,OTHER,COURSE,MANAGER,MANAGER_AUTH,LEARNER_AUTH,STUDENT,seedEnrollment} from './fixtures/academy-platform-database.mjs';

const migration=new URL('../supabase/migrations/20260922192706_academy_course_authoring_v1.sql',import.meta.url);
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
function indexes(plan){
  const found=[];
  const visit=node=>{if(node['Index Name'])found.push(node['Index Name']);for(const child of node.Plans??[])visit(child);};
  visit(plan.Plan);return [...new Set(found)];
}

test('authoring snapshots keep representative multi-tenant datasets and near-limit drafts bounded', {timeout:90000},async t=>{
  const db=await academySetup();t.after(()=>db.close());
  await db.exec("alter table academy.courses add column program_kind text check(program_kind in ('short_course','diploma'))");
  const sql=await readFile(migration,'utf8');await db.exec(sql);
  await configure(db);await platformAction(db,'set_member',{email:'manager@example.test',role:'manager',status:'active'});
  await db.query('insert into academy.authoring_settings(tenant_id,enabled) values($1,true)',[T]);
  await login(db,MANAGER_AUTH);

  // Synthetic-only volume: 1,000 pilot and 9,000 unrelated courses, three
  // released versions per pilot course, 200 paths with 100 courses each.
  await db.query("insert into academy.courses(id,tenant_id,course_code,title_ar,category,status) select md5('authoring-performance-course-'||n)::uuid,case when n<=1000 then $1::uuid else $2::uuid end,'PERF-'||n,'دورة تدريبية تجريبية '||n,'Training','active' from generate_series(1,10000)n",[T,OTHER]);
  await db.query("insert into academy.training_course_versions(tenant_id,course_id,version,title,learning_mode,status,created_by_subject_id,reviewed_by_subject_id,published_at) select $1,c.id,n,c.title_ar,'self_paced','published',$2,$2,now() from academy.courses c cross join generate_series(1,3)n where c.tenant_id=$1",[T,MANAGER]);
  const seedDocument={title:'عنوان مسودة تجريبية',description:'Synthetic draft',category:'Training',topics:[{id:'topic',title:'المحتوى',units:[{id:'lesson',title:'درس تجريبي',kind:'text',body:'DO_NOT_RETURN_BODY'.repeat(300)}]}]};
  await db.query('insert into academy.course_authoring(tenant_id,course_id,revision,document,updated_by_subject_id) select $1,c.id,1,$2,$3 from academy.courses c where c.tenant_id=$1 and c.id<>$4',[T,JSON.stringify(seedDocument),MANAGER,COURSE]);
  const selected=(await db.query('select id from academy.courses where tenant_id=$1 and id<>$2 order by id limit 99',[T,COURSE])).rows.map(row=>row.id);
  const pathDocument={title:'مسار تدريبي تجريبي',description:'Published learning sequence',courseIds:[COURSE,...selected]};
  await db.query("insert into academy.learning_paths(id,tenant_id,revision,document,published_revision,published_document,published_at,updated_by_subject_id) select md5('authoring-performance-path-'||n)::uuid,$1,1,$2,1,$2,now(),$3 from generate_series(1,200)n",[T,JSON.stringify(pathDocument),MANAGER]);
  await db.query('insert into academy.learning_path_releases(tenant_id,path_id,revision,document,published_by_subject_id) select tenant_id,id,1,document,$2 from academy.learning_paths where tenant_id=$1',[T,MANAGER]);
  await db.query("insert into academy.learning_path_release_courses(tenant_id,path_id,revision,course_id,position) select p.tenant_id,p.id,1,c.value::uuid,c.ordinality::int from academy.learning_paths p cross join lateral jsonb_array_elements_text(p.document->'courseIds') with ordinality c where p.tenant_id=$1",[T]);
  await db.query('insert into academy.learning_path_courses(tenant_id,path_id,course_id,position) select tenant_id,path_id,course_id,position from academy.learning_path_release_courses where tenant_id=$1',[T]);
  await db.exec('analyze');

  const snapshot=args=>call(db,'public.v1_academy_authoring_snapshot',{p_slug:'marktone',...args});
  const list=await snapshot({});
  assert.equal(list.courses.length,50);assert.equal(list.paths.length,50);assert.deepEqual(list.hasMore,{courses:true,paths:true});
  assert.ok(bytes(list)<80000,`List payload ${bytes(list)} exceeds representative budget`);
  assert.equal(JSON.stringify(list).includes('DO_NOT_RETURN_BODY'),false);
  assert.equal((await snapshot({p_query:'دورة تدريبية تجريبية 9999'})).courses.length,0,'Unrelated tenant courses cannot appear in search');
  const last=await snapshot({p_offset:1000,p_path_offset:150});assert.equal(last.courses.length,1);assert.equal(last.paths.length,50);assert.deepEqual(last.hasMore,{courses:false,paths:false});

  const document={title:'Near-limit draft',description:'Synthetic draft near the bounded payload limit',category:'Training',level:'all',language:'ar',learningMode:'self_paced',policy:{minAssessmentPercent:70,minAttendancePercent:0,requireCompletedRun:false,certificateEnabled:false,termsVersion:'2026',supportEmail:'support@example.test'},topics:[{id:'topic',title:'Large content',summary:'',units:Array.from({length:19},(_,n)=>({id:`lesson-${n}`,title:`Lesson ${n}`,kind:'text',body:'x'.repeat(50000),required:true}))}]};
  await call(db,'public.v1_academy_authoring_action',{p_slug:'marktone',p_action:'save_course',p_command_id:id(96001),p_payload:{courseId:COURSE,expectedRevision:0,document}});
  const focused=await snapshot({p_course_id:COURSE});
  assert.equal(focused.course.document.topics[0].units.length,19);assert.ok(bytes(focused)<1100000,`Focused payload ${bytes(focused)} exceeds bounded draft plus summary budget`);

  // EXPLAIN the exact queries extracted from the real RPC, including JSON
  // projection. No alternate simplified query or disabled sequential scans.
  const snapshotBody=sql.slice(sql.indexOf('create function public.v1_academy_authoring_snapshot'),sql.indexOf('create function public.v1_academy_authoring_action'));
  const courseQuery=snapshotBody.slice(snapshotBody.indexOf('with candidates as ('),snapshotBody.indexOf('from numbered;')+'from numbered'.length)
    .replace(' into course_rows,more_courses','').replaceAll(/\bt\b/g,'$1::uuid').replaceAll(/\bp_query\b/g,"''").replaceAll(/\bp_offset\b/g,'0');
  const pathsStart=snapshotBody.indexOf('with candidates as(select');
  const pathQuery=snapshotBody.slice(pathsStart,snapshotBody.indexOf('from numbered;',pathsStart)+'from numbered'.length)
    .replace(' into path_rows,more_paths','').replaceAll(/\bt\b/g,'$1::uuid').replaceAll(/\bp_query\b/g,"''").replaceAll(/\bp_path_offset\b/g,'0');
  const explain=async(query,params)=>(await db.query(`explain (analyze,buffers,format json) ${query}`,params)).rows[0]['QUERY PLAN'][0];
  const coursePlan=await explain(courseQuery,[T]),pathPlan=await explain(pathQuery,[T]);
  assert.ok(indexes(coursePlan).some(name=>name.includes('training_course_versions_tenant_id_course_id')),'Latest published versions use the existing composite course/version index');
  assert.ok(indexes(pathPlan).includes('learning_paths_list_idx'),'Path listing uses tenant-scoped sorted index');

  await seedEnrollment(db);
  const tokenHash='b'.repeat(64);
  await call(db,'public.v1_academy_training_action',{p_slug:'marktone',p_action:'issue_invitation',p_command_id:id(96002),p_payload:{studentId:STUDENT,email:'learner@example.test',tokenHash}});
  await login(db,LEARNER_AUTH);
  await call(db,'public.v1_academy_training_action',{p_slug:'marktone',p_action:'accept_invitation',p_command_id:id(96003),p_payload:{tokenHash}});
  const learner=await call(db,'public.v1_academy_learner_paths',{p_slug:'marktone',p_offset:0});
  assert.equal(learner.paths.length,20);assert.equal(learner.hasMore,true);assert.ok(learner.paths.every(path=>path.courses.length===100));
  assert.ok(bytes(learner)<600000,`Learner payload ${bytes(learner)} exceeds representative 20×100 metadata budget`);
  assert.equal(JSON.stringify(learner).includes('DO_NOT_RETURN_BODY'),false);
  const learnerBody=sql.slice(sql.indexOf('create function public.v1_academy_learner_paths'));
  const learnerQuery=learnerBody.slice(learnerBody.indexOf('with own_enrollments as materialized'),learnerBody.indexOf('from numbered p;')+'from numbered p'.length)
    .replace(' into rows,more','').replaceAll(/\bt\b/g,'$1::uuid').replaceAll(/\bstudent\b/g,'$2::uuid').replaceAll(/\bp_offset\b/g,'0');
  const learnerPlan=await explain(learnerQuery,[T,STUDENT]);
  assert.ok(indexes(learnerPlan).some(name=>name.startsWith('learning_path_release_courses_')),'Learner published course projections use tenant/path or course indexes');
  t.diagnostic(JSON.stringify({synthetic:{pilotCourses:1001,unrelatedCourses:9001,versions:3003,paths:200,coursesPerPath:100},payloadBytes:{list:bytes(list),focused:bytes(focused),learner:bytes(learner)},pgliteExecutionMs:{courses:coursePlan['Execution Time'],paths:pathPlan['Execution Time'],learner:learnerPlan['Execution Time']},indexes:{courses:indexes(coursePlan),paths:indexes(pathPlan),learner:indexes(learnerPlan)},note:'PGlite timings are local diagnostic evidence, not a production latency SLO or multi-connection benchmark.'}));
});
