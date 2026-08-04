begin;

insert into access_control.permissions(
  permission_key,module_key,name_ar,description
) values
  ('platform.content.manage','content','إدارة المحتوى والمعارف','إنشاء وتحرير ونشر الأخبار والمعارف ومصادر المحتوى'),
  ('platform.settings.manage','settings','إدارة إعدادات المنصة','إدارة الإعدادات والتكاملات المركزية دون إدارة المستخدمين')
on conflict (permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

with seed(role_key,name_ar,name_en) as (
  values
    ('platform_website_manager','مسؤول الموقع الإلكتروني','Website Manager'),
    ('platform_tenants_manager','مسؤول إدارة المنشآت','Tenant Operations Manager'),
    ('platform_billing_manager','مسؤول الباقات والاشتراكات','Billing Manager'),
    ('platform_content_manager','مسؤول المحتوى والمعارف','Content Manager'),
    ('platform_access_manager','مسؤول فريق المنصة والصلاحيات','Platform Access Manager'),
    ('platform_operations_manager','مشرف تشغيل المنصة','Platform Operations Manager')
)
insert into access_control.roles(
  tenant_id,role_key,name_ar,name_en,scope,is_system
)
select null,seed.role_key,seed.name_ar,seed.name_en,'platform',true
from seed
where not exists (
  select 1
  from access_control.roles role
  where role.scope='platform'
    and role.tenant_id is null
    and role.role_key=seed.role_key
);

with seed(role_key,name_ar,name_en) as (
  values
    ('platform_website_manager','مسؤول الموقع الإلكتروني','Website Manager'),
    ('platform_tenants_manager','مسؤول إدارة المنشآت','Tenant Operations Manager'),
    ('platform_billing_manager','مسؤول الباقات والاشتراكات','Billing Manager'),
    ('platform_content_manager','مسؤول المحتوى والمعارف','Content Manager'),
    ('platform_access_manager','مسؤول فريق المنصة والصلاحيات','Platform Access Manager'),
    ('platform_operations_manager','مشرف تشغيل المنصة','Platform Operations Manager')
)
update access_control.roles role
set name_ar=seed.name_ar,
    name_en=seed.name_en,
    is_system=true,
    updated_at=now()
from seed
where role.scope='platform'
  and role.tenant_id is null
  and role.role_key=seed.role_key;

with seed(role_key,permission_key) as (
  values
    ('platform_website_manager','platform.control.read'),
    ('platform_website_manager','platform.website.manage'),
    ('platform_tenants_manager','platform.control.read'),
    ('platform_tenants_manager','platform.tenants.manage'),
    ('platform_billing_manager','platform.control.read'),
    ('platform_billing_manager','platform.billing.manage'),
    ('platform_content_manager','platform.control.read'),
    ('platform_content_manager','platform.content.manage'),
    ('platform_access_manager','platform.control.read'),
    ('platform_access_manager','platform.access.manage'),
    ('platform_operations_manager','platform.control.read'),
    ('platform_operations_manager','platform.control.write'),
    ('platform_operations_manager','platform.settings.manage'),
    ('platform_operations_manager','platform.audit.read')
)
insert into access_control.role_permissions(role_id,permission_key)
select role.id,seed.permission_key
from seed
join access_control.roles role
  on role.scope='platform'
 and role.tenant_id is null
 and role.role_key=seed.role_key
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select owner.id,permission.permission_key
from access_control.roles owner
cross join access_control.permissions permission
where owner.scope='platform'
  and owner.tenant_id is null
  and owner.role_key='platform_owner'
  and permission.permission_key like 'platform.%'
on conflict do nothing;

create table if not exists access_control.platform_invitations(
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text not null,
  role_key text not null,
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending','accepted','expired','revoked')),
  expires_at timestamptz not null default (now()+interval '7 days'),
  invited_by_subject_id uuid references access_control.subjects(id) on delete set null,
  accepted_by_subject_id uuid references access_control.subjects(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists platform_invitations_email_status_idx
  on access_control.platform_invitations(lower(email),status,created_at desc);
create index if not exists platform_invitations_role_status_idx
  on access_control.platform_invitations(role_key,status);

alter table access_control.platform_invitations enable row level security;
revoke all on table access_control.platform_invitations
  from public,anon,authenticated;

drop trigger if exists platform_invitations_set_updated_at
  on access_control.platform_invitations;
create trigger platform_invitations_set_updated_at
before update on access_control.platform_invitations
for each row execute function private_app.set_updated_at();

create or replace function private_app.link_existing_platform_user(
  p_full_name text,
  p_email text,
  p_role_key text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_auth_user_id uuid;
  v_subject_id uuid;
  v_membership_id uuid;
  v_role_id uuid;
begin
  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(auth_user.email)=lower(trim(p_email))
    and auth_user.email_confirmed_at is not null
  limit 1;

  if v_auth_user_id is null then
    return jsonb_build_object('linked',false);
  end if;

  select role.id
  into v_role_id
  from access_control.roles role
  where role.scope='platform'
    and role.tenant_id is null
    and role.role_key=p_role_key
  limit 1;

  if v_role_id is null then
    raise exception 'invalid_role';
  end if;

  insert into access_control.subjects(
    auth_user_id,email,full_name,status,must_change_password
  ) values (
    v_auth_user_id,lower(trim(p_email)),trim(p_full_name),'active',false
  )
  on conflict (auth_user_id) do update
  set email=excluded.email,
      full_name=excluded.full_name,
      status='active'
  returning id into v_subject_id;

  select membership.id
  into v_membership_id
  from access_control.memberships membership
  where membership.subject_id=v_subject_id
    and membership.scope='platform'
  limit 1;

  if v_membership_id is null then
    insert into access_control.memberships(
      subject_id,tenant_id,scope,status
    ) values (
      v_subject_id,null,'platform','active'
    ) returning id into v_membership_id;
  else
    update access_control.memberships
    set status='active',updated_at=now()
    where id=v_membership_id;
  end if;

  delete from access_control.membership_roles membership_role
  using access_control.roles role
  where membership_role.membership_id=v_membership_id
    and role.id=membership_role.role_id
    and role.scope='platform';

  insert into access_control.membership_roles(membership_id,role_id)
  values(v_membership_id,v_role_id)
  on conflict do nothing;

  return jsonb_build_object(
    'linked',true,
    'subjectId',v_subject_id,
    'membershipId',v_membership_id
  );
end;
$$;

revoke all on function private_app.link_existing_platform_user(text,text,text)
  from public,anon,authenticated;

create or replace function public.v2_current_user_context()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
declare
  v_subject access_control.subjects%rowtype;
  v_memberships jsonb;
  v_platform_access boolean;
  v_platform_membership_id uuid;
  v_platform_permissions jsonb;
  v_platform_roles jsonb;
  v_platform_role_label text;
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;

  select *
  into v_subject
  from access_control.subjects
  where auth_user_id=auth.uid()
    and status='active'
  limit 1;

  if v_subject.id is null then
    raise exception 'account_not_linked';
  end if;

  select membership.id
  into v_platform_membership_id
  from access_control.memberships membership
  where membership.subject_id=v_subject.id
    and membership.scope='platform'
    and membership.status='active'
  limit 1;

  select coalesce(
    jsonb_agg(distinct role_permission.permission_key order by role_permission.permission_key),
    '[]'::jsonb
  )
  into v_platform_permissions
  from access_control.membership_roles membership_role
  join access_control.roles role on role.id=membership_role.role_id
  join access_control.role_permissions role_permission on role_permission.role_id=role.id
  where membership_role.membership_id=v_platform_membership_id
    and role.scope='platform';

  select coalesce(
    jsonb_agg(distinct role.role_key order by role.role_key),
    '[]'::jsonb
  ),string_agg(distinct role.name_ar,'، ' order by role.name_ar)
  into v_platform_roles,v_platform_role_label
  from access_control.membership_roles membership_role
  join access_control.roles role on role.id=membership_role.role_id
  where membership_role.membership_id=v_platform_membership_id
    and role.scope='platform';

  v_platform_access:=private_app.has_platform_permission('platform.control.read');

  select coalesce(jsonb_agg(item order by item->>'tenantName'),'[]'::jsonb)
  into v_memberships
  from (
    select jsonb_build_object(
      'membershipId',membership.id,
      'tenantId',tenant.id,
      'tenantSlug',tenant.slug,
      'tenantName',tenant.name,
      'status',membership.status,
      'roles',coalesce((
        select jsonb_agg(role.role_key order by role.role_key)
        from access_control.membership_roles membership_role
        join access_control.roles role on role.id=membership_role.role_id
        where membership_role.membership_id=membership.id
      ),'[]'::jsonb),
      'permissions',coalesce((
        select jsonb_agg(distinct role_permission.permission_key order by role_permission.permission_key)
        from access_control.membership_roles membership_role
        join access_control.role_permissions role_permission
          on role_permission.role_id=membership_role.role_id
        where membership_role.membership_id=membership.id
      ),'[]'::jsonb)
    ) item
    from access_control.memberships membership
    join core.tenants tenant on tenant.id=membership.tenant_id
    where membership.subject_id=v_subject.id
      and membership.scope='tenant'
      and membership.status='active'
  ) memberships;

  return jsonb_build_object(
    'subject',jsonb_build_object(
      'id',v_subject.id,
      'email',v_subject.email,
      'fullName',v_subject.full_name,
      'status',v_subject.status,
      'mustChangePassword',v_subject.must_change_password
    ),
    'platformAccess',v_platform_access,
    'platformMembershipId',v_platform_membership_id,
    'platformPermissions',coalesce(v_platform_permissions,'[]'::jsonb),
    'platformRoles',coalesce(v_platform_roles,'[]'::jsonb),
    'platformRoleLabel',coalesce(v_platform_role_label,''),
    'memberships',v_memberships
  );
end;
$$;

create or replace function public.v2_platform_access_snapshot()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
declare
  v_actor_subject_id uuid:=private_app.current_subject_id();
  v_actor_membership_id uuid;
begin
  if not private_app.has_platform_permission('platform.access.manage') then
    raise exception 'forbidden';
  end if;

  select membership.id
  into v_actor_membership_id
  from access_control.memberships membership
  where membership.subject_id=v_actor_subject_id
    and membership.scope='platform'
    and membership.status='active'
  limit 1;

  return jsonb_build_object(
    'viewer',jsonb_build_object(
      'subjectId',v_actor_subject_id,
      'membershipId',v_actor_membership_id
    ),
    'summary',jsonb_build_object(
      'activeEmployees',(select count(*) from access_control.memberships where scope='platform' and status='active'),
      'suspendedEmployees',(select count(*) from access_control.memberships where scope='platform' and status='suspended'),
      'pendingInvitations',(select count(*) from access_control.platform_invitations where status='pending' and expires_at>now()),
      'roles',(select count(*) from access_control.roles where scope='platform' and tenant_id is null)
    ),
    'permissions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'key',permission.permission_key,
        'moduleKey',permission.module_key,
        'moduleName',case permission.module_key
          when 'platform' then 'لوحة المنصة'
          when 'access' then 'فريق المنصة والصلاحيات'
          when 'audit' then 'سجل التدقيق'
          when 'billing' then 'الباقات والاشتراكات'
          when 'content' then 'المحتوى والمعارف'
          when 'settings' then 'الإعدادات والتكاملات'
          else 'صلاحيات المنصة'
        end,
        'name',permission.name_ar,
        'description',coalesce(permission.description,'تحديد إمكانية استخدام هذه الوظيفة.')
      ) order by permission.module_key,permission.name_ar,permission.permission_key)
      from access_control.permissions permission
      where permission.permission_key like 'platform.%'
    ),'[]'::jsonb),
    'roles',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',role.id,
        'key',role.role_key,
        'nameAr',role.name_ar,
        'nameEn',role.name_en,
        'isSystem',role.is_system,
        'isProtected',role.role_key='platform_owner',
        'canDelete',not role.is_system and role.role_key<>'platform_owner',
        'permissions',coalesce((
          select jsonb_agg(role_permission.permission_key order by role_permission.permission_key)
          from access_control.role_permissions role_permission
          where role_permission.role_id=role.id
        ),'[]'::jsonb),
        'assignedEmployeeCount',(
          select count(distinct membership_role.membership_id)
          from access_control.membership_roles membership_role
          join access_control.memberships membership on membership.id=membership_role.membership_id
          where membership_role.role_id=role.id
            and membership.scope='platform'
        ),
        'pendingInvitationCount',(
          select count(*)
          from access_control.platform_invitations invitation
          where invitation.role_key=role.role_key
            and invitation.status='pending'
            and invitation.expires_at>now()
        )
      ) order by case when role.role_key='platform_owner' then 0 else 1 end,role.name_ar)
      from access_control.roles role
      where role.scope='platform'
        and role.tenant_id is null
    ),'[]'::jsonb),
    'employees',coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId',membership.id,
        'subjectId',subject.id,
        'fullName',subject.full_name,
        'email',subject.email,
        'status',membership.status,
        'subjectStatus',subject.status,
        'mustChangePassword',subject.must_change_password,
        'joinedAt',membership.joined_at,
        'roles',coalesce((
          select jsonb_agg(jsonb_build_object(
            'key',role.role_key,
            'nameAr',role.name_ar
          ) order by case when role.role_key='platform_owner' then 0 else 1 end,role.name_ar)
          from access_control.membership_roles membership_role
          join access_control.roles role on role.id=membership_role.role_id
          where membership_role.membership_id=membership.id
            and role.scope='platform'
        ),'[]'::jsonb),
        'permissions',coalesce((
          select jsonb_agg(distinct role_permission.permission_key order by role_permission.permission_key)
          from access_control.membership_roles membership_role
          join access_control.role_permissions role_permission on role_permission.role_id=membership_role.role_id
          where membership_role.membership_id=membership.id
        ),'[]'::jsonb)
      ) order by case membership.status when 'active' then 0 else 1 end,subject.full_name)
      from access_control.memberships membership
      join access_control.subjects subject on subject.id=membership.subject_id
      where membership.scope='platform'
    ),'[]'::jsonb),
    'invitations',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',invitation.id,
        'fullName',invitation.full_name,
        'email',invitation.email,
        'roleKey',invitation.role_key,
        'roleName',role.name_ar,
        'status',case
          when invitation.status='pending' and invitation.expires_at<=now() then 'expired'
          else invitation.status
        end,
        'expiresAt',invitation.expires_at,
        'createdAt',invitation.created_at
      ) order by invitation.created_at desc)
      from access_control.platform_invitations invitation
      left join access_control.roles role
        on role.scope='platform'
       and role.tenant_id is null
       and role.role_key=invitation.role_key
      where invitation.status in ('pending','expired','revoked')
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_platform_access_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_payload jsonb:=coalesce(p_payload,'{}'::jsonb);
  v_actor_subject_id uuid:=private_app.current_subject_id();
  v_actor_membership_id uuid;
  v_actor_is_owner boolean:=false;
  v_role_id uuid;
  v_role_key text;
  v_role_is_system boolean;
  v_name_ar text;
  v_name_en text;
  v_permissions text[];
  v_custom_key text;
  v_membership_id uuid;
  v_subject_id uuid;
  v_target_is_owner boolean:=false;
  v_email text;
  v_full_name text;
  v_link jsonb;
  v_token text;
  v_invitation_id uuid;
  v_count integer;
  v_result jsonb:='{}'::jsonb;
