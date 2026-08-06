begin;

create or replace function private_app.tenant_yeastar_addon_enabled(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    private_app.tenant_addon_installed(p_tenant_id, 'yeastar')
    or private_app.tenant_addon_enabled(
      p_tenant_id,
      'addon.integration.yeastar'
    );
$$;

revoke all on function private_app.tenant_yeastar_addon_enabled(uuid)
from public, anon, authenticated;

do $migration$
begin
  if to_regprocedure(
    'private_app.yeastar_reports_snapshot_core_v2(text,timestamp with time zone,timestamp with time zone,text,text,text,integer,integer)'
  ) is null then
    if to_regprocedure(
      'public.v2_tenant_yeastar_reports_snapshot_v2(text,timestamp with time zone,timestamp with time zone,text,text,text,integer,integer)'
    ) is null then
      raise exception 'missing_yeastar_reports_snapshot_v2';
    end if;

    alter function public.v2_tenant_yeastar_reports_snapshot_v2(
      text,
      timestamptz,
      timestamptz,
      text,
      text,
      text,
      integer,
      integer
    ) set schema private_app;

    alter function private_app.v2_tenant_yeastar_reports_snapshot_v2(
      text,
      timestamptz,
      timestamptz,
      text,
      text,
      text,
      integer,
      integer
    ) rename to yeastar_reports_snapshot_core_v2;
  end if;

  if to_regprocedure(
    'private_app.yeastar_settings_snapshot_core(text)'
  ) is null then
    if to_regprocedure(
      'public.v2_tenant_yeastar_settings_snapshot(text)'
    ) is null then
      raise exception 'missing_yeastar_settings_snapshot';
    end if;

    alter function public.v2_tenant_yeastar_settings_snapshot(text)
      set schema private_app;
    alter function private_app.v2_tenant_yeastar_settings_snapshot(text)
      rename to yeastar_settings_snapshot_core;
  end if;

  if to_regprocedure(
    'private_app.yeastar_authorize_core(text,text)'
  ) is null then
    if to_regprocedure(
      'public.v2_tenant_yeastar_authorize(text,text)'
    ) is null then
      raise exception 'missing_yeastar_authorize';
    end if;

    alter function public.v2_tenant_yeastar_authorize(text, text)
      set schema private_app;
    alter function private_app.v2_tenant_yeastar_authorize(text, text)
      rename to yeastar_authorize_core;
  end if;

  if to_regprocedure(
    'private_app.yeastar_staff_options_core(text)'
  ) is null then
    if to_regprocedure(
      'public.v2_tenant_yeastar_staff_options(text)'
    ) is null then
      raise exception 'missing_yeastar_staff_options';
    end if;

    alter function public.v2_tenant_yeastar_staff_options(text)
      set schema private_app;
    alter function private_app.v2_tenant_yeastar_staff_options(text)
      rename to yeastar_staff_options_core;
  end if;
end;
$migration$;

revoke all on function private_app.yeastar_reports_snapshot_core_v2(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) from public, anon, authenticated;

revoke all on function private_app.yeastar_settings_snapshot_core(text)
from public, anon, authenticated;

revoke all on function private_app.yeastar_authorize_core(text, text)
from public, anon, authenticated;

revoke all on function private_app.yeastar_staff_options_core(text)
from public, anon, authenticated;

create or replace function public.v3_tenant_yeastar_access_snapshot(
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
  v_enabled boolean := false;
  v_can_view boolean := false;
  v_can_manage boolean := false;
  v_is_platform boolean := false;
  v_connection communication_hub.provider_connections%rowtype;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then
    raise exception 'tenant_not_found';
  end if;

  v_is_platform := (
    private_app.has_platform_permission('platform.tenants.read')
    or private_app.has_platform_permission('platform.tenants.manage')
    or private_app.has_platform_permission('platform.control.read')
    or private_app.has_platform_permission('platform.control.write')
  );
  v_can_view := (
    v_is_platform
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.crm.read'
    )
  );
  v_can_manage := (
    v_is_platform
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.settings.manage'
    )
  );

  if not (
    v_can_view
    or v_can_manage
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.workspace.read'
    )
  ) then
    raise exception 'forbidden';
  end if;

  v_enabled :=
    private_app.tenant_yeastar_addon_enabled(v_tenant_id);

  if v_enabled then
    select connection.*
    into v_connection
    from communication_hub.provider_connections connection
    where connection.tenant_id = v_tenant_id
      and connection.provider_key = 'yeastar_p550'
    limit 1;
  end if;

  return jsonb_build_object(
    'productKey', 'yeastar',
    'featureKey', 'addon.integration.yeastar',
    'enabled', v_enabled,
    'visible', v_enabled and (v_can_view or v_can_manage),
    'configured', v_enabled and v_connection.id is not null,
    'status', case
      when not v_enabled then 'addon_not_installed'
      else coalesce(v_connection.status, 'not_configured')
    end,
    'canView', v_can_view,
    'canManage', v_can_manage
  );
