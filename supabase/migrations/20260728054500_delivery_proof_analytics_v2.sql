begin;

alter table communication_hub.message_outbox
  add column delivery_state text not null default 'queued'
    check (
      delivery_state in (
        'queued',
        'accepted',
        'delivered',
        'read',
        'simulated',
        'failed',
        'bounced',
        'complained',
        'cancelled'
      )
    ),
  add column delivery_updated_at timestamptz,
  add column delivered_at timestamptz,
  add column read_at timestamptz;

alter table academy.training_automation_jobs
  add column delivery_state text not null default 'queued'
    check (
      delivery_state in (
        'queued',
        'accepted',
        'delivered',
        'read',
        'simulated',
        'failed',
        'bounced',
        'complained',
        'cancelled'
      )
    ),
  add column delivery_updated_at timestamptz,
  add column delivered_at timestamptz,
  add column read_at timestamptz;

update communication_hub.message_outbox
set delivery_state = case status
      when 'sent' then 'accepted'
      when 'simulated' then 'simulated'
      when 'failed' then 'failed'
      when 'cancelled' then 'cancelled'
      else 'queued'
    end,
    delivery_updated_at = coalesce(processed_at, updated_at);

update academy.training_automation_jobs
set delivery_state = case status
      when 'sent' then 'accepted'
      when 'simulated' then 'simulated'
      when 'failed' then 'failed'
      when 'cancelled' then 'cancelled'
      else 'queued'
    end,
    delivery_updated_at = coalesce(processed_at, updated_at);

create or replace function private_app.sync_delivery_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.delivery_state := case new.status
    when 'sent' then 'accepted'
    when 'simulated' then 'simulated'
    when 'failed' then 'failed'
    when 'cancelled' then 'cancelled'
    else 'queued'
  end;
  new.delivery_updated_at := now();
  return new;
end;
$$;

revoke all on function private_app.sync_delivery_state()
from public, anon, authenticated;

create trigger message_outbox_sync_delivery_state
before insert or update of status
on communication_hub.message_outbox
for each row execute function private_app.sync_delivery_state();

create trigger training_jobs_sync_delivery_state
before insert or update of status
on academy.training_automation_jobs
for each row execute function private_app.sync_delivery_state();

create table communication_hub.delivery_webhooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references communication_hub.provider_connections(id)
    on delete cascade,
  secret_id uuid not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'error')),
  last_received_at timestamptz,
  last_error text,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id)
);

create table communication_hub.delivery_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  webhook_id uuid not null
    references communication_hub.delivery_webhooks(id)
    on delete cascade,
  provider_connection_id uuid not null
    references communication_hub.provider_connections(id)
    on delete cascade,
  message_outbox_id uuid
    references communication_hub.message_outbox(id)
    on delete set null,
  training_job_id uuid
    references academy.training_automation_jobs(id)
    on delete set null,
  provider_event_id text not null,
  external_id text,
  state text not null
    check (
      state in (
        'accepted',
        'delivered',
        'read',
        'simulated',
        'failed',
        'bounced',
        'complained'
      )
    ),
  occurred_at timestamptz not null,
  cost_minor bigint not null default 0
    check (cost_minor between 0 and 1000000000),
  currency text not null default 'SAR'
    check (currency ~ '^[A-Z]{3}$'),
  billable boolean not null default false,
  payload_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (provider_connection_id, provider_event_id),
  check (
    message_outbox_id is null
    or training_job_id is null
  )
);

create index delivery_webhooks_tenant_idx
on communication_hub.delivery_webhooks (tenant_id, status);

create index delivery_webhooks_creator_reference_idx
on communication_hub.delivery_webhooks (created_by_subject_id)
where created_by_subject_id is not null;

create index delivery_webhooks_updater_reference_idx
on communication_hub.delivery_webhooks (updated_by_subject_id)
where updated_by_subject_id is not null;

create index delivery_events_tenant_time_idx
on communication_hub.delivery_events (
  tenant_id,
  occurred_at desc
);

create index delivery_events_webhook_reference_idx
on communication_hub.delivery_events (webhook_id);

create index delivery_events_outbox_reference_idx
on communication_hub.delivery_events (message_outbox_id)
where message_outbox_id is not null;

create index delivery_events_training_reference_idx
on communication_hub.delivery_events (training_job_id)
where training_job_id is not null;

