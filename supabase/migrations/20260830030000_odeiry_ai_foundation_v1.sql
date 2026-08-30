begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- ODEIRY AI foundation v1.
--
-- Safety properties:
--   * additive only; no existing row is updated or backfilled;
--   * globally disabled and tenant-disabled by default;
--   * no provider secret is stored in Postgres;
--   * usage is non-billable shadow telemetry, not an entitlement, wallet,
--     credit balance, invoice, or replacement for catalog.addon_usage_*;
--   * support tickets remain canonical in core.support_requests. ODEIRY only
--     records an immutable tenant-scoped link after the normal support flow.

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('access_control.subjects') is null
     or to_regclass('core.support_requests') is null then
    raise exception 'odeiry_foundation_missing_required_schema';
  end if;
  if to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure(
       'private_app.support_is_active_tenant_member(uuid)'
     ) is null
     or to_regprocedure(
       'private_app.support_tenant_can_read_ticket(uuid,uuid)'
     ) is null
     or to_regprocedure('private_app.has_platform_permission(text)') is null
     or to_regprocedure(
       'private_app.write_audit(text,text,text,uuid,jsonb)'
     ) is null
     or to_regprocedure(
       'private_app.v1_tenant_deletion_preview_document(uuid)'
     ) is null then
    raise exception 'odeiry_foundation_missing_required_function';
  end if;
end;
$preflight$;

create table platform.odeiry_runtime_settings (
  singleton boolean primary key default true
    constraint odeiry_runtime_settings_singleton_check check (singleton),
  enabled boolean not null default false,
  billing_mode text not null default 'shadow'
    constraint odeiry_runtime_settings_shadow_only_check
    check (billing_mode = 'shadow'),
  max_input_chars integer not null default 12000
    check (max_input_chars between 1000 and 24000),
  max_response_chars integer not null default 24000
    check (max_response_chars between 1000 and 24000),
  max_knowledge_results smallint not null default 6
    check (max_knowledge_results between 1 and 12),
  version integer not null default 1 check (version >= 1),
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into platform.odeiry_runtime_settings(singleton,enabled,billing_mode)
values (true,false,'shadow')
on conflict (singleton) do nothing;

create table core.odeiry_tenant_settings (
  tenant_id uuid primary key
    references core.tenants(id) on delete restrict,
  enabled boolean not null default false,
  billing_mode text not null default 'shadow'
    constraint odeiry_tenant_settings_shadow_only_check
    check (billing_mode = 'shadow'),
  shadow_soft_budget_units bigint
    check (
      shadow_soft_budget_units is null
      or shadow_soft_budget_units between 1 and 1000000000000
    ),
  run_rate_limit_per_minute smallint not null default 12
    check (run_rate_limit_per_minute between 1 and 60),
  retention_days smallint not null default 90
    check (retention_days between 30 and 730),
  version integer not null default 1 check (version >= 1),
  enabled_at timestamptz,
  enabled_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint odeiry_tenant_settings_enabled_audit_check check (
    (not enabled and enabled_at is null and enabled_by_subject_id is null)
    or (enabled and enabled_at is not null and enabled_by_subject_id is not null)
  )
);

create table core.odeiry_threads (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  created_by_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  title text not null
    check (char_length(btrim(title)) between 1 and 160),
  status text not null default 'active'
    check (status in ('active','archived')),
  version integer not null default 1 check (version >= 1),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint odeiry_threads_tenant_id_id_key unique (tenant_id,id),
  constraint odeiry_threads_tenant_owner_key
    unique (tenant_id,id,created_by_subject_id)
);

create table core.odeiry_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  thread_id uuid not null,
  requested_by_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  client_request_id text not null
    check (
      char_length(client_request_id) between 8 and 160
      and client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'
    ),
  request_hash text not null
    check (request_hash ~ '^[a-f0-9]{64}$'),
  finalization_hash text
    check (
      finalization_hash is null
      or finalization_hash ~ '^[a-f0-9]{64}$'
    ),
  status text not null default 'reserved'
    check (status in ('reserved','running','completed','failed','cancelled')),
  provider_key text not null default 'openai'
    check (provider_key = 'openai'),
  requested_model text
    check (
      requested_model is null
      or requested_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,99}$'
    ),
  actual_model text
    check (
      actual_model is null
      or actual_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,99}$'
    ),
  provider_response_id text
    check (
      provider_response_id is null
      or char_length(provider_response_id) between 1 and 240
    ),
  estimated_business_units bigint not null
    check (estimated_business_units between 1 and 1000000000),
  settled_business_units bigint
    check (
      settled_business_units is null
      or settled_business_units between 0 and 1000000000
    ),
  measured_business_units bigint
    check (
      measured_business_units is null
      or measured_business_units between 0 and 1000000000
    ),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  cached_input_tokens bigint
    check (cached_input_tokens is null or cached_input_tokens >= 0),
  reasoning_tokens bigint
    check (reasoning_tokens is null or reasoning_tokens >= 0),
  finish_reason text
    check (
      finish_reason is null
      or finish_reason ~ '^[a-z][a-z0-9_.-]{1,79}$'
    ),
  response_data jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(response_data) = 'object'
      and octet_length(response_data::text) <= 32768
    ),
  request_context jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(request_context) = 'object'
      and octet_length(request_context::text) <= 2048
    ),
  error_code text
    check (
      error_code is null
      or error_code ~ '^[a-z][a-z0-9_.-]{1,99}$'
    ),
  attempt_count smallint not null default 1
    check (attempt_count between 1 and 20),
  knowledge_search_count smallint not null default 0
    check (knowledge_search_count between 0 and 3),
  reservation_expires_at timestamptz not null
    default (now() + interval '15 minutes'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint odeiry_runs_thread_owner_fk
    foreign key (tenant_id,thread_id,requested_by_subject_id)
    references core.odeiry_threads(
      tenant_id,id,created_by_subject_id
    ) on delete restrict,
  constraint odeiry_runs_tenant_id_id_key unique (tenant_id,id),
  constraint odeiry_runs_tenant_id_thread_id_id_key
    unique (tenant_id,id,thread_id),
  constraint odeiry_runs_client_request_key
    unique (tenant_id,requested_by_subject_id,client_request_id),
  constraint odeiry_runs_settlement_bounds_check check (
    settled_business_units is null
    or settled_business_units <= estimated_business_units
  ),
  constraint odeiry_runs_measured_bounds_check check (
    measured_business_units is null
    or settled_business_units is null
    or measured_business_units >= settled_business_units
  ),
  constraint odeiry_runs_terminal_state_check check (
    (
      status in ('reserved','running')
      and completed_at is null
      and finalization_hash is null
    )
    or (
      status in ('completed','failed','cancelled')
      and completed_at is not null
      and finalization_hash is not null
    )
  )
);

create table core.odeiry_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  thread_id uuid not null,
  run_id uuid not null,
  message_role text not null
    check (message_role in ('user','assistant','system','tool')),
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  content text not null
    check (
      char_length(btrim(content)) between 1 and 24000
      and octet_length(content) <= 96000
    ),
  content_hash text not null
    check (content_hash ~ '^[a-f0-9]{64}$'),
  citations jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(citations) = 'array'
      and jsonb_array_length(citations) <= 20
      and octet_length(citations::text) <= 12000
    ),
  created_at timestamptz not null default now(),
  constraint odeiry_messages_run_thread_fk
    foreign key (tenant_id,run_id,thread_id)
    references core.odeiry_runs(tenant_id,id,thread_id)
    on delete restrict,
  constraint odeiry_messages_tenant_id_id_key unique (tenant_id,id)
);

create table core.odeiry_usage_events (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  run_id uuid not null,
  event_type text not null
    check (
      event_type in (
        'reservation_created','usage_settled','reservation_released'
      )
    ),
  idempotency_key text not null
    check (
      char_length(idempotency_key) between 8 and 180
      and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$'
    ),
  business_units bigint not null
    check (business_units between 0 and 1000000000),
  measured_business_units bigint not null default 0
    check (measured_business_units between 0 and 1000000000),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cached_input_tokens bigint not null default 0
    check (cached_input_tokens >= 0),
  reasoning_tokens bigint not null default 0
    check (reasoning_tokens >= 0),
  provider_cost_micros bigint not null default 0
    check (provider_cost_micros >= 0),
  provider_cost_currency text not null default 'USD'
    check (provider_cost_currency ~ '^[A-Z]{3}$'),
  billable boolean not null default false,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint odeiry_usage_events_run_fk
    foreign key (tenant_id,run_id)
    references core.odeiry_runs(tenant_id,id) on delete restrict,
  constraint odeiry_usage_events_idempotency_key
    unique (tenant_id,idempotency_key),
  constraint odeiry_usage_events_shadow_only_check check (not billable),
  constraint odeiry_usage_events_lifecycle_units_check check (
    (
      event_type = 'reservation_created'
      and business_units > 0
      and measured_business_units = business_units
    )
    or (
      event_type = 'usage_settled'
      and measured_business_units >= business_units
    )
    or (
      event_type = 'reservation_released'
      and business_units > 0
      and measured_business_units = 0
    )
  )
);