begin
  if not private_app.has_platform_permission('platform.access.manage') then
    raise exception 'forbidden';
  end if;

  select membership.id
  into v_actor_membership_id
  from access_control.memberships membership
  where membership.subject_id=v_actor_subject_id
    and membership.scope='platform'
    and membership.status='active'
  limit 1;

  select exists(
    select 1
    from access_control.membership_roles membership_role
    join access_control.roles role on role.id=membership_role.role_id
    where membership_role.membership_id=v_actor_membership_id
      and role.scope='platform'
      and role.role_key='platform_owner'
  ) into v_actor_is_owner;

  if v_action in ('create_role','update_role') then
    v_name_ar:=trim(coalesce(v_payload->>'nameAr',''));
    v_name_en:=nullif(trim(coalesce(v_payload->>'nameEn','')),'');
    if length(v_name_ar)<2 then raise exception 'invalid_role_name'; end if;
    if coalesce(jsonb_typeof(v_payload->'permissions'),'')<>'array' then
      raise exception 'invalid_permissions';
    end if;

    select coalesce(array_agg(distinct submitted.permission_key order by submitted.permission_key),array[]::text[])
    into v_permissions
    from jsonb_array_elements_text(v_payload->'permissions') submitted(permission_key);

    if exists(
      select 1
      from unnest(v_permissions) submitted(permission_key)
      left join access_control.permissions permission
        on permission.permission_key=submitted.permission_key
       and permission.permission_key like 'platform.%'
      where permission.permission_key is null
    ) then raise exception 'invalid_permissions'; end if;

    if not ('platform.control.read'=any(v_permissions)) then
      v_permissions:=array_append(v_permissions,'platform.control.read');
    end if;
  end if;

  if v_action='create_role' then
    if exists(
      select 1 from access_control.roles role
      where role.scope='platform' and lower(role.name_ar)=lower(v_name_ar)
    ) then raise exception 'role_name_exists'; end if;

    loop
      v_custom_key:='platform_custom_'||substr(md5(v_name_ar||clock_timestamp()::text||random()::text),1,16);
      exit when not exists(select 1 from access_control.roles where scope='platform' and role_key=v_custom_key);
    end loop;

    insert into access_control.roles(
      tenant_id,role_key,name_ar,name_en,scope,is_system
    ) values(null,v_custom_key,v_name_ar,v_name_en,'platform',false)
    returning id into v_role_id;

    insert into access_control.role_permissions(role_id,permission_key)
    select v_role_id,permission_key from unnest(v_permissions) selected(permission_key)
    on conflict do nothing;

    perform private_app.write_audit(
      'platform.role.created','platform_role',v_custom_key,null,
      jsonb_build_object('nameAr',v_name_ar,'permissionCount',cardinality(v_permissions))
    );
    v_result:=jsonb_build_object('changedRoleKey',v_custom_key);

  elsif v_action='update_role' then
    v_role_key:=nullif(trim(v_payload->>'roleKey'),'');
    select role.id,role.is_system
    into v_role_id,v_role_is_system
    from access_control.roles role
    where role.scope='platform'
      and role.tenant_id is null
      and role.role_key=v_role_key
    limit 1;
    if v_role_id is null then raise exception 'role_not_found'; end if;

    if exists(
      select 1 from access_control.roles role
      where role.scope='platform'
        and role.id<>v_role_id
        and lower(role.name_ar)=lower(v_name_ar)
    ) then raise exception 'role_name_exists'; end if;

    if v_role_key='platform_owner' then
      select coalesce(array_agg(permission.permission_key order by permission.permission_key),array[]::text[])
      into v_permissions
      from access_control.permissions permission
      where permission.permission_key like 'platform.%';
    end if;

    if exists(
      select 1 from access_control.membership_roles
      where membership_id=v_actor_membership_id and role_id=v_role_id
    ) and not ('platform.access.manage'=any(v_permissions)) and not exists(
      select 1
      from access_control.membership_roles membership_role
      join access_control.role_permissions role_permission on role_permission.role_id=membership_role.role_id
      where membership_role.membership_id=v_actor_membership_id
        and membership_role.role_id<>v_role_id
        and role_permission.permission_key='platform.access.manage'
    ) then raise exception 'cannot_remove_own_access'; end if;

    update access_control.roles
    set name_ar=v_name_ar,name_en=v_name_en,updated_at=now()
    where id=v_role_id;
    delete from access_control.role_permissions where role_id=v_role_id;
    insert into access_control.role_permissions(role_id,permission_key)
    select v_role_id,permission_key from unnest(v_permissions) selected(permission_key)
    on conflict do nothing;

    perform private_app.write_audit(
      'platform.role.updated','platform_role',v_role_key,null,
      jsonb_build_object('nameAr',v_name_ar,'permissionCount',cardinality(v_permissions))
    );
    v_result:=jsonb_build_object('changedRoleKey',v_role_key);

  elsif v_action='delete_role' then
    v_role_key:=nullif(trim(v_payload->>'roleKey'),'');
    select role.id,role.is_system
    into v_role_id,v_role_is_system
    from access_control.roles role
    where role.scope='platform'
      and role.tenant_id is null
      and role.role_key=v_role_key
    limit 1;
    if v_role_id is null then raise exception 'role_not_found'; end if;
    if v_role_is_system or v_role_key='platform_owner' then raise exception 'system_role_protected'; end if;
    if exists(select 1 from access_control.membership_roles where role_id=v_role_id)
       or exists(select 1 from access_control.platform_invitations where role_key=v_role_key and status='pending') then
      raise exception 'role_in_use';
    end if;
    delete from access_control.roles where id=v_role_id;
    perform private_app.write_audit('platform.role.deleted','platform_role',v_role_key,null,'{}'::jsonb);

  elsif v_action='invite_employee' then
    v_full_name:=trim(coalesce(v_payload->>'fullName',''));
    v_email:=lower(trim(coalesce(v_payload->>'email','')));
    v_role_key:=nullif(trim(v_payload->>'roleKey'),'');
    if length(v_full_name)<2 then raise exception 'full_name_required'; end if;
    if v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid_email'; end if;
    select role.id into v_role_id
    from access_control.roles role
    where role.scope='platform' and role.tenant_id is null and role.role_key=v_role_key
    limit 1;
    if v_role_id is null then raise exception 'invalid_role'; end if;
    if v_role_key='platform_owner' and not v_actor_is_owner then raise exception 'owner_assignment_forbidden'; end if;

    if exists(
      select 1
      from access_control.subjects subject
      join access_control.memberships membership on membership.subject_id=subject.id
      where lower(subject.email)=v_email and membership.scope='platform' and membership.status='active'
    ) then raise exception 'employee_exists'; end if;

    v_link:=private_app.link_existing_platform_user(v_full_name,v_email,v_role_key);
    if coalesce((v_link->>'linked')::boolean,false) then
      perform private_app.write_audit(
        'platform.employee.linked','platform_membership',v_link->>'membershipId',null,
        jsonb_build_object('email',v_email,'roleKey',v_role_key)
      );
      v_result:=jsonb_build_object(
        'actionResult',jsonb_build_object('status','linked','email',v_email,'membershipId',v_link->>'membershipId')
      );
    else
      update access_control.platform_invitations
      set status='revoked'
      where lower(email)=v_email and status='pending';
      v_token:=encode(extensions.gen_random_bytes(32),'hex');
      insert into access_control.platform_invitations(
        email,full_name,role_key,token_hash,invited_by_subject_id
      ) values(
        v_email,v_full_name,v_role_key,
        encode(extensions.digest(v_token,'sha256'),'hex'),v_actor_subject_id
      ) returning id into v_invitation_id;
      perform private_app.write_audit(
        'platform.employee.invited','platform_invitation',v_invitation_id::text,null,
        jsonb_build_object('email',v_email,'roleKey',v_role_key)
      );
      v_result:=jsonb_build_object(
        'actionResult',jsonb_build_object(
          'status','invited','email',v_email,'invitationId',v_invitation_id,'invitationToken',v_token
        )
      );
    end if;

  elsif v_action='update_employee' then
    v_membership_id:=nullif(v_payload->>'membershipId','')::uuid;
    v_role_key:=nullif(trim(v_payload->>'roleKey'),'');
    v_full_name:=nullif(trim(coalesce(v_payload->>'fullName','')),'');
    select membership.subject_id into v_subject_id
    from access_control.memberships membership
    where membership.id=v_membership_id and membership.scope='platform'
    for update;
    if v_subject_id is null then raise exception 'employee_not_found'; end if;
    select exists(
      select 1
      from access_control.membership_roles membership_role
      join access_control.roles role on role.id=membership_role.role_id
      where membership_role.membership_id=v_membership_id and role.role_key='platform_owner'
    ) into v_target_is_owner;
    if v_target_is_owner and not v_actor_is_owner then raise exception 'owner_assignment_forbidden'; end if;
    select role.id into v_role_id
    from access_control.roles role
    where role.scope='platform' and role.tenant_id is null and role.role_key=v_role_key
    limit 1;
    if v_role_id is null then raise exception 'invalid_role'; end if;
    if v_role_key='platform_owner' and not v_actor_is_owner then raise exception 'owner_assignment_forbidden'; end if;
    if v_membership_id=v_actor_membership_id and not exists(
      select 1 from access_control.role_permissions
      where role_id=v_role_id and permission_key='platform.access.manage'
    ) then raise exception 'cannot_remove_own_access'; end if;

    delete from access_control.membership_roles membership_role
    using access_control.roles role
    where membership_role.membership_id=v_membership_id
      and role.id=membership_role.role_id and role.scope='platform';
    insert into access_control.membership_roles(membership_id,role_id)
    values(v_membership_id,v_role_id) on conflict do nothing;
    if v_full_name is not null then
      if length(v_full_name)<2 then raise exception 'full_name_required'; end if;
      update access_control.subjects set full_name=v_full_name,updated_at=now() where id=v_subject_id;
    end if;
    perform private_app.write_audit(
      'platform.employee.updated','platform_membership',v_membership_id::text,null,
      jsonb_build_object('roleKey',v_role_key)
    );

  elsif v_action in ('suspend_employee','activate_employee') then
    v_membership_id:=nullif(v_payload->>'membershipId','')::uuid;
    select membership.subject_id into v_subject_id
    from access_control.memberships membership
    where membership.id=v_membership_id and membership.scope='platform'
    for update;
    if v_subject_id is null then raise exception 'employee_not_found'; end if;
    if v_membership_id=v_actor_membership_id then raise exception 'cannot_change_own_status'; end if;
    select exists(
      select 1
      from access_control.membership_roles membership_role
      join access_control.roles role on role.id=membership_role.role_id
      where membership_role.membership_id=v_membership_id and role.role_key='platform_owner'
    ) into v_target_is_owner;
    if v_target_is_owner and not v_actor_is_owner then raise exception 'owner_assignment_forbidden'; end if;

    if v_action='suspend_employee' then
      select count(distinct membership.id)
      into v_count
      from access_control.memberships membership
      join access_control.membership_roles membership_role on membership_role.membership_id=membership.id
      join access_control.role_permissions role_permission on role_permission.role_id=membership_role.role_id
      where membership.scope='platform'
        and membership.status='active'
        and membership.id<>v_membership_id
        and role_permission.permission_key='platform.access.manage';
      if v_count=0 then raise exception 'cannot_suspend_last_access_manager'; end if;
      update access_control.memberships set status='suspended',updated_at=now() where id=v_membership_id;
    else
      update access_control.memberships set status='active',updated_at=now() where id=v_membership_id;
    end if;
    perform private_app.write_audit(
      case when v_action='suspend_employee' then 'platform.employee.suspended' else 'platform.employee.activated' end,
      'platform_membership',v_membership_id::text,null,'{}'::jsonb
    );

  elsif v_action in ('revoke_invitation','renew_invitation') then
    v_invitation_id:=nullif(v_payload->>'invitationId','')::uuid;
    select invitation.role_key
    into v_role_key
    from access_control.platform_invitations invitation
    where invitation.id=v_invitation_id
      and invitation.status='pending'
    for update;
    if v_role_key is null then raise exception 'invitation_not_found'; end if;
    if v_role_key='platform_owner' and not v_actor_is_owner then raise exception 'owner_assignment_forbidden'; end if;
    if v_action='revoke_invitation' then
      update access_control.platform_invitations set status='revoked' where id=v_invitation_id;
      v_result:=jsonb_build_object('actionResult',jsonb_build_object('status','revoked'));
    else
      v_token:=encode(extensions.gen_random_bytes(32),'hex');
      update access_control.platform_invitations
      set token_hash=encode(extensions.digest(v_token,'sha256'),'hex'),
          expires_at=now()+interval '7 days',status='pending'
      where id=v_invitation_id;
      v_result:=jsonb_build_object(
        'actionResult',jsonb_build_object(
          'status','renewed','invitationId',v_invitation_id,'invitationToken',v_token
        )
      );
    end if;
    perform private_app.write_audit(
      case when v_action='revoke_invitation' then 'platform.invitation.revoked' else 'platform.invitation.renewed' end,
      'platform_invitation',v_invitation_id::text,null,'{}'::jsonb
    );
  else
    raise exception 'invalid_platform_access_action';
  end if;

  return public.v2_platform_access_snapshot()||v_result;
