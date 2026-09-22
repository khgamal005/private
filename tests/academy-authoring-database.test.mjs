import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {academySetup,configure,platformAction,call,id,login,T,OTHER,COURSE,FOREIGN_COURSE,MANAGER_AUTH,EDITOR_AUTH,ACADEMY_INSTRUCTOR_AUTH,ADMIN,ADMIN_AUTH,LEARNER_AUTH,ENROLLMENT,STUDENT,HANDOFF,INVOICE,ACCOUNT,seedEnrollment,seedPayment} from './fixtures/academy-platform-database.mjs';

const migration=new URL('../supabase/migrations/20260922192706_academy_course_authoring_v1.sql',import.meta.url);
let sequence=92000;
const action=(db,p_action,p_payload,p_command_id=id(sequence++),p_slug='marktone')=>call(db,'public.v1_academy_authoring_action',{p_slug,p_action,p_command_id,p_payload});
const snapshot=(db,options={})=>call(db,'public.v1_academy_authoring_snapshot',{p_slug:'marktone',...options});
const learning=(db,p_action,p_payload)=>call(db,'public.v1_academy_training_action',{p_slug:'marktone',p_action,p_payload,p_command_id:id(sequence++)});
async function setup({enabled=true}={}){
 const db=await academySetup();
 try{
  // program_kind is live-verified from diploma governance; the base fixture
  // intentionally predates that independent feature.
  await db.exec("alter table academy.courses add column program_kind text check(program_kind in ('short_course','diploma'))");
  await db.exec(await readFile(migration,'utf8'));
  await configure(db);
  for(const [email,role] of [['manager@example.test','manager'],['editor@example.test','website_editor'],['academy.instructor@example.test','instructor']])await platformAction(db,'set_member',{email,role,status:'active'});
  if(enabled)await db.query('insert into academy.authoring_settings(tenant_id,enabled) values($1,true)',[T]);
  await login(db,MANAGER_AUTH);
  return db;
 }catch(error){await db.close();delete error.query;throw error;}
}
function document(title='Real course'){
 return {title,description:'Course description',category:'Training',level:'all',language:'ar',thumbnailUrl:'',introVideoUrl:'',learningMode:'self_paced',
  policy:{minAttendancePercent:0,minAssessmentPercent:70,requireCompletedRun:false,certificateEnabled:true,termsVersion:'2026-09',supportEmail:'support@example.test'},
  topics:[{id:'topic1',title:'Introduction',summary:'Start here',units:[{id:'lesson1',title:'First lesson',kind:'text',required:true,minimumSeconds:0,body:'Real lesson material'}]},
   {id:'topic2',title:'Assessment',summary:'Check understanding',units:[{id:'quiz1',title:'Final quiz',kind:'quiz',required:true,questions:[{id:'q1',prompt:'Select the correct response',options:['Correct','Wrong'],correctOptionIndex:0}]}]}],
  aiBrief:{goal:'Draft a practical course',audience:'New learners',language:'ar',topicCount:5,notes:'Review before generation'}};
}
async function ready(db,{courseId=null,title='Real course'}={}){
 const created=courseId?{courseId,revision:0}:await action(db,'create_course',{title});
 const saved=await action(db,'save_course',{courseId:created.courseId,expectedRevision:created.revision,document:document(title)});
 const published=await action(db,'publish_course',{courseId:saved.courseId,expectedRevision:saved.revision,humanReviewed:true});
 return {...saved,...published};
}

test('authoring installation is inactive, manager-only, pilot-only and denies direct RLS table access',async t=>{
 const db=await setup({enabled:false});t.after(()=>db.close());
 assert.equal((await snapshot(db)).available,false);
 await login(db,ACADEMY_INSTRUCTOR_AUTH);
 assert.deepEqual(await call(db,'public.v1_academy_learner_paths',{p_slug:'marktone',p_offset:0}),{paths:[],hasMore:false,offset:0,pageSize:20});
 await login(db,MANAGER_AUTH);
 await assert.rejects(action(db,'create_course',{title:'Not enabled'}),/academy_authoring_not_available/);
 await db.query('insert into academy.authoring_settings(tenant_id,enabled) values($1,true)',[T]);
 for(const actor of [EDITOR_AUTH,ACADEMY_INSTRUCTOR_AUTH]){
  await login(db,actor);
  await assert.rejects(snapshot(db),/academy_authoring_permission_denied/);
  await assert.rejects(action(db,'create_course',{title:'Unauthorized'}),/academy_authoring_permission_denied/);
  await assert.rejects(call(db,'public.v1_academy_learner_paths',{p_slug:'marktone',p_offset:0}),/training_permission_denied/);
 }
 await login(db,MANAGER_AUTH);
 await assert.rejects(action(db,'create_course',{title:'Foreign'},undefined,'foreign'),/academy_not_available/);
 await assert.rejects(snapshot(db,{p_course_id:FOREIGN_COURSE}),/academy_authoring_course_not_found/);
 await db.exec('set role authenticated');
 await assert.rejects(db.query('select * from academy.course_authoring'),/permission denied/);
 await db.exec('reset role');
 await login(db,null);await assert.rejects(snapshot(db),/authentication_required/);
 assert.equal((await db.query('select count(*)::int n from academy.courses where tenant_id=$1',[OTHER])).rows[0].n,1);
});

