begin;
create table zoom_core.purge_requests (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,connection_id uuid not null,reason text not null,
 state text not null default 'pending' check(state in ('pending','provider_data_removed','policy_required','complete')),created_at timestamptz not null default now(),completed_at timestamptz,
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),unique(connection_id,reason)
);
create function zoom_core.request_deauthorization_purge() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='deauthorized' and old.status<>'deauthorized' then
  insert into zoom_core.purge_requests(tenant_id,connection_id,reason) values(new.tenant_id,new.id,'deauthorization') on conflict do nothing;
 end if;return new;
end $$;
create trigger zoom_deauthorization_purge after update of status on zoom_core.connections for each row execute function zoom_core.request_deauthorization_purge();
create function public.v1_zoom_recovery_begin(p_slug text,p_session_id uuid,p_revision integer,p_lease_id uuid,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);l zoom_core.links%rowtype;o zoom_core.operations%rowtype;
begin
 if not zoom_core.allowed(t,'sessions.manage') or length(trim(coalesce(p_reason,'')))<5 then raise exception 'zoom_forbidden';end if;
 select * into l from zoom_core.links where tenant_id=t and session_id=p_session_id for update;
 if l.id is null or l.revision<>p_revision or l.state not in ('uncertain','failed') then raise exception 'zoom_revision_conflict';end if;
 select * into o from zoom_core.operations where tenant_id=t and link_id=l.id and revision=l.revision and kind in ('create','update','cancel','import') and state in ('uncertain','blocked','dead') order by created_at desc limit 1 for update;
 if o.id is null then raise exception 'zoom_operation_in_progress';end if;
 update zoom_core.operations set state='processing',lease_id=p_lease_id,lease_until=now()+interval '90 seconds',fence=fence+1 where id=o.id returning * into o;
 perform private_app.write_audit('zoom.recovery','zoom_operation',o.id::text,t,jsonb_build_object('reason',left(p_reason,500)));
 return jsonb_build_object('operationId',o.id,'fence',o.fence);
end $$;
create function public.v1_zoom_sweep(p_limit integer default 50) returns jsonb language plpgsql security definer set search_path='' as $$
declare l zoom_core.links%rowtype;total int:=0;
begin
 perform zoom_core.service_only();if p_limit not between 1 and 100 then raise exception 'zoom_invalid_request';end if;
 delete from zoom_core.access_grants where expires_at<now()-interval '1 hour';
 delete from zoom_core.oauth_attempts where expires_at<now()-interval '1 day';
 -- A missing webhook is a reason to query the provider, never proof of absence.
 for l in select x.* from zoom_core.links x join zoom_core.settings cfg on cfg.tenant_id=x.tenant_id and cfg.enabled join zoom_core.connections c on c.tenant_id=x.tenant_id and c.id=x.connection_id and c.status='connected'
 where x.meeting_id is not null and x.state in ('ready','imported','live','ended') and (x.desired->>'endsAt')::timestamptz<now()-interval '5 minutes' and (x.desired->>'endsAt')::timestamptz>now()-interval '30 days'
 and private_app.tenant_addon_enabled(x.tenant_id,'addon.integration.zoom') and not exists(select 1 from zoom_core.operations o where o.tenant_id=x.tenant_id and o.link_id=x.id and o.kind='reconcile' and (o.state in ('pending','retry','processing') or o.created_at>now()-interval '6 hours'))
 and not exists(select 1 from zoom_core.instances i where i.tenant_id=x.tenant_id and i.link_id=x.id and i.evidence_state='complete') order by x.last_synced_at nulls first,x.id limit p_limit for update of x skip locked loop
  insert into zoom_core.operations(tenant_id,connection_id,link_id,revision,kind,command_id) values(l.tenant_id,l.connection_id,l.id,l.revision,'reconcile',gen_random_uuid());total:=total+1;
 end loop;
 update zoom_core.recordings set state='withdrawn',updated_at=now() where state='published' and expires_at<=now();
 -- Preserve explicit waiting/uncertain states; do not silently retry registration.
 update zoom_core.registrations set state='uncertain' where state='registering' and lease_until<=now();
 return jsonb_build_object('reconciliationsQueued',total);
