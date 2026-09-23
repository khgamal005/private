begin;
create table zoom_core.replaced_meetings (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,link_id uuid not null,connection_id uuid not null,host_id uuid not null,
 meeting_id text not null,occurrence_id text not null default '',kind text not null,previous_revision integer not null,new_revision integer not null,
 state text not null default 'awaiting_replacement' check(state in ('awaiting_replacement','pending_cancel','processing','cancelled','blocked')),secret_id uuid,registration_secrets uuid[] not null default '{}',
 lease_id uuid,lease_until timestamptz,fence int not null default 0,reason text not null,created_by uuid not null references access_control.subjects(id),created_at timestamptz not null default now(),last_error text,
 foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),foreign key(tenant_id,host_id) references zoom_core.hosts(tenant_id,id),unique(tenant_id,link_id,previous_revision)
);
create function public.v1_zoom_replace(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);l zoom_core.links%rowtype;s academy.course_run_sessions%rowtype;candidate record;result jsonb;secrets uuid[];newrev int;
begin
 if not zoom_core.allowed(t,'sessions.manage') or p_payload->>'impactApproved' is distinct from 'true' or length(trim(coalesce(p_payload->>'reason','')))<8 then raise exception 'zoom_replacement_approval_required';end if;
 result:=zoom_core.command(t,p_command_id,'replace',p_payload);if result is not null then return result;end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':zoom-schedule',0));
 select * into l from zoom_core.links where tenant_id=t and id=(p_payload->>'linkId')::uuid for update;select * into s from academy.course_run_sessions where tenant_id=t and id=l.session_id for update;
 if l.id is null or l.revision is distinct from (p_payload->>'expectedVersion')::int or l.state not in ('ready','imported','drift','failed') or l.management<>'managed' or l.meeting_id is null or s.starts_at<=now() or exists(select 1 from zoom_core.instances where tenant_id=t and link_id=l.id and started_at is not null) then raise exception 'zoom_replacement_requires_unstarted_session';end if;
 if exists(select 1 from zoom_core.replaced_meetings where tenant_id=t and link_id=l.id and state<>'cancelled') then raise exception 'zoom_operation_in_progress';end if;
 select * into candidate from zoom_core.candidates(t,s.id,l.instructor_subject_id,s.starts_at,s.ends_at,coalesce((l.desired->>'attendees')::int,1),l.kind,l.desired,l.id) where host_id=(p_payload->>'hostId')::uuid and connection_id<>l.connection_id limit 1;
 if candidate.host_id is null then raise exception 'zoom_schedule_conflict';end if;
 select coalesce(array_agg(secret_id) filter(where secret_id is not null),'{}') into secrets from zoom_core.registrations where tenant_id=t and link_id=l.id;
 newrev:=l.revision+1;
 insert into zoom_core.replaced_meetings(tenant_id,link_id,connection_id,host_id,meeting_id,occurrence_id,kind,previous_revision,new_revision,secret_id,registration_secrets,reason,created_by)
 values(t,l.id,l.connection_id,l.host_id,l.meeting_id,l.occurrence_id,l.kind,l.revision,newrev,l.secret_id,secrets,left(p_payload->>'reason',500),private_app.current_subject_id());
 update zoom_core.registrations set registrant_id=null,verified_email=null,verified_zoom_user_id=null,secret_id=null,state='new',lease=null,lease_until=null where tenant_id=t and link_id=l.id;
 delete from zoom_core.access_grants where tenant_id=t and link_id=l.id;
 update zoom_core.links set connection_id=candidate.connection_id,host_id=candidate.host_id,meeting_id=null,occurrence_id='',secret_id=null,revision=newrev,state='queued',reason='account_replacement',desired=desired||jsonb_build_object('replacementPending',true,'startsAt',s.starts_at,'endsAt',s.ends_at) where id=l.id;
 insert into zoom_core.reservations(tenant_id,link_id,host_id,instructor_subject_id,slot,occupied_range,revision) values(t,l.id,candidate.host_id,l.instructor_subject_id,candidate.slot,candidate.occupied_range,newrev);
 insert into zoom_core.operations(tenant_id,connection_id,link_id,revision,kind,command_id) values(t,candidate.connection_id,l.id,newrev,'create',p_command_id);
 update academy.training_automation_jobs set status='cancelled',last_error='zoom_replacement_pending' where tenant_id=t and session_id=l.session_id and status in ('pending','failed','waiting_configuration');
 result:=jsonb_build_object('id',l.id,'state','queued','revision',newrev,'impact','old_reference_retained_until_provider_cancellation');update zoom_core.commands set result=jsonb_build_object('id',l.id,'state','queued','revision',newrev,'impact','old_reference_retained_until_provider_cancellation') where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.replace','zoom_link',l.id::text,t,jsonb_build_object('reason',left(p_payload->>'reason',500),'newRevision',newrev));return result;
