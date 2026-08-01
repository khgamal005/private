create table if not exists people.role_guide_progress (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  subject_id uuid not null references access_control.subjects(id) on delete cascade,
  guide_version text not null,
  status text not null default 'not_started'
    check (status in ('not_started','in_progress','completed','skipped','dismissed')),
  current_step integer not null default 0 check (current_step between 0 and 50),
  last_mode text not null default 'workspace'
    check (last_mode in ('workspace','page')),
  auto_open boolean not null default true,
  checklist_date date,
  checklist jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, subject_id, guide_version)
);

create index if not exists role_guide_progress_subject_idx
  on people.role_guide_progress(subject_id, tenant_id);
create index if not exists role_guide_progress_tenant_status_idx
  on people.role_guide_progress(tenant_id, status);

alter table people.role_guide_progress enable row level security;
revoke all on table people.role_guide_progress from public, anon, authenticated;
grant select, insert, update, delete on table people.role_guide_progress to service_role;

create or replace function public.v2_tenant_role_guide_snapshot(
  p_slug text,
  p_version text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_subject access_control.subjects%rowtype;
  v_progress people.role_guide_progress%rowtype;
  v_role_key text;
  v_today date;
begin
  if p_version is null
     or length(btrim(p_version)) < 1
     or length(btrim(p_version)) > 40 then
    raise exception 'invalid_guide_version';
  end if;

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.can_access_tenant(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  select subject.*
  into v_subject
  from access_control.subjects subject
  where subject.auth_user_id = auth.uid()
    and subject.status = 'active'
  limit 1;

  if v_subject.id is null then
    raise exception 'subject_not_found';
  end if;

  select role.role_key
  into v_role_key
  from access_control.memberships membership
  join access_control.membership_roles membership_role
    on membership_role.membership_id = membership.id
  join access_control.roles role
    on role.id = membership_role.role_id
   and role.scope = 'tenant'
  where membership.subject_id = v_subject.id
    and membership.tenant_id = v_tenant.id
    and membership.scope = 'tenant'
    and membership.status = 'active'
  order by
    case role.role_key
      when 'tenant_owner' then 1
      when 'tenant_admin' then 2
      when 'executive_manager' then 3
      when 'sales_manager' then 4
      when 'sales_supervisor' then 5
      else 10
    end,
    role.role_key
  limit 1;

  if v_role_key is null
     and private_app.has_platform_permission('platform.control.read') then
    v_role_key := 'platform_owner';
  end if;

  v_role_key := coalesce(v_role_key, 'member');
  v_today := (
    now() at time zone coalesce(v_tenant.timezone, 'Asia/Riyadh')
  )::date;

  select progress.*
  into v_progress
  from people.role_guide_progress progress
  where progress.tenant_id = v_tenant.id
    and progress.subject_id = v_subject.id
    and progress.guide_version = btrim(p_version)
  limit 1;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'subjectId', v_subject.id,
      'name', v_subject.full_name,
      'email', v_subject.email,
      'roleKey', v_role_key
    ),
    'progress', jsonb_build_object(
      'status', coalesce(v_progress.status, 'not_started'),
      'currentStep', coalesce(v_progress.current_step, 0),
      'lastMode', coalesce(v_progress.last_mode, 'workspace'),
      'autoOpen', coalesce(v_progress.auto_open, true),
      'checklistDate', v_today,
      'checklist', case
        when v_progress.checklist_date = v_today
          then coalesce(v_progress.checklist, '{}'::jsonb)
        else '{}'::jsonb
      end,
      'startedAt', v_progress.started_at,
      'completedAt', v_progress.completed_at,
      'lastOpenedAt', v_progress.last_opened_at
    )
  );
end;
$function$;