end;
$$;

create or replace function public.v2_platform_invitation_preview(p_token text)
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
declare
  v_invitation access_control.platform_invitations%rowtype;
  v_role_name text;
begin
  select invitation.*
  into v_invitation
  from access_control.platform_invitations invitation
  where invitation.token_hash=encode(
    extensions.digest(trim(coalesce(p_token,'')),'sha256'),'hex'
  ) and invitation.status='pending'
  limit 1;
  if v_invitation.id is null then raise exception 'invalid_invitation'; end if;
  if v_invitation.expires_at<=now() then raise exception 'invitation_expired'; end if;
  select role.name_ar into v_role_name
  from access_control.roles role
  where role.scope='platform' and role.tenant_id is null and role.role_key=v_invitation.role_key
  limit 1;
  return jsonb_build_object(
    'scope','platform',
    'fullName',v_invitation.full_name,
    'email',v_invitation.email,
    'roleKey',v_invitation.role_key,
    'roleName',coalesce(v_role_name,'مستخدم المنصة'),
    'expiresAt',v_invitation.expires_at
  );
end;
$$;

create or replace function public.v2_accept_platform_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_invitation access_control.platform_invitations%rowtype;
  v_email text;
  v_link jsonb;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  v_email:=lower(coalesce(auth.jwt()->>'email',''));
  select invitation.*
  into v_invitation
  from access_control.platform_invitations invitation
  where invitation.token_hash=encode(
    extensions.digest(trim(coalesce(p_token,'')),'sha256'),'hex'
  ) and invitation.status='pending'
  for update
  limit 1;
  if v_invitation.id is null then raise exception 'invalid_invitation'; end if;
  if v_invitation.expires_at<=now() then
    update access_control.platform_invitations set status='expired' where id=v_invitation.id;
    raise exception 'invitation_expired';
  end if;
  if v_email='' or v_email<>lower(v_invitation.email) then raise exception 'invitation_email_mismatch'; end if;
  v_link:=private_app.link_existing_platform_user(
    v_invitation.full_name,v_invitation.email,v_invitation.role_key
  );
  if not coalesce((v_link->>'linked')::boolean,false) then raise exception 'account_not_available'; end if;
  update access_control.platform_invitations
  set status='accepted',accepted_by_subject_id=(v_link->>'subjectId')::uuid,accepted_at=now()
  where id=v_invitation.id;
  perform private_app.write_audit(
    'platform.invitation.accepted','platform_invitation',v_invitation.id::text,null,
    jsonb_build_object('email',v_invitation.email,'roleKey',v_invitation.role_key)
  );
  return jsonb_build_object(
    'status','accepted','scope','platform','membershipId',v_link->>'membershipId','next','/control'
  );
