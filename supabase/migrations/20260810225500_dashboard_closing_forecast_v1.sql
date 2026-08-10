-- Add a cohort-based closing rate and a qualified-lead revenue forecast.
begin;

create index if not exists lead_assignments_tenant_staff_assigned_contact_idx
on sales_core.lead_assignments (
  tenant_id,
  assigned_staff_id,
  assigned_at,
  contact_id
);

create index if not exists registration_handoffs_verified_contact_idx
on academy.registration_handoffs (tenant_id, contact_id)
where payment_status = 'verified';

create or replace function public.v2_tenant_role_dashboard_snapshot_v4(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_snapshot jsonb;
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_role_key text;
  v_is_platform boolean := false;
  v_can_crm boolean := false;
  v_scope_staff_ids uuid[] := '{}'::uuid[];
  v_timezone text;
  v_month_date date;
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_distributed_this_month bigint := 0;
  v_paid_from_distributed bigint := 0;
  v_closing_rate numeric;
  v_qualified_leads bigint := 0;
  v_valued_qualified_leads bigint := 0;
  v_qualified_value_minor bigint := 0;
  v_expected_revenue_minor bigint;
  v_sales_patch jsonb;
begin
  -- The canonical v3 function performs tenant access checks and resolves the
  -- effective viewer role before this wrapper adds the new derived metrics.
  v_snapshot := public.v2_tenant_role_dashboard_snapshot_v3(p_slug);

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  v_role_key := coalesce(
    nullif(v_snapshot #>> '{viewer,roleKey}', ''),
    'tenant_user'
  );
  v_staff_id := nullif(
    v_snapshot #>> '{viewer,staffId}',
    ''
  )::uuid;
  v_is_platform :=
    private_app.has_platform_permission('platform.tenants.read');
  v_can_crm := coalesce(
    (v_snapshot #>> '{permissions,crm}')::boolean,
    false
  );

  if not v_can_crm then
    return v_snapshot;
  end if;

  v_scope_staff_ids := private_app.v2_metric_staff_scope(
    v_tenant.id,
    v_staff_id,
    v_role_key,
    v_is_platform
  );
  v_timezone := coalesce(nullif(v_tenant.timezone, ''), 'UTC');
  v_month_date := date_trunc(
    'month',
    now() at time zone v_timezone
  )::date;
  v_month_start := v_month_date::timestamp at time zone v_timezone;
  v_month_end := (
    v_month_date + interval '1 month'
  )::timestamp at time zone v_timezone;

  with assignment_cohort as (
    select distinct assignment.contact_id
    from sales_core.lead_assignments assignment
    where assignment.tenant_id = v_tenant.id
      and assignment.assigned_staff_id = any(v_scope_staff_ids)
      and assignment.assigned_at >= v_month_start
      and assignment.assigned_at < v_month_end
  )
  select
    count(*),
    count(*) filter (
      where exists (
        select 1
        from academy.registration_handoffs handoff
        where handoff.tenant_id = v_tenant.id
          and handoff.contact_id = assignment.contact_id
          and handoff.payment_status = 'verified'
      )
    )
  into v_distributed_this_month, v_paid_from_distributed
  from assignment_cohort assignment;

  if v_distributed_this_month > 0 then
    v_closing_rate := round(
      least(
        100.0,
        100.0 * v_paid_from_distributed
          / v_distributed_this_month
      ),
      1
    );
  end if;

  with qualified_contacts as (
    select
      contact.id,
      greatest(
        coalesce(opportunity.value_minor, course.price_minor, 0),
        0
      )::bigint as estimated_value_minor
    from sales_core.contacts contact
    left join academy.courses course
      on course.id = contact.interest_course_id
     and course.tenant_id = contact.tenant_id
    left join lateral (
      select scoped_opportunity.value_minor
      from sales_core.opportunities scoped_opportunity
      where scoped_opportunity.tenant_id = contact.tenant_id
        and scoped_opportunity.contact_id = contact.id
        and scoped_opportunity.status in ('open', 'pending_verification')
        and scoped_opportunity.value_minor > 0
      order by scoped_opportunity.updated_at desc,
        scoped_opportunity.id desc
      limit 1
    ) opportunity on true
    where contact.tenant_id = v_tenant.id
      and contact.owner_staff_id = any(v_scope_staff_ids)
      and private_app.v2_metric_is_active_contact(
        contact.status,
        contact.lead_status
      )
      and (
        contact.lead_quality in ('qualified', 'good', 'excellent')
        or contact.lead_status in (
          'interested',
          'very_interested',
          'awaiting_payment',
          'payment_submitted'
        )
      )
  )
  select
    count(*),
    count(*) filter (where contact.estimated_value_minor > 0),
    coalesce(sum(contact.estimated_value_minor), 0)
  into
    v_qualified_leads,
    v_valued_qualified_leads,
    v_qualified_value_minor
  from qualified_contacts contact;

  if v_closing_rate is not null then
    v_expected_revenue_minor := round(
      v_qualified_value_minor::numeric * v_closing_rate / 100.0
    )::bigint;
  end if;

  v_sales_patch := jsonb_build_object(
    'distributedThisMonth', v_distributed_this_month,
    'paidFromDistributedThisMonth', v_paid_from_distributed,
    'closingRate', v_closing_rate,
    -- Keep legacy consumers aligned with the corrected cohort definition.
    'conversionRate', v_closing_rate,
    'qualifiedLeads', v_qualified_leads,
    'valuedQualifiedLeads', v_valued_qualified_leads,
    'qualifiedValueMinor', v_qualified_value_minor,
    'expectedRevenueMinor', v_expected_revenue_minor,
    'forecastMethod', 'qualified_value_x_cohort_closing_rate'
  );

  return jsonb_set(
    v_snapshot,
    '{sales}',
    coalesce(v_snapshot -> 'sales', '{}'::jsonb) || v_sales_patch,
    true
  );
end;
$function$;

revoke all on function public.v2_tenant_role_dashboard_snapshot_v4(text)
from public, anon;
grant execute on function public.v2_tenant_role_dashboard_snapshot_v4(text)
to authenticated;

comment on function public.v2_tenant_role_dashboard_snapshot_v4(text) is
  'Role-scoped dashboard with same-cohort monthly closing rate and expected revenue from currently qualified lead value.';

commit;