create table platform.odeiry_knowledge_articles (
  id uuid primary key default extensions.gen_random_uuid(),
  article_key text not null unique
    check (article_key ~ '^[a-z][a-z0-9_.-]{2,119}$'),
  module_key text not null
    check (module_key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  title_ar text not null
    check (char_length(btrim(title_ar)) between 3 and 240),
  summary_ar text not null
    check (char_length(btrim(summary_ar)) between 10 and 1000),
  body_ar text not null
    check (
      char_length(btrim(body_ar)) between 20 and 50000
      and octet_length(body_ar) <= 160000
    ),
  tags text[] not null default '{}'::text[]
    check (cardinality(tags) <= 30),
  audience text[] not null default array['employee','manager']::text[]
    check (
      cardinality(audience) between 1 and 4
      and audience <@ array[
        'employee','manager','tenant_owner','platform_support'
      ]::text[]
    ),
  source_kind text not null
    constraint odeiry_knowledge_source_kind_check
    check (
      source_kind in (
        'odeir_product_docs','odeir_support_policy','odeir_release_note'
      )
    ),
  source_reference text not null
    constraint odeiry_knowledge_source_reference_check
    check (
      source_reference
      ~ '^(component|route|policy|release)/[A-Za-z0-9_./-]{1,220}$'
    ),
  public_url text
    constraint odeiry_knowledge_public_url_check
    check (
      public_url is null
      or public_url
        ~ '^https://(www\.)?odeir\.com/[A-Za-z0-9/_-]*$'
    ),
  status text not null default 'draft'
    check (status in ('draft','published','archived')),
  version integer not null default 1 check (version >= 1),
  published_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(
      to_tsvector('simple'::regconfig,coalesce(title_ar,'')),'A'
    )
    || setweight(
      to_tsvector('simple'::regconfig,coalesce(summary_ar,'')),'B'
    )
    || setweight(
      to_tsvector('simple'::regconfig,coalesce(body_ar,'')),'C'
    )
  ) stored,
  constraint odeiry_knowledge_published_state_check check (
    status <> 'published' or published_at is not null
  )
);

