-- Version aligned with the migration recorded by the linked Supabase project.
begin;

create unique index if not exists people_staff_tenant_email_idx
on people.staff_profiles (tenant_id, email)
where email is not null;

create or replace function public.v2_tenant_update_staff(
  p_tenant_slug text,
  p_staff_id uuid,
  p_full_name text,
  p_role_key text,
  p_department_key text,
  p_job_title text,
  p_email text default null,
  p_phone text default null,
  p_employment_status text default 'active',
  p_capacity_minutes_weekly integer default 2400
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_department_id uuid;
  v_role_id uuid;
  v_staff people.staff_profiles%rowtype;
  v_email text;
  v_account_status text;
  v_is_own_membership boolean := false;
  v_new_role_can_manage_users boolean := false;
begin
  select t.id
  into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.people.manage'
  ) then
    raise exception 'forbidden';
  end if;

  select sp.*
  into v_staff
  from people.staff_profiles sp
  where sp.id = p_staff_id
    and sp.tenant_id = v_tenant_id
  for update;

  if v_staff.id is null then
    raise exception 'staff_not_found';
  end if;

  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'full_name_required';
  end if;

  if p_employment_status not in ('active', 'leave', 'inactive') then
    raise exception 'invalid_employment_status';
  end if;

  if p_capacity_minutes_weekly is null
     or p_capacity_minutes_weekly < 0
     or p_capacity_minutes_weekly > 10080 then
    raise exception 'invalid_capacity';
  end if;

  select r.id
  into v_role_id
  from access_control.roles r
  where r.scope = 'tenant'
    and r.role_key = p_role_key
    and (r.tenant_id is null or r.tenant_id = v_tenant_id)
  order by (r.tenant_id = v_tenant_id) desc
  limit 1;

  if v_role_id is null then
    raise exception 'invalid_role';
  end if;

  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;

  if v_email is not null and exists (
    select 1
    from people.staff_profiles sp
    where sp.tenant_id = v_tenant_id
      and sp.email = v_email
      and sp.id <> v_staff.id
  ) then
    raise exception 'staff_email_exists';
  end if;

  if v_staff.membership_id is not null
     and v_staff.email is distinct from v_email then
    raise exception 'active_account_email_locked';
  end if;

  insert into people.departments (
    tenant_id,
    department_key,
    name_ar
  )
  values (
    v_tenant_id,
    coalesce(nullif(trim(p_department_key), ''), 'general'),
    case coalesce(nullif(trim(p_department_key), ''), 'general')
      when 'sales' then 'المبيعات'
      when 'customer_service' then 'خدمة العملاء'
      when 'data' then 'البيانات والتحليلات'
      when 'management' then 'الإدارة'
      else 'عام'
    end
  )
  on conflict (tenant_id, department_key) do update
  set status = 'active'
  returning id into v_department_id;

  if v_staff.membership_id is not null
     and v_staff.role_key is distinct from p_role_key then
    select exists (
      select 1
      from access_control.memberships m
      where m.id = v_staff.membership_id
        and m.subject_id = private_app.current_subject_id()
    )
    into v_is_own_membership;

    select exists (
      select 1
      from access_control.role_permissions rp
      where rp.role_id = v_role_id
        and rp.permission_key = 'tenant.users.manage'
    )
    into v_new_role_can_manage_users;

    if v_is_own_membership
       and not private_app.has_platform_permission('platform.control.read')
       and not v_new_role_can_manage_users then
      raise exception 'cannot_remove_own_admin_access';
    end if;

    delete from access_control.membership_roles mr
    using access_control.roles r
    where mr.membership_id = v_staff.membership_id
      and r.id = mr.role_id
      and r.scope = 'tenant';

    insert into access_control.membership_roles (membership_id, role_id)
    values (v_staff.membership_id, v_role_id)
    on conflict do nothing;
  end if;

  if v_staff.membership_id is not null then
    v_account_status := 'active';
  elsif v_staff.account_status = 'invited'
        and v_staff.email is not distinct from v_email then
    v_account_status := 'invited';
  elsif v_staff.account_status = 'suspended' then
    v_account_status := 'suspended';
  else
    v_account_status := 'profile_only';
  end if;

  if v_staff.account_status = 'invited'
     and v_staff.email is distinct from v_email then
    update access_control.tenant_invitations
    set status = 'revoked'
    where tenant_id = v_tenant_id
      and lower(email) = lower(v_staff.email)
      and status = 'pending';
    v_account_status := 'profile_only';
  end if;

  update people.staff_profiles
  set full_name = trim(p_full_name),
      email = v_email,
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      job_title = coalesce(nullif(trim(p_job_title), ''), trim(p_full_name)),
      department_id = v_department_id,
      role_key = p_role_key,
      employment_status = p_employment_status,
      account_status = v_account_status,
      capacity_minutes_weekly = p_capacity_minutes_weekly
  where id = v_staff.id;

  if v_staff.membership_id is not null then
    update access_control.subjects s
    set full_name = trim(p_full_name)
    from access_control.memberships m
    where m.id = v_staff.membership_id
      and s.id = m.subject_id;
  end if;

  perform private_app.write_audit(
    'tenant.staff_updated',
    'staff_profile',
    v_staff.id::text,
    v_tenant_id,
    jsonb_build_object(
      'name', trim(p_full_name),
      'roleKey', p_role_key,
      'accountStatus', v_account_status
    )
  );

  return jsonb_build_object(
    'id', v_staff.id,
    'name', trim(p_full_name),
    'email', v_email,
    'roleKey', p_role_key,
    'accountStatus', v_account_status
  );