end;
$$;

create or replace function public.v3_tenant_yeastar_reports_snapshot(
  p_slug text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_extension text default null,
  p_call_type text default null,
  p_status text default null,
  p_limit integer default 100,
  p_offset integer default 0
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
  if not (
    private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.crm.read'
    )
    or private_app.has_tenant_permission(
      v_tenant_id,
      'tenant.settings.manage'
    )
  ) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_yeastar_addon_enabled(v_tenant_id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  return private_app.yeastar_reports_snapshot_core_v2(
    p_slug,
    p_from,
    p_to,
    p_extension,
    p_call_type,
    p_status,
    p_limit,
    p_offset
  );
end;
$$;

create or replace function public.v3_tenant_yeastar_settings_snapshot(
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
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_yeastar_addon_enabled(v_tenant_id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  return private_app.yeastar_settings_snapshot_core(p_slug);
end;
$$;

create or replace function public.v3_tenant_yeastar_authorize(
  p_tenant_slug text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
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
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_yeastar_addon_enabled(v_tenant_id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  return private_app.yeastar_authorize_core(
    p_tenant_slug,
    p_action
  );
end;
$$;

create or replace function public.v3_tenant_yeastar_staff_options(
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
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_yeastar_addon_enabled(v_tenant_id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  return private_app.yeastar_staff_options_core(p_slug);
end;
$$;

create or replace function public.v2_tenant_yeastar_action(
  p_tenant_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_actor_subject_id uuid;
  v_connection communication_hub.provider_connections%rowtype;
  v_connection_id uuid;
  v_public_config jsonb;
  v_secret_refs jsonb;
  v_secret_value text;
  v_existing_secret_id uuid;
  v_saved_secret_id uuid;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_yeastar_addon_enabled(v_tenant.id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  v_actor_subject_id := private_app.current_subject_id();
  if v_actor_subject_id is null then
    raise exception 'forbidden';
  end if;

  select *
  into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  for update;

  if p_action = 'save' then
    v_public_config := private_app.yeastar_public_config(
      coalesce(p_payload -> 'publicConfig', '{}'::jsonb)
    );

    if v_connection.id is null then
      insert into communication_hub.provider_connections (
        tenant_id,
        channel,
        provider_key,
        display_name,
        status,
        is_default,
        public_config,
        created_by_subject_id,
        updated_by_subject_id
      )
      values (
        v_tenant.id,
        'api',
        'yeastar_p550',
        coalesce(
          nullif(trim(p_payload ->> 'displayName'), ''),
          'Yeastar P550'
        ),
        'draft',
        false,
        v_public_config,
        v_actor_subject_id,
        v_actor_subject_id
      )
      returning * into v_connection;
    else
      update communication_hub.provider_connections
      set display_name = coalesce(
            nullif(trim(p_payload ->> 'displayName'), ''),
            display_name
          ),
          public_config = v_public_config,
          status = 'draft',
          last_error = null,
          updated_by_subject_id = v_actor_subject_id
      where id = v_connection.id
      returning * into v_connection;
    end if;

    v_connection_id := v_connection.id;
    v_secret_refs := coalesce(
      v_connection.secret_refs,
      '{}'::jsonb
    );

    v_secret_value :=
      nullif(p_payload #>> '{secrets,clientId}', '');
    if v_secret_value is not null then
      begin
        v_existing_secret_id :=
          nullif(v_secret_refs ->> 'clientId', '')::uuid;
      exception when invalid_text_representation then
        v_existing_secret_id := null;
      end;

      v_saved_secret_id := private_app.integration_secret_upsert(
        v_tenant.id,
        v_connection_id,
        'clientId',
        v_secret_value,
        v_existing_secret_id
      );
      v_secret_refs := jsonb_set(
        v_secret_refs,
        '{clientId}',
        to_jsonb(v_saved_secret_id::text),
        true
      );
    end if;

    v_secret_value :=
      nullif(p_payload #>> '{secrets,clientSecret}', '');
    if v_secret_value is not null then
      begin
        v_existing_secret_id :=
          nullif(v_secret_refs ->> 'clientSecret', '')::uuid;
      exception when invalid_text_representation then
        v_existing_secret_id := null;
      end;

      v_saved_secret_id := private_app.integration_secret_upsert(
        v_tenant.id,
        v_connection_id,
        'clientSecret',
        v_secret_value,
        v_existing_secret_id
      );
      v_secret_refs := jsonb_set(
        v_secret_refs,
        '{clientSecret}',
        to_jsonb(v_saved_secret_id::text),
        true
      );
    end if;

    if not (v_secret_refs ? 'clientId')
       or not (v_secret_refs ? 'clientSecret') then
      raise exception 'yeastar_credentials_required';
    end if;

    update communication_hub.provider_connections
    set secret_refs = v_secret_refs
    where id = v_connection_id;

    insert into core.integrations (
      tenant_id,
      system_type,
      display_name,
      status,
      configuration
    )
    values (
      v_tenant.id,
      'yeastar_pbx',
      v_connection.display_name,
      'draft',
      jsonb_build_object(
        'connectionId',
        v_connection_id,
        'providerKey',
        'yeastar_p550',
        'extensions',
        v_public_config ->> 'extensions'
      )
    )
    on conflict (tenant_id, system_type)
      where tenant_id is not null
    do update
    set display_name = excluded.display_name,
        status = excluded.status,
        configuration = excluded.configuration,
        last_checked_at = null,
        updated_at = now();

    perform private_app.write_audit(
      'telephony.yeastar.settings_saved',
      'provider_connection',
      v_connection_id::text,
      v_tenant.id,
      jsonb_build_object(
        'extensions', v_public_config ->> 'extensions',
        'syncIntervalMinutes',
          v_public_config ->> 'syncIntervalMinutes'
      )
    );

    return jsonb_build_object(
      'connectionId',
      v_connection_id,
      'status',
      'draft',
      'configuredSecrets',
      jsonb_build_array('clientId', 'clientSecret')
    );

  elsif p_action = 'disable' then
    if v_connection.id is null then
      raise exception 'integration_connection_not_found';
    end if;

    update communication_hub.provider_connections
    set status = 'disabled',
        last_error = null,
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection.id;

    update core.integrations
    set status = 'disabled',
        updated_at = now()
    where tenant_id = v_tenant.id
      and system_type = 'yeastar_pbx';

    return jsonb_build_object('status', 'disabled');
  else
    raise exception 'invalid_yeastar_action';
  end if;
end;
$$;

create or replace function public.v3_tenant_yeastar_action(
  p_tenant_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.v2_tenant_yeastar_action(
    p_tenant_slug,
    p_action,
    p_payload
  );
$$;

create or replace function public.v3_tenant_yeastar_save_with_assignments(
  p_tenant_slug text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
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
    'tenant.settings.manage'
  ) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_yeastar_addon_enabled(v_tenant_id) then
    raise exception 'yeastar_addon_not_enabled';
  end if;

  return public.v2_tenant_yeastar_save_with_assignments(
    p_tenant_slug,
    p_payload
  );
end;
$$;

create or replace function public.v2_tenant_yeastar_reports_snapshot_v2(
  p_slug text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_extension text default null,
  p_call_type text default null,
  p_status text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.v3_tenant_yeastar_reports_snapshot(
    p_slug,
    p_from,
    p_to,
    p_extension,
    p_call_type,
    p_status,
    p_limit,
    p_offset
  );
$$;

create or replace function public.v2_tenant_yeastar_settings_snapshot(
  p_slug text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.v3_tenant_yeastar_settings_snapshot(p_slug);
$$;

create or replace function public.v2_tenant_yeastar_authorize(
  p_tenant_slug text,
  p_action text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.v3_tenant_yeastar_authorize(
    p_tenant_slug,
    p_action
  );
$$;

create or replace function public.v2_tenant_yeastar_staff_options(
  p_slug text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.v3_tenant_yeastar_staff_options(p_slug);
$$;

revoke all on function public.v3_tenant_yeastar_access_snapshot(text)
from public, anon;
revoke all on function public.v3_tenant_yeastar_reports_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) from public, anon;
revoke all on function public.v3_tenant_yeastar_settings_snapshot(text)
from public, anon;
revoke all on function public.v3_tenant_yeastar_authorize(text, text)
from public, anon;
revoke all on function public.v3_tenant_yeastar_staff_options(text)
from public, anon;
revoke all on function public.v3_tenant_yeastar_action(
  text,
  text,
  jsonb
) from public, anon;
revoke all on function public.v3_tenant_yeastar_save_with_assignments(
  text,
  jsonb
) from public, anon;

grant execute on function public.v3_tenant_yeastar_access_snapshot(text)
to authenticated;
grant execute on function public.v3_tenant_yeastar_reports_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) to authenticated;
grant execute on function public.v3_tenant_yeastar_settings_snapshot(text)
to authenticated;
grant execute on function public.v3_tenant_yeastar_authorize(text, text)
to authenticated;
grant execute on function public.v3_tenant_yeastar_staff_options(text)
to authenticated;
grant execute on function public.v3_tenant_yeastar_action(
  text,
  text,
  jsonb
) to authenticated;
grant execute on function public.v3_tenant_yeastar_save_with_assignments(
  text,
  jsonb
) to authenticated;

revoke all on function public.v2_tenant_yeastar_reports_snapshot_v2(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) from public, anon;
revoke all on function public.v2_tenant_yeastar_settings_snapshot(text)
from public, anon;
revoke all on function public.v2_tenant_yeastar_authorize(text, text)
from public, anon;
revoke all on function public.v2_tenant_yeastar_staff_options(text)
from public, anon;
revoke all on function public.v2_tenant_yeastar_action(
  text,
  text,
  jsonb
) from public, anon;

grant execute on function public.v2_tenant_yeastar_reports_snapshot_v2(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) to authenticated;
grant execute on function public.v2_tenant_yeastar_settings_snapshot(text)
to authenticated;
grant execute on function public.v2_tenant_yeastar_authorize(text, text)
to authenticated;
grant execute on function public.v2_tenant_yeastar_staff_options(text)
to authenticated;
grant execute on function public.v2_tenant_yeastar_action(
  text,
  text,
  jsonb
) to authenticated;

comment on function public.v3_tenant_yeastar_access_snapshot(text) is
  'Returns the paid Yeastar add-on entitlement and viewer capabilities.';
comment on function public.v3_tenant_yeastar_reports_snapshot(
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  integer,
  integer
) is
  'Paid-add-on-gated Yeastar call intelligence snapshot.';
comment on function public.v3_tenant_yeastar_settings_snapshot(text) is
  'Paid-add-on-gated Yeastar settings snapshot.';
comment on function private_app.tenant_yeastar_addon_enabled(uuid) is
  'Single source of truth for Yeastar product or bundled entitlement.';

notify pgrst, 'reload schema';

commit;