create table core.odeiry_ticket_escalations (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  thread_id uuid not null,
  run_id uuid not null,
  support_request_id uuid not null,
  linked_by_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  reason_code text not null
    check (
      reason_code in (
        'unresolved','low_confidence','user_requested','suspected_bug',
        'security_concern','other'
      )
    ),
  client_request_id text not null
    check (
      char_length(client_request_id) between 8 and 160
      and client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'
    ),
  request_hash text not null
    check (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint odeiry_ticket_escalations_run_thread_fk
    foreign key (tenant_id,run_id,thread_id)
    references core.odeiry_runs(tenant_id,id,thread_id)
    on delete restrict,
  constraint odeiry_ticket_escalations_support_fk
    foreign key (tenant_id,support_request_id)
    references core.support_requests(tenant_id,id)
    on delete restrict,
  constraint odeiry_ticket_escalations_run_key unique (tenant_id,run_id),
  constraint odeiry_ticket_escalations_ticket_key
    unique (tenant_id,support_request_id),
  constraint odeiry_ticket_escalations_client_request_key
    unique (tenant_id,linked_by_subject_id,client_request_id)
);

create index platform_odeiry_runtime_updated_by_idx
on platform.odeiry_runtime_settings(updated_by_subject_id)
where updated_by_subject_id is not null;

create index core_odeiry_tenant_settings_enabled_by_idx
on core.odeiry_tenant_settings(enabled_by_subject_id)
where enabled_by_subject_id is not null;

create index core_odeiry_tenant_settings_updated_by_idx
on core.odeiry_tenant_settings(updated_by_subject_id)
where updated_by_subject_id is not null;

create index core_odeiry_tenant_settings_enabled_idx
on core.odeiry_tenant_settings(tenant_id)
where enabled;

create index core_odeiry_threads_owner_activity_idx
on core.odeiry_threads(
  tenant_id,created_by_subject_id,updated_at desc,id desc
);

create index core_odeiry_threads_subject_reference_idx
on core.odeiry_threads(created_by_subject_id);

create index core_odeiry_runs_thread_activity_idx
on core.odeiry_runs(tenant_id,thread_id,created_at desc,id desc);

create index core_odeiry_runs_subject_rate_idx
on core.odeiry_runs(
  tenant_id,requested_by_subject_id,created_at desc,id desc
);

create index core_odeiry_runs_subject_reference_idx
on core.odeiry_runs(requested_by_subject_id);

create index core_odeiry_runs_open_expiry_idx
on core.odeiry_runs(reservation_expires_at,id)
where status in ('reserved','running');

create index core_odeiry_messages_thread_time_idx
on core.odeiry_messages(tenant_id,thread_id,created_at,id);

create index core_odeiry_messages_creator_reference_idx
on core.odeiry_messages(created_by_subject_id)
where created_by_subject_id is not null;

create unique index core_odeiry_messages_run_role_uidx
on core.odeiry_messages(tenant_id,run_id,message_role)
where message_role in ('user','assistant');

create index core_odeiry_usage_events_tenant_time_idx
on core.odeiry_usage_events(tenant_id,occurred_at desc,id desc);

create index core_odeiry_usage_events_run_time_idx
on core.odeiry_usage_events(tenant_id,run_id,occurred_at,id);

create index platform_odeiry_knowledge_search_idx
on platform.odeiry_knowledge_articles using gin(search_vector);

create index platform_odeiry_knowledge_published_module_idx
on platform.odeiry_knowledge_articles(module_key,updated_at desc,id)
where status = 'published';

create index core_odeiry_ticket_escalations_thread_idx
on core.odeiry_ticket_escalations(tenant_id,thread_id,created_at desc);

create index core_odeiry_ticket_escalations_linked_by_idx
on core.odeiry_ticket_escalations(linked_by_subject_id,created_at desc);

alter table platform.odeiry_runtime_settings enable row level security;
alter table core.odeiry_tenant_settings enable row level security;
alter table core.odeiry_threads enable row level security;
alter table core.odeiry_runs enable row level security;
alter table core.odeiry_messages enable row level security;
alter table core.odeiry_usage_events enable row level security;
alter table platform.odeiry_knowledge_articles enable row level security;
alter table core.odeiry_ticket_escalations enable row level security;

revoke all on table platform.odeiry_runtime_settings
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_tenant_settings
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_threads
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_runs
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_messages
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_usage_events
from public,anon,authenticated,service_role;
revoke all on table platform.odeiry_knowledge_articles
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_ticket_escalations
from public,anon,authenticated,service_role;

create or replace function private_app.odeiry_is_active_tenant_member(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and private_app.support_is_active_tenant_member(p_tenant_id)
$$;

create or replace function private_app.odeiry_can_read_thread(
  p_tenant_id uuid,
  p_thread_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private_app.odeiry_is_active_tenant_member(p_tenant_id)
    and exists(
      select 1
      from core.odeiry_threads thread
      where thread.tenant_id = p_tenant_id
        and thread.id = p_thread_id
        and thread.created_by_subject_id = private_app.current_subject_id()
    )
$$;

create or replace function private_app.odeiry_is_available(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from platform.odeiry_runtime_settings runtime
    join core.odeiry_tenant_settings setting
      on setting.tenant_id = p_tenant_id
    where runtime.singleton
      and runtime.enabled
      and runtime.billing_mode = 'shadow'
      and setting.enabled
      and setting.billing_mode = 'shadow'
  )
$$;

create or replace function private_app.odeiry_validate_client_request_id(
  p_value text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := btrim(coalesce(p_value,''));
begin
  if char_length(v_value) not between 8 and 160
     or v_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$' then
    raise exception 'odeiry_client_request_id_invalid';
  end if;
  return v_value;
end;
$$;

create or replace function public.v3_platform_odeiry_configure(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text := lower(btrim(coalesce(p_action,'')));
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_setting core.odeiry_tenant_settings%rowtype;
  v_tenant core.tenants%rowtype;
  v_actor_id uuid := private_app.current_subject_id();
  v_expected_version integer;
  v_enabled boolean;
  v_soft_budget bigint;
  v_rate_limit smallint;
  v_retention_days smallint;
  v_now timestamptz := clock_timestamp();
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'odeiry_configuration_invalid';
  end if;
  if octet_length(p_payload::text) > 8192 then
    raise exception 'odeiry_configuration_invalid';
  end if;

  if v_action = 'set_runtime' then
    if exists(
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in ('enabled','expectedVersion')
    )
       or not p_payload ? 'enabled'
       or jsonb_typeof(p_payload -> 'enabled') <> 'boolean' then
      raise exception 'odeiry_configuration_invalid';
    end if;
    begin
      v_enabled := (p_payload ->> 'enabled')::boolean;
      v_expected_version := (p_payload ->> 'expectedVersion')::integer;
    exception when others then
      raise exception 'odeiry_configuration_invalid';
    end;
    select runtime.* into v_runtime
    from platform.odeiry_runtime_settings runtime
    where runtime.singleton
    for update;
    if v_runtime.singleton is null then
      raise exception 'odeiry_runtime_missing';
    end if;
    if v_expected_version is null
       or v_expected_version <> v_runtime.version then
      raise exception 'odeiry_version_conflict';
    end if;
    update platform.odeiry_runtime_settings runtime
    set enabled = v_enabled,
        billing_mode = 'shadow',
        version = runtime.version + 1,
        updated_by_subject_id = v_actor_id,
        updated_at = v_now
    where runtime.singleton
    returning * into v_runtime;
    perform private_app.write_audit(
      'odeiry.runtime.configured','odeiry_runtime','default',null,
      jsonb_build_object(
        'enabled',v_runtime.enabled,
        'billingMode','shadow',
        'version',v_runtime.version
      )
    );
    return jsonb_build_object(
      'action','set_runtime',
      'enabled',v_runtime.enabled,
      'billingMode',v_runtime.billing_mode,
      'version',v_runtime.version
    );
  end if;

  if v_action = 'configure_tenant' then
    if exists(
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in (
        'tenantSlug','enabled','expectedVersion','shadowSoftBudgetUnits',
        'runRateLimitPerMinute','retentionDays'
      )
    )
       or not p_payload ? 'enabled'
       or jsonb_typeof(p_payload -> 'enabled') <> 'boolean' then
      raise exception 'odeiry_configuration_invalid';
    end if;
    select tenant.* into v_tenant
    from core.tenants tenant
    where tenant.slug = btrim(coalesce(p_payload ->> 'tenantSlug',''))
    limit 1;
    if v_tenant.id is null then
      raise exception 'tenant_not_found';
    end if;
    begin
      v_enabled := (p_payload ->> 'enabled')::boolean;
      v_expected_version := (p_payload ->> 'expectedVersion')::integer;
    exception when others then
      raise exception 'odeiry_configuration_invalid';
    end;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:odeiry:tenant-config:'||v_tenant.id::text,0
      )
    );
    select setting.* into v_setting
    from core.odeiry_tenant_settings setting
    where setting.tenant_id = v_tenant.id
    for update;
    begin
      v_soft_budget := case
        when p_payload ? 'shadowSoftBudgetUnits' then
          nullif(p_payload ->> 'shadowSoftBudgetUnits','')::bigint
        else v_setting.shadow_soft_budget_units
      end;
      v_rate_limit := coalesce(
        case when p_payload ? 'runRateLimitPerMinute' then
          (p_payload ->> 'runRateLimitPerMinute')::smallint
        else v_setting.run_rate_limit_per_minute end,
        12
      );
      v_retention_days := coalesce(
        case when p_payload ? 'retentionDays' then
          (p_payload ->> 'retentionDays')::smallint
        else v_setting.retention_days end,
        90
      );
    exception when others then
      raise exception 'odeiry_configuration_invalid';
    end;
    if (v_soft_budget is not null
          and v_soft_budget not between 1 and 1000000000000)
       or v_rate_limit not between 1 and 60
       or v_retention_days not between 30 and 730 then
      raise exception 'odeiry_configuration_invalid';
    end if;

    if v_setting.tenant_id is null then
      if v_expected_version is distinct from 0 then
        raise exception 'odeiry_version_conflict';
      end if;
      insert into core.odeiry_tenant_settings(
        tenant_id,enabled,billing_mode,shadow_soft_budget_units,
        run_rate_limit_per_minute,retention_days,version,
        enabled_at,enabled_by_subject_id,updated_by_subject_id,
        created_at,updated_at
      ) values (
        v_tenant.id,v_enabled,'shadow',v_soft_budget,v_rate_limit,
        v_retention_days,1,
        case when v_enabled then v_now else null end,
        case when v_enabled then v_actor_id else null end,
        v_actor_id,v_now,v_now
      ) returning * into v_setting;
    else
      if v_expected_version is null
         or v_expected_version <> v_setting.version then
        raise exception 'odeiry_version_conflict';
      end if;
      update core.odeiry_tenant_settings setting
      set enabled = v_enabled,
          billing_mode = 'shadow',
          shadow_soft_budget_units = v_soft_budget,
          run_rate_limit_per_minute = v_rate_limit,
          retention_days = v_retention_days,
          version = setting.version + 1,
          enabled_at = case when v_enabled then
            coalesce(setting.enabled_at,v_now) else null end,
          enabled_by_subject_id = case when v_enabled then
            coalesce(setting.enabled_by_subject_id,v_actor_id) else null end,
          updated_by_subject_id = v_actor_id,
          updated_at = v_now
      where setting.tenant_id = v_tenant.id
      returning * into v_setting;
    end if;
    perform private_app.write_audit(
      'odeiry.tenant.configured','tenant',v_tenant.id::text,
      v_tenant.id,jsonb_build_object(
        'enabled',v_setting.enabled,
        'billingMode','shadow',
        'shadowSoftBudgetUnits',v_setting.shadow_soft_budget_units,
        'softBudgetEnforced',false,
        'runRateLimitPerMinute',v_setting.run_rate_limit_per_minute,
        'retentionDays',v_setting.retention_days,
        'version',v_setting.version
      )
    );
    return jsonb_build_object(
      'action','configure_tenant',
      'tenantId',v_tenant.id,
      'tenantSlug',v_tenant.slug,
      'enabled',v_setting.enabled,
      'billingMode',v_setting.billing_mode,
      'shadowSoftBudgetUnits',v_setting.shadow_soft_budget_units,
      'softBudgetEnforced',false,
      'runRateLimitPerMinute',v_setting.run_rate_limit_per_minute,
      'retentionDays',v_setting.retention_days,
      'version',v_setting.version
    );
  end if;

  raise exception 'odeiry_configuration_action_invalid';
end;
$$;

-- Keep tenant deletion fail-closed until a future, separately reviewed cleanup
-- phase knows how to remove AI conversations and telemetry deliberately.
alter function private_app.v1_tenant_deletion_preview_document(uuid)
rename to v1_tenant_deletion_preview_document_odeiry_legacy_internal;

revoke all on function
  private_app.v1_tenant_deletion_preview_document_odeiry_legacy_internal(uuid)
from public,anon,authenticated,service_role;

create or replace function private_app.v1_tenant_deletion_preview_document(
  p_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_counts jsonb;
  v_blockers jsonb;
  v_settings bigint := 0;
  v_threads bigint := 0;
  v_runs bigint := 0;
  v_messages bigint := 0;
  v_usage_events bigint := 0;
  v_escalations bigint := 0;
  v_total bigint := 0;
  v_digest text;
begin
  v_result := private_app
    .v1_tenant_deletion_preview_document_odeiry_legacy_internal(
      p_tenant_id
    );
  select count(*) into v_settings
  from core.odeiry_tenant_settings setting
  where setting.tenant_id = p_tenant_id;
  select count(*) into v_threads
  from core.odeiry_threads thread
  where thread.tenant_id = p_tenant_id;
  select count(*) into v_runs
  from core.odeiry_runs run
  where run.tenant_id = p_tenant_id;
  select count(*) into v_messages
  from core.odeiry_messages message
  where message.tenant_id = p_tenant_id;
  select count(*) into v_usage_events
  from core.odeiry_usage_events usage_event
  where usage_event.tenant_id = p_tenant_id;
  select count(*) into v_escalations
  from core.odeiry_ticket_escalations escalation
  where escalation.tenant_id = p_tenant_id;
  v_total := v_settings + v_threads + v_runs + v_messages
    + v_usage_events + v_escalations;
  v_counts := coalesce(v_result -> 'counts','{}'::jsonb)
    || jsonb_build_object(
      'odeiryTenantSettings',v_settings,
      'odeiryThreads',v_threads,
      'odeiryRuns',v_runs,
      'odeiryMessages',v_messages,
      'odeiryUsageEvents',v_usage_events,
      'odeiryTicketEscalations',v_escalations
    );
  v_blockers := coalesce(v_result -> 'blockers','[]'::jsonb);
  if v_total > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code','odeiry_history_exists',
      'count',v_total,
      'message','توجد إعدادات أو محادثات أو سجلات قياس لأوديري تتطلب قرار احتفاظ صريحًا.'
    ));
  end if;
  v_digest := encode(extensions.digest(
    coalesce(v_result ->> 'previewDigest','')||'|'||v_counts::text||'|'
      ||v_blockers::text,
    'sha256'
  ),'hex');
  return jsonb_set(
    jsonb_set(
      jsonb_set(v_result,'{counts}',v_counts,true),
      '{blockers}',v_blockers,true
    ),
    '{canDelete}',to_jsonb(jsonb_array_length(v_blockers) = 0),true
  ) || jsonb_build_object(
    'dependencyFingerprint',encode(extensions.digest(
      coalesce(v_result ->> 'dependencyFingerprint','')||'|'
        ||v_settings::text||'|'||v_threads::text||'|'||v_runs::text||'|'
        ||v_messages::text||'|'||v_usage_events::text||'|'
        ||v_escalations::text,
      'sha256'
    ),'hex'),
    'previewDigest',v_digest
  );
end;
$$;

revoke all on function private_app.v1_tenant_deletion_preview_document(uuid)
from public,anon,authenticated,service_role;

create or replace function private_app.odeiry_sha256(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(coalesce(p_payload,'{}'::jsonb)::text,'sha256'),
    'hex'
  )
$$;

create or replace function private_app.odeiry_set_updated_at_clock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := greatest(
    coalesce(old.updated_at,'epoch'::timestamptz),
    coalesce(new.updated_at,'epoch'::timestamptz),
    clock_timestamp()
  );
  return new;
end;
$$;

create or replace function private_app.odeiry_usage_events_append_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'odeiry_usage_events_append_only';
end;
$$;

create or replace function private_app.odeiry_run_document(
  p_tenant_id uuid,
  p_run_id uuid,
  p_subject_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'runId',run.id,
    'threadId',run.thread_id,
    'status',run.status,
    'clientRequestId',run.client_request_id,
    'provider',run.provider_key,
    'requestedModel',run.requested_model,
    'actualModel',run.actual_model,
    'reservedUnits',run.estimated_business_units,
    'settledUnits',run.settled_business_units,
    'measuredActualUnits',run.measured_business_units,
    'inputTokens',run.input_tokens,
    'outputTokens',run.output_tokens,
    'cachedInputTokens',run.cached_input_tokens,
    'reasoningTokens',run.reasoning_tokens,
    'finishReason',run.finish_reason,
    'attemptCount',run.attempt_count,
    'reservationExpiresAt',run.reservation_expires_at,
    'responseText',(
      select message.content
      from core.odeiry_messages message
      where message.tenant_id = run.tenant_id
        and message.run_id = run.id
        and message.message_role = 'assistant'
      limit 1
    ),
    'responseData',run.response_data,
    'citations',coalesce((
      select message.citations
      from core.odeiry_messages message
      where message.tenant_id = run.tenant_id
        and message.run_id = run.id
        and message.message_role = 'assistant'
      limit 1
    ),'[]'::jsonb),
    'errorCode',run.error_code,
    'createdAt',run.created_at,
    'completedAt',run.completed_at
  ))
  from core.odeiry_runs run
  where run.tenant_id = p_tenant_id
    and run.id = p_run_id
    and run.requested_by_subject_id = p_subject_id
$$;

create or replace function private_app.odeiry_context_messages(
  p_tenant_id uuid,
  p_thread_id uuid,
  p_subject_id uuid,
  p_excluded_message_id uuid,
  p_limit integer default 12
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role',recent.message_role,
        'content',left(recent.content,4000),
        'createdAt',recent.created_at
      ) order by recent.created_at,recent.id
    ),
    '[]'::jsonb
  )
  from (
    select message.id,message.message_role,message.content,message.created_at
    from core.odeiry_messages message
    join core.odeiry_threads thread
      on thread.tenant_id = message.tenant_id
     and thread.id = message.thread_id
    where message.tenant_id = p_tenant_id
      and message.thread_id = p_thread_id
      and message.id <> p_excluded_message_id
      and message.message_role in ('user','assistant')
      and thread.created_by_subject_id = p_subject_id
    order by message.created_at desc,message.id desc
    limit least(greatest(coalesce(p_limit,12),1),12)
  ) recent
