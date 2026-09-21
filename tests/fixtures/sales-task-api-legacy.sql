-- Function-only baseline captured read-only from ODEIR on 2026-09-21.
-- No production records. The governance migration replaces underlying mutations.
CREATE OR REPLACE FUNCTION public.v2_tenant_create_task(p_tenant_slug text, p_title text, p_description text DEFAULT NULL::text, p_assigned_staff_id uuid DEFAULT NULL::uuid, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_priority text DEFAULT 'normal'::text, p_opportunity_id uuid DEFAULT NULL::uuid, p_contact_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_task_id uuid;
  v_current_staff_id uuid;
  v_assigned_staff_id uuid;
  v_view_team boolean;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.work.write'
  ) then raise exception 'forbidden'; end if;
  if p_title is null or length(trim(p_title)) < 2 then
    raise exception 'title_required';
  end if;
  if p_due_at is null then raise exception 'due_at_required'; end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'invalid_priority';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  v_assigned_staff_id := coalesce(p_assigned_staff_id, v_current_staff_id);
  if not v_view_team then
    if v_current_staff_id is null then raise exception 'staff_account_not_linked'; end if;
    v_assigned_staff_id := v_current_staff_id;
  end if;
  if v_assigned_staff_id is not null and not exists (
    select 1 from people.staff_profiles sp
    where sp.id = v_assigned_staff_id
      and sp.tenant_id = v_tenant_id
      and sp.employment_status = 'active'
  ) then raise exception 'invalid_assignee'; end if;
  if p_opportunity_id is not null and not exists (
    select 1 from sales_core.opportunities o
    where o.id = p_opportunity_id
      and o.tenant_id = v_tenant_id
  ) then raise exception 'invalid_opportunity'; end if;
  if p_contact_id is not null and not exists (
    select 1 from sales_core.contacts c
    where c.id = p_contact_id
      and c.tenant_id = v_tenant_id
  ) then raise exception 'invalid_contact'; end if;

  insert into work_core.tasks (
    tenant_id,
    title,
    description,
    priority,
    assigned_staff_id,
    created_by_subject_id,
    opportunity_id,
    contact_id,
    due_at
  )
  values (
    v_tenant_id,
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    p_priority,
    v_assigned_staff_id,
    private_app.current_subject_id(),
    p_opportunity_id,
    p_contact_id,
    p_due_at
  )
  returning id into v_task_id;

  perform private_app.write_audit(
    'tenant.work_task_created',
    'work_task',
    v_task_id::text,
    v_tenant_id,
    jsonb_build_object('title', trim(p_title))
  );

  return jsonb_build_object('id', v_task_id, 'title', trim(p_title));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v3_tenant_update_task_status(p_tenant_slug text, p_task_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_task work_core.tasks%rowtype;
begin
  v_result := public.v2_tenant_update_task_status(
    p_tenant_slug,
    p_task_id,
    p_status
  );

  select task.*
  into v_task
  from work_core.tasks task
  join core.tenants tenant
    on tenant.id = task.tenant_id
  where tenant.slug = p_tenant_slug
    and task.id = p_task_id
  limit 1;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'completionTiming', v_task.completion_timing,
    'completedAt', v_task.completed_at
  ));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v4_tenant_transition_task(p_tenant_slug text, p_task_id uuid, p_status text DEFAULT NULL::text, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_task work_core.tasks%rowtype;
begin
  v_result := public.v3_tenant_transition_task(
    p_tenant_slug,
    p_task_id,
    p_status,
    p_due_at,
    p_note
  );

  select task.*
  into v_task
  from work_core.tasks task
  join core.tenants tenant
    on tenant.id = task.tenant_id
  where tenant.slug = p_tenant_slug
    and task.id = p_task_id
  limit 1;

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'completionTiming', v_task.completion_timing,
    'completedAt', v_task.completed_at
  ));
end;
$function$
;
