import test from 'node:test';import assert from 'node:assert/strict';
import {zoomSetup,call,id,T,ADMIN_AUTH,LEARNER_AUTH,login,service} from './fixtures/zoom-database.mjs';
import {seedZoomLesson} from './fixtures/zoom-lesson.mjs';
test('ZM-12/14 T43/58: background report is owner-bound, expires, respects filters and rechecks revoked export permission',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {host}=await seedZoomLesson(db);
 await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.zoom.reports.export') on conflict do nothing",[id(21)]);
 const result=await call(db,'public.v1_zoom_report_request',{p_slug:'marktone',p_command_id:id(72001),p_options:{hostId:host}});assert.equal(result.total,1);assert.equal(result.state,'pending');
 await service(db);await call(db,'public.v1_zoom_reports_work',{});await service(db,false);
 const hash='a'.repeat(64);await call(db,'public.v1_zoom_report_ticket',{p_slug:'marktone',p_export_id:result.id,p_token_hash:hash});
 const args={p_slug:'marktone',p_export_id:result.id,p_token_hash:hash,p_page:0};let chunk=await call(db,'public.v1_zoom_report_chunk',args);assert.equal(chunk.rows.length,1);assert.equal(chunk.rows[0].attendance_percent,null);assert.equal(chunk.rows[0].evidence_quality,'unknown');assert.ok(!JSON.stringify(chunk).includes('join_url'));
 const filtered=await call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'reports',p_options:{hostId:id(79999)}});assert.equal(filtered.rows.length,0);assert.equal(filtered.summary.scheduled,0);
 await login(db,LEARNER_AUTH);await assert.rejects(call(db,'public.v1_zoom_report_chunk',args),/zoom_forbidden/);await login(db,ADMIN_AUTH);
 await db.query("delete from access_control.role_permissions where role_id=$1 and permission_key='tenant.zoom.reports.export'",[id(21)]);await assert.rejects(call(db,'public.v1_zoom_report_chunk',args),/zoom_forbidden/);
 await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.zoom.reports.export')",[id(21)]);await db.query("update zoom_core.report_exports set download_until=now()-interval '1 second' where id=$1",[result.id]);await assert.rejects(call(db,'public.v1_zoom_report_chunk',args),/zoom_access_expired/);
 await db.query("update access_control.memberships set status='suspended' where tenant_id=$1 and scope='tenant'",[T]);await assert.rejects(call(db,'public.v1_zoom_snapshot',{p_slug:'marktone',p_view:'accounts'}),/zoom_forbidden/);assert.equal(await call(db,'private_app.has_platform_permission',{p_permission:'platform.control.read'}),true);
 await db.query("update zoom_core.report_exports set expires_at=now()-interval '1 second' where tenant_id=$1",[T]);await service(db);await call(db,'public.v1_zoom_reports_work',{});assert.equal((await db.query('select count(*)::int n from zoom_core.report_chunks')).rows[0].n,0);
});
test('ZM-12: export spans 205 canonical sessions in three bounded chunks with no duplicates',async t=>{
 const db=await zoomSetup({complete:true});t.after(()=>db.close());const {session,link}=await seedZoomLesson(db);
 await db.query("insert into access_control.role_permissions(role_id,permission_key) values($1,'tenant.zoom.reports.export') on conflict do nothing",[id(21)]);
 await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,s.tenant_id,s.course_run_id,n,'Synthetic export '||n,s.starts_at+make_interval(mins=>n),s.ends_at+make_interval(mins=>n),'online' from generate_series(77001,77204)n cross join academy.course_run_sessions s where s.id=$1",[session]);
 await db.query("insert into zoom_core.links(tenant_id,session_id,connection_id,host_id,instructor_subject_id,state,desired,meeting_id) select s.tenant_id,s.id,l.connection_id,l.host_id,l.instructor_subject_id,'ready',jsonb_build_object('startsAt',s.starts_at,'endsAt',s.ends_at),'synthetic-'||s.id from academy.course_run_sessions s cross join zoom_core.links l where l.id=$1 and s.session_number between 77001 and 77204",[link]);
 const job=await call(db,'public.v1_zoom_report_request',{p_slug:'marktone',p_command_id:id(77250),p_options:{from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+90*86400000).toISOString()}});assert.equal(job.total,205);
 await service(db);for(let n=0;n<3;n++)await call(db,'public.v1_zoom_reports_work',{});await service(db,false);
 const hash='c'.repeat(64),ticket=await call(db,'public.v1_zoom_report_ticket',{p_slug:'marktone',p_export_id:job.id,p_token_hash:hash});assert.equal(ticket.pages,3);
 const rows=[];for(let page=0;page<3;page++){const chunk=await call(db,'public.v1_zoom_report_chunk',{p_slug:'marktone',p_export_id:job.id,p_token_hash:hash,p_page:page});assert.equal(chunk.rows.length,page===2?5:100);rows.push(...chunk.rows);}
 assert.equal(new Set(rows.map(x=>x.link_id)).size,205);
});