$$;

revoke all on function private_app.odeiry_is_active_tenant_member(uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_can_read_thread(uuid,uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_is_available(uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_validate_client_request_id(text)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_sha256(jsonb)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_set_updated_at_clock()
from public,anon,authenticated,service_role;
revoke all on function
  private_app.odeiry_usage_events_append_only_guard()
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_run_document(uuid,uuid,uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_context_messages(
  uuid,uuid,uuid,uuid,integer
) from public,anon,authenticated,service_role;

create trigger odeiry_runtime_settings_set_updated_at
before update on platform.odeiry_runtime_settings
for each row execute function private_app.odeiry_set_updated_at_clock();

create trigger odeiry_tenant_settings_set_updated_at
before update on core.odeiry_tenant_settings
for each row execute function private_app.odeiry_set_updated_at_clock();

create trigger odeiry_threads_set_updated_at
before update on core.odeiry_threads
for each row execute function private_app.odeiry_set_updated_at_clock();

create trigger odeiry_runs_set_updated_at
before update on core.odeiry_runs
for each row execute function private_app.odeiry_set_updated_at_clock();

create trigger odeiry_knowledge_articles_set_updated_at
before update on platform.odeiry_knowledge_articles
for each row execute function private_app.odeiry_set_updated_at_clock();

create trigger odeiry_usage_events_append_only
before update or delete on core.odeiry_usage_events
for each row execute function
  private_app.odeiry_usage_events_append_only_guard();

create policy odeiry_tenant_settings_isolated_read
on core.odeiry_tenant_settings
for select
to authenticated
using (private_app.odeiry_is_active_tenant_member(tenant_id));

create policy odeiry_threads_owner_read
on core.odeiry_threads
for select
to authenticated
using (
  private_app.odeiry_is_active_tenant_member(tenant_id)
  and created_by_subject_id = private_app.current_subject_id()
);

create policy odeiry_runs_owner_read
on core.odeiry_runs
for select
to authenticated
using (
  private_app.odeiry_is_active_tenant_member(tenant_id)
  and requested_by_subject_id = private_app.current_subject_id()
);

create policy odeiry_messages_owner_read
on core.odeiry_messages
for select
to authenticated
using (
  private_app.odeiry_can_read_thread(tenant_id,thread_id)
);

create policy odeiry_usage_events_owner_read
on core.odeiry_usage_events
for select
to authenticated
using (
  private_app.odeiry_is_active_tenant_member(tenant_id)
  and exists(
    select 1
    from core.odeiry_runs run
    where run.tenant_id = odeiry_usage_events.tenant_id
      and run.id = odeiry_usage_events.run_id
      and run.requested_by_subject_id = private_app.current_subject_id()
  )
);

create policy odeiry_ticket_escalations_owner_read
on core.odeiry_ticket_escalations
for select
to authenticated
using (
  private_app.odeiry_is_active_tenant_member(tenant_id)
  and linked_by_subject_id = private_app.current_subject_id()
);

-- These articles describe only behavior that already exists in the support
-- component and v3 support RPC. They contain no tenant or user data.
insert into platform.odeiry_knowledge_articles(
  article_key,module_key,title_ar,summary_ar,body_ar,tags,audience,
  source_kind,source_reference,status,published_at,reviewed_at
) values
(
  'support.open_ticket','support',
  'كيفية فتح تذكرة دعم فني في أودير',
  'البيانات المطلوبة لإرسال مشكلة واضحة إلى فريق الدعم ومتابعتها بسرعة.',
  'من قسم الدعم الفني اضغط فتح تذكرة، ثم اختر الوحدة المتأثرة وحجم الأثر والأولوية. اكتب عنوانًا محددًا ووصفًا يوضح ما حدث، وأضف خطوات تكرار المشكلة والنتيجة المتوقعة والنتيجة الفعلية إن أمكن. يرفق أودير سياق المتصفح والمسار بصورة آمنة لمساعدة الفريق في التشخيص. راجع البيانات ثم أرسل التذكرة؛ سيظهر رقم مرجعي يمكن متابعته من نفس القسم.',
  array['الدعم الفني','فتح تذكرة','تشخيص']::text[],
  array['employee','manager','tenant_owner']::text[],
  'odeir_product_docs','component/odeir-support-desk',
  'published',now(),now()
),
(
  'support.ticket_lifecycle','support',
  'متابعة التذكرة وتأكيد الحل',
  'طريقة متابعة ردود فريق ماركتون وإعادة فتح المشكلة أو إغلاقها بعد الحل.',
  'تظهر المحادثة وحالة التذكرة داخل قسم الدعم الفني. عندما يرسل فريق ماركتون ردًا يمكنك إضافة رسالة جديدة من نفس التذكرة. بعد تحويلها إلى محلولة يظهر خيار تأكيد الحل وإغلاق التذكرة، وإذا كانت المشكلة ما زالت قائمة اختر إعادة فتحها ليصل إشعار المتابعة إلى الفريق. لا تنشئ تذكرة ثانية لنفس المشكلة ما دام بإمكانك متابعة التذكرة الحالية.',
  array['متابعة التذكرة','إغلاق التذكرة','إعادة الفتح']::text[],
  array['employee','manager','tenant_owner']::text[],
  'odeir_support_policy','policy/support-workflow-v1',
  'published',now(),now()
),
(
  'support.initial_diagnostics','support',
  'معلومات التشخيص الأولي للمشكلة',
  'معلومات بسيطة تساعد أوديري وفريق الدعم على الوصول إلى سبب المشكلة.',
  'قبل التصعيد حدّد الصفحة أو الوحدة التي ظهرت فيها المشكلة، وما الخطوات التي سبقتها، وهل تتكرر مع مستخدم واحد أم أكثر. سجّل النتيجة الفعلية والنتيجة التي كنت تتوقعها، وتجنب إرسال كلمات المرور أو مفاتيح الربط أو بيانات حساسة داخل المحادثة. إذا استمرت المشكلة يستطيع أوديري إعداد مسودة تذكرة، لكن إنشاء التذكرة يظل إجراءً مؤكدًا من المستخدم عبر مسار الدعم الفني المعتاد.',
  array['تشخيص أولي','أمان','تصعيد']::text[],
  array['employee','manager','tenant_owner']::text[],
  'odeir_support_policy','route/api-support-tenant-action',
  'published',now(),now()
)
on conflict (article_key) do nothing;

create or replace function public.v3_tenant_odeiry_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_setting core.odeiry_tenant_settings%rowtype;
  v_subject_id uuid := private_app.current_subject_id();
  v_available boolean := false;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,'')) > 240 then
    raise exception 'odeiry_slug_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if v_subject_id is null
     or not private_app.odeiry_is_active_tenant_member(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  select runtime.* into v_runtime
  from platform.odeiry_runtime_settings runtime
  where runtime.singleton;
  select setting.* into v_setting
  from core.odeiry_tenant_settings setting
  where setting.tenant_id = v_tenant.id;
  v_available := coalesce(v_runtime.enabled,false)
    and coalesce(v_setting.enabled,false)
    and coalesce(v_runtime.billing_mode,'shadow') = 'shadow'
    and coalesce(v_setting.billing_mode,'shadow') = 'shadow';

  return jsonb_build_object(
    'schemaVersion',1,
    'generatedAt',now(),
    'available',v_available,
    'enabled',coalesce(v_setting.enabled,false),
    'globalEnabled',coalesce(v_runtime.enabled,false),
    'reason',case
      when not coalesce(v_runtime.enabled,false) then 'globally_disabled'
      when not coalesce(v_setting.enabled,false) then 'tenant_disabled'
      else null
    end,
    'billing',jsonb_build_object(
      'mode','shadow',
      'billable',false,
      'softBudgetUnits',v_setting.shadow_soft_budget_units,
      'softBudgetEnforced',false
    ),
    'limits',jsonb_build_object(
      'maxInputChars',coalesce(v_runtime.max_input_chars,12000),
      'maxResponseChars',coalesce(v_runtime.max_response_chars,24000),
      'maxKnowledgeResults',coalesce(
        v_runtime.max_knowledge_results,6
      ),
      'runsPerMinute',coalesce(v_setting.run_rate_limit_per_minute,12)
    )
  );
end;
$$;

create or replace function public.v3_tenant_odeiry_action(
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
  v_setting core.odeiry_tenant_settings%rowtype;
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_thread core.odeiry_threads%rowtype;
  v_run core.odeiry_runs%rowtype;
  v_escalation core.odeiry_ticket_escalations%rowtype;
  v_subject_id uuid := private_app.current_subject_id();
  v_action text := lower(btrim(coalesce(p_action,'')));
  v_thread_id uuid;
  v_run_id uuid;
  v_ticket_id uuid;
  v_user_message_id uuid;
  v_client_request_id text;
  v_request_hash text;
  v_user_message text;
  v_model text;
  v_reason_code text;
  v_estimated_units bigint;
  v_expected_version integer;
  v_context jsonb := '[]'::jsonb;
  v_request_context jsonb := '{}'::jsonb;
  v_minimum_estimated_units bigint;
  v_requested_estimated_units bigint;
  v_now timestamptz := clock_timestamp();
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'odeiry_payload_invalid';
  end if;
  if octet_length(p_payload::text) > 65536
     or char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,'')) > 240 then
    raise exception 'odeiry_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if v_subject_id is null
     or not private_app.odeiry_is_active_tenant_member(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  if v_action = 'start_run' then
    if exists(
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in (
        'threadId','clientRequestId','userMessage','estimatedUnits',
        'model','context'
      )
    ) then
      raise exception 'odeiry_payload_invalid';
    end if;
    select runtime.* into v_runtime
    from platform.odeiry_runtime_settings runtime
    where runtime.singleton;
    select setting.* into v_setting
    from core.odeiry_tenant_settings setting
    where setting.tenant_id = v_tenant.id;
    if not coalesce(v_runtime.enabled,false)
       or not coalesce(v_setting.enabled,false)
       or coalesce(v_runtime.billing_mode,'shadow') <> 'shadow'
       or coalesce(v_setting.billing_mode,'shadow') <> 'shadow' then
      raise exception 'odeiry_unavailable';
    end if;

    v_client_request_id :=
      private_app.odeiry_validate_client_request_id(
        p_payload ->> 'clientRequestId'
      );
    v_user_message := btrim(coalesce(p_payload ->> 'userMessage',''));
    if char_length(v_user_message) not between 1 and
         v_runtime.max_input_chars
       or octet_length(v_user_message) > 96000 then
      raise exception 'odeiry_user_message_invalid';
    end if;
    v_request_context := coalesce(p_payload -> 'context','{}'::jsonb);
    if jsonb_typeof(v_request_context) <> 'object'
       or exists(
         select 1
         from jsonb_object_keys(v_request_context) context_key
         where context_key not in ('module','pathClass')
       )
       or (
         v_request_context ? 'module'
         and jsonb_typeof(v_request_context -> 'module') <> 'string'
       )
       or (
         v_request_context ? 'pathClass'
         and jsonb_typeof(v_request_context -> 'pathClass') <> 'string'
       ) then
      raise exception 'odeiry_context_invalid';
    end if;
    v_request_context := jsonb_strip_nulls(jsonb_build_object(
      'module',nullif(lower(btrim(coalesce(
        v_request_context ->> 'module',''
      ))),''),
      'pathClass',nullif(btrim(coalesce(
        v_request_context ->> 'pathClass',''
      )),'')
    ));
    if (
      (v_request_context ? 'module')
        is distinct from (v_request_context ? 'pathClass')
    ) or (
      v_request_context ? 'module'
      and v_request_context ->> 'module' not in (
        'login_access','dashboard','tasks_calendar','courses','sales_crm',
        'admissions','marketing_automation','accounting',
        'team_permissions','reports','website','integrations',
        'addons_marketplace','performance','support','other'
      )
    ) or (
      v_request_context ? 'pathClass'
      and not (
        (v_request_context ->> 'pathClass' = 'workspace.support'
          and v_request_context ->> 'module' = 'support')
        or (v_request_context ->> 'pathClass' = 'workspace.dashboard'
          and v_request_context ->> 'module' = 'dashboard')
        or (v_request_context ->> 'pathClass' = 'workspace.tasks_calendar'
          and v_request_context ->> 'module' = 'tasks_calendar')
        or (v_request_context ->> 'pathClass' = 'workspace.courses'
          and v_request_context ->> 'module' = 'courses')
        or (v_request_context ->> 'pathClass' = 'workspace.sales_crm'
          and v_request_context ->> 'module' = 'sales_crm')
        or (v_request_context ->> 'pathClass' = 'workspace.admissions'
          and v_request_context ->> 'module' = 'admissions')
        or (
          v_request_context ->> 'pathClass'
            = 'workspace.marketing_automation'
          and v_request_context ->> 'module' = 'marketing_automation'
        )
        or (v_request_context ->> 'pathClass' = 'workspace.accounting'
          and v_request_context ->> 'module' = 'accounting')
        or (
          v_request_context ->> 'pathClass' = 'workspace.team_permissions'
          and v_request_context ->> 'module' = 'team_permissions'
        )
        or (v_request_context ->> 'pathClass' = 'workspace.reports'
          and v_request_context ->> 'module' = 'reports')
        or (v_request_context ->> 'pathClass' = 'workspace.website'
          and v_request_context ->> 'module' = 'website')
        or (v_request_context ->> 'pathClass' = 'workspace.integrations'
          and v_request_context ->> 'module' = 'integrations')
        or (
          v_request_context ->> 'pathClass'
            = 'workspace.addons_marketplace'
          and v_request_context ->> 'module' = 'addons_marketplace'
        )
        or (v_request_context ->> 'pathClass' = 'workspace.performance'
          and v_request_context ->> 'module' = 'performance')
        or (v_request_context ->> 'pathClass' = 'workspace.other'
          and v_request_context ->> 'module' = 'other')
      )
    ) then
      raise exception 'odeiry_context_invalid';
    end if;
    v_model := nullif(btrim(coalesce(p_payload ->> 'model','')),'');
    if v_model is not null
       and v_model !~ '^gpt-[A-Za-z0-9][A-Za-z0-9._:-]{0,94}$' then
      raise exception 'odeiry_model_invalid';
    end if;
    begin
      v_minimum_estimated_units := greatest(
        1,ceil(char_length(v_user_message)::numeric / 4)::bigint
      );
      v_requested_estimated_units := coalesce(
        nullif(p_payload ->> 'estimatedUnits','')::bigint,
        v_minimum_estimated_units
      );
    exception when others then
      raise exception 'odeiry_estimated_units_invalid';
    end;
    if v_requested_estimated_units < 1 then
      raise exception 'odeiry_estimated_units_invalid';
    end if;
    -- The request value is a hint only. The database bounds shadow telemetry
    -- from message size and the configured maximum response, so a tenant
    -- member cannot manufacture an arbitrary future financial balance.
    v_estimated_units := greatest(
      v_minimum_estimated_units,
      least(
        v_requested_estimated_units,
        v_minimum_estimated_units
          + ceil(v_runtime.max_response_chars::numeric / 2)::bigint
      )
    );
    begin
      v_thread_id := nullif(btrim(coalesce(
        p_payload ->> 'threadId',''
      )),'')::uuid;
    exception when others then
      raise exception 'odeiry_thread_invalid';
    end;
    v_request_hash := private_app.odeiry_sha256(jsonb_build_object(
      'threadId',v_thread_id,
      'userMessage',v_user_message,
      'estimatedUnits',v_estimated_units,
      'model',v_model,
      'context',v_request_context
    ));

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:odeiry:start:'||v_tenant.id::text||':'
          ||v_subject_id::text||':'||v_client_request_id,
        0
      )
    );
    select run.* into v_run
    from core.odeiry_runs run
    where run.tenant_id = v_tenant.id
      and run.requested_by_subject_id = v_subject_id
      and run.client_request_id = v_client_request_id
    for update;
    if v_run.id is not null then
      if v_run.request_hash is distinct from v_request_hash then
        raise exception 'odeiry_idempotency_conflict';
      end if;
      if v_run.status in ('reserved','running')
         and v_run.reservation_expires_at <= v_now then
        if v_run.attempt_count >= 20 then
          raise exception 'odeiry_retry_limit_exceeded';
        end if;
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'odeir:odeiry:rate:'||v_tenant.id::text||':'
              ||v_subject_id::text,
            0
          )
        );
        if (
          select count(*)
          from core.odeiry_usage_events recent_event
          join core.odeiry_runs recent_run
            on recent_run.tenant_id = recent_event.tenant_id
           and recent_run.id = recent_event.run_id
          where recent_event.tenant_id = v_tenant.id
            and recent_event.event_type = 'reservation_created'
            and recent_event.occurred_at > v_now - interval '1 minute'
            and recent_run.requested_by_subject_id = v_subject_id
        ) >= v_setting.run_rate_limit_per_minute then
          raise exception 'odeiry_rate_limit_exceeded';
        end if;
        insert into core.odeiry_usage_events(
          tenant_id,run_id,event_type,idempotency_key,business_units,
          measured_business_units,billable,occurred_at,created_at
        ) values (
          v_tenant.id,v_run.id,'reservation_released',
          'run:'||v_run.id::text||':release:'||v_run.attempt_count::text,
          v_run.estimated_business_units,0,false,v_now,v_now
        ) on conflict (tenant_id,idempotency_key) do nothing;
        update core.odeiry_runs run
        set status = 'reserved',
            attempt_count = run.attempt_count + 1,
            knowledge_search_count = 0,
            reservation_expires_at = v_now + interval '15 minutes',
            started_at = v_now,
            updated_at = v_now
        where run.tenant_id = v_tenant.id
          and run.id = v_run.id
        returning * into v_run;
        insert into core.odeiry_usage_events(
          tenant_id,run_id,event_type,idempotency_key,business_units,
          measured_business_units,billable,occurred_at,created_at
        ) values (
          v_tenant.id,v_run.id,'reservation_created',
          'run:'||v_run.id::text||':reservation:'
            ||v_run.attempt_count::text,
          v_run.estimated_business_units,v_run.estimated_business_units,
          false,v_now,v_now
        ) on conflict (tenant_id,idempotency_key) do nothing;
        select message.id into v_user_message_id
        from core.odeiry_messages message
        where message.tenant_id = v_tenant.id
          and message.run_id = v_run.id
          and message.message_role = 'user'
        limit 1;
        v_context := private_app.odeiry_context_messages(
          v_tenant.id,v_run.thread_id,v_subject_id,v_user_message_id,12
        );
        return private_app.odeiry_run_document(
          v_tenant.id,v_run.id,v_subject_id
        ) || jsonb_build_object(
          'idempotent',false,
          'recovered',true,
          'userMessageId',v_user_message_id,
          'contextMessages',v_context
        );
      end if;
      return private_app.odeiry_run_document(
        v_tenant.id,v_run.id,v_subject_id
      ) || jsonb_build_object(
        'idempotent',true,
        'contextMessages','[]'::jsonb
      );
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:odeiry:rate:'||v_tenant.id::text||':'
          ||v_subject_id::text,
        0
      )
    );
    if (
      select count(*)
      from core.odeiry_usage_events recent_event
      join core.odeiry_runs recent_run
        on recent_run.tenant_id = recent_event.tenant_id
       and recent_run.id = recent_event.run_id
      where recent_event.tenant_id = v_tenant.id
        and recent_event.event_type = 'reservation_created'
        and recent_event.occurred_at > v_now - interval '1 minute'
        and recent_run.requested_by_subject_id = v_subject_id
    ) >= v_setting.run_rate_limit_per_minute then
      raise exception 'odeiry_rate_limit_exceeded';
    end if;

    if v_thread_id is null then
      insert into core.odeiry_threads(
        tenant_id,created_by_subject_id,title,status,last_message_at,
        created_at,updated_at
      ) values (
        v_tenant.id,v_subject_id,left(v_user_message,160),'active',v_now,
        v_now,v_now
      ) returning * into v_thread;
      v_thread_id := v_thread.id;
    else
      select thread.* into v_thread
      from core.odeiry_threads thread
      where thread.tenant_id = v_tenant.id
        and thread.id = v_thread_id
        and thread.created_by_subject_id = v_subject_id
        and thread.status = 'active'
      for update;
      if v_thread.id is null then
        raise exception 'odeiry_thread_not_found';
      end if;
    end if;

    v_run_id := extensions.gen_random_uuid();
    v_user_message_id := extensions.gen_random_uuid();
    insert into core.odeiry_runs(
      id,tenant_id,thread_id,requested_by_subject_id,client_request_id,
      request_hash,status,provider_key,requested_model,
      estimated_business_units,reservation_expires_at,started_at,
      request_context,created_at,updated_at
    ) values (
      v_run_id,v_tenant.id,v_thread_id,v_subject_id,v_client_request_id,
      v_request_hash,'reserved','openai',v_model,v_estimated_units,
      v_now + interval '15 minutes',v_now,v_request_context,v_now,v_now
    ) returning * into v_run;

    insert into core.odeiry_messages(
      id,tenant_id,thread_id,run_id,message_role,created_by_subject_id,
      content,content_hash,citations,created_at
    ) values (
      v_user_message_id,v_tenant.id,v_thread_id,v_run_id,'user',
      v_subject_id,v_user_message,
      private_app.odeiry_sha256(to_jsonb(v_user_message)),
      '[]'::jsonb,v_now
    );
    update core.odeiry_threads thread
    set last_message_at = v_now,
        version = thread.version + 1,
        updated_at = v_now
    where thread.tenant_id = v_tenant.id
      and thread.id = v_thread_id;
    insert into core.odeiry_usage_events(
      tenant_id,run_id,event_type,idempotency_key,business_units,
      measured_business_units,billable,occurred_at,created_at
    ) values (
      v_tenant.id,v_run_id,'reservation_created',
      'run:'||v_run_id::text||':reservation:1',v_estimated_units,
      v_estimated_units,false,v_now,v_now
    );

    v_context := private_app.odeiry_context_messages(
      v_tenant.id,v_thread_id,v_subject_id,v_user_message_id,12
    );
    return private_app.odeiry_run_document(
      v_tenant.id,v_run_id,v_subject_id
    ) || jsonb_build_object(
      'idempotent',false,
      'userMessageId',v_user_message_id,
      'contextMessages',v_context
    );
  end if;

  if v_action = 'archive_thread' then
    if exists(
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in ('threadId','expectedVersion')
    ) then
      raise exception 'odeiry_payload_invalid';
    end if;
    begin
      v_thread_id := (p_payload ->> 'threadId')::uuid;
      v_expected_version := (p_payload ->> 'expectedVersion')::integer;
    exception when others then
      raise exception 'odeiry_thread_invalid';
    end;
    select thread.* into v_thread
    from core.odeiry_threads thread
    where thread.tenant_id = v_tenant.id
      and thread.id = v_thread_id
      and thread.created_by_subject_id = v_subject_id
    for update;
    if v_thread.id is null then
      raise exception 'odeiry_thread_not_found';
    end if;
    if v_thread.status = 'archived' then
      return jsonb_build_object(
        'threadId',v_thread.id,'status','archived',
        'version',v_thread.version,'idempotent',true
      );
    end if;
    if v_expected_version is null
       or v_expected_version <> v_thread.version then
      raise exception 'odeiry_version_conflict';
    end if;
    update core.odeiry_threads thread
    set status = 'archived',
        version = thread.version + 1,
        updated_at = v_now
    where thread.tenant_id = v_tenant.id
      and thread.id = v_thread.id
    returning * into v_thread;
    perform private_app.write_audit(
      'odeiry.thread.archived','odeiry_thread',v_thread.id::text,
      v_tenant.id,jsonb_build_object('version',v_thread.version)
    );
    return jsonb_build_object(
      'threadId',v_thread.id,'status',v_thread.status,
      'version',v_thread.version,'idempotent',false
    );
  end if;

  if v_action = 'link_ticket' then
    if exists(
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in (
        'runId','ticketId','reasonCode','clientRequestId'
      )
    ) then
      raise exception 'odeiry_payload_invalid';
    end if;
    begin
      v_run_id := (p_payload ->> 'runId')::uuid;
      v_ticket_id := (p_payload ->> 'ticketId')::uuid;
    exception when others then
      raise exception 'odeiry_ticket_link_invalid';
    end;
    v_reason_code := lower(btrim(coalesce(
      p_payload ->> 'reasonCode','user_requested'
    )));
    if v_reason_code not in (
      'unresolved','low_confidence','user_requested','suspected_bug',
      'security_concern','other'
    ) then
      raise exception 'odeiry_ticket_link_invalid';
    end if;
    v_client_request_id :=
      private_app.odeiry_validate_client_request_id(
        p_payload ->> 'clientRequestId'
      );
    v_request_hash := private_app.odeiry_sha256(jsonb_build_object(
      'runId',v_run_id,'ticketId',v_ticket_id,
      'reasonCode',v_reason_code
    ));
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:odeiry:ticket-link:'||v_tenant.id::text||':'
          ||v_client_request_id,
        0
      )
    );
    select escalation.* into v_escalation
    from core.odeiry_ticket_escalations escalation
    where escalation.tenant_id = v_tenant.id
      and (
        escalation.run_id = v_run_id
        or escalation.support_request_id = v_ticket_id
        or (
          escalation.linked_by_subject_id = v_subject_id
          and escalation.client_request_id = v_client_request_id
        )
      )
    order by escalation.created_at,escalation.id
    limit 1;
    if v_escalation.id is not null then
      if v_escalation.run_id is distinct from v_run_id
         or v_escalation.support_request_id is distinct from v_ticket_id
         or v_escalation.linked_by_subject_id is distinct from v_subject_id
         or v_escalation.request_hash is distinct from v_request_hash then
        raise exception 'odeiry_ticket_link_conflict';
      end if;
      return jsonb_build_object(
        'escalationId',v_escalation.id,
        'ticketId',v_escalation.support_request_id,
        'idempotent',true
      );
    end if;
    select run.* into v_run
    from core.odeiry_runs run
    where run.tenant_id = v_tenant.id
      and run.id = v_run_id
      and run.requested_by_subject_id = v_subject_id;
    if v_run.id is null then
      raise exception 'odeiry_run_not_found';
    end if;
    if not private_app.support_tenant_can_read_ticket(
      v_tenant.id,v_ticket_id
    ) then
      raise exception 'support_ticket_not_found';
    end if;
    insert into core.odeiry_ticket_escalations(
      tenant_id,thread_id,run_id,support_request_id,
      linked_by_subject_id,reason_code,client_request_id,request_hash,
      created_at
    ) values (
      v_tenant.id,v_run.thread_id,v_run.id,v_ticket_id,v_subject_id,
      v_reason_code,v_client_request_id,v_request_hash,v_now
    ) returning * into v_escalation;
    perform private_app.write_audit(
      'odeiry.ticket.linked','support_request',v_ticket_id::text,
      v_tenant.id,jsonb_build_object(
        'odeiryRunId',v_run.id,
        'odeiryThreadId',v_run.thread_id,
        'reasonCode',v_reason_code
      )
    );
    return jsonb_build_object(
      'escalationId',v_escalation.id,
      'ticketId',v_escalation.support_request_id,
      'idempotent',false
    );
  end if;

  raise exception 'odeiry_action_invalid';
