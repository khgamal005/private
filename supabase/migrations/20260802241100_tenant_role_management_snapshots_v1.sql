-- Human-readable, tenant-aware role and permission snapshots.
-- Internal permission keys remain stable, while the UI receives Arabic names.

create or replace function public.v2_tenant_effective_roles_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  if not private_app.can_access_tenant(v_tenant_id) then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'roles',
    coalesce((
      with ranked_roles as (
        select
          role.*,
          row_number() over (
            partition by role.role_key
            order by
              case when role.tenant_id = v_tenant_id then 0 else 1 end,
              role.created_at desc
          ) as position
        from access_control.roles role
        where role.scope = 'tenant'
          and (role.tenant_id is null or role.tenant_id = v_tenant_id)
      ),
      effective_roles as (
        select *
        from ranked_roles
        where position = 1
      )
      select jsonb_agg(
        jsonb_build_object(
          'id', role.id,
          'key', role.role_key,
          'nameAr', role.name_ar,
          'nameEn', role.name_en,
          'origin', case
            when role.tenant_id is null then 'system'
            when exists (
              select 1
              from access_control.roles system_role
              where system_role.scope = 'tenant'
                and system_role.tenant_id is null
                and system_role.role_key = role.role_key
            ) then 'overridden'
            else 'custom'
          end,
          'permissions', coalesce((
            select jsonb_agg(
              role_permission.permission_key
              order by role_permission.permission_key
            )
            from access_control.role_permissions role_permission
            where role_permission.role_id = role.id
          ), '[]'::jsonb)
        )
        order by role.name_ar, role.role_key
      )
      from effective_roles role
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_role_management_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
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

  return jsonb_build_object(
    'terminology', jsonb_build_object(
      'jobTitle',
      'المسمى الوظيفي يصف وظيفة الموظف ولا يمنحه صلاحيات تلقائيًا.',
      'department',
      'القسم ينظم الموظفين داخل الهيكل الإداري ولا يفتح الشاشات.',
      'role',
      'الدور هو قالب الصلاحيات الذي يحدد ما يمكن عرضه أو تنفيذه.'
    ),
    'departments', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', department.id,
          'key', department.department_key,
          'nameAr', department.name_ar,
          'nameEn', department.name_en,
          'status', department.status
        )
        order by department.name_ar
      )
      from people.departments department
      where department.tenant_id = v_tenant_id
    ), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'key', permission.permission_key,
          'moduleKey', permission.module_key,
          'moduleName', case permission.module_key
            when 'access' then 'المستخدمون والصلاحيات'
            when 'academy' then 'البرامج والدورات'
            when 'admissions' then 'التسجيل والقبول'
            when 'ai_assistant' then 'المساعد الذكي'
            when 'analytics' then 'التقارير والتحليلات'
            when 'content' then 'الأخبار والمعارف'
            when 'crm' then 'المبيعات والعملاء'
            when 'customer_service' then 'خدمة العملاء'
            when 'incentives' then 'الأهداف والحوافز'
            when 'people' then 'فريق العمل والربط'
            when 'reports' then 'التقارير'
            when 'support' then 'الدعم'
            when 'tenant' then 'إعدادات المنشأة والدخول'
            when 'training' then 'تشغيل المتدربين'
            when 'work' then 'المهام والتقويم'
            else 'صلاحيات أخرى'
          end,
          'name', permission.name_ar,
          'description', coalesce(
            permission.description,
            'تحديد إمكانية استخدام هذه الوظيفة.'
          )
        )
        order by
          permission.module_key,
          permission.name_ar,
          permission.permission_key
      )
      from access_control.permissions permission
      where permission.permission_key like 'tenant.%'
    ), '[]'::jsonb),
    'roles', coalesce((
      with ranked_roles as (
        select
          role.*,
          row_number() over (
            partition by role.role_key
            order by
              case when role.tenant_id = v_tenant_id then 0 else 1 end,
              role.created_at desc
          ) as position
        from access_control.roles role
        where role.scope = 'tenant'
          and (role.tenant_id is null or role.tenant_id = v_tenant_id)
      ),
      effective_roles as (
        select *
        from ranked_roles
        where position = 1
      )
      select jsonb_agg(
        jsonb_build_object(
          'id', role.id,
          'key', role.role_key,
          'nameAr', role.name_ar,
          'nameEn', role.name_en,
          'origin', case
            when role.tenant_id is null then 'system'
            when exists (
              select 1
              from access_control.roles system_role
              where system_role.scope = 'tenant'
                and system_role.tenant_id is null
                and system_role.role_key = role.role_key
            ) then 'overridden'
            else 'custom'
          end,
          'isProtected', role.role_key = 'tenant_owner',
          'canReset', (
            role.tenant_id = v_tenant_id
            and exists (
              select 1
              from access_control.roles system_role
              where system_role.scope = 'tenant'
                and system_role.tenant_id is null
                and system_role.role_key = role.role_key
            )
          ),
          'canDelete', (
            role.tenant_id = v_tenant_id
            and not exists (
              select 1
              from access_control.roles system_role
              where system_role.scope = 'tenant'
                and system_role.tenant_id is null
                and system_role.role_key = role.role_key
            )
          ),
          'permissions', coalesce((
            select jsonb_agg(
              role_permission.permission_key
              order by role_permission.permission_key
            )
            from access_control.role_permissions role_permission
            where role_permission.role_id = role.id
          ), '[]'::jsonb),
          'lockedPermissions', case
            when role.role_key = 'tenant_owner' then coalesce((
              select jsonb_agg(
                permission.permission_key
                order by permission.permission_key
              )
              from access_control.permissions permission
              where permission.permission_key like 'tenant.%'
            ), '[]'::jsonb)
            else jsonb_build_array('tenant.workspace.read')
          end,
          'assignedStaffCount', (
            select count(*)
            from people.staff_profiles staff
            where staff.tenant_id = v_tenant_id
              and staff.role_key = role.role_key
          ),
          'pendingInvitationCount', (
            select count(*)
            from access_control.tenant_invitations invitation
            where invitation.tenant_id = v_tenant_id
              and invitation.role_key = role.role_key
              and invitation.status = 'pending'
          )
        )
        order by
          case when role.role_key = 'tenant_owner' then 0 else 1 end,
          role.name_ar,
          role.role_key
      )
      from effective_roles role
    ), '[]'::jsonb)
  );
end;
$$;

revoke all
on function public.v2_tenant_effective_roles_snapshot(text)
from public, anon, authenticated;

revoke all
on function public.v2_tenant_role_management_snapshot(text)
from public, anon, authenticated;

grant execute
on function public.v2_tenant_effective_roles_snapshot(text)
to authenticated, service_role;

grant execute
on function public.v2_tenant_role_management_snapshot(text)
to authenticated, service_role;