end;
$$;

create or replace function public.v2_tenant_invite_staff(
  p_tenant_slug text,
  p_staff_id uuid,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_staff people.staff_profiles%rowtype;
  v_email text;
  v_link jsonb;
  v_token text;
  v_invitation_id uuid;
begin
  select t.id
  into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.people.manage'
  ) or not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.users.manage'
  ) then
    raise exception 'forbidden';
  end if;

  select sp.*
  into v_staff
  from people.staff_profiles sp
  where sp.id = p_staff_id
    and sp.tenant_id = v_tenant_id
  for update;

  if v_staff.id is null then
    raise exception 'staff_not_found';
  end if;

  if v_staff.membership_id is not null
     and v_staff.account_status = 'active' then
    raise exception 'staff_account_already_active';
  end if;

  v_email := nullif(
    lower(trim(coalesce(p_email, v_staff.email, ''))),
    ''
  );

  if v_email is null
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;

  if exists (
    select 1
    from people.staff_profiles sp
    where sp.tenant_id = v_tenant_id
      and sp.email = v_email
      and sp.id <> v_staff.id
  ) then
    raise exception 'staff_email_exists';
  end if;

  v_link := private_app.link_existing_tenant_user(
    v_tenant_id,
    v_staff.full_name,
    v_email,
    v_staff.role_key
  );

  if coalesce((v_link ->> 'linked')::boolean, false) then
    update people.staff_profiles
    set email = v_email,
        membership_id = (v_link ->> 'membershipId')::uuid,
        account_status = 'active'
    where id = v_staff.id;

    perform private_app.write_audit(
      'tenant.staff_account_linked',
      'staff_profile',
      v_staff.id::text,
      v_tenant_id,
      jsonb_build_object(
        'email', v_email,
        'roleKey', v_staff.role_key
      )
    );

    return jsonb_build_object(
      'status', 'linked',
      'email', v_email,
      'membershipId', v_link ->> 'membershipId'
    );
  end if;

  update access_control.tenant_invitations
  set status = 'revoked'
  where tenant_id = v_tenant_id
    and lower(email) = v_email
    and status = 'pending';

  if v_staff.email is not null and v_staff.email <> v_email then
    update access_control.tenant_invitations
    set status = 'revoked'
    where tenant_id = v_tenant_id
      and lower(email) = lower(v_staff.email)
      and status = 'pending';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into access_control.tenant_invitations (
    tenant_id,
    email,
    full_name,
    role_key,
    token_hash,
    invited_by_subject_id
  )
  values (
    v_tenant_id,
    v_email,
    v_staff.full_name,
    v_staff.role_key,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    private_app.current_subject_id()
  )
  returning id into v_invitation_id;

  update people.staff_profiles
  set email = v_email,
      account_status = 'invited',
      metadata = metadata || jsonb_build_object(
        'invitationId', v_invitation_id,
        'invitedAt', now()
      )
  where id = v_staff.id;

  perform private_app.write_audit(
    'tenant.staff_invited',
    'staff_profile',
    v_staff.id::text,
    v_tenant_id,
    jsonb_build_object(
      'email', v_email,
      'roleKey', v_staff.role_key,
      'invitationId', v_invitation_id
    )
  );

  return jsonb_build_object(
    'status', 'invited',
    'email', v_email,
    'invitationId', v_invitation_id,
    'invitationToken', v_token
  );
