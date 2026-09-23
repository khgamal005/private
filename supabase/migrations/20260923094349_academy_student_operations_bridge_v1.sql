-- Reuse ODEIR ownership, capacity, operating availability and training tasks.
-- No historical backfill and no activation are performed here.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

create unique index if not exists academy_operations_tasks_tenant_id_uq on work_core.tasks(tenant_id,id);
create table academy.order_operations (
 tenant_id uuid not null references core.tenants(id),order_id uuid not null,contact_id uuid not null,
 assigned_staff_id uuid,followup_staff_id uuid,task_id uuid,
 routing_state text not null check(routing_state in ('assigned','queue')),
 assignment_strategy text not null check(assignment_strategy in ('existing_owner','auto_fair','auto_online','queue','queue_fallback')),
 assigned_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(tenant_id,order_id),
 foreign key(tenant_id,order_id) references academy.store_orders(tenant_id,id),
 foreign key(tenant_id,contact_id) references sales_core.contacts(tenant_id,id),
 foreign key(tenant_id,assigned_staff_id) references people.staff_profiles(tenant_id,id),
 foreign key(tenant_id,followup_staff_id) references people.staff_profiles(tenant_id,id),
 foreign key(tenant_id,task_id) references work_core.tasks(tenant_id,id)
);
create index academy_order_operations_contact_idx on academy.order_operations(tenant_id,contact_id);
create index academy_order_operations_staff_idx on academy.order_operations(tenant_id,assigned_staff_id,assigned_at) where assigned_staff_id is not null;
create index academy_order_operations_followup_idx on academy.order_operations(tenant_id,followup_staff_id) where followup_staff_id is not null;
create index academy_order_operations_task_idx on academy.order_operations(tenant_id,task_id) where task_id is not null;
create index academy_order_operations_queue_idx on academy.order_operations(tenant_id,updated_at,order_id) where routing_state='queue';
alter table academy.order_operations enable row level security;
alter table academy.order_operations force row level security;
revoke all on academy.order_operations from public,anon,authenticated,service_role;

create function private_app.academy_assignment_count_v1(t uuid,s uuid,p_daily boolean) returns bigint
language sql stable security definer set search_path='' as $$
 select count(*) from academy.order_operations o join core.tenants tenant on tenant.id=o.tenant_id
 left join work_core.tasks task on task.tenant_id=o.tenant_id and task.id=o.task_id
 where o.tenant_id=t and o.assigned_staff_id=s and o.routing_state='assigned'
 and case when p_daily then o.assigned_at>=date_trunc('day',now() at time zone tenant.timezone) at time zone tenant.timezone
  and o.assigned_at<(date_trunc('day',now() at time zone tenant.timezone)+interval '1 day') at time zone tenant.timezone
 else task.status in ('todo','in_progress') end
$$;
-- Include native academy assignments in the existing shared selector. Its
-- operating-shift/absence guard remains intact; other tenants have zero new rows.
do $shared_capacity$
declare definition text;capacity text:=') < profile.daily_capacity';load text:='::numeric / greatest(profile.weight, 1)';
begin
 definition:=pg_get_functiondef('private_app.commerce_order_pick_assignee(uuid,text)'::regprocedure);
 if (length(definition)-length(replace(definition,capacity,'')))/length(capacity)<>1
  or (length(definition)-length(replace(definition,load,'')))/length(load)<>1 then raise exception 'academy_assignment_selector_baseline_changed';end if;
 definition:=replace(definition,capacity,') + private_app.academy_assignment_count_v1(p_tenant_id,staff.id,true) < profile.daily_capacity');
 definition:=replace(definition,load,'::numeric / greatest(profile.weight, 1) + private_app.academy_assignment_count_v1(p_tenant_id,staff.id,false)::numeric / greatest(profile.weight,1)');
 execute definition;
end $shared_capacity$;

-- Automated pinning records the real actor when present. A system admission
-- never impersonates an employee to satisfy the old NOT NULL field.
alter table academy.training_enrollment_versions alter column assigned_by_subject_id drop not null;
alter table academy.training_enrollment_versions add column assignment_source text not null default 'manual' check(assignment_source in ('manual','academy_bridge'));
alter table academy.training_enrollment_versions add constraint academy_version_assignment_actor_check check(assigned_by_subject_id is not null or assignment_source='academy_bridge');

alter table academy.training_learning_events alter column actor_subject_id drop not null;
alter table academy.training_learning_events add column actor_type text not null default 'user' check(actor_type in ('user','system'));
alter table academy.training_learning_events add constraint academy_learning_event_actor_check check(actor_subject_id is not null or actor_type='system');

