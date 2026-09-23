begin;
create table zoom_core.ai_drafts (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,recording_id uuid not null,source_revision integer not null,source_hash text not null,
 requested_by uuid not null references access_control.subjects(id),run_id uuid,kind text not null check(kind in ('summary','questions','unit')),
 state text not null default 'reserved' check(state in ('reserved','generating','draft','reviewed','applied','failed','source_removed')),
 content jsonb,model text,usage jsonb,created_at timestamptz not null default now(),reviewed_at timestamptz,applied_course_id uuid,
 foreign key(tenant_id,recording_id) references zoom_core.recordings(tenant_id,id),foreign key(tenant_id,run_id) references core.odeiry_runs(tenant_id,id),
 foreign key(tenant_id,applied_course_id) references academy.courses(tenant_id,id),unique(tenant_id,id),unique(run_id)
);
create function public.v1_zoom_transcript_authorize(p_slug text,p_recording_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);r zoom_core.recordings%rowtype;i zoom_core.instances%rowtype;l zoom_core.links%rowtype;
begin
 select * into r from zoom_core.recordings where tenant_id=t and id=p_recording_id and state not in ('deleted','source_missing');
 select * into i from zoom_core.instances where tenant_id=t and id=r.instance_id;select * into l from zoom_core.links where tenant_id=t and id=i.link_id;
 if r.id is null or not(zoom_core.allowed(t,'recordings.publish') or private_app.training_is_instructor_v1(t,(select course_run_id from academy.course_run_sessions where tenant_id=t and id=l.session_id))) then raise exception 'zoom_forbidden';end if;
 if not exists(select 1 from zoom_core.settings where tenant_id=t and retention_policy->>'approved'='true') then raise exception 'zoom_retention_approval_required';end if;
 return jsonb_build_object('recordingId',r.id,'fileId',r.provider_file_id,'uuid',i.uuid,'connectionId',i.connection_id,'sourceRevision',r.transcript_revision);