end;
$$;

create or replace function public.v3_tenant_odeiry_finalize(
  p_slug text,
  p_run_id uuid,
  p_status text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_run core.odeiry_runs%rowtype;
  v_subject_id uuid;
  v_status text := lower(btrim(coalesce(p_status,'')));
  v_response_text text;
  v_response_data jsonb := '{}'::jsonb;
  v_metadata jsonb := '{}'::jsonb;
  v_citation_keys jsonb := '[]'::jsonb;
  v_citations jsonb := '[]'::jsonb;
  v_actual_model text;
  v_provider_response_id text;
  v_finish_reason text;
  v_error_code text;
  v_finalization_hash text;
  v_assistant_message_id uuid;
  v_settled_units bigint := 0;
  v_measured_units bigint := 0;
  v_input_tokens bigint := 0;
  v_output_tokens bigint := 0;
  v_cached_input_tokens bigint := 0;
  v_reasoning_tokens bigint := 0;
  v_now timestamptz := clock_timestamp();
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'odeiry_payload_invalid';
  end if;
  if octet_length(p_payload::text) > 65536
     or char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,'')) > 240 then
    raise exception 'odeiry_payload_invalid';
  end if;
  if v_status not in ('completed','failed','cancelled') then
    raise exception 'odeiry_final_status_invalid';
  end if;
  if (
    v_status = 'completed'
    and exists(
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in (
        'responseText','responseData','actualUnits','measuredActualUnits',
        'inputTokens','outputTokens','cachedInputTokens','reasoningTokens',
        'model','providerResponseId','finishReason','citationKeys','metadata'
      )
    )
  ) or (
    v_status in ('failed','cancelled')
    and exists(
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in ('errorCode','metadata')
    )
  ) then
    raise exception 'odeiry_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  select run.* into v_run
  from core.odeiry_runs run
  where run.tenant_id = v_tenant.id
    and run.id = p_run_id
  for update;
  if v_run.id is null then
    raise exception 'odeiry_run_not_found';
  end if;
  v_subject_id := v_run.requested_by_subject_id;

  if v_status = 'completed' then
    select runtime.* into v_runtime
    from platform.odeiry_runtime_settings runtime
    where runtime.singleton;
    v_response_text := btrim(coalesce(p_payload ->> 'responseText',''));
    if char_length(v_response_text) not between 1 and
         coalesce(v_runtime.max_response_chars,24000)
       or octet_length(v_response_text) > 96000 then
      raise exception 'odeiry_response_invalid';
    end if;
    v_response_data := coalesce(p_payload -> 'responseData','{}'::jsonb);
    if jsonb_typeof(v_response_data) <> 'object'
       or octet_length(v_response_data::text) > 32768 then
      raise exception 'odeiry_response_data_invalid';
    end if;
    v_metadata := coalesce(p_payload -> 'metadata','{}'::jsonb);
    if jsonb_typeof(v_metadata) <> 'object'
       or octet_length(v_metadata::text) > 1024
       or exists(
         select 1
         from jsonb_object_keys(v_metadata) metadata_key
         where metadata_key not in (
           'sourceCount','knowledgeSearchEnabled'
         )
       )
       or (
         v_metadata ? 'sourceCount'
         and jsonb_typeof(v_metadata -> 'sourceCount') <> 'number'
       )
       or (
         v_metadata ? 'knowledgeSearchEnabled'
         and jsonb_typeof(v_metadata -> 'knowledgeSearchEnabled')
           <> 'boolean'
       ) then
      raise exception 'odeiry_metadata_invalid';
    end if;
    begin
      v_settled_units := coalesce(
        nullif(p_payload ->> 'actualUnits','')::bigint,
        v_run.estimated_business_units
      );
      v_measured_units := coalesce(
        nullif(p_payload ->> 'measuredActualUnits','')::bigint,
        v_settled_units
      );
      v_input_tokens := coalesce(
        nullif(p_payload ->> 'inputTokens','')::bigint,0
      );
      v_output_tokens := coalesce(
        nullif(p_payload ->> 'outputTokens','')::bigint,0
      );
      v_cached_input_tokens := coalesce(
        nullif(p_payload ->> 'cachedInputTokens','')::bigint,0
      );
      v_reasoning_tokens := coalesce(
        nullif(p_payload ->> 'reasoningTokens','')::bigint,0
      );
    exception when others then
      raise exception 'odeiry_usage_invalid';
    end;
    if v_settled_units not between 0 and v_run.estimated_business_units
       or v_measured_units not between v_settled_units and 1000000000
       or v_input_tokens not between 0 and 1000000000
       or v_output_tokens not between 0 and 1000000000
       or v_cached_input_tokens not between 0 and 1000000000
       or v_reasoning_tokens not between 0 and 1000000000 then
      raise exception 'odeiry_usage_invalid';
    end if;
    v_actual_model := nullif(btrim(coalesce(
      p_payload ->> 'model',v_run.requested_model
    )),'');
    if v_actual_model is not null
       and v_actual_model
         !~ '^gpt-[A-Za-z0-9][A-Za-z0-9._:-]{0,94}$' then
      raise exception 'odeiry_model_invalid';
    end if;
    v_provider_response_id := nullif(left(btrim(coalesce(
      p_payload ->> 'providerResponseId',''
    )),240),'');
    v_finish_reason := lower(nullif(btrim(coalesce(
      p_payload ->> 'finishReason','stop'
    )),''));
    if v_finish_reason is null
       or v_finish_reason !~ '^[a-z][a-z0-9_.-]{1,79}$' then
      raise exception 'odeiry_finish_reason_invalid';
    end if;
    v_citation_keys := coalesce(
      p_payload -> 'citationKeys','[]'::jsonb
    );
    if jsonb_typeof(v_citation_keys) <> 'array'
       or jsonb_array_length(v_citation_keys) > 20
       or exists(
         select 1
         from jsonb_array_elements(v_citation_keys) citation(value)
         where jsonb_typeof(citation.value) <> 'string'
       ) then
      raise exception 'odeiry_citations_invalid';
    end if;
    select coalesce(
      jsonb_agg(article.article_key order by requested.ordinality),
      '[]'::jsonb
    ) into v_citations
    from jsonb_array_elements_text(v_citation_keys)
      with ordinality requested(article_key,ordinality)
    join platform.odeiry_knowledge_articles article
      on article.article_key = requested.article_key
     and article.status = 'published';
    if jsonb_array_length(v_citations)
         <> jsonb_array_length(v_citation_keys) then
      raise exception 'odeiry_citations_invalid';
    end if;
    v_finalization_hash := private_app.odeiry_sha256(
      jsonb_build_object(
        'status',v_status,
        'responseText',v_response_text,
        'responseData',v_response_data,
        'actualUnits',v_settled_units,
        'measuredActualUnits',v_measured_units,
        'inputTokens',v_input_tokens,
        'outputTokens',v_output_tokens,
        'cachedInputTokens',v_cached_input_tokens,
        'reasoningTokens',v_reasoning_tokens,
        'model',v_actual_model,
        'providerResponseId',v_provider_response_id,
        'finishReason',v_finish_reason,
        'citationKeys',v_citations,
        'metadata',v_metadata
      )
    );
  else
    v_metadata := coalesce(p_payload -> 'metadata','{}'::jsonb);
    if jsonb_typeof(v_metadata) <> 'object'
       or octet_length(v_metadata::text) > 512
       or exists(
         select 1
         from jsonb_object_keys(v_metadata) metadata_key
         where metadata_key <> 'providerCalled'
       )
       or (
         v_metadata ? 'providerCalled'
         and jsonb_typeof(v_metadata -> 'providerCalled') <> 'boolean'
       ) then
      raise exception 'odeiry_metadata_invalid';
    end if;
    v_error_code := lower(btrim(coalesce(
      p_payload ->> 'errorCode',
      case when v_status = 'cancelled' then 'request_cancelled'
        else 'provider_error' end
    )));
    if v_error_code !~ '^[a-z][a-z0-9_.-]{1,99}$' then
      raise exception 'odeiry_error_code_invalid';
    end if;
    v_finalization_hash := private_app.odeiry_sha256(
      jsonb_build_object(
        'status',v_status,'errorCode',v_error_code,'metadata',v_metadata
      )
    );
  end if;

  if v_run.status in ('completed','failed','cancelled') then
    if v_run.status is distinct from v_status
       or v_run.finalization_hash is distinct from v_finalization_hash then
      raise exception 'odeiry_finalization_conflict';
    end if;
    return private_app.odeiry_run_document(
      v_tenant.id,v_run.id,v_subject_id
    ) || jsonb_build_object('idempotent',true);
  end if;
  if v_run.status not in ('reserved','running') then
    raise exception 'odeiry_run_state_invalid';
  end if;

  if v_status = 'completed' then
    perform 1
    from core.odeiry_threads thread
    where thread.tenant_id = v_tenant.id
      and thread.id = v_run.thread_id
      and thread.created_by_subject_id = v_subject_id
    for update;
    if not found then
      raise exception 'odeiry_thread_not_found';
    end if;
    v_assistant_message_id := extensions.gen_random_uuid();
    insert into core.odeiry_messages(
      id,tenant_id,thread_id,run_id,message_role,created_by_subject_id,
      content,content_hash,citations,created_at
    ) values (
      v_assistant_message_id,v_tenant.id,v_run.thread_id,v_run.id,
      'assistant',null,v_response_text,
      private_app.odeiry_sha256(to_jsonb(v_response_text)),
      v_citations,v_now
    );
    update core.odeiry_runs run
    set status = 'completed',
        finalization_hash = v_finalization_hash,
        actual_model = v_actual_model,
        provider_response_id = v_provider_response_id,
        settled_business_units = v_settled_units,
        measured_business_units = v_measured_units,
        input_tokens = v_input_tokens,
        output_tokens = v_output_tokens,
        cached_input_tokens = v_cached_input_tokens,
        reasoning_tokens = v_reasoning_tokens,
        finish_reason = v_finish_reason,
        response_data = v_response_data,
        error_code = null,
        completed_at = v_now,
        updated_at = v_now
    where run.tenant_id = v_tenant.id
      and run.id = v_run.id
    returning * into v_run;
    insert into core.odeiry_usage_events(
      tenant_id,run_id,event_type,idempotency_key,business_units,
      measured_business_units,input_tokens,output_tokens,
      cached_input_tokens,reasoning_tokens,billable,occurred_at,created_at
    ) values (
      v_tenant.id,v_run.id,'usage_settled',
      'run:'||v_run.id::text||':settlement',v_settled_units,
      v_measured_units,v_input_tokens,v_output_tokens,
      v_cached_input_tokens,v_reasoning_tokens,false,v_now,v_now
    );
    update core.odeiry_threads thread
    set last_message_at = v_now,
        version = thread.version + 1,
        updated_at = v_now
    where thread.tenant_id = v_tenant.id
      and thread.id = v_run.thread_id;
    return private_app.odeiry_run_document(
      v_tenant.id,v_run.id,v_subject_id
    ) || jsonb_build_object(
      'idempotent',false,
      'assistantMessageId',v_assistant_message_id
    );
  end if;

  update core.odeiry_runs run
  set status = v_status,
      finalization_hash = v_finalization_hash,
      settled_business_units = 0,
      measured_business_units = 0,
      error_code = v_error_code,
      completed_at = v_now,
      updated_at = v_now
  where run.tenant_id = v_tenant.id
    and run.id = v_run.id
  returning * into v_run;
  insert into core.odeiry_usage_events(
    tenant_id,run_id,event_type,idempotency_key,business_units,
    measured_business_units,billable,occurred_at,created_at
  ) values (
    v_tenant.id,v_run.id,'reservation_released',
    'run:'||v_run.id::text||':release:'||v_run.attempt_count::text,
    v_run.estimated_business_units,0,false,v_now,v_now
  ) on conflict (tenant_id,idempotency_key) do nothing;
  return private_app.odeiry_run_document(
    v_tenant.id,v_run.id,v_subject_id
  ) || jsonb_build_object('idempotent',false);
