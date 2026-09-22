import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {zoomSetup,connect,syncHost,service,call,id,T,OTHER,ADMIN_AUTH,login} from './fixtures/zoom-database.mjs';
let db;before(async()=>{db=await zoomSetup();});after(async()=>{await db?.close();});
test('ZM-01/02 T01/03: two accounts persist, reconnect preserves unique hosts and capacity',async()=>{
 const a=await connect(db),b=await connect(db,{account:'account-B',user:'host-B',state:'b'.repeat(64)});
 assert.notEqual(a.connectionId,b.connectionId);await syncHost(db,a.connectionId);
 const again=await connect(db,{mode:'reconnect',connectionId:a.connectionId,state:'c'.repeat(64)});assert.equal(a.connectionId,again.connectionId);
 await syncHost(db,a.connectionId);assert.equal((await db.query('select count(*)::int n from zoom_core.hosts')).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from zoom_core.connections')).rows[0].n,2);
});
test('ZM-01/14 T04–07: mismatch, cross-tenant account, expired/replayed state and revoked membership fail',async()=>{
 const connection=(await db.query('select id from zoom_core.connections where account_id=$1',['account-A'])).rows[0].id;
 await assert.rejects(connect(db,{mode:'reconnect',connectionId:connection,account:'wrong-account',state:'d'.repeat(64)}),/zoom_account_mismatch/);
 await assert.rejects(call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:'claim',p_state_hash:'a'.repeat(64)}),/zoom_invalid_state/);
 await db.query('update zoom_core.connections set tenant_id=$1 where account_id=$2',[OTHER,'account-B']);
 await assert.rejects(connect(db,{account:'account-B',state:'e'.repeat(64)}),/zoom_account_unavailable/);
 await db.query('update zoom_core.connections set tenant_id=$1 where account_id=$2',[T,'account-B']);
 await call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:'add',p_state_hash:'f'.repeat(64)});
 await db.query("update access_control.memberships set status='suspended' where subject_id=(select id from access_control.subjects where auth_user_id=$1)",[ADMIN_AUTH]);
 await assert.rejects(call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:'claim',p_state_hash:'f'.repeat(64)}),/zoom_forbidden/);
 await db.query("update access_control.memberships set status='active' where subject_id=(select id from access_control.subjects where auth_user_id=$1)",[ADMIN_AUTH]);
 await db.query("update zoom_core.oauth_attempts set expires_at=now()-interval '1 second' where state_hash=$1",['f'.repeat(64)]);
 await assert.rejects(call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:'claim',p_state_hash:'f'.repeat(64)}),/zoom_invalid_state/);
});
test('ZM-13 T08: refresh lease serializes rotation, fences stale worker and treats lost refresh as uncertain',async()=>{
 await service(db);const c=(await db.query('select * from zoom_core.connections where account_id=$1',['account-A'])).rows[0];
 await db.query("update zoom_core.connections set expires_at=now() where id=$1",[c.id]);
 const lease=id(201),args={p_connection_id:c.id,p_lease_id:lease,p_action:'claim'};
 const first=await call(db,'public.v1_zoom_token_lease',args);assert.equal(first.status,'refresh');
 assert.equal((await call(db,'public.v1_zoom_token_lease',{...args,p_lease_id:id(202)})).status,'busy');
 await assert.rejects(call(db,'public.v1_zoom_token_lease',{...args,p_action:'complete',p_generation:first.generation-1}),/zoom_stale_lease/);
 const done=await call(db,'public.v1_zoom_token_lease',{...args,p_action:'complete',p_generation:first.generation,p_tokens:{access_token:'rotated',refresh_token:'rotated-refresh',expires_in:3600}});assert.equal(done.accessToken,'rotated');
 assert.equal((await call(db,'public.v1_zoom_token_lease',args)).status,'ready');
 await db.query("update zoom_core.connections set expires_at=now(),refresh_lease=$2,refresh_until=now()-interval '1 second' where id=$1",[c.id,id(203)]);
 assert.equal((await call(db,'public.v1_zoom_token_lease',args)).status,'reauth_required');
});
test('ZM-14/15 T49/50: service credentials cannot be requested by a learner; addon checked without LMS activation',async()=>{
 await service(db,false);await login(db,ADMIN_AUTH);
 await assert.rejects(call(db,'public.v1_zoom_token_lease',{p_connection_id:id(1),p_lease_id:id(2),p_action:'claim'}),/zoom_forbidden/);
 await db.query("select set_config('fixture.zoom_addon','no',false)");
 await assert.rejects(call(db,'public.v1_zoom_oauth',{p_slug:'marktone',p_action:'add',p_state_hash:'1'.repeat(64)}),/zoom_not_enabled/);
 await db.query("select set_config('fixture.zoom_addon','yes',false)");
 const policies=await db.query("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='zoom_core' and c.relkind='r'");assert.ok(policies.rows.every(x=>x.relrowsecurity));
 assert.equal((await db.query('select count(*)::int n from academy.training_journey_settings where enabled')).rows[0].n,0);
});