test('course creation is canonical and idempotent; stale saves and command reuse cannot overwrite drafts',async t=>{
 const db=await setup();t.after(()=>db.close());const command=id(sequence++);
 const created=await action(db,'create_course',{title:'Canonical authoring course'},command);
 assert.deepEqual(await action(db,'create_course',{title:'Canonical authoring course'},command),created);
 assert.equal(created.revision,1);
 const row=(await db.query('select title_ar,status,program_kind from academy.courses where id=$1',[created.courseId])).rows[0];
 assert.deepEqual(row,{title_ar:'Canonical authoring course',status:'draft',program_kind:'short_course'});
 await assert.rejects(action(db,'create_course',{title:'Different content'},command),/command_id_reused_with_different_payload/);
 await login(db,ADMIN_AUTH);await assert.rejects(action(db,'create_course',{title:'Canonical authoring course'},command),/command_id_reused_with_different_payload/);await login(db,MANAGER_AUTH);
 const saved=await action(db,'save_course',{courseId:created.courseId,expectedRevision:1,document:document()});
 assert.equal(saved.revision,2);
 await assert.rejects(action(db,'save_course',{courseId:created.courseId,expectedRevision:1,document:document('Stale writer')}),/academy_authoring_revision_conflict/);
 const focused=await snapshot(db,{p_course_id:created.courseId});assert.equal(focused.course.document.title,'Real course');
 assert.deepEqual(focused.course.document.aiBrief,document().aiBrief);assert.equal(focused.ai.configured,false);
 const listing=await snapshot(db);assert.equal(JSON.stringify(listing).includes('Real lesson material'),false);
 assert.equal((await db.query('select count(*)::int n from academy.training_course_versions')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,0);
});

test('drafts can be incomplete but publication is atomic, reviewed and compiles topic order into existing learning versions',async t=>{
 const db=await setup();t.after(()=>db.close());const created=await action(db,'create_course',{title:'Review workflow'});
 const incomplete=document();incomplete.topics[0].title='';incomplete.topics[0].units[0].body='';
 const saved=await action(db,'save_course',{courseId:created.courseId,expectedRevision:1,document:incomplete});
 await assert.rejects(action(db,'publish_course',{courseId:created.courseId,expectedRevision:saved.revision,humanReviewed:true}),/academy_authoring_topic_invalid/);
 assert.equal((await db.query('select count(*)::int n from academy.training_course_versions')).rows[0].n,0);
 const missingAssessment=document();missingAssessment.topics.pop();
 const noAssessment=await action(db,'save_course',{courseId:created.courseId,expectedRevision:saved.revision,document:missingAssessment});
 await assert.rejects(action(db,'publish_course',{courseId:created.courseId,expectedRevision:noAssessment.revision,humanReviewed:true}),/training_assessment_required/);
 assert.equal((await db.query('select count(*)::int n from academy.training_course_versions')).rows[0].n,0);
 const good=await action(db,'save_course',{courseId:created.courseId,expectedRevision:noAssessment.revision,document:document()});
 await assert.rejects(action(db,'publish_course',{courseId:created.courseId,expectedRevision:good.revision,humanReviewed:false}),/training_human_review_required/);
 const published=await action(db,'publish_course',{courseId:created.courseId,expectedRevision:good.revision,humanReviewed:true});
 const repeated=await action(db,'publish_course',{courseId:created.courseId,expectedRevision:good.revision,humanReviewed:true});
 assert.equal(repeated.versionId,published.versionId);
 const version=(await db.query('select status,policy from academy.training_course_versions where id=$1',[published.versionId])).rows[0];
 assert.equal(version.status,'published');assert.deepEqual(version.policy.curriculumTopics,[{id:'topic1',title:'Introduction',summary:'Start here',startPosition:1,unitCount:1},{id:'topic2',title:'Assessment',summary:'Check understanding',startPosition:2,unitCount:1}]);
 assert.deepEqual((await db.query('select title,kind from academy.training_units where version_id=$1 order by position',[published.versionId])).rows,[{title:'First lesson',kind:'text'},{title:'Final quiz',kind:'quiz'}]);
 assert.equal((await db.query('select status from academy.courses where id=$1',[created.courseId])).rows[0].status,'active');
 await assert.rejects(db.query("update academy.course_authoring_releases set document='{}' where course_id=$1",[created.courseId]),/academy_authoring_release_immutable/);
 await assert.rejects(db.query("update academy.training_units set title='Changed' where version_id=$1",[published.versionId]),/training_published_version_immutable/);
});

test('republishing appends content and never moves enrolled students or duplicates finance',async t=>{
 const db=await setup();t.after(()=>db.close());await seedPayment(db);await seedEnrollment(db);
 const first=await ready(db,{courseId:COURSE});
 await learning(db,'assign_version',{enrollmentId:ENROLLMENT,versionId:first.versionId});
 const updated=document('Updated course');updated.topics[0].units[0].body='New content after publication';
 const saved=await action(db,'save_course',{courseId:COURSE,expectedRevision:first.revision,document:updated});
 const second=await action(db,'publish_course',{courseId:COURSE,expectedRevision:saved.revision,humanReviewed:true});
 assert.notEqual(first.versionId,second.versionId);
 assert.equal((await db.query('select version_id from academy.training_enrollment_versions where enrollment_id=$1',[ENROLLMENT])).rows[0].version_id,first.versionId);
 assert.equal((await db.query('select body from academy.training_units where version_id=$1 and position=1',[first.versionId])).rows[0].body,'Real lesson material');
 assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,1);
});

