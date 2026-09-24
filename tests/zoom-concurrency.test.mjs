import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {zoomSetup,connect,syncHost,service,call,id,T,RUN,INSTRUCTOR,ADMIN,login,ADMIN_AUTH,STAFF} from './fixtures/zoom-database.mjs';
const databaseUrl=process.env.ZOOM_TEST_DATABASE_URL;
function localTestUrl(value){const u=new URL(value);assert.ok(['postgres:','postgresql:'].includes(u.protocol));assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));assert.equal(u.pathname,'/zoom_concurrency');assert.equal(u.search,'');assert.equal(u.hash,'');return u.toString();}
// Poll actual lock state instead of sleeping or assuming the calls overlapped.
// Both backends must be blocked through this controller before it releases them.
async function blockedBarrier(controller, workerPids, controllerPid) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    await controller.query('select pg_stat_clear_snapshot()');
    const { rows } = await controller.query(`select pid, wait_event_type,
      pg_blocking_pids(pid) blockers from pg_stat_activity where pid=any($1::int[])`, [workerPids]);
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const reachesController = (pid, seen = new Set()) => {
      if (pid === controllerPid) return true;
      if (seen.has(pid)) return false;
      seen.add(pid);
      return (byPid.get(pid)?.blockers ?? []).some(blocker => reachesController(blocker, seen));
    };
    if (workerPids.every(pid => byPid.get(pid)?.wait_event_type === 'Lock' && reachesController(pid))) return;
    await yieldTurn();
  }
  throw new Error('Both concurrent transactions did not reach the controlled lock barrier');
}

async function transaction(client, operation) {
  try {
    await client.query('begin');
    const value = await operation(client);
    await client.query('commit');
    return { ok: true, value };
  } catch (error) {
    await client.query('rollback');
    return { ok: false, error: { code: error.code, message: error.message } };
  }
}

async function race(controller, workers, lock, operations) {
  await controller.query('begin');
  let pending;
  try {
    await lock(controller);
    const controllerPid = (await controller.query('select pg_backend_pid() pid')).rows[0].pid;
    const pids = await Promise.all(workers.map(async client => (await client.query('select pg_backend_pid() pid')).rows[0].pid));
    pending = workers.map((client, index) => transaction(client, operations[index]));
    await blockedBarrier(controller, pids, controllerPid);
    await controller.query('commit');
    return await Promise.all(pending);
  } finally {
    // Releases a barrier even if the overlap assertion failed. Workers have
    // independent statement/lock timeouts and always roll back on failure.
    await controller.query('rollback');
    if (pending) await Promise.all(pending);
  }
}


test('ZM-03/13 T08/14: independent PostgreSQL connections compete for the final slot and rotating token',{skip:!databaseUrl&&'Requires explicit disposable loopback ZOOM_TEST_DATABASE_URL',timeout:240000},async t=>{
 const {Client}=await import('pg');const clients=[];t.after(()=>Promise.allSettled(clients.map(c=>c.end())));
 for(const label of ['controller','a','b']){const c=new Client({connectionString:localTestUrl(databaseUrl),application_name:`zoom-race-${label}`,statement_timeout:15000,lock_timeout:10000});clients.push(c);await c.connect();}
 const [controller,...workers]=clients;
 assert.equal((await controller.query("select count(*)::int n from pg_namespace where nspname in ('zoom_core','academy','core')")).rows[0].n,0,'Refuse non-empty database');
 const db={query:(s,p)=>controller.query(s,p),exec:s=>controller.query(s),close:async()=>{}};
 await zoomSetup({database:db,complete:true});
 // First-use setup is serialized too: concurrent operators create one disabled
 // settings row, and neither request can activate it as a side effect.
 await db.query('delete from zoom_core.settings where tenant_id=$1',[T]);
 for(const c of workers){await login(c,ADMIN_AUTH);await service(c,false);}
 const initialized=await race(controller,workers,c=>c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${T}:setup`]),workers.map((_,n)=>c=>call(c,'public.v1_zoom_initialize',{p_slug:'marktone',p_command_id:id(4490+n),p_payload:{ownerStaffId:STAFF,environment:'test'}})));
 assert.equal(initialized.filter(r=>r.ok&&r.value.enabled===false).length,2,JSON.stringify(initialized));
 assert.equal((await db.query('select count(*)::int n from zoom_core.settings where tenant_id=$1',[T])).rows[0].n,1);
 await service(db);
 await call(db,'public.v1_zoom_activate',{p_slug:'marktone',p_auth_user_id:ADMIN_AUTH,p_subject_id:ADMIN,p_command_id:id(4492),p_revision:1,p_environment:'test'});
 const connection=(await connect(db)).connectionId;await syncHost(db,connection);
 const host=(await db.query('select id from zoom_core.hosts')).rows[0].id;
 await db.query('update zoom_core.hosts set allowed=true,instructor_subject_id=$1 where id=$2',[INSTRUCTOR,host]);
 await db.query("insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,authorization_kind,verified_at) values($1,$2,$3,'host-A','host',now()),($1,$2,$4,'teacher-B','alternative_host',now())",[T,host,INSTRUCTOR,ADMIN]);
 await db.query('insert into academy.training_run_instructors(tenant_id,run_id,subject_id,assigned_by_subject_id) values($1,$2,$3,$4),($1,$2,$4,$4)',[T,RUN,INSTRUCTOR,ADMIN]);
 for(let n=0;n<2;n++)await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) values($1,$2,$3,$4,'Race session','2031-01-01 10:00Z','2031-01-01 11:00Z','online')",[id(4500+n),T,RUN,n+1]);
 for(const c of workers){await login(c,ADMIN_AUTH);await service(c,false);}
 const results=await race(controller,workers,c=>c.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`${T}:zoom-schedule`]),workers.map((_,n)=>c=>call(c,'public.v1_zoom_action',{p_slug:'marktone',p_action:'assign',p_command_id:id(4510+n),p_payload:{sessionId:id(4500+n),instructorId:n?ADMIN:INSTRUCTOR,expectedVersion:0,attendees:25}})));
 assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));assert.equal(results.filter(r=>r.error?.message==='zoom_schedule_conflict').length,1,JSON.stringify(results));
 assert.equal((await db.query("select count(*)::int n from zoom_core.reservations where state<>'released'")).rows[0].n,1);
 await db.query("update zoom_core.connections set expires_at=now()-interval '1 minute' where id=$1",[connection]);for(const c of workers)await service(c);
 const tokens=await race(controller,workers,c=>c.query('select id from zoom_core.connections where id=$1 for update',[connection]),workers.map((_,n)=>c=>call(c,'public.v1_zoom_token_lease',{p_connection_id:connection,p_lease_id:id(4520+n),p_action:'claim'})));
 assert.equal(tokens.filter(r=>r.ok&&r.value.status==='refresh').length,1);assert.equal(tokens.filter(r=>r.ok&&r.value.status==='busy').length,1);
 const {zoomLoadBenchmark}=await import('./fixtures/zoom-load-benchmark.mjs');await zoomLoadBenchmark(controller,workers,message=>t.diagnostic(message));
 t.diagnostic('Two backend PIDs observed blocked at the controlled lock barrier before release; one reservation and one refresh claim committed.');
});