create index message_outbox_delivery_analytics_idx
on communication_hub.message_outbox (
  tenant_id,
  delivery_state,
  created_at desc
);

create index training_jobs_delivery_analytics_idx
on academy.training_automation_jobs (
  tenant_id,
  delivery_state,
  created_at desc
);

create trigger delivery_webhooks_set_updated_at
before update on communication_hub.delivery_webhooks
for each row execute function private_app.set_updated_at();

alter table communication_hub.delivery_webhooks
enable row level security;

alter table communication_hub.delivery_events
enable row level security;

create policy delivery_webhooks_isolated_read
on communication_hub.delivery_webhooks
for select to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy delivery_events_isolated_read
on communication_hub.delivery_events
for select to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table communication_hub.delivery_webhooks
from public, anon, authenticated;

revoke all on table communication_hub.delivery_events
from public, anon, authenticated;

do $seed_delivery_webhooks$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_webhook_id uuid;
  v_secret text;
  v_secret_id uuid;
begin
  for v_connection in
    select connection.*
    from communication_hub.provider_connections connection
    where connection.status <> 'disabled'
  loop
    v_webhook_id := gen_random_uuid();
    v_secret := encode(extensions.gen_random_bytes(32), 'hex');
    v_secret_id := private_app.integration_secret_upsert(
      v_connection.tenant_id,
      v_connection.id,
      'deliveryWebhookSecret',
      v_secret,
      null
    );
    insert into communication_hub.delivery_webhooks (
      id,
      tenant_id,
      connection_id,
      secret_id
    )
    values (
      v_webhook_id,
      v_connection.tenant_id,
      v_connection.id,
      v_secret_id
    )
    on conflict (connection_id) do nothing;
  end loop;
end;
$seed_delivery_webhooks$;

