import test from 'node:test';
import assert from 'node:assert/strict';
import {zoomSetup,call,login,ADMIN_AUTH,LEARNER_AUTH,ENROLLMENT,seedEnrollment} from './fixtures/zoom-database.mjs';

test('prepared Zoom schema exposes authorized empty settings while provider work stays disabled and non-Zoom eligibility is unchanged',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());
 // Disposable PGlite only: no live project or production tenant rows are used.
 await db.exec('update zoom_core.settings set enabled=false');
 await login(db,ADMIN_AUTH);
 const snapshot=await call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'accounts'});
 assert.equal(snapshot.enabled,false);assert.deepEqual(snapshot.accounts,[]);assert.deepEqual(snapshot.hosts,[]);
 await assert.rejects(()=>call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:'add',p_state_hash:'a'.repeat(64)}),/zoom_not_enabled/);
 await login(db,LEARNER_AUTH);
 await assert.rejects(()=>call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'accounts'}),/zoom_forbidden/);
 await login(db,ADMIN_AUTH);
 await assert.rejects(()=>call(db,'public.v1_zoom_snapshot',{p_slug:'foreign',p_view:'accounts'}),/zoom_forbidden/);
 await seedEnrollment(db);
 const args={p_enrollment_id:ENROLLMENT};
 assert.deepEqual(await call(db,'private_app.training_eligibility',args),await call(db,'private_app.training_eligibility_before_zoom_v1',args));
 assert.deepEqual(await call(db,'private_app.training_learning_eligibility_v1',args),await call(db,'private_app.training_learning_eligibility_before_zoom_v1',args));
 for(const name of ['connections','oauth_attempts','links','operations','reservations']){
  assert.equal((await db.query(`select count(*)::int as n from zoom_core.${name}`)).rows[0].n,0,name);
 }
});
