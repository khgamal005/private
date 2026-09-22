begin;
-- No generic export-job facility exists in the inspected schema. These are
-- short-lived Zoom report projections, not an academic or financial authority.
create function zoom_core.report_scope(t uuid,opt jsonb,ids uuid[] default null) returns table(link_id uuid,starts_at timestamptz,item jsonb) language sql stable security definer set search_path='' as $$
 select l.id,s.starts_at,jsonb_build_object('link_id',l.id,'title',s.title,'course_title',course.title_ar,'run_title',run.title,'starts_at',s.starts_at,'state',l.state,'reason',l.reason,'host_name',h.name,'account_name',c.label,'instructor_name',teacher.full_name,
  'expected_learners',(select count(*) from zoom_core.roster where tenant_id=t and link_id=l.id),'approved_learners',(select count(*) from academy.attendance_records where tenant_id=t and session_id=s.id and metadata?'zoom'),
  'attendance_percent',(select round(sum(coalesce((a.metadata->'zoom'->>'manualSeconds')::numeric,(a.metadata->'zoom'->>'attendedSeconds')::numeric))*100/nullif(sum((a.metadata->'zoom'->>'requiredSeconds')::numeric),0),2) from academy.attendance_records a where a.tenant_id=t and a.session_id=s.id and a.metadata?'zoom'),
  'evidence_quality',evidence.quality,'first_started_at',evidence.first_start,'last_ended_at',evidence.last_end)
 from zoom_core.links l join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id
 join academy.course_runs run on run.tenant_id=s.tenant_id and run.id=s.course_run_id join academy.courses course on course.tenant_id=run.tenant_id and course.id=run.course_id
 join zoom_core.hosts h on h.tenant_id=l.tenant_id and h.id=l.host_id join zoom_core.connections c on c.tenant_id=l.tenant_id and c.id=l.connection_id left join access_control.subjects teacher on teacher.id=l.instructor_subject_id
 cross join lateral(select case when count(*)=0 then 'unknown' when bool_and(i.evidence_state='complete') then 'complete' else 'incomplete' end quality,min(i.started_at) first_start,max(i.ended_at) last_end from zoom_core.instances i where i.tenant_id=t and i.link_id=l.id)evidence
 where l.tenant_id=t and (ids is null or l.id=any(ids)) and s.starts_at>=coalesce((opt->>'from')::timestamptz,now()-interval '7 days') and s.starts_at<coalesce((opt->>'to')::timestamptz,now()+interval '30 days')
 and (coalesce(opt->>'query','')='' or s.title ilike '%'||(opt->>'query')||'%' or run.title ilike '%'||(opt->>'query')||'%')
 and (nullif(opt->>'courseId','') is null or course.id=(opt->>'courseId')::uuid) and (nullif(opt->>'runId','') is null or run.id=(opt->>'runId')::uuid)
 and (nullif(opt->>'hostId','') is null or h.id=(opt->>'hostId')::uuid) and (nullif(opt->>'connectionId','') is null or c.id=(opt->>'connectionId')::uuid)
 and (nullif(opt->>'instructorId','') is null or l.instructor_subject_id=(opt->>'instructorId')::uuid) and (nullif(opt->>'kind','') is null or l.kind=opt->>'kind')
 and (nullif(opt->>'status','') is null or l.state=opt->>'status') and (nullif(opt->>'quality','') is null or evidence.quality=opt->>'quality')
$$;
alter function public.v1_zoom_snapshot(text,text,jsonb) rename to v1_zoom_snapshot_before_exports;
create function public.v1_zoom_snapshot(p_slug text,p_view text default 'sessions',p_options jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb;t uuid;rows_value jsonb;summary jsonb;
begin
 base:=public.v1_zoom_snapshot_before_exports(p_slug,p_view,p_options);if p_view<>'reports' then return base;end if;t:=zoom_core.tenant(p_slug,false);
 select coalesce(jsonb_agg(item order by starts_at,link_id),'[]') into rows_value from(select * from zoom_core.report_scope(t,p_options) order by starts_at,link_id limit 50 offset coalesce((p_options->>'offset')::int,0))x;
 select jsonb_build_object('scheduled',count(*),'ended',count(*)filter(where item->>'state'='ended'),'cancelled',count(*)filter(where item->>'state'='cancelled'),'exceptions',count(*)filter(where item->>'state' in ('uncertain','drift','failed')),'evidenceComplete',count(*)filter(where item->>'evidence_quality'='complete')) into summary from zoom_core.report_scope(t,p_options);
 return base||jsonb_build_object('rows',rows_value,'summary',summary,'filters',jsonb_build_object(
  'courses',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',title_ar)),'[]') from(select id,title_ar from academy.courses where tenant_id=t order by title_ar limit 200)x),
  'runs',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',title)),'[]') from(select id,title from academy.course_runs where tenant_id=t order by title limit 200)x),
  'hosts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name)),'[]') from(select id,name from zoom_core.hosts where tenant_id=t order by name limit 200)x),
  'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',label)),'[]') from(select id,label from zoom_core.connections where tenant_id=t order by label limit 100)x),
  'instructors',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name)),'[]') from(select distinct a.id,a.full_name from academy.training_run_instructors i join access_control.subjects a on a.id=i.subject_id where i.tenant_id=t order by a.full_name limit 200)x)),
  'exports',case when zoom_core.allowed(t,'reports.export') then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'state',state,'processed',processed,'total',cardinality(link_ids),'createdAt',created_at,'expiresAt',expires_at)),'[]') from(select * from zoom_core.report_exports where tenant_id=t and auth_user_id=auth.uid() and expires_at>now() order by created_at desc limit 10)x) else '[]'::jsonb end);
