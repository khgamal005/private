-- Applied migration version: 20260803020200
begin;

create or replace function public.v2_marketing_hub_authorize(
  p_tenant_slug text,
  p_provider text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection marketing_hub.connections%rowtype;
  v_provider_key text;
  v_action text := lower(trim(coalesce(p_action, '')));
begin
  if v_action not in ('test_connection','sync_now') then
    raise exception 'marketing_action_invalid';
  end if;

  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_manage_marketing_hub(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  if not private_app.tenant_addon_enabled(
    v_tenant.id,
    'addon.marketing_attribution'
  ) then
    raise exception 'marketing_addon_not_enabled';
  end if;

  v_provider_key := private_app.marketing_provider_key(p_provider);
  select * into v_connection
  from marketing_hub.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = v_provider_key
    and connection.status <> 'disabled'
  limit 1;

  if v_connection.id is null then
    raise exception 'marketing_connection_not_found';
  end if;
  if v_action = 'sync_now'
     and v_connection.status not in ('active','degraded') then
    raise exception 'marketing_connection_test_required';
  end if;

  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'connectionId', v_connection.id,
    'providerKey', v_connection.provider_key,
    'action', v_action
  );
end;
$$;

create or replace function public.v2_marketing_hub_connection_configuration(
  p_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection marketing_hub.connections%rowtype;
  v_secret record;
  v_secret_id uuid;
  v_secrets jsonb := '{}'::jsonb;
  v_expected_name text;
begin
  select * into v_connection
  from marketing_hub.connections connection
  where connection.id = p_connection_id
    and connection.status <> 'disabled'
  limit 1;
  if v_connection.id is null then
    raise exception 'marketing_connection_not_found';
  end if;

  for v_secret in
    select secret.key, secret.value
    from jsonb_each_text(v_connection.secret_refs) secret
  loop
    begin
      v_secret_id := v_secret.value::uuid;
    exception when invalid_text_representation then
      raise exception 'marketing_secret_reference_invalid';
    end;

    v_expected_name :=
      'integration:' || v_connection.tenant_id::text
      || ':' || v_connection.id::text
      || ':marketing:' || v_connection.provider_key
      || ':' || v_secret.key;

    v_secrets := jsonb_set(
      v_secrets,
      array[v_secret.key],
      to_jsonb(coalesce((
        select decrypted.decrypted_secret
        from vault.decrypted_secrets decrypted
        where decrypted.id = v_secret_id
          and decrypted.name = v_expected_name
        limit 1
      ), '')),
      true
    );
  end loop;

  return jsonb_build_object(
    'tenantId', v_connection.tenant_id,
    'connectionId', v_connection.id,
    'providerKey', v_connection.provider_key,
    'status', v_connection.status,
    'frequency', v_connection.frequency,
    'syncLookbackDays', v_connection.sync_lookback_days,
    'apiVersion', v_connection.api_version,
    'configuration', v_connection.configuration,
    'secrets', v_secrets,
    'lastSyncedAt', v_connection.last_synced_at,
    'remoteMetadata', v_connection.remote_metadata
  );
end;
$$;

create or replace function public.v2_marketing_hub_finish_test(
  p_connection_id uuid,
  p_success boolean,
  p_identity jsonb default '{}'::jsonb,
  p_error_code text default null,
  p_error_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection marketing_hub.connections%rowtype;
  v_external_account_id text;
  v_account_name text;
  v_currency text;
  v_timezone text;
  v_account marketing_hub.ad_accounts%rowtype;
begin
  select * into v_connection
  from marketing_hub.connections connection
  where connection.id = p_connection_id
  for update;
  if v_connection.id is null then
    raise exception 'marketing_connection_not_found';
  end if;

  if p_success then
    v_external_account_id := nullif(trim(coalesce(
      p_identity ->> 'externalAccountId',
      p_identity ->> 'id'
    )), '');
    if v_external_account_id is null
       or length(v_external_account_id) > 160 then
      raise exception 'marketing_account_identity_missing';
    end if;
    v_account_name := left(coalesce(
      nullif(trim(p_identity ->> 'name'), ''),
      v_connection.display_name,
      upper(v_connection.provider_key)
    ), 240);
    v_currency := upper(coalesce(
      nullif(trim(p_identity ->> 'currency'), ''),
      'SAR'
    ));
    if v_currency !~ '^[A-Z]{3}$' then v_currency := 'SAR'; end if;
    v_timezone := left(nullif(trim(p_identity ->> 'timezone'), ''), 120);

    insert into marketing_hub.ad_accounts (
      tenant_id,
      connection_id,
      provider_key,
      external_account_id,
      name,
      currency,
      timezone,
      status,
      is_selected,
      metadata,
      remote_updated_at,
      last_synced_at
    )
    values (
      v_connection.tenant_id,
      v_connection.id,
      v_connection.provider_key,
      v_external_account_id,
      v_account_name,
      v_currency,
      v_timezone,
      lower(coalesce(nullif(p_identity ->> 'status', ''), 'active')),
      true,
      coalesce(p_identity -> 'metadata', '{}'::jsonb),
      private_app.marketing_try_timestamptz(
        p_identity ->> 'remoteUpdatedAt'
      ),
      null
    )
    on conflict (connection_id, external_account_id) do update
    set name = excluded.name,
        currency = excluded.currency,
        timezone = excluded.timezone,
        status = excluded.status,
        is_selected = true,
        metadata = excluded.metadata,
        remote_updated_at = excluded.remote_updated_at
    returning * into v_account;

    update marketing_hub.connections
    set status = 'active',
        external_user_id = nullif(trim(p_identity ->> 'externalUserId'), ''),
        token_expires_at = private_app.marketing_try_timestamptz(
          p_identity ->> 'tokenExpiresAt'
        ),
        last_checked_at = now(),
        next_sync_at = private_app.marketing_next_sync(frequency, now()),
        last_error_code = null,
        last_error_detail = null,
        remote_metadata = coalesce(p_identity -> 'metadata', '{}'::jsonb)
    where id = v_connection.id
    returning * into v_connection;
  else
    update marketing_hub.connections
    set status = case
          when coalesce(p_error_code, '') in (
            'remote_http_401',
            'remote_http_403',
            'token_expired',
            'oauth_refresh_failed'
          ) then 'reauth_required'
          else 'error'
        end,
        last_checked_at = now(),
        next_sync_at = null,
        last_error_code = left(nullif(trim(p_error_code), ''), 160),
        last_error_detail = left(nullif(trim(p_error_detail), ''), 500)
    where id = v_connection.id
    returning * into v_connection;
  end if;

  update core.integrations
  set status = case
        when v_connection.status = 'reauth_required' then 'error'
        else v_connection.status
      end,
      last_checked_at = v_connection.last_checked_at,
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'marketing_' || v_connection.provider_key;

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'providerKey', v_connection.provider_key,
    'status', v_connection.status,
    'accountId', v_account.id,
    'externalAccountId', v_account.external_account_id,
    'checkedAt', v_connection.last_checked_at
  );
end;
$$;

create or replace function public.v2_marketing_hub_start_sync(
  p_connection_id uuid,
  p_trigger text,
  p_date_from date,
  p_date_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection marketing_hub.connections%rowtype;
  v_run marketing_hub.sync_runs%rowtype;
  v_trigger text := lower(trim(coalesce(p_trigger, 'manual')));
  v_key text := nullif(trim(p_idempotency_key), '');
begin
  if v_trigger not in ('manual','scheduled','recovery') then
    raise exception 'marketing_sync_trigger_invalid';
  end if;
  if p_date_from is null or p_date_to is null
     or p_date_to < p_date_from
     or p_date_to - p_date_from > 92 then
    raise exception 'marketing_sync_range_invalid';
  end if;
  if v_key is null or length(v_key) > 200 then
    raise exception 'marketing_idempotency_key_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text, 0));

  select * into v_connection
  from marketing_hub.connections connection
  where connection.id = p_connection_id
    and connection.status in ('active','degraded')
  for update;
  if v_connection.id is null then
    raise exception 'marketing_connection_not_ready';
  end if;

  update marketing_hub.sync_runs run
  set status = 'failed',
      error_code = 'sync_lease_expired',
      error_detail = 'The previous worker lease expired.',
      finished_at = now(),
      lease_expires_at = null
  where run.connection_id = v_connection.id
    and run.status in ('queued','running')
    and coalesce(run.lease_expires_at, run.updated_at + interval '30 minutes')
      < now();

  select * into v_run
  from marketing_hub.sync_runs run
  where run.connection_id = v_connection.id
    and run.idempotency_key = v_key
  limit 1;
  if v_run.id is not null then
    return jsonb_build_object(
      'runId', v_run.id,
      'duplicate', true,
      'status', v_run.status
    );
  end if;

  select * into v_run
  from marketing_hub.sync_runs run
  where run.connection_id = v_connection.id
    and run.status in ('queued','running')
  order by run.created_at desc
  limit 1;
  if v_run.id is not null then
    return jsonb_build_object(
      'runId', v_run.id,
      'duplicate', true,
      'status', v_run.status
    );
  end if;

  insert into marketing_hub.sync_runs (
    tenant_id,
    connection_id,
    trigger_type,
    date_from,
    date_to,
    idempotency_key,
    status,
    attempt_count,
    worker_id,
    lease_expires_at,
    started_at
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    v_trigger,
    p_date_from,
    p_date_to,
    v_key,
    'running',
    1,
    'edge:ads-sync',
    now() + interval '30 minutes',
    now()
  )
  returning * into v_run;

  update marketing_hub.connections
  set last_error_code = null,
      last_error_detail = null
  where id = v_connection.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'duplicate', false,
    'status', v_run.status,
    'dateFrom', v_run.date_from,
    'dateTo', v_run.date_to
  );
end;
$$;

create or replace function public.v2_marketing_hub_store_dimensions(
  p_connection_id uuid,
  p_run_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection marketing_hub.connections%rowtype;
  v_run marketing_hub.sync_runs%rowtype;
  v_account_payload jsonb;
  v_account marketing_hub.ad_accounts%rowtype;
  v_campaign marketing_hub.campaigns%rowtype;
  v_group marketing_hub.ad_groups%rowtype;
  v_item jsonb;
  v_external_id text;
  v_parent_id text;
  v_currency text;
  v_status text;
  v_campaign_count integer := 0;
  v_group_count integer := 0;
  v_ad_count integer := 0;
  v_failed_count integer := 0;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'marketing_dimensions_payload_invalid';
  end if;
  if coalesce(jsonb_array_length(p_payload -> 'campaigns'), 0) > 500
     or coalesce(jsonb_array_length(p_payload -> 'adGroups'), 0) > 500
     or coalesce(jsonb_array_length(p_payload -> 'ads'), 0) > 500 then
    raise exception 'marketing_dimensions_batch_too_large';
  end if;

  select * into v_connection
  from marketing_hub.connections connection
  where connection.id = p_connection_id
  limit 1;
  if v_connection.id is null then
    raise exception 'marketing_connection_not_found';
  end if;

  select * into v_run
  from marketing_hub.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
    and run.status = 'running'
    and run.lease_expires_at > now()
  for update;
  if v_run.id is null then raise exception 'marketing_sync_run_not_running'; end if;

  v_account_payload := coalesce(p_payload -> 'account', '{}'::jsonb);
  v_external_id := nullif(trim(coalesce(
    v_account_payload ->> 'externalAccountId',
    v_connection.configuration ->> 'accountId',
    v_connection.configuration ->> 'customerId',
    v_connection.configuration ->> 'advertiserId',
    v_connection.configuration ->> 'adAccountId'
  )), '');
  if v_external_id is null then
    raise exception 'marketing_account_identity_missing';
  end if;
  v_currency := upper(coalesce(
    nullif(trim(v_account_payload ->> 'currency'), ''),
    'SAR'
  ));
  if v_currency !~ '^[A-Z]{3}$' then v_currency := 'SAR'; end if;
  v_status := lower(coalesce(
    nullif(trim(v_account_payload ->> 'status'), ''),
    'active'
  ));
  if v_status not in ('active','inactive','closed','unknown') then
    v_status := 'unknown';
  end if;

  insert into marketing_hub.ad_accounts (
    tenant_id,
    connection_id,
    provider_key,
    external_account_id,
    name,
    currency,
    timezone,
    status,
    is_selected,
    metadata,
    remote_updated_at,
    last_synced_at
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    v_connection.provider_key,
    v_external_id,
    left(coalesce(
      nullif(trim(v_account_payload ->> 'name'), ''),
      v_connection.display_name,
      upper(v_connection.provider_key)
    ), 240),
    v_currency,
    left(nullif(trim(v_account_payload ->> 'timezone'), ''), 120),
    v_status,
    true,
    coalesce(v_account_payload -> 'metadata', '{}'::jsonb),
    private_app.marketing_try_timestamptz(
      v_account_payload ->> 'remoteUpdatedAt'
    ),
    now()
  )
  on conflict (connection_id, external_account_id) do update
  set name = excluded.name,
      currency = excluded.currency,
      timezone = excluded.timezone,
      status = excluded.status,
      is_selected = true,
      metadata = excluded.metadata,
      remote_updated_at = excluded.remote_updated_at,
      last_synced_at = now()
  returning * into v_account;

  for v_item in
    select item.value
    from jsonb_array_elements(coalesce(
      p_payload -> 'campaigns',
      '[]'::jsonb
    )) item(value)
  loop
    v_external_id := nullif(trim(v_item ->> 'externalId'), '');
    if jsonb_typeof(v_item) <> 'object'
       or v_external_id is null
       or length(v_external_id) > 160 then
      v_failed_count := v_failed_count + 1;
      continue;
    end if;
    insert into marketing_hub.campaigns (
      tenant_id,
      ad_account_id,
      provider_key,
      external_campaign_id,
      name,
      objective,
      status,
      effective_status,
      budget_type,
      budget_minor,
      start_date,
      end_date,
      destination_url,
      tracking_template,
      raw_payload,
      remote_updated_at,
      last_synced_at
    )
    values (
      v_connection.tenant_id,
      v_account.id,
      v_connection.provider_key,
      v_external_id,
      left(coalesce(nullif(trim(v_item ->> 'name'), ''), v_external_id), 500),
      left(nullif(trim(v_item ->> 'objective'), ''), 160),
      left(lower(coalesce(nullif(trim(v_item ->> 'status'), ''), 'unknown')), 80),
      left(lower(nullif(trim(v_item ->> 'effectiveStatus'), '')), 120),
      left(lower(nullif(trim(v_item ->> 'budgetType'), '')), 80),
      greatest(0, private_app.marketing_try_bigint(v_item ->> 'budgetMinor')),
      private_app.marketing_try_timestamptz(v_item ->> 'startDate')::date,
      private_app.marketing_try_timestamptz(v_item ->> 'endDate')::date,
      case
        when v_item ->> 'destinationUrl' ~* '^https?://'
          then left(v_item ->> 'destinationUrl', 2000)
        else null
      end,
      left(nullif(v_item ->> 'trackingTemplate', ''), 2000),
      case
        when jsonb_typeof(v_item -> 'raw') = 'object'
          then v_item -> 'raw'
        else v_item - 'raw'
      end,
      private_app.marketing_try_timestamptz(v_item ->> 'remoteUpdatedAt'),
      now()
    )
    on conflict (ad_account_id, external_campaign_id) do update
    set name = excluded.name,
        objective = excluded.objective,
        status = excluded.status,
        effective_status = excluded.effective_status,
        budget_type = excluded.budget_type,
        budget_minor = excluded.budget_minor,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        destination_url = excluded.destination_url,
        tracking_template = excluded.tracking_template,
        raw_payload = excluded.raw_payload,
        remote_updated_at = excluded.remote_updated_at,
        last_synced_at = now();
    v_campaign_count := v_campaign_count + 1;
  end loop;

  for v_item in
    select item.value
    from jsonb_array_elements(coalesce(
      p_payload -> 'adGroups',
      '[]'::jsonb
    )) item(value)
  loop
    v_external_id := nullif(trim(v_item ->> 'externalId'), '');
    v_parent_id := nullif(trim(v_item ->> 'externalCampaignId'), '');
    select * into v_campaign
    from marketing_hub.campaigns campaign
    where campaign.ad_account_id = v_account.id
      and campaign.external_campaign_id = v_parent_id
    limit 1;
    if jsonb_typeof(v_item) <> 'object'
       or v_external_id is null
       or v_campaign.id is null then
      v_failed_count := v_failed_count + 1;
      continue;
    end if;
    insert into marketing_hub.ad_groups (
      tenant_id,
      ad_account_id,
      campaign_id,
      provider_key,
      external_ad_group_id,
      name,
      status,
      effective_status,
      optimization_goal,
      bid_strategy,
      budget_minor,
      raw_payload,
      remote_updated_at,
      last_synced_at
    )
    values (
      v_connection.tenant_id,
      v_account.id,
      v_campaign.id,
      v_connection.provider_key,
      left(v_external_id, 160),
      left(coalesce(nullif(trim(v_item ->> 'name'), ''), v_external_id), 500),
      left(lower(coalesce(nullif(trim(v_item ->> 'status'), ''), 'unknown')), 80),
      left(lower(nullif(trim(v_item ->> 'effectiveStatus'), '')), 120),
      left(nullif(trim(v_item ->> 'optimizationGoal'), ''), 160),
      left(nullif(trim(v_item ->> 'bidStrategy'), ''), 160),
      greatest(0, private_app.marketing_try_bigint(v_item ->> 'budgetMinor')),
      case
        when jsonb_typeof(v_item -> 'raw') = 'object'
          then v_item -> 'raw'
        else v_item - 'raw'
      end,
      private_app.marketing_try_timestamptz(v_item ->> 'remoteUpdatedAt'),
      now()
    )
    on conflict (ad_account_id, external_ad_group_id) do update
    set campaign_id = excluded.campaign_id,
        name = excluded.name,
        status = excluded.status,
        effective_status = excluded.effective_status,
        optimization_goal = excluded.optimization_goal,
        bid_strategy = excluded.bid_strategy,
        budget_minor = excluded.budget_minor,
        raw_payload = excluded.raw_payload,
        remote_updated_at = excluded.remote_updated_at,
        last_synced_at = now();
    v_group_count := v_group_count + 1;
  end loop;

  for v_item in
    select item.value
    from jsonb_array_elements(coalesce(p_payload -> 'ads', '[]'::jsonb)) item(value)
  loop
    v_external_id := nullif(trim(v_item ->> 'externalId'), '');
    v_parent_id := nullif(trim(v_item ->> 'externalCampaignId'), '');
    select * into v_campaign
    from marketing_hub.campaigns campaign
    where campaign.ad_account_id = v_account.id
      and campaign.external_campaign_id = v_parent_id
    limit 1;
    select * into v_group
    from marketing_hub.ad_groups ad_group
    where ad_group.ad_account_id = v_account.id
      and ad_group.external_ad_group_id = nullif(trim(
        v_item ->> 'externalAdGroupId'
      ), '')
    limit 1;
    if jsonb_typeof(v_item) <> 'object'
       or v_external_id is null
       or v_campaign.id is null then
      v_failed_count := v_failed_count + 1;
      continue;
    end if;
    insert into marketing_hub.ads (
      tenant_id,
      ad_account_id,
      campaign_id,
      ad_group_id,
      provider_key,
      external_ad_id,
      external_creative_id,
      name,
      status,
      effective_status,
      destination_url,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      raw_payload,
      remote_updated_at,
      last_synced_at
    )
    values (
      v_connection.tenant_id,
      v_account.id,
      v_campaign.id,
      v_group.id,
      v_connection.provider_key,
      left(v_external_id, 160),
      left(nullif(trim(v_item ->> 'externalCreativeId'), ''), 160),
      left(coalesce(nullif(trim(v_item ->> 'name'), ''), v_external_id), 500),
      left(lower(coalesce(nullif(trim(v_item ->> 'status'), ''), 'unknown')), 80),
      left(lower(nullif(trim(v_item ->> 'effectiveStatus'), '')), 120),
      case
        when v_item ->> 'destinationUrl' ~* '^https?://'
          then left(v_item ->> 'destinationUrl', 2000)
        else null
      end,
      left(nullif(trim(v_item ->> 'utmSource'), ''), 255),
      left(nullif(trim(v_item ->> 'utmMedium'), ''), 255),
      left(nullif(trim(v_item ->> 'utmCampaign'), ''), 500),
      left(nullif(trim(v_item ->> 'utmContent'), ''), 500),
      case
        when jsonb_typeof(v_item -> 'raw') = 'object'
          then v_item -> 'raw'
        else v_item - 'raw'
      end,
      private_app.marketing_try_timestamptz(v_item ->> 'remoteUpdatedAt'),
      now()
    )
    on conflict (ad_account_id, external_ad_id) do update
    set campaign_id = excluded.campaign_id,
        ad_group_id = excluded.ad_group_id,
        external_creative_id = excluded.external_creative_id,
        name = excluded.name,
        status = excluded.status,
        effective_status = excluded.effective_status,
        destination_url = excluded.destination_url,
        utm_source = excluded.utm_source,
        utm_medium = excluded.utm_medium,
        utm_campaign = excluded.utm_campaign,
        utm_content = excluded.utm_content,
        raw_payload = excluded.raw_payload,
        remote_updated_at = excluded.remote_updated_at,
        last_synced_at = now();
    v_ad_count := v_ad_count + 1;
  end loop;

  update marketing_hub.sync_runs
  set lease_expires_at = now() + interval '30 minutes',
      cursor = coalesce(p_payload -> 'cursor', cursor)
  where id = v_run.id;

  return jsonb_build_object(
    'accountId', v_account.id,
    'campaignCount', v_campaign_count,
    'adGroupCount', v_group_count,
    'adCount', v_ad_count,
    'failedCount', v_failed_count
  );
end;
$$;

create or replace function public.v2_marketing_hub_store_metrics(
  p_connection_id uuid,
  p_run_id uuid,
  p_metrics jsonb,
  p_cursor jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection marketing_hub.connections%rowtype;
  v_run marketing_hub.sync_runs%rowtype;
  v_account marketing_hub.ad_accounts%rowtype;
  v_campaign marketing_hub.campaigns%rowtype;
  v_group marketing_hub.ad_groups%rowtype;
  v_ad marketing_hub.ads%rowtype;
  v_item jsonb;
  v_date date;
  v_level text;
  v_external_id text;
  v_currency text;
  v_stored integer := 0;
  v_failed integer := 0;
begin
  if jsonb_typeof(p_metrics) <> 'array'
     or jsonb_array_length(p_metrics) > 500 then
    raise exception 'marketing_metrics_batch_invalid';
  end if;

  select * into v_connection
  from marketing_hub.connections connection
  where connection.id = p_connection_id
  limit 1;
  if v_connection.id is null then
    raise exception 'marketing_connection_not_found';
  end if;

  select * into v_run
  from marketing_hub.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
    and run.status = 'running'
    and run.lease_expires_at > now()
  for update;
  if v_run.id is null then raise exception 'marketing_sync_run_not_running'; end if;

  select * into v_account
  from marketing_hub.ad_accounts account
  where account.connection_id = v_connection.id
    and account.is_selected
  order by account.updated_at desc
  limit 1;
  if v_account.id is null then
    raise exception 'marketing_account_not_found';
  end if;

  for v_item in select item.value from jsonb_array_elements(p_metrics) item(value)
  loop
    v_date := private_app.marketing_try_timestamptz(
      v_item ->> 'date'
    )::date;
    v_level := lower(trim(coalesce(v_item ->> 'entityLevel', 'ad')));
    v_external_id := nullif(trim(v_item ->> 'externalEntityId'), '');
    if jsonb_typeof(v_item) <> 'object'
       or v_date is null
       or v_date < v_run.date_from
       or v_date > v_run.date_to
       or v_level not in ('account','campaign','ad_group','ad')
       or v_external_id is null then
      v_failed := v_failed + 1;
      continue;
    end if;

    v_campaign := null;
    v_group := null;
    v_ad := null;
    if nullif(trim(v_item ->> 'externalCampaignId'), '') is not null then
      select * into v_campaign
      from marketing_hub.campaigns campaign
      where campaign.ad_account_id = v_account.id
        and campaign.external_campaign_id = v_item ->> 'externalCampaignId'
      limit 1;
    end if;
    if nullif(trim(v_item ->> 'externalAdGroupId'), '') is not null then
      select * into v_group
      from marketing_hub.ad_groups ad_group
      where ad_group.ad_account_id = v_account.id
        and ad_group.external_ad_group_id = v_item ->> 'externalAdGroupId'
      limit 1;
    end if;
    if nullif(trim(v_item ->> 'externalAdId'), '') is not null then
      select * into v_ad
      from marketing_hub.ads ad
      where ad.ad_account_id = v_account.id
        and ad.external_ad_id = v_item ->> 'externalAdId'
      limit 1;
    end if;

    v_currency := upper(coalesce(
      nullif(trim(v_item ->> 'currency'), ''),
      v_account.currency,
      'SAR'
    ));
    if v_currency !~ '^[A-Z]{3}$' then v_currency := v_account.currency; end if;

    insert into marketing_hub.daily_metrics (
      tenant_id,
      ad_account_id,
      campaign_id,
      ad_group_id,
      ad_id,
      provider_key,
      metric_date,
      entity_level,
      external_entity_id,
      breakdown_key,
      currency,
      impressions,
      reach,
      clicks,
      link_clicks,
      spend_minor,
      platform_leads,
      platform_conversions,
      platform_revenue_minor,
      video_views,
      raw_metrics
    )
    values (
      v_connection.tenant_id,
      v_account.id,
      v_campaign.id,
      v_group.id,
      v_ad.id,
      v_connection.provider_key,
      v_date,
      v_level,
      left(v_external_id, 160),
      left(coalesce(nullif(v_item ->> 'breakdownKey', ''), 'all'), 160),
      v_currency,
      greatest(0, coalesce(private_app.marketing_try_bigint(v_item ->> 'impressions'), 0)),
      greatest(0, coalesce(private_app.marketing_try_bigint(v_item ->> 'reach'), 0)),
      greatest(0, coalesce(private_app.marketing_try_bigint(v_item ->> 'clicks'), 0)),
      greatest(0, coalesce(private_app.marketing_try_bigint(v_item ->> 'linkClicks'), 0)),
      greatest(0, coalesce(private_app.marketing_try_bigint(v_item ->> 'spendMinor'), 0)),
      greatest(0, coalesce(private_app.marketing_try_numeric(v_item ->> 'platformLeads'), 0)),
      greatest(0, coalesce(private_app.marketing_try_numeric(v_item ->> 'platformConversions'), 0)),
      greatest(0, coalesce(private_app.marketing_try_bigint(v_item ->> 'platformRevenueMinor'), 0)),
      greatest(0, coalesce(private_app.marketing_try_bigint(v_item ->> 'videoViews'), 0)),
      case
        when jsonb_typeof(v_item -> 'raw') = 'object'
          then v_item -> 'raw'
        else v_item - 'raw'
      end
    )
    on conflict (
      ad_account_id,
      metric_date,
      entity_level,
      external_entity_id,
      breakdown_key
    ) do update
    set campaign_id = excluded.campaign_id,
        ad_group_id = excluded.ad_group_id,
        ad_id = excluded.ad_id,
        currency = excluded.currency,
        impressions = excluded.impressions,
        reach = excluded.reach,
        clicks = excluded.clicks,
        link_clicks = excluded.link_clicks,
        spend_minor = excluded.spend_minor,
        platform_leads = excluded.platform_leads,
        platform_conversions = excluded.platform_conversions,
        platform_revenue_minor = excluded.platform_revenue_minor,
        video_views = excluded.video_views,
        raw_metrics = excluded.raw_metrics;
    v_stored := v_stored + 1;
  end loop;

  update marketing_hub.sync_runs
  set lease_expires_at = now() + interval '30 minutes',
      cursor = coalesce(p_cursor, '{}'::jsonb)
  where id = v_run.id;

  return jsonb_build_object(
    'storedCount', v_stored,
    'failedCount', v_failed
  );
end;
$$;

create or replace function public.v2_marketing_hub_finish_sync(
  p_connection_id uuid,
  p_run_id uuid,
  p_status text,
  p_stats jsonb default '{}'::jsonb,
  p_error_code text default null,
  p_error_detail text default null,
  p_remote_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection marketing_hub.connections%rowtype;
  v_run marketing_hub.sync_runs%rowtype;
  v_status text := lower(trim(coalesce(p_status, '')));
  v_now timestamptz := now();
begin
  if v_status not in ('success','partial','failed') then
    raise exception 'marketing_sync_status_invalid';
  end if;
  if jsonb_typeof(coalesce(p_stats, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_remote_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'marketing_sync_result_invalid';
  end if;

  select * into v_connection
  from marketing_hub.connections connection
  where connection.id = p_connection_id
  for update;
  if v_connection.id is null then
    raise exception 'marketing_connection_not_found';
  end if;

  select * into v_run
  from marketing_hub.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;
  if v_run.id is null then raise exception 'marketing_sync_run_not_found'; end if;

  update marketing_hub.sync_runs
  set status = v_status,
      stats = coalesce(p_stats, '{}'::jsonb),
      error_code = left(nullif(trim(p_error_code), ''), 160),
      error_detail = left(nullif(trim(p_error_detail), ''), 1000),
      lease_expires_at = null,
      finished_at = v_now
  where id = v_run.id
  returning * into v_run;

  update marketing_hub.connections
  set status = case
        when v_status = 'success' then 'active'
        when v_status = 'partial' then 'degraded'
        when coalesce(p_error_code, '') in (
          'remote_http_401',
          'remote_http_403',
          'token_expired',
          'oauth_refresh_failed'
        ) then 'reauth_required'
        else 'error'
      end,
      last_checked_at = v_now,
      last_synced_at = case
        when v_status in ('success','partial') then v_now
        else last_synced_at
      end,
      next_sync_at = case
        when v_status in ('success','partial')
          then private_app.marketing_next_sync(frequency, v_now)
        else null
      end,
      last_error_code = case
        when v_status = 'failed'
          then left(nullif(trim(p_error_code), ''), 160)
        else null
      end,
      last_error_detail = case
        when v_status = 'failed'
          then left(nullif(trim(p_error_detail), ''), 500)
        else null
      end,
      remote_metadata = coalesce(p_remote_metadata, '{}'::jsonb)
  where id = v_connection.id
  returning * into v_connection;

  update marketing_hub.ad_accounts
  set last_synced_at = case
        when v_status in ('success','partial') then v_now
        else last_synced_at
      end
  where connection_id = v_connection.id;

  update core.integrations
  set status = case
        when v_connection.status = 'reauth_required' then 'error'
        else v_connection.status
      end,
      last_checked_at = v_connection.last_checked_at,
      updated_at = now()
  where tenant_id = v_connection.tenant_id
    and system_type = 'marketing_' || v_connection.provider_key;

  return jsonb_build_object(
    'runId', v_run.id,
    'status', v_run.status,
    'finishedAt', v_run.finished_at,
    'nextSyncAt', v_connection.next_sync_at
  );
end;
$$;

create or replace function public.v2_marketing_hub_claim_due_connections(
  p_limit integer default 10,
  p_worker_id text default 'scheduler'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_result jsonb;
begin
  with due as (
    select connection.id
    from marketing_hub.connections connection
    where connection.status in ('active','degraded')
      and connection.frequency <> 'manual'
      and connection.next_sync_at <= now()
    order by connection.next_sync_at, connection.id
    for update skip locked
    limit v_limit
  ), leased as (
    update marketing_hub.connections connection
    set next_sync_at = now() + interval '35 minutes'
    from due
    where connection.id = due.id
    returning connection.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'connectionId', leased.id,
    'tenantId', leased.tenant_id,
    'providerKey', leased.provider_key,
    'syncLookbackDays', leased.sync_lookback_days,
    'workerId', left(coalesce(p_worker_id, 'scheduler'), 120)
  ) order by leased.next_sync_at, leased.id), '[]'::jsonb)
  into v_result
  from leased;

  return v_result;
end;
$$;

revoke all on function public.v2_marketing_hub_authorize(text,text,text)
from public, anon;
revoke all on function public.v2_marketing_hub_connection_configuration(uuid)
from public, anon, authenticated;
revoke all on function public.v2_marketing_hub_finish_test(
  uuid,boolean,jsonb,text,text
)
from public, anon, authenticated;
revoke all on function public.v2_marketing_hub_start_sync(
  uuid,text,date,date,text
)
from public, anon, authenticated;
revoke all on function public.v2_marketing_hub_store_dimensions(
  uuid,uuid,jsonb
)
from public, anon, authenticated;
revoke all on function public.v2_marketing_hub_store_metrics(
  uuid,uuid,jsonb,jsonb
)
from public, anon, authenticated;
revoke all on function public.v2_marketing_hub_finish_sync(
  uuid,uuid,text,jsonb,text,text,jsonb
)
from public, anon, authenticated;
revoke all on function public.v2_marketing_hub_claim_due_connections(
  integer,text
)
from public, anon, authenticated;

grant execute on function public.v2_marketing_hub_authorize(text,text,text)
to authenticated;
grant execute on function public.v2_marketing_hub_connection_configuration(uuid)
to service_role;
grant execute on function public.v2_marketing_hub_finish_test(
  uuid,boolean,jsonb,text,text
)
to service_role;
grant execute on function public.v2_marketing_hub_start_sync(
  uuid,text,date,date,text
)
to service_role;
grant execute on function public.v2_marketing_hub_store_dimensions(
  uuid,uuid,jsonb
)
to service_role;
grant execute on function public.v2_marketing_hub_store_metrics(
  uuid,uuid,jsonb,jsonb
)
to service_role;
grant execute on function public.v2_marketing_hub_finish_sync(
  uuid,uuid,text,jsonb,text,text,jsonb
)
to service_role;
grant execute on function public.v2_marketing_hub_claim_due_connections(
  integer,text
)
to service_role;

commit;
