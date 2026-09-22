begin;
-- Transactional webinar delivery reuses the tenant's existing message queue.
-- It carries no academic enrollment and never falls back to platform channels.
do $$declare r record;expression text;begin
 for r in select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='academy.training_automation_jobs'::regclass and contype='c' and pg_get_constraintdef(oid) like '%job_type%' loop
  expression:=substring(r.definition from '^CHECK \((.*)\)$');if expression is null then raise exception 'zoom_queue_constraint_unrecognized';end if;
  execute format('alter table academy.training_automation_jobs drop constraint %I',r.conname);
  execute format('alter table academy.training_automation_jobs add constraint %I check ((%s) or (job_type=''zoom_webinar_joining'' and channel in (''whatsapp'',''email'') and enrollment_id is null and session_id is not null and recipient is not null and metadata->>''webinarRegistrationId'' is not null))',r.conname,expression);
 end loop;
end $$;
create function public.v1_zoom_webinar_notify(p_slug text,p_command_id uuid,p_registration_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);r zoom_core.webinar_registrations%rowtype;l zoom_core.links%rowtype;c sales_core.contacts%rowtype;cfg academy.training_automation_settings%rowtype;channel_key text;recipient_value text;job uuid;result jsonb;
begin
 if not zoom_core.allowed(t,'webinars.manage') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,'webinar_notify',jsonb_build_object('registrationId',p_registration_id));if result is not null then return result;end if;
 select * into r from zoom_core.webinar_registrations where tenant_id=t and id=p_registration_id and state='registered' and registration_consent;
 select * into l from zoom_core.links where tenant_id=t and id=r.link_id and state in ('ready','live','imported');if l.id is null then raise exception 'zoom_not_found';end if;
 c:=private_app.sales_followup_contact(p_slug,r.contact_id,true);select * into cfg from academy.training_automation_settings where tenant_id=t;
 if cfg.id is null or not cfg.joining_enabled then raise exception 'zoom_message_configuration_required';end if;
 channel_key:=cfg.primary_channel;recipient_value:=case channel_key when 'email' then lower(c.email) else private_app.normalize_training_phone(coalesce(c.whatsapp,c.phone),cfg.whatsapp_country_code) end;
 if nullif(recipient_value,'') is null and cfg.email_fallback_enabled then channel_key:='email';recipient_value:=lower(c.email);end if;
 if nullif(recipient_value,'') is null then raise exception 'zoom_verified_email_required';end if;
 insert into academy.training_automation_jobs(tenant_id,course_run_id,session_id,dedupe_key,job_type,channel,recipient,subject,message_text,max_attempts,created_by_subject_id,metadata)
 select t,s.course_run_id,s.id,'zoom:webinar:'||r.id||':joining:'||l.revision,'zoom_webinar_joining',channel_key,recipient_value,'بيانات الانضمام للندوة','تُجهز بيانات الانضمام الفردية عند الإرسال.',1,private_app.current_subject_id(),jsonb_build_object('webinarRegistrationId',r.id,'zoomRevision',l.revision,'actorUserId',auth.uid(),'actorSubjectId',private_app.current_subject_id()) from academy.course_run_sessions s where s.tenant_id=t and s.id=l.session_id
 on conflict(tenant_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key returning id into job;
 result:=jsonb_build_object('jobId',job,'state','queued','channel',channel_key);update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.webinar.notify','zoom_webinar_registration',r.id::text,t,jsonb_build_object('jobId',job,'channel',channel_key));return result;
end $$;
alter function public.v1_zoom_message_check(uuid) rename to v1_zoom_message_check_before_webinars;
create function public.v1_zoom_message_check(p_job_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j academy.training_automation_jobs%rowtype;r zoom_core.webinar_registrations%rowtype;l zoom_core.links%rowtype;c sales_core.contacts%rowtype;s academy.course_run_sessions%rowtype;cfg academy.training_automation_settings%rowtype;ten core.tenants%rowtype;url_value text;recipient_value text;when_value text;previous_sub text:=current_setting('request.jwt.claim.sub',true);previous_claims text:=current_setting('request.jwt.claims',true);
begin
 perform zoom_core.service_only();select * into j from academy.training_automation_jobs where id=p_job_id;
 if j.job_type is distinct from 'zoom_webinar_joining' then return public.v1_zoom_message_check_before_webinars(p_job_id);end if;
 select * into r from zoom_core.webinar_registrations where tenant_id=j.tenant_id and id=(j.metadata->>'webinarRegistrationId')::uuid;
 select * into l from zoom_core.links where tenant_id=j.tenant_id and id=r.link_id;select * into s from academy.course_run_sessions where tenant_id=j.tenant_id and id=l.session_id;select * into ten from core.tenants where id=j.tenant_id;
 if j.status<>'processing' or r.id is null or r.state<>'registered' or not r.registration_consent or l.state not in ('ready','live','imported') or s.status='cancelled' or now()>s.ends_at+interval '15 minutes' or j.session_id<>s.id or j.metadata->>'zoomRevision' is distinct from l.revision::text or not exists(select 1 from zoom_core.settings where tenant_id=j.tenant_id and enabled) or not private_app.tenant_addon_enabled(j.tenant_id,'addon.integration.zoom') or not exists(select 1 from zoom_core.connections where tenant_id=j.tenant_id and id=l.connection_id and status in ('connected','paused')) then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_message_not_eligible');end if;
 perform zoom_core.assert_actor(j.tenant_id,(j.metadata->>'actorUserId')::uuid,(j.metadata->>'actorSubjectId')::uuid,'webinars.manage');
 perform set_config('request.jwt.claim.sub',j.metadata->>'actorUserId',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',j.metadata->>'actorUserId','role','authenticated')::text,true);
 c:=private_app.sales_followup_contact(ten.slug,r.contact_id,true);
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
 select * into cfg from academy.training_automation_settings where tenant_id=j.tenant_id;
 recipient_value:=case j.channel when 'email' then lower(c.email) else private_app.normalize_training_phone(coalesce(c.whatsapp,c.phone),cfg.whatsapp_country_code) end;
 if not coalesce(cfg.joining_enabled,false) or j.recipient is distinct from recipient_value then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_recipient_changed');end if;
 select decrypted_secret::jsonb->>'join_url' into url_value from vault.decrypted_secrets where id=r.secret_id;if url_value is null then return jsonb_build_object('managed',true,'allowed',false,'reason','zoom_registration_pending');end if;
 when_value:=to_char(s.starts_at at time zone ten.timezone,'YYYY-MM-DD HH24:MI')||' ('||ten.timezone||')';
 return jsonb_build_object('managed',true,'allowed',true,'job',jsonb_build_object('type',j.job_type,'subject','بيانات الانضمام للندوة','messageText',s.title||E'\n'||when_value||E'\n'||url_value,'metadata',jsonb_build_object('studentName',c.full_name,'sessionTitle',s.title,'startDate',when_value,'venueOrLink',url_value)));
end $$;

-- An issued certificate is never silently revoked by later provider evidence.
-- The existing task workflow gives the authorized owner a reviewable exception.
create function zoom_core.certificate_review_task() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.metadata->'zoom' is not distinct from new.metadata->'zoom' and old.status is not distinct from new.status then return new;end if;
 if not (old.metadata?'zoom' or new.metadata?'zoom') then return new;end if;
 insert into work_core.tasks(tenant_id,task_key,title,description,priority,assigned_staff_id,due_at,metadata)
 select new.tenant_id,'zoom:certificate-review:'||c.id,'مراجعة شهادة بعد تغير دليل الحضور','تغير دليل حضور معتمد بعد إصدار الشهادة. راجع الأهلية والسياسة؛ لم تُسحب الشهادة تلقائيًا.','high',cfg.owner_staff_id,now()+interval '1 day',jsonb_build_object('source','zoom_certificate_review','certificateId',c.id,'enrollmentId',new.enrollment_id)
 from academy.certificates c join zoom_core.settings cfg on cfg.tenant_id=c.tenant_id join people.staff_profiles staff on staff.tenant_id=cfg.tenant_id and staff.id=cfg.owner_staff_id and staff.employment_status='active'
 where c.tenant_id=new.tenant_id and c.enrollment_id=new.enrollment_id and c.status='issued'
 on conflict(tenant_id,task_key) do update set status='todo',completed_at=null,updated_at=now();return new;
end $$;
create trigger zoom_certificate_review_task after update of metadata,status on academy.attendance_records for each row execute function zoom_core.certificate_review_task();
revoke all on function public.v1_zoom_webinar_notify(text,uuid,uuid),public.v1_zoom_message_check(uuid),public.v1_zoom_message_check_before_webinars(uuid),zoom_core.certificate_review_task() from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_webinar_notify(text,uuid,uuid) to authenticated;
grant execute on function public.v1_zoom_message_check(uuid) to service_role;
commit;
