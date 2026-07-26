begin;

create table access_control.tenant_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  email text not null,
  full_name text not null,
  role_key text not null default 'tenant_owner',
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  invited_by_subject_id uuid references access_control.subjects(id) on delete set null,
  accepted_by_subject_id uuid references access_control.subjects(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(trim(email))),
  check (length(trim(full_name)) >= 2)
);

create unique index tenant_invitations_one_pending_email_idx
  on access_control.tenant_invitations (tenant_id, lower(email))
  where status = 'pending';

create index tenant_invitations_tenant_status_idx
  on access_control.tenant_invitations (tenant_id, status, created_at desc);

create trigger tenant_invitations_set_updated_at
before update on access_control.tenant_invitations
for each row execute function private_app.set_updated_at();

alter table access_control.tenant_invitations enable row level security;
revoke all on table access_control.tenant_invitations from public, anon, authenticated;

create policy tenant_invitations_isolated_read
on access_control.tenant_invitations
for select
to authenticated
using (
  private_app.has_platform_permission('platform.access.manage')
  or private_app.has_tenant_permission(tenant_id, 'tenant.users.manage')
);

create or replace function private_app.link_existing_tenant_user(
  p_tenant_id uuid,
  p_full_name text,
  p_email text,
  p_role_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_subject_id uuid;
  v_membership_id uuid;
  v_role_id uuid;
begin
  select u.id
  into v_auth_user_id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1;

  if v_auth_user_id is null then
    return jsonb_build_object('linked', false);
  end if;

  insert into access_control.subjects (
    auth_user_id,
    email,
    full_name,
    status,
    must_change_password
  )
  values (
    v_auth_user_id,
    lower(trim(p_email)),
    trim(p_full_name),
    'active',
    false
  )
  on conflict (auth_user_id) do update
  set email = excluded.email,
      full_name = excluded.full_name,
      status = 'active'
  returning id into v_subject_id;

  select r.id
  into v_role_id
  from access_control.roles r
  where r.scope = 'tenant'
    and r.role_key = p_role_key
    and (r.tenant_id is null or r.tenant_id = p_tenant_id)
  order by (r.tenant_id = p_tenant_id) desc
  limit 1;

  if v_role_id is null then
    raise exception 'invalid_role';
  end if;

  select m.id
  into v_membership_id
  from access_control.memberships m
  where m.subject_id = v_subject_id
    and m.tenant_id = p_tenant_id
    and m.scope = 'tenant'
  limit 1;

  if v_membership_id is null then
    insert into access_control.memberships (
      subject_id,
      tenant_id,
      scope,
      status
    )
    values (
      v_subject_id,
      p_tenant_id,
      'tenant',
      'active'
    )
    returning id into v_membership_id;
  else
    update access_control.memberships
    set status = 'active'
    where id = v_membership_id;
  end if;

  insert into access_control.membership_roles (membership_id, role_id)
  values (v_membership_id, v_role_id)
  on conflict do nothing;

  return jsonb_build_object(
    'linked', true,
    'subjectId', v_subject_id,
    'membershipId', v_membership_id
  );
end;
$$;

revoke all on function private_app.link_existing_tenant_user(uuid, text, text, text)
from public, anon, authenticated;

drop function if exists public.v2_platform_provision_tenant(
  text,
  text,
  text,
  text,
  text,
  text
);

create or replace function public.v2_platform_provision_tenant(
  p_display_name text,
  p_legal_name text,
  p_slug text,
  p_country_code text,
  p_timezone text,
  p_plan_key text,
  p_owner_name text,
  p_owner_email text,
  p_hostname text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_tenant_id uuid;
  v_plan_id uuid;
  v_hostname text;
  v_owner_email text;
  v_owner_link jsonb;
  v_invitation_token text;
  v_invitation_id uuid;
  v_domain_id uuid;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;

  if p_display_name is null or length(trim(p_display_name)) < 2 then
    raise exception 'display_name_required';
  end if;

  if p_slug is null or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid_slug';
  end if;

  if exists (select 1 from core.tenants where slug = p_slug) then
    raise exception 'slug_exists';
  end if;

  if p_owner_name is null or length(trim(p_owner_name)) < 2 then
    raise exception 'owner_name_required';
  end if;

  v_owner_email := lower(trim(coalesce(p_owner_email, '')));
  if v_owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_owner_email';
  end if;

  select p.id
  into v_plan_id
  from catalog.plans p
  where p.plan_key = coalesce(nullif(trim(p_plan_key), ''), 'free')
    and p.status = 'active'
  limit 1;

  if v_plan_id is null then
    raise exception 'plan_not_found';
  end if;

  v_hostname := lower(trim(coalesce(p_hostname, '')));
  if v_hostname <> '' then
    v_hostname := regexp_replace(v_hostname, '\.$', '');
    if v_hostname !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' then
      raise exception 'invalid_hostname';
    end if;
    if exists (select 1 from core.domains where hostname = v_hostname) then
      raise exception 'domain_exists';
    end if;
  end if;

  insert into core.organizations (
    organization_key,
    legal_name,
    display_name,
    country_code
  )
  values (
    'org-' || p_slug,
    coalesce(nullif(trim(p_legal_name), ''), trim(p_display_name)),
    trim(p_display_name),
    upper(coalesce(nullif(trim(p_country_code), ''), 'SA'))
  )
  returning id into v_organization_id;

  insert into core.tenants (
    organization_id,
    tenant_key,
    slug,
    name,
    legal_name,
    status,
    country_code,
    timezone
  )
  values (
    v_organization_id,
    'tenant-' || p_slug,
    p_slug,
    trim(p_display_name),
    coalesce(nullif(trim(p_legal_name), ''), trim(p_display_name)),
    'trial',
    upper(coalesce(nullif(trim(p_country_code), ''), 'SA')),
    coalesce(nullif(trim(p_timezone), ''), 'Asia/Riyadh')
  )
  returning id into v_tenant_id;

  insert into core.tenant_modules (tenant_id, module_id, enabled, enabled_at)
  select v_tenant_id, m.id, true, now()
  from core.modules m
  where m.enabled_by_default
  on conflict do nothing;

  insert into catalog.subscriptions (tenant_id, plan_id, status)
  values (v_tenant_id, v_plan_id, 'trialing');

  if v_hostname <> '' then
    insert into core.domains (
      tenant_id,
      hostname,
      domain_type,
      status,
      is_primary
    )
    values (
      v_tenant_id,
      v_hostname,
      case
        when v_hostname = p_slug || '.marktone.sa' then 'subdomain'
        else 'custom'
      end,
      'pending',
      true
    )
    returning id into v_domain_id;
  end if;

  v_owner_link := private_app.link_existing_tenant_user(
    v_tenant_id,
    trim(p_owner_name),
    v_owner_email,
    'tenant_owner'
  );

  if not coalesce((v_owner_link ->> 'linked')::boolean, false) then
    v_invitation_token := encode(extensions.gen_random_bytes(32), 'hex');

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
      v_owner_email,
      trim(p_owner_name),
      'tenant_owner',
      encode(extensions.digest(v_invitation_token, 'sha256'), 'hex'),
      private_app.current_subject_id()
    )
    returning id into v_invitation_id;
  end if;

  perform private_app.write_audit(
    'tenant.provisioned',
    'tenant',
    v_tenant_id::text,
    v_tenant_id,
    jsonb_build_object(
      'slug', p_slug,
      'name', trim(p_display_name),
      'planKey', coalesce(nullif(trim(p_plan_key), ''), 'free'),
      'ownerEmail', v_owner_email,
      'ownerLinked', coalesce((v_owner_link ->> 'linked')::boolean, false),
      'domain', nullif(v_hostname, '')
    )
  );

  return jsonb_build_object(
    'id', v_tenant_id,
    'slug', p_slug,
    'status', 'trial',
    'planKey', coalesce(nullif(trim(p_plan_key), ''), 'free'),
    'domain', case
      when v_domain_id is null then null
      else jsonb_build_object(
        'id', v_domain_id,
        'hostname', v_hostname,
        'status', 'pending'
      )
    end,
    'owner', jsonb_build_object(
      'name', trim(p_owner_name),
      'email', v_owner_email,
      'status', case
        when coalesce((v_owner_link ->> 'linked')::boolean, false) then 'linked'
        else 'invited'
      end,
      'invitationId', v_invitation_id,
      'invitationToken', v_invitation_token
    )
  );
end;
$$;

create or replace function public.v2_tenant_invite_user(
  p_tenant_slug text,
  p_full_name text,
  p_email text,
  p_role_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_email text;
  v_role_key text;
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

  if not private_app.has_tenant_permission(v_tenant_id, 'tenant.users.manage') then
    raise exception 'forbidden';
  end if;

  if p_full_name is null or length(trim(p_full_name)) < 2 then
    raise exception 'full_name_required';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;

  v_role_key := coalesce(nullif(trim(p_role_key), ''), 'tenant_admin');
  if not exists (
    select 1
    from access_control.roles r
    where r.scope = 'tenant'
      and r.role_key = v_role_key
      and (r.tenant_id is null or r.tenant_id = v_tenant_id)
  ) then
    raise exception 'invalid_role';
  end if;

  v_link := private_app.link_existing_tenant_user(
    v_tenant_id,
    trim(p_full_name),
    v_email,
    v_role_key
  );

  if coalesce((v_link ->> 'linked')::boolean, false) then
    perform private_app.write_audit(
      'tenant.user_linked',
      'membership',
      v_link ->> 'membershipId',
      v_tenant_id,
      jsonb_build_object('email', v_email, 'roleKey', v_role_key)
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
    trim(p_full_name),
    v_role_key,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    private_app.current_subject_id()
  )
  returning id into v_invitation_id;

  perform private_app.write_audit(
    'tenant.user_invited',
    'invitation',
    v_invitation_id::text,
    v_tenant_id,
    jsonb_build_object('email', v_email, 'roleKey', v_role_key)
  );

  return jsonb_build_object(
    'status', 'invited',
    'email', v_email,
    'invitationId', v_invitation_id,
    'invitationToken', v_token
  );
end;
$$;

create or replace function public.v2_invitation_preview(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation access_control.tenant_invitations%rowtype;
  v_tenant core.tenants%rowtype;
  v_role_name text;
begin
  if p_token is null or length(trim(p_token)) < 32 then
    raise exception 'invalid_invitation';
  end if;

  select i.*
  into v_invitation
  from access_control.tenant_invitations i
  where i.token_hash = encode(
      extensions.digest(trim(p_token), 'sha256'),
      'hex'
    )
    and i.status = 'pending'
  limit 1;

  if v_invitation.id is null then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.expires_at <= now() then
    raise exception 'invitation_expired';
  end if;

  select *
  into v_tenant
  from core.tenants
  where id = v_invitation.tenant_id;

  select r.name_ar
  into v_role_name
  from access_control.roles r
  where r.scope = 'tenant'
    and r.role_key = v_invitation.role_key
    and (r.tenant_id is null or r.tenant_id = v_invitation.tenant_id)
  order by (r.tenant_id = v_invitation.tenant_id) desc
  limit 1;

  return jsonb_build_object(
    'tenantName', v_tenant.name,
    'tenantSlug', v_tenant.slug,
    'fullName', v_invitation.full_name,
    'email', v_invitation.email,
    'roleKey', v_invitation.role_key,
    'roleName', v_role_name,
    'expiresAt', v_invitation.expires_at
  );
end;
$$;

create or replace function public.v2_accept_tenant_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation access_control.tenant_invitations%rowtype;
  v_email text;
  v_link jsonb;
  v_tenant_slug text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  select i.*
  into v_invitation
  from access_control.tenant_invitations i
  where i.token_hash = encode(
      extensions.digest(trim(coalesce(p_token, '')), 'sha256'),
      'hex'
    )
    and i.status = 'pending'
  for update
  limit 1;

  if v_invitation.id is null then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.expires_at <= now() then
    update access_control.tenant_invitations
    set status = 'expired'
    where id = v_invitation.id;
    raise exception 'invitation_expired';
  end if;

  if v_email = '' or v_email <> lower(v_invitation.email) then
    raise exception 'invitation_email_mismatch';
  end if;

  v_link := private_app.link_existing_tenant_user(
    v_invitation.tenant_id,
    v_invitation.full_name,
    v_invitation.email,
    v_invitation.role_key
  );

  if not coalesce((v_link ->> 'linked')::boolean, false) then
    raise exception 'account_not_available';
  end if;

  update access_control.tenant_invitations
  set status = 'accepted',
      accepted_by_subject_id = (v_link ->> 'subjectId')::uuid,
      accepted_at = now()
  where id = v_invitation.id;

  select t.slug
  into v_tenant_slug
  from core.tenants t
  where t.id = v_invitation.tenant_id;

  perform private_app.write_audit(
    'tenant.invitation_accepted',
    'invitation',
    v_invitation.id::text,
    v_invitation.tenant_id,
    jsonb_build_object(
      'email', v_invitation.email,
      'roleKey', v_invitation.role_key
    )
  );

  return jsonb_build_object(
    'status', 'accepted',
    'tenantSlug', v_tenant_slug,
    'membershipId', v_link ->> 'membershipId'
  );
end;
$$;

create or replace function public.v2_platform_provisioning_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private_app.has_platform_permission('platform.control.read') then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'pendingInvitations', (
      select count(*)
      from access_control.tenant_invitations i
      where i.status = 'pending'
        and i.expires_at > now()
    ),
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenantId', t.id,
        'domain', d.hostname,
        'domainStatus', d.status,
        'memberCount', (
          select count(*)
          from access_control.memberships m
          where m.tenant_id = t.id
            and m.scope = 'tenant'
            and m.status = 'active'
        ),
        'ownerName', coalesce(owner_subject.full_name, owner_invite.full_name),
        'ownerEmail', coalesce(owner_subject.email, owner_invite.email),
        'ownerStatus', case
          when owner_subject.id is not null then 'linked'
          when owner_invite.id is not null then 'invited'
          else 'missing'
        end
      ) order by t.created_at desc)
      from core.tenants t
      left join lateral (
        select domain.hostname, domain.status
        from core.domains domain
        where domain.tenant_id = t.id
        order by domain.is_primary desc, domain.created_at
        limit 1
      ) d on true
      left join lateral (
        select s.id, s.full_name, s.email
        from access_control.memberships m
        join access_control.membership_roles mr on mr.membership_id = m.id
        join access_control.roles r on r.id = mr.role_id
        join access_control.subjects s on s.id = m.subject_id
        where m.tenant_id = t.id
          and m.scope = 'tenant'
          and m.status = 'active'
          and r.role_key = 'tenant_owner'
        order by m.created_at
        limit 1
      ) owner_subject on true
      left join lateral (
        select i.id, i.full_name, i.email
        from access_control.tenant_invitations i
        where i.tenant_id = t.id
          and i.role_key = 'tenant_owner'
          and i.status = 'pending'
        order by i.created_at desc
        limit 1
      ) owner_invite on true
    ), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'tenantId', i.tenant_id,
        'tenantName', t.name,
        'fullName', i.full_name,
        'email', i.email,
        'roleKey', i.role_key,
        'status', i.status,
        'expiresAt', i.expires_at,
        'createdAt', i.created_at
      ) order by i.created_at desc)
      from access_control.tenant_invitations i
      join core.tenants t on t.id = i.tenant_id
    ), '[]'::jsonb)
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
    'domains', coalesce((
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
    ), '[]'::jsonb),
    'subscription', (
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
    ),
    'employees', coalesce((
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
    ), '[]'::jsonb),
    'roles', coalesce((
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
    ), '[]'::jsonb),
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

revoke execute on function public.v2_platform_provision_tenant(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public, anon;
revoke execute on function public.v2_tenant_invite_user(text, text, text, text)
from public, anon;
revoke execute on function public.v2_accept_tenant_invitation(text)
from public, anon;
revoke execute on function public.v2_platform_provisioning_snapshot()
from public, anon;
revoke execute on function public.v2_tenant_access_snapshot(text)
from public, anon;
revoke execute on function public.v2_invitation_preview(text)
from public;

grant execute on function public.v2_platform_provision_tenant(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to authenticated;
grant execute on function public.v2_tenant_invite_user(text, text, text, text)
to authenticated;
grant execute on function public.v2_accept_tenant_invitation(text)
to authenticated;
grant execute on function public.v2_platform_provisioning_snapshot()
to authenticated;
grant execute on function public.v2_tenant_access_snapshot(text)
to authenticated;
grant execute on function public.v2_invitation_preview(text)
to anon, authenticated;

commit;
