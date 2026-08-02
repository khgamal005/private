-- Employee-centered Yeastar extension assignment.
begin;

create or replace function public.v2_tenant_staff_extension_snapshot(
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
  v_connection communication_hub.provider_connections%rowtype;
  v_assignments jsonb := '{}'::jsonb;
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
    'tenant.people.read'
  ) then
    raise exception 'forbidden';
  end if;

  select connection.*
  into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant_id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  if v_connection.id is not null then
    v_assignments := coalesce(
      v_connection.public_config -> 'extensionAssignments',
      '{}'::jsonb
    );
    if jsonb_typeof(v_assignments) <> 'object' then
      v_assignments := '{}'::jsonb;
    end if;
  end if;

  return jsonb_build_object(
    'configured', v_connection.id is not null,
    'status', coalesce(v_connection.status, 'not_configured'),
    'monitoredExtensions', coalesce(
      v_connection.public_config ->> 'extensions',
      ''
    ),
    'extensions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'staffId', staff.id,
          'staffName', staff.full_name,
          'extension', mapping.key
        )
        order by staff.full_name, mapping.key
      )
      from jsonb_each_text(v_assignments) mapping
      join people.staff_profiles staff
        on staff.id::text = mapping.value
       and staff.tenant_id = v_tenant_id
       and staff.employment_status = 'active'
      where mapping.key ~ '^[0-9]{1,10}$'
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_assign_staff_extension(
  p_tenant_slug text,
  p_staff_id uuid,
  p_extension text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_staff_name text;
  v_connection communication_hub.provider_connections%rowtype;
  v_extension text := nullif(trim(coalesce(p_extension, '')), '');
  v_assignments jsonb := '{}'::jsonb;
  v_public_config jsonb := '{}'::jsonb;
  v_extensions text[] := '{}'::text[];
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
    'tenant.people.manage'
  ) then
    raise exception 'forbidden';
  end if;

  select staff.full_name
  into v_staff_name
  from people.staff_profiles staff
  where staff.id = p_staff_id
    and staff.tenant_id = v_tenant_id
    and staff.employment_status = 'active'
  limit 1;

  if v_staff_name is null then
    raise exception 'staff_not_found';
  end if;
  if v_extension is not null and v_extension !~ '^[0-9]{1,10}$' then
    raise exception 'yeastar_invalid_extension';
  end if;

  select connection.*
  into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant_id
    and connection.provider_key = 'yeastar_p550'
  for update;

  if v_connection.id is null then
    if v_extension is null then
      return jsonb_build_object(
        'staffId', p_staff_id,
        'extension', null,
        'configured', false
      );
    end if;
    raise exception 'yeastar_connection_not_configured';
  end if;

  v_public_config := coalesce(v_connection.public_config, '{}'::jsonb);
  v_assignments := coalesce(
    v_public_config -> 'extensionAssignments',
    '{}'::jsonb
  );
  if jsonb_typeof(v_assignments) <> 'object' then
    v_assignments := '{}'::jsonb;
  end if;

  if v_extension is not null
     and nullif(v_assignments ->> v_extension, '') is not null
     and v_assignments ->> v_extension <> p_staff_id::text then
    raise exception 'yeastar_extension_already_assigned';
  end if;

  select coalesce(
    jsonb_object_agg(entry.key, entry.value),
    '{}'::jsonb
  )
  into v_assignments
  from jsonb_each_text(v_assignments) entry
  where entry.value <> p_staff_id::text;

  if v_extension is not null then
    v_assignments := v_assignments
      || jsonb_build_object(v_extension, p_staff_id::text);
  end if;

  select coalesce(array_agg(distinct extension order by extension), '{}'::text[])
  into v_extensions
  from (
    select trim(value) as extension
    from regexp_split_to_table(
      coalesce(v_public_config ->> 'extensions', ''),
      '[,;[:space:]]+'
    ) value
    where trim(value) ~ '^[0-9]{1,10}$'
    union
    select key
    from jsonb_each_text(v_assignments)
    where key ~ '^[0-9]{1,10}$'
  ) monitored;

  v_public_config := jsonb_set(
    v_public_config,
    '{extensionAssignments}',
    v_assignments,
    true
  );
  v_public_config := jsonb_set(
    v_public_config,
    '{extensions}',
    to_jsonb(array_to_string(v_extensions, ', ')),
    true
  );

  update communication_hub.provider_connections connection
  set public_config = v_public_config,
      updated_at = now()
  where connection.id = v_connection.id;

  perform private_app.write_audit(
    'tenant.yeastar.staff_extension_assigned',
    'staff_profile',
    p_staff_id::text,
    v_tenant_id,
    jsonb_build_object(
      'staffName', v_staff_name,
      'extension', v_extension
    )
  );

  return jsonb_build_object(
    'staffId', p_staff_id,
    'extension', v_extension,
    'configured', true
  );
end;
$$;

revoke all on function public.v2_tenant_staff_extension_snapshot(text)
from public, anon;
revoke all on function public.v2_tenant_assign_staff_extension(
  text,
  uuid,
  text
) from public, anon;

grant execute on function public.v2_tenant_staff_extension_snapshot(text)
to authenticated;
grant execute on function public.v2_tenant_assign_staff_extension(
  text,
  uuid,
  text
) to authenticated;

comment on function public.v2_tenant_staff_extension_snapshot(text) is
  'Returns employee Yeastar extension assignments for the tenant team directory.';
comment on function public.v2_tenant_assign_staff_extension(text, uuid, text) is
  'Assigns one numeric Yeastar extension to one active tenant employee and keeps it monitored.';

commit;