end;
$$;

create or replace function public.v2_platform_control_snapshot_v2()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_can_tenants boolean:=private_app.has_platform_permission('platform.tenants.manage');
  v_can_billing boolean:=private_app.has_platform_permission('platform.billing.manage');
  v_can_content boolean:=private_app.has_platform_permission('platform.content.manage');
  v_can_website boolean:=private_app.has_platform_permission('platform.website.manage');
  v_can_access boolean:=private_app.has_platform_permission('platform.access.manage');
  v_can_settings boolean:=private_app.has_platform_permission('platform.settings.manage')
    or private_app.has_platform_permission('platform.control.write');
  v_can_audit boolean:=private_app.has_platform_permission('platform.audit.read');
begin
  if not private_app.has_platform_permission('platform.control.read') then raise exception 'forbidden'; end if;
  v_result:=public.v2_platform_control_snapshot();
  if not v_can_tenants then
    v_result:=jsonb_set(v_result,'{tenants}','[]'::jsonb,true);
    v_result:=jsonb_set(v_result,'{summary,organizations}',to_jsonb(0),true);
    v_result:=jsonb_set(v_result,'{summary,activeTenants}',to_jsonb(0),true);
  end if;
  if not (v_can_billing or v_can_tenants) then
    v_result:=jsonb_set(v_result,'{plans}','[]'::jsonb,true);
    v_result:=jsonb_set(v_result,'{features}','[]'::jsonb,true);
  end if;
  if not v_can_billing then
    v_result:=jsonb_set(v_result,'{subscriptions}','[]'::jsonb,true);
  end if;
  if not v_can_access then
    v_result:=jsonb_set(v_result,'{roles}','[]'::jsonb,true);
  end if;
  if not v_can_settings then
    v_result:=jsonb_set(v_result,'{integrations}','[]'::jsonb,true);
    v_result:=jsonb_set(v_result,'{supportRequests}','[]'::jsonb,true);
    v_result:=jsonb_set(v_result,'{summary,integrations}',to_jsonb(0),true);
    v_result:=jsonb_set(v_result,'{summary,openSupport}',to_jsonb(0),true);
  end if;
  if not v_can_audit then
    v_result:=jsonb_set(v_result,'{audit}','[]'::jsonb,true);
  end if;
  return v_result||jsonb_build_object('capabilities',jsonb_build_object(
    'overview',true,
    'tenants',v_can_tenants,
    'billing',v_can_billing,
    'content',v_can_content,
    'website',v_can_website,
    'access',v_can_access,
    'settings',v_can_settings,
    'audit',v_can_audit
  ));
