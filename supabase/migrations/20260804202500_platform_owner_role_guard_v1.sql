begin;

create or replace function private_app.guard_platform_owner_role_update()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor_is_owner boolean:=false;
begin
  if old.scope='platform'
     and old.tenant_id is null
     and old.role_key='platform_owner'
     and auth.uid() is not null then
    select exists(
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='platform'
       and membership.status='active'
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id
       and role.scope='platform'
       and role.role_key='platform_owner'
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
    ) into v_actor_is_owner;

    if not v_actor_is_owner then
      raise exception 'owner_assignment_forbidden';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private_app.guard_platform_owner_role_update()
from public,anon,authenticated;

drop trigger if exists platform_owner_role_update_guard
on access_control.roles;
create trigger platform_owner_role_update_guard
before update on access_control.roles
for each row execute function private_app.guard_platform_owner_role_update();

commit;