end $$;
create function public.v1_zoom_transcript_store(p_recording_id uuid,p_generation integer,p_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.recordings%rowtype;i zoom_core.instances%rowtype;
begin
 perform zoom_core.service_only();select * into r from zoom_core.recordings where id=p_recording_id for update;select * into i from zoom_core.instances where tenant_id=r.tenant_id and id=r.instance_id;
 if r.id is null or r.file_type not in ('TRANSCRIPT','CC') or r.state='deleted' or octet_length(p_text) not between 1 and 1048576 or not exists(select 1 from zoom_core.connections where tenant_id=r.tenant_id and id=i.connection_id and status in ('connected','paused') and generation=p_generation) then raise exception 'zoom_stale_operation';end if;
 update zoom_core.recordings set transcript=p_text,transcript_revision=case when transcript is distinct from p_text then transcript_revision+1 else transcript_revision end,updated_at=now() where id=r.id;
 return jsonb_build_object('status','stored');
end $$;
create function public.v1_zoom_ai_policy(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);result jsonb;
begin
 if not zoom_core.allowed(t,'retention.manage') or not zoom_core.allowed(t,'ai.generate') or p_payload->>'approved' is distinct from 'true' or length(trim(coalesce(p_payload->>'reason','')))<10 then raise exception 'zoom_ai_approval_required';end if;
 result:=zoom_core.command(t,p_command_id,'ai_policy',p_payload);if result is not null then return result;end if;
 update zoom_core.settings set ai_policy=jsonb_build_object('approved',true,'provider','odeiry_openai','approvedBy',private_app.current_subject_id(),'approvedAt',now(),'dataPurpose','reviewable_learning_drafts','noProviderStorage',true),revision=revision+1 where tenant_id=t;
 update zoom_core.commands set result='{"status":"approved"}' where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.ai_policy','zoom_settings',t::text,t,jsonb_build_object('reason',left(p_payload->>'reason',500)));return '{"status":"approved"}';
end $$;
create function public.v1_zoom_ai_prepare(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);ctx jsonb;r zoom_core.recordings%rowtype;result jsonb;draft_id uuid;
begin
 if not zoom_core.allowed(t,'ai.generate') or p_payload->>'consent' is distinct from 'true' or coalesce(p_payload->>'kind','') not in ('summary','questions','unit') then raise exception 'zoom_ai_approval_required';end if;
 ctx:=public.v1_zoom_transcript_authorize(p_slug,(p_payload->>'recordingId')::uuid);
 if not exists(select 1 from zoom_core.settings where tenant_id=t and ai_policy->>'approved'='true') then raise exception 'zoom_ai_approval_required';end if;
 select * into r from zoom_core.recordings where tenant_id=t and id=(ctx->>'recordingId')::uuid for update;
 if r.transcript is null or r.transcript_revision is distinct from (p_payload->>'sourceRevision')::int then raise exception 'zoom_source_revision_conflict';end if;
 result:=zoom_core.command(t,p_command_id,'ai_prepare',p_payload);if result is not null then return result;end if;
 insert into zoom_core.ai_drafts(tenant_id,recording_id,source_revision,source_hash,requested_by,kind) values(t,r.id,r.transcript_revision,encode(extensions.digest(r.transcript,'sha256'),'hex'),private_app.current_subject_id(),p_payload->>'kind') returning id into draft_id;
 result:=jsonb_build_object('draftId',draft_id,'sourceRevision',r.transcript_revision,'sourceHash',encode(extensions.digest(r.transcript,'sha256'),'hex'));
 update zoom_core.commands set result=jsonb_build_object('draftId',draft_id,'sourceRevision',r.transcript_revision,'sourceHash',encode(extensions.digest(r.transcript,'sha256'),'hex')) where tenant_id=t and id=p_command_id;
 return result;
end $$;
create function public.v1_zoom_ai_context(p_slug text,p_draft_id uuid,p_run_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);d zoom_core.ai_drafts%rowtype;r zoom_core.recordings%rowtype;
begin
 select * into d from zoom_core.ai_drafts where tenant_id=t and id=p_draft_id and requested_by=private_app.current_subject_id() for update;
 if d.id is null or d.state not in ('reserved','generating') or not zoom_core.allowed(t,'ai.generate') then raise exception 'zoom_forbidden';end if;
 perform public.v1_zoom_transcript_authorize(p_slug,d.recording_id);
 select * into r from zoom_core.recordings where tenant_id=t and id=d.recording_id;
 if r.transcript is null or r.transcript_revision<>d.source_revision then raise exception 'zoom_source_revision_conflict';end if;
 if not exists(select 1 from core.odeiry_runs where tenant_id=t and id=p_run_id and requested_by_subject_id=d.requested_by and status in ('reserved','running') and client_request_id='zoom:'||d.id) then raise exception 'zoom_ai_budget_required';end if;
 if d.run_id is not null and d.run_id<>p_run_id then raise exception 'zoom_revision_conflict';end if;
 update zoom_core.ai_drafts set run_id=p_run_id,state='generating' where id=d.id;
 return jsonb_build_object('draftId',d.id,'kind',d.kind,'transcript',r.transcript,'sourceRevision',d.source_revision,'sourceHash',d.source_hash);
end $$;
create function public.v1_zoom_ai_finish(p_slug text,p_draft_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);d zoom_core.ai_drafts%rowtype;run core.odeiry_runs%rowtype;content_value jsonb;
begin
 select * into d from zoom_core.ai_drafts where tenant_id=t and id=p_draft_id and requested_by=private_app.current_subject_id() for update;
 if d.id is null or not zoom_core.allowed(t,'ai.generate') then raise exception 'zoom_forbidden';end if;
 perform public.v1_zoom_transcript_authorize(p_slug,d.recording_id);
 if not exists(select 1 from zoom_core.recordings where tenant_id=t and id=d.recording_id and transcript_revision=d.source_revision and transcript is not null) then raise exception 'zoom_source_revision_conflict';end if;
 select * into run from core.odeiry_runs where tenant_id=t and id=d.run_id and requested_by_subject_id=d.requested_by and status='completed';
 if run.id is null then raise exception 'zoom_generation_not_complete';end if;
 content_value:=run.response_data;
 if content_value is null then raise exception 'zoom_generation_not_complete';end if;
 update zoom_core.ai_drafts set content=content_value,state='draft',model=run.actual_model,usage=jsonb_build_object('inputTokens',run.input_tokens,'outputTokens',run.output_tokens,'businessUnits',run.settled_business_units) where id=d.id;
 return jsonb_build_object('id',d.id,'state','draft','content',content_value,'sourceRevision',d.source_revision,'model',run.actual_model);
end $$;
-- The existing authoring RPC remains the only publisher. This action only appends
-- a reviewed text unit to its draft, preserving optimistic concurrency and LMS gate.
create function public.v1_zoom_ai_apply(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);d zoom_core.ai_drafts%rowtype;a academy.course_authoring%rowtype;document_value jsonb;result jsonb;course_key uuid;
begin
 if not zoom_core.allowed(t,'ai.generate') or p_payload->>'reviewed' is distinct from 'true' then raise exception 'zoom_forbidden';end if;
 select * into d from zoom_core.ai_drafts where tenant_id=t and id=(p_payload->>'draftId')::uuid and state in ('draft','reviewed') for update;
 select s.course_id into course_key from zoom_core.recordings r join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id join zoom_core.links l on l.tenant_id=i.tenant_id and l.id=i.link_id join academy.course_run_sessions cs on cs.tenant_id=l.tenant_id and cs.id=l.session_id join academy.course_runs s on s.tenant_id=cs.tenant_id and s.id=cs.course_run_id where r.tenant_id=t and r.id=d.recording_id;
 if d.id is null or course_key is distinct from (p_payload->>'courseId')::uuid then raise exception 'zoom_forbidden';end if;
 perform public.v1_zoom_transcript_authorize(p_slug,d.recording_id);
 select * into a from academy.course_authoring where tenant_id=t and course_id=course_key;
 if a.revision is distinct from (p_payload->>'expectedVersion')::int then raise exception 'zoom_revision_conflict';end if;
 document_value:=a.document;document_value:=jsonb_set(document_value,'{topics}',coalesce(document_value->'topics','[]')||jsonb_build_array(jsonb_build_object('id','zoom-'||d.id,'title',left(p_payload->>'title',180),'summary','مسودة تعليمية راجعها المحرر','units',jsonb_build_array(jsonb_build_object('id','zoom-unit-'||d.id,'title',left(p_payload->>'title',180),'kind','text','required',false,'minimumSeconds',0,'body',p_payload->>'body')))));
 result:=public.v1_academy_authoring_action(p_slug,'save_course',p_command_id,jsonb_build_object('courseId',course_key,'expectedRevision',a.revision,'document',document_value));
 update zoom_core.ai_drafts set state='applied',reviewed_at=now(),applied_course_id=course_key where id=d.id;
 perform private_app.write_audit('zoom.ai_apply','zoom_ai_draft',d.id::text,t,jsonb_build_object('courseId',course_key));return result;
end $$;
create function public.v1_zoom_sdk_context(p_grant_id uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;g zoom_core.access_grants%rowtype;l zoom_core.links%rowtype;person access_control.subjects%rowtype;email_value text;
begin
 perform zoom_core.service_only();g:=zoom_core.check_grant(p_grant_id);ctx:='{}';
 select * into l from zoom_core.links where tenant_id=g.tenant_id and id=g.link_id;select * into person from access_control.subjects where id=g.subject_id;
 select lower(email) into email_value from auth.users where id=g.auth_user_id and email_confirmed_at is not null;
 if email_value is null then raise exception 'zoom_verified_email_required';end if;
 return ctx||jsonb_build_object('connectionId',l.connection_id,'providerUserId',(select provider_user_id from zoom_core.host_instructors where tenant_id=g.tenant_id and host_id=l.host_id and subject_id=g.subject_id and active),'accountId',(select account_id from zoom_core.connections where tenant_id=g.tenant_id and id=l.connection_id),'email',email_value,'name',person.full_name,'meetingId',l.meeting_id,'kind',l.kind,'role',case g.action when 'start' then 1 else 0 end);
end $$;
alter table zoom_core.ai_drafts enable row level security;
revoke all on zoom_core.ai_drafts from public,anon,authenticated,service_role;
do $$declare r record;begin
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_transcript_authorize','v1_zoom_transcript_store','v1_zoom_ai_policy','v1_zoom_ai_prepare','v1_zoom_ai_context','v1_zoom_ai_finish','v1_zoom_ai_apply','v1_zoom_sdk_context') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);execute format('grant execute on function %s to %I',r.sig,case when r.proname in ('v1_zoom_transcript_store','v1_zoom_sdk_context') then 'service_role' else 'authenticated' end);
 end loop;
end $$;
commit;