end;
$$;

create or replace function public.v2_platform_provisioning_snapshot_v2()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then raise exception 'forbidden'; end if;
  return public.v2_platform_provisioning_snapshot();
end;
$$;

create or replace function platform.is_platform_content_admin()
returns boolean
language sql
stable security definer
set search_path=''
as $$
  select private_app.has_platform_permission('platform.content.manage')
    or private_app.has_platform_permission('platform.control.write')
$$;

revoke all on function public.v2_platform_access_snapshot() from public,anon,authenticated;
revoke all on function public.v2_platform_access_action(text,jsonb) from public,anon,authenticated;
revoke all on function public.v2_platform_invitation_preview(text) from public,anon,authenticated;
revoke all on function public.v2_accept_platform_invitation(text) from public,anon,authenticated;
revoke all on function public.v2_platform_control_snapshot_v2() from public,anon,authenticated;
revoke all on function public.v2_platform_provisioning_snapshot_v2() from public,anon,authenticated;

grant execute on function public.v2_platform_access_snapshot() to authenticated;
grant execute on function public.v2_platform_access_action(text,jsonb) to authenticated;
grant execute on function public.v2_platform_invitation_preview(text) to anon,authenticated;
grant execute on function public.v2_accept_platform_invitation(text) to authenticated;
grant execute on function public.v2_platform_control_snapshot_v2() to authenticated;
grant execute on function public.v2_platform_provisioning_snapshot_v2() to authenticated;

commit;