end;
$$;

create or replace function public.v3_tenant_odeiry_knowledge_search(
  p_slug text,
  p_run_id uuid,
  p_query text,
  p_limit integer default 6
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_setting core.odeiry_tenant_settings%rowtype;
  v_run core.odeiry_runs%rowtype;
  v_subject_id uuid := private_app.current_subject_id();
  v_query text := btrim(coalesce(p_query,''));
  v_limit integer;
  v_ts_query tsquery;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,'')) > 240 then
    raise exception 'odeiry_slug_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if v_subject_id is null
     or not private_app.odeiry_is_active_tenant_member(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  select runtime.* into v_runtime
  from platform.odeiry_runtime_settings runtime
  where runtime.singleton;
  select setting.* into v_setting
  from core.odeiry_tenant_settings setting
  where setting.tenant_id = v_tenant.id;
  if not coalesce(v_runtime.enabled,false)
     or not coalesce(v_setting.enabled,false)
     or coalesce(v_runtime.billing_mode,'shadow') <> 'shadow'
     or coalesce(v_setting.billing_mode,'shadow') <> 'shadow' then
    raise exception 'odeiry_unavailable';
  end if;
  select run.* into v_run
  from core.odeiry_runs run
  where run.tenant_id = v_tenant.id
    and run.id = p_run_id
    and run.requested_by_subject_id = v_subject_id
    and run.status in ('reserved','running')
    and run.reservation_expires_at > clock_timestamp()
  for update;
  if v_run.id is null then
    raise exception 'odeiry_run_not_active';
  end if;
  if v_run.knowledge_search_count >= 3 then
    raise exception 'odeiry_knowledge_search_limit_exceeded';
  end if;
  update core.odeiry_runs run
  set knowledge_search_count = run.knowledge_search_count + 1,
      updated_at = clock_timestamp()
  where run.tenant_id = v_tenant.id
    and run.id = v_run.id;
  if char_length(v_query) not between 2 and 500
     or octet_length(v_query) > 2000 then
    raise exception 'odeiry_knowledge_query_invalid';
  end if;
  v_limit := least(
    greatest(coalesce(p_limit,6),1),
    v_runtime.max_knowledge_results
  );
  v_ts_query := plainto_tsquery('simple'::regconfig,v_query);
  if v_ts_query::text = '' then
    return jsonb_build_object(
      'query',v_query,'articles','[]'::jsonb
    );
  end if;
  return jsonb_build_object(
    'query',v_query,
    'articles',coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'articleKey',matched.article_key,
          'moduleKey',matched.module_key,
          'title',matched.title_ar,
          'summary',matched.summary_ar,
          'content',left(matched.body_ar,8000),
          'tags',to_jsonb(matched.tags),
          'version',matched.version,
          'sourceKind',matched.source_kind,
          'sourceReference',matched.source_reference,
          'publicUrl',matched.public_url,
          'updatedAt',matched.updated_at,
          'rank',matched.rank
        )) order by matched.rank desc,matched.updated_at desc,
          matched.article_key
      )
      from (
        select article.*,
          ts_rank_cd(article.search_vector,v_ts_query) as rank
        from platform.odeiry_knowledge_articles article
        where article.status = 'published'
          and article.search_vector @@ v_ts_query
        order by rank desc,article.updated_at desc,article.article_key
        limit v_limit
      ) matched
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.v3_tenant_odeiry_snapshot(text)
from public,anon,authenticated,service_role;
revoke all on function public.v3_tenant_odeiry_action(text,text,jsonb)
from public,anon,authenticated,service_role;
revoke all on function public.v3_tenant_odeiry_finalize(
  text,uuid,text,jsonb
) from public,anon,authenticated,service_role;
revoke all on function public.v3_tenant_odeiry_knowledge_search(
  text,uuid,text,integer
) from public,anon,authenticated,service_role;
revoke all on function public.v3_platform_odeiry_configure(text,jsonb)
from public,anon,authenticated,service_role;