create or replace function private_app.delivery_state_rank(
  p_state text
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_state
    when 'queued' then 10
    when 'accepted' then 20
    when 'simulated' then 25
    when 'delivered' then 30
    when 'read' then 40
    when 'failed' then 50
    when 'bounced' then 60
    when 'complained' then 70
    when 'cancelled' then 80
    else 0
  end;
$$;

revoke all on function private_app.delivery_state_rank(text)
from public, anon, authenticated;

create or replace function public.v2_delivery_webhook_receive(
  p_webhook_id uuid,
  p_timestamp text,
  p_signature text,
  p_raw_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_webhook communication_hub.delivery_webhooks%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_secret text;
  v_expected text;
  v_provided text;
  v_received_at timestamptz;
  v_payload jsonb;
  v_state text;
  v_provider_event_id text;
  v_external_id text;
  v_occurred_at timestamptz;
  v_cost_minor bigint;
  v_currency text;
  v_billable boolean;
  v_outbox_id uuid;
  v_training_id uuid;
  v_event_id uuid;
  v_duplicate boolean := false;
begin
  select webhook.*
  into v_webhook
  from communication_hub.delivery_webhooks webhook
  where webhook.id = p_webhook_id
    and webhook.status = 'active'
  limit 1;
  if v_webhook.id is null then raise exception 'forbidden'; end if;

  select connection.*
  into v_connection
  from communication_hub.provider_connections connection
  where connection.id = v_webhook.connection_id
    and connection.status <> 'disabled'
  limit 1;
  if v_connection.id is null then raise exception 'forbidden'; end if;

  if p_timestamp !~ '^[0-9]{10}$' then
    raise exception 'forbidden';
  end if;
  v_received_at := to_timestamp(p_timestamp::double precision);
  if abs(extract(epoch from (now() - v_received_at))) > 300 then
    raise exception 'forbidden';
  end if;

  select secret.decrypted_secret
  into v_secret
  from vault.decrypted_secrets secret
  where secret.id = v_webhook.secret_id;
  if v_secret is null then raise exception 'forbidden'; end if;

  v_expected := encode(
    extensions.hmac(
      convert_to(p_timestamp || '.' || p_raw_body, 'utf8'),
      convert_to(v_secret, 'utf8'),
      'sha256'
    ),
    'hex'
  );
  v_provided := lower(
    replace(coalesce(p_signature, ''), 'sha256=', '')
  );
  if extensions.digest(v_expected, 'sha256')
     <> extensions.digest(v_provided, 'sha256') then
    raise exception 'forbidden';
  end if;

  begin
    v_payload := p_raw_body::jsonb;
  exception when others then
    raise exception 'invalid_delivery_payload';
  end;

  v_state := lower(nullif(trim(v_payload ->> 'state'), ''));
  if coalesce(v_state, '') not in (
    'accepted',
    'delivered',
    'read',
    'simulated',
    'failed',
    'bounced',
    'complained'
  ) then raise exception 'invalid_delivery_state'; end if;

  v_provider_event_id := nullif(
    trim(v_payload ->> 'providerEventId'),
    ''
  );
  if v_provider_event_id is null
     or length(v_provider_event_id) > 200 then
    raise exception 'invalid_provider_event';
  end if;
  v_external_id := nullif(trim(v_payload ->> 'externalId'), '');
  if length(coalesce(v_external_id, '')) > 240 then
    raise exception 'invalid_provider_event';
  end if;

  begin
    v_occurred_at := coalesce(
      nullif(v_payload ->> 'occurredAt', '')::timestamptz,
      now()
    );
  exception when others then
    raise exception 'invalid_delivery_timestamp';
  end;
  if v_occurred_at > now() + interval '5 minutes'
     or v_occurred_at < now() - interval '365 days' then
    raise exception 'invalid_delivery_timestamp';
  end if;

  begin
    v_cost_minor := least(
      greatest(coalesce((v_payload ->> 'costMinor')::bigint, 0), 0),
      1000000000
    );
  exception when others then
    raise exception 'invalid_delivery_cost';
  end;
  v_currency := upper(coalesce(
    nullif(trim(v_payload ->> 'currency'), ''),
    'SAR'
  ));
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid_delivery_currency';
  end if;
  v_billable := coalesce(
    (v_payload ->> 'billable')::boolean,
    v_cost_minor > 0
  );

  if v_external_id is not null then
    select job.id
    into v_outbox_id
    from communication_hub.message_outbox job
    where job.tenant_id = v_webhook.tenant_id
      and job.provider_connection_id = v_webhook.connection_id
      and job.external_id = v_external_id
    order by job.created_at desc
    limit 1;

    if v_outbox_id is null then
      select job.id
      into v_training_id
      from academy.training_automation_jobs job
      where job.tenant_id = v_webhook.tenant_id
        and job.external_id = v_external_id
        and job.metadata ->> 'providerConnectionId'
          = v_webhook.connection_id::text
      order by job.created_at desc
      limit 1;
    end if;
  end if;

  insert into communication_hub.delivery_events (
    tenant_id,
    webhook_id,
    provider_connection_id,
    message_outbox_id,
    training_job_id,
    provider_event_id,
    external_id,
    state,
    occurred_at,
    cost_minor,
    currency,
    billable,
    payload_summary
  )
  values (
    v_webhook.tenant_id,
    v_webhook.id,
    v_webhook.connection_id,
    v_outbox_id,
    v_training_id,
    v_provider_event_id,
    v_external_id,
    v_state,
    v_occurred_at,
    v_cost_minor,
    v_currency,
    v_billable,
    jsonb_strip_nulls(jsonb_build_object(
      'providerStatus', left(v_payload ->> 'providerStatus', 120),
      'detail', left(v_payload ->> 'detail', 300),
      'source', coalesce(
        nullif(v_payload ->> 'source', ''),
        'signed_webhook'
      ),
      'matched', v_outbox_id is not null or v_training_id is not null
    ))
  )
  on conflict (provider_connection_id, provider_event_id)
  do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select event.id
    into v_event_id
    from communication_hub.delivery_events event
    where event.provider_connection_id = v_webhook.connection_id
      and event.provider_event_id = v_provider_event_id;
    v_duplicate := true;
  else
    if v_outbox_id is not null then
      update communication_hub.message_outbox job
      set delivery_state = v_state,
          delivery_updated_at = v_occurred_at,
          delivered_at = case
            when v_state in ('delivered', 'read')
              then coalesce(job.delivered_at, v_occurred_at)
            else job.delivered_at
          end,
          read_at = case
            when v_state = 'read'
              then coalesce(job.read_at, v_occurred_at)
            else job.read_at
          end,
          metadata = job.metadata || jsonb_build_object(
            'deliveryState', v_state,
            'deliveryEventId', v_event_id
          )
      where job.id = v_outbox_id
        and private_app.delivery_state_rank(v_state)
          >= private_app.delivery_state_rank(job.delivery_state);
    elsif v_training_id is not null then
      update academy.training_automation_jobs job
      set delivery_state = v_state,
          delivery_updated_at = v_occurred_at,
          delivered_at = case
            when v_state in ('delivered', 'read')
              then coalesce(job.delivered_at, v_occurred_at)
            else job.delivered_at
          end,
          read_at = case
            when v_state = 'read'
              then coalesce(job.read_at, v_occurred_at)
            else job.read_at
          end,
          metadata = job.metadata || jsonb_build_object(
            'deliveryState', v_state,
            'deliveryEventId', v_event_id
          )
      where job.id = v_training_id
        and private_app.delivery_state_rank(v_state)
          >= private_app.delivery_state_rank(job.delivery_state);
    end if;

    update communication_hub.delivery_webhooks
    set last_received_at = now(),
        last_error = null
    where id = v_webhook.id;

    insert into audit_log.events (
      tenant_id,
      action,
      resource_type,
      resource_id,
      context
    )
    values (
      v_webhook.tenant_id,
      'communication.delivery.' || v_state,
      'delivery_event',
      v_event_id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'providerKey', v_connection.provider_key,
        'channel', v_connection.channel,
        'messageMatched',
          v_outbox_id is not null or v_training_id is not null,
        'billable', v_billable,
        'costMinor', v_cost_minor,
        'currency', v_currency
      ))
    );
  end if;

  return jsonb_build_object(
    'eventId', v_event_id,
    'state', v_state,
    'duplicate', v_duplicate,
    'matched', v_outbox_id is not null or v_training_id is not null
  );