test('paths validate tenant and publication, retain release order while newer drafts change',async t=>{
 const db=await setup();t.after(()=>db.close());const first=await ready(db,{courseId:COURSE});
 const draft=await action(db,'create_course',{title:'Unpublished course'});
 await assert.rejects(action(db,'save_path',{expectedRevision:0,document:{title:'Invalid path',courseIds:[FOREIGN_COURSE]}}),/academy_authoring_path_course_not_found/);
 await assert.rejects(action(db,'save_path',{expectedRevision:0,document:{title:'Duplicate path',courseIds:[COURSE,COURSE]}}),/academy_authoring_path_courses_invalid/);
 const saved=await action(db,'save_path',{expectedRevision:0,document:{title:'Ordered path',description:'Suggested order',courseIds:[COURSE,draft.courseId]}});
 await assert.rejects(action(db,'publish_path',{pathId:saved.pathId,expectedRevision:saved.revision,humanReviewed:true}),/academy_authoring_path_course_unpublished/);
 const secondSave=await action(db,'save_course',{courseId:draft.courseId,expectedRevision:1,document:document('Second course')});
 await action(db,'publish_course',{courseId:draft.courseId,expectedRevision:secondSave.revision,humanReviewed:true});
 await action(db,'publish_path',{pathId:saved.pathId,expectedRevision:saved.revision,humanReviewed:true});
 const edit=await action(db,'save_path',{pathId:saved.pathId,expectedRevision:saved.revision,document:{title:'Reordered draft',courseIds:[draft.courseId,COURSE]}});
 const focused=(await snapshot(db,{p_path_id:saved.pathId,p_query:'No course title matches'})).path;
 assert.deepEqual(focused.document.courseIds,[draft.courseId,COURSE]);assert.deepEqual(focused.publishedDocument.courseIds,[COURSE,draft.courseId]);assert.equal(focused.publishedRevision,1);
 assert.deepEqual(focused.courses.map(course=>course.id),[draft.courseId,COURSE]);assert.equal(focused.courses[0].title,'Second course');assert.ok(focused.courses[0].publishedVersionId);
 await assert.rejects(action(db,'save_path',{pathId:saved.pathId,expectedRevision:1,document:{title:'Stale path',courseIds:[COURSE]}}),/academy_authoring_revision_conflict/);
 assert.equal(edit.revision,2);assert.ok(first.versionId);
 await action(db,'save_path',{expectedRevision:0,document:{title:'A different path',courseIds:[]}});
 const searched=await snapshot(db,{p_query:'Reordered'});assert.equal(searched.paths.length,1);assert.equal(searched.paths[0].pathId,saved.pathId);
 assert.equal((await snapshot(db,{p_query:'No path matches'})).paths.length,0);
 await assert.rejects(db.query("update academy.learning_path_releases set document='{}' where path_id=$1",[saved.pathId]),/academy_authoring_release_immutable/);
});