end;
$$;

create or replace function public.v2_tenant_access_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_can_manage_users boolean;
begin
  select t.id
  into v_tenant_id
  from core.tenants t
  where t.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.can_access_tenant(v_tenant_id) then
    raise exception 'forbidden';
  end if;

  v_can_manage_users := private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.users.manage'
  );

  return jsonb_build_object(
    'domains', case
      when v_can_manage_users then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', d.id,
          'hostname', d.hostname,
          'type', d.domain_type,
          'status', d.status,
          'primary', d.is_primary,
          'verifiedAt', d.verified_at
        ) order by d.is_primary desc, d.created_at)
        from core.domains d
        where d.tenant_id = v_tenant_id
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'subscription', case
      when v_can_manage_users then (
        select jsonb_build_object(
          'id', s.id,
          'status', s.status,
          'planKey', p.plan_key,
          'planName', p.name_ar,
          'periodStart', s.period_start,
          'periodEnd', s.period_end
        )
        from catalog.subscriptions s
        join catalog.plans p on p.id = s.plan_id
        where s.tenant_id = v_tenant_id
          and s.status in ('trialing', 'active', 'past_due', 'paused')
        order by s.created_at desc
        limit 1
      )
      else null
    end,
    'employees', case
      when v_can_manage_users then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id,
          'subjectId', s.id,
          'name', s.full_name,
          'email', s.email,
          'status', m.status,
          'role', role_data.name_ar,
          'roleKey', role_data.role_key,
          'roles', role_data.roles,
          'permissions', role_data.permissions
        ) order by s.full_name)
        from access_control.memberships m
        join access_control.subjects s on s.id = m.subject_id
        left join lateral (
          select
            min(r.name_ar) as name_ar,
            min(r.role_key) as role_key,
            jsonb_agg(distinct r.role_key order by r.role_key) as roles,
            jsonb_agg(distinct rp.permission_key order by rp.permission_key)
              filter (where rp.permission_key is not null) as permissions
          from access_control.membership_roles mr
          join access_control.roles r on r.id = mr.role_id
          left join access_control.role_permissions rp on rp.role_id = r.id
          where mr.membership_id = m.id
        ) role_data on true
        where m.tenant_id = v_tenant_id
          and m.scope = 'tenant'
          and m.status <> 'revoked'
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'roles', case
      when v_can_manage_users then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', r.id,
          'key', r.role_key,
          'nameAr', r.name_ar,
          'nameEn', r.name_en,
          'permissions', coalesce((
            select jsonb_agg(rp.permission_key order by rp.permission_key)
            from access_control.role_permissions rp
            where rp.role_id = r.id
          ), '[]'::jsonb)
        ) order by r.name_ar)
        from access_control.roles r
        where r.scope = 'tenant'
          and (r.tenant_id is null or r.tenant_id = v_tenant_id)
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'invitations', case
      when v_can_manage_users then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id,
          'fullName', i.full_name,
          'email', i.email,
          'roleKey', i.role_key,
          'status', i.status,
          'expiresAt', i.expires_at,
          'createdAt', i.created_at
        ) order by i.created_at desc)
        from access_control.tenant_invitations i
        where i.tenant_id = v_tenant_id
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
end;
$$;

revoke execute on function public.v2_tenant_update_staff(
  text, uuid, text, text, text, text, text, text, text, integer
) from public, anon;
revoke execute on function public.v2_tenant_invite_staff(
  text, uuid, text
) from public, anon;

grant execute on function public.v2_tenant_update_staff(
  text, uuid, text, text, text, text, text, text, text, integer
) to authenticated;
grant execute on function public.v2_tenant_invite_staff(
  text, uuid, text
) to authenticated;

commit;
