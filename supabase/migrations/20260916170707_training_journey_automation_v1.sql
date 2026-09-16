-- Internal staff reminders only. No customer messages, enrollment mutation or payment mutation.
-- The scheduler is inert until the Marktone pilot, LMS entitlement and automation are enabled.
begin;

alter table academy.training_journey_settings
 add column automation_enabled boolean not null default false,
 add column automation_admissions_staff_id uuid references people.staff_profiles(id),
 add column automation_finance_staff_id uuid references people.staff_profiles(id),
 add column automation_escalation_staff_id uuid references people.staff_profiles(id),
 add column automation_assignment_due_days integer not null default 1 check (automation_assignment_due_days between 1 and 7),
 add column automation_grading_due_days integer not null default 2 check (automation_grading_due_days between 1 and 14),
 add column automation_cursor text,
 add column automation_last_run_at timestamptz;

create function private_app.training_automation_staff_active_v1(p_tenant_id uuid,p_staff_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from people.staff_profiles sp
 join access_control.memberships m on m.id=sp.membership_id and m.tenant_id=sp.tenant_id and m.scope='tenant' and m.status='active'
 join access_control.subjects s on s.id=m.subject_id and s.status='active' and not s.must_change_password
 where sp.tenant_id=p_tenant_id and sp.id=p_staff_id and sp.employment_status='active')
$$;