grant execute on function public.v3_tenant_odeiry_snapshot(text)
to authenticated;
grant execute on function public.v3_tenant_odeiry_action(text,text,jsonb)
to authenticated;
grant execute on function public.v3_tenant_odeiry_knowledge_search(
  text,uuid,text,integer
) to authenticated;
grant execute on function public.v3_platform_odeiry_configure(text,jsonb)
to authenticated;
grant execute on function public.v3_tenant_odeiry_finalize(
  text,uuid,text,jsonb
) to service_role;

comment on table platform.odeiry_runtime_settings is
'Global ODEIRY kill switch and safe runtime bounds. It stores no API key and starts disabled.';

comment on table core.odeiry_tenant_settings is
'Per-tenant ODEIRY gate. Rows are created only by an audited platform action; absent means disabled.';

comment on column core.odeiry_tenant_settings.shadow_soft_budget_units is
'Reporting-only shadow budget. It is never enforced, deducted, invoiced, or treated as a balance in v1.';

comment on table core.odeiry_threads is
'Tenant- and subject-owned ODEIRY conversations; no cross-user history is exposed.';

comment on table core.odeiry_runs is
'Idempotent ODEIRY provider-call lifecycle. Estimated, settled, measured units and provider tokens are separate.';

comment on table core.odeiry_messages is
'Tenant-scoped ODEIRY conversation messages. Context is loaded from owned rows, never accepted as client history.';

