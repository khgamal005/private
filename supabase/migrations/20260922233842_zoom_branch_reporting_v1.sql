begin;
alter table zoom_core.hosts add column branch_id uuid;
alter table zoom_core.hosts add foreign key(tenant_id,branch_id) references core.branches(tenant_id,id);
create index zoom_host_branch on zoom_core.hosts(tenant_id,branch_id);
alter function zoom_core.candidates(uuid,uuid,uuid,timestamptz,timestamptz,integer,text,jsonb,uuid) rename to candidates_before_branches;
create function zoom_core.candidates(t uuid,sid uuid,teacher uuid,starts timestamptz,ends timestamptz,attendees integer,kind_key text,requirements jsonb,exclude_link uuid default null) returns table(host_id uuid,connection_id uuid,slot integer,occupied_range tstzrange,reason text) language sql stable security definer set search_path='' as $$
 select candidate.host_id,candidate.connection_id,candidate.slot,candidate.occupied_range,candidate.reason from zoom_core.candidates_before_branches(t,sid,teacher,starts,ends,attendees,kind_key,requirements,exclude_link) with ordinality candidate
 join zoom_core.hosts host on host.tenant_id=t and host.id=candidate.host_id
 join academy.course_run_sessions session on session.tenant_id=t and session.id=sid join academy.course_runs run on run.tenant_id=t and run.id=session.course_run_id
 where host.branch_id is null or (host.branch_id=run.branch_id and exists(select 1 from core.branches b where b.tenant_id=t and b.id=host.branch_id and b.active))
 order by candidate.ordinality
$$;
alter function public.v1_zoom_action(text,text,uuid,jsonb) rename to v1_zoom_action_before_branch;
create function public.v1_zoom_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid;result jsonb;replay boolean;
begin
 if p_action<>'configure_host' or not p_payload?'branchId' then return public.v1_zoom_action_before_branch(p_slug,p_action,p_command_id,p_payload);end if;
 t:=zoom_core.tenant(p_slug);if not zoom_core.allowed(t,'hosts.manage') then raise exception 'zoom_forbidden';end if;
 if nullif(p_payload->>'branchId','') is not null and not exists(select 1 from core.branches where tenant_id=t and id=(p_payload->>'branchId')::uuid and active) then raise exception 'zoom_invalid_branch';end if;
 replay:=exists(select 1 from zoom_core.commands cmd where cmd.tenant_id=t and cmd.id=p_command_id and cmd.result is not null);
 result:=public.v1_zoom_action_before_branch(p_slug,p_action,p_command_id,p_payload);
 if not replay then update zoom_core.hosts set branch_id=nullif(p_payload->>'branchId','')::uuid where tenant_id=t and id=(p_payload->>'hostId')::uuid;end if;
 return result;
