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