test('direct RPC validates oversized content, URLs, identifiers and bounded searchable snapshots',async t=>{
 const db=await setup();t.after(()=>db.close());
 for(const url of ['javascript:alert(1)','http://example.test','https://user:pass@example.test','https://example.test\\x']){
  const doc=document();doc.thumbnailUrl=url;
  await assert.rejects(action(db,'save_course',{courseId:COURSE,expectedRevision:0,document:doc}),/academy_authoring_url_invalid/);
 }
 const duplicate=document();duplicate.topics[1].id='topic1';
 await assert.rejects(action(db,'save_course',{courseId:COURSE,expectedRevision:0,document:duplicate}),/academy_authoring_topic_invalid/);
 const tooLarge=document();tooLarge.topics[0].units[0].body='x'.repeat(50001);
 await assert.rejects(action(db,'save_course',{courseId:COURSE,expectedRevision:0,document:tooLarge}),/academy_authoring_unit_invalid/);
 const extra=document();extra.privateCredential='DO_NOT_STORE';extra.policy.privateCredential='DO_NOT_STORE';extra.aiBrief.privateCredential='DO_NOT_STORE';extra.topics[0].units[0].privateCredential='DO_NOT_STORE';extra.topics[1].units[0].questions[0].privateCredential='DO_NOT_STORE';
 extra.aiBrief.goal='م'.repeat(2000);extra.aiBrief.audience='م'.repeat(1000);extra.aiBrief.notes='م'.repeat(6000);
 await action(db,'save_course',{courseId:COURSE,expectedRevision:0,document:extra});
 assert.equal(JSON.stringify((await snapshot(db,{p_course_id:COURSE})).course.document).includes('DO_NOT_STORE'),false);
 assert.equal((await snapshot(db,{p_course_id:COURSE})).course.document.aiBrief.notes.length,6000);
 await db.query("insert into academy.courses(tenant_id,course_code,title_ar,category) select $1,'SEARCH-'||n,'Search course '||n,'Training' from generate_series(1,55) n",[T]);
 const page=await snapshot(db,{p_query:'Search course'});assert.equal(page.courses.length,50);assert.equal(page.hasMore.courses,true);
 const rest=await snapshot(db,{p_query:'Search course',p_offset:50});assert.equal(rest.courses.length,5);assert.equal(rest.hasMore.courses,false);
 assert.equal(rest.offset,50);assert.equal(rest.pathOffset,0);assert.equal(rest.query,'Search course');assert.deepEqual(rest.tenant,{id:T,slug:'marktone'});
 assert.equal(new Set([...page.courses,...rest.courses].map(c=>c.id)).size,55);
 await assert.rejects(snapshot(db,{p_offset:-1}),/academy_authoring_query_invalid/);
 const plan=await db.query('explain select * from academy.learning_paths where tenant_id=$1 order by updated_at desc,id limit 51',[T]);
 assert.match(JSON.stringify(plan.rows),/learning_paths_list_idx/);
 // Creation and content changes only use audited RPCs; unrelated tenant retained.
 assert.equal((await db.query('select count(*)::int n from academy.courses where tenant_id=$1',[OTHER])).rows[0].n,1);
});

test('legacy publication is labeled explicitly instead of pairing it with an unrelated authoring revision',async t=>{
 const db=await setup();t.after(()=>db.close());const first=await ready(db,{courseId:COURSE});
 const doc=document('Legacy editor release');
 const legacy=await learning(db,'save_draft',{courseId:COURSE,title:doc.title,learningMode:doc.learningMode,policy:doc.policy,units:doc.topics.flatMap(topic=>topic.units)});
 await learning(db,'publish_version',{versionId:legacy.versionId,humanReviewed:true});
 const focused=(await snapshot(db,{p_course_id:COURSE})).course;
 assert.equal(focused.publishedVersionId,legacy.versionId);assert.equal(focused.authoringPublishedVersionId,first.versionId);assert.equal(focused.publishedRevision,null);assert.equal(focused.externallyUpdated,true);
 await assert.rejects(action(db,'publish_course',{courseId:COURSE,expectedRevision:first.revision,humanReviewed:true}),/academy_authoring_external_change/);
});