end $$;
create table zoom_core.report_exports(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),command_id uuid not null,auth_user_id uuid not null references auth.users(id),subject_id uuid not null references access_control.subjects(id),
 options jsonb not null,link_ids uuid[] not null,processed int not null default 0,state text not null default 'pending' check(state in ('pending','processing','ready','revoked','failed')),
 download_hash text,download_until timestamptz,created_at timestamptz not null default now(),completed_at timestamptz,expires_at timestamptz not null default now()+interval '24 hours',last_error text,
 unique(tenant_id,command_id),unique(tenant_id,id)
);
create table zoom_core.report_chunks(tenant_id uuid not null,export_id uuid not null,page int not null,rows jsonb not null,primary key(export_id,page),foreign key(tenant_id,export_id) references zoom_core.report_exports(tenant_id,id) on delete cascade);
create index zoom_report_exports_due on zoom_core.report_exports(state,created_at);
alter table zoom_core.report_exports enable row level security;alter table zoom_core.report_exports force row level security;
alter table zoom_core.report_chunks enable row level security;alter table zoom_core.report_chunks force row level security;
revoke all on zoom_core.report_exports,zoom_core.report_chunks from public,anon,authenticated,service_role;
create function public.v1_zoom_report_request(p_slug text,p_command_id uuid,p_options jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);result jsonb;ids uuid[];job uuid;opt jsonb;start_at timestamptz:=coalesce((p_options->>'from')::timestamptz,now()-interval '7 days');end_at timestamptz:=coalesce((p_options->>'to')::timestamptz,now()+interval '30 days');
begin
 if not zoom_core.allowed(t,'reports.export') then raise exception 'zoom_forbidden';end if;
 if end_at<=start_at or end_at-start_at>interval '93 days' or length(coalesce(p_options->>'query',''))>100 then raise exception 'zoom_invalid_range';end if;
 result:=zoom_core.command(t,p_command_id,'report_export',p_options);if result is not null then return result;end if;
 opt:=(p_options-'offset')||jsonb_build_object('from',start_at,'to',end_at);
 select coalesce(array_agg(link_id order by starts_at,link_id),'{}') into ids from(select link_id,starts_at from zoom_core.report_scope(t,opt) order by starts_at,link_id limit 50001)x;
 if cardinality(ids)>50000 then raise exception 'zoom_export_too_large';end if;
 insert into zoom_core.report_exports(tenant_id,command_id,auth_user_id,subject_id,options,link_ids) values(t,p_command_id,auth.uid(),private_app.current_subject_id(),opt,ids) returning id into job;
 result:=jsonb_build_object('id',job,'state','pending','total',cardinality(ids));update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.report.requested','zoom_export',job::text,t,jsonb_build_object('rows',cardinality(ids),'options',opt));return result;
