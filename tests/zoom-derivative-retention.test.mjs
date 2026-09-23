import test from 'node:test';
import assert from 'node:assert/strict';
import {call,id,T,OTHER,COURSE,FOREIGN_COURSE,ENROLLMENT,ADMIN,ADMIN_AUTH,LEARNER_AUTH,login,service} from './fixtures/zoom-database.mjs';
import {seedZoomDerivative,authoring,revokeSource,derivativePreview,derivativeDelete} from './fixtures/zoom-derivative.mjs';
import {signZoomDeletionLedger,replayZoomDeletionLedger} from '../lib/zoom-deletion-ledger.mjs';

async function independentRows(db){return (await db.query(`select
 (select jsonb_agg(to_jsonb(x) order by id) from accounting_core.payments x) payments,
 (select jsonb_agg(to_jsonb(x) order by id) from academy.enrollments x) enrollments,
 (select jsonb_agg(to_jsonb(x) order by unit_id) from academy.training_unit_progress x) progress,
 (select jsonb_agg(to_jsonb(x) order by id) from academy.training_quiz_attempts x) attempts,
 (select jsonb_agg(to_jsonb(x) order by id) from academy.certificates x) certificates,
 (select to_jsonb(x) from academy.courses x where id=$1) foreign_course`,[FOREIGN_COURSE])).rows[0];}

test('T62: reviewed deletion redacts all canonical authoring copies and leaves independent academic/financial records unchanged',async t=>{
 const {db,draftId,connection,versionId,applyArgs,applied}=await seedZoomDerivative();t.after(()=>db.close());
 assert.deepEqual(await call(db,'public.v1_zoom_ai_apply',applyArgs),applied,'successful apply retry reuses the same receipt');
 await assert.rejects(call(db,'public.v1_zoom_ai_apply',{...applyArgs,p_payload:{...applyArgs.p_payload,body:'different'}}),/zoom_command_reused/);
 await call(db,'public.v1_academy_training_action',{p_slug:'marktone',p_action:'assign_version',p_command_id:id(97100),p_payload:{enrollmentId:ENROLLMENT,versionId}});
 const sourceUnit=(await db.query('select id from academy.training_units where version_id=$1 and position=3',[versionId])).rows[0].id;
 await db.query('insert into academy.training_unit_progress(tenant_id,enrollment_id,version_id,unit_id,completed_at,completed_by_subject_id) values($1,$2,$3,$4,now(),$5)',[T,ENROLLMENT,versionId,sourceUnit,ADMIN]);
 const before=await independentRows(db);
 const oldDoc=(await db.query('select document from academy.course_authoring where tenant_id=$1 and course_id=$2',[T,COURSE])).rows[0].document;
 const copied=await authoring(db,'create_course',{title:'Another synthetic course'},97109);
 await assert.rejects(authoring(db,'save_course',{courseId:copied.courseId,expectedRevision:1,document:oldDoc},97110),/zoom_source_course_mismatch/);
 await revokeSource(db,connection);
 // Cleanup remains available when Zoom is off. Membership/course rights remain required.
 await db.query('update zoom_core.settings set enabled=false where tenant_id=$1',[T]);
 const preview=await derivativePreview(db,draftId);
 assert.deepEqual(preview.conflicts,[]);assert.deepEqual(preview.changes.map(x=>x.kind).sort(),['draft','event','release','unit','version']);
 assert.ok(!JSON.stringify(preview).includes('SENSITIVE'));
 const result=await derivativeDelete(db,preview);assert.equal(result.changedCopies,5);assert.equal(result.backupDeletion,'requires_storage_policy');
 assert.deepEqual(await derivativeDelete(db,preview),result,'identical command is replayed safely');
 assert.deepEqual(await independentRows(db),before);
 const tables=['academy.course_authoring','academy.course_authoring_releases','academy.training_units','academy.training_course_versions','academy.training_learning_events','zoom_core.authoring_sources','zoom_core.commands'];
 for(const table of tables){const rows=(await db.query(`select to_jsonb(x) row from ${table} x`)).rows;assert.ok(!JSON.stringify(rows).includes('SENSITIVE'),table);}
 const nextDoc=(await db.query('select document,revision from academy.course_authoring where tenant_id=$1 and course_id=$2',[T,COURSE])).rows[0];
 assert.deepEqual(nextDoc.document.topics.slice(0,2),oldDoc.topics.slice(0,2));
 await assert.rejects(authoring(db,'save_course',{courseId:COURSE,expectedRevision:nextDoc.revision,document:oldDoc},97101),/zoom_deleted_source/);
 assert.equal((await db.query('select count(*)::int n from zoom_core.redaction_permits')).rows[0].n,0);
 await db.query("select set_config('zoom.redaction','true',false)");
 await assert.rejects(db.query("update academy.training_units set body='unauthorized' where id=$1",[sourceUnit]),/training_published_version_immutable/);
 await assert.rejects(db.query("update academy.course_authoring_releases set document='{}' where version_id=$1",[versionId]),/academy_authoring_release_immutable/);
 await assert.rejects(db.query('delete from academy.training_units where id=$1',[sourceUnit]),/training_published_version_immutable/);
});