-- Both the authenticated manual reconcile and the scheduled worker use the same task keys.
-- This helper never creates sales follow-ups and never impersonates a staff member.
create function private_app.training_automation_task_v1(p_tenant_id uuid,p_key text,p_title text,p_milestone text,
 p_staff uuid,p_contact uuid,p_handoff uuid,p_resource uuid,p_due timestamptz,p_active boolean,
 p_escalation_staff uuid,p_dry_run boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare task work_core.tasks%rowtype; task_id uuid; changed boolean:=false; notif integer:=0; touched integer:=0;
 meta jsonb; occurrence integer:=1; notification_key text;
begin
 select * into task from work_core.tasks where tenant_id=p_tenant_id and task_key=p_key;
 if not p_active then
  if task.status in ('todo','in_progress') and task.metadata->>'source'='training_journey' and not p_dry_run then
   update work_core.tasks set status='completed',completed_at=now(),metadata=metadata||jsonb_build_object('lastTransition',jsonb_build_object('kind','training_automation_resolved','actorType','system')) where id=task.id and tenant_id=p_tenant_id;
   changed:=true;
  end if;
  return jsonb_build_object('actionable',false,'changed',changed,'notifications',0,'missingAssignee',false);
 end if;
 if not private_app.training_automation_staff_active_v1(p_tenant_id,p_staff) then
  return jsonb_build_object('actionable',true,'changed',false,'notifications',0,'missingAssignee',true);
 end if;
 if p_dry_run then return jsonb_build_object('actionable',true,'changed',false,'notifications',0,'missingAssignee',false); end if;
 if task.id is not null and task.metadata->>'source' is distinct from 'training_journey' then raise exception 'training_task_key_collision'; end if;
 occurrence:=coalesce((task.metadata->>'automationOccurrence')::integer,1);
 if task.id is not null and task.status in ('completed','cancelled') then occurrence:=occurrence+1; end if;
 meta:=jsonb_build_object('source','training_journey','actionType','custom','actorType','system',
  'handoffId',p_handoff,'resourceId',p_resource,'automationMilestone',p_milestone,'automationOccurrence',occurrence);
 if task.id is null then
  insert into work_core.tasks(tenant_id,task_key,title,description,status,priority,assigned_staff_id,created_by_subject_id,contact_id,due_at,metadata)
  values(p_tenant_id,p_key,p_title,'افتح منصة التدريب التفاعلي لمراجعة الحالة واتخاذ الإجراء المناسب.','todo','high',p_staff,null,p_contact,p_due,meta)
  on conflict(tenant_id,task_key) do nothing returning id into task_id;
  changed:=task_id is not null;
  select * into task from work_core.tasks where tenant_id=p_tenant_id and task_key=p_key;
 else
  if task.status in ('completed','cancelled') or task.assigned_staff_id is distinct from p_staff or task.metadata->>'automationMilestone' is distinct from p_milestone then
   update work_core.tasks set status=case when status in ('completed','cancelled') then 'todo' else status end,
    completed_at=null,assigned_staff_id=p_staff,title=p_title,
    due_at=case when status in ('completed','cancelled') then p_due else due_at end,
    metadata=metadata||meta||jsonb_build_object('lastTransition',jsonb_build_object('kind','training_automation_reconciled','actorType','system'))
   where id=task.id and tenant_id=p_tenant_id;
   changed:=true;
  end if;
 end if;
 select * into task from work_core.tasks where tenant_id=p_tenant_id and task_key=p_key;
 notification_key:=case when p_milestone='request_pending' and occurrence=1 then p_key else p_key||':'||p_milestone||':'||occurrence::text end;
 insert into work_core.notifications(tenant_id,notification_key,recipient_staff_id,notification_type,title,message,severity,action_path,contact_id,handoff_id,metadata)
 values(p_tenant_id,notification_key,p_staff,'training_journey',p_title,'توجد حالة تدريب تحتاج متابعتك داخل منصة التدريب التفاعلي.','warning','lms',p_contact,p_handoff,
  jsonb_build_object('source','training_journey','taskId',task.id,'resourceId',p_resource,'actorType','system')) on conflict do nothing;
 get diagnostics touched=row_count; notif:=notif+touched;
 if task.due_at<now() and private_app.training_automation_staff_active_v1(p_tenant_id,p_escalation_staff) and p_escalation_staff<>p_staff then
  insert into work_core.notifications(tenant_id,notification_key,recipient_staff_id,notification_type,title,message,severity,action_path,contact_id,handoff_id,metadata)
  values(p_tenant_id,notification_key||':escalation',p_escalation_staff,'training_journey','حالة تدريب تجاوزت موعد المتابعة',p_title,'danger','lms',p_contact,p_handoff,
   jsonb_build_object('source','training_journey','taskId',task.id,'resourceId',p_resource,'actorType','system','escalation',true)) on conflict do nothing;
  get diagnostics touched=row_count; notif:=notif+touched;
 end if;
 return jsonb_build_object('actionable',true,'changed',changed,'notifications',notif,'missingAssignee',false);
end $$;

create function private_app.training_journey_sweep_batch_v1(p_limit integer default 50,p_dry_run boolean default true,p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t constant uuid:='3d185482-b916-49cc-b868-b6dfdb93eba8'; cfg academy.training_journey_settings%rowtype;
 tz text; row_record record; h academy.registration_handoffs%rowtype; e academy.enrollments%rowtype;
 sub academy.training_submissions%rowtype; req academy.training_journey_requests%rowtype; financial jsonb; outcome jsonb;
 staff uuid; contact uuid; handoff uuid; resource uuid; due timestamptz; active boolean; milestone text; title text; key text;
 batch_size integer:=greatest(1,least(coalesce(p_limit,50),50)); checked integer:=0; actionable integer:=0; changed integer:=0; notifications integer:=0; missing integer:=0; cursor_key text;
begin
 if p_dry_run is null or p_preview is null then raise exception 'training_automation_options_required';end if;
 select s.* into cfg from academy.training_journey_settings s join core.tenants c on c.id=s.tenant_id
 where s.tenant_id=t and c.slug='marktone' and c.status in ('trial','active') and s.enabled;
 if cfg.tenant_id is null or not private_app.tenant_addon_enabled(t,'lms') or (not cfg.automation_enabled and not p_preview) then
  return jsonb_build_object('skipped',true,'reason','disabled','checkedCount',0,'dryRun',p_dry_run);
 end if;
 if not p_dry_run and not pg_try_advisory_xact_lock(hashtextextended('training-journey-automation:'||t::text,91217)) then
  return jsonb_build_object('skipped',true,'reason','in_flight','checkedCount',0,'dryRun',false);
 end if;
 select timezone into tz from core.tenants where id=t;
 cursor_key:=case when p_dry_run then null else cfg.automation_cursor end;
 -- Cursor scans bounded source slices. Financial calculations occur only inside this batch.
 for row_record in
  select * from (
   (select 'c:'||en.id::text candidate,'content' kind,en.id resource_id from academy.enrollments en
     join academy.training_financial_links l on l.tenant_id=en.tenant_id and l.handoff_id=en.handoff_id
     where en.tenant_id=t and (cursor_key is null or cursor_key<'c:' or (left(cursor_key,2)='c:' and en.id>substring(cursor_key from 3)::uuid)) order by en.id limit batch_size)
   union all
   (select 'f:'||l.handoff_id::text,'finance',l.handoff_id from academy.training_financial_links l
     where l.tenant_id=t and (cursor_key is null or cursor_key<'f:' or (left(cursor_key,2)='f:' and l.handoff_id>substring(cursor_key from 3)::uuid)) order by l.handoff_id limit batch_size)
   union all
   (select 'g:'||s.id::text,'grading',s.id from academy.training_submissions s
     where s.tenant_id=t and (cursor_key is null or cursor_key<'g:' or (left(cursor_key,2)='g:' and s.id>substring(cursor_key from 3)::uuid)) order by s.id limit batch_size)
   union all
   (select 'r:'||r.id::text,'request',r.id from academy.training_journey_requests r
     where r.tenant_id=t and (cursor_key is null or cursor_key<'r:' or (left(cursor_key,2)='r:' and r.id>substring(cursor_key from 3)::uuid)) order by r.id limit batch_size)
  ) candidates order by candidate limit batch_size
 loop
  checked:=checked+1; cursor_key:=row_record.candidate; resource:=row_record.resource_id;
  staff:=null; contact:=null; handoff:=null; active:=false; due:=null; milestone:='resolved'; title:='متابعة التدريب';
  if row_record.kind='content' then
   select * into e from academy.enrollments where tenant_id=t and id=resource;
   select * into h from academy.registration_handoffs where tenant_id=t and id=e.handoff_id;
   key:='training-content-'||e.id::text;handoff:=h.id;contact:=h.contact_id;
   active:=e.status in ('confirmed','active') and not exists(
    select 1 from academy.training_enrollment_versions ev
    join academy.training_course_versions v on v.tenant_id=ev.tenant_id and v.id=ev.version_id and v.course_id=e.course_id and v.status='published'
    where ev.tenant_id=t and ev.enrollment_id=e.id);
   if active then
    staff:=cfg.automation_admissions_staff_id;title:='استكمال ربط المحتوى التدريبي';milestone:='content_version_required';
    due:=(((e.enrolled_at at time zone tz)::date+cfg.automation_assignment_due_days)+time '17:00') at time zone tz;
   end if;
  elsif row_record.kind='finance' then
   select * into h from academy.registration_handoffs where tenant_id=t and id=resource;
   select * into e from academy.enrollments where tenant_id=t and handoff_id=h.id;
   financial:=case when e.id is null then private_app.training_journey_handoff_finance_v1(h.id) else private_app.training_journey_financial_access_v1(e.id) end;
   handoff:=h.id;contact:=h.contact_id;key:='training-clearance-'||h.id::text;
   if h.status not in ('rejected','cancelled') and e.id is null and coalesce((financial->>'trainingAllowed')::boolean,false) then
    active:=true;milestone:='paid_unassigned';title:='استكمال إسناد المتدرب';
    staff:=case when private_app.training_automation_staff_active_v1(t,h.assigned_staff_id) then h.assigned_staff_id else cfg.automation_admissions_staff_id end;
    due:=(((coalesce(h.payment_verified_at,h.created_at) at time zone tz)::date+cfg.automation_assignment_due_days)+time '17:00') at time zone tz;
   elsif h.status not in ('rejected','cancelled') and (e.id is null or e.status in ('confirmed','active','completed')) and financial->>'financialStatus' in ('grace_period','overdue') then
    active:=true;milestone:=(financial->>'financialStatus')||':'||(financial->>'overdueSince');
    title:=case when financial->>'financialStatus'='grace_period' then 'متابعة قسط خلال مهلة السداد' else 'متابعة قسط تجاوز مهلة السداد' end;
    staff:=cfg.automation_finance_staff_id;
    due:=((financial->>'graceEndsOn')::date+time '17:00') at time zone tz;
   end if;
  elsif row_record.kind='grading' then
   select * into sub from academy.training_submissions where tenant_id=t and id=resource;
   select * into e from academy.enrollments where tenant_id=t and id=sub.enrollment_id;
   select * into h from academy.registration_handoffs where tenant_id=t and id=e.handoff_id;
   key:='training-grading-'||sub.id::text;handoff:=h.id;contact:=h.contact_id;
   active:=e.status in ('confirmed','active','completed')
    and not exists(select 1 from academy.training_grades g where g.tenant_id=t and g.submission_id=sub.id)
    and not exists(select 1 from academy.training_submissions n where n.tenant_id=t and n.enrollment_id=sub.enrollment_id and n.unit_id=sub.unit_id and n.attempt>sub.attempt);
   if active then
    select sp.id into staff from academy.training_run_instructors i
     join access_control.memberships m on m.tenant_id=i.tenant_id and m.subject_id=i.subject_id and m.scope='tenant'
     join people.staff_profiles sp on sp.tenant_id=t and sp.membership_id=m.id
     where i.tenant_id=t and i.run_id=e.course_run_id and i.active and private_app.training_automation_staff_active_v1(t,sp.id)
     order by i.assigned_at,sp.id limit 1;
    if staff is null then staff:=cfg.automation_escalation_staff_id;title:='تعيين محاضر لتصحيح الواجب';milestone:='instructor_required';
    else title:='واجب ينتظر التصحيح';milestone:='awaiting_grade';end if;
    due:=(((sub.submitted_at at time zone tz)::date+cfg.automation_grading_due_days)+time '17:00') at time zone tz;
   end if;
  else
   select * into req from academy.training_journey_requests where tenant_id=t and id=resource;
   select * into e from academy.enrollments where tenant_id=t and id=req.enrollment_id;
   select * into h from academy.registration_handoffs where tenant_id=t and id=e.handoff_id;
   key:='training-request-'||req.id::text;handoff:=h.id;contact:=h.contact_id;active:=req.status='pending';
   staff:=case when private_app.training_automation_staff_active_v1(t,req.assigned_staff_id) then req.assigned_staff_id else cfg.automation_admissions_staff_id end;
   due:=req.due_at;title:='مراجعة طلب المتدرب';milestone:='request_pending';
  end if;
  outcome:=private_app.training_automation_task_v1(t,key,title,milestone,staff,contact,handoff,resource,due,active,cfg.automation_escalation_staff_id,p_dry_run);
  actionable:=actionable+case when (outcome->>'actionable')::boolean then 1 else 0 end;
  changed:=changed+case when (outcome->>'changed')::boolean then 1 else 0 end;
  notifications:=notifications+(outcome->>'notifications')::integer;
  missing:=missing+case when (outcome->>'missingAssignee')::boolean then 1 else 0 end;
 end loop;
 if not p_dry_run then
  update academy.training_journey_settings set automation_cursor=case when checked=batch_size then cursor_key else null end,automation_last_run_at=now() where tenant_id=t;
  if changed>0 or notifications>0 then
   insert into academy.training_journey_events(tenant_id,actor_subject_id,event_type,payload)
   values(t,null,'automation.sweep',jsonb_build_object('actorType','system','checkedCount',checked,'changedCount',changed,'notificationCount',notifications,'missingAssigneeCount',missing));
  end if;
 end if;
 return jsonb_build_object('skipped',false,'dryRun',p_dry_run,'checkedCount',checked,'actionableCount',actionable,'changedCount',changed,'notificationCount',notifications,'missingAssigneeCount',missing,'batchSize',batch_size);
end $$;

create function private_app.training_journey_sweep_v1() returns jsonb
language sql security definer set search_path='' as $$ select private_app.training_journey_sweep_batch_v1(50,false,false) $$;
create function public.v1_training_journey_sweep(p_limit integer default 50,p_dry_run boolean default true) returns jsonb
language sql security definer set search_path='' as $$ select private_app.training_journey_sweep_batch_v1(p_limit,p_dry_run,false) $$;

create function public.v3_training_automation_settings_action(p_slug text,p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid; cfg academy.training_journey_settings%rowtype; staff uuid; v_enabled boolean; cached jsonb; response jsonb; command uuid;
begin
 t:=private_app.training_journey_tenant_v1(p_slug);
 if not private_app.has_tenant_permission(t,'tenant.academy.write') or not private_app.has_tenant_permission(t,'tenant.settings.manage') then raise exception 'forbidden' using errcode='42501';end if;
 if p_action not in ('snapshot','preview','update') or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'training_action_invalid';end if;
 if p_action='preview' then return private_app.training_journey_sweep_batch_v1(50,true,true);end if;
 if p_action='update' then
  command:=(p_payload->>'commandId')::uuid;
  cached:=private_app.training_journey_command_v1(t,command,'automation.update',p_payload);
  if cached is not null then return cached;end if;
  if jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' then raise exception 'training_enabled_required';end if;
  v_enabled:=(p_payload->>'enabled')::boolean;
  foreach staff in array array[(p_payload->>'admissionsStaffId')::uuid,(p_payload->>'financeStaffId')::uuid,(p_payload->>'escalationStaffId')::uuid] loop
   if (v_enabled or staff is not null) and not private_app.training_automation_staff_active_v1(t,staff) then raise exception 'training_responsible_staff_required';end if;
  end loop;
  update academy.training_journey_settings set automation_enabled=v_enabled,
   automation_admissions_staff_id=(p_payload->>'admissionsStaffId')::uuid,
   automation_finance_staff_id=(p_payload->>'financeStaffId')::uuid,
   automation_escalation_staff_id=(p_payload->>'escalationStaffId')::uuid,
   automation_assignment_due_days=coalesce((p_payload->>'assignmentDueDays')::integer,1),
   automation_grading_due_days=coalesce((p_payload->>'gradingDueDays')::integer,2),
   automation_cursor=null,updated_at=now(),updated_by_subject_id=private_app.current_subject_id() where tenant_id=t;
  perform private_app.training_journey_append_event_v1(t,'automation.settings',t,p_payload-'commandId');
 end if;
 select * into cfg from academy.training_journey_settings where tenant_id=t;
 response:=jsonb_build_object('enabled',cfg.automation_enabled,'admissionsStaffId',cfg.automation_admissions_staff_id,
  'financeStaffId',cfg.automation_finance_staff_id,'escalationStaffId',cfg.automation_escalation_staff_id,
  'assignmentDueDays',cfg.automation_assignment_due_days,'gradingDueDays',cfg.automation_grading_due_days,'lastRunAt',cfg.automation_last_run_at,
  'cronAvailable',exists(select 1 from pg_catalog.pg_extension where extname='pg_cron'),
  'staffCandidates',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.full_name) order by s.full_name,s.id)
   from people.staff_profiles s where s.tenant_id=t and private_app.training_automation_staff_active_v1(t,s.id)),'[]'::jsonb));
 if p_action='update' then return private_app.training_journey_complete_command_v1(t,command,response);end if;
 return response;
end $$;

revoke all on function private_app.training_automation_staff_active_v1(uuid,uuid),private_app.training_automation_task_v1(uuid,text,text,text,uuid,uuid,uuid,uuid,timestamptz,boolean,uuid,boolean),private_app.training_journey_sweep_batch_v1(integer,boolean,boolean),private_app.training_journey_sweep_v1(),public.v1_training_journey_sweep(integer,boolean),public.v3_training_automation_settings_action(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.v1_training_journey_sweep(integer,boolean) to service_role;
grant execute on function public.v3_training_automation_settings_action(text,text,jsonb) to authenticated;

-- pg_cron is already installed by the canonical training automation migration.
-- The optional check also permits local PostgreSQL test runtimes without pg_cron.
do $$ begin
 if exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then
  perform cron.schedule('odeir-marktone-training-journey','*/5 * * * *','select private_app.training_journey_sweep_v1();');
 end if;
end $$;
commit;
