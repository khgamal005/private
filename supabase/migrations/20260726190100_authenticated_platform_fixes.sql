create extension if not exists http with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function platform.api_subject_id(p_user_id uuid)
returns uuid language sql stable security definer set search_path='' as $$
 select s.id from identity.subjects s
 left join identity.external_identities x on x.subject_id=s.id
 left join auth.users u on u.id=p_user_id
 where x.provider_subject=p_user_id::text or s.subject_key=p_user_id::text or (u.email is not null and lower(s.email)=lower(u.email))
 order by case when x.provider_subject=p_user_id::text then 0 else 1 end limit 1
$$;
create or replace function platform.is_platform_operator(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from identity.memberships m join identity.roles r on r.id=m.role_id
 where m.subject_id=platform.api_subject_id(p_user_id) and m.status='active'
 and (m.starts_at is null or m.starts_at<=now()) and (m.ends_at is null or m.ends_at>now())
 and r.role_key in ('platform_owner','platform_admin'))
$$;
create or replace function platform.assert_api_user(p_user_id uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin if auth.uid() is null or p_user_id is null or auth.uid()<>p_user_id then raise exception 'forbidden'; end if; end $$;
create or replace function platform.assert_tenant_access(p_user_id uuid,p_tenant_slug text)
returns void language plpgsql stable security definer set search_path='' as $$
declare v_tenant uuid; v_subject uuid; v_email text;
begin
 perform platform.assert_api_user(p_user_id);
 select t.id into v_tenant from platform.tenants t where t.slug=p_tenant_slug and t.lifecycle_status not in ('closed','deleted') and t.archived_at is null limit 1;
 if v_tenant is null then raise exception 'tenant_not_found'; end if;
 if platform.is_platform_operator(p_user_id) then return; end if;
 v_subject:=platform.api_subject_id(p_user_id);
 select lower(u.email) into v_email from auth.users u where u.id=p_user_id;
 if exists(select 1 from identity.memberships m where m.subject_id=v_subject and m.tenant_id=v_tenant and m.status='active' and (m.starts_at is null or m.starts_at<=now()) and (m.ends_at is null or m.ends_at>now()))
 or exists(select 1 from crm.employees e where e.tenant_id=v_tenant and e.employment_status='active' and (e.subject_id=v_subject or lower(coalesce(e.email::text,''))=v_email))
 then return; end if;
 raise exception 'forbidden';
end $$;

create or replace function operations.ensure_user(p_user_id uuid,p_email text default null,p_name text default null,p_tenant_slug text default null)
returns operations.users language plpgsql security definer set search_path='' as $$
declare v_user operations.users; v_auth auth.users%rowtype; v_tenant uuid; v_role text:='member'; v_employee crm.employees%rowtype; v_job_role record; v_manager_auth uuid; v_email text;
begin
 if p_user_id is null then raise exception 'user_required'; end if;
 select * into v_auth from auth.users where id=p_user_id;
 if v_auth.id is null then raise exception 'auth_user_not_found'; end if;
 v_email:=lower(coalesce(nullif(trim(p_email),''),v_auth.email,''));
 v_tenant:=operations.resolve_tenant_id(p_tenant_slug);
 v_role:=operations.normalize_role(coalesce(v_auth.raw_app_meta_data->>'role',''));
 if v_tenant is not null and v_email<>'' then
  select e.* into v_employee from crm.employees e where e.tenant_id=v_tenant and e.employment_status='active' and lower(coalesce(e.email::text,''))=v_email order by e.updated_at desc limit 1;
 end if;
 if v_employee.id is not null then
  select role_key,name_ar,name_en into v_job_role from crm.job_roles where id=v_employee.job_role_id;
  v_role:=operations.normalize_role(coalesce(v_job_role.role_key,v_job_role.name_ar,v_job_role.name_en,''));
  p_name:=coalesce(nullif(trim(p_name),''),v_employee.full_name);
  if v_employee.manager_employee_id is not null then
   select u.id into v_manager_auth from crm.employees m join auth.users u on lower(coalesce(u.email,''))=lower(coalesce(m.email::text,'')) where m.id=v_employee.manager_employee_id limit 1;
  end if;
 end if;
 if platform.is_platform_operator(p_user_id) then v_role:='admin'; end if;
 insert into operations.users(user_id,tenant_id,employee_id,email,display_name,role_code,manager_user_id,last_seen_at)
 values(p_user_id,v_tenant,v_employee.id,nullif(v_email,''),coalesce(nullif(trim(p_name),''),v_auth.raw_user_meta_data->>'name',split_part(v_email,'@',1)),v_role,v_manager_auth,now())
 on conflict(user_id) do update set tenant_id=coalesce(excluded.tenant_id,operations.users.tenant_id),employee_id=coalesce(excluded.employee_id,operations.users.employee_id),email=coalesce(excluded.email,operations.users.email),display_name=coalesce(excluded.display_name,operations.users.display_name),role_code=case when excluded.role_code='member' and operations.users.role_code<>'member' then operations.users.role_code else excluded.role_code end,manager_user_id=coalesce(excluded.manager_user_id,operations.users.manager_user_id),last_seen_at=now(),updated_at=now()
 returning * into v_user;
 return v_user;
end $$;

create or replace function public.operations_api_heartbeat(p_user_id uuid,p_email text,p_name text,p_tenant_slug text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_api_user(p_user_id); if p_tenant_slug is not null then perform platform.assert_tenant_access(p_user_id,p_tenant_slug); end if; return public.operations_heartbeat(p_user_id,p_email,p_name,p_tenant_slug); end $$;
create or replace function public.operations_api_bootstrap(p_user_id uuid,p_email text,p_name text,p_tenant_slug text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_api_user(p_user_id); if p_tenant_slug is not null then perform platform.assert_tenant_access(p_user_id,p_tenant_slug); end if; return public.operations_bootstrap(p_user_id,p_email,p_name,p_tenant_slug); end $$;
create or replace function public.operations_api_calendar(p_user_id uuid,p_tenant_slug text,p_from timestamptz,p_to timestamptz,p_scope text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_tenant_access(p_user_id,p_tenant_slug); return public.operations_calendar(p_user_id,p_tenant_slug,p_from,p_to,p_scope); end $$;
create or replace function public.operations_api_import_batch(p_user_id uuid,p_tenant_slug text,p_file_name text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_tenant_access(p_user_id,p_tenant_slug); return public.operations_import_batch(p_user_id,p_tenant_slug,p_file_name,p_rows); end $$;
create or replace function public.operations_api_upsert_team(p_user_id uuid,p_tenant_slug text,p_team_id uuid,p_name text,p_manager_user_id uuid,p_member_ids jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_tenant_access(p_user_id,p_tenant_slug); return public.operations_upsert_team(p_user_id,p_tenant_slug,p_team_id,p_name,p_manager_user_id,p_member_ids); end $$;
create or replace function public.operations_api_distribute(p_user_id uuid,p_batch_id uuid,p_team_id uuid,p_method text,p_due_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_api_user(p_user_id); return public.operations_distribute(p_user_id,p_batch_id,p_team_id,p_method,p_due_at); end $$;
create or replace function public.operations_api_create_task(p_user_id uuid,p_tenant_slug text,p_title text,p_description text,p_assigned_to uuid,p_starts_at timestamptz,p_due_at timestamptz,p_recurrence_type text,p_recurrence_interval integer,p_recurrence_end_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_tenant_access(p_user_id,p_tenant_slug); return public.operations_create_task(p_user_id,p_tenant_slug,p_title,p_description,p_assigned_to,p_starts_at,p_due_at,p_recurrence_type,p_recurrence_interval,p_recurrence_end_at); end $$;
create or replace function public.operations_api_complete_task(p_user_id uuid,p_task_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_api_user(p_user_id); return public.operations_complete_task(p_user_id,p_task_id); end $$;

create or replace function public.engagement_snapshot(p_user_id uuid,p_tenant_slug text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_subject uuid; v_tenant uuid; v_role text; v_employee uuid; v_can_manage boolean; v_result jsonb;
begin
 select platform.api_subject_id(p_user_id) into v_subject;
 select t.id into v_tenant from platform.tenants t where t.slug=p_tenant_slug limit 1;
 if v_subject is null or v_tenant is null then raise exception 'غير مصرح'; end if;
 select r.role_key into v_role from identity.memberships m join identity.roles r on r.id=m.role_id
 where m.subject_id=v_subject and m.status='active' and (m.tenant_id=v_tenant or (m.tenant_id is null and r.role_key in ('platform_owner','platform_admin')))
 order by case when m.tenant_id=v_tenant then 0 else 1 end limit 1;
 if v_role is null then raise exception 'لا توجد عضوية فعالة'; end if;
 select e.id into v_employee from crm.employees e where e.tenant_id=v_tenant and e.subject_id=v_subject limit 1;
 v_can_manage:=v_role in ('platform_owner','platform_admin','tenant_admin','admin','manager','sales_manager','sales_supervisor','hr_manager');
 select jsonb_build_object(
 'user',jsonb_build_object('subjectId',v_subject,'employeeId',v_employee,'role',v_role,'canManage',v_can_manage),
 'employees',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.full_name,'email',e.email,'managerId',e.manager_employee_id) order by e.full_name) from crm.employees e where e.tenant_id=v_tenant and e.employment_status='active'),'[]'::jsonb),
 'plans',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'periodStart',p.period_start,'periodEnd',p.period_end,'metricType',p.metric_type,'targetValue',p.target_value,'incentiveType',p.incentive_type,'incentiveValue',p.incentive_value,'tiers',p.tiers,'status',p.status) order by p.created_at desc) from engagement.incentive_plans p where p.tenant_id=v_tenant),'[]'::jsonb),
 'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'planId',a.plan_id,'employeeId',a.employee_id,'employeeName',e.full_name,'target',coalesce(a.target_override,p.target_value),'achieved',a.achieved_value,'expected',a.expected_incentive,'pending',a.pending_incentive,'payable',a.payable_incentive,'paid',a.paid_incentive)) from engagement.incentive_assignments a join engagement.incentive_plans p on p.id=a.plan_id join crm.employees e on e.id=a.employee_id where a.tenant_id=v_tenant and (v_can_manage or a.employee_id=v_employee)),'[]'::jsonb),
 'announcements',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'type',n.type,'priority',n.priority,'title',n.title,'body',n.body,'startsAt',n.starts_at,'endsAt',n.ends_at,'requiresAck',n.requires_ack,'isPinned',n.is_pinned,'status',n.status,'createdAt',n.created_at,'viewedAt',ar.viewed_at,'acknowledgedAt',ar.acknowledged_at) order by n.is_pinned desc,n.created_at desc) from engagement.announcements n left join engagement.announcement_reads ar on ar.announcement_id=n.id and ar.subject_id=v_subject where n.tenant_id=v_tenant and n.status in ('published','archived','scheduled')),'[]'::jsonb)
 ) into v_result;
 return v_result;