end;
$$;

revoke execute on function public.v2_delivery_webhook_receive(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.v2_delivery_webhook_receive(
  uuid,
  text,
  text,
  text
) to service_role;

create or replace function public.v2_training_automation_complete_job_v2(
  p_secret text,
  p_job_id uuid,
  p_result_state text,
  p_external_id text default null,
  p_external_url text default null,
  p_error text default null,
  p_provider_connection_id uuid default null,
  p_provider_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job academy.training_automation_jobs%rowtype;
  v_result jsonb;
begin
  if p_result_state <> 'simulated' then
    v_result := public.v2_training_automation_complete_job(
      p_secret,
      p_job_id,
      p_result_state,
      p_external_id,
      p_external_url,
      p_error
    );
    if p_provider_connection_id is not null
       or nullif(p_provider_key, '') is not null then
      update academy.training_automation_jobs
      set metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
        'providerConnectionId', p_provider_connection_id,
        'providerKey', nullif(p_provider_key, '')
      ))
      where id = p_job_id;
    end if;
    return v_result;
  end if;

  if not private_app.training_automation_secret_valid(p_secret) then
    raise exception 'forbidden';
  end if;

  select *
  into v_job
  from academy.training_automation_jobs job
  where job.id = p_job_id
  for update;
  if v_job.id is null then raise exception 'automation_job_not_found'; end if;

  update academy.training_automation_jobs
  set status = 'simulated',
      external_id = nullif(p_external_id, ''),
      external_url = nullif(p_external_url, ''),
      last_error = null,
      locked_at = null,
      processed_at = now(),
      metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
        'deliveryMode', 'marktone_sandbox',
        'providerConnectionId', p_provider_connection_id,
        'providerKey', p_provider_key,
        'truthLabel', 'simulated_not_sent_to_recipient'
      ))
  where id = v_job.id
  returning * into v_job;

  insert into audit_log.events (
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_job.tenant_id,
    'training.automation.dispatch_simulated',
    'training_automation_job',
    v_job.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'jobType', v_job.job_type,
      'channel', v_job.channel,
      'externalId', v_job.external_id,
      'providerConnectionId', p_provider_connection_id,
      'providerKey', p_provider_key,
      'sentToRecipient', false
    ))
  );

  return jsonb_build_object(
    'jobId', v_job.id,
    'status', v_job.status,
    'attempts', v_job.attempts,
    'sentToRecipient', false
  );
end;
$$;

revoke execute on function public.v2_training_automation_complete_job_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text
) from public, anon, authenticated;

grant execute on function public.v2_training_automation_complete_job_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  text
) to service_role;

