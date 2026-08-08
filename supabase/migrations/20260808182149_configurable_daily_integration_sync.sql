-- Applied migration version: 20260808182149
begin;

alter table commerce_sync.connections
  add column if not exists sync_time_local time without time zone
    not null default time '03:00',
  add column if not exists sync_timezone text
    not null default 'Asia/Riyadh';

alter table commerce_sync.connections
  alter column frequency set default 'daily';

alter table marketing_hub.connections
  add column if not exists sync_time_local time without time zone
    not null default time '03:00',
  add column if not exists sync_timezone text
    not null default 'Asia/Riyadh';

create or replace function private_app.sync_time_value(
  p_value text,
  p_default time without time zone default time '03:00'
)
returns time without time zone
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_time time without time zone;
begin
  if nullif(trim(p_value), '') is null then
    return coalesce(p_default, time '03:00');
  end if;
  begin
    v_time := trim(p_value)::time without time zone;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception 'sync_time_invalid';
  end;
  return date_trunc('minute', v_time)::time without time zone;
end;
$$;

create or replace function private_app.sync_timezone_value(
  p_value text,
  p_default text default 'Asia/Riyadh'
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_timezone text := coalesce(
    nullif(trim(p_value), ''),
    nullif(trim(p_default), ''),
    'Asia/Riyadh'
  );
begin
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone
    where timezone.name = v_timezone
  ) then
    raise exception 'sync_timezone_invalid';
  end if;
  return v_timezone;
end;
$$;

create or replace function private_app.next_scheduled_sync_at(
  p_frequency text,
  p_sync_time time without time zone,
  p_timezone text,
  p_from timestamptz default now()
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_frequency text := lower(trim(coalesce(p_frequency, 'manual')));
  v_timezone text;
  v_time time without time zone := coalesce(p_sync_time, time '03:00');
  v_local timestamp without time zone;
  v_candidate timestamp without time zone;
begin
  v_timezone := private_app.sync_timezone_value(
    p_timezone,
    'Asia/Riyadh'
  );
  if v_frequency = 'manual' then return null; end if;

  v_local := coalesce(p_from, now()) at time zone v_timezone;
  v_candidate := v_local::date + v_time;

  if v_frequency = 'every_6_hours' then
    while v_candidate <= v_local loop
      v_candidate := v_candidate + interval '6 hours';
    end loop;
  elsif v_frequency = 'daily' then
    if v_candidate <= v_local then
      v_candidate := v_candidate + interval '1 day';
    end if;
  elsif v_frequency = 'weekly' then
    if v_candidate <= v_local then
      v_candidate := v_candidate + interval '7 days';
    end if;
  elsif v_frequency = 'monthly' then
    if v_candidate <= v_local then
      v_candidate :=
        ((v_local::date + interval '1 month')::date + v_time);
    end if;
  else
    raise exception 'sync_frequency_invalid';
  end if;

  return v_candidate at time zone v_timezone;
end;
$$;

revoke all on function private_app.sync_time_value(text,time without time zone)
from public, anon, authenticated;
revoke all on function private_app.sync_timezone_value(text,text)
from public, anon, authenticated;
revoke all on function private_app.next_scheduled_sync_at(
  text,time without time zone,text,timestamptz
)
from public, anon, authenticated;

create or replace function private_app.apply_connection_sync_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.sync_time_local := coalesce(new.sync_time_local, time '03:00');
  new.sync_timezone := coalesce(
    nullif(trim(new.sync_timezone), ''),
    'Asia/Riyadh'
  );

  if new.status in ('active','degraded')
     and new.frequency <> 'manual' then
    if tg_op = 'INSERT'
       or new.frequency is distinct from old.frequency
       or new.sync_time_local is distinct from old.sync_time_local
       or new.sync_timezone is distinct from old.sync_timezone
       or new.status is distinct from old.status
       or new.last_checked_at is distinct from old.last_checked_at
       or new.last_synced_at is distinct from old.last_synced_at
       or new.next_sync_at is null then
      new.next_sync_at := private_app.next_scheduled_sync_at(
        new.frequency,
        new.sync_time_local,
        new.sync_timezone,
        now()
      );
    end if;
  else
    new.next_sync_at := null;
  end if;

  return new;
end;
$$;

revoke all on function private_app.apply_connection_sync_schedule()
from public, anon, authenticated;

drop trigger if exists apply_woocommerce_sync_schedule
on commerce_sync.connections;
create trigger apply_woocommerce_sync_schedule
before insert or update on commerce_sync.connections
for each row execute function private_app.apply_connection_sync_schedule();

drop trigger if exists apply_marketing_sync_schedule
on marketing_hub.connections;
create trigger apply_marketing_sync_schedule
before insert or update on marketing_hub.connections
for each row execute function private_app.apply_connection_sync_schedule();

create or replace function public.v2_tenant_sync_schedule_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_can_read_woocommerce boolean;
  v_can_read_marketing boolean;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;

  v_can_read_woocommerce := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.academy.read'
  );
  v_can_read_marketing := private_app.can_read_marketing_hub(v_tenant.id);

  if not v_can_read_woocommerce and not v_can_read_marketing then
    raise exception 'forbidden';
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'timezone', 'Asia/Riyadh',
    'woocommerce', case
      when not v_can_read_woocommerce then null
      else (
        select jsonb_build_object(
          'frequency', connection.frequency,
          'syncFrequency', connection.frequency,
          'syncTime', to_char(connection.sync_time_local, 'HH24:MI'),
          'syncTimezone', connection.sync_timezone,
          'nextSyncAt', connection.next_sync_at
        )
        from commerce_sync.connections connection
        where connection.tenant_id = v_tenant.id
        limit 1
      )
    end,
    'marketing', case
      when not v_can_read_marketing then '{}'::jsonb
      else coalesce((
        select jsonb_object_agg(
          connection.provider_key,
          jsonb_build_object(
            'frequency', connection.frequency,
            'syncTime', to_char(connection.sync_time_local, 'HH24:MI'),
            'syncTimezone', connection.sync_timezone,
            'nextSyncAt', connection.next_sync_at
          )
          order by connection.provider_key
        )
        from marketing_hub.connections connection
        where connection.tenant_id = v_tenant.id
      ), '{}'::jsonb)
    end
  );
