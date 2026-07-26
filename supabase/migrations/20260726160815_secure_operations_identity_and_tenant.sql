-- Security foundation: bind Operations calls to the authenticated Supabase user,
-- enforce tenant membership, and stop deriving authorization from user-editable metadata.

create or replace function operations.ensure_user(
  p_user_id uuid,
  p_email text default null,
  p_name text default null,
  p_tenant_slug text default null
)
returns operations.users
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user operations.users;
  v_auth auth.users%rowtype;
  v_session_user_id uuid;
  v_subject_id uuid;
  v_tenant uuid;
  v_role text := 'member';
  v_membership_role text;
  v_employee crm.employees%rowtype;
  v_job_role record;
  v_manager_auth uuid;
  v_email text;
begin
  v_session_user_id := auth.uid();

  if v_session_user_id is null
     or p_user_id is null
     or p_user_id is distinct from v_session_user_id then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  select *
    into v_auth
  from auth.users
  where id = v_session_user_id;

  if v_auth.id is null then
    raise exception 'auth_user_not_found'
      using errcode = '42501';
  end if;

  select identity.current_subject_id()
    into v_subject_id;

  if v_subject_id is null then
    raise exception 'identity_not_provisioned'
      using errcode = '42501';
  end if;

  v_email := lower(coalesce(v_auth.email, ''));

  if nullif(btrim(coalesce(p_tenant_slug, '')), '') is not null then
    v_tenant := operations.resolve_tenant_id(p_tenant_slug);

    if v_tenant is null then
      raise exception 'tenant_not_found'
        using errcode = 'P0002';
    end if;
  else
    select u.tenant_id
      into v_tenant
    from operations.users u
    where u.user_id = v_session_user_id;
  end if;

  if v_tenant is not null
     and not identity.has_platform_access()
     and not exists (
       select 1
       from identity.memberships m
       where m.subject_id = v_subject_id
         and m.tenant_id = v_tenant
         and m.status = 'active'
         and (m.starts_at is null or m.starts_at <= now())
         and (m.ends_at is null or m.ends_at > now())
     ) then
    raise exception 'tenant_forbidden'
      using errcode = '42501';
  end if;

  if identity.has_platform_access() then
    v_role := 'admin';
  elsif v_tenant is not null then
    select r.role_key
      into v_membership_role
    from identity.memberships m
    join identity.roles r on r.id = m.role_id
    where m.subject_id = v_subject_id
      and m.tenant_id = v_tenant
      and m.status = 'active'
      and (m.starts_at is null or m.starts_at <= now())
      and (m.ends_at is null or m.ends_at > now())
    order by
      case r.role_key
        when 'tenant_owner' then 1
        when 'tenant_admin' then 2
        else 3
      end,
      m.created_at
    limit 1;

    v_role := operations.normalize_role(coalesce(v_membership_role, ''));
  end if;

  if v_tenant is not null and v_email <> '' then
    select e.*
      into v_employee
    from crm.employees e
    where e.tenant_id = v_tenant
      and e.employment_status = 'active'
      and lower(coalesce(e.email::text, '')) = v_email
    order by e.updated_at desc
    limit 1;
  end if;

  if v_employee.id is not null then
    select role_key, name_ar, name_en
      into v_job_role
    from crm.job_roles
    where id = v_employee.job_role_id;

    if v_role <> 'admin' then
      v_role := operations.normalize_role(
        coalesce(v_job_role.role_key, v_job_role.name_ar, v_job_role.name_en, '')
      );
    end if;

    if v_employee.manager_employee_id is not null then
      select u.id
        into v_manager_auth
      from crm.employees m
      join auth.users u
        on lower(coalesce(u.email, '')) = lower(coalesce(m.email::text, ''))
      where m.id = v_employee.manager_employee_id
      limit 1;
    end if;
  end if;

  insert into operations.users (
    user_id,
    tenant_id,
    employee_id,
    email,
    display_name,
    role_code,
    manager_user_id,
    last_seen_at
  )
  values (
    v_session_user_id,
    v_tenant,
    v_employee.id,
    nullif(v_email, ''),
    coalesce(
      v_employee.full_name,
      nullif(btrim(v_auth.raw_user_meta_data ->> 'name'), ''),
      nullif(btrim(v_auth.raw_user_meta_data ->> 'full_name'), ''),
      split_part(v_email, '@', 1)
    ),
    v_role,
    v_manager_auth,
    now()
  )
  on conflict (user_id) do update
  set tenant_id = coalesce(excluded.tenant_id, operations.users.tenant_id),
      employee_id = excluded.employee_id,
      email = excluded.email,
      display_name = excluded.display_name,
      role_code = excluded.role_code,
      manager_user_id = excluded.manager_user_id,
      last_seen_at = now(),
      updated_at = now()
  returning * into v_user;

  return v_user;