create or replace function public.v2_tenant_delivery_analytics_snapshot(
  p_slug text,
  p_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_days integer;
  v_since timestamptz;
  v_summary jsonb;
  v_channels jsonb;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  v_days := least(greatest(coalesce(p_days, 30), 1), 90);
  v_since := now() - make_interval(days => v_days);

  with facts as (
    select
      job.channel,
      job.delivery_state,
      job.created_at
    from communication_hub.message_outbox job
    where job.tenant_id = v_tenant.id
      and job.created_at >= v_since
    union all
    select
      job.channel,
      job.delivery_state,
      job.created_at
    from academy.training_automation_jobs job
    where job.tenant_id = v_tenant.id
      and job.channel in ('whatsapp', 'email')
      and job.created_at >= v_since
  )
  select jsonb_build_object(
    'messages', count(*),
    'accepted', count(*) filter (
      where delivery_state in ('accepted', 'delivered', 'read')
    ),
    'delivered', count(*) filter (
      where delivery_state in ('delivered', 'read')
    ),
    'read', count(*) filter (where delivery_state = 'read'),
    'simulated', count(*) filter (where delivery_state = 'simulated'),
    'failed', count(*) filter (
      where delivery_state in ('failed', 'bounced', 'complained')
    ),
    'bounced', count(*) filter (where delivery_state = 'bounced'),
    'complained', count(*) filter (where delivery_state = 'complained'),
    'deliveryRate', case
      when count(*) filter (
        where delivery_state not in ('queued', 'simulated', 'cancelled')
      ) = 0 then 0
      else round(
        100.0 * count(*) filter (
          where delivery_state in ('delivered', 'read')
        ) / count(*) filter (
          where delivery_state not in (
            'queued',
            'simulated',
            'cancelled'
          )
        ),
        1
      )
    end
  )
  into v_summary
  from facts;

  with facts as (
    select job.channel, job.delivery_state
    from communication_hub.message_outbox job
    where job.tenant_id = v_tenant.id
      and job.created_at >= v_since
    union all
    select job.channel, job.delivery_state
    from academy.training_automation_jobs job
    where job.tenant_id = v_tenant.id
      and job.channel in ('whatsapp', 'email')
      and job.created_at >= v_since
  ),
  grouped as (
    select
      channel,
      count(*) as messages,
      count(*) filter (
        where delivery_state in ('delivered', 'read')
      ) as delivered,
      count(*) filter (
        where delivery_state in ('failed', 'bounced', 'complained')
      ) as failed,
      count(*) filter (
        where delivery_state = 'simulated'
      ) as simulated
    from facts
    group by channel
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'channel', channel,
    'messages', messages,
    'delivered', delivered,
    'failed', failed,
    'simulated', simulated
  ) order by channel), '[]'::jsonb)
  into v_channels
  from grouped;

  return jsonb_build_object(
    'generatedAt', now(),
    'days', v_days,
    'viewer', jsonb_build_object('canManage', true),
    'summary', v_summary || jsonb_build_object(
      'costMinor', (
        select coalesce(sum(event.cost_minor), 0)
        from communication_hub.delivery_events event
        where event.tenant_id = v_tenant.id
          and event.occurred_at >= v_since
          and event.billable
      ),
      'currency', coalesce((
        select event.currency
        from communication_hub.delivery_events event
        where event.tenant_id = v_tenant.id
          and event.occurred_at >= v_since
          and event.billable
        group by event.currency
        order by sum(event.cost_minor) desc
        limit 1
      ), 'SAR')
    ),
    'channels', v_channels,
    'webhooks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', webhook.id,
        'connectionId', connection.id,
        'connectionName', connection.display_name,
        'providerKey', connection.provider_key,
        'channel', connection.channel,
        'status', webhook.status,
        'lastReceivedAt', webhook.last_received_at,
        'lastError', webhook.last_error,
        'endpoint',
          'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
          || 'training-automation-dispatch'
      ) order by connection.channel, connection.display_name)
      from communication_hub.delivery_webhooks webhook
      join communication_hub.provider_connections connection
        on connection.id = webhook.connection_id
      where webhook.tenant_id = v_tenant.id
    ), '[]'::jsonb),
    'recentEvents', coalesce((
      select jsonb_agg(event_row.payload order by event_row.occurred_at desc)
      from (
        select
          event.occurred_at,
          jsonb_build_object(
            'id', event.id,
            'state', event.state,
            'providerKey', connection.provider_key,
            'channel', connection.channel,
            'matched',
              event.message_outbox_id is not null
              or event.training_job_id is not null,
            'billable', event.billable,
            'costMinor', event.cost_minor,
            'currency', event.currency,
            'detail', event.payload_summary ->> 'detail',
            'occurredAt', event.occurred_at
          ) as payload
        from communication_hub.delivery_events event
        join communication_hub.provider_connections connection
          on connection.id = event.provider_connection_id
        where event.tenant_id = v_tenant.id
          and event.occurred_at >= v_since
        order by event.occurred_at desc
        limit 30
      ) event_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v2_tenant_delivery_analytics_action(
  p_slug text,
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
  v_actor uuid;
  v_connection communication_hub.provider_connections%rowtype;
  v_webhook communication_hub.delivery_webhooks%rowtype;
  v_connection_id uuid;
  v_secret text;
  v_secret_id uuid;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  begin
    v_connection_id := (p_payload ->> 'connectionId')::uuid;
  exception when others then
    raise exception 'invalid_integration_connection';
  end;
  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.id = v_connection_id
    and connection.tenant_id = v_tenant.id
    and connection.status <> 'disabled'
  for update;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select * into v_webhook
  from communication_hub.delivery_webhooks webhook
  where webhook.connection_id = v_connection.id
  for update;

  if p_action = 'rotate_webhook' then
    v_secret := encode(extensions.gen_random_bytes(32), 'hex');
    v_secret_id := private_app.integration_secret_upsert(
      v_tenant.id,
      v_connection.id,
      'deliveryWebhookSecret',
      v_secret,
      v_webhook.secret_id
    );
    insert into communication_hub.delivery_webhooks (
      id,
      tenant_id,
      connection_id,
      secret_id,
      status,
      last_error,
      created_by_subject_id,
      updated_by_subject_id
    )
    values (
      coalesce(v_webhook.id, gen_random_uuid()),
      v_tenant.id,
      v_connection.id,
      v_secret_id,
      'active',
      null,
      coalesce(v_webhook.created_by_subject_id, v_actor),
      v_actor
    )
    on conflict (connection_id) do update
    set secret_id = excluded.secret_id,
        status = 'active',
        last_error = null,
        updated_by_subject_id = excluded.updated_by_subject_id
    returning * into v_webhook;

  elsif p_action in ('pause_webhook', 'enable_webhook') then
    if v_webhook.id is null then
      raise exception 'delivery_webhook_not_found';
    end if;
    update communication_hub.delivery_webhooks
    set status = case
          when p_action = 'pause_webhook' then 'paused'
          else 'active'
        end,
        last_error = null,
        updated_by_subject_id = v_actor
    where id = v_webhook.id
    returning * into v_webhook;
  else
    raise exception 'invalid_delivery_action';
  end if;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_tenant.id,
    v_actor,
    'communication.delivery_webhook.' || p_action,
    'delivery_webhook',
    v_webhook.id::text,
    jsonb_build_object(
      'connectionId', v_connection.id,
      'providerKey', v_connection.provider_key,
      'status', v_webhook.status
    )
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'webhookId', v_webhook.id,
    'status', v_webhook.status,
    'endpoint',
      'https://gswpbwdactcstkasddta.supabase.co/functions/v1/'
      || 'training-automation-dispatch',
    'secret', case when p_action = 'rotate_webhook' then v_secret end,
    'secretShownOnce', p_action = 'rotate_webhook'
  ));
end;
$$;

revoke execute on function
  public.v2_tenant_delivery_analytics_snapshot(text, integer)
from public, anon;

revoke execute on function
  public.v2_tenant_delivery_analytics_action(text, text, jsonb)
from public, anon;

grant execute on function
  public.v2_tenant_delivery_analytics_snapshot(text, integer)
to authenticated;

grant execute on function
  public.v2_tenant_delivery_analytics_action(text, text, jsonb)
to authenticated;

comment on table communication_hub.delivery_events is
'Normalized, idempotent, signed delivery evidence without recipient message bodies.';

comment on table communication_hub.delivery_webhooks is
'Tenant provider webhook endpoints with rotated secrets stored only in Vault.';

commit;