end $$;
create function public.v1_zoom_purge(p_limit integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare req zoom_core.purge_requests%rowtype;cfg zoom_core.settings%rowtype;count_value int:=0;raw_count int;attendance_count int;
begin
 perform zoom_core.service_only();if p_limit not between 1 and 50 then raise exception 'zoom_invalid_request';end if;
 for req in select * from zoom_core.purge_requests where state<>'complete' order by created_at limit p_limit for update skip locked loop
  select * into cfg from zoom_core.settings where tenant_id=req.tenant_id;
  delete from vault.secrets where id in (
   select vault_secret_id from zoom_core.connections where tenant_id=req.tenant_id and id=req.connection_id union all
   select secret_id from zoom_core.links where tenant_id=req.tenant_id and connection_id=req.connection_id union all
   select r.secret_id from zoom_core.registrations r join zoom_core.links l on l.tenant_id=r.tenant_id and l.id=r.link_id where l.tenant_id=req.tenant_id and l.connection_id=req.connection_id union all
   select r.secret_id from zoom_core.recordings r join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id where i.tenant_id=req.tenant_id and i.connection_id=req.connection_id
  );
  update zoom_core.connections set vault_secret_id=null,scopes='[]',label='اتصال أُلغي تفويضه',last_error='zoom_deauthorized' where tenant_id=req.tenant_id and id=req.connection_id;
  update zoom_core.operations set state='blocked',payload='{}',result=null,last_error='zoom_deauthorized',lease_id=null,lease_until=null where tenant_id=req.tenant_id and connection_id=req.connection_id and state<>'cancelled';
  delete from zoom_core.access_grants where tenant_id=req.tenant_id and link_id in(select id from zoom_core.links where tenant_id=req.tenant_id and connection_id=req.connection_id);
  update zoom_core.registrations set registrant_id=null,verified_email=null,verified_zoom_user_id=null,secret_id=null,state='revoked',lease=null,lease_until=null where tenant_id=req.tenant_id and link_id in(select id from zoom_core.links where tenant_id=req.tenant_id and connection_id=req.connection_id);
  delete from zoom_core.intervals where tenant_id=req.tenant_id and instance_id in(select id from zoom_core.instances where tenant_id=req.tenant_id and connection_id=req.connection_id);get diagnostics raw_count=row_count;
  delete from zoom_core.recording_opens where tenant_id=req.tenant_id and recording_id in(select r.id from zoom_core.recordings r join zoom_core.instances i on i.tenant_id=r.tenant_id and i.id=r.instance_id where i.tenant_id=req.tenant_id and i.connection_id=req.connection_id);
  update zoom_core.recordings set state='deleted',secret_id=null,transcript=null,size_bytes=0,provider_file_id='purged:'||id,recording_type=null,updated_at=now() where tenant_id=req.tenant_id and instance_id in(select id from zoom_core.instances where tenant_id=req.tenant_id and connection_id=req.connection_id);
  update zoom_core.instances set uuid='purged:'||id,started_at=null,ended_at=null,evidence_state='incomplete' where tenant_id=req.tenant_id and connection_id=req.connection_id;
  delete from zoom_core.events where tenant_id=req.tenant_id and connection_id=req.connection_id;
  delete from zoom_core.busy_windows where tenant_id=req.tenant_id and host_id in(select id from zoom_core.hosts where tenant_id=req.tenant_id and connection_id=req.connection_id) and source='provider';
  update zoom_core.host_instructors set provider_user_id='purged',provider_email=null,active=false where tenant_id=req.tenant_id and host_id in(select id from zoom_core.hosts where tenant_id=req.tenant_id and connection_id=req.connection_id);
  update zoom_core.hosts set name='مضيف مفصول',user_id='purged:'||id,allowed=false,provider_active=false,capabilities='{}',verification_source=null where tenant_id=req.tenant_id and connection_id=req.connection_id;
  update zoom_core.links set meeting_id=null,occurrence_id='',secret_id=null,observed='{}',state='failed',reason='zoom_data_purged' where tenant_id=req.tenant_id and connection_id=req.connection_id;
  -- Source-derived academic fields need an explicit approved retention decision.
  -- Independent payments/enrollments/certificates and human decisions are preserved.
  attendance_count:=0;
  if cfg.retention_policy->>'derivedAttendance'='delete_auto_preserve_human' then
   delete from academy.attendance_records a where a.tenant_id=req.tenant_id and a.metadata?'zoom' and coalesce(a.metadata->'zoom'->>'override','false')<>'true' and a.session_id in(select session_id from zoom_core.links where tenant_id=req.tenant_id and connection_id=req.connection_id);get diagnostics attendance_count=row_count;
   update academy.attendance_records a set metadata=(metadata-'zoom')||jsonb_build_object('zoomEvidenceRemoved',true) where a.tenant_id=req.tenant_id and a.metadata->'zoom'->>'override'='true' and a.session_id in(select session_id from zoom_core.links where tenant_id=req.tenant_id and connection_id=req.connection_id);
   update zoom_core.purge_requests set state='complete',completed_at=now() where id=req.id;
  else update zoom_core.purge_requests set state='policy_required' where id=req.id;end if;
  insert into zoom_core.retention_runs(tenant_id,connection_id,status,counts) values(req.tenant_id,req.connection_id,case when cfg.retention_policy->>'derivedAttendance'='delete_auto_preserve_human' then 'local_complete_backup_policy_pending' else 'derived_policy_required' end,jsonb_build_object('intervals',raw_count,'derivedAttendance',attendance_count));
  count_value:=count_value+1;
 end loop;return jsonb_build_object('processed',count_value,'backupDeletion','requires_storage_policy');
end $$;
create function public.v1_zoom_retention_policy(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);result jsonb;
begin
 if not zoom_core.allowed(t,'retention.manage') or p_payload->>'derivedAttendance' is distinct from 'delete_auto_preserve_human' or length(trim(coalesce(p_payload->>'reason','')))<10 or p_payload->>'approved' is distinct from 'true' then raise exception 'zoom_retention_approval_required';end if;
 result:=zoom_core.command(t,p_command_id,'retention_policy',p_payload);if result is not null then return result;end if;
 update zoom_core.settings set retention_policy=retention_policy||jsonb_build_object('derivedAttendance',p_payload->>'derivedAttendance','derivedApprovedBy',private_app.current_subject_id(),'derivedApprovedAt',now()),revision=revision+1 where tenant_id=t;
 perform private_app.write_audit('zoom.retention_policy','zoom_settings',t::text,t,jsonb_build_object('reason',left(p_payload->>'reason',500)));
 update zoom_core.commands set result='{"status":"approved"}' where tenant_id=t and id=p_command_id;return '{"status":"approved"}';
end $$;
alter table zoom_core.purge_requests enable row level security;
revoke all on zoom_core.purge_requests from public,anon,authenticated,service_role;
revoke all on all functions in schema zoom_core from public,anon,authenticated,service_role;
do $$declare r record;begin
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_recovery_begin','v1_zoom_sweep','v1_zoom_purge','v1_zoom_retention_policy') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);execute format('grant execute on function %s to %I',r.sig,case when r.proname in ('v1_zoom_sweep','v1_zoom_purge') then 'service_role' else 'authenticated' end);
 end loop;
end $$;
commit;