create function private_app.academy_enrollment_delivery_v1(t uuid,p_enrollment_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e academy.enrollments%rowtype;h academy.registration_handoffs%rowtype;version uuid;staff uuid;queue_staff uuid;due timestamptz;zone text;bound boolean;cfg academy.training_journey_settings%rowtype;
begin
 if not private_app.academy_delivery_enabled_v1(t) then return jsonb_build_object('enabled',false);end if;
 select * into e from academy.enrollments where tenant_id=t and id=p_enrollment_id for update;
 if e.id is null then return jsonb_build_object('enabled',true,'ready',false);end if;
 select * into h from academy.registration_handoffs where tenant_id=t and id=e.handoff_id;
 if e.status not in ('confirmed','active','completed') or h.status<>'completed'
  or not coalesce((private_app.training_journey_financial_access_v1(e.id)->>'trainingAllowed')::boolean,false) then return jsonb_build_object('enabled',true,'ready',false);end if;
 select * into cfg from academy.training_journey_settings where tenant_id=t;
 select timezone into zone from core.tenants where id=t;
 due:=(((now() at time zone zone)::date+coalesce(cfg.automation_assignment_due_days,1))+time '17:00') at time zone zone;
 select owner_staff_id into staff from sales_core.contacts where tenant_id=t and id=h.contact_id;
 queue_staff:=private_app.commerce_order_queue_owner(t,cfg.automation_admissions_staff_id);
 if not private_app.training_automation_staff_active_v1(t,staff) then
  staff:=case when private_app.training_automation_staff_active_v1(t,cfg.automation_admissions_staff_id) then cfg.automation_admissions_staff_id
   when private_app.training_automation_staff_active_v1(t,h.assigned_staff_id) then h.assigned_staff_id else queue_staff end;
 end if;
 select version_id into version from academy.training_enrollment_versions where tenant_id=t and enrollment_id=e.id;
 if version is null then
  select cv.id into version from academy.training_course_versions cv where cv.tenant_id=t and cv.course_id=e.course_id and cv.status='published'
   and ((cv.learning_mode='self_paced') = exists(select 1 from academy.course_runs r where r.tenant_id=t and r.id=e.course_run_id and r.metadata->>'trainingJourneySelfpaced'='true')) order by cv.version desc limit 1;
  if version is not null then
   insert into academy.training_enrollment_versions(tenant_id,enrollment_id,version_id,assigned_by_subject_id,assignment_source)
   values(t,e.id,version,private_app.current_subject_id(),'academy_bridge') on conflict(tenant_id,enrollment_id) do nothing;
   if private_app.current_subject_id() is not null then
    perform private_app.training_learning_event_v1(t,e.id,'version_assigned',jsonb_build_object('versionId',version,'source','academy_bridge','actorType','user'));
   else
    insert into academy.training_learning_events(tenant_id,enrollment_id,actor_subject_id,actor_type,event_type,payload)
    values(t,e.id,null,'system','version_assigned',jsonb_build_object('versionId',version,'source','academy_bridge'));
    insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
    values(t,null,'training.version_assigned','training_journey',e.id::text,jsonb_build_object('versionId',version,'source','academy_bridge','actorType','system'));
   end if;
  end if;
 end if;
 bound:=exists(select 1 from academy.training_learner_accounts where tenant_id=t and student_id=e.student_id and status='active');
 if not exists(select 1 from academy.platform_settings where tenant_id=t and mode='connected') then
  return jsonb_build_object('enabled',true,'ready',version is not null,'learnerLinked',bound,'versionId',version);
 end if;
 -- Same missing-content key as the established training scheduler.
 perform private_app.training_automation_task_v1(t,'training-content-'||e.id::text,'استكمال ربط المحتوى التدريبي','content_version_required',staff,h.contact_id,h.id,e.id,due,version is null,cfg.automation_escalation_staff_id,false);
 bound:=exists(select 1 from academy.training_learner_accounts where tenant_id=t and student_id=e.student_id and status='active');
 perform private_app.training_automation_task_v1(t,'academy-learner-access-'||e.id::text,'تجهيز دخول الطالب ومتابعة بدء التدريب','learner_access_required',staff,h.contact_id,h.id,e.id,due,not bound,cfg.automation_escalation_staff_id,false);
 return jsonb_build_object('enabled',true,'ready',version is not null,'learnerLinked',bound,'versionId',version,'followupStaffId',staff);
end $$;

create function private_app.academy_order_operations_v1(t uuid,p_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o academy.store_orders%rowtype;contact sales_core.contacts%rowtype;route sales_core.commerce_order_routing_settings%rowtype;prior academy.order_operations%rowtype;
 staff uuid;queue_staff uuid;task uuid;state text;strategy text;delivery jsonb;
begin
 if not private_app.academy_delivery_enabled_v1(t) then return jsonb_build_object('enabled',false);end if;
 if not exists(select 1 from academy.platform_settings where tenant_id=t and mode='connected') then return jsonb_build_object('enabled',false,'reason','standalone');end if;
 select * into o from academy.store_orders where tenant_id=t and id=p_order_id for update;
 if o.id is null or o.status<>'enrolled' then raise exception 'academy_order_not_editable';end if;
 select c.* into contact from sales_core.contacts c join academy.students st on st.tenant_id=c.tenant_id and st.contact_id=c.id where st.tenant_id=t and st.id=o.student_id for update of c;
 if contact.id is null then raise exception 'academy_identity_review_required';end if;
 select * into prior from academy.order_operations where tenant_id=t and order_id=o.id;
 select * into route from sales_core.commerce_order_routing_settings where tenant_id=t;
 staff:=contact.owner_staff_id;strategy:='existing_owner';
 -- try-lock prevents a contact/routing lock inversion with WooCommerce intake.
 -- Contention becomes a visible queue item; no payment or enrollment is repeated.
 if staff is null then
  strategy:='queue';
  if coalesce(route.routing_mode,'queue') in ('auto_fair','auto_online')
   and pg_try_advisory_xact_lock(hashtextextended('woocommerce-order-routing:'||t::text,2401)) then
   staff:=private_app.commerce_order_pick_assignee(t,route.routing_mode);
   if staff is not null and private_app.training_automation_staff_active_v1(t,staff)
    and private_app.staff_operationally_available_v1(t,staff) then
    update sales_core.contacts set owner_staff_id=staff where tenant_id=t and id=contact.id and owner_staff_id is null;
    update sales_core.sales_assignment_profiles set last_assigned_at=now() where tenant_id=t and staff_id=staff;
    strategy:=route.routing_mode;
   else staff:=null;strategy:='queue_fallback';end if;
  end if;
 end if;
 state:=case when staff is not null and private_app.training_automation_staff_active_v1(t,staff) then 'assigned' else 'queue' end;
 queue_staff:=private_app.commerce_order_queue_owner(t,route.queue_owner_staff_id);
 delivery:=private_app.academy_enrollment_delivery_v1(t,o.enrollment_id);
 -- A queue entry remains visible even when no active manager is configured.
 if state='queue' then
  perform private_app.training_automation_task_v1(t,'academy-order-owner-'||o.id::text,'إسناد طالب المتجر إلى مسؤول المتابعة','store_owner_required',queue_staff,contact.id,o.handoff_id,o.id,
   now()+make_interval(mins=>coalesce(route.default_due_minutes,60)),true,null,false);
  select id into task from work_core.tasks where tenant_id=t and task_key='academy-order-owner-'||o.id::text;
 else
  perform private_app.training_automation_task_v1(t,'academy-order-owner-'||o.id::text,'إسناد طالب المتجر إلى مسؤول المتابعة','store_owner_required',queue_staff,contact.id,o.handoff_id,o.id,now(),false,null,false);
  select id into task from work_core.tasks where tenant_id=t and task_key='academy-learner-access-'||o.enrollment_id::text;
 end if;
 insert into academy.order_operations(tenant_id,order_id,contact_id,assigned_staff_id,followup_staff_id,task_id,routing_state,assignment_strategy,assigned_at)
 values(t,o.id,contact.id,staff,nullif(delivery->>'followupStaffId','')::uuid,task,state,strategy,case when state='assigned' then now() end)
 on conflict(tenant_id,order_id) do update set assigned_staff_id=excluded.assigned_staff_id,followup_staff_id=excluded.followup_staff_id,task_id=excluded.task_id,
  routing_state=excluded.routing_state,assignment_strategy=case when academy.order_operations.assigned_staff_id=excluded.assigned_staff_id then academy.order_operations.assignment_strategy else excluded.assignment_strategy end,
  assigned_at=case when academy.order_operations.assigned_staff_id=excluded.assigned_staff_id then academy.order_operations.assigned_at else excluded.assigned_at end,updated_at=now();
 if prior.order_id is null or prior.assigned_staff_id is distinct from staff or prior.routing_state<>state then
  perform private_app.write_audit('academy.store.operations_linked','academy_store',o.id::text,t,jsonb_build_object('contactId',contact.id,'ownerStaffId',staff,'routingState',state,'strategy',strategy));
 end if;
 return jsonb_build_object('orderId',o.id,'routingState',state,'assignedStaffId',staff,'delivery',delivery);
end $$;

create function private_app.academy_delivery_transition_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare enrollment uuid;
begin
 if not private_app.academy_delivery_enabled_v1(new.tenant_id) then return new;end if;
 if tg_table_name='store_orders' then
  if new.status='enrolled' and old.status<>'enrolled' then perform private_app.academy_order_operations_v1(new.tenant_id,new.id);end if;
 elsif tg_table_name='registration_handoffs' then
  if new.status='completed' and old.status<>'completed' then
   for enrollment in select id from academy.enrollments where tenant_id=new.tenant_id and handoff_id=new.id loop perform private_app.academy_enrollment_delivery_v1(new.tenant_id,enrollment);end loop;
  end if;
 elsif tg_table_name='training_learner_accounts' then
  if new.status='active' then
   update work_core.tasks task set status='completed',completed_at=now(),metadata=task.metadata||jsonb_build_object('lastTransition',jsonb_build_object('kind','academy_learner_bound','actorType','system'))
   from academy.enrollments e where e.tenant_id=new.tenant_id and e.student_id=new.student_id
    and task.tenant_id=e.tenant_id and task.task_key='academy-learner-access-'||e.id::text
    and task.status in ('todo','in_progress') and task.metadata->>'source'='training_journey';
  end if;
 end if;
 return new;
end $$;
create trigger academy_store_operations after update of status on academy.store_orders for each row execute function private_app.academy_delivery_transition_v1();
create trigger academy_operational_learner_delivery after update of status on academy.registration_handoffs for each row execute function private_app.academy_delivery_transition_v1();
create trigger academy_learner_access_resolved after insert or update of status on academy.training_learner_accounts for each row execute function private_app.academy_delivery_transition_v1();

create function public.v1_academy_order_reconcile(p_slug text,p_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid;
begin
 t:=private_app.academy_delivery_tenant_v1(p_slug);
 if private_app.academy_has_permission_v1(t,'manageAdmissions') is not true then raise exception 'forbidden' using errcode='42501';end if;
 return private_app.academy_order_operations_v1(t,p_order_id);
end $$;
revoke all on function private_app.academy_assignment_count_v1(uuid,uuid,boolean),private_app.academy_enrollment_delivery_v1(uuid,uuid),private_app.academy_order_operations_v1(uuid,uuid),private_app.academy_delivery_transition_v1(),public.v1_academy_order_reconcile(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.v1_academy_order_reconcile(text,uuid) to authenticated;

do $commerce_presentation$
declare definition text;needle text;
begin
 definition:=pg_get_functiondef('public.v1_academy_commerce_snapshot(text,integer)'::regprocedure);
 needle:='''verifiedReference'',o.verified_reference)';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'academy_commerce_snapshot_baseline_changed';end if;
 definition:=replace(definition,needle,$fields$'verifiedReference',o.verified_reference,'operations',(
  select jsonb_build_object('routingState',op.routing_state,'strategy',op.assignment_strategy,'ownerName',sp.full_name,'followupName',fp.full_name,'taskStatus',task.status)
  from academy.order_operations op left join people.staff_profiles sp on sp.tenant_id=op.tenant_id and sp.id=op.assigned_staff_id
  left join people.staff_profiles fp on fp.tenant_id=op.tenant_id and fp.id=op.followup_staff_id
  left join work_core.tasks task on task.tenant_id=op.tenant_id and task.id=op.task_id where op.tenant_id=t and op.order_id=o.id))$fields$);
 needle:='''canManageStore'',private_app.academy_has_permission_v1(t,''manageStore'')';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'academy_commerce_snapshot_baseline_changed';end if;
 definition:=replace(definition,needle,'''deliveryEnabled'',private_app.academy_delivery_enabled_v1(t),'||needle);
 execute definition;
 definition:=pg_get_functiondef('public.v1_academy_storefront(text)'::regprocedure);
 needle:='''slug'',c.slug,''name'',c.name';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'academy_storefront_baseline_changed';end if;
 definition:=replace(definition,needle,needle||',''timezone'',c.timezone');
 definition:=replace(definition,'''title'',o.title,''description'',o.description','''title'',course.title_ar,''description'',coalesce(course.description,o.description)');
 execute definition;
end $commerce_presentation$;
commit;