comment on table core.odeiry_usage_events is
'Append-only, non-billable shadow telemetry. This is not catalog add-on quota, entitlement, wallet, credit, charge, invoice, or financial authority.';

comment on table platform.odeiry_knowledge_articles is
'Platform-global curated ODEIR product knowledge only; tenant content and tenant identifiers are forbidden.';

comment on table core.odeiry_ticket_escalations is
'Immutable link from an owned ODEIRY run to the canonical support ticket; it never creates or mutates the ticket.';

comment on function public.v3_tenant_odeiry_snapshot(text) is
'Minimal membership-checked availability gate; deliberately excludes conversation history and aggregate scans.';

comment on function public.v3_tenant_odeiry_action(text,text,jsonb) is
'Creates an owned run atomically with idempotency, bounded context, concurrency-safe rate limiting and stale reservation recovery.';

comment on function public.v3_tenant_odeiry_finalize(
  text,uuid,text,jsonb
) is
'Service-role-only finalization of the exact tenant run. It writes non-billable shadow telemetry and cannot authorize a charge.';

comment on function public.v3_tenant_odeiry_knowledge_search(
  text,uuid,text,integer
) is
'Searches global curated knowledge only for an active owned run, with three bounded calls per attempt for tool retry tolerance.';

comment on function public.v3_platform_odeiry_configure(text,jsonb) is
'Audited platform.settings.manage control for the global and per-tenant disabled-by-default gates.';

commit;