end
$function$;

create or replace function operations.assert_tenant_access(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_subject_id uuid;
begin
  if auth.uid() is null then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  if p_tenant_id is null then
    raise exception 'tenant_required'
      using errcode = '42501';
  end if;

  if identity.has_platform_access() then
    return;
  end if;

  v_subject_id := identity.current_subject_id();

  if v_subject_id is null
     or not exists (
       select 1
       from identity.memberships m
       where m.subject_id = v_subject_id
         and m.tenant_id = p_tenant_id
         and m.status = 'active'
         and (m.starts_at is null or m.starts_at <= now())
         and (m.ends_at is null or m.ends_at > now())
     ) then
    raise exception 'tenant_forbidden'
      using errcode = '42501';
  end if;
end
$function$;

create or replace function public.operations_complete_task(
  p_user_id uuid,
  p_task_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user operations.users;
  v_task operations.tasks;
begin
  v_user := operations.ensure_user(p_user_id, null, null, null);

  select *
    into v_task
  from operations.tasks
  where id = p_task_id;

  if v_task.id is null then
    raise exception 'task_not_found'
      using errcode = 'P0002';
  end if;

  perform operations.assert_tenant_access(v_task.tenant_id);

  if v_task.assigned_to <> p_user_id
     and v_user.role_code not in ('admin', 'sales_manager', 'manager') then
    raise exception 'task_not_allowed'
      using errcode = '42501';
  end if;

  if not identity.has_platform_access()
     and v_task.tenant_id is distinct from v_user.tenant_id then
    raise exception 'task_outside_tenant'
      using errcode = '42501';
  end if;

  update operations.tasks
  set status = 'completed',
      completed_at = now(),
      completion_timing = case when now() <= due_at then 'on_time' else 'late' end,
      updated_at = now()
  where id = p_task_id;

  if v_task.lead_id is not null then
    update operations.import_leads
    set status = 'completed',
        updated_at = now()
    where id = v_task.lead_id
      and tenant_id is not distinct from v_task.tenant_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'completion_timing', case when now() <= v_task.due_at then 'on_time' else 'late' end,
    'completed_at', now()
  );
end
$function$;

create or replace function public.operations_upsert_team(
  p_user_id uuid,
  p_tenant_slug text,
  p_team_id uuid,
  p_name text,
  p_manager_user_id uuid,
  p_member_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user operations.users;
  v_team operations.sales_teams;
  v_team_id uuid;
  v_manager_id uuid;
  v_manager operations.users;
  v_member text;
  v_member_user operations.users;
begin
  v_user := operations.ensure_user(p_user_id, null, null, p_tenant_slug);

  if v_user.role_code not in ('admin', 'sales_manager') then
    raise exception 'role_not_allowed'
      using errcode = '42501';
  end if;

  perform operations.assert_tenant_access(v_user.tenant_id);
  v_manager_id := coalesce(p_manager_user_id, p_user_id);

  select *
    into v_manager
  from operations.users
  where user_id = v_manager_id
    and is_active;

  if v_manager.user_id is null
     or v_manager.tenant_id is distinct from v_user.tenant_id then
    raise exception 'manager_outside_tenant'
      using errcode = '42501';
  end if;

  if p_team_id is null then
    insert into operations.sales_teams (
      tenant_id,
      name,
      manager_user_id,
      created_by
    )
    values (
      v_user.tenant_id,
      p_name,
      v_manager_id,
      p_user_id
    )
    returning * into v_team;
  else
    select *
      into v_team
    from operations.sales_teams
    where id = p_team_id
      and is_active;

    if v_team.id is null then
      raise exception 'team_not_found'
        using errcode = 'P0002';
    end if;

    perform operations.assert_tenant_access(v_team.tenant_id);

    if v_team.tenant_id is distinct from v_user.tenant_id
       or (v_user.role_code <> 'admin' and v_team.manager_user_id <> p_user_id) then
      raise exception 'team_not_allowed'
        using errcode = '42501';
    end if;

    update operations.sales_teams
    set name = coalesce(nullif(p_name, ''), name),
        manager_user_id = v_manager_id,
        updated_at = now()
    where id = p_team_id
    returning * into v_team;
  end if;

  v_team_id := v_team.id;

  delete from operations.team_members
  where team_id = v_team_id;

  if jsonb_typeof(p_member_ids) = 'array' then
    for v_member in
      select jsonb_array_elements_text(p_member_ids)
    loop
      select *
        into v_member_user
      from operations.users
      where user_id = v_member::uuid
        and is_active;

      if v_member_user.user_id is null
         or v_member_user.tenant_id is distinct from v_team.tenant_id then
        raise exception 'member_outside_tenant'
          using errcode = '42501';
      end if;

      insert into operations.team_members (team_id, user_id)
      values (v_team_id, v_member_user.user_id)
      on conflict do nothing;

      update operations.users
      set manager_user_id = v_manager_id,
          role_code = case when role_code = 'member' then 'sales_agent' else role_code end,
          updated_at = now()
      where user_id = v_member_user.user_id
        and tenant_id is not distinct from v_team.tenant_id;
    end loop;
  end if;

  return jsonb_build_object('success', true, 'team_id', v_team_id);
end
$function$;

create or replace function public.operations_distribute(
  p_user_id uuid,
  p_batch_id uuid,
  p_team_id uuid,
  p_method text,
  p_due_at timestamp with time zone
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user operations.users;
  v_team operations.sales_teams;
  v_candidates uuid[];
  v_count int;
  v_idx int := 0;
  v_assigned int := 0;
  v_target uuid;
  v_target_user operations.users;
  v_task uuid;
  v_crm_task uuid;
  v_contact uuid;
  v_manager_employee uuid;
  r operations.import_leads;
  v_run uuid;
  v_contact_key text;
  v_task_key text;
begin
  v_user := operations.ensure_user(p_user_id, null, null, null);

  if v_user.role_code not in ('admin', 'sales_manager') then
    raise exception 'role_not_allowed'
      using errcode = '42501';
  end if;

  if p_method not in ('fair', 'online_only') then
    raise exception 'invalid_method';
  end if;

  if p_due_at is null or p_due_at <= now() then
    raise exception 'future_due_date_required';
  end if;

  select *
    into v_team
  from operations.sales_teams
  where id = p_team_id
    and is_active;

  if v_team.id is null then
    raise exception 'team_not_found'
      using errcode = 'P0002';
  end if;

  perform operations.assert_tenant_access(v_team.tenant_id);

  if v_team.tenant_id is distinct from v_user.tenant_id
     or (v_user.role_code <> 'admin' and v_team.manager_user_id <> p_user_id) then
    raise exception 'team_not_allowed'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from operations.import_batches b
    where b.id = p_batch_id
      and b.tenant_id is not distinct from v_team.tenant_id
      and b.status in ('ready', 'partially_distributed')
  ) then
    raise exception 'batch_not_ready';
  end if;

  select array_agg(
           x.user_id
           order by x.active_assignments, x.last_assigned_at nulls first, x.user_id
         )
    into v_candidates
  from (
    select
      tm.user_id,
      tm.last_assigned_at,
      (
        select count(*)
        from operations.tasks ot
        where ot.assigned_to = tm.user_id
          and ot.tenant_id is not distinct from v_team.tenant_id
          and ot.status in ('open', 'in_progress')
      ) as active_assignments
    from operations.team_members tm
    join operations.users u on u.user_id = tm.user_id
    where tm.team_id = p_team_id
      and tm.is_active
      and u.is_active
      and u.tenant_id is not distinct from v_team.tenant_id
      and (p_method = 'fair' or u.last_seen_at > now() - interval '5 minutes')
  ) x;

  v_count := coalesce(array_length(v_candidates, 1), 0);

  if v_count = 0 then
    raise exception 'no_available_team_members';
  end if;

  insert into operations.distribution_runs (
    batch_id,
    team_id,
    manager_user_id,
    method,
    due_at,
    candidates_count
  )
  values (
    p_batch_id,
    p_team_id,
    p_user_id,
    p_method,
    p_due_at,
    v_count
  )
  returning id into v_run;

  v_manager_employee := v_user.employee_id;

  for r in
    select *
    from operations.import_leads
    where batch_id = p_batch_id
      and tenant_id is not distinct from v_team.tenant_id
      and status = 'unassigned'
    order by created_at, id
    for update skip locked
  loop
    v_idx := v_idx + 1;
    v_target := v_candidates[((v_idx - 1) % v_count) + 1];

    select *
      into v_target_user
    from operations.users
    where user_id = v_target
      and tenant_id is not distinct from v_team.tenant_id
      and is_active;

    if v_target_user.user_id is null then
      raise exception 'assignee_outside_tenant'
        using errcode = '42501';
    end if;

    v_contact := null;

    select id
      into v_contact
    from crm.contacts
    where tenant_id = r.tenant_id
      and regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') = r.phone_normalized
    order by updated_at desc
    limit 1;

    if v_contact is null then
      v_contact_key := 'con_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 24);

      insert into crm.contacts (
        contact_key,
        tenant_id,
        full_name,
        phone,
        source,
        owner_employee_id,
        status,
        metadata
      )
      values (
        v_contact_key,
        r.tenant_id,
        r.customer_name,
        r.phone,
        'import',
        v_target_user.employee_id,
        'lead',
        jsonb_build_object(
          'importLeadId', r.id,
          'batchId', r.batch_id,
          'program', r.program_name,
          'adName', r.ad_name
        )
      )
      returning id into v_contact;
    else
      update crm.contacts
      set owner_employee_id = coalesce(v_target_user.employee_id, owner_employee_id),
          updated_at = now(),
          metadata = metadata || jsonb_build_object(
            'lastImportLeadId', r.id,
            'program', r.program_name,
            'adName', r.ad_name
          )
      where id = v_contact
        and tenant_id is not distinct from v_team.tenant_id;
    end if;

    v_crm_task := null;

    if v_target_user.employee_id is not null then
      v_task_key := 'tsk_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 24);

      insert into crm.tasks (
        task_key,
        tenant_id,
        title,
        description,
        task_type,
        priority,
        status,
        assigned_to_employee_id,
        assigned_by_employee_id,
        contact_id,
        due_at,
        metadata
      )
      values (
        v_task_key,
        r.tenant_id,
        'متابعة العميل: ' || r.customer_name,
        concat_ws(' — ', nullif(r.program_name, ''), nullif(r.ad_name, '')),
        'follow_up',
        'high',
        'open',
        v_target_user.employee_id,
        v_manager_employee,
        v_contact,
        p_due_at,
        jsonb_build_object(
          'source', 'operations_distribution',
          'distributionRunId', v_run,
          'importLeadId', r.id
        )
      )
      returning id into v_crm_task;
    end if;

    insert into operations.tasks (
      tenant_id,
      title,
      description,
      task_type,
      assigned_to,
      assigned_by,
      team_id,
      lead_id,
      starts_at,
      due_at,
      source_system,
      source_task_id,
      metadata
    )
    values (
      r.tenant_id,
      'متابعة العميل: ' || r.customer_name,
      concat_ws(' — ', nullif(r.program_name, ''), nullif(r.ad_name, '')),
      'lead_followup',
      v_target,
      p_user_id,
      p_team_id,
      r.id,
      now(),
      p_due_at,
      case when v_crm_task is null then 'operations' else 'crm' end,
      case when v_crm_task is null then null else v_crm_task::text end,
      jsonb_build_object(
        'distribution_run_id', v_run,
        'contact_id', v_contact,
        'crm_task_id', v_crm_task
      )
    )
    returning id into v_task;

    update operations.import_leads
    set status = 'assigned',
        assigned_to = v_target,
        assigned_at = now(),
        task_id = v_task,
        contact_id = v_contact,
        crm_task_id = v_crm_task,
        updated_at = now()
    where id = r.id
      and tenant_id is not distinct from v_team.tenant_id;

    update operations.team_members
    set last_assigned_at = now()
    where team_id = p_team_id
      and user_id = v_target;

    v_assigned := v_assigned + 1;
  end loop;

  update operations.import_batches
  set assigned_rows = assigned_rows + v_assigned,
      status = case
        when exists (
          select 1
          from operations.import_leads
          where batch_id = p_batch_id
            and tenant_id is not distinct from v_team.tenant_id
            and status = 'unassigned'
        ) then 'partially_distributed'
        else 'distributed'
      end,
      updated_at = now()
  where id = p_batch_id
    and tenant_id is not distinct from v_team.tenant_id;

  update operations.distribution_runs
  set assigned_count = v_assigned,
      details = jsonb_build_object(
        'candidate_user_ids', to_jsonb(v_candidates),
        'crmIntegrated', true
      )
  where id = v_run;

  return jsonb_build_object(
    'success', true,
    'run_id', v_run,
    'assigned_count', v_assigned,
    'candidates_count', v_count,
    'method', p_method,
    'due_at', p_due_at,
    'crm_integrated', true
  );
end
$function$;

revoke execute on function operations.assert_tenant_access(uuid)
  from public, anon, authenticated, service_role;

revoke execute on function operations.ensure_user(uuid, text, text, text)
  from public, anon, authenticated, service_role;

revoke execute on function operations.resolve_tenant_id(text)
  from public, anon, authenticated;

revoke execute on function public.operations_bootstrap(uuid, text, text, text)
  from public, anon;
grant execute on function public.operations_bootstrap(uuid, text, text, text)
  to authenticated;

revoke execute on function public.operations_calendar(
  uuid, text, timestamp with time zone, timestamp with time zone, text
) from public, anon;
grant execute on function public.operations_calendar(
  uuid, text, timestamp with time zone, timestamp with time zone, text
) to authenticated;

revoke execute on function public.operations_heartbeat(uuid, text, text, text)
  from public, anon;
grant execute on function public.operations_heartbeat(uuid, text, text, text)
  to authenticated;

revoke execute on function public.operations_upsert_team(
  uuid, text, uuid, text, uuid, jsonb
) from public, anon;
grant execute on function public.operations_upsert_team(
  uuid, text, uuid, text, uuid, jsonb
) to authenticated;

revoke execute on function public.operations_import_batch(uuid, text, text, jsonb)
  from public, anon;
grant execute on function public.operations_import_batch(uuid, text, text, jsonb)
  to authenticated;

revoke execute on function public.operations_distribute(
  uuid, uuid, uuid, text, timestamp with time zone
) from public, anon;
grant execute on function public.operations_distribute(
  uuid, uuid, uuid, text, timestamp with time zone
) to authenticated;

revoke execute on function public.operations_create_task(
  uuid, text, text, text, uuid, timestamp with time zone,
  timestamp with time zone, text, integer, timestamp with time zone
) from public, anon;
grant execute on function public.operations_create_task(
  uuid, text, text, text, uuid, timestamp with time zone,
  timestamp with time zone, text, integer, timestamp with time zone
) to authenticated;

revoke execute on function public.operations_complete_task(uuid, uuid)
  from public, anon;
grant execute on function public.operations_complete_task(uuid, uuid)
  to authenticated;
