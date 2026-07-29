begin;

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
    and u.email_confirmed_at is not null
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

create or replace function private_app.sync_staff_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_email text;
  v_role_key text;
  v_auth_confirmed boolean;
begin
  select
    m.tenant_id,
    s.email,
    r.role_key,
    (u.email_confirmed_at is not null)
  into
    v_tenant_id,
    v_email,
    v_role_key,
    v_auth_confirmed
  from access_control.memberships m
  join access_control.subjects s on s.id = m.subject_id
  join auth.users u on u.id = s.auth_user_id
  join access_control.roles r on r.id = new.role_id
  where m.id = new.membership_id
    and m.scope = 'tenant'
  limit 1;

  if v_tenant_id is not null and v_email is not null then
    update people.staff_profiles
    set membership_id = new.membership_id,
        role_key = v_role_key,
        account_status = case
          when v_auth_confirmed then 'active'
          else 'invited'
        end
    where tenant_id = v_tenant_id
      and email = lower(v_email);
  end if;

  return new;
end;
$$;

revoke all on function private_app.sync_staff_membership()
from public, anon, authenticated;

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

  update people.staff_profiles
  set membership_id = (v_link ->> 'membershipId')::uuid,
      account_status = 'active'
  where tenant_id = v_invitation.tenant_id
    and lower(email) = lower(v_invitation.email);

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

revoke execute on function public.v2_accept_tenant_invitation(text)
from public, anon;
grant execute on function public.v2_accept_tenant_invitation(text)
to authenticated;

update people.staff_profiles sp
set account_status = 'invited'
from access_control.memberships m
join access_control.subjects s on s.id = m.subject_id
join auth.users u on u.id = s.auth_user_id
where sp.membership_id = m.id
  and sp.account_status = 'active'
  and u.email_confirmed_at is null
  and exists (
    select 1
    from access_control.tenant_invitations i
    where i.tenant_id = sp.tenant_id
      and lower(i.email) = lower(sp.email)
      and i.status = 'pending'
      and i.expires_at > now()
  );

commit;