end $$;
alter function public.v1_zoom_operation_context(uuid,uuid,integer) rename to v1_zoom_operation_context_before_branch;
create function public.v1_zoom_operation_context(p_operation_id uuid,p_lease_id uuid,p_fence integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 result:=public.v1_zoom_operation_context_before_branch(p_operation_id,p_lease_id,p_fence);
 if result->'operation'->>'kind' in ('create','update','import') and exists(select 1 from zoom_core.links l join zoom_core.hosts h on h.tenant_id=l.tenant_id and h.id=l.host_id join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id join academy.course_runs r on r.tenant_id=s.tenant_id and r.id=s.course_run_id where l.id=(result->'link'->>'id')::uuid and h.branch_id is not null and (h.branch_id is distinct from r.branch_id or not exists(select 1 from core.branches b where b.tenant_id=h.tenant_id and b.id=h.branch_id and b.active))) then raise exception 'zoom_invalid_branch';end if;
 return result;
end $$;
create function zoom_core.report_comparison(t uuid,opt jsonb) returns jsonb language sql stable security definer set search_path='' as $$
 with scoped as(select * from zoom_core.report_scope(t,opt)), stats as(select count(*) total,count(*)filter(where item->>'state'='ended') ended,count(*)filter(where item->>'evidence_quality'='complete' and item->>'state'='ended') complete,count(*)filter(where item->>'first_started_at' is not null) start_known,count(*)filter(where (item->>'first_started_at')::timestamptz<=starts_at+make_interval(mins=>(select (operating_policy->>'lateStartMinutes')::int from zoom_core.settings where tenant_id=t))) on_time from scoped)
 select jsonb_build_object('sessions',total,'ended',ended,'complete',complete,'knownStarts',start_known,'onTimeStarts',on_time,'onTimePercent',round(on_time*100.0/nullif(start_known,0),2),'evidenceCoveragePercent',round(complete*100.0/nullif(ended,0),2)) from stats
$$;
alter function public.v1_zoom_snapshot(text,text,jsonb) rename to v1_zoom_snapshot_before_branch_reports;
create function public.v1_zoom_snapshot(p_slug text,p_view text default 'sessions',p_options jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;t uuid;start_at timestamptz;end_at timestamptz;previous jsonb;teacher_rows jsonb;
begin
 result:=public.v1_zoom_snapshot_before_branch_reports(p_slug,p_view,p_options);t:=zoom_core.tenant(p_slug,false);
 if p_view='accounts' then
  return result||jsonb_build_object('branches',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]') from core.branches where tenant_id=t and active),
   'hosts',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from(select id,connection_id,user_id,name,allowed,provider_active,licensed,capacity,concurrency_limit,provider_concurrency,capabilities,verified_at,instructor_subject_id,revision,before_minutes,after_minutes,preference,branch_id from zoom_core.hosts where tenant_id=t
   and (coalesce(p_options->>'query','')='' or name ilike '%'||(p_options->>'query')||'%') and (nullif(p_options->>'connectionId','') is null or connection_id=(p_options->>'connectionId')::uuid)
   and (nullif(p_options->>'branchId','') is null or branch_id=(p_options->>'branchId')::uuid) and (nullif(p_options->>'instructorId','') is null or instructor_subject_id=(p_options->>'instructorId')::uuid)
   and (coalesce(p_options->>'status','')='' or case p_options->>'status' when 'allowed' then allowed when 'disabled' then not allowed when 'unverified' then not licensed or not provider_active or verified_at<=now()-interval '24 hours' else false end)
   order by name,id limit 50 offset coalesce((p_options->>'offset')::int,0))x));
 elsif p_view='reports' then
  start_at:=(result->'period'->>'from')::timestamptz;end_at:=(result->'period'->>'to')::timestamptz;previous:=(p_options-'offset')||jsonb_build_object('from',start_at-(end_at-start_at),'to',start_at);
  with rows as(select l.instructor_subject_id,s.course_run_id,r.item from zoom_core.report_scope(t,p_options) r join zoom_core.links l on l.tenant_id=t and l.id=r.link_id join academy.course_run_sessions s on s.tenant_id=t and s.id=l.session_id), teachers as(select instructor_subject_id,count(*) sessions,count(*)filter(where item->>'first_started_at' is not null) known_starts,count(*)filter(where item->>'evidence_quality'='complete') complete from rows group by instructor_subject_id)
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.full_name,'sessions',v.sessions,'knownStarts',v.known_starts,'completeEvidence',v.complete,'assessmentCount',scores.n,'assessmentPercent',scores.percent,'learnerRating',null) order by a.full_name),'[]') into teacher_rows from (select * from teachers order by instructor_subject_id limit 100)v join access_control.subjects a on a.id=v.instructor_subject_id
  cross join lateral(select count(*) n,round(sum(score)*100/nullif(sum(max_score),0),2) percent from academy.assessment_results ar where ar.tenant_id=t and ar.course_run_id in(select distinct course_run_id from rows where instructor_subject_id=v.instructor_subject_id) and ar.assessed_at>=start_at and ar.assessed_at<end_at)scores;
  return result||jsonb_build_object('comparison',jsonb_build_object('current',zoom_core.report_comparison(t,p_options),'previous',zoom_core.report_comparison(t,previous),'previousFrom',start_at-(end_at-start_at),'previousTo',start_at),'teacherOutcomes',teacher_rows);
 end if;return result;
end $$;
revoke all on function zoom_core.candidates_before_branches(uuid,uuid,uuid,timestamptz,timestamptz,integer,text,jsonb,uuid),zoom_core.candidates(uuid,uuid,uuid,timestamptz,timestamptz,integer,text,jsonb,uuid),public.v1_zoom_action_before_branch(text,text,uuid,jsonb),public.v1_zoom_action(text,text,uuid,jsonb),public.v1_zoom_operation_context_before_branch(uuid,uuid,integer),public.v1_zoom_operation_context(uuid,uuid,integer),zoom_core.report_comparison(uuid,jsonb),public.v1_zoom_snapshot_before_branch_reports(text,text,jsonb),public.v1_zoom_snapshot(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_action(text,text,uuid,jsonb),public.v1_zoom_snapshot(text,text,jsonb) to authenticated;
grant execute on function public.v1_zoom_operation_context(uuid,uuid,integer) to service_role;
commit;