test('T62/14: changed previews and mixed human edits stop deletion atomically; tenant and role spoofing never authorize it',async t=>{
 const {db,draftId,connection}=await seedZoomDerivative();t.after(()=>db.close());await revokeSource(db,connection);
 const preview=await derivativePreview(db,draftId);
 const row=(await db.query('select document,revision from academy.course_authoring where tenant_id=$1 and course_id=$2',[T,COURSE])).rows[0];
 row.document.topics[2].units[0].body+=' Human correction';
 await authoring(db,'save_course',{courseId:COURSE,expectedRevision:row.revision,document:row.document},97200);
 await assert.rejects(derivativeDelete(db,preview),/zoom_retention_preview_changed/);
 const changed=await derivativePreview(db,draftId);assert.equal(changed.conflicts[0].reason,'human_edit');
 await assert.rejects(derivativeDelete(db,changed,97201),/zoom_derivative_human_review_required/);
 assert.equal((await db.query('select deleted_at from zoom_core.authoring_sources')).rows[0].deleted_at,null);
 assert.ok(JSON.stringify((await db.query('select document from academy.course_authoring_releases')).rows).includes('SENSITIVE SOURCE BODY'));
 await login(db,LEARNER_AUTH);await db.query("select set_config('request.jwt.claims','{\"user_metadata\":{\"role\":\"admin\"}}',false)");
 await assert.rejects(derivativePreview(db,draftId),/zoom_forbidden/);
 await assert.rejects(derivativeDelete(db,changed,97202),/zoom_forbidden/);
 await login(db,ADMIN_AUTH);await assert.rejects(call(db,'public.v1_zoom_derivative_preview',{p_slug:'foreign',p_draft_id:draftId}),/zoom_forbidden/);
 await assert.rejects(db.query('insert into zoom_core.authoring_sources select $1,draft_id,$2,topic_hash,unit_hash,header_hash,redacted_topic_hash,redacted_unit_hash,redacted_header_hash,created_at,deleted_at,deleted_by,deletion_reason from zoom_core.authoring_sources',[OTHER,FOREIGN_COURSE]),/foreign key/);
 for(const role of ['anon','authenticated','service_role']){
  assert.equal((await db.query("select has_table_privilege($1,'zoom_core.redaction_permits','INSERT') allowed",[role])).rows[0].allowed,false);
  assert.equal((await db.query("select has_function_privilege($1,'zoom_core.derivative_execute(uuid,uuid,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,false);
 }
 await service(db,false);
});

test('T62: a separately signed ledger removes resurfaced derivatives from a real isolated database backup',async t=>{
 const {PGlite}=await import('@electric-sql/pglite');const {pgcrypto}=await import('@electric-sql/pglite/contrib/pgcrypto');
 const {db,draftId,connection}=await seedZoomDerivative();t.after(()=>db.close());await revokeSource(db,connection);
 const backup=await db.dumpDataDir('gzip');
 await derivativeDelete(db,await derivativePreview(db,draftId));await service(db);
 const entries=(await call(db,'public.v1_zoom_derivative_ledger',{p_tenant_id:T})).entries;
 assert.equal(entries.length,1);assert.ok(!JSON.stringify(entries).includes('SENSITIVE'));
 const key='ab'.repeat(32),envelope=signZoomDeletionLedger(T,entries,key);
 const restored=new PGlite({loadDataDir:backup,extensions:{pgcrypto}});t.after(()=>restored.close());await restored.waitReady;await service(restored);
 assert.ok(JSON.stringify((await restored.query('select document from academy.course_authoring_releases')).rows).includes('SENSITIVE SOURCE BODY'));
 let writes=0;const rpc=async(name,args)=>{writes++;return call(restored,`public.${name}`,args);};
 await assert.rejects(replayZoomDeletionLedger({...envelope,payload:envelope.payload.replace('topic_hash','wrong_hash')},T,key,rpc),/zoom_deletion_signature_invalid/);
 await assert.rejects(replayZoomDeletionLedger(envelope,OTHER,key,rpc),/zoom_deletion_ledger_invalid/);
 assert.equal(writes,0,'tampering and tenant substitution fail before the first write');
 await assert.rejects(call(restored,'public.v1_zoom_derivative_replay',{p_tenant_id:T,p_tombstone:{...entries[0],topic_hash:'a'.repeat(64)}}),/zoom_deletion_ledger_invalid/);
 const [result]=await replayZoomDeletionLedger(envelope,T,key,rpc);assert.equal(result.changedCopies,5);
 assert.equal((await replayZoomDeletionLedger(envelope,T,key,rpc))[0].changedCopies,0,'safe resume after a lost response');
 for(const table of ['academy.course_authoring','academy.course_authoring_releases','academy.training_units','academy.training_course_versions','academy.training_learning_events'])assert.ok(!JSON.stringify((await restored.query(`select to_jsonb(x) from ${table} x`)).rows).includes('SENSITIVE'),table);
 assert.equal((await restored.query("select count(*)::int n from zoom_core.retention_runs where status='derivative_ledger_replayed'")).rows[0].n,1);
 await service(restored,false);await assert.rejects(call(restored,'public.v1_zoom_derivative_ledger',{p_tenant_id:T}),/zoom_forbidden/);
});
