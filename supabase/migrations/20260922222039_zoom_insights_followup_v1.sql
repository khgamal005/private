begin;
alter table zoom_core.settings add column operating_policy jsonb not null default '{"lateStartMinutes":10,"absenceThreshold":3,"retentionWarningDays":3}'::jsonb;
create index zoom_usage_tenant_time on core.odeiry_usage_events(tenant_id,occurred_at,run_id) where event_type='usage_settled';
create function public.v1_zoom_insights(p_slug text,p_from timestamptz,p_to timestamptz) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug,false);result jsonb;
begin
 if not (zoom_core.allowed(t,'sessions.manage') or zoom_core.allowed(t,'reports.export')) then raise exception 'zoom_forbidden';end if;
 if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '93 days' then raise exception 'zoom_invalid_range';end if;
 select jsonb_build_object('period',jsonb_build_object('from',p_from,'to',p_to),'source','canonical_zoom_operations',
  'hosts',coalesce((select jsonb_agg(to_jsonb(x)) from(select h.id,h.name,h.concurrency_limit,coalesce(sum(extract(epoch from upper(r.occupied_range*tstzrange(p_from,p_to,'[)'))-lower(r.occupied_range*tstzrange(p_from,p_to,'[)')))),0) reserved_seconds,round(coalesce(sum(extract(epoch from upper(r.occupied_range*tstzrange(p_from,p_to,'[)'))-lower(r.occupied_range*tstzrange(p_from,p_to,'[)')))),0)*100/(extract(epoch from p_to-p_from)*h.concurrency_limit),2) calendar_utilization_percent from zoom_core.hosts h left join zoom_core.reservations r on r.tenant_id=t and r.host_id=h.id and r.state<>'released' and r.occupied_range&&tstzrange(p_from,p_to,'[)') where h.tenant_id=t group by h.id order by h.name,h.id limit 50)x),'[]'),
  'quality',(select jsonb_build_object('reportIntervals',count(*),'unmatched',count(*)filter(where v.quality in ('unmatched','ambiguous')),'unknownDuration',count(*)filter(where v.joined_at is null or v.left_at is null or v.left_at<=v.joined_at),'manualMatches',count(*)filter(where v.quality='manual')) from zoom_core.intervals v join zoom_core.instances i on i.tenant_id=v.tenant_id and i.id=v.instance_id join zoom_core.links l on l.tenant_id=i.tenant_id and l.id=i.link_id join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id where v.tenant_id=t and v.source='report' and s.starts_at>=p_from and s.starts_at<p_to),
  'recordings',(select jsonb_build_object('knownProviderBytes',coalesce(sum(r.size_bytes),0),'published',count(*)filter(where r.state='published'),'awaitingReview',count(*)filter(where r.state='review'),'storageCost',null,'watchSeconds',null) from zoom_core.recordings r where r.tenant_id=t and r.updated_at>=p_from and r.updated_at<p_to),
  'messages',(select jsonb_build_object('acceptedByProvider',count(*)filter(where j.status='sent'),'waiting',count(*)filter(where j.status in ('waiting_configuration','pending')),'failed',count(*)filter(where j.status='failed'),'delivered',null) from academy.training_automation_jobs j where j.tenant_id=t and j.metadata?'zoomRevision' and j.created_at>=p_from and j.created_at<p_to),
  'ai',(select jsonb_build_object('settledRuns',count(*),'businessUnits',coalesce(sum(u.business_units),0),'inputTokens',coalesce(sum(u.input_tokens),0),'outputTokens',coalesce(sum(u.output_tokens),0),'recordedProviderCostMicros',coalesce(sum(u.provider_cost_micros),0),'costCurrency','USD','costVerified',coalesce(bool_and(u.provider_cost_micros>0 and u.provider_cost_currency='USD'),false),'billable',coalesce(bool_or(u.billable),false)) from core.odeiry_usage_events u join core.odeiry_runs run on run.tenant_id=u.tenant_id and run.id=u.run_id where u.tenant_id=t and u.event_type='usage_settled' and u.occurred_at>=p_from and u.occurred_at<p_to and run.client_request_id like 'zoom:%'),
  'licenseCost',null,'limitations',jsonb_build_array('Calendar utilization uses elapsed calendar seconds, not office opening hours.','Provider acceptance does not prove delivery or reading.','Zero unverified AI cost is not a free-usage claim.','Provider recording metadata is not a storage bill.')) into result;
 return result;