create or replace function public.v2_tenant_role_guide_action(
  p_slug text,
  p_action text,
  p_payload jsonb,
  p_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_subject access_control.subjects%rowtype;
  v_progress people.role_guide_progress%rowtype;
  v_today date;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_version text := btrim(coalesce(p_version, ''));
  v_step integer;
  v_mode text;
  v_item_id text;
  v_checked boolean;
begin
  if length(v_version) < 1 or length(v_version) > 40 then
    raise exception 'invalid_guide_version';
  end if;

  if v_action not in (
    'open','start','progress','complete','skip','dismiss','reset','checklist'
  ) then
    raise exception 'invalid_role_guide_action';
  end if;

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.can_access_tenant(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  select subject.*
  into v_subject
  from access_control.subjects subject
  where subject.auth_user_id = auth.uid()
    and subject.status = 'active'
  limit 1;

  if v_subject.id is null then
    raise exception 'subject_not_found';
  end if;

  v_today := (
    now() at time zone coalesce(v_tenant.timezone, 'Asia/Riyadh')
  )::date;

  insert into people.role_guide_progress (
    tenant_id,
    subject_id,
    guide_version,
    checklist_date,
    last_opened_at
  ) values (
    v_tenant.id,
    v_subject.id,
    v_version,
    v_today,
    now()
  )
  on conflict (tenant_id, subject_id, guide_version) do nothing;

  select progress.*
  into v_progress
  from people.role_guide_progress progress
  where progress.tenant_id = v_tenant.id
    and progress.subject_id = v_subject.id
    and progress.guide_version = v_version
  for update;

  v_step := case
    when coalesce(p_payload ->> 'currentStep', '') ~ '^\d{1,2}$'
      then least(50, greatest(0, (p_payload ->> 'currentStep')::integer))
    else v_progress.current_step
  end;
  v_mode := case
    when p_payload ->> 'mode' in ('workspace','page')
      then p_payload ->> 'mode'
    else v_progress.last_mode
  end;

  if v_action = 'open' then
    update people.role_guide_progress
    set last_opened_at = now(),
        checklist = case
          when checklist_date = v_today then checklist
          else '{}'::jsonb
        end,
        checklist_date = v_today,
        updated_at = now()
    where id = v_progress.id;

  elsif v_action = 'start' then
    update people.role_guide_progress
    set status = 'in_progress',
        current_step = v_step,
        last_mode = v_mode,
        auto_open = true,
        started_at = coalesce(started_at, now()),
        completed_at = null,
        last_opened_at = now(),
        updated_at = now()
    where id = v_progress.id;

  elsif v_action = 'progress' then
    update people.role_guide_progress
    set status = 'in_progress',
        current_step = v_step,
        last_mode = v_mode,
        started_at = coalesce(started_at, now()),
        last_opened_at = now(),
        updated_at = now()
    where id = v_progress.id;

  elsif v_action = 'complete' then
    update people.role_guide_progress
    set status = 'completed',
        current_step = v_step,
        last_mode = v_mode,
        auto_open = false,
        started_at = coalesce(started_at, now()),
        completed_at = now(),
        last_opened_at = now(),
        updated_at = now()
    where id = v_progress.id;

  elsif v_action = 'skip' then
    update people.role_guide_progress
    set status = 'skipped',
        current_step = v_step,
        last_mode = v_mode,
        auto_open = true,
        last_opened_at = now(),
        updated_at = now()
    where id = v_progress.id;

  elsif v_action = 'dismiss' then
    update people.role_guide_progress
    set status = 'dismissed',
        auto_open = false,
        last_opened_at = now(),
        updated_at = now()
    where id = v_progress.id;

  elsif v_action = 'reset' then
    update people.role_guide_progress
    set status = 'not_started',
        current_step = 0,
        last_mode = 'workspace',
        auto_open = true,
        checklist_date = v_today,
        checklist = '{}'::jsonb,
        started_at = null,
        completed_at = null,
        last_opened_at = now(),
        updated_at = now()
    where id = v_progress.id;

  elsif v_action = 'checklist' then
    v_item_id := lower(btrim(coalesce(p_payload ->> 'itemId', '')));
    if v_item_id !~ '^[a-z0-9_-]{1,64}$' then
      raise exception 'invalid_checklist_item';
    end if;
    v_checked := coalesce((p_payload ->> 'checked')::boolean, false);

    update people.role_guide_progress
    set checklist = jsonb_set(
          case when checklist_date = v_today
            then coalesce(checklist, '{}'::jsonb)
            else '{}'::jsonb
          end,
          array[v_item_id],
          to_jsonb(v_checked),
          true
        ),
        checklist_date = v_today,
        last_opened_at = now(),
        updated_at = now()
    where id = v_progress.id;
  end if;

  return public.v2_tenant_role_guide_snapshot(p_slug, v_version);
end;
$function$;

revoke all on function public.v2_tenant_role_guide_snapshot(text,text)
  from public, anon;
revoke all on function public.v2_tenant_role_guide_action(text,text,jsonb,text)
  from public, anon;
grant execute on function public.v2_tenant_role_guide_snapshot(text,text)
  to authenticated, service_role;
grant execute on function public.v2_tenant_role_guide_action(text,text,jsonb,text)
  to authenticated, service_role;

comment on table people.role_guide_progress is
  'Per-user, per-tenant progress for the interactive My Role guide.';
comment on function public.v2_tenant_role_guide_snapshot(text,text) is
  'Returns the authenticated user role-guide progress for one tenant.';
comment on function public.v2_tenant_role_guide_action(text,text,jsonb,text) is
  'Persists role-guide tours, daily checklist, skip, dismiss, and completion states.';
