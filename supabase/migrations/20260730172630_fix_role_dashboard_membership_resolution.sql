-- Resolve the effective tenant role for owners/admins without staff profiles.
begin;

create or replace function public.v2_tenant_role_dashboard_snapshot_v2(
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
  v_subject_id uuid;
  v_snapshot jsonb;
  v_role_key text;
  v_role_label text;
  v_subject_name text;
  v_executive jsonb;
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
    'tenant.workspace.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_snapshot := public.v2_tenant_role_dashboard_snapshot(p_slug);
  if nullif(v_snapshot #>> '{viewer,staffId}', '') is not null then
    return v_snapshot;
  end if;

  v_subject_id := private_app.current_subject_id();
  select role.role_key, subject.full_name
  into v_role_key, v_subject_name
  from access_control.memberships membership
  join access_control.membership_roles membership_role
    on membership_role.membership_id = membership.id
  join access_control.roles role
    on role.id = membership_role.role_id
  join access_control.subjects subject
    on subject.id = membership.subject_id
  where membership.tenant_id = v_tenant_id
    and membership.subject_id = v_subject_id
    and membership.status = 'active'
    and role.scope = 'tenant'
  order by private_app.tenant_role_rank(role.role_key) desc
  limit 1;

  if v_role_key is null then
    return v_snapshot;
  end if;

  v_role_label := case v_role_key
    when 'tenant_owner' then 'مالك المنشأة'
    when 'tenant_admin' then 'مدير المنشأة'
    when 'executive_manager' then 'المدير التنفيذي'
    when 'sales_manager' then 'مدير المبيعات'
    when 'sales_supervisor' then 'مشرف المبيعات'
    when 'sales_user' then 'مسؤول المبيعات'
    when 'customer_service' then 'خدمة العملاء'
    when 'data_officer' then 'مسؤول البيانات'
    when 'data_analyst' then 'محلل البيانات'
    when 'training_manager' then 'مدير التدريب'
    else 'مستخدم المنشأة'
  end;

  v_snapshot := jsonb_set(
    v_snapshot,
    '{viewer,roleKey}',
    to_jsonb(v_role_key),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{viewer,roleLabel}',
    to_jsonb(v_role_label),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{viewer,name}',
    to_jsonb(coalesce(v_subject_name, v_role_label)),
    true
  );
  v_snapshot := jsonb_set(
    v_snapshot,
    '{viewer,jobTitle}',
    to_jsonb(v_role_label),
    true
  );

  if v_role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  ) then
    select jsonb_build_object(
      'activeStaff', count(*) filter (
        where staff.employment_status = 'active'
      ),
      'activeAccounts', count(*) filter (
        where staff.account_status = 'active'
      )
    )
    into v_executive
    from people.staff_profiles staff
    where staff.tenant_id = v_tenant_id;

    v_executive := coalesce(v_executive, '{}'::jsonb)
      || jsonb_build_object(
        'pipelineValueMinor', (
          select coalesce(sum(opportunity.value_minor), 0)
          from sales_core.opportunities opportunity
          where opportunity.tenant_id = v_tenant_id
            and opportunity.status = 'open'
        ),
        'wonRevenueMinor', (
          select coalesce(sum(opportunity.value_minor), 0)
          from sales_core.opportunities opportunity
          where opportunity.tenant_id = v_tenant_id
            and opportunity.status = 'won'
            and opportunity.updated_at >= date_trunc('month', now())
        ),
        'pendingAdmissions', (
          select count(*)
          from academy.registration_handoffs handoff
          where handoff.tenant_id = v_tenant_id
            and handoff.status in ('pending', 'in_review')
        ),
        'activeCourseRuns', (
          select count(*)
          from academy.course_runs course_run
          where course_run.tenant_id = v_tenant_id
            and course_run.status in ('open', 'in_progress')
        )
      );

    v_snapshot := jsonb_set(
      v_snapshot,
      '{executive}',
      v_executive,
      true
    );
    v_snapshot := jsonb_set(
      v_snapshot,
      '{permissions,executive}',
      'true'::jsonb,
      true
    );
  end if;

  return v_snapshot;
end;
$$;

revoke all on function public.v2_tenant_role_dashboard_snapshot_v2(text)
from public, anon;
grant execute on function public.v2_tenant_role_dashboard_snapshot_v2(text)
to authenticated;

comment on function public.v2_tenant_role_dashboard_snapshot_v2(text) is
  'Role dashboard with membership fallback for tenant users without staff profiles.';

commit;
