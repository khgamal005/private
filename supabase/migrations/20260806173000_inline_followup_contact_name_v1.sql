begin;

create or replace function public.v2_tenant_record_sales_followup_v3(
  p_tenant_slug text,
  p_contact_id uuid,
  p_activity_type text,
  p_summary text,
  p_lead_status text,
  p_lead_quality text default 'unrated',
  p_next_action_type text default null,
  p_next_action_at timestamptz default null,
  p_course_id uuid default null,
  p_course_run_id uuid default null,
  p_payment_amount_minor bigint default null,
  p_payment_reference text default null,
  p_preferred_start_date date default null,
  p_closure_reason text default null,
  p_contact_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_clean_name text;
  v_name_changed boolean;
  v_result jsonb;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then
    raise exception 'forbidden';
  end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then
    raise exception 'invalid_contact';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  if p_contact_name is null then
    v_clean_name := v_contact.full_name;
  else
    v_clean_name := nullif(btrim(p_contact_name), '');
    if v_clean_name is null or length(v_clean_name) < 2 then
      raise exception 'contact_name_required';
    end if;
    if length(v_clean_name) > 150 then
      raise exception 'contact_name_too_long';
    end if;
  end if;

  v_name_changed := v_contact.full_name is distinct from v_clean_name;
  if v_name_changed then
    update sales_core.contacts
    set full_name = v_clean_name
    where id = v_contact.id
      and tenant_id = v_tenant_id;
  end if;

  v_result := public.v2_tenant_record_sales_followup_v2(
    p_tenant_slug => p_tenant_slug,
    p_contact_id => p_contact_id,
    p_activity_type => p_activity_type,
    p_summary => p_summary,
    p_lead_status => p_lead_status,
    p_lead_quality => p_lead_quality,
    p_next_action_type => p_next_action_type,
    p_next_action_at => p_next_action_at,
    p_course_id => p_course_id,
    p_course_run_id => p_course_run_id,
    p_payment_amount_minor => p_payment_amount_minor,
    p_payment_reference => p_payment_reference,
    p_preferred_start_date => p_preferred_start_date,
    p_closure_reason => p_closure_reason
  );

  if v_name_changed then
    perform private_app.write_audit(
      'tenant.sales_contact_name_updated',
      'sales_contact',
      p_contact_id::text,
      v_tenant_id,
      jsonb_build_object(
        'oldName', v_contact.full_name,
        'newName', v_clean_name,
        'source', 'sales_followup'
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'contactName', v_clean_name,
    'nameUpdated', v_name_changed
  );
end;
$$;

revoke all on function public.v2_tenant_record_sales_followup_v3(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text,
  text
) from public, anon;

grant execute on function public.v2_tenant_record_sales_followup_v3(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text,
  text
) to authenticated, service_role;

comment on function public.v2_tenant_record_sales_followup_v3(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  uuid,
  uuid,
  bigint,
  text,
  date,
  text,
  text
) is
'Atomically updates an assigned sales contact name and records the follow-up.';

commit;