end $$;

create or replace function public.engagement_create_plan(p_user_id uuid,p_tenant_slug text,p_title text,p_period_start date,p_period_end date,p_metric_type text,p_target_value numeric,p_incentive_type text,p_incentive_value numeric,p_tiers jsonb,p_employee_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_subject uuid; v_tenant uuid; v_role text; v_plan uuid;
begin
 select platform.api_subject_id(p_user_id) into v_subject; select t.id into v_tenant from platform.tenants t where t.slug=p_tenant_slug limit 1;
 select r.role_key into v_role from identity.memberships m join identity.roles r on r.id=m.role_id where m.subject_id=v_subject and m.status='active' and (m.tenant_id=v_tenant or (m.tenant_id is null and r.role_key in ('platform_owner','platform_admin'))) order by case when m.tenant_id=v_tenant then 0 else 1 end limit 1;
 if coalesce(v_role,'') not in ('platform_owner','platform_admin','tenant_admin','admin','manager','sales_manager','sales_supervisor') then raise exception 'لا تملك صلاحية إدارة الحوافز'; end if;
 insert into engagement.incentive_plans(tenant_id,title,period_start,period_end,metric_type,target_value,incentive_type,incentive_value,tiers,created_by) values(v_tenant,p_title,p_period_start,p_period_end,p_metric_type,p_target_value,p_incentive_type,p_incentive_value,coalesce(p_tiers,'[]'::jsonb),v_subject) returning id into v_plan;
 insert into engagement.incentive_assignments(plan_id,tenant_id,employee_id) select v_plan,v_tenant,e.id from crm.employees e where e.tenant_id=v_tenant and e.id=any(p_employee_ids) on conflict do nothing;
 return jsonb_build_object('id',v_plan,'success',true);
end $$;
create or replace function public.engagement_create_announcement(p_user_id uuid,p_tenant_slug text,p_type text,p_priority text,p_title text,p_body text,p_starts_at timestamptz,p_ends_at timestamptz,p_requires_ack boolean,p_is_pinned boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_subject uuid; v_tenant uuid; v_role text; v_id uuid;
begin
 select platform.api_subject_id(p_user_id) into v_subject; select t.id into v_tenant from platform.tenants t where t.slug=p_tenant_slug limit 1;
 select r.role_key into v_role from identity.memberships m join identity.roles r on r.id=m.role_id where m.subject_id=v_subject and m.status='active' and (m.tenant_id=v_tenant or (m.tenant_id is null and r.role_key in ('platform_owner','platform_admin'))) order by case when m.tenant_id=v_tenant then 0 else 1 end limit 1;
 if coalesce(v_role,'') not in ('platform_owner','platform_admin','tenant_admin','admin','manager','hr_manager') then raise exception 'لا تملك صلاحية النشر الداخلي'; end if;
 insert into engagement.announcements(tenant_id,type,priority,title,body,starts_at,ends_at,requires_ack,is_pinned,status,created_by) values(v_tenant,p_type,p_priority,p_title,p_body,coalesce(p_starts_at,now()),p_ends_at,coalesce(p_requires_ack,false),coalesce(p_is_pinned,false),case when p_starts_at>now() then 'scheduled' else 'published' end,v_subject) returning id into v_id;
 return jsonb_build_object('id',v_id,'success',true);
end $$;
create or replace function public.engagement_api_snapshot(p_user_id uuid,p_tenant_slug text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_tenant_access(p_user_id,p_tenant_slug); return public.engagement_snapshot(p_user_id,p_tenant_slug); end $$;
create or replace function public.engagement_api_create_plan(p_user_id uuid,p_tenant_slug text,p_title text,p_period_start date,p_period_end date,p_metric_type text,p_target_value numeric,p_incentive_type text,p_incentive_value numeric,p_tiers jsonb,p_employee_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_tenant_access(p_user_id,p_tenant_slug); return public.engagement_create_plan(p_user_id,p_tenant_slug,p_title,p_period_start,p_period_end,p_metric_type,p_target_value,p_incentive_type,p_incentive_value,p_tiers,p_employee_ids); end $$;
create or replace function public.engagement_api_create_announcement(p_user_id uuid,p_tenant_slug text,p_type text,p_priority text,p_title text,p_body text,p_starts_at timestamptz,p_ends_at timestamptz,p_requires_ack boolean,p_is_pinned boolean)
returns jsonb language plpgsql security definer set search_path='' as $$ begin perform platform.assert_tenant_access(p_user_id,p_tenant_slug); return public.engagement_create_announcement(p_user_id,p_tenant_slug,p_type,p_priority,p_title,p_body,p_starts_at,p_ends_at,p_requires_ack,p_is_pinned); end $$;
create or replace function public.engagement_api_mark_read(p_user_id uuid,p_announcement_id uuid,p_acknowledge boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_slug text; begin select t.slug into v_slug from engagement.announcements a join platform.tenants t on t.id=a.tenant_id where a.id=p_announcement_id; perform platform.assert_tenant_access(p_user_id,v_slug); return public.engagement_mark_read(p_user_id,p_announcement_id,p_acknowledge); end $$;

create or replace function platform.is_platform_content_admin()
returns boolean language sql stable security definer set search_path='' as $$ select auth.uid() is not null and platform.is_platform_operator(auth.uid()) $$;
alter table public.knowledge_categories enable row level security;
alter table public.knowledge_posts enable row level security;
alter table public.knowledge_sources enable row level security;
drop policy if exists "platform admins manage knowledge categories" on public.knowledge_categories;
create policy "platform admins manage knowledge categories" on public.knowledge_categories for all to authenticated using(platform.is_platform_content_admin()) with check(platform.is_platform_content_admin());
drop policy if exists "platform admins manage knowledge posts" on public.knowledge_posts;
create policy "platform admins manage knowledge posts" on public.knowledge_posts for all to authenticated using(platform.is_platform_content_admin()) with check(platform.is_platform_content_admin());
drop policy if exists "platform admins manage knowledge sources" on public.knowledge_sources;
create policy "platform admins manage knowledge sources" on public.knowledge_sources for all to authenticated using(platform.is_platform_content_admin()) with check(platform.is_platform_content_admin());
revoke insert,update,delete,truncate on public.knowledge_categories,public.knowledge_posts,public.knowledge_sources from anon;
grant select on public.knowledge_categories,public.knowledge_posts to anon;
grant select,insert,update,delete on public.knowledge_categories,public.knowledge_posts,public.knowledge_sources to authenticated;

revoke all on function public.operations_api_heartbeat(uuid,text,text,text),public.operations_api_bootstrap(uuid,text,text,text),public.operations_api_calendar(uuid,text,timestamptz,timestamptz,text),public.operations_api_import_batch(uuid,text,text,jsonb),public.operations_api_upsert_team(uuid,text,uuid,text,uuid,jsonb),public.operations_api_distribute(uuid,uuid,uuid,text,timestamptz),public.operations_api_create_task(uuid,text,text,text,uuid,timestamptz,timestamptz,text,integer,timestamptz),public.operations_api_complete_task(uuid,uuid),public.engagement_api_snapshot(uuid,text),public.engagement_api_create_plan(uuid,text,text,date,date,text,numeric,text,numeric,jsonb,uuid[]),public.engagement_api_create_announcement(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean),public.engagement_api_mark_read(uuid,uuid,boolean) from public,anon;
grant execute on function public.operations_api_heartbeat(uuid,text,text,text),public.operations_api_bootstrap(uuid,text,text,text),public.operations_api_calendar(uuid,text,timestamptz,timestamptz,text),public.operations_api_import_batch(uuid,text,text,jsonb),public.operations_api_upsert_team(uuid,text,uuid,text,uuid,jsonb),public.operations_api_distribute(uuid,uuid,uuid,text,timestamptz),public.operations_api_create_task(uuid,text,text,text,uuid,timestamptz,timestamptz,text,integer,timestamptz),public.operations_api_complete_task(uuid,uuid),public.engagement_api_snapshot(uuid,text),public.engagement_api_create_plan(uuid,text,text,date,date,text,numeric,text,numeric,jsonb,uuid[]),public.engagement_api_create_announcement(uuid,text,text,text,text,text,timestamptz,timestamptz,boolean,boolean),public.engagement_api_mark_read(uuid,uuid,boolean) to authenticated;
