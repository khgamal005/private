import {connect,syncHost,service,seedEnrollment,seedPayment,call,id,T,RUN,INSTRUCTOR,ADMIN,STUDENT,ENROLLMENT,LEARNER,LEARNER_AUTH,HANDOFF,INVOICE,ACCOUNT,login,ADMIN_AUTH} from './zoom-database.mjs';
export async function seedZoomLesson(db,{state='ready',kind='meeting'}={}){
 await seedEnrollment(db);await seedPayment(db);
 await db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true) on conflict(tenant_id) do update set enabled=true',[T]);
 await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)",[T,HANDOFF,INVOICE,ACCOUNT,ADMIN]);
 await db.query("insert into access_control.subjects(id,auth_user_id,email,full_name) values($1,$2,'learner@example.test','Synthetic learner')",[LEARNER,LEARNER_AUTH]);
 await db.query('insert into academy.training_learner_accounts(tenant_id,student_id,subject_id) values($1,$2,$3)',[T,STUDENT,LEARNER]);
 await db.query('insert into academy.training_run_instructors(tenant_id,run_id,subject_id,assigned_by_subject_id) values($1,$2,$3,$4)',[T,RUN,INSTRUCTOR,ADMIN]);
 const connection=(await connect(db)).connectionId;await syncHost(db,connection);const host=(await db.query('select id from zoom_core.hosts where connection_id=$1',[connection])).rows[0].id;
 await db.query('update zoom_core.hosts set allowed=true,instructor_subject_id=$1 where id=$2',[INSTRUCTOR,host]);
 await db.query("insert into zoom_core.host_instructors(tenant_id,host_id,subject_id,provider_user_id,provider_email,authorization_kind,verified_at) values($1,$2,$3,'host-A','instructor@example.test','host',now())",[T,host,INSTRUCTOR]);
 const session=id(50001),link=id(50002),instance=id(50003);
 await db.query("insert into academy.course_run_sessions(id,tenant_id,course_run_id,session_number,title,starts_at,ends_at,delivery_mode,status) values($1,$2,$3,1,'Synthetic live lesson',now()-interval '10 minutes',now()+interval '50 minutes','online','scheduled')",[session,T,RUN]);
 await db.query("insert into zoom_core.links(id,tenant_id,session_id,connection_id,host_id,instructor_subject_id,kind,meeting_id,state,desired,observed) select $1,$2,$3,$4,$5,$6,$7,'12345678901',$8,jsonb_build_object('startsAt',starts_at,'endsAt',ends_at,'title',title,'attendees',10,'recording','off'),'{\"registration\":0}' from academy.course_run_sessions where id=$3",[link,T,session,connection,host,INSTRUCTOR,kind,state]);
 await service(db,false);await login(db,ADMIN_AUTH);
 return {connection,host,session,link,instance};
}
export async function grant(db,session,action='join'){
 return call(db,'public.v1_zoom_access',{p_slug:'marktone',p_session_id:session,p_enrollment_id:action==='join'?ENROLLMENT:null,p_action:action});
}