end $$;
create function public.v1_zoom_reports_work(p_limit int default 2) returns jsonb language plpgsql security definer set search_path='' as $$
declare job zoom_core.report_exports%rowtype;part jsonb;next_pos int;processed_jobs int:=0;
begin
 perform zoom_core.service_only();if p_limit not between 1 and 10 then raise exception 'zoom_invalid_request';end if;
 delete from zoom_core.report_exports where expires_at<=now();
 for job in select * from zoom_core.report_exports where state in ('pending','processing') order by created_at,id limit p_limit for update skip locked loop
  begin
   perform zoom_core.assert_actor(job.tenant_id,job.auth_user_id,job.subject_id,'reports.export');
   if not exists(select 1 from zoom_core.settings where tenant_id=job.tenant_id and enabled) or not private_app.tenant_addon_enabled(job.tenant_id,'addon.integration.zoom') then raise exception 'zoom_not_enabled';end if;
   next_pos:=least(job.processed+100,cardinality(job.link_ids));
   select coalesce(jsonb_agg(item order by starts_at,link_id),'[]') into part from zoom_core.report_scope(job.tenant_id,job.options,job.link_ids[job.processed+1:next_pos]);
   insert into zoom_core.report_chunks(tenant_id,export_id,page,rows) values(job.tenant_id,job.id,job.processed/100,part);
   update zoom_core.report_exports set processed=next_pos,state=case when next_pos=cardinality(link_ids) then 'ready' else 'processing' end,completed_at=case when next_pos=cardinality(link_ids) then now() end,expires_at=case when next_pos=cardinality(link_ids) then now()+interval '1 hour' else expires_at end where id=job.id;
   processed_jobs:=processed_jobs+1;
  exception when others then
   delete from zoom_core.report_chunks where export_id=job.id;update zoom_core.report_exports set state='revoked',link_ids='{}',last_error='zoom_export_authority_or_source_changed',download_hash=null where id=job.id;
  end;
 end loop;return jsonb_build_object('processedJobs',processed_jobs);
end $$;
create function public.v1_zoom_report_ticket(p_slug text,p_export_id uuid,p_token_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);job zoom_core.report_exports%rowtype;
begin
 if not zoom_core.allowed(t,'reports.export') or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'zoom_forbidden';end if;
 select * into job from zoom_core.report_exports where tenant_id=t and id=p_export_id and auth_user_id=auth.uid() and subject_id=private_app.current_subject_id() and state='ready' and expires_at>now() for update;
 if job.id is null then raise exception 'zoom_not_found';end if;
 update zoom_core.report_exports set download_hash=p_token_hash,download_until=now()+interval '2 minutes' where id=job.id;
 perform private_app.write_audit('zoom.report.download','zoom_export',job.id::text,t,jsonb_build_object('rows',job.processed));return jsonb_build_object('pages',greatest(1,ceil(job.processed/100.0)),'expiresIn',120);
end $$;
create function public.v1_zoom_report_chunk(p_slug text,p_export_id uuid,p_token_hash text,p_page int default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);job zoom_core.report_exports%rowtype;data jsonb;
begin
 if not zoom_core.allowed(t,'reports.export') or p_page not between 0 and 499 then raise exception 'zoom_forbidden';end if;
 select * into job from zoom_core.report_exports where tenant_id=t and id=p_export_id and auth_user_id=auth.uid() and subject_id=private_app.current_subject_id() and state='ready' and expires_at>now() and download_until>now() and download_hash=p_token_hash;
 if job.id is null then raise exception 'zoom_access_expired';end if;
 if exists(select 1 from zoom_core.links l join zoom_core.connections c on c.tenant_id=l.tenant_id and c.id=l.connection_id where l.tenant_id=t and l.id=any(job.link_ids) and c.status in ('deauthorized','disconnected')) then raise exception 'zoom_recording_unavailable';end if;
 select rows into data from zoom_core.report_chunks where tenant_id=t and export_id=job.id and page=p_page;
 if data is null then raise exception 'zoom_not_found';end if;
 return jsonb_build_object('rows',data,'pages',greatest(1,ceil(job.processed/100.0)),'generatedFrom',job.created_at,'generatedTo',job.completed_at,'period',job.options);
end $$;
revoke all on function zoom_core.report_scope(uuid,jsonb,uuid[]),public.v1_zoom_snapshot_before_exports(text,text,jsonb),public.v1_zoom_snapshot(text,text,jsonb),public.v1_zoom_report_request(text,uuid,jsonb),public.v1_zoom_reports_work(int),public.v1_zoom_report_ticket(text,uuid,text),public.v1_zoom_report_chunk(text,uuid,text,int) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_snapshot(text,text,jsonb),public.v1_zoom_report_request(text,uuid,jsonb),public.v1_zoom_report_ticket(text,uuid,text),public.v1_zoom_report_chunk(text,uuid,text,int) to authenticated;
grant execute on function public.v1_zoom_reports_work(int) to service_role;
alter function public.v1_zoom_purge(int) rename to v1_zoom_purge_before_exports;
create function public.v1_zoom_purge(p_limit int default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 result:=public.v1_zoom_purge_before_exports(p_limit);
 delete from zoom_core.report_exports job where job.expires_at<=now() or exists(select 1 from zoom_core.links l join zoom_core.connections c on c.tenant_id=l.tenant_id and c.id=l.connection_id where l.tenant_id=job.tenant_id and l.id=any(job.link_ids) and c.status='deauthorized');
 return result;
end $$;
revoke all on function public.v1_zoom_purge_before_exports(int),public.v1_zoom_purge(int) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_purge(int) to service_role;
commit;