end $$;
create function public.v1_zoom_replaced_claim(p_lease_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.replaced_meetings%rowtype;
begin
 perform zoom_core.service_only();
 update zoom_core.replaced_meetings old_meeting set state='pending_cancel' where state='awaiting_replacement' and exists(select 1 from zoom_core.links l where l.tenant_id=old_meeting.tenant_id and l.id=old_meeting.link_id and l.revision=old_meeting.new_revision and l.state in ('ready','live','ended') and l.meeting_id is not null);
 select history.* into r from zoom_core.replaced_meetings history join zoom_core.connections c on c.tenant_id=history.tenant_id and c.id=history.connection_id and c.status in ('connected','paused') where history.state='pending_cancel' or (history.state='processing' and history.lease_until<=now()) order by history.created_at limit 1 for update of history skip locked;
 if r.id is null then return null;end if;
 update zoom_core.replaced_meetings set state='processing',lease_id=p_lease_id,lease_until=now()+interval '60 seconds',fence=fence+1 where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'connectionId',r.connection_id,'meetingId',r.meeting_id,'occurrenceId',r.occurrence_id,'kind',r.kind,'fence',r.fence);
end $$;
create function public.v1_zoom_replaced_complete(p_id uuid,p_lease_id uuid,p_fence int,p_generation int,p_cancelled boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.replaced_meetings%rowtype;
begin
 perform zoom_core.service_only();select * into r from zoom_core.replaced_meetings where id=p_id for update;
 if r.id is null or r.lease_id is distinct from p_lease_id or r.fence<>p_fence or r.lease_until<=now() or not exists(select 1 from zoom_core.connections where tenant_id=r.tenant_id and id=r.connection_id and generation=p_generation and status in ('connected','paused')) then raise exception 'zoom_stale_lease';end if;
 if p_cancelled then
  delete from vault.secrets where id=r.secret_id or id=any(r.registration_secrets);
  update zoom_core.reservations set state='released' where tenant_id=r.tenant_id and link_id=r.link_id and revision<=r.previous_revision;
  update zoom_core.links set desired=desired-'replacementPending' where tenant_id=r.tenant_id and id=r.link_id;
  update zoom_core.replaced_meetings set state='cancelled',lease_id=null,lease_until=null,secret_id=null,registration_secrets='{}' where id=r.id;
 else update zoom_core.replaced_meetings set state='blocked',last_error='zoom_old_meeting_review_required',lease_id=null,lease_until=null where id=r.id;end if;
 perform private_app.write_audit('zoom.replacement_old_meeting','zoom_link',r.link_id::text,r.tenant_id,jsonb_build_object('cancelled',p_cancelled));return jsonb_build_object('cancelled',p_cancelled);
end $$;
create function public.v1_zoom_replacement_snapshot(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug,false);
begin
 if not zoom_core.allowed(t,'sessions.manage') then return '[]';end if;
 return coalesce((select jsonb_agg(to_jsonb(x)) from(select h.id,h.link_id,h.state,h.reason,h.last_error,s.title from zoom_core.replaced_meetings h join zoom_core.links l on l.tenant_id=h.tenant_id and l.id=h.link_id join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id where h.tenant_id=t and h.state<>'cancelled' order by h.created_at limit 50)x),'[]');
end $$;
create function public.v1_zoom_replacement_retry(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);result jsonb;
begin
 if not zoom_core.allowed(t,'sessions.manage') or length(trim(coalesce(p_payload->>'reason','')))<8 then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,'replacement_retry',p_payload);if result is not null then return result;end if;
 update zoom_core.replaced_meetings set state='pending_cancel',last_error=null where tenant_id=t and id=(p_payload->>'replacementId')::uuid and state='blocked';
 if not found then raise exception 'zoom_not_found';end if;
 perform private_app.write_audit('zoom.replacement_retry','zoom_replacement',p_payload->>'replacementId',t,jsonb_build_object('reason',left(p_payload->>'reason',500)));
 update zoom_core.commands set result='{"state":"queued"}' where tenant_id=t and id=p_command_id;return '{"state":"queued"}';
end $$;
alter function public.v1_zoom_purge(integer) rename to v1_zoom_purge_advanced;
create function public.v1_zoom_purge(p_limit integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.replaced_meetings%rowtype;
begin
 perform zoom_core.service_only();
 for r in select h.* from zoom_core.replaced_meetings h join zoom_core.purge_requests p on p.tenant_id=h.tenant_id and p.connection_id=h.connection_id where h.meeting_id not like 'purged:%' limit 100 for update of h skip locked loop
  delete from vault.secrets where id=r.secret_id or id=any(r.registration_secrets);
  update zoom_core.replaced_meetings set meeting_id='purged:'||id,occurrence_id='',secret_id=null,registration_secrets='{}',state='blocked',last_error='zoom_deauthorized',lease_id=null,lease_until=null where id=r.id;
 end loop;return public.v1_zoom_purge_advanced(p_limit);
end $$;
revoke all on function public.v1_zoom_purge_advanced(integer),public.v1_zoom_purge(integer),public.v1_zoom_replacement_snapshot(text),public.v1_zoom_replacement_retry(text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_purge(integer) to service_role;
grant execute on function public.v1_zoom_replacement_snapshot(text),public.v1_zoom_replacement_retry(text,uuid,jsonb) to authenticated;

alter table zoom_core.replaced_meetings enable row level security;
revoke all on zoom_core.replaced_meetings from public,anon,authenticated,service_role;
revoke all on function public.v1_zoom_replace(text,uuid,jsonb),public.v1_zoom_replaced_claim(uuid),public.v1_zoom_replaced_complete(uuid,uuid,int,int,boolean) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_replace(text,uuid,jsonb) to authenticated;
grant execute on function public.v1_zoom_replaced_claim(uuid),public.v1_zoom_replaced_complete(uuid,uuid,int,int,boolean) to service_role;
commit;
