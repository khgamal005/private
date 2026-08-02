-- Safe tenant role management actions.
-- No existing role or employee data is removed by this migration.

create or replace function public.v2_tenant_role_management_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_role_key text;
  v_name_ar text;
  v_name_en text;
  v_permissions text[];
  v_system_role_id uuid;
  v_tenant_role_id uuid;
  v_effective_role_id uuid;
  v_actor_membership_id uuid;
  v_custom_key text;
  v_result jsonb;
begin
  p_action := lower(trim(coalesce(p_action, '')));

  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.users.manage'
  ) then
    raise exception 'forbidden';
  end if;

  v_role_key := nullif(trim(v_payload ->> 'roleKey'), '');
  v_name_ar := trim(coalesce(v_payload ->> 'nameAr', ''));
  v_name_en := nullif(trim(coalesce(v_payload ->> 'nameEn', '')), '');

  if p_action in ('create_role', 'update_role') then
    if length(v_name_ar) < 2 then
      raise exception 'invalid_role_name';
    end if;

    if jsonb_typeof(v_payload -> 'permissions') <> 'array' then
      raise exception 'invalid_permissions';
    end if;

    select coalesce(
      array_agg(item.permission_key order by item.permission_key),
      array[]::text[]
    )
    into v_permissions
    from (
      select distinct permission_key
      from jsonb_array_elements_text(
        v_payload -> 'permissions'
      ) as submitted(permission_key)
    ) item;

    if exists (
      select 1
      from unnest(v_permissions) submitted(permission_key)
      left join access_control.permissions permission
        on permission.permission_key = submitted.permission_key
       and permission.permission_key like 'tenant.%'
      where permission.permission_key is null
    ) then
      raise exception 'invalid_permissions';
    end if;

    if not ('tenant.workspace.read' = any(v_permissions)) then
      v_permissions := array_append(
        v_permissions,
        'tenant.workspace.read'
      );
    end if;

    if 'tenant.crm.write' = any(v_permissions)
       and not ('tenant.crm.read' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.crm.read');
    end if;

    if (
      'tenant.leads.read' = any(v_permissions)
      or 'tenant.leads.import' = any(v_permissions)
      or 'tenant.leads.distribute' = any(v_permissions)
      or 'tenant.leads.analytics' = any(v_permissions)
    ) and not ('tenant.crm.read' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.crm.read');
    end if;

    if (
      'tenant.leads.import' = any(v_permissions)
      or 'tenant.leads.distribute' = any(v_permissions)
      or 'tenant.leads.analytics' = any(v_permissions)
    ) and not ('tenant.leads.read' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.leads.read');
    end if;

    if 'tenant.work.write' = any(v_permissions)
       and not ('tenant.work.read' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.work.read');
    end if;

    if 'tenant.academy.write' = any(v_permissions)
       and not ('tenant.academy.read' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.academy.read');
    end if;

    if 'tenant.admissions.write' = any(v_permissions)
       and not ('tenant.admissions.read' = any(v_permissions)) then
      v_permissions := array_append(
        v_permissions,
        'tenant.admissions.read'
      );
    end if;

    if 'tenant.training.write' = any(v_permissions)
       and not ('tenant.training.read' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.training.read');
    end if;

    if 'tenant.incentives.write' = any(v_permissions)
       and not ('tenant.incentives.read' = any(v_permissions)) then
      v_permissions := array_append(
        v_permissions,
        'tenant.incentives.read'
      );
    end if;

    if 'tenant.people.manage' = any(v_permissions)
       and not ('tenant.people.read' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.people.read');
    end if;

    if 'tenant.users.reset_password' = any(v_permissions)
       and not ('tenant.users.manage' = any(v_permissions)) then
      v_permissions := array_append(v_permissions, 'tenant.users.manage');
    end if;

    select coalesce(
      array_agg(item.permission_key order by item.permission_key),
      array[]::text[]
    )
    into v_permissions
    from (
      select distinct permission_key
      from unnest(v_permissions) submitted(permission_key)
    ) item;

    if exists (
      select 1
      from access_control.roles role
      where role.scope = 'tenant'
        and (role.tenant_id is null or role.tenant_id = v_tenant_id)
        and role.role_key <> coalesce(v_role_key, '')
        and lower(role.name_ar) = lower(v_name_ar)
    ) then
      raise exception 'role_name_exists';
    end if;
  end if;

  if p_action = 'create_role' then
    loop
      v_custom_key := 'custom_' || substr(
        md5(
          v_tenant_id::text
          || v_name_ar
          || clock_timestamp()::text
          || random()::text
        ),
        1,
        16
      );

      exit when not exists (
        select 1
        from access_control.roles role
        where role.tenant_id = v_tenant_id
          and role.role_key = v_custom_key
      );
    end loop;

    insert into access_control.roles (
      tenant_id,
      role_key,
      name_ar,
      name_en,
      scope,
      is_system
    )
    values (
      v_tenant_id,
      v_custom_key,
      v_name_ar,
      v_name_en,
      'tenant',
      false
    )
    returning id into v_tenant_role_id;

    insert into access_control.role_permissions (
      role_id,
      permission_key
    )
    select v_tenant_role_id, permission_key
    from unnest(v_permissions) selected(permission_key)
    on conflict do nothing;

    perform private_app.write_audit(
      'tenant.role.created',
      'tenant_role',
      v_custom_key,
      v_tenant_id,
      jsonb_build_object(
        'nameAr', v_name_ar,
        'permissionCount', cardinality(v_permissions)
      )
    );

    v_role_key := v_custom_key;

  elsif p_action = 'update_role' then
    if v_role_key is null then
      raise exception 'role_not_found';
    end if;

    select role.id
    into v_system_role_id
    from access_control.roles role
    where role.scope = 'tenant'
      and role.tenant_id is null
      and role.role_key = v_role_key
    limit 1;

    select role.id
    into v_tenant_role_id
    from access_control.roles role
    where role.scope = 'tenant'
      and role.tenant_id = v_tenant_id
      and role.role_key = v_role_key
    limit 1;

    v_effective_role_id := coalesce(
      v_tenant_role_id,
      v_system_role_id
    );

    if v_effective_role_id is null then
      raise exception 'role_not_found';
    end if;

    if v_role_key = 'tenant_owner' then
      select coalesce(
        array_agg(
          permission.permission_key
          order by permission.permission_key
        ),
        array[]::text[]
      )
      into v_permissions
      from access_control.permissions permission
      where permission.permission_key like 'tenant.%';
    end if;

    select membership.id
    into v_actor_membership_id
    from access_control.memberships membership
    where membership.subject_id = private_app.current_subject_id()
      and membership.tenant_id = v_tenant_id
      and membership.scope = 'tenant'
      and membership.status = 'active'
    limit 1;

    if v_actor_membership_id is not null
       and not ('tenant.users.manage' = any(v_permissions))
       and exists (
         select 1
         from access_control.membership_roles membership_role
         join access_control.roles role
           on role.id = membership_role.role_id
         where membership_role.membership_id = v_actor_membership_id
           and role.role_key = v_role_key
       )
       and not exists (
         select 1
         from access_control.membership_roles membership_role
         join access_control.roles role
           on role.id = membership_role.role_id
         join access_control.role_permissions role_permission
           on role_permission.role_id = role.id
          and role_permission.permission_key = 'tenant.users.manage'
         where membership_role.membership_id = v_actor_membership_id
           and role.role_key <> v_role_key
       ) then
      raise exception 'cannot_remove_own_role_management';
    end if;

    if v_tenant_role_id is null then
      insert into access_control.roles (
        tenant_id,
        role_key,
        name_ar,
        name_en,
        scope,
        is_system
      )
      values (
        v_tenant_id,
        v_role_key,
        v_name_ar,
        v_name_en,
        'tenant',
        false
      )
      returning id into v_tenant_role_id;
    else
      update access_control.roles
      set name_ar = v_name_ar,
          name_en = v_name_en,
          updated_at = now()
      where id = v_tenant_role_id;
    end if;

    delete from access_control.role_permissions
    where role_id = v_tenant_role_id;

    insert into access_control.role_permissions (
      role_id,
      permission_key
    )
    select v_tenant_role_id, permission_key
    from unnest(v_permissions) selected(permission_key)
    on conflict do nothing;

    if v_system_role_id is not null then
      insert into access_control.membership_roles (
        membership_id,
        role_id
      )
      select membership_role.membership_id, v_tenant_role_id
      from access_control.membership_roles membership_role
      join access_control.memberships membership
        on membership.id = membership_role.membership_id
       and membership.tenant_id = v_tenant_id
       and membership.scope = 'tenant'
      where membership_role.role_id = v_system_role_id
      on conflict do nothing;

      delete from access_control.membership_roles membership_role
      using access_control.memberships membership
      where membership.id = membership_role.membership_id
        and membership.tenant_id = v_tenant_id
        and membership.scope = 'tenant'
        and membership_role.role_id = v_system_role_id;
    end if;

    perform private_app.write_audit(
      'tenant.role.updated',
      'tenant_role',
      v_role_key,
      v_tenant_id,
      jsonb_build_object(
        'nameAr', v_name_ar,
        'permissionCount', cardinality(v_permissions)
      )
    );

  elsif p_action = 'reset_role' then
    if v_role_key is null then
      raise exception 'role_not_found';
    end if;

    select role.id
    into v_system_role_id
    from access_control.roles role
    where role.scope = 'tenant'
      and role.tenant_id is null
      and role.role_key = v_role_key
    limit 1;

    select role.id
    into v_tenant_role_id
    from access_control.roles role
    where role.scope = 'tenant'
      and role.tenant_id = v_tenant_id
      and role.role_key = v_role_key
    limit 1;

    if v_tenant_role_id is null or v_system_role_id is null then
      raise exception 'role_not_customized';
    end if;

    select coalesce(
      array_agg(
        role_permission.permission_key
        order by role_permission.permission_key
      ),
      array[]::text[]
    )
    into v_permissions
    from access_control.role_permissions role_permission
    where role_permission.role_id = v_system_role_id;

    select membership.id
    into v_actor_membership_id
    from access_control.memberships membership
    where membership.subject_id = private_app.current_subject_id()
      and membership.tenant_id = v_tenant_id
      and membership.scope = 'tenant'
      and membership.status = 'active'
    limit 1;

    if v_actor_membership_id is not null
       and not ('tenant.users.manage' = any(v_permissions))
       and exists (
         select 1
         from access_control.membership_roles membership_role
         where membership_role.membership_id = v_actor_membership_id
           and membership_role.role_id = v_tenant_role_id
       )
       and not exists (
         select 1
         from access_control.membership_roles membership_role
         join access_control.roles role
           on role.id = membership_role.role_id
         join access_control.role_permissions role_permission
           on role_permission.role_id = role.id
          and role_permission.permission_key = 'tenant.users.manage'
         where membership_role.membership_id = v_actor_membership_id
           and role.role_key <> v_role_key
       ) then
      raise exception 'cannot_remove_own_role_management';
    end if;

    insert into access_control.membership_roles (
      membership_id,
      role_id
    )
    select membership_role.membership_id, v_system_role_id
    from access_control.membership_roles membership_role
    where membership_role.role_id = v_tenant_role_id
    on conflict do nothing;

    delete from access_control.membership_roles
    where role_id = v_tenant_role_id;

    delete from access_control.roles
    where id = v_tenant_role_id;

    perform private_app.write_audit(
      'tenant.role.reset',
      'tenant_role',
      v_role_key,
      v_tenant_id,
      '{}'::jsonb
    );

  elsif p_action = 'delete_role' then
    if v_role_key is null then
      raise exception 'role_not_found';
    end if;

    select role.id
    into v_system_role_id
    from access_control.roles role
    where role.scope = 'tenant'
      and role.tenant_id is null
      and role.role_key = v_role_key
    limit 1;

    select role.id
    into v_tenant_role_id
    from access_control.roles role
    where role.scope = 'tenant'
      and role.tenant_id = v_tenant_id
      and role.role_key = v_role_key
    limit 1;

    if v_tenant_role_id is null then
      raise exception 'role_not_found';
    end if;

    if v_system_role_id is not null then
      raise exception 'system_role_use_reset';
    end if;

    if exists (
      select 1
      from access_control.membership_roles membership_role
      join access_control.memberships membership
        on membership.id = membership_role.membership_id
      where membership_role.role_id = v_tenant_role_id
        and membership.tenant_id = v_tenant_id
    ) or exists (
      select 1
      from people.staff_profiles staff
      where staff.tenant_id = v_tenant_id
        and staff.role_key = v_role_key
    ) or exists (
      select 1
      from access_control.tenant_invitations invitation
      where invitation.tenant_id = v_tenant_id
        and invitation.role_key = v_role_key
        and invitation.status = 'pending'
    ) then
      raise exception 'role_in_use';
    end if;

    delete from access_control.roles
    where id = v_tenant_role_id;

    perform private_app.write_audit(
      'tenant.role.deleted',
      'tenant_role',
      v_role_key,
      v_tenant_id,
      '{}'::jsonb
    );

    v_role_key := null;

  else
    raise exception 'invalid_role_action';
  end if;

  v_result := public.v2_tenant_role_management_snapshot(p_slug);

  return v_result || jsonb_build_object(
    'changedRoleKey',
    v_role_key
  );
end;
$$;

revoke all
on function public.v2_tenant_role_management_action(text, text, jsonb)
from public, anon, authenticated;

grant execute
on function public.v2_tenant_role_management_action(text, text, jsonb)
to authenticated, service_role;
