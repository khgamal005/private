-- Applied migration version: 20260803020300
begin;

create or replace function private_app.marketing_provider_from_source(
  p_value text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := lower(trim(coalesce(p_value, '')));
begin
  if v_value ~ '(facebook|instagram|meta|فيس|انستا)' then
    return 'meta';
  elsif v_value ~ '(google|adwords|google_ads|جوجل|قوقل)' then
    return 'google_ads';
  elsif v_value ~ '(tiktok|tik_tok|تيك)' then
    return 'tiktok_ads';
  elsif v_value ~ '(snapchat|snap|سناب)' then
    return 'snapchat_ads';
  end if;
  return null;
end;
$$;

create or replace function private_app.marketing_identity_hash(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when nullif(lower(trim(p_value)), '') is null then null
    else encode(
      extensions.digest(lower(trim(p_value)), 'sha256'),
      'hex'
    )
  end;
$$;

create or replace function private_app.marketing_phone_hash(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select private_app.marketing_identity_hash(
    nullif(right(regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g'), 9), '')
  );
$$;

create or replace function private_app.marketing_json_text(
  p_value jsonb,
  variadic p_keys text[]
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_result text;
begin
  foreach v_key in array p_keys loop
    v_result := nullif(trim(p_value ->> v_key), '');
    if v_result is not null then return v_result; end if;
  end loop;
  return null;
end;
$$;

create or replace function private_app.marketing_event_revenue(
  p_amount bigint,
  p_status text
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'refunded' then -abs(coalesce(p_amount, 0))
    when p_status = 'cancelled' then 0
    else greatest(0, coalesce(p_amount, 0))
  end;
$$;

create or replace function public.v2_marketing_hub_refresh_attribution(
  p_tenant_id uuid,
  p_date_from date default null,
  p_date_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_settings marketing_hub.attribution_settings%rowtype;
  v_from date := coalesce(p_date_from, current_date - 365);
  v_to date := coalesce(p_date_to, current_date);
  v_touchpoints bigint := 0;
  v_conversions bigint := 0;
  v_attributions bigint := 0;
  v_insights bigint := 0;
  v_coverage numeric := 0;
  v_rows bigint := 0;
begin
  if v_to < v_from or v_to - v_from > 730 then
    raise exception 'marketing_attribution_range_invalid';
  end if;

  select * into v_tenant
  from core.tenants tenant
  where tenant.id = p_tenant_id
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;

  perform pg_advisory_xact_lock(
    hashtextextended('marketing-attribution:' || p_tenant_id::text, 0)
  );

  insert into marketing_hub.attribution_settings (
    tenant_id,
    model,
    click_window_days,
    view_window_days,
    base_currency,
    timezone
  )
  values (
    v_tenant.id,
    'last_non_direct',
    30,
    1,
    upper(coalesce(nullif(v_tenant.settings ->> 'currency', ''), 'SAR')),
    coalesce(v_tenant.timezone, 'Asia/Riyadh')
  )
  on conflict (tenant_id) do nothing;

  select * into v_settings
  from marketing_hub.attribution_settings settings
  where settings.tenant_id = v_tenant.id;

  insert into marketing_hub.touchpoints (
    tenant_id,
    occurred_at,
    source_kind,
    source_ref,
    contact_id,
    identity_hashes,
    provider_key,
    channel,
    click_id_type,
    click_id_hash,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    external_campaign_id,
    external_ad_group_id,
    external_ad_id,
    landing_url,
    referrer_url,
    metadata
  )
  select
    contact.tenant_id,
    contact.created_at,
    'crm',
    'contact:' || contact.id::text,
    contact.id,
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(contact.email),
      'phone', private_app.marketing_phone_hash(
        coalesce(contact.phone, contact.whatsapp)
      )
    )),
    private_app.marketing_provider_from_source(coalesce(
      contact.metadata ->> 'utm_source',
      contact.source
    )),
    left(nullif(trim(contact.source), ''), 160),
    case
      when nullif(contact.metadata ->> 'gclid', '') is not null then 'gclid'
      when nullif(contact.metadata ->> 'gbraid', '') is not null then 'gbraid'
      when nullif(contact.metadata ->> 'wbraid', '') is not null then 'wbraid'
      when nullif(contact.metadata ->> 'fbclid', '') is not null then 'fbclid'
      when nullif(contact.metadata ->> 'ttclid', '') is not null then 'ttclid'
      when nullif(contact.metadata ->> 'sc_click_id', '') is not null
        then 'sc_click_id'
      else null
    end,
    private_app.marketing_identity_hash(coalesce(
      nullif(contact.metadata ->> 'gclid', ''),
      nullif(contact.metadata ->> 'gbraid', ''),
      nullif(contact.metadata ->> 'wbraid', ''),
      nullif(contact.metadata ->> 'fbclid', ''),
      nullif(contact.metadata ->> 'ttclid', ''),
      nullif(contact.metadata ->> 'sc_click_id', '')
    )),
    left(coalesce(
      nullif(contact.metadata ->> 'utm_source', ''),
      nullif(contact.source, '')
    ), 255),
    left(nullif(contact.metadata ->> 'utm_medium', ''), 255),
    left(coalesce(
      nullif(contact.metadata ->> 'utm_campaign', ''),
      nullif(contact.campaign_name, '')
    ), 500),
    left(coalesce(
      nullif(contact.metadata ->> 'utm_content', ''),
      nullif(contact.ad_name, '')
    ), 500),
    left(nullif(contact.metadata ->> 'utm_term', ''), 500),
    left(nullif(contact.metadata ->> 'external_campaign_id', ''), 160),
    left(nullif(contact.metadata ->> 'external_ad_group_id', ''), 160),
    left(nullif(contact.metadata ->> 'external_ad_id', ''), 160),
    case
      when contact.metadata ->> 'landing_url' ~* '^https?://'
        then left(contact.metadata ->> 'landing_url', 2000)
      else null
    end,
    case
      when contact.metadata ->> 'referrer_url' ~* '^https?://'
        then left(contact.metadata ->> 'referrer_url', 2000)
      else null
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'campaignName', contact.campaign_name,
      'adName', contact.ad_name,
      'leadStatus', contact.lead_status,
      'source', contact.source
    ))
  from sales_core.contacts contact
  where contact.tenant_id = v_tenant.id
    and contact.created_at::date between v_from and v_to
  on conflict (tenant_id, source_kind, source_ref) do update
  set occurred_at = excluded.occurred_at,
      contact_id = excluded.contact_id,
      identity_hashes = excluded.identity_hashes,
      provider_key = excluded.provider_key,
      channel = excluded.channel,
      click_id_type = excluded.click_id_type,
      click_id_hash = excluded.click_id_hash,
      utm_source = excluded.utm_source,
      utm_medium = excluded.utm_medium,
      utm_campaign = excluded.utm_campaign,
      utm_content = excluded.utm_content,
      utm_term = excluded.utm_term,
      external_campaign_id = excluded.external_campaign_id,
      external_ad_group_id = excluded.external_ad_group_id,
      external_ad_id = excluded.external_ad_id,
      landing_url = excluded.landing_url,
      referrer_url = excluded.referrer_url,
      metadata = excluded.metadata;
  get diagnostics v_touchpoints = row_count;

  insert into marketing_hub.conversion_events (
    tenant_id,
    event_type,
    occurred_at,
    source_kind,
    source_ref,
    dedupe_key,
    contact_id,
    amount_minor,
    currency,
    status,
    identity_hashes,
    metadata
  )
  select
    contact.tenant_id,
    'lead',
    contact.created_at,
    'crm',
    'contact:' || contact.id::text,
    'crm:lead:' || contact.id::text,
    contact.id,
    0,
    v_settings.base_currency,
    case
      when contact.lead_status in ('cancelled','duplicate') then 'cancelled'
      else 'active'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(contact.email),
      'phone', private_app.marketing_phone_hash(
        coalesce(contact.phone, contact.whatsapp)
      )
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'source', contact.source,
      'campaignName', contact.campaign_name,
      'adName', contact.ad_name,
      'leadStatus', contact.lead_status
    ))
  from sales_core.contacts contact
  where contact.tenant_id = v_tenant.id
    and contact.created_at::date between v_from and v_to
  on conflict (tenant_id, dedupe_key) do update
  set occurred_at = excluded.occurred_at,
      status = excluded.status,
      identity_hashes = excluded.identity_hashes,
      metadata = excluded.metadata;
  get diagnostics v_conversions = row_count;

  insert into marketing_hub.conversion_events (
    tenant_id,
    event_type,
    occurred_at,
    source_kind,
    source_ref,
    dedupe_key,
    contact_id,
    amount_minor,
    currency,
    status,
    identity_hashes,
    metadata
  )
  select
    contact.tenant_id,
    'qualified_lead',
    coalesce(contact.lead_status_changed_at, contact.updated_at),
    'crm',
    'contact:' || contact.id::text,
    'crm:qualified:' || contact.id::text,
    contact.id,
    0,
    v_settings.base_currency,
    'active',
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(contact.email),
      'phone', private_app.marketing_phone_hash(
        coalesce(contact.phone, contact.whatsapp)
      )
    )),
    jsonb_build_object('leadStatus', contact.lead_status)
  from sales_core.contacts contact
  where contact.tenant_id = v_tenant.id
    and contact.lead_status in (
      'interested',
      'very_interested',
      'awaiting_payment',
      'paid'
    )
    and coalesce(
      contact.lead_status_changed_at,
      contact.updated_at
    )::date between v_from and v_to
  on conflict (tenant_id, dedupe_key) do update
  set occurred_at = excluded.occurred_at,
      identity_hashes = excluded.identity_hashes,
      metadata = excluded.metadata;
  get diagnostics v_rows = row_count;
  v_conversions := v_conversions + v_rows;

  insert into marketing_hub.conversion_events (
    tenant_id,
    event_type,
    occurred_at,
    source_kind,
    source_ref,
    dedupe_key,
    contact_id,
    opportunity_id,
    amount_minor,
    currency,
    status,
    identity_hashes,
    metadata
  )
  select
    handoff.tenant_id,
    'payment',
    coalesce(
      handoff.payment_verified_at,
      handoff.payment_reported_at,
      handoff.paid_at
    ),
    'academy',
    'handoff:' || handoff.id::text,
    'academy:payment:' || handoff.id::text,
    handoff.contact_id,
    handoff.opportunity_id,
    coalesce(handoff.payment_amount_minor, opportunity.value_minor, 0),
    upper(coalesce(opportunity.currency, v_settings.base_currency)),
    case handoff.payment_status
      when 'refunded' then 'refunded'
      when 'rejected' then 'cancelled'
      else 'active'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(contact.email),
      'phone', private_app.marketing_phone_hash(
        coalesce(contact.phone, contact.whatsapp)
      )
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'paymentStatus', handoff.payment_status,
      'paymentReferenceHash', private_app.marketing_identity_hash(
        handoff.payment_reference
      ),
      'courseId', handoff.course_id
    ))
  from academy.registration_handoffs handoff
  join sales_core.contacts contact
    on contact.id = handoff.contact_id
   and contact.tenant_id = handoff.tenant_id
  left join sales_core.opportunities opportunity
    on opportunity.id = handoff.opportunity_id
   and opportunity.tenant_id = handoff.tenant_id
  where handoff.tenant_id = v_tenant.id
    and handoff.payment_status in ('verified','refunded')
    and coalesce(
      handoff.payment_verified_at,
      handoff.payment_reported_at,
      handoff.paid_at
    )::date between v_from and v_to
  on conflict (tenant_id, dedupe_key) do update
  set occurred_at = excluded.occurred_at,
      amount_minor = excluded.amount_minor,
      currency = excluded.currency,
      status = excluded.status,
      identity_hashes = excluded.identity_hashes,
      metadata = excluded.metadata;
  get diagnostics v_rows = row_count;
  v_conversions := v_conversions + v_rows;

  insert into marketing_hub.conversion_events (
    tenant_id,
    event_type,
    occurred_at,
    source_kind,
    source_ref,
    dedupe_key,
    contact_id,
    opportunity_id,
    amount_minor,
    currency,
    status,
    identity_hashes,
    metadata
  )
  select
    opportunity.tenant_id,
    'won_opportunity',
    opportunity.updated_at,
    'crm',
    'opportunity:' || opportunity.id::text,
    'crm:won:' || opportunity.id::text,
    opportunity.contact_id,
    opportunity.id,
    opportunity.value_minor,
    upper(opportunity.currency),
    'active',
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(contact.email),
      'phone', private_app.marketing_phone_hash(
        coalesce(contact.phone, contact.whatsapp)
      )
    )),
    jsonb_build_object('title', opportunity.title)
  from sales_core.opportunities opportunity
  join sales_core.contacts contact
    on contact.id = opportunity.contact_id
   and contact.tenant_id = opportunity.tenant_id
  where opportunity.tenant_id = v_tenant.id
    and opportunity.status = 'won'
    and opportunity.updated_at::date between v_from and v_to
    and not exists (
      select 1
      from academy.registration_handoffs handoff
      where handoff.tenant_id = opportunity.tenant_id
        and handoff.opportunity_id = opportunity.id
        and handoff.payment_status in ('verified','refunded')
    )
  on conflict (tenant_id, dedupe_key) do update
  set occurred_at = excluded.occurred_at,
      amount_minor = excluded.amount_minor,
      currency = excluded.currency,
      status = excluded.status,
      identity_hashes = excluded.identity_hashes,
      metadata = excluded.metadata;
  get diagnostics v_rows = row_count;
  v_conversions := v_conversions + v_rows;

  insert into marketing_hub.touchpoints (
    tenant_id,
    occurred_at,
    source_kind,
    source_ref,
    commerce_entity_id,
    identity_hashes,
    provider_key,
    channel,
    click_id_type,
    click_id_hash,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    external_campaign_id,
    external_ad_group_id,
    external_ad_id,
    landing_url,
    metadata
  )
  select
    entity.tenant_id,
    coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    ),
    'commerce',
    'commerce_hub:order:' || entity.id::text,
    entity.id,
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'customerEmail',
          'email'
        )
      ),
      'phone', private_app.marketing_phone_hash(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'customerPhone',
          'phone'
        )
      )
    )),
    private_app.marketing_provider_from_source(
      private_app.marketing_json_text(
        entity.normalized_payload,
        'utmSource',
        'source'
      )
    ),
    left(private_app.marketing_json_text(
      entity.normalized_payload,
      'source',
      'utmSource'
    ), 160),
    left(entity.normalized_payload ->> 'clickIdType', 40),
    private_app.marketing_identity_hash(
      entity.normalized_payload ->> 'clickId'
    ),
    left(entity.normalized_payload ->> 'utmSource', 255),
    left(entity.normalized_payload ->> 'utmMedium', 255),
    left(entity.normalized_payload ->> 'utmCampaign', 500),
    left(entity.normalized_payload ->> 'utmContent', 500),
    left(entity.normalized_payload ->> 'utmTerm', 500),
    left(entity.normalized_payload ->> 'externalCampaignId', 160),
    left(entity.normalized_payload ->> 'externalAdGroupId', 160),
    left(entity.normalized_payload ->> 'externalAdId', 160),
    case
      when entity.normalized_payload ->> 'landingUrl' ~* '^https?://'
        then left(entity.normalized_payload ->> 'landingUrl', 2000)
      else null
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'commerceProvider', entity.provider_key,
      'externalOrderId', entity.external_id,
      'orderNumber', entity.normalized_payload ->> 'orderNumber'
    ))
  from commerce_hub.external_entities entity
  where entity.tenant_id = v_tenant.id
    and entity.entity_type = 'orders'
    and entity.sync_state = 'active'
    and coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    )::date between v_from and v_to
  on conflict (tenant_id, source_kind, source_ref) do update
  set occurred_at = excluded.occurred_at,
      commerce_entity_id = excluded.commerce_entity_id,
      identity_hashes = excluded.identity_hashes,
      provider_key = excluded.provider_key,
      channel = excluded.channel,
      click_id_type = excluded.click_id_type,
      click_id_hash = excluded.click_id_hash,
      utm_source = excluded.utm_source,
      utm_medium = excluded.utm_medium,
      utm_campaign = excluded.utm_campaign,
      utm_content = excluded.utm_content,
      utm_term = excluded.utm_term,
      external_campaign_id = excluded.external_campaign_id,
      external_ad_group_id = excluded.external_ad_group_id,
      external_ad_id = excluded.external_ad_id,
      landing_url = excluded.landing_url,
      metadata = excluded.metadata;
  get diagnostics v_rows = row_count;
  v_touchpoints := v_touchpoints + v_rows;

  insert into marketing_hub.conversion_events (
    tenant_id,
    event_type,
    occurred_at,
    source_kind,
    source_ref,
    dedupe_key,
    commerce_entity_id,
    amount_minor,
    currency,
    status,
    identity_hashes,
    metadata
  )
  select
    entity.tenant_id,
    'purchase',
    coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    ),
    'commerce',
    'commerce_hub:order:' || entity.id::text,
    'commerce_hub:purchase:' || entity.id::text,
    entity.id,
    greatest(0, coalesce(private_app.marketing_try_bigint(
      entity.normalized_payload ->> 'amountMinor'
    ), 0)),
    upper(coalesce(
      nullif(entity.normalized_payload ->> 'currency', ''),
      v_settings.base_currency
    )),
    case lower(coalesce(
      entity.normalized_payload ->> 'paymentStatus',
      entity.normalized_payload ->> 'status',
      ''
    ))
      when 'refunded' then 'refunded'
      when 'cancelled' then 'cancelled'
      when 'canceled' then 'cancelled'
      when 'failed' then 'cancelled'
      else 'active'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'customerEmail',
          'email'
        )
      ),
      'phone', private_app.marketing_phone_hash(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'customerPhone',
          'phone'
        )
      )
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'commerceProvider', entity.provider_key,
      'externalOrderId', entity.external_id,
      'orderNumber', entity.normalized_payload ->> 'orderNumber',
      'paymentStatus', entity.normalized_payload ->> 'paymentStatus',
      'orderStatus', entity.normalized_payload ->> 'status'
    ))
  from commerce_hub.external_entities entity
  where entity.tenant_id = v_tenant.id
    and entity.entity_type = 'orders'
    and entity.sync_state = 'active'
    and coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.normalized_payload,
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    )::date between v_from and v_to
  on conflict (tenant_id, dedupe_key) do update
  set occurred_at = excluded.occurred_at,
      amount_minor = excluded.amount_minor,
      currency = excluded.currency,
      status = excluded.status,
      identity_hashes = excluded.identity_hashes,
      metadata = excluded.metadata;
  get diagnostics v_rows = row_count;
  v_conversions := v_conversions + v_rows;

  insert into marketing_hub.touchpoints (
    tenant_id,
    occurred_at,
    source_kind,
    source_ref,
    identity_hashes,
    provider_key,
    channel,
    click_id_type,
    click_id_hash,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    external_campaign_id,
    external_ad_group_id,
    external_ad_id,
    landing_url,
    metadata
  )
  select
    entity.tenant_id,
    coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    ),
    'commerce',
    'commerce_sync:order:' || entity.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'customerEmail',
          'email'
        )
      ),
      'phone', private_app.marketing_phone_hash(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'customerPhone',
          'phone'
        )
      )
    )),
    private_app.marketing_provider_from_source(
      private_app.marketing_json_text(
        entity.raw_payload -> '_marktone',
        'utmSource',
        'source'
      )
    ),
    left(private_app.marketing_json_text(
      entity.raw_payload -> '_marktone',
      'source',
      'utmSource'
    ), 160),
    left(entity.raw_payload #>> '{_marktone,clickIdType}', 40),
    private_app.marketing_identity_hash(
      entity.raw_payload #>> '{_marktone,clickId}'
    ),
    left(entity.raw_payload #>> '{_marktone,utmSource}', 255),
    left(entity.raw_payload #>> '{_marktone,utmMedium}', 255),
    left(entity.raw_payload #>> '{_marktone,utmCampaign}', 500),
    left(entity.raw_payload #>> '{_marktone,utmContent}', 500),
    left(entity.raw_payload #>> '{_marktone,utmTerm}', 500),
    left(entity.raw_payload #>> '{_marktone,externalCampaignId}', 160),
    left(entity.raw_payload #>> '{_marktone,externalAdGroupId}', 160),
    left(entity.raw_payload #>> '{_marktone,externalAdId}', 160),
    case
      when entity.raw_payload #>> '{_marktone,landingUrl}' ~* '^https?://'
        then left(entity.raw_payload #>> '{_marktone,landingUrl}', 2000)
      else null
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'commerceProvider', 'woocommerce',
      'externalOrderId', entity.external_id,
      'orderNumber', entity.raw_payload #>> '{_marktone,orderNumber}'
    ))
  from commerce_sync.external_entities entity
  where entity.tenant_id = v_tenant.id
    and entity.entity_type = 'orders'
    and entity.sync_state = 'active'
    and coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    )::date between v_from and v_to
  on conflict (tenant_id, source_kind, source_ref) do update
  set occurred_at = excluded.occurred_at,
      identity_hashes = excluded.identity_hashes,
      provider_key = excluded.provider_key,
      channel = excluded.channel,
      click_id_type = excluded.click_id_type,
      click_id_hash = excluded.click_id_hash,
      utm_source = excluded.utm_source,
      utm_medium = excluded.utm_medium,
      utm_campaign = excluded.utm_campaign,
      utm_content = excluded.utm_content,
      utm_term = excluded.utm_term,
      external_campaign_id = excluded.external_campaign_id,
      external_ad_group_id = excluded.external_ad_group_id,
      external_ad_id = excluded.external_ad_id,
      landing_url = excluded.landing_url,
      metadata = excluded.metadata;
  get diagnostics v_rows = row_count;
  v_touchpoints := v_touchpoints + v_rows;

  insert into marketing_hub.conversion_events (
    tenant_id,
    event_type,
    occurred_at,
    source_kind,
    source_ref,
    dedupe_key,
    amount_minor,
    currency,
    status,
    identity_hashes,
    metadata
  )
  select
    entity.tenant_id,
    'purchase',
    coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    ),
    'commerce',
    'commerce_sync:order:' || entity.id::text,
    'commerce_sync:purchase:' || entity.id::text,
    greatest(0, coalesce(private_app.marketing_try_bigint(
      entity.raw_payload #>> '{_marktone,amountMinor}'
    ), 0)),
    upper(coalesce(
      nullif(entity.raw_payload #>> '{_marktone,currency}', ''),
      v_settings.base_currency
    )),
    case lower(coalesce(
      entity.raw_payload #>> '{_marktone,paymentStatus}',
      entity.raw_payload #>> '{_marktone,status}',
      ''
    ))
      when 'refunded' then 'refunded'
      when 'cancelled' then 'cancelled'
      when 'canceled' then 'cancelled'
      when 'failed' then 'cancelled'
      else 'active'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'email', private_app.marketing_identity_hash(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'customerEmail',
          'email'
        )
      ),
      'phone', private_app.marketing_phone_hash(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'customerPhone',
          'phone'
        )
      )
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'commerceProvider', 'woocommerce',
      'externalOrderId', entity.external_id,
      'orderNumber', entity.raw_payload #>> '{_marktone,orderNumber}',
      'paymentStatus', entity.raw_payload #>> '{_marktone,paymentStatus}',
      'orderStatus', entity.raw_payload #>> '{_marktone,status}'
    ))
  from commerce_sync.external_entities entity
  where entity.tenant_id = v_tenant.id
    and entity.entity_type = 'orders'
    and entity.sync_state = 'active'
    and coalesce(
      private_app.marketing_try_timestamptz(
        private_app.marketing_json_text(
          entity.raw_payload -> '_marktone',
          'occurredAt',
          'createdAt',
          'externalUpdatedAt'
        )
      ),
      entity.remote_updated_at,
      entity.created_at
    )::date between v_from and v_to
  on conflict (tenant_id, dedupe_key) do update
  set occurred_at = excluded.occurred_at,
      amount_minor = excluded.amount_minor,
      currency = excluded.currency,
      status = excluded.status,
      identity_hashes = excluded.identity_hashes,
      metadata = excluded.metadata;
  get diagnostics v_rows = row_count;
  v_conversions := v_conversions + v_rows;

  delete from marketing_hub.attributions attribution
  using marketing_hub.conversion_events conversion
  where attribution.conversion_event_id = conversion.id
    and attribution.tenant_id = v_tenant.id
    and conversion.occurred_at::date between v_from and v_to;

  if v_settings.model = 'linear' then
    with eligible as (
      select
        conversion.id as conversion_id,
        touchpoint.id as touchpoint_id,
        count(*) over (partition by conversion.id) as touchpoint_count
      from marketing_hub.conversion_events conversion
      join marketing_hub.touchpoints touchpoint
        on touchpoint.tenant_id = conversion.tenant_id
       and touchpoint.occurred_at <= conversion.occurred_at
       and touchpoint.occurred_at >= conversion.occurred_at
         - make_interval(days => v_settings.click_window_days)
       and (
         (
           conversion.contact_id is not null
           and touchpoint.contact_id = conversion.contact_id
         )
         or conversion.source_ref = touchpoint.source_ref
         or (
           nullif(conversion.identity_hashes ->> 'email', '') is not null
           and conversion.identity_hashes ->> 'email'
             = touchpoint.identity_hashes ->> 'email'
         )
         or (
           nullif(conversion.identity_hashes ->> 'phone', '') is not null
           and conversion.identity_hashes ->> 'phone'
             = touchpoint.identity_hashes ->> 'phone'
         )
       )
      where conversion.tenant_id = v_tenant.id
        and conversion.occurred_at::date between v_from and v_to
    )
    insert into marketing_hub.attributions (
      tenant_id,
      conversion_event_id,
      touchpoint_id,
      model,
      credit,
      attributed_revenue_minor,
      provider_key,
      campaign_id,
      ad_group_id,
      ad_id,
      external_campaign_id,
      external_ad_group_id,
      external_ad_id,
      campaign_name,
      ad_group_name,
      ad_name,
      confidence,
      confidence_score,
      evidence,
      window_days
    )
    select
      conversion.tenant_id,
      conversion.id,
      touchpoint.id,
      v_settings.model,
      (1::numeric / eligible.touchpoint_count)::numeric(9,8),
      round(
        private_app.marketing_event_revenue(
          conversion.amount_minor,
          conversion.status
        )::numeric / eligible.touchpoint_count
      )::bigint,
      touchpoint.provider_key,
      campaign.id,
      ad_group.id,
      ad.id,
      touchpoint.external_campaign_id,
      touchpoint.external_ad_group_id,
      touchpoint.external_ad_id,
      coalesce(campaign.name, touchpoint.utm_campaign),
      ad_group.name,
      coalesce(ad.name, touchpoint.utm_content),
      case
        when touchpoint.click_id_hash is not null then 'exact'
        when ad.id is not null or campaign.id is not null then 'strong'
        else 'probable'
      end,
      case
        when touchpoint.click_id_hash is not null then 100
        when ad.id is not null then 95
        when campaign.id is not null then 85
        else 65
      end,
      jsonb_strip_nulls(jsonb_build_object(
        'match', case
          when touchpoint.click_id_hash is not null then 'click_id'
          when conversion.contact_id = touchpoint.contact_id then 'contact_id'
          when conversion.source_ref = touchpoint.source_ref then 'source_ref'
          else 'identity_hash'
        end,
        'sourceKind', touchpoint.source_kind
      )),
      v_settings.click_window_days
    from eligible
    join marketing_hub.conversion_events conversion
      on conversion.id = eligible.conversion_id
    join marketing_hub.touchpoints touchpoint
      on touchpoint.id = eligible.touchpoint_id
    left join lateral (
      select candidate.*
      from marketing_hub.campaigns candidate
      where candidate.tenant_id = conversion.tenant_id
        and candidate.provider_key = touchpoint.provider_key
        and (
          candidate.external_campaign_id = touchpoint.external_campaign_id
          or (
            touchpoint.external_campaign_id is null
            and touchpoint.utm_campaign is not null
            and lower(candidate.name) = lower(touchpoint.utm_campaign)
          )
        )
      order by
        (candidate.external_campaign_id = touchpoint.external_campaign_id) desc,
        candidate.updated_at desc,
        candidate.id
      limit 1
    ) campaign on true
    left join lateral (
      select candidate.*
      from marketing_hub.ad_groups candidate
      where candidate.tenant_id = conversion.tenant_id
        and candidate.provider_key = touchpoint.provider_key
        and candidate.external_ad_group_id = touchpoint.external_ad_group_id
      order by candidate.updated_at desc, candidate.id
      limit 1
    ) ad_group on true
    left join lateral (
      select candidate.*
      from marketing_hub.ads candidate
      where candidate.tenant_id = conversion.tenant_id
        and candidate.provider_key = touchpoint.provider_key
        and candidate.external_ad_id = touchpoint.external_ad_id
      order by candidate.updated_at desc, candidate.id
      limit 1
    ) ad on true;
    get diagnostics v_attributions = row_count;

    insert into marketing_hub.attributions (
      tenant_id,
      conversion_event_id,
      touchpoint_id,
      model,
      credit,
      attributed_revenue_minor,
      confidence,
      confidence_score,
      evidence,
      window_days
    )
    select
      conversion.tenant_id,
      conversion.id,
      null,
      v_settings.model,
      1,
      private_app.marketing_event_revenue(
        conversion.amount_minor,
        conversion.status
      ),
      'untracked',
      0,
      jsonb_build_object(
        'match', 'none',
        'reason', 'no_touchpoint_in_window'
      ),
      v_settings.click_window_days
    from marketing_hub.conversion_events conversion
    where conversion.tenant_id = v_tenant.id
      and conversion.occurred_at::date between v_from and v_to
      and not exists (
        select 1
        from marketing_hub.touchpoints touchpoint
        where touchpoint.tenant_id = conversion.tenant_id
          and touchpoint.occurred_at <= conversion.occurred_at
          and touchpoint.occurred_at >= conversion.occurred_at
            - make_interval(days => v_settings.click_window_days)
          and (
            (
              conversion.contact_id is not null
              and touchpoint.contact_id = conversion.contact_id
            )
            or conversion.source_ref = touchpoint.source_ref
            or (
              nullif(conversion.identity_hashes ->> 'email', '') is not null
              and conversion.identity_hashes ->> 'email'
                = touchpoint.identity_hashes ->> 'email'
            )
            or (
              nullif(conversion.identity_hashes ->> 'phone', '') is not null
              and conversion.identity_hashes ->> 'phone'
                = touchpoint.identity_hashes ->> 'phone'
            )
          )
      );
    get diagnostics v_rows = row_count;
    v_attributions := v_attributions + v_rows;
  else
    insert into marketing_hub.attributions (
      tenant_id,
      conversion_event_id,
      touchpoint_id,
      model,
      credit,
      attributed_revenue_minor,
      provider_key,
      campaign_id,
      ad_group_id,
      ad_id,
      external_campaign_id,
      external_ad_group_id,
      external_ad_id,
      campaign_name,
      ad_group_name,
      ad_name,
      confidence,
      confidence_score,
      evidence,
      window_days
    )
    select
      conversion.tenant_id,
      conversion.id,
      selected.id,
      v_settings.model,
      1,
      private_app.marketing_event_revenue(
        conversion.amount_minor,
        conversion.status
      ),
      selected.provider_key,
      campaign.id,
      ad_group.id,
      ad.id,
      selected.external_campaign_id,
      selected.external_ad_group_id,
      selected.external_ad_id,
      coalesce(campaign.name, selected.utm_campaign),
      ad_group.name,
      coalesce(ad.name, selected.utm_content),
      case
        when selected.id is null then 'untracked'
        when selected.click_id_hash is not null then 'exact'
        when ad.id is not null or campaign.id is not null then 'strong'
        else 'probable'
      end,
      case
        when selected.id is null then 0
        when selected.click_id_hash is not null then 100
        when ad.id is not null then 95
        when campaign.id is not null then 85
        else 65
      end,
      case
        when selected.id is null then jsonb_build_object(
          'match', 'none',
          'reason', 'no_touchpoint_in_window'
        )
        else jsonb_strip_nulls(jsonb_build_object(
          'match', case
            when selected.click_id_hash is not null then 'click_id'
            when conversion.contact_id = selected.contact_id then 'contact_id'
            when conversion.source_ref = selected.source_ref then 'source_ref'
            else 'identity_hash'
          end,
          'sourceKind', selected.source_kind
        ))
      end,
      v_settings.click_window_days
    from marketing_hub.conversion_events conversion
    left join lateral (
      select touchpoint.*
      from marketing_hub.touchpoints touchpoint
      where touchpoint.tenant_id = conversion.tenant_id
        and touchpoint.occurred_at <= conversion.occurred_at
        and touchpoint.occurred_at >= conversion.occurred_at
          - make_interval(days => v_settings.click_window_days)
        and (
          (
            conversion.contact_id is not null
            and touchpoint.contact_id = conversion.contact_id
          )
          or conversion.source_ref = touchpoint.source_ref
          or (
            nullif(conversion.identity_hashes ->> 'email', '') is not null
            and conversion.identity_hashes ->> 'email'
              = touchpoint.identity_hashes ->> 'email'
          )
          or (
            nullif(conversion.identity_hashes ->> 'phone', '') is not null
            and conversion.identity_hashes ->> 'phone'
              = touchpoint.identity_hashes ->> 'phone'
          )
        )
      order by
        case
          when v_settings.model = 'last_non_direct'
               and coalesce(touchpoint.utm_medium, '') in (
                 'direct',
                 '(none)',
                 'none'
               ) then 1
          else 0
        end,
        case
          when v_settings.model = 'first_touch'
            then touchpoint.occurred_at
        end asc,
        case
          when v_settings.model in ('last_touch', 'last_non_direct')
            then touchpoint.occurred_at
        end desc,
        touchpoint.id
      limit 1
    ) selected on true
    left join lateral (
      select candidate.*
      from marketing_hub.campaigns candidate
      where candidate.tenant_id = conversion.tenant_id
        and candidate.provider_key = selected.provider_key
        and (
          candidate.external_campaign_id = selected.external_campaign_id
          or (
            selected.external_campaign_id is null
            and selected.utm_campaign is not null
            and lower(candidate.name) = lower(selected.utm_campaign)
          )
        )
      order by
        (candidate.external_campaign_id = selected.external_campaign_id) desc,
        candidate.updated_at desc,
        candidate.id
      limit 1
    ) campaign on true
    left join lateral (
      select candidate.*
      from marketing_hub.ad_groups candidate
      where candidate.tenant_id = conversion.tenant_id
        and candidate.provider_key = selected.provider_key
        and candidate.external_ad_group_id = selected.external_ad_group_id
      order by candidate.updated_at desc, candidate.id
      limit 1
    ) ad_group on true
    left join lateral (
      select candidate.*
      from marketing_hub.ads candidate
      where candidate.tenant_id = conversion.tenant_id
        and candidate.provider_key = selected.provider_key
        and candidate.external_ad_id = selected.external_ad_id
      order by candidate.updated_at desc, candidate.id
      limit 1
    ) ad on true
    where conversion.tenant_id = v_tenant.id
      and conversion.occurred_at::date between v_from and v_to;
    get diagnostics v_attributions = row_count;
  end if;

  select coalesce(
    100.0 * count(*) filter (
      where attribution.confidence <> 'untracked'
    ) / nullif(count(*), 0),
    0
  )
  into v_coverage
  from marketing_hub.attributions attribution
  join marketing_hub.conversion_events conversion
    on conversion.id = attribution.conversion_event_id
  where attribution.tenant_id = v_tenant.id
    and conversion.event_type in ('payment','purchase','won_opportunity')
    and conversion.status <> 'cancelled'
    and conversion.occurred_at::date between v_from and v_to;

  if v_coverage < 70 and exists (
    select 1
    from marketing_hub.conversion_events conversion
    where conversion.tenant_id = v_tenant.id
      and conversion.event_type in ('payment','purchase','won_opportunity')
      and conversion.occurred_at::date between v_from and v_to
    offset 4 limit 1
  ) then
    insert into marketing_hub.insights (
      tenant_id,
      fingerprint,
      insight_type,
      severity,
      title_ar,
      detail_ar,
      recommended_action_ar,
      evidence,
      last_detected_at
    )
    values (
      v_tenant.id,
      'tracking-gap:tenant',
      'tracking_gap',
      'warning',
      'جزء من المبيعات غير منسوب إلى حملات',
      'نسبة تغطية الإسناد أقل من المستوى الموصى به لاتخاذ قرار دقيق.',
      'ثبّت UTM ومعرّفات النقر في نماذج العملاء وصفحات إتمام الطلب ثم أعد المزامنة.',
      jsonb_build_object('coverageRate', round(v_coverage, 2)),
      now()
    )
    on conflict (tenant_id, fingerprint) do update
    set severity = excluded.severity,
        detail_ar = excluded.detail_ar,
        recommended_action_ar = excluded.recommended_action_ar,
        evidence = excluded.evidence,
        last_detected_at = now();
    v_insights := v_insights + 1;
  end if;

  insert into marketing_hub.insights (
    tenant_id,
    fingerprint,
    insight_type,
    severity,
    title_ar,
    detail_ar,
    recommended_action_ar,
    provider_key,
    evidence,
    last_detected_at
  )
  select
    connection.tenant_id,
    'sync-health:' || connection.provider_key,
    'sync_health',
    case
      when connection.status in ('error','reauth_required') then 'critical'
      else 'warning'
    end,
    'بيانات ' || provider.name_ar || ' تحتاج تحديثًا',
    case
      when connection.status = 'reauth_required'
        then 'انتهى التفويض الرسمي أو تغيرت صلاحيات الحساب.'
      when connection.status = 'error'
        then 'توقفت آخر مزامنة قبل اكتمالها.'
      else 'آخر مزامنة أقدم من المدة المتوقعة لهذا الربط.'
    end,
    'اختبر الاتصال ثم شغّل المزامنة من مركز الحملات.',
    connection.provider_key,
    jsonb_build_object(
      'status', connection.status,
      'lastSyncedAt', connection.last_synced_at,
      'lastErrorCode', connection.last_error_code
    ),
    now()
  from marketing_hub.connections connection
  join marketing_hub.providers provider
    on provider.provider_key = connection.provider_key
  where connection.tenant_id = v_tenant.id
    and connection.status <> 'disabled'
    and (
      connection.status in ('error','reauth_required')
      or connection.last_synced_at is null
      or connection.last_synced_at < now() - interval '48 hours'
    )
  on conflict (tenant_id, fingerprint) do update
  set severity = excluded.severity,
      title_ar = excluded.title_ar,
      detail_ar = excluded.detail_ar,
      recommended_action_ar = excluded.recommended_action_ar,
      evidence = excluded.evidence,
      last_detected_at = now();
  get diagnostics v_rows = row_count;
  v_insights := v_insights + v_rows;

  with metric_level as (
    select
      metric.*,
      max(case metric.entity_level
        when 'ad' then 4
        when 'ad_group' then 3
        when 'campaign' then 2
        else 1
      end) over (
        partition by metric.ad_account_id, metric.metric_date
      ) as selected_level
    from marketing_hub.daily_metrics metric
    where metric.tenant_id = v_tenant.id
      and metric.metric_date between v_from and v_to
  ), spend as (
    select
      metric.campaign_id,
      sum(metric.spend_minor)::bigint as spend_minor
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
    group by metric.campaign_id
  ), revenue as (
    select
      attribution.campaign_id,
      sum(attribution.attributed_revenue_minor)::bigint as revenue_minor,
      count(distinct attribution.conversion_event_id) filter (
        where conversion.status = 'active'
          and conversion.event_type in (
            'payment',
            'purchase',
            'won_opportunity'
          )
      )::integer as sales
    from marketing_hub.attributions attribution
    join marketing_hub.conversion_events conversion
      on conversion.id = attribution.conversion_event_id
    where attribution.tenant_id = v_tenant.id
      and conversion.occurred_at::date between v_from and v_to
    group by attribution.campaign_id
  ), decision as (
    select
      campaign.id,
      campaign.tenant_id,
      campaign.provider_key,
      campaign.name,
      coalesce(spend.spend_minor, 0) as spend_minor,
      coalesce(revenue.revenue_minor, 0) as revenue_minor,
      coalesce(revenue.sales, 0) as sales,
      case
        when coalesce(spend.spend_minor, 0) > 0
          then coalesce(revenue.revenue_minor, 0)::numeric
            / spend.spend_minor
        else null
      end as roas
    from marketing_hub.campaigns campaign
    left join spend on spend.campaign_id = campaign.id
    left join revenue on revenue.campaign_id = campaign.id
    where campaign.tenant_id = v_tenant.id
  )
  insert into marketing_hub.insights (
    tenant_id,
    fingerprint,
    insight_type,
    severity,
    title_ar,
    detail_ar,
    recommended_action_ar,
    provider_key,
    campaign_id,
    evidence,
    last_detected_at
  )
  select
    decision.tenant_id,
    case
      when decision.spend_minor >= 10000 and decision.sales = 0
        then 'review-spend:' || decision.id::text
      else 'scale:' || decision.id::text
    end,
    case
      when decision.spend_minor >= 10000 and decision.sales = 0
        then 'review_spend'
      else 'scale'
    end,
    case
      when decision.spend_minor >= 10000 and decision.sales = 0
        then 'warning'
      else 'opportunity'
    end,
    case
      when decision.spend_minor >= 10000 and decision.sales = 0
        then 'إنفاق دون مبيعات منسوبة: ' || decision.name
      else 'حملة مرشحة للتوسع: ' || decision.name
    end,
    case
      when decision.spend_minor >= 10000 and decision.sales = 0
        then 'الحملة أنفقت ضمن الفترة ولم يظهر لها بيع موثوق في ماركتون.'
      else 'الحملة حققت عائدًا قويًا مع أكثر من عملية بيع موثقة.'
    end,
    case
      when decision.spend_minor >= 10000 and decision.sales = 0
        then 'راجع الاستهداف وصفحة الوصول وجودة التتبع قبل زيادة الميزانية.'
      else 'اختبر زيادة تدريجية للميزانية وراقب تكلفة البيع يوميًا.'
    end,
    decision.provider_key,
    decision.id,
    jsonb_build_object(
      'spendMinor', decision.spend_minor,
      'revenueMinor', decision.revenue_minor,
      'sales', decision.sales,
      'roas', round(coalesce(decision.roas, 0), 3)
    ),
    now()
  from decision
  where (
      decision.spend_minor >= 10000
      and decision.sales = 0
    )
    or (
      decision.roas >= 3
      and decision.sales >= 3
    )
  on conflict (tenant_id, fingerprint) do update
  set severity = excluded.severity,
      title_ar = excluded.title_ar,
      detail_ar = excluded.detail_ar,
      recommended_action_ar = excluded.recommended_action_ar,
      evidence = excluded.evidence,
      last_detected_at = now();
  get diagnostics v_rows = row_count;
  v_insights := v_insights + v_rows;

  insert into marketing_hub.insights (
    tenant_id,
    fingerprint,
    insight_type,
    severity,
    title_ar,
    detail_ar,
    recommended_action_ar,
    evidence,
    last_detected_at
  )
  select
    v_tenant.id,
    'currency-mismatch:' || metric.currency,
    'currency_mismatch',
    'warning',
    'عملة إنفاق مختلفة: ' || metric.currency,
    'لا تُجمع هذه التكلفة داخل ROAS العام لأن عملة الحساب تختلف عن '
      || v_settings.base_currency || '.',
    'وحّد عملة التقارير أو أضف سعر تحويل معتمد قبل جمع الحسابات.',
    jsonb_build_object(
      'metricCurrency', metric.currency,
      'baseCurrency', v_settings.base_currency
    ),
    now()
  from marketing_hub.daily_metrics metric
  where metric.tenant_id = v_tenant.id
    and metric.metric_date between v_from and v_to
    and metric.currency <> v_settings.base_currency
  group by metric.currency
  on conflict (tenant_id, fingerprint) do update
  set detail_ar = excluded.detail_ar,
      recommended_action_ar = excluded.recommended_action_ar,
      evidence = excluded.evidence,
      last_detected_at = now();
  get diagnostics v_rows = row_count;
  v_insights := v_insights + v_rows;

  return jsonb_build_object(
    'touchpointsProcessed', v_touchpoints,
    'conversionsProcessed', v_conversions,
    'attributionsCalculated', v_attributions,
    'coverageRate', round(v_coverage, 2),
    'insightsDetected', v_insights,
    'model', v_settings.model,
    'dateFrom', v_from,
    'dateTo', v_to
  );
end;
$$;

create or replace function public.v2_tenant_marketing_hub_snapshot(
  p_slug text,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_settings marketing_hub.attribution_settings%rowtype;
  v_from date := coalesce(p_from, current_date - 29);
  v_to date := coalesce(p_to, current_date);
  v_feature_enabled boolean;
  v_can_manage boolean;
  v_providers jsonb := '[]'::jsonb;
  v_summary jsonb := '{}'::jsonb;
  v_campaigns jsonb := '[]'::jsonb;
  v_sources jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_funnel jsonb := '[]'::jsonb;
  v_insights jsonb := '[]'::jsonb;
  v_store_sources jsonb := '[]'::jsonb;
  v_data_health jsonb := '{}'::jsonb;
begin
  if v_to < v_from or v_to - v_from > 366 then
    raise exception 'marketing_snapshot_range_invalid';
  end if;

  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_read_marketing_hub(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  v_feature_enabled := private_app.tenant_addon_enabled(
    v_tenant.id,
    'addon.marketing_attribution'
  );
  v_can_manage := private_app.can_manage_marketing_hub(v_tenant.id);

  select * into v_settings
  from marketing_hub.attribution_settings settings
  where settings.tenant_id = v_tenant.id;
  if v_settings.tenant_id is null then
    v_settings.tenant_id := v_tenant.id;
    v_settings.model := 'last_non_direct';
    v_settings.click_window_days := 30;
    v_settings.view_window_days := 1;
    v_settings.base_currency := upper(coalesce(
      nullif(v_tenant.settings ->> 'currency', ''),
      'SAR'
    ));
    v_settings.timezone := coalesce(v_tenant.timezone, 'Asia/Riyadh');
  end if;

  v_providers := (
    select coalesce(jsonb_agg(jsonb_build_object(
    'providerKey', provider.provider_key,
    'nameAr', provider.name_ar,
    'nameEn', provider.name_en,
    'descriptionAr', provider.description_ar,
    'setupMode', provider.setup_mode,
    'adapterStatus', provider.adapter_status,
    'apiVersion', coalesce(
      connection.api_version,
      provider.default_api_version
    ),
    'supportedApiVersions', to_jsonb(provider.supported_api_versions),
    'capabilities', to_jsonb(provider.capabilities),
    'requiredConfigKeys', to_jsonb(provider.required_config_keys),
    'optionalConfigKeys', to_jsonb(provider.optional_config_keys),
    'requiredSecretKeys', to_jsonb(provider.required_secret_keys),
    'optionalSecretKeys', to_jsonb(provider.optional_secret_keys),
    'documentationUrl', provider.documentation_url,
    'connection', case
      when connection.id is null then null
      else jsonb_build_object(
        'connectionId', connection.id,
        'displayName', connection.display_name,
        'status', connection.status,
        'frequency', connection.frequency,
        'syncLookbackDays', connection.sync_lookback_days,
        'apiVersion', connection.api_version,
        'configuration', connection.configuration,
        'configuredSecrets', (
          select coalesce(
            jsonb_agg(secret.key order by secret.key),
            '[]'::jsonb
          )
          from jsonb_each_text(connection.secret_refs) secret
        ),
        'lastCheckedAt', connection.last_checked_at,
        'lastSyncedAt', connection.last_synced_at,
        'nextSyncAt', connection.next_sync_at,
        'lastErrorCode', connection.last_error_code,
        'accountCount', (
          select count(*)
          from marketing_hub.ad_accounts account
          where account.connection_id = connection.id
            and account.is_selected
        ),
        'accounts', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', account.id,
            'externalAccountId', account.external_account_id,
            'name', account.name,
            'currency', account.currency,
            'timezone', account.timezone,
            'status', account.status,
            'lastSyncedAt', account.last_synced_at
          ) order by account.name), '[]'::jsonb)
          from marketing_hub.ad_accounts account
          where account.connection_id = connection.id
            and account.is_selected
        ),
        'recentRuns', (
          select coalesce(jsonb_agg(run_row.value order by run_row.created_at desc), '[]'::jsonb)
          from (
            select
              run.created_at,
              jsonb_build_object(
                'id', run.id,
                'status', run.status,
                'triggerType', run.trigger_type,
                'dateFrom', run.date_from,
                'dateTo', run.date_to,
                'stats', run.stats,
                'errorCode', run.error_code,
                'startedAt', run.started_at,
                'finishedAt', run.finished_at
              ) as value
            from marketing_hub.sync_runs run
            where run.connection_id = connection.id
            order by run.created_at desc
            limit 5
          ) run_row
        )
      )
      end
    ) order by provider.sort_order, provider.provider_key), '[]'::jsonb)
    from marketing_hub.providers provider
    left join marketing_hub.connections connection
      on connection.tenant_id = v_tenant.id
     and connection.provider_key = provider.provider_key
    where provider.status in ('active','beta')
  );

  with metric_level as (
    select
      metric.*,
      max(case metric.entity_level
        when 'ad' then 4
        when 'ad_group' then 3
        when 'campaign' then 2
        else 1
      end) over (
        partition by metric.ad_account_id, metric.metric_date
      ) as selected_level
    from marketing_hub.daily_metrics metric
    where metric.tenant_id = v_tenant.id
      and metric.metric_date between v_from and v_to
      and metric.currency = v_settings.base_currency
  ), selected_metrics as (
    select *
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
  ), performance as (
    select
      coalesce(sum(metric.impressions), 0)::bigint as impressions,
      coalesce(sum(metric.reach), 0)::bigint as reach,
      coalesce(sum(metric.clicks), 0)::bigint as clicks,
      coalesce(sum(metric.link_clicks), 0)::bigint as link_clicks,
      coalesce(sum(metric.spend_minor), 0)::bigint as spend_minor,
      coalesce(sum(metric.platform_conversions), 0)::numeric
        as platform_conversions,
      coalesce(sum(metric.platform_revenue_minor), 0)::bigint
        as platform_revenue_minor
    from selected_metrics metric
  ), attributed as (
    select
      count(distinct conversion.id) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )::integer as leads,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'qualified_lead'
          and conversion.status = 'active'
      )::integer as qualified_leads,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )::integer as sales,
      count(distinct conversion.id) filter (
        where conversion.status = 'refunded'
      )::integer as refunds,
      coalesce(sum(attribution.attributed_revenue_minor) filter (
        where conversion.currency = v_settings.base_currency
      ), 0)::bigint as revenue_minor,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status <> 'cancelled'
      )::integer as revenue_events,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status <> 'cancelled'
          and attribution.confidence <> 'untracked'
      )::integer as tracked_revenue_events
    from marketing_hub.conversion_events conversion
    left join marketing_hub.attributions attribution
      on attribution.conversion_event_id = conversion.id
     and attribution.model = v_settings.model
    where conversion.tenant_id = v_tenant.id
      and conversion.occurred_at::date between v_from and v_to
  )
  select jsonb_build_object(
    'currency', v_settings.base_currency,
    'impressions', performance.impressions,
    'reach', performance.reach,
    'clicks', performance.clicks,
    'linkClicks', performance.link_clicks,
    'spendMinor', performance.spend_minor,
    'platformConversions', round(performance.platform_conversions, 2),
    'platformRevenueMinor', performance.platform_revenue_minor,
    'leads', attributed.leads,
    'qualifiedLeads', attributed.qualified_leads,
    'sales', attributed.sales,
    'refunds', attributed.refunds,
    'revenueMinor', attributed.revenue_minor,
    'roas', case
      when performance.spend_minor > 0 then round(
        attributed.revenue_minor::numeric / performance.spend_minor,
        3
      )
      else null
    end,
    'ctr', case
      when performance.impressions > 0 then round(
        100.0 * performance.clicks / performance.impressions,
        2
      )
      else null
    end,
    'cpcMinor', case
      when performance.clicks > 0
        then round(performance.spend_minor::numeric / performance.clicks)
      else null
    end,
    'cplMinor', case
      when attributed.leads > 0
        then round(performance.spend_minor::numeric / attributed.leads)
      else null
    end,
    'cacMinor', case
      when attributed.sales > 0
        then round(performance.spend_minor::numeric / attributed.sales)
      else null
    end,
    'conversionRate', case
      when attributed.leads > 0 then round(
        100.0 * attributed.sales / attributed.leads,
        2
      )
      else null
    end,
    'attributionCoverageRate', case
      when attributed.revenue_events > 0 then round(
        100.0 * attributed.tracked_revenue_events
          / attributed.revenue_events,
        2
      )
      else null
    end
  )
  into v_summary
  from performance, attributed;

  with metric_level as (
    select
      metric.*,
      max(case metric.entity_level
        when 'ad' then 4
        when 'ad_group' then 3
        when 'campaign' then 2
        else 1
      end) over (
        partition by metric.ad_account_id, metric.metric_date
      ) as selected_level
    from marketing_hub.daily_metrics metric
    where metric.tenant_id = v_tenant.id
      and metric.metric_date between v_from and v_to
  ), performance as (
    select
      metric.campaign_id,
      metric.currency,
      sum(metric.impressions)::bigint as impressions,
      sum(metric.clicks)::bigint as clicks,
      sum(metric.link_clicks)::bigint as link_clicks,
      sum(metric.spend_minor)::bigint as spend_minor,
      sum(metric.platform_conversions)::numeric as platform_conversions,
      sum(metric.platform_revenue_minor)::bigint as platform_revenue_minor
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
    group by metric.campaign_id, metric.currency
  ), attributed as (
    select
      attribution.campaign_id,
      conversion.currency,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )::integer as leads,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'qualified_lead'
          and conversion.status = 'active'
      )::integer as qualified_leads,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )::integer as sales,
      count(distinct conversion.id) filter (
        where conversion.status = 'refunded'
      )::integer as refunds,
      sum(attribution.attributed_revenue_minor)::bigint as revenue_minor,
      round(avg(attribution.confidence_score), 0)::integer
        as confidence_score
    from marketing_hub.attributions attribution
    join marketing_hub.conversion_events conversion
      on conversion.id = attribution.conversion_event_id
    where attribution.tenant_id = v_tenant.id
      and attribution.model = v_settings.model
      and conversion.occurred_at::date between v_from and v_to
    group by attribution.campaign_id, conversion.currency
  ), rows as (
    select
      campaign.id,
      campaign.provider_key,
      campaign.external_campaign_id,
      campaign.name,
      campaign.objective,
      campaign.status,
      campaign.effective_status,
      account.name as account_name,
      coalesce(performance.currency, attributed.currency, account.currency)
        as currency,
      coalesce(performance.impressions, 0) as impressions,
      coalesce(performance.clicks, 0) as clicks,
      coalesce(performance.link_clicks, 0) as link_clicks,
      coalesce(performance.spend_minor, 0) as spend_minor,
      coalesce(performance.platform_conversions, 0)
        as platform_conversions,
      coalesce(performance.platform_revenue_minor, 0)
        as platform_revenue_minor,
      coalesce(attributed.leads, 0) as leads,
      coalesce(attributed.qualified_leads, 0) as qualified_leads,
      coalesce(attributed.sales, 0) as sales,
      coalesce(attributed.refunds, 0) as refunds,
      coalesce(attributed.revenue_minor, 0) as revenue_minor,
      attributed.confidence_score
    from marketing_hub.campaigns campaign
    join marketing_hub.ad_accounts account
      on account.id = campaign.ad_account_id
    left join performance
      on performance.campaign_id = campaign.id
    left join attributed
      on attributed.campaign_id = campaign.id
     and attributed.currency = coalesce(performance.currency, account.currency)
    where campaign.tenant_id = v_tenant.id
      and (
        performance.campaign_id is not null
        or attributed.campaign_id is not null
        or campaign.status in ('active','enabled')
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', rows.id,
    'providerKey', rows.provider_key,
    'externalCampaignId', rows.external_campaign_id,
    'name', rows.name,
    'objective', rows.objective,
    'status', rows.status,
    'effectiveStatus', rows.effective_status,
    'accountName', rows.account_name,
    'currency', rows.currency,
    'impressions', rows.impressions,
    'clicks', rows.clicks,
    'linkClicks', rows.link_clicks,
    'spendMinor', rows.spend_minor,
    'platformConversions', round(rows.platform_conversions, 2),
    'platformRevenueMinor', rows.platform_revenue_minor,
    'leads', rows.leads,
    'qualifiedLeads', rows.qualified_leads,
    'sales', rows.sales,
    'refunds', rows.refunds,
    'revenueMinor', rows.revenue_minor,
    'confidenceScore', rows.confidence_score,
    'roas', case
      when rows.spend_minor > 0
        then round(rows.revenue_minor::numeric / rows.spend_minor, 3)
      else null
    end,
    'ctr', case
      when rows.impressions > 0
        then round(100.0 * rows.clicks / rows.impressions, 2)
      else null
    end,
    'cplMinor', case
      when rows.leads > 0
        then round(rows.spend_minor::numeric / rows.leads)
      else null
    end,
    'cacMinor', case
      when rows.sales > 0
        then round(rows.spend_minor::numeric / rows.sales)
      else null
    end
  ) order by rows.spend_minor desc, rows.revenue_minor desc, rows.name), '[]'::jsonb)
  into v_campaigns
  from rows;

  with campaign_rows as (
    select value
    from jsonb_array_elements(v_campaigns) value
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'providerKey', source.provider_key,
    'spendMinor', source.spend_minor,
    'revenueMinor', source.revenue_minor,
    'leads', source.leads,
    'sales', source.sales,
    'roas', case
      when source.spend_minor > 0
        then round(source.revenue_minor::numeric / source.spend_minor, 3)
      else null
    end
  ) order by source.spend_minor desc, source.revenue_minor desc), '[]'::jsonb)
  into v_sources
  from (
    select
      value ->> 'providerKey' as provider_key,
      sum((value ->> 'spendMinor')::bigint)::bigint as spend_minor,
      sum((value ->> 'revenueMinor')::bigint)::bigint as revenue_minor,
      sum((value ->> 'leads')::integer)::integer as leads,
      sum((value ->> 'sales')::integer)::integer as sales
    from campaign_rows
    group by value ->> 'providerKey'
  ) source;

  with metric_level as (
    select
      metric.*,
      max(case metric.entity_level
        when 'ad' then 4
        when 'ad_group' then 3
        when 'campaign' then 2
        else 1
      end) over (
        partition by metric.ad_account_id, metric.metric_date
      ) as selected_level
    from marketing_hub.daily_metrics metric
    where metric.tenant_id = v_tenant.id
      and metric.metric_date between v_from and v_to
      and metric.currency = v_settings.base_currency
  ), performance as (
    select
      metric.metric_date as day,
      sum(metric.spend_minor)::bigint as spend_minor,
      sum(metric.clicks)::bigint as clicks,
      sum(metric.impressions)::bigint as impressions
    from metric_level metric
    where case metric.entity_level
      when 'ad' then 4
      when 'ad_group' then 3
      when 'campaign' then 2
      else 1
    end = metric.selected_level
    group by metric.metric_date
  ), attributed as (
    select
      conversion.occurred_at::date as day,
      count(distinct conversion.id) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )::integer as leads,
      count(distinct conversion.id) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )::integer as sales,
      sum(attribution.attributed_revenue_minor) filter (
        where conversion.currency = v_settings.base_currency
      )::bigint as revenue_minor
    from marketing_hub.conversion_events conversion
    left join marketing_hub.attributions attribution
      on attribution.conversion_event_id = conversion.id
     and attribution.model = v_settings.model
    where conversion.tenant_id = v_tenant.id
      and conversion.occurred_at::date between v_from and v_to
    group by conversion.occurred_at::date
  ), days as (
    select generate_series(v_from, v_to, interval '1 day')::date as day
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', days.day,
    'spendMinor', coalesce(performance.spend_minor, 0),
    'impressions', coalesce(performance.impressions, 0),
    'clicks', coalesce(performance.clicks, 0),
    'leads', coalesce(attributed.leads, 0),
    'sales', coalesce(attributed.sales, 0),
    'revenueMinor', coalesce(attributed.revenue_minor, 0)
  ) order by days.day), '[]'::jsonb)
  into v_daily
  from days
  left join performance on performance.day = days.day
  left join attributed on attributed.day = days.day;

  select jsonb_build_array(
    jsonb_build_object(
      'key', 'leads',
      'label', 'عملاء جدد',
      'count', count(*) filter (
        where conversion.event_type = 'lead'
          and conversion.status = 'active'
      )
    ),
    jsonb_build_object(
      'key', 'qualified',
      'label', 'عملاء مؤهلون',
      'count', count(*) filter (
        where conversion.event_type = 'qualified_lead'
          and conversion.status = 'active'
      )
    ),
    jsonb_build_object(
      'key', 'sales',
      'label', 'مبيعات موثقة',
      'count', count(*) filter (
        where conversion.event_type in (
          'payment',
          'purchase',
          'won_opportunity'
        )
          and conversion.status = 'active'
      )
    ),
    jsonb_build_object(
      'key', 'refunds',
      'label', 'مرتجعات',
      'count', count(*) filter (where conversion.status = 'refunded')
    )
  )
  into v_funnel
  from marketing_hub.conversion_events conversion
  where conversion.tenant_id = v_tenant.id
    and conversion.occurred_at::date between v_from and v_to;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', insight.id,
    'type', insight.insight_type,
    'severity', insight.severity,
    'title', insight.title_ar,
    'detail', insight.detail_ar,
    'recommendedAction', insight.recommended_action_ar,
    'providerKey', insight.provider_key,
    'campaignId', insight.campaign_id,
    'evidence', insight.evidence,
    'status', insight.status,
    'lastDetectedAt', insight.last_detected_at
  ) order by
    case insight.severity
      when 'critical' then 1
      when 'warning' then 2
      when 'opportunity' then 3
      else 4
    end,
    insight.last_detected_at desc
  ), '[]'::jsonb)
  into v_insights
  from marketing_hub.insights insight
  where insight.tenant_id = v_tenant.id
    and insight.status in ('open','acknowledged');

  select coalesce(jsonb_agg(source.value order by source.sort_order), '[]'::jsonb)
  into v_store_sources
  from (
    select
      10 + provider.sort_order as sort_order,
      jsonb_build_object(
        'providerKey', provider.provider_key,
        'nameAr', provider.name_ar,
        'status', connection.status,
        'lastSyncedAt', connection.last_synced_at,
        'orderCount', (
          select count(*)
          from commerce_hub.external_entities entity
          where entity.connection_id = connection.id
            and entity.entity_type = 'orders'
            and entity.sync_state = 'active'
        )
      ) as value
    from commerce_hub.connections connection
    join commerce_hub.providers provider
      on provider.provider_key = connection.provider_key
    where connection.tenant_id = v_tenant.id
      and connection.status <> 'disabled'
    union all
    select
      10,
      jsonb_build_object(
        'providerKey', 'woocommerce',
        'nameAr', 'WooCommerce',
        'status', connection.status,
        'lastSyncedAt', connection.last_synced_at,
        'orderCount', (
          select count(*)
          from commerce_sync.external_entities entity
          where entity.connection_id = connection.id
            and entity.entity_type = 'orders'
            and entity.sync_state = 'active'
        )
      )
    from commerce_sync.connections connection
    where connection.tenant_id = v_tenant.id
      and connection.status <> 'disabled'
  ) source;

  select jsonb_build_object(
    'activeConnections', count(*) filter (
      where connection.status in ('active','degraded')
    ),
    'connectionsNeedingAttention', count(*) filter (
      where connection.status in ('error','reauth_required')
    ),
    'staleConnections', count(*) filter (
      where connection.status in ('active','degraded')
        and (
          connection.last_synced_at is null
          or connection.last_synced_at < now() - interval '48 hours'
        )
    ),
    'lastSyncedAt', max(connection.last_synced_at),
    'currencyMismatches', (
      select count(distinct metric.currency)
      from marketing_hub.daily_metrics metric
      where metric.tenant_id = v_tenant.id
        and metric.metric_date between v_from and v_to
        and metric.currency <> v_settings.base_currency
    ),
    'commerceSources', jsonb_array_length(v_store_sources),
    'attributionModel', v_settings.model,
    'clickWindowDays', v_settings.click_window_days,
    'viewWindowDays', v_settings.view_window_days
  )
  into v_data_health
  from marketing_hub.connections connection
  where connection.tenant_id = v_tenant.id
    and connection.status <> 'disabled';

  return jsonb_build_object(
    'tenant', jsonb_build_object(
      'id', v_tenant.id,
      'slug', v_tenant.slug,
      'name', v_tenant.name,
      'timezone', v_settings.timezone
    ),
    'featureEnabled', v_feature_enabled,
    'canManage', v_can_manage,
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'settings', jsonb_build_object(
      'model', v_settings.model,
      'clickWindowDays', v_settings.click_window_days,
      'viewWindowDays', v_settings.view_window_days,
      'baseCurrency', v_settings.base_currency,
      'timezone', v_settings.timezone
    ),
    'providers', v_providers,
    'summary', v_summary,
    'campaigns', v_campaigns,
    'sources', v_sources,
    'daily', v_daily,
    'funnel', v_funnel,
    'insights', v_insights,
    'commerceSources', v_store_sources,
    'dataHealth', v_data_health
  );
end;
$$;

revoke all on function private_app.marketing_provider_from_source(text)
from public, anon, authenticated;
revoke all on function private_app.marketing_identity_hash(text)
from public, anon, authenticated;
revoke all on function private_app.marketing_phone_hash(text)
from public, anon, authenticated;
revoke all on function private_app.marketing_json_text(jsonb,text[])
from public, anon, authenticated;
revoke all on function private_app.marketing_event_revenue(bigint,text)
from public, anon, authenticated;
revoke all on function public.v2_marketing_hub_refresh_attribution(
  uuid,date,date
)
from public, anon, authenticated;
revoke all on function public.v2_tenant_marketing_hub_snapshot(
  text,date,date
)
from public, anon;

grant execute on function public.v2_marketing_hub_refresh_attribution(
  uuid,date,date
)
to service_role;
grant execute on function public.v2_tenant_marketing_hub_snapshot(
  text,date,date
)
to authenticated, service_role;

comment on function public.v2_tenant_marketing_hub_snapshot(text,date,date)
is 'Tenant-isolated campaign cost, first-party attribution, commerce revenue, ROAS, data health, and decision snapshot.';

commit;
