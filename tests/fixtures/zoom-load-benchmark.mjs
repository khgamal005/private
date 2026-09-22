import assert from 'node:assert/strict';
import {cpus,totalmem,platform,arch} from 'node:os';
import {createHash} from 'node:crypto';
import {call,service,id} from './zoom-database.mjs';
export async function zoomLoadBenchmark(controller,workers,diagnostic){
 assert.equal((await controller.query('select current_database() name')).rows[0].name,'zoom_concurrency');
 await controller.query(`create table public.zoom_load_fixture as select n,md5('zoom-load-tenant:'||n)::uuid tenant_id,md5('zoom-load-subject:'||n)::uuid subject_id,md5('zoom-load-auth:'||n)::uuid auth_id,md5('zoom-load-member:'||n)::uuid membership_id,md5('zoom-load-role:'||n)::uuid role_id,md5('zoom-load-connection:'||n)::uuid connection_id from generate_series(1,3000)n`);
 await controller.query("insert into core.tenants(id,organization_id,tenant_key,slug,name,status) select tenant_id,$1,'zoom-bench-'||n,'zoom-bench-'||n,'Synthetic tenant '||n,'active' from public.zoom_load_fixture",[id(20)]);
 await controller.query("insert into auth.users(id,email,email_confirmed_at) select auth_id,'zoom-bench-'||n||'@example.test',now() from public.zoom_load_fixture");
 await controller.query("insert into access_control.subjects(id,auth_user_id,email,full_name) select subject_id,auth_id,'zoom-bench-'||n||'@example.test','Synthetic operator '||n from public.zoom_load_fixture");
 await controller.query("insert into access_control.memberships(id,subject_id,tenant_id,scope) select membership_id,subject_id,tenant_id,'tenant' from public.zoom_load_fixture");
 await controller.query("insert into access_control.roles(id,tenant_id,role_key,name_ar,scope) select role_id,tenant_id,'zoom_benchmark','Synthetic operator','tenant' from public.zoom_load_fixture");
 await controller.query('insert into access_control.membership_roles(membership_id,role_id) select membership_id,role_id from public.zoom_load_fixture');
 await controller.query("insert into access_control.role_permissions(role_id,permission_key) select role_id,'tenant.zoom.connections.manage' from public.zoom_load_fixture");
 await controller.query("insert into zoom_core.settings(tenant_id,enabled,environment) select tenant_id,true,'test' from public.zoom_load_fixture");
 await controller.query("insert into zoom_core.connections(id,tenant_id,environment,account_id,grant_user_id,label,status) select connection_id,tenant_id,'test','zoom-load-account-'||n,'zoom-load-user-'||n,'Synthetic account '||n,'connected' from public.zoom_load_fixture");
 await controller.query("insert into zoom_core.hosts(tenant_id,connection_id,account_id,user_id,name,provider_active,licensed,capacity,verified_at,verification_source) select tenant_id,connection_id,'zoom-load-account-'||n,'zoom-load-user-'||n,'Synthetic host '||n,true,true,100,now(),'synthetic-contract' from public.zoom_load_fixture");
 const rows=(await controller.query('select * from public.zoom_load_fixture order by n')).rows;
 const measurements=[];const hash=s=>createHash('sha256').update(s).digest('hex');
 for(const size of [100,1000,3000]){
  let index=0;const reads=[],writes=[];let duplicates=0;const start=performance.now();
  await Promise.all(workers.map(async worker=>{
   for(;;){const n=index++;if(n>=size)break;const row=rows[n];await worker.query("select set_config('request.jwt.claim.sub',$1,false)",[row.auth_id]);await service(worker,false);
    let at=performance.now();const snapshot=await call(worker,'public.v1_zoom_snapshot',{p_slug:`zoom-bench-${row.n}`,p_view:'accounts'});reads.push(performance.now()-at);
    assert.equal(snapshot.accounts.length,1);assert.equal(snapshot.accounts[0].id,row.connection_id);assert.equal(snapshot.hosts.length,1);
    await service(worker);const event={p_environment:'test',p_dedupe:hash(`zoom-load:${size}:${n}`),p_event:{accountId:`zoom-load-account-${row.n}`,event:'meeting.started',eventTs:Date.now(),meetingId:`synthetic-${size}-${n}`,uuid:`synthetic-instance-${size}-${n}`}};
    at=performance.now();assert.equal((await call(worker,'public.v1_zoom_receive_event',event)).status,'stored');writes.push(performance.now()-at);
    if(n%4===0){assert.equal((await call(worker,'public.v1_zoom_receive_event',event)).status,'duplicate');duplicates++;}
   }
  }));
  const duration=performance.now()-start;const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
  measurements.push({activeTenants:size,requests:size*2+duplicates,workers:workers.length,durationMs:Math.round(duration),requestsPerSecond:Number(((size*2+duplicates)/(duration/1000)).toFixed(2)),readP95Ms:Number(percentile(reads,.95).toFixed(2)),webhookDatabaseP95Ms:Number(percentile(writes,.95).toFixed(2)),errors:0,uniqueEvents:size,duplicates});
 }
 const stored=(await controller.query("select count(*)::int n from zoom_core.events where payload->>'accountId' like 'zoom-load-account-%'")).rows[0].n;assert.equal(stored,4100);
 assert.equal((await controller.query("select count(*)::int n from zoom_core.events e join zoom_core.connections c on c.id=e.connection_id where e.tenant_id<>c.tenant_id or e.payload->>'accountId'<>c.account_id")).rows[0].n,0);
 const result={recordedAt:new Date().toISOString(),runtime:{node:process.version,os:platform(),arch:arch(),cpuModel:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),postgres:(await controller.query('select version() version')).rows[0].version},dataset:{tenants:3000,operators:3000,accounts:3000,hosts:3000,events:4100},measurements,limitations:['Synthetic local PostgreSQL; no live Zoom, external HTTP, production encryption or messaging.','Webhook metric covers durable database receipt; it excludes network and signature verification.','Bounded account snapshots and signed-event equivalents only; this does not prove 3000 simultaneous lectures.']};
 diagnostic('ZOOM_LOAD_REPORT '+JSON.stringify(result));return result;
}