end $$;
alter function public.v1_zoom_snapshot(text,text,jsonb) rename to v1_zoom_snapshot_before_insights;
create function public.v1_zoom_snapshot(p_slug text,p_view text default 'sessions',p_options jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;t uuid;
begin
 result:=public.v1_zoom_snapshot_before_insights(p_slug,p_view,p_options);t:=zoom_core.tenant(p_slug,false);
 if p_view='accounts' then result:=result||jsonb_build_object('staff',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',full_name)) from people.staff_profiles where tenant_id=t and employment_status='active'),'[]'));
 elsif p_view='reports' then result:=result||jsonb_build_object('insights',public.v1_zoom_insights(p_slug,(result->'period'->>'from')::timestamptz,(result->'period'->>'to')::timestamptz));end if;
 return result;
end $$;
-- Existing Odeiry run authorization/budget is required, and only aggregate
-- evidence leaves the DB. Neither contact rows nor provider secrets are returned.
create function public.v1_zoom_odeiry_context(p_slug text,p_run_id uuid,p_period text default 'last_30_days') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);r core.odeiry_runs%rowtype;days integer;insights jsonb;summary jsonb;
begin
 if not zoom_core.allowed(t,'ai.generate') or not zoom_core.allowed(t,'sessions.manage') then raise exception 'zoom_forbidden';end if;
 select * into r from core.odeiry_runs where tenant_id=t and id=p_run_id and requested_by_subject_id=private_app.current_subject_id() and status in ('reserved','running') and reservation_expires_at>now() and request_context->>'assistantMode'='manager_v1';
 if r.id is null then raise exception 'zoom_ai_budget_required';end if;
 days:=case p_period when 'last_7_days' then 7 when 'last_30_days' then 30 when 'last_90_days' then 90 end;if days is null then raise exception 'zoom_invalid_range';end if;
 insights:=public.v1_zoom_insights(p_slug,now()-make_interval(days=>days),now());
 summary:=public.v1_zoom_snapshot(p_slug,'reports',jsonb_build_object('from',now()-make_interval(days=>days),'to',now()));
 return jsonb_build_object('available',true,'sourceId','manager.zoom_operations.live','title','مؤشرات تشغيل زووم من أودير','period',insights->'period','summary',summary->'summary','quality',insights->'quality','recordings',insights->'recordings','messages',insights->'messages','ai',insights->'ai','limitations',insights->'limitations');
end $$;
alter function public.v1_zoom_operational_tasks() rename to v1_zoom_operational_tasks_before_followup;
create function public.v1_zoom_operational_tasks() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;n int;
begin
 perform zoom_core.service_only();result:=public.v1_zoom_operational_tasks_before_followup();
 with conditions as (
  select l.tenant_id,'late:'||l.id task_key,'التحقق من بدء محاضرة زووم' title,'لم يصل دليل بدء الاجتماع؛ تحقق من المصدر قبل الحكم.' description,l.id reference from zoom_core.links l join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id join zoom_core.settings cfg on cfg.tenant_id=l.tenant_id where l.state in ('ready','imported') and s.status='scheduled' and s.starts_at<now()-make_interval(mins=>(cfg.operating_policy->>'lateStartMinutes')::int) and s.ends_at>now()
  union all select l.tenant_id,'overrun:'||l.id,'مراجعة امتداد محاضرة زووم','الاجتماع ما زال مباشرًا بعد موعده؛ راجع أثره على الحجز التالي دون إنهائه آليًا.',l.id from zoom_core.links l join academy.course_run_sessions s on s.tenant_id=l.tenant_id and s.id=l.session_id where l.state='live' and s.ends_at<now()
  union all select c.tenant_id,'connection:'||c.id,'مراجعة اتصال زووم','الاتصال أو الصلاحيات تحتاج مراجعة؛ لا تحذف التسجيلات أو الدفعات المستقلة.',c.id from zoom_core.connections c where c.status in ('reauth_required','missing_scope','deauthorized')
  union all select r.tenant_id,'retention:'||r.id,'اقتراب انتهاء إتاحة تسجيل','راجع سياسة الإتاحة والاحتفاظ. لا يُحذف الأصل لدى زووم آليًا.',r.id from zoom_core.recordings r join zoom_core.settings cfg on cfg.tenant_id=r.tenant_id where r.state='published' and r.expires_at>now() and r.expires_at<now()+make_interval(days=>(cfg.operating_policy->>'retentionWarningDays')::int)
  union all select a.tenant_id,'absence:'||a.enrollment_id,'مراجعة غياب متكرر معتمد','راجع سجلات الغياب المعتمدة والاستحقاق، ثم اختر المتابعة المناسبة. لا يُرسل تواصل تلقائي.',a.enrollment_id from academy.attendance_records a join zoom_core.settings cfg on cfg.tenant_id=a.tenant_id where a.status='absent' and a.metadata?'zoom' and a.marked_at>now()-interval '30 days' group by a.tenant_id,a.enrollment_id,cfg.operating_policy having count(*)>=(cfg.operating_policy->>'absenceThreshold')::int
 ) insert into work_core.tasks(tenant_id,task_key,title,description,priority,assigned_staff_id,due_at,metadata)
 select x.tenant_id,'zoom:followup:'||x.task_key,x.title,x.description,'high',cfg.owner_staff_id,now()+interval '1 hour',jsonb_build_object('source','zoom_followup','reference',x.reference)
 from conditions x join zoom_core.settings cfg on cfg.tenant_id=x.tenant_id and cfg.enabled join people.staff_profiles p on p.tenant_id=x.tenant_id and p.id=cfg.owner_staff_id and p.employment_status='active'
 where private_app.tenant_addon_enabled(x.tenant_id,'addon.integration.zoom') on conflict(tenant_id,task_key) do update set description=excluded.description,updated_at=now();get diagnostics n=row_count;
 return result||jsonb_build_object('followupConditions',n);
end $$;
revoke all on function public.v1_zoom_insights(text,timestamptz,timestamptz),public.v1_zoom_snapshot_before_insights(text,text,jsonb),public.v1_zoom_snapshot(text,text,jsonb),public.v1_zoom_odeiry_context(text,uuid,text),public.v1_zoom_operational_tasks_before_followup(),public.v1_zoom_operational_tasks() from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_insights(text,timestamptz,timestamptz),public.v1_zoom_snapshot(text,text,jsonb),public.v1_zoom_odeiry_context(text,uuid,text) to authenticated;
grant execute on function public.v1_zoom_operational_tasks() to service_role;
commit;
