begin;

create or replace function public.v2_tenant_update_sales_contact_v1(
  p_tenant_slug text,
  p_contact_id uuid,
  p_full_name text,
  p_phone text default null,
  p_whatsapp text default null,
  p_email text default null,
  p_organization_name text default null,
  p_interest_course_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_previous_contact sales_core.contacts%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_name text;
  v_phone text;
  v_whatsapp text;
  v_email text;
  v_organization text;
  v_notes text;
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id::text, 1729)
  );

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

  v_previous_contact := v_contact;

  v_name := nullif(pg_catalog.btrim(p_full_name), '');
  v_phone := private_app.normalize_lead_phone(p_phone);
  v_whatsapp := private_app.normalize_lead_phone(p_whatsapp);
  v_email := nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), '');
  v_organization := nullif(pg_catalog.btrim(p_organization_name), '');
  v_notes := nullif(pg_catalog.btrim(p_notes), '');

  if v_name is null or pg_catalog.length(v_name) < 2 then
    raise exception 'contact_name_required';
  end if;
  if pg_catalog.length(v_name) > 150 then
    raise exception 'contact_name_too_long';
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_phone, '')), '') is not null
     and v_phone is null then
    raise exception 'invalid_phone';
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_whatsapp, '')), '') is not null
     and v_whatsapp is null then
    raise exception 'invalid_whatsapp';
  end if;
  if v_phone is null and v_whatsapp is null and v_email is null then
    raise exception 'contact_identity_required';
  end if;
  if v_email is not null
     and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;
  if pg_catalog.length(coalesce(v_organization, '')) > 200 then
    raise exception 'organization_name_too_long';
  end if;
  if pg_catalog.length(coalesce(v_notes, '')) > 2000 then
    raise exception 'contact_notes_too_long';
  end if;

  if p_interest_course_id is not null and not exists (
    select 1
    from academy.courses course
    where course.id = p_interest_course_id
      and course.tenant_id = v_tenant_id
      and course.status <> 'archived'
  ) then
    raise exception 'invalid_course';
  end if;

  if exists (
    select 1
    from sales_core.contact_identities identity
    where identity.tenant_id = v_tenant_id
      and identity.contact_id <> v_contact.id
      and (
        (
          identity.identity_type = 'phone'
          and identity.identity_value in (v_phone, v_whatsapp)
        )
        or (
          identity.identity_type = 'email'
          and identity.identity_value = v_email
        )
      )
  ) then
    raise exception 'duplicate_contact_identity';
  end if;

  update sales_core.contacts
  set full_name = v_name,
      phone = v_phone,
      whatsapp = v_whatsapp,
      email = v_email,
      organization_name = v_organization,
      interest_course_id = p_interest_course_id,
      notes = v_notes
  where id = v_contact.id
    and tenant_id = v_tenant_id
  returning * into v_contact;

  perform private_app.write_audit(
    'tenant.sales_contact_updated',
    'sales_contact',
    v_contact.id::text,
    v_tenant_id,
    jsonb_build_object(
      'old', jsonb_build_object(
        'name', v_previous_contact.full_name,
        'phone', v_previous_contact.phone,
        'whatsapp', v_previous_contact.whatsapp,
        'email', v_previous_contact.email,
        'organizationName', v_previous_contact.organization_name,
        'courseId', v_previous_contact.interest_course_id,
        'notes', v_previous_contact.notes
      ),
      'new', jsonb_build_object(
        'name', v_contact.full_name,
        'phone', v_contact.phone,
        'whatsapp', v_contact.whatsapp,
        'email', v_contact.email,
        'organizationName', v_contact.organization_name,
        'courseId', v_contact.interest_course_id,
        'notes', v_contact.notes
      ),
      'source', 'tenant_customer_editor'
    )
  );

  return jsonb_build_object(
    'id', v_contact.id,
    'name', v_contact.full_name,
    'phone', v_contact.phone,
    'whatsapp', v_contact.whatsapp,
    'email', v_contact.email,
    'organizationName', v_contact.organization_name,
    'interestCourseId', v_contact.interest_course_id,
    'notes', v_contact.notes
  );
end;
$$;

revoke all on function public.v2_tenant_update_sales_contact_v1(
  text, uuid, text, text, text, text, text, uuid, text
) from public, anon;

grant execute on function public.v2_tenant_update_sales_contact_v1(
  text, uuid, text, text, text, text, text, uuid, text
) to authenticated, service_role;

create or replace function public.v2_tenant_customer_history_snapshot_v2(
  p_slug text,
  p_contact_id uuid,
  p_limit integer default 250
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_notes text;
begin
  v_result := public.v2_tenant_customer_history_snapshot(
    p_slug,
    p_contact_id,
    p_limit
  );

  select contact.notes
  into v_notes
  from sales_core.contacts contact
  join core.tenants tenant on tenant.id = contact.tenant_id
  where tenant.slug = p_slug
    and contact.id = p_contact_id
  limit 1;

  return pg_catalog.jsonb_set(
    v_result,
    '{contact,notes}',
    coalesce(pg_catalog.to_jsonb(v_notes), 'null'::jsonb),
    true
  );
end;
$$;

revoke all on function public.v2_tenant_customer_history_snapshot_v2(
  text, uuid, integer
) from public, anon;

grant execute on function public.v2_tenant_customer_history_snapshot_v2(
  text, uuid, integer
) to authenticated, service_role;

comment on function public.v2_tenant_update_sales_contact_v1(
  text, uuid, text, text, text, text, text, uuid, text
) is
'Updates safe customer fields for assigned tenant CRM users and reuses the canonical identity guard.';

comment on function public.v2_tenant_customer_history_snapshot_v2(
  text, uuid, integer
) is
'Extends the complete customer timeline with the current persistent customer note.';

commit;