end;
$$;

revoke all on function public.v2_tenant_sync_schedule_snapshot(text)
from public, anon;
grant execute on function public.v2_tenant_sync_schedule_snapshot(text)
to authenticated;

create or replace function public.v2_tenant_sync_schedule_action(
  p_tenant_slug text,
  p_domain text,
  p_provider text default null,
  p_frequency text default null,
  p_sync_time text default null,
  p_sync_timezone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_frequency text;
  v_sync_time time without time zone;
  v_timezone text;
  v_woocommerce commerce_sync.connections%rowtype;
  v_marketing marketing_hub.connections%rowtype;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;

  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'forbidden'; end if;

  if v_domain = 'woocommerce' then
    if not private_app.can_manage_woocommerce(v_tenant.id) then
      raise exception 'forbidden';
    end if;
    if not private_app.tenant_addon_enabled(
      v_tenant.id,
      'addon.integration.woocommerce'
    ) then
      raise exception 'integration_addon_not_enabled';
    end if;

    select * into v_woocommerce
    from commerce_sync.connections connection
    where connection.tenant_id = v_tenant.id
    for update;
    if v_woocommerce.id is null then
      raise exception 'woocommerce_connection_not_found';
    end if;

    v_frequency := lower(coalesce(
      nullif(trim(p_frequency), ''),
      v_woocommerce.frequency
    ));
    if v_frequency not in ('manual','daily','weekly','monthly') then
      raise exception 'woocommerce_invalid_frequency';
    end if;
    v_sync_time := private_app.sync_time_value(
      p_sync_time,
      v_woocommerce.sync_time_local
    );
    v_timezone := private_app.sync_timezone_value(
      p_sync_timezone,
      v_woocommerce.sync_timezone
    );

    update commerce_sync.connections connection
    set frequency = v_frequency,
        sync_time_local = v_sync_time,
        sync_timezone = v_timezone,
        updated_by_subject_id = v_actor,
        updated_at = now()
    where connection.id = v_woocommerce.id
    returning * into v_woocommerce;

    update core.integrations integration
    set configuration = coalesce(integration.configuration, '{}'::jsonb)
          || jsonb_build_object(
            'frequency', v_woocommerce.frequency,
            'syncTime', to_char(v_woocommerce.sync_time_local, 'HH24:MI'),
            'syncTimezone', v_woocommerce.sync_timezone
          ),
        updated_at = now()
    where integration.tenant_id = v_tenant.id
      and integration.system_type = 'woocommerce';

    perform private_app.write_audit(
      'commerce.woocommerce.schedule_saved',
      'commerce_connection',
      v_woocommerce.id::text,
      v_tenant.id,
      jsonb_build_object(
        'frequency', v_woocommerce.frequency,
        'syncTime', to_char(v_woocommerce.sync_time_local, 'HH24:MI'),
        'syncTimezone', v_woocommerce.sync_timezone,
        'nextSyncAt', v_woocommerce.next_sync_at
      )
    );

    return jsonb_build_object(
      'connectionId', v_woocommerce.id,
      'frequency', v_woocommerce.frequency,
      'syncTime', to_char(v_woocommerce.sync_time_local, 'HH24:MI'),
      'syncTimezone', v_woocommerce.sync_timezone,
      'nextSyncAt', v_woocommerce.next_sync_at
    );
  elsif v_domain = 'marketing' then
    if not private_app.can_manage_marketing_hub(v_tenant.id) then
      raise exception 'forbidden';
    end if;
    if not private_app.tenant_addon_enabled(
      v_tenant.id,
      'addon.marketing_attribution'
    ) then
      raise exception 'marketing_addon_not_enabled';
    end if;

    v_provider := private_app.marketing_provider_key(v_provider);
    select * into v_marketing
    from marketing_hub.connections connection
    where connection.tenant_id = v_tenant.id
      and connection.provider_key = v_provider
    for update;
    if v_marketing.id is null then
      raise exception 'marketing_connection_not_found';
    end if;

    v_frequency := private_app.marketing_frequency(coalesce(
      nullif(trim(p_frequency), ''),
      v_marketing.frequency
    ));
    v_sync_time := private_app.sync_time_value(
      p_sync_time,
      v_marketing.sync_time_local
    );
    v_timezone := private_app.sync_timezone_value(
      p_sync_timezone,
      v_marketing.sync_timezone
    );

    update marketing_hub.connections connection
    set frequency = v_frequency,
        sync_time_local = v_sync_time,
        sync_timezone = v_timezone,
        updated_by_subject_id = v_actor,
        updated_at = now()
    where connection.id = v_marketing.id
    returning * into v_marketing;

    update core.integrations integration
    set configuration = coalesce(integration.configuration, '{}'::jsonb)
          || jsonb_build_object(
            'frequency', v_marketing.frequency,
            'syncTime', to_char(v_marketing.sync_time_local, 'HH24:MI'),
            'syncTimezone', v_marketing.sync_timezone
          ),
        updated_at = now()
    where integration.tenant_id = v_tenant.id
      and integration.system_type = 'marketing_' || v_marketing.provider_key;

    perform private_app.write_audit(
      'marketing.connection.schedule_saved',
      'marketing_connection',
      v_marketing.id::text,
      v_tenant.id,
      jsonb_build_object(
        'providerKey', v_marketing.provider_key,
        'frequency', v_marketing.frequency,
        'syncTime', to_char(v_marketing.sync_time_local, 'HH24:MI'),
        'syncTimezone', v_marketing.sync_timezone,
        'nextSyncAt', v_marketing.next_sync_at
      )
    );

    return jsonb_build_object(
      'connectionId', v_marketing.id,
      'providerKey', v_marketing.provider_key,
      'frequency', v_marketing.frequency,
      'syncTime', to_char(v_marketing.sync_time_local, 'HH24:MI'),
      'syncTimezone', v_marketing.sync_timezone,
      'nextSyncAt', v_marketing.next_sync_at
    );
  end if;

  raise exception 'sync_domain_invalid';
end;
$$;

revoke all on function public.v2_tenant_sync_schedule_action(
  text,text,text,text,text,text
)
from public, anon;
grant execute on function public.v2_tenant_sync_schedule_action(
  text,text,text,text,text,text
)
to authenticated;

create or replace function public.v3_tenant_woocommerce_action(
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
  v_result jsonb;
  v_schedule jsonb;
begin
  v_result := public.v2_tenant_woocommerce_action(
    p_tenant_slug,
    p_action,
    p_payload
  );
  if lower(trim(coalesce(p_action, ''))) = 'save' then
    v_schedule := public.v2_tenant_sync_schedule_action(
      p_tenant_slug,
      'woocommerce',
      null,
      p_payload ->> 'frequency',
      p_payload ->> 'syncTime',
      p_payload ->> 'syncTimezone'
    );
    v_result := coalesce(v_result, '{}'::jsonb) || v_schedule;
  end if;
  return v_result;
end;
$$;

revoke all on function public.v3_tenant_woocommerce_action(text,text,jsonb)
from public, anon;
grant execute on function public.v3_tenant_woocommerce_action(text,text,jsonb)
to authenticated;

create or replace function public.v3_tenant_marketing_hub_action(
  p_tenant_slug text,
  p_provider text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_schedule jsonb;
begin
  v_result := public.v2_tenant_marketing_hub_action(
    p_tenant_slug,
    p_provider,
    p_action,
    p_payload
  );
  if lower(trim(coalesce(p_action, ''))) = 'save' then
    v_schedule := public.v2_tenant_sync_schedule_action(
      p_tenant_slug,
      'marketing',
      p_provider,
      p_payload ->> 'frequency',
      p_payload ->> 'syncTime',
      p_payload ->> 'syncTimezone'
    );
    v_result := coalesce(v_result, '{}'::jsonb) || v_schedule;
  end if;
  return v_result;
end;
$$;

revoke all on function public.v3_tenant_marketing_hub_action(
  text,text,text,jsonb
)
from public, anon;
grant execute on function public.v3_tenant_marketing_hub_action(
  text,text,text,jsonb
)
to authenticated;

create or replace function public.v2_woocommerce_due_connections()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  with due as (
    select connection.id
    from commerce_sync.connections connection
    where connection.status in ('active','degraded')
      and connection.frequency <> 'manual'
      and connection.next_sync_at <= now()
      and connection.secret_refs ? 'consumerKey'
      and connection.secret_refs ? 'consumerSecret'
      and private_app.tenant_addon_enabled(
        connection.tenant_id,
        'addon.integration.woocommerce'
      )
    order by connection.next_sync_at, connection.id
    for update skip locked
    limit 5
  ), leased as (
    update commerce_sync.connections connection
    set next_sync_at = now() + interval '30 minutes'
    from due
    where connection.id = due.id
    returning connection.id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('connectionId', leased.id)
      order by leased.id
    ),
    '[]'::jsonb
  )
  into v_result
  from leased;

  return v_result;
end;
$$;

revoke all on function public.v2_woocommerce_due_connections()
from public, anon, authenticated;
grant execute on function public.v2_woocommerce_due_connections()
to service_role;

do $secret$
begin
  if not exists (
    select 1
    from vault.secrets secret
    where secret.name = 'marketing_dispatch_secret'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'marketing_dispatch_secret',
      'Authorizes the scheduled marketing synchronization dispatcher.'
    );
  end if;
end;
$secret$;

create or replace function public.v2_marketing_schedule_authorize(
  p_secret text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets secret
    where secret.name = 'marketing_dispatch_secret'
      and secret.decrypted_secret = p_secret
  );
$$;

revoke all on function public.v2_marketing_schedule_authorize(text)
from public, anon, authenticated;
grant execute on function public.v2_marketing_schedule_authorize(text)
to service_role;

update commerce_sync.connections connection
set frequency = 'daily',
    sync_time_local = time '03:00',
    sync_timezone = 'Asia/Riyadh',
    updated_at = now()
where connection.tenant_id = (
    select tenant.id
    from core.tenants tenant
    where tenant.slug = 'reef-skills'
    limit 1
  )
  and connection.frequency = 'weekly';

update commerce_sync.connections connection
set next_sync_at = private_app.next_scheduled_sync_at(
  connection.frequency,
  connection.sync_time_local,
  connection.sync_timezone,
  now()
)
where connection.status in ('active','degraded')
  and connection.frequency <> 'manual';

update marketing_hub.connections connection
set next_sync_at = private_app.next_scheduled_sync_at(
  connection.frequency,
  connection.sync_time_local,
  connection.sync_timezone,
  now()
)
where connection.status in ('active','degraded')
  and connection.frequency <> 'manual';

do $schedule$
declare
  v_job_id bigint;
begin
  select job.jobid into v_job_id
  from cron.job job
  where job.jobname = 'marktone-woocommerce-sync'
  limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'marktone-woocommerce-sync',
    '*/5 * * * *',
    $command$
      select net.http_post(
        url :=
          'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
          || 'woocommerce-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-marktone-woocommerce-secret',
          (
            select secret.decrypted_secret
            from vault.decrypted_secrets secret
            where secret.name = 'woocommerce_dispatch_secret'
          )
        ),
        body := jsonb_build_object(
          'action', 'scheduled_sync',
          'requestedAt', now()
        ),
        timeout_milliseconds := 150000
      ) as request_id;
    $command$
  );

  select job.jobid into v_job_id
  from cron.job job
  where job.jobname = 'marktone-marketing-sync'
  limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'marktone-marketing-sync',
    '*/5 * * * *',
    $command$
      select net.http_post(
        url :=
          'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
          || 'ads-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-marktone-marketing-secret',
          (
            select secret.decrypted_secret
            from vault.decrypted_secrets secret
            where secret.name = 'marketing_dispatch_secret'
          )
        ),
        body := jsonb_build_object(
          'action', 'dispatch_due',
          'limit', 3,
          'requestedAt', now()
        ),
        timeout_milliseconds := 150000
      ) as request_id;
    $command$
  );
end;
$schedule$;

commit;
