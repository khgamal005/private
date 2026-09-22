begin;
-- Extend both historical checks while preserving all subsequently added job types.
do $$declare r record;expression text;begin
 for r in select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='academy.training_automation_jobs'::regclass and contype='c' and pg_get_constraintdef(oid) like '%job_type%' loop
  expression:=substring(r.definition from '^CHECK \((.*)\)$');
  if expression is null then raise exception 'zoom_queue_constraint_unrecognized';end if;
  execute format('alter table academy.training_automation_jobs drop constraint %I',r.conname);
  execute format('alter table academy.training_automation_jobs add constraint %I check ((%s) or (job_type in (''zoom_joining'',''zoom_changed'',''zoom_cancelled'',''zoom_recording'') and channel in (''whatsapp'',''email'') and enrollment_id is not null and session_id is not null and recipient is not null and message_text is not null))',r.conname,expression);
 end loop;
end $$;
create function zoom_core.enqueue_messages(lid uuid,event_key text,asset uuid default null) returns integer language plpgsql security definer set search_path='' as $$
declare l zoom_core.links%rowtype;s academy.course_run_sessions%rowtype;cfg academy.training_automation_settings%rowtype;e record;job_key text;channel_key text;recipient_value text;due timestamptz;total int:=0;
begin
 select * into l from zoom_core.links where id=lid;select * into s from academy.course_run_sessions where tenant_id=l.tenant_id and id=l.session_id;
 if event_key in ('ready','changed') then s.starts_at:=(l.desired->>'startsAt')::timestamptz;end if;
 select * into cfg from academy.training_automation_settings where tenant_id=l.tenant_id;
 if cfg.id is null or event_key not in ('ready','changed','cancelled','recording') then return 0;end if;
 if event_key in ('ready','changed','cancelled') then update academy.training_automation_jobs set status='cancelled',last_error='zoom_superseded' where tenant_id=l.tenant_id and session_id=s.id and status in ('pending','failed','waiting_configuration') and coalesce((metadata->>'zoomRevision')::int,-1)<>l.revision;end if;
 for e in select en.id,st.phone,st.email from academy.enrollments en join academy.students st on st.tenant_id=en.tenant_id and st.id=en.student_id where en.tenant_id=l.tenant_id and en.course_run_id=s.course_run_id and en.status in ('confirmed','active','completed') loop
  recipient_value:=private_app.normalize_training_phone(e.phone,cfg.whatsapp_country_code);channel_key:='whatsapp';
  if cfg.primary_channel='email' or recipient_value is null then
   if cfg.primary_channel='email' or cfg.email_fallback_enabled then recipient_value:=e.email;channel_key:='email';else continue;end if;
  end if;
  if recipient_value is null or (channel_key='email' and recipient_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then continue;end if;
  for job_key in select unnest(case event_key when 'ready' then array['zoom_joining','session_reminder_24h','session_reminder_1h'] when 'changed' then array['zoom_changed','session_reminder_24h','session_reminder_1h'] when 'cancelled' then array['zoom_cancelled'] else array['zoom_recording'] end) loop
   if job_key='zoom_joining' and (not cfg.joining_enabled or exists(select 1 from academy.training_automation_jobs where tenant_id=l.tenant_id and session_id=s.id and enrollment_id=e.id and job_type='zoom_joining' and status='sent')) then continue;end if;
   if (job_key='session_reminder_24h' and not cfg.reminder_24h_enabled) or(job_key='session_reminder_1h' and not cfg.reminder_1h_enabled) then continue;end if;
   due:=case job_key when 'session_reminder_24h' then s.starts_at-interval '24 hours' when 'session_reminder_1h' then s.starts_at-interval '1 hour' else now() end;
   if job_key like 'session_reminder_%' and due<=now() then continue;end if;
   insert into academy.training_automation_jobs(tenant_id,course_run_id,session_id,enrollment_id,dedupe_key,job_type,channel,recipient,subject,message_text,due_at,max_attempts,metadata)
   values(l.tenant_id,s.course_run_id,s.id,e.id,'zoom:'||s.id||':'||e.id||':'||job_key||':'||l.revision||':'||coalesce(asset::text,''),job_key,channel_key,recipient_value,'محاضرات أودير','تُبنى الرسالة من النسخة الحالية عند الإرسال.',due,1,jsonb_build_object('source','zoom_v1','zoomRevision',l.revision,'recordingId',asset)) on conflict(tenant_id,dedupe_key) do nothing;
   total:=total+1;
  end loop;
 end loop;return total;
end $$;
create function zoom_core.notify_link() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state in ('ready','imported','cancelled') and new.state is distinct from old.state then
  perform zoom_core.enqueue_messages(new.id,case when new.state='cancelled' then 'cancelled' when old.state='updating' then 'changed' else 'ready' end);
 end if;return new;
end $$;
create trigger zoom_link_messages after update of state on zoom_core.links for each row execute function zoom_core.notify_link();
create function zoom_core.notify_recording() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='published' and old.state<>'published' then perform zoom_core.enqueue_messages((select link_id from zoom_core.instances where tenant_id=new.tenant_id and id=new.instance_id),'recording',new.id);end if;return new;
end $$;
create trigger zoom_recording_messages after update of state on zoom_core.recordings for each row execute function zoom_core.notify_recording();
create or replace function public.v1_zoom_message_check(p_job_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j academy.training_automation_jobs%rowtype;l zoom_core.links%rowtype;f jsonb;s academy.course_run_sessions%rowtype;st academy.students%rowtype;r academy.course_runs%rowtype;ten core.tenants%rowtype;url_value text;when_value text;heading text;message_value text;
begin
 perform zoom_core.service_only();select * into j from academy.training_automation_jobs where id=p_job_id;
 select * into l from zoom_core.links where tenant_id=j.tenant_id and session_id=j.session_id;
 if l.id is null then return jsonb_build_object('managed',false);end if;
 if j.channel='zoom' then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_new_engine_required');end if;
 if j.status<>'processing' or j.metadata->>'zoomRevision' is distinct from l.revision::text then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_message_superseded');end if;
 select * into s from academy.course_run_sessions where tenant_id=j.tenant_id and id=j.session_id;
 select * into r from academy.course_runs where tenant_id=j.tenant_id and id=s.course_run_id;
 select * into ten from core.tenants where id=j.tenant_id;
 select x.* into st from academy.students x join academy.enrollments en on en.tenant_id=x.tenant_id and en.student_id=x.id where en.tenant_id=j.tenant_id and en.id=j.enrollment_id and en.course_run_id=s.course_run_id and en.status in ('confirmed','active','completed');
 f:=private_app.training_journey_financial_access_v1(j.enrollment_id);
 if st.id is null or not coalesce((f->>'trainingAllowed')::boolean,false) or not private_app.tenant_addon_enabled(j.tenant_id,'addon.integration.zoom') or not exists(select 1 from zoom_core.settings where tenant_id=j.tenant_id and enabled) then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_message_not_eligible');end if;
 if j.job_type='zoom_cancelled' then
  if l.state<>'cancelled' then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_message_superseded');end if;
 elsif j.job_type='zoom_recording' then
  if not exists(select 1 from zoom_core.recordings where tenant_id=j.tenant_id and id=(j.metadata->>'recordingId')::uuid and state='published' and expires_at>now()) then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_recording_unavailable');end if;
 elsif s.status='cancelled' or l.state not in ('ready','live','imported') then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_message_not_ready');end if;
 url_value:='https://odeir.com/training/'||ten.slug||'/sessions/'||s.id;
 when_value:=to_char(s.starts_at at time zone ten.timezone,'YYYY-MM-DD HH24:MI')||' ('||ten.timezone||')';
 heading:=case j.job_type when 'zoom_cancelled' then 'أُلغيت المحاضرة' when 'zoom_changed' then 'تغير موعد المحاضرة' when 'zoom_recording' then 'أصبح تسجيل المحاضرة متاحًا' when 'zoom_joining' then 'محاضرتك جاهزة' else 'تذكير بموعد المحاضرة' end;
 message_value:=heading||': '||s.title||E'\n'||when_value||E'\n'||url_value;
 return jsonb_build_object('managed',true,'allowed',true,'url',url_value,'revision',l.revision,'job',jsonb_build_object('type',j.job_type,'subject',heading,'messageText',message_value,'metadata',jsonb_build_object('studentName',st.full_name,'courseName',(select title_ar from academy.courses where tenant_id=j.tenant_id and id=r.course_id),'runName',r.title,'sessionTitle',s.title,'startDate',when_value,'venueOrLink',url_value)));
end $$;
-- Zoom-only login authorization uses the existing learner and instructor identities.
create function public.v1_zoom_portal(p_slug text,p_role text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);
begin
 if p_role='learner' and not exists(select 1 from academy.enrollments e where e.tenant_id=t and private_app.training_is_learner_v1(t,e.id)) then raise exception 'zoom_forbidden';end if;
 if p_role='instructor' and not exists(select 1 from academy.training_run_instructors i where i.tenant_id=t and private_app.training_is_instructor_v1(t,i.run_id)) then raise exception 'zoom_forbidden';end if;
 if p_role not in ('learner','instructor') then raise exception 'zoom_forbidden';end if;
 return jsonb_build_object('slug',p_slug,'role',p_role,'lmsEnabled',private_app.academy_platform_enabled_v1(t,'lms'));
end $$;
-- Each batch uses the identical transactional candidate/reservation path. A single
-- conflict rolls back the batch; the caller can preview and choose a smaller set.
create function public.v1_zoom_batch(p_slug text,p_command_id uuid,p_sessions jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);item jsonb;result jsonb;rows jsonb:='[]';
begin
 if not zoom_core.allowed(t,'sessions.manage') or jsonb_typeof(p_sessions)<>'array' or jsonb_array_length(p_sessions) not between 1 and 100 then raise exception 'zoom_invalid_request';end if;
 result:=zoom_core.command(t,p_command_id,'batch',p_sessions);if result is not null then return result;end if;
 for item in select value from jsonb_array_elements(p_sessions) loop rows:=rows||jsonb_build_array(public.v1_zoom_action(p_slug,'assign',gen_random_uuid(),item));end loop;
 update zoom_core.commands set result=jsonb_build_object('sessions',rows) where tenant_id=t and id=p_command_id;return jsonb_build_object('sessions',rows);
end $$;
-- Explicit human mapping for provider occurrences whose API omits occurrence IDs.
create function public.v1_zoom_map_instance(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);l zoom_core.links%rowtype;result jsonb;ev zoom_core.events%rowtype;
begin
 if not zoom_core.allowed(t,'attendance.review') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,'map_instance',p_payload);if result is not null then return result;end if;
 select * into l from zoom_core.links where tenant_id=t and id=(p_payload->>'linkId')::uuid;
 select * into ev from zoom_core.events where tenant_id=t and connection_id=l.connection_id and id=(p_payload->>'eventId')::uuid and state='review' and payload->>'meetingId'=l.meeting_id;
 if l.id is null or ev.id is null or nullif(ev.payload->>'uuid','') is null or length(trim(coalesce(p_payload->>'reason','')))<5 then raise exception 'zoom_invalid_instance_mapping';end if;
 insert into zoom_core.instances(tenant_id,connection_id,link_id,uuid) values(t,l.connection_id,l.id,ev.payload->>'uuid');
 update zoom_core.events set state='pending' where tenant_id=t and connection_id=l.connection_id and payload->>'uuid'=ev.payload->>'uuid' and state='review';
 result:=jsonb_build_object('status','mapped');update zoom_core.commands set result=jsonb_build_object('status','mapped') where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.map_instance','zoom_link',l.id::text,t,jsonb_build_object('reason',left(p_payload->>'reason',500)));return result;
end $$;

-- Reuse canonical invitation/account tables; this grant never enables LMS.
create function public.v1_zoom_invitation_preview(p_slug text,p_token_hash text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('slug',t.slug,'email',i.email) from academy.training_invitations i join core.tenants t on t.id=i.tenant_id join zoom_core.settings cfg on cfg.tenant_id=t.id and cfg.enabled
 where t.slug=p_slug and t.status='active' and private_app.tenant_addon_enabled(t.id,'addon.integration.zoom') and i.token_hash=p_token_hash and p_token_hash~'^[a-f0-9]{64}$' and i.status='pending' and i.expires_at>now()
$$;
create function public.v1_zoom_invitation(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid;actor uuid;inv academy.training_invitations%rowtype;student academy.students%rowtype;email_value text;confirmed timestamptz;result jsonb;inv_id uuid;
begin
 if auth.uid() is null then raise exception 'zoom_forbidden';end if;
 select id into t from core.tenants where slug=p_slug and status='active';
 if t is null or not private_app.tenant_addon_enabled(t,'addon.integration.zoom') or not exists(select 1 from zoom_core.settings where tenant_id=t and enabled) then raise exception 'zoom_not_enabled';end if;
 if p_action='accept_invitation' then
  select * into inv from academy.training_invitations where tenant_id=t and token_hash=p_payload->>'tokenHash' for update;
  select lower(trim(email)),email_confirmed_at into email_value,confirmed from auth.users where id=auth.uid();
  select * into student from academy.students where tenant_id=t and id=inv.student_id and status in ('active','graduated');
  if inv.id is null or inv.status<>'pending' or inv.expires_at<=now() or confirmed is null or inv.email is distinct from email_value or lower(trim(student.email)) is distinct from email_value then raise exception 'zoom_invalid_invitation';end if;
  insert into access_control.subjects(auth_user_id,email,full_name,status,must_change_password) values(auth.uid(),email_value,student.full_name,'active',false) on conflict(auth_user_id) do nothing;
  actor:=private_app.current_subject_id();if actor is null or not exists(select 1 from access_control.subjects where id=actor and status='active' and not must_change_password) then raise exception 'zoom_forbidden';end if;
  result:=zoom_core.command(t,p_command_id,p_action,p_payload);if result is not null then return result;end if;
  insert into academy.training_learner_accounts(tenant_id,student_id,subject_id) values(t,student.id,actor);
  update academy.training_invitations set status='accepted',accepted_by_subject_id=actor,accepted_at=now(),activation_claim_id=null,activation_claim_expires_at=null where id=inv.id;
  result:=jsonb_build_object('studentId',student.id);
 elsif p_action='issue_invitation' then
  if not zoom_core.allowed(t,'sessions.manage') then raise exception 'zoom_forbidden';end if;
  result:=zoom_core.command(t,p_command_id,p_action,p_payload);if result is not null then return result;end if;
  select st.* into student from academy.students st join academy.enrollments en on en.tenant_id=st.tenant_id and en.student_id=st.id where en.tenant_id=t and en.id=(p_payload->>'enrollmentId')::uuid and en.status in ('confirmed','active','completed');
  if student.id is null or student.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p_payload->>'tokenHash' !~ '^[a-f0-9]{64}$' then raise exception 'zoom_invalid_invitation';end if;
  if exists(select 1 from academy.training_learner_accounts where tenant_id=t and student_id=student.id) then raise exception 'zoom_learner_already_linked';end if;
  update academy.training_invitations set status='revoked' where tenant_id=t and student_id=student.id and status='pending';
  insert into academy.training_invitations(tenant_id,student_id,email,token_hash,expires_at,invited_by_subject_id) values(t,student.id,lower(trim(student.email)),p_payload->>'tokenHash',now()+interval '7 days',private_app.current_subject_id()) returning id into inv_id;
  result:=jsonb_build_object('invitationId',inv_id);
 else raise exception 'zoom_invalid_action';end if;
 update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.'||p_action,'training_invitation',coalesce(inv.id,inv_id)::text,t,'{}');return result;
end $$;
revoke all on function public.v1_zoom_invitation_preview(text,text),public.v1_zoom_invitation(text,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_invitation_preview(text,text) to anon,authenticated;
grant execute on function public.v1_zoom_invitation(text,text,uuid,jsonb) to authenticated;
revoke all on all functions in schema zoom_core from public,anon,authenticated,service_role;
revoke all on function public.v1_zoom_portal(text,text),public.v1_zoom_batch(text,uuid,jsonb),public.v1_zoom_map_instance(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_portal(text,text),public.v1_zoom_batch(text,uuid,jsonb),public.v1_zoom_map_instance(text,uuid,jsonb) to authenticated;
commit;