test('learner paths expose only published metadata and own actual progress without granting enrollment or leaking answers',async t=>{
 const db=await setup();t.after(()=>db.close());await seedPayment(db);await seedEnrollment(db);
 await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
 const first=await ready(db,{courseId:COURSE});const second=await ready(db,{title:'Not enrolled course'});
 await learning(db,'assign_version',{enrollmentId:ENROLLMENT,versionId:first.versionId});
 const path=await action(db,'save_path',{expectedRevision:0,document:{title:'Published learner path',description:'Published description',courseIds:[COURSE,second.courseId]}});
 await action(db,'publish_path',{pathId:path.pathId,expectedRevision:path.revision,humanReviewed:true});
 await action(db,'save_path',{pathId:path.pathId,expectedRevision:path.revision,document:{title:'PRIVATE DRAFT TITLE',description:'PRIVATE DRAFT DESCRIPTION',courseIds:[second.courseId,COURSE]}});
 const tokenHash='a'.repeat(64);
 await learning(db,'issue_invitation',{studentId:STUDENT,email:'learner@example.test',tokenHash});
 await login(db,LEARNER_AUTH);await learning(db,'accept_invitation',{tokenHash});
 await assert.rejects(snapshot(db),/academy_authoring_permission_denied/);
 const project=()=>call(db,'public.v1_academy_learner_paths',{p_slug:'marktone',p_offset:0});
 let result=await project();assert.equal(result.paths.length,1);assert.equal(result.pageSize,20);assert.equal(result.paths[0].title,'Published learner path');
 assert.deepEqual(result.paths[0].courses,[{id:COURSE,title:'Real course',enrolled:true,completed:false,progressPercent:0},{id:second.courseId,title:'Not enrolled course',enrolled:false,completed:false,progressPercent:null}]);
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(JSON.stringify(result).includes('correctOptionIndex'),false);assert.equal(JSON.stringify(result).includes('aiBrief'),false);
 const units=(await db.query('select id from academy.training_units where version_id=$1 order by position',[first.versionId])).rows;
 await learning(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:units[0].id});await learning(db,'complete_unit',{enrollmentId:ENROLLMENT,unitId:units[0].id});
 result=await project();assert.equal(result.paths[0].courses[0].progressPercent,50);
 const quiz=await learning(db,'open_unit',{enrollmentId:ENROLLMENT,unitId:units[1].id});assert.equal(JSON.stringify(quiz).includes('correctOptionIndex'),false);
 await learning(db,'submit_quiz',{enrollmentId:ENROLLMENT,unitId:units[1].id,answers:{q1:0}});
 result=await project();assert.equal(result.paths[0].courses[0].progressPercent,100);assert.equal(result.paths[0].courses[0].completed,true);
 assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n,1);
 await login(db,MANAGER_AUTH);await assert.rejects(project(),/training_permission_denied/);
 await login(db,LEARNER_AUTH);await db.query('update academy.authoring_settings set enabled=false where tenant_id=$1',[T]);assert.deepEqual((await project()).paths,[]);
});

test('enabled learner paths preserve empty dashboards for inactive or blocked students while suspended bindings stay denied',async t=>{
 const db=await setup();t.after(()=>db.close());await seedEnrollment(db);
 await ready(db,{courseId:COURSE});
 const path=await action(db,'save_path',{expectedRevision:0,document:{title:'Existing learner path',courseIds:[COURSE]}});
 await action(db,'publish_path',{pathId:path.pathId,expectedRevision:path.revision,humanReviewed:true});
 const tokenHash='b'.repeat(64);
 await learning(db,'issue_invitation',{studentId:STUDENT,email:'learner@example.test',tokenHash});
 await login(db,LEARNER_AUTH);await learning(db,'accept_invitation',{tokenHash});
 const project=()=>call(db,'public.v1_academy_learner_paths',{p_slug:'marktone',p_offset:0});
 assert.equal((await project()).paths.length,1);
 for(const status of ['inactive','blocked']){
  await db.query('update academy.students set status=$1 where tenant_id=$2 and id=$3',[status,T,STUDENT]);
  const existing=await call(db,'public.v1_academy_training_snapshot',{p_slug:'marktone',p_role:'learner'});
  assert.deepEqual(existing.enrollments,[]);
  assert.deepEqual(await project(),{paths:[],hasMore:false,offset:0,pageSize:20});
 }
 await db.query("update academy.students set status='graduated' where tenant_id=$1 and id=$2",[T,STUDENT]);
 assert.equal((await project()).paths.length,1);
 await db.query("update academy.training_learner_accounts set status='suspended' where tenant_id=$1 and student_id=$2",[T,STUDENT]);
 await assert.rejects(project(),/training_permission_denied/);
 await login(db,MANAGER_AUTH);await assert.rejects(project(),/training_permission_denied/);
});
