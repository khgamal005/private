begin;

create extension if not exists supabase_vault;

create schema if not exists communication_hub;

revoke all on schema communication_hub
from public, anon, authenticated;

create table communication_hub.provider_catalog (
  provider_key text primary key,
  channel text not null
    check (channel in ('whatsapp', 'email', 'api')),
  name_ar text not null,
  description_ar text not null,
  addon_key text not null,
  setup_fields jsonb not null default '[]'::jsonb,
  secret_fields jsonb not null default '[]'::jsonb,
  docs_url text,
  supports_test boolean not null default true,
  status text not null default 'active'
    check (status in ('active', 'beta', 'disabled')),
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, provider_key)
);

create table communication_hub.provider_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  channel text not null
    check (channel in ('whatsapp', 'email', 'api')),
  provider_key text not null
    references communication_hub.provider_catalog(provider_key)
    on delete restrict,
  display_name text not null,
  status text not null default 'draft'
    check (
      status in (
        'draft',
        'testing',
        'active',
        'degraded',
        'disabled',
        'error'
      )
    ),
  is_default boolean not null default false,
  public_config jsonb not null default '{}'::jsonb,
  secret_refs jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  last_error text,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel, provider_key)
);

create unique index provider_connections_one_default_channel_idx
on communication_hub.provider_connections (tenant_id, channel)
where is_default and status <> 'disabled';

create index provider_connections_tenant_status_idx
on communication_hub.provider_connections (
  tenant_id,
  channel,
  status,
  updated_at desc
);

create table communication_hub.message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  template_key text not null
    check (template_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  event_key text not null
    check (event_key ~ '^[a-z][a-z0-9_.]{2,100}$'),
  channel text not null default 'any'
    check (channel in ('any', 'whatsapp', 'email', 'api')),
  name_ar text not null,
  description_ar text,
  subject_template text,
  body_template text not null
    check (length(trim(body_template)) between 10 and 5000),
  default_subject_template text,
  default_body_template text not null,
  provider_template_name text,
  locale text not null default 'ar'
    check (locale ~ '^[a-z]{2,3}([_-][A-Za-z]{2,4})?$'),
  variables text[] not null default '{}'::text[],
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  is_system boolean not null default false,
  created_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, template_key, channel)
);

create index message_templates_tenant_event_idx
on communication_hub.message_templates (
  tenant_id,
  event_key,
  channel,
  status
);

create trigger provider_catalog_set_updated_at
before update on communication_hub.provider_catalog
for each row execute function private_app.set_updated_at();

create trigger provider_connections_set_updated_at
before update on communication_hub.provider_connections
for each row execute function private_app.set_updated_at();

create trigger message_templates_set_updated_at
before update on communication_hub.message_templates
for each row execute function private_app.set_updated_at();

alter table communication_hub.provider_catalog enable row level security;
alter table communication_hub.provider_connections enable row level security;
alter table communication_hub.message_templates enable row level security;

revoke all on all tables in schema communication_hub
from public, anon, authenticated;

revoke all on all sequences in schema communication_hub
from public, anon, authenticated;

alter default privileges in schema communication_hub
revoke all on tables from public, anon, authenticated;

alter default privileges in schema communication_hub
revoke all on sequences from public, anon, authenticated;

insert into catalog.features (
  feature_key,
  name_ar,
  name_en,
  category,
  value_type,
  default_value,
  status
)
values
  (
    'addon.integration.whatsapp',
    'ربط واتساب',
    'WhatsApp Integration',
    'addon',
    'boolean',
    'false'::jsonb,
    'beta'
  ),
  (
    'addon.integration.email',
    'ربط البريد الإلكتروني',
    'Email Integration',
    'addon',
    'boolean',
    'false'::jsonb,
    'beta'
  ),
  (
    'addon.integration.api',
    'ربط API وWebhook',
    'API and Webhook Integration',
    'addon',
    'boolean',
    'false'::jsonb,
    'beta'
  ),
  (
    'addon.communication.templates',
    'قوالب الرسائل والتخصيص',
    'Message Templates',
    'addon',
    'boolean',
    'false'::jsonb,
    'beta'
  )
on conflict (feature_key) do update
set name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    category = excluded.category,
    value_type = excluded.value_type,
    status = excluded.status,
    updated_at = now();

insert into catalog.plan_features (
  plan_id,
  feature_id,
  value
)
select
  plan.id,
  feature.id,
  'true'::jsonb
from catalog.plans plan
cross join catalog.features feature
where plan.plan_key = 'full'
  and feature.feature_key in (
    'addon.integration.whatsapp',
    'addon.integration.email',
    'addon.integration.api',
    'addon.communication.templates'
  )
on conflict (plan_id, feature_id) do update
set value = excluded.value,
    updated_at = now();

insert into communication_hub.provider_catalog (
  provider_key,
  channel,
  name_ar,
  description_ar,
  addon_key,
  setup_fields,
  secret_fields,
  docs_url,
  status,
  sort_order
)
values
  (
    'meta_whatsapp',
    'whatsapp',
    'WhatsApp Cloud API',
    'الربط الرسمي المباشر مع Meta والقوالب المعتمدة.',
    'addon.integration.whatsapp',
    jsonb_build_array(
      jsonb_build_object(
        'key', 'phoneNumberId',
        'label', 'معرّف رقم واتساب',
        'type', 'text',
        'required', true,
        'placeholder', 'مثال: 123456789012345'
      ),
      jsonb_build_object(
        'key', 'businessAccountId',
        'label', 'معرّف حساب واتساب للأعمال',
        'type', 'text',
        'required', false,
        'placeholder', 'WABA ID'
      ),
      jsonb_build_object(
        'key', 'apiVersion',
        'label', 'إصدار Graph API',
        'type', 'text',
        'required', true,
        'defaultValue', 'v25.0'
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'key', 'accessToken',
        'label', 'رمز الوصول الدائم',
        'type', 'password',
        'required', true
      )
    ),
    'https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started',
    'active',
    10
  ),
  (
    'webhook_whatsapp',
    'whatsapp',
    'مزود واتساب آخر',
    'يرسل الرسالة إلى API أو Webhook تابع لأي مزود واتساب خارجي.',
    'addon.integration.whatsapp',
    jsonb_build_array(
      jsonb_build_object(
        'key', 'endpoint',
        'label', 'رابط API الآمن',
        'type', 'url',
        'required', true,
        'placeholder', 'https://provider.example.com/messages'
      ),
      jsonb_build_object(
        'key', 'authHeader',
        'label', 'اسم ترويسة المصادقة',
        'type', 'text',
        'required', false,
        'defaultValue', 'Authorization'
      ),
      jsonb_build_object(
        'key', 'authScheme',
        'label', 'طريقة المصادقة',
        'type', 'select',
        'required', false,
        'options', jsonb_build_array('Bearer', 'Raw'),
        'defaultValue', 'Bearer'
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'key', 'authToken',
        'label', 'API Key أو Token',
        'type', 'password',
        'required', true
      ),
      jsonb_build_object(
        'key', 'signatureSecret',
        'label', 'سر توقيع Webhook',
        'type', 'password',
        'required', false
      )
    ),
    null,
    'beta',
    20
  ),
  (
    'resend',
    'email',
    'Resend',
    'إعداد سريع للبريد التشغيلي مع نطاق ومرسل موثّق.',
    'addon.integration.email',
    jsonb_build_array(
      jsonb_build_object(
        'key', 'fromEmail',
        'label', 'بريد الإرسال',
        'type', 'email',
        'required', true,
        'placeholder', 'training@example.com'
      ),
      jsonb_build_object(
        'key', 'fromName',
        'label', 'اسم المرسل',
        'type', 'text',
        'required', false
      ),
      jsonb_build_object(
        'key', 'replyTo',
        'label', 'بريد الرد',
        'type', 'email',
        'required', false
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'key', 'apiKey',
        'label', 'Resend API Key',
        'type', 'password',
        'required', true
      )
    ),
    'https://resend.com/docs/api-reference/emails/send-email',
    'active',
    30
  ),
  (
    'amazon_ses',
    'email',
    'Amazon SES',
    'إرسال احترافي واسع النطاق عبر Amazon Simple Email Service.',
    'addon.integration.email',
    jsonb_build_array(
      jsonb_build_object(
        'key', 'region',
        'label', 'منطقة AWS',
        'type', 'text',
        'required', true,
        'defaultValue', 'eu-west-1',
        'placeholder', 'eu-west-1'
      ),
      jsonb_build_object(
        'key', 'fromEmail',
        'label', 'البريد أو النطاق الموثّق',
        'type', 'email',
        'required', true
      ),
      jsonb_build_object(
        'key', 'fromName',
        'label', 'اسم المرسل',
        'type', 'text',
        'required', false
      ),
      jsonb_build_object(
        'key', 'replyTo',
        'label', 'بريد الرد',
        'type', 'email',
        'required', false
      ),
      jsonb_build_object(
        'key', 'configurationSet',
        'label', 'Configuration Set',
        'type', 'text',
        'required', false
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'key', 'accessKeyId',
        'label', 'AWS Access Key ID',
        'type', 'password',
        'required', true
      ),
      jsonb_build_object(
        'key', 'secretAccessKey',
        'label', 'AWS Secret Access Key',
        'type', 'password',
        'required', true
      ),
      jsonb_build_object(
        'key', 'sessionToken',
        'label', 'AWS Session Token',
        'type', 'password',
        'required', false
      )
    ),
    'https://docs.aws.amazon.com/ses/latest/dg/send-email-api.html',
    'active',
    40
  ),
  (
    'webhook_email',
    'email',
    'مزود بريد آخر',
    'يرسل البريد إلى API متوافق مع أي مزود خارجي تختاره المنشأة.',
    'addon.integration.email',
    jsonb_build_array(
      jsonb_build_object(
        'key', 'endpoint',
        'label', 'رابط API الآمن',
        'type', 'url',
        'required', true,
        'placeholder', 'https://provider.example.com/email'
      ),
      jsonb_build_object(
        'key', 'authHeader',
        'label', 'اسم ترويسة المصادقة',
        'type', 'text',
        'required', false,
        'defaultValue', 'Authorization'
      ),
      jsonb_build_object(
        'key', 'authScheme',
        'label', 'طريقة المصادقة',
        'type', 'select',
        'required', false,
        'options', jsonb_build_array('Bearer', 'Raw'),
        'defaultValue', 'Bearer'
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'key', 'authToken',
        'label', 'API Key أو Token',
        'type', 'password',
        'required', true
      ),
      jsonb_build_object(
        'key', 'signatureSecret',
        'label', 'سر توقيع Webhook',
        'type', 'password',
        'required', false
      )
    ),
    null,
    'beta',
    50
  ),
  (
    'custom_webhook',
    'api',
    'API / Webhook مخصص',
    'يرسل أحداث ماركتون بصيغة JSON إلى نظام خارجي بأمان.',
    'addon.integration.api',
    jsonb_build_array(
      jsonb_build_object(
        'key', 'endpoint',
        'label', 'رابط Webhook الآمن',
        'type', 'url',
        'required', true,
        'placeholder', 'https://system.example.com/webhooks/marktone'
      ),
      jsonb_build_object(
        'key', 'eventName',
        'label', 'اسم الحدث',
        'type', 'text',
        'required', false,
        'defaultValue', 'marktone.message'
      ),
      jsonb_build_object(
        'key', 'authHeader',
        'label', 'اسم ترويسة المصادقة',
        'type', 'text',
        'required', false,
        'defaultValue', 'Authorization'
      ),
      jsonb_build_object(
        'key', 'authScheme',
        'label', 'طريقة المصادقة',
        'type', 'select',
        'required', false,
        'options', jsonb_build_array('Bearer', 'Raw'),
        'defaultValue', 'Bearer'
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'key', 'authToken',
        'label', 'API Key أو Token',
        'type', 'password',
        'required', false
      ),
      jsonb_build_object(
        'key', 'signatureSecret',
        'label', 'سر توقيع HMAC',
        'type', 'password',
        'required', false
      )
    ),
    null,
    'beta',
    60
  )
on conflict (provider_key) do update
set channel = excluded.channel,
    name_ar = excluded.name_ar,
    description_ar = excluded.description_ar,
    addon_key = excluded.addon_key,
    setup_fields = excluded.setup_fields,
    secret_fields = excluded.secret_fields,
    docs_url = excluded.docs_url,
    supports_test = excluded.supports_test,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function private_app.tenant_addon_enabled(
  p_tenant_id uuid,
  p_feature_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select (override.value #>> '{}')::boolean
      from catalog.tenant_feature_overrides override
      join catalog.features feature
        on feature.id = override.feature_id
      where override.tenant_id = p_tenant_id
        and feature.feature_key = p_feature_key
      limit 1
    ),
    (
      select (plan_feature.value #>> '{}')::boolean
      from catalog.subscriptions subscription
      join catalog.plan_features plan_feature
        on plan_feature.plan_id = subscription.plan_id
      join catalog.features feature
        on feature.id = plan_feature.feature_id
      where subscription.tenant_id = p_tenant_id
        and subscription.status in ('trialing', 'active')
        and feature.feature_key = p_feature_key
      order by subscription.created_at desc
      limit 1
    ),
    (
      select (feature.default_value #>> '{}')::boolean
      from catalog.features feature
      where feature.feature_key = p_feature_key
      limit 1
    ),
    false
  );
$$;

revoke all on function private_app.tenant_addon_enabled(uuid, text)
from public, anon, authenticated;

create or replace function private_app.integration_public_config(
  p_provider_key text,
  p_config jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_provider_key
    when 'meta_whatsapp' then jsonb_strip_nulls(jsonb_build_object(
      'phoneNumberId', nullif(trim(p_config ->> 'phoneNumberId'), ''),
      'businessAccountId',
        nullif(trim(p_config ->> 'businessAccountId'), ''),
      'apiVersion',
        coalesce(
          nullif(trim(p_config ->> 'apiVersion'), ''),
          'v25.0'
        )
    ))
    when 'resend' then jsonb_strip_nulls(jsonb_build_object(
      'fromEmail', lower(nullif(trim(p_config ->> 'fromEmail'), '')),
      'fromName', nullif(trim(p_config ->> 'fromName'), ''),
      'replyTo', lower(nullif(trim(p_config ->> 'replyTo'), ''))
    ))
    when 'amazon_ses' then jsonb_strip_nulls(jsonb_build_object(
      'region',
        coalesce(
          lower(nullif(trim(p_config ->> 'region'), '')),
          'eu-west-1'
        ),
      'fromEmail', lower(nullif(trim(p_config ->> 'fromEmail'), '')),
      'fromName', nullif(trim(p_config ->> 'fromName'), ''),
      'replyTo', lower(nullif(trim(p_config ->> 'replyTo'), '')),
      'configurationSet',
        nullif(trim(p_config ->> 'configurationSet'), '')
    ))
    when 'webhook_whatsapp' then jsonb_strip_nulls(jsonb_build_object(
      'endpoint', nullif(trim(p_config ->> 'endpoint'), ''),
      'authHeader',
        coalesce(
          nullif(trim(p_config ->> 'authHeader'), ''),
          'Authorization'
        ),
      'authScheme',
        case
          when p_config ->> 'authScheme' = 'Raw' then 'Raw'
          else 'Bearer'
        end
    ))
    when 'webhook_email' then jsonb_strip_nulls(jsonb_build_object(
      'endpoint', nullif(trim(p_config ->> 'endpoint'), ''),
      'authHeader',
        coalesce(
          nullif(trim(p_config ->> 'authHeader'), ''),
          'Authorization'
        ),
      'authScheme',
        case
          when p_config ->> 'authScheme' = 'Raw' then 'Raw'
          else 'Bearer'
        end
    ))
    when 'custom_webhook' then jsonb_strip_nulls(jsonb_build_object(
      'endpoint', nullif(trim(p_config ->> 'endpoint'), ''),
      'eventName',
        coalesce(
          nullif(trim(p_config ->> 'eventName'), ''),
          'marktone.message'
        ),
      'authHeader',
        coalesce(
          nullif(trim(p_config ->> 'authHeader'), ''),
          'Authorization'
        ),
      'authScheme',
        case
          when p_config ->> 'authScheme' = 'Raw' then 'Raw'
          else 'Bearer'
        end
    ))
    else '{}'::jsonb
  end;
$$;

revoke all on function private_app.integration_public_config(text, jsonb)
from public, anon, authenticated;

create or replace function private_app.integration_secret_upsert(
  p_tenant_id uuid,
  p_connection_id uuid,
  p_secret_key text,
  p_secret_value text,
  p_existing_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text;
begin
  if nullif(p_secret_value, '') is null then
    return p_existing_id;
  end if;

  v_secret_name :=
    'integration:' || p_tenant_id::text
    || ':' || p_connection_id::text
    || ':' || p_secret_key;

  if p_existing_id is not null
     and exists (
       select 1
       from vault.secrets secret
       where secret.id = p_existing_id
     ) then
    perform vault.update_secret(
      p_existing_id,
      p_secret_value,
      v_secret_name,
      'Encrypted tenant integration credential.'
    );
    return p_existing_id;
  end if;

  select vault.create_secret(
    p_secret_value,
    v_secret_name,
    'Encrypted tenant integration credential.'
  )
  into v_secret_id;

  return v_secret_id;
end;
$$;

revoke all on function private_app.integration_secret_upsert(
  uuid,
  uuid,
  text,
  text,
  uuid
)
from public, anon, authenticated;

create or replace function private_app.message_template_variables(
  p_subject text,
  p_body text
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct token order by token), '{}'::text[])
  from (
    select match[1] as token
    from regexp_matches(
      coalesce(p_subject, '') || E'\n' || coalesce(p_body, ''),
      '\{\{([a-z][a-z0-9_]*)\}\}',
      'g'
    ) match
  ) variables;
$$;

revoke all on function private_app.message_template_variables(text, text)
from public, anon, authenticated;

create or replace function private_app.validate_message_template(
  p_subject text,
  p_body text
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_token text;
  v_allowed constant text[] := array[
    'name',
    'course',
    'batch',
    'session',
    'date',
    'time',
    'trainer',
    'location',
    'link',
    'certificate_link',
    'amount',
    'center',
    'delivery_mode'
  ];
begin
  if length(trim(coalesce(p_body, ''))) < 10 then
    raise exception 'template_body_required';
  end if;
  if length(p_body) > 5000 then
    raise exception 'template_body_too_long';
  end if;
  if length(coalesce(p_subject, '')) > 500 then
    raise exception 'template_subject_too_long';
  end if;

  foreach v_token in array private_app.message_template_variables(
    p_subject,
    p_body
  )
  loop
    if not (v_token = any(v_allowed)) then
      raise exception 'invalid_template_variable';
    end if;
  end loop;
end;
$$;

revoke all on function private_app.validate_message_template(text, text)
from public, anon, authenticated;

create or replace function private_app.render_message_template_text(
  p_template text,
  p_values jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result text := coalesce(p_template, '');
  v_key text;
  v_value text;
begin
  for v_key, v_value in
    select value.key, value.value
    from jsonb_each_text(coalesce(p_values, '{}'::jsonb)) value
  loop
    v_result := replace(
      v_result,
      '{{' || v_key || '}}',
      coalesce(v_value, '—')
    );
  end loop;

  v_result := regexp_replace(
    v_result,
    '\{\{[a-z][a-z0-9_]*\}\}',
    '—',
    'g'
  );
  return v_result;
end;
$$;

revoke all on function private_app.render_message_template_text(
  text,
  jsonb
)
from public, anon, authenticated;

create or replace function private_app.message_template_field(
  p_tenant_id uuid,
  p_template_key text,
  p_channel text,
  p_field text,
  p_values jsonb,
  p_fallback text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_template communication_hub.message_templates%rowtype;
  v_source text;
begin
  select *
  into v_template
  from communication_hub.message_templates template
  where template.tenant_id = p_tenant_id
    and template.template_key = p_template_key
    and template.status = 'active'
    and template.channel in (p_channel, 'any')
  order by
    case when template.channel = p_channel then 0 else 1 end,
    template.updated_at desc
  limit 1;

  if v_template.id is null then
    return p_fallback;
  end if;

  v_source := case p_field
    when 'subject' then v_template.subject_template
    else v_template.body_template
  end;
  if nullif(v_source, '') is null then return p_fallback; end if;
  return private_app.render_message_template_text(v_source, p_values);
end;
$$;

revoke all on function private_app.message_template_field(
  uuid,
  text,
  text,
  text,
  jsonb,
  text
)
from public, anon, authenticated;

insert into communication_hub.message_templates (
  tenant_id,
  template_key,
  event_key,
  channel,
  name_ar,
  description_ar,
  subject_template,
  body_template,
  default_subject_template,
  default_body_template,
  variables,
  status,
  is_system
)
select
  tenant.id,
  template.template_key,
  template.event_key,
  'any',
  template.name_ar,
  template.description_ar,
  template.subject_template,
  template.body_template,
  template.subject_template,
  template.body_template,
  private_app.message_template_variables(
    template.subject_template,
    template.body_template
  ),
  'active',
  true
from core.tenants tenant
cross join (
  values
    (
      'joining_instructions',
      'training.joining',
      'رسالة الانضمام',
      'تُرسل بعد إتمام تسجيل المتدرب في الدفعة.',
      'مرحبًا بك في {{course}}',
      E'مرحبًا {{name}}،\nتم تسجيلك في {{course}} ضمن {{batch}}.\nبداية البرنامج: {{date}}\nطريقة التقديم: {{delivery_mode}}\nمكان أو رابط الحضور: {{link}}\nنتمنى لك تجربة تدريبية موفقة مع {{center}}.'
    ),
    (
      'session_reminder_24h',
      'training.session.reminder_24h',
      'تذكير قبل 24 ساعة',
      'تذكير مبكر بموعد الجلسة القادمة.',
      'تذكير بموعد {{session}} غدًا',
      E'مرحبًا {{name}}،\nنذكّرك بموعد {{session}} ضمن {{course}}.\nالموعد: {{date}}\nالمدرب: {{trainer}}\nمكان أو رابط الحضور: {{link}}\nننتظرك في الموعد.'
    ),
    (
      'session_reminder_1h',
      'training.session.reminder_1h',
      'تذكير قبل ساعة',
      'تذكير فوري قبل بداية الجلسة.',
      'تبدأ {{session}} خلال ساعة',
      E'مرحبًا {{name}}،\nتبدأ جلسة {{session}} في {{course}} خلال ساعة.\nالموعد: {{date}}\nرابط أو مكان الحضور: {{link}}\nنتمنى لك جلسة موفقة.'
    ),
    (
      'registration_confirmed',
      'admissions.registration.confirmed',
      'تأكيد التسجيل',
      'إشعار اعتماد التسجيل والدفعة.',
      'تم تأكيد تسجيلك في {{course}}',
      E'مرحبًا {{name}}،\nتم تأكيد تسجيلك في {{course}} ضمن {{batch}}.\nموعد البداية: {{date}}\nسنتواصل معك بأي تحديثات تخص البرنامج.'
    ),
    (
      'payment_confirmed',
      'admissions.payment.confirmed',
      'تأكيد الدفع',
      'إشعار التحقق من عملية الدفع.',
      'تم تأكيد دفعتك',
      E'مرحبًا {{name}}،\nتم التحقق من دفعتك بقيمة {{amount}} لبرنامج {{course}}.\nسيتم استكمال تسجيلك وإرسال تفاصيل الانضمام قريبًا.'
    ),
    (
      'schedule_changed',
      'training.session.changed',
      'تغيير موعد',
      'إشعار المتدرب بتعديل موعد أو رابط جلسة.',
      'تحديث موعد {{session}}',
      E'مرحبًا {{name}}،\nتم تحديث موعد {{session}} ضمن {{course}}.\nالموعد الجديد: {{date}}\nمكان أو رابط الحضور: {{link}}\nنعتذر عن أي إزعاج.'
    ),
    (
      'certificate_ready',
      'training.certificate.ready',
      'الشهادة جاهزة',
      'إشعار أهلية وإصدار الشهادة.',
      'شهادتك في {{course}} جاهزة',
      E'تهانينا {{name}}،\nتم إصدار شهادتك في {{course}}.\nيمكنك عرضها وتحميلها من الرابط التالي:\n{{certificate_link}}\nنتمنى لك مزيدًا من النجاح.'
    )
) template(
  template_key,
  event_key,
  name_ar,
  description_ar,
  subject_template,
  body_template
)
where tenant.status in ('trial', 'active')
on conflict (tenant_id, template_key, channel) do nothing;

create or replace function private_app.build_joining_message(
  p_enrollment_id uuid
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_values jsonb;
  v_fallback text;
begin
  select
    enrollment.tenant_id,
    jsonb_build_object(
      'name', student.full_name,
      'course', course.title_ar,
      'batch', coalesce(run.title, course.title_ar),
      'date',
        coalesce(
          to_char(
            run.starts_at at time zone tenant.timezone,
            'YYYY-MM-DD HH24:MI'
          ),
          'سيحدد لاحقًا'
        ),
      'time',
        coalesce(
          to_char(
            run.starts_at at time zone tenant.timezone,
            'HH24:MI'
          ),
          'سيحدد لاحقًا'
        ),
      'delivery_mode',
        case run.delivery_mode
          when 'online' then 'عن بُعد'
          when 'onsite' then 'حضوري'
          else 'هجين'
        end,
      'location', coalesce(run.venue_or_link, 'سيحدد لاحقًا'),
      'link', coalesce(run.venue_or_link, 'سيحدد لاحقًا'),
      'trainer', coalesce(run.instructor_name, 'سيحدد لاحقًا'),
      'center', tenant.name
    ),
    format(
      E'مرحبًا %s،\nتم تسجيلك في %s ضمن %s.\nبداية البرنامج: %s\nمكان/رابط الحضور: %s',
      student.full_name,
      course.title_ar,
      coalesce(run.title, course.title_ar),
      coalesce(
        to_char(
          run.starts_at at time zone tenant.timezone,
          'YYYY-MM-DD HH24:MI'
        ),
        'سيحدد لاحقًا'
      ),
      coalesce(run.venue_or_link, 'سيحدد لاحقًا')
    )
  into v_tenant_id, v_values, v_fallback
  from academy.enrollments enrollment
  join academy.students student
    on student.id = enrollment.student_id
  join academy.course_runs run
    on run.id = enrollment.course_run_id
  join academy.courses course
    on course.id = enrollment.course_id
  join core.tenants tenant
    on tenant.id = enrollment.tenant_id
  where enrollment.id = p_enrollment_id;

  if v_tenant_id is null then raise exception 'enrollment_not_found'; end if;

  return private_app.message_template_field(
    v_tenant_id,
    'joining_instructions',
    'any',
    'body',
    v_values,
    v_fallback
  );
end;
$$;

revoke all on function private_app.build_joining_message(uuid)
from public, anon, authenticated;

create or replace function private_app.training_job_apply_template()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_template_key text;
  v_values jsonb;
  v_center_name text;
begin
  v_template_key := case new.job_type
    when 'joining_instructions' then 'joining_instructions'
    when 'session_reminder_24h' then 'session_reminder_24h'
    when 'session_reminder_1h' then 'session_reminder_1h'
    else null
  end;
  if v_template_key is null then return new; end if;

  select tenant.name
  into v_center_name
  from core.tenants tenant
  where tenant.id = new.tenant_id;

  v_values := jsonb_strip_nulls(jsonb_build_object(
    'name', new.metadata ->> 'studentName',
    'course', new.metadata ->> 'courseName',
    'batch', new.metadata ->> 'runName',
    'session', new.metadata ->> 'sessionTitle',
    'date', new.metadata ->> 'startDate',
    'time', new.metadata ->> 'startDate',
    'trainer', new.metadata ->> 'trainerName',
    'location', new.metadata ->> 'venueOrLink',
    'link', new.metadata ->> 'venueOrLink',
    'center', v_center_name
  ));

  new.subject := private_app.message_template_field(
    new.tenant_id,
    v_template_key,
    new.channel,
    'subject',
    v_values,
    new.subject
  );
  new.message_text := private_app.message_template_field(
    new.tenant_id,
    v_template_key,
    new.channel,
    'body',
    v_values,
    new.message_text
  );
  new.metadata := new.metadata || jsonb_build_object(
    'templateKey',
    v_template_key
  );
  return new;
end;
$$;

revoke all on function private_app.training_job_apply_template()
from public, anon, authenticated;

create trigger training_automation_jobs_apply_template
before insert or update of subject, message_text, metadata, channel
on academy.training_automation_jobs
for each row execute function private_app.training_job_apply_template();

create or replace function public.v2_tenant_integration_hub_snapshot(
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
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'viewer', jsonb_build_object(
      'canManage',
      private_app.has_tenant_permission(
        v_tenant.id,
        'tenant.settings.manage'
      )
    ),
    'summary', jsonb_build_object(
      'activeConnections',
        (
          select count(*)
          from communication_hub.provider_connections connection
          where connection.tenant_id = v_tenant.id
            and connection.status = 'active'
        ),
      'configuredConnections',
        (
          select count(*)
          from communication_hub.provider_connections connection
          where connection.tenant_id = v_tenant.id
            and connection.secret_refs <> '{}'::jsonb
        ),
      'activeTemplates',
        (
          select count(*)
          from communication_hub.message_templates template
          where template.tenant_id = v_tenant.id
            and template.status = 'active'
        )
    ),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', catalog.provider_key,
        'channel', catalog.channel,
        'name', catalog.name_ar,
        'description', catalog.description_ar,
        'addonKey', catalog.addon_key,
        'addonEnabled',
          private_app.tenant_addon_enabled(
            v_tenant.id,
            catalog.addon_key
          ),
        'setupFields', catalog.setup_fields,
        'secretFields', catalog.secret_fields,
        'docsUrl', catalog.docs_url,
        'supportsTest', catalog.supports_test,
        'status', catalog.status,
        'connection', (
          select jsonb_build_object(
            'id', connection.id,
            'displayName', connection.display_name,
            'status', connection.status,
            'isDefault', connection.is_default,
            'publicConfig', connection.public_config,
            'configuredSecrets',
              coalesce((
                select jsonb_agg(secret.key order by secret.key)
                from jsonb_each_text(connection.secret_refs) secret
              ), '[]'::jsonb),
            'lastCheckedAt', connection.last_checked_at,
            'lastError', connection.last_error,
            'updatedAt', connection.updated_at
          )
          from communication_hub.provider_connections connection
          where connection.tenant_id = v_tenant.id
            and connection.provider_key = catalog.provider_key
          limit 1
        )
      ) order by catalog.sort_order)
      from communication_hub.provider_catalog catalog
      where catalog.status in ('active', 'beta')
    ), '[]'::jsonb),
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', template.id,
        'key', template.template_key,
        'eventKey', template.event_key,
        'channel', template.channel,
        'name', template.name_ar,
        'description', template.description_ar,
        'subject', template.subject_template,
        'body', template.body_template,
        'providerTemplateName', template.provider_template_name,
        'locale', template.locale,
        'variables', template.variables,
        'status', template.status,
        'isSystem', template.is_system,
        'isCustomized',
          (
            template.subject_template is distinct from
              template.default_subject_template
            or template.body_template is distinct from
              template.default_body_template
            or template.provider_template_name is not null
          ),
        'updatedAt', template.updated_at
      ) order by template.created_at, template.name_ar)
      from communication_hub.message_templates template
      where template.tenant_id = v_tenant.id
        and template.status <> 'archived'
    ), '[]'::jsonb),
    'variables', jsonb_build_array(
      jsonb_build_object(
        'key', 'name',
        'label', 'اسم المستفيد',
        'sample', 'سارة أحمد'
      ),
      jsonb_build_object(
        'key', 'course',
        'label', 'اسم الدورة',
        'sample', 'إدارة المشاريع PMP'
      ),
      jsonb_build_object(
        'key', 'batch',
        'label', 'اسم الدفعة',
        'sample', 'دفعة أغسطس المسائية'
      ),
      jsonb_build_object(
        'key', 'session',
        'label', 'اسم الجلسة',
        'sample', 'الجلسة الافتتاحية'
      ),
      jsonb_build_object(
        'key', 'date',
        'label', 'التاريخ والموعد',
        'sample', '10 أغسطس 2026، 7:00 م'
      ),
      jsonb_build_object(
        'key', 'time',
        'label', 'الوقت',
        'sample', '7:00 م'
      ),
      jsonb_build_object(
        'key', 'trainer',
        'label', 'اسم المدرب',
        'sample', 'د. أحمد علي'
      ),
      jsonb_build_object(
        'key', 'location',
        'label', 'المكان',
        'sample', 'القاعة الرئيسية'
      ),
      jsonb_build_object(
        'key', 'link',
        'label', 'رابط الانضمام',
        'sample', 'https://zoom.us/j/example'
      ),
      jsonb_build_object(
        'key', 'certificate_link',
        'label', 'رابط الشهادة',
        'sample', 'https://example.com/certificate'
      ),
      jsonb_build_object(
        'key', 'amount',
        'label', 'المبلغ',
        'sample', '699 ر.س'
      ),
      jsonb_build_object(
        'key', 'center',
        'label', 'اسم المنشأة',
        'sample', v_tenant.name
      ),
      jsonb_build_object(
        'key', 'delivery_mode',
        'label', 'طريقة التقديم',
        'sample', 'عن بُعد'
      )
    )
  );
end;
$$;

create or replace function public.v2_tenant_integration_hub_action(
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
  v_catalog communication_hub.provider_catalog%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_template communication_hub.message_templates%rowtype;
  v_connection_id uuid;
  v_template_id uuid;
  v_provider_key text;
  v_channel text;
  v_display_name text;
  v_public_config jsonb;
  v_secret_refs jsonb;
  v_secret_key text;
  v_secret_value text;
  v_existing_secret_id uuid;
  v_saved_secret_id uuid;
  v_template_key text;
  v_subject text;
  v_body text;
  v_variables text[];
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  v_actor_subject_id := private_app.current_subject_id();
  if v_actor_subject_id is null then raise exception 'forbidden'; end if;

  if p_action = 'save_connection' then
    v_provider_key := nullif(trim(p_payload ->> 'providerKey'), '');
    v_channel := nullif(trim(p_payload ->> 'channel'), '');

    select *
    into v_catalog
    from communication_hub.provider_catalog catalog
    where catalog.provider_key = v_provider_key
      and catalog.channel = v_channel
      and catalog.status in ('active', 'beta');

    if v_catalog.provider_key is null then
      raise exception 'invalid_integration_provider';
    end if;
    if not private_app.tenant_addon_enabled(
      v_tenant.id,
      v_catalog.addon_key
    ) then raise exception 'integration_addon_not_enabled'; end if;

    v_display_name := coalesce(
      nullif(trim(p_payload ->> 'displayName'), ''),
      v_catalog.name_ar
    );
    v_public_config := private_app.integration_public_config(
      v_provider_key,
      coalesce(p_payload -> 'publicConfig', '{}'::jsonb)
    );

    if v_public_config ? 'endpoint'
       and v_public_config ->> 'endpoint' !~ '^https://[^[:space:]]+$' then
      raise exception 'integration_https_required';
    end if;
    if v_public_config ? 'fromEmail'
       and v_public_config ->> 'fromEmail'
         !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'invalid_sender_email';
    end if;
    if v_provider_key = 'amazon_ses'
       and coalesce(v_public_config ->> 'region', '')
         !~ '^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$' then
      raise exception 'invalid_aws_region';
    end if;
    if v_provider_key = 'meta_whatsapp'
       and v_public_config ? 'apiVersion'
       and v_public_config ->> 'apiVersion' !~ '^v[0-9]{1,2}\.[0-9]$' then
      raise exception 'invalid_meta_api_version';
    end if;

    begin
      v_connection_id := nullif(p_payload ->> 'connectionId', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_integration_connection';
    end;

    if v_connection_id is not null then
      select *
      into v_connection
      from communication_hub.provider_connections connection
      where connection.id = v_connection_id
        and connection.tenant_id = v_tenant.id
      for update;
      if v_connection.id is null then
        raise exception 'integration_connection_not_found';
      end if;
      if v_connection.provider_key <> v_provider_key
         or v_connection.channel <> v_channel then
        raise exception 'integration_provider_locked';
      end if;
    else
      select *
      into v_connection
      from communication_hub.provider_connections connection
      where connection.tenant_id = v_tenant.id
        and connection.provider_key = v_provider_key
        and connection.channel = v_channel
      for update;
      v_connection_id := v_connection.id;
    end if;

    if v_connection_id is null then
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
        v_channel,
        v_provider_key,
        v_display_name,
        'draft',
        not exists (
          select 1
          from communication_hub.provider_connections connection
          where connection.tenant_id = v_tenant.id
            and connection.channel = v_channel
            and connection.status <> 'disabled'
        ),
        v_public_config,
        v_actor_subject_id,
        v_actor_subject_id
      )
      returning * into v_connection;
      v_connection_id := v_connection.id;
    else
      update communication_hub.provider_connections
      set display_name = v_display_name,
          public_config = v_public_config,
          status = case
            when status = 'disabled' then 'draft'
            when status = 'active' then 'draft'
            else status
          end,
          last_error = null,
          updated_by_subject_id = v_actor_subject_id
      where id = v_connection_id
      returning * into v_connection;
    end if;

    v_secret_refs := coalesce(v_connection.secret_refs, '{}'::jsonb);
    for v_secret_key, v_secret_value in
      select secret.key, secret.value
      from jsonb_each_text(
        coalesce(p_payload -> 'secrets', '{}'::jsonb)
      ) secret
    loop
      if not exists (
        select 1
        from jsonb_array_elements(v_catalog.secret_fields) field
        where field ->> 'key' = v_secret_key
      ) then raise exception 'invalid_integration_secret'; end if;
      if nullif(v_secret_value, '') is null then continue; end if;

      begin
        v_existing_secret_id :=
          nullif(v_secret_refs ->> v_secret_key, '')::uuid;
      exception when invalid_text_representation then
        v_existing_secret_id := null;
      end;

      v_saved_secret_id := private_app.integration_secret_upsert(
        v_tenant.id,
        v_connection_id,
        v_secret_key,
        v_secret_value,
        v_existing_secret_id
      );
      v_secret_refs := jsonb_set(
        v_secret_refs,
        array[v_secret_key],
        to_jsonb(v_saved_secret_id::text),
        true
      );
    end loop;

    update communication_hub.provider_connections
    set secret_refs = v_secret_refs,
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection_id
    returning * into v_connection;

    if coalesce(
      (p_payload ->> 'makeDefault')::boolean,
      v_connection.is_default
    ) then
      update communication_hub.provider_connections
      set is_default = false,
          updated_by_subject_id = v_actor_subject_id
      where tenant_id = v_tenant.id
        and channel = v_channel
        and id <> v_connection_id;

      update communication_hub.provider_connections
      set is_default = true,
          updated_by_subject_id = v_actor_subject_id
      where id = v_connection_id
      returning * into v_connection;
    end if;

    insert into core.integrations (
      tenant_id,
      system_type,
      display_name,
      status,
      configuration
    )
    values (
      v_tenant.id,
      case v_provider_key
        when 'meta_whatsapp' then 'whatsapp_cloud'
        when 'resend' then 'resend_email'
        when 'amazon_ses' then 'amazon_ses_email'
        when 'webhook_whatsapp' then 'whatsapp_custom_api'
        when 'webhook_email' then 'email_custom_api'
        else 'custom_webhook'
      end,
      v_display_name,
      'draft',
      jsonb_build_object(
        'connectionId', v_connection_id,
        'providerKey', v_provider_key,
        'channel', v_channel,
        'providerState', 'saved_requires_test',
        'addonKey', v_catalog.addon_key,
        'dispatchMode', 'supabase_edge_function'
      )
    )
    on conflict (tenant_id, system_type) where tenant_id is not null
    do update
    set display_name = excluded.display_name,
        status = excluded.status,
        configuration = excluded.configuration,
        last_checked_at = null,
        updated_at = now();

    perform private_app.write_audit(
      'integration.connection.saved',
      'provider_connection',
      v_connection_id::text,
      v_tenant.id,
      jsonb_build_object(
        'providerKey', v_provider_key,
        'channel', v_channel,
        'configuredSecretCount',
          (
            select count(*)
            from jsonb_each_text(v_secret_refs)
          )
      )
    );

    return jsonb_build_object(
      'connectionId', v_connection_id,
      'status', v_connection.status,
      'configuredSecrets',
        coalesce((
          select jsonb_agg(secret.key order by secret.key)
          from jsonb_each_text(v_secret_refs) secret
        ), '[]'::jsonb)
    );

  elsif p_action = 'set_default_connection' then
    begin
      v_connection_id := (p_payload ->> 'connectionId')::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_integration_connection';
    end;

    select *
    into v_connection
    from communication_hub.provider_connections connection
    where connection.id = v_connection_id
      and connection.tenant_id = v_tenant.id
      and connection.status <> 'disabled'
    for update;
    if v_connection.id is null then
      raise exception 'integration_connection_not_found';
    end if;

    update communication_hub.provider_connections
    set is_default = false,
        updated_by_subject_id = v_actor_subject_id
    where tenant_id = v_tenant.id
      and channel = v_connection.channel;

    update communication_hub.provider_connections
    set is_default = true,
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection.id;

    perform private_app.write_audit(
      'integration.connection.default_changed',
      'provider_connection',
      v_connection.id::text,
      v_tenant.id,
      jsonb_build_object('channel', v_connection.channel)
    );
    return jsonb_build_object(
      'connectionId', v_connection.id,
      'isDefault', true
    );

  elsif p_action = 'disable_connection' then
    begin
      v_connection_id := (p_payload ->> 'connectionId')::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_integration_connection';
    end;

    update communication_hub.provider_connections
    set status = 'disabled',
        is_default = false,
        last_error = null,
        updated_by_subject_id = v_actor_subject_id
    where id = v_connection_id
      and tenant_id = v_tenant.id
    returning * into v_connection;
    if v_connection.id is null then
      raise exception 'integration_connection_not_found';
    end if;

    perform private_app.write_audit(
      'integration.connection.disabled',
      'provider_connection',
      v_connection.id::text,
      v_tenant.id,
      jsonb_build_object(
        'providerKey', v_connection.provider_key,
        'channel', v_connection.channel
      )
    );
    return jsonb_build_object(
      'connectionId', v_connection.id,
      'status', 'disabled'
    );

  elsif p_action = 'save_template' then
    if not private_app.tenant_addon_enabled(
      v_tenant.id,
      'addon.communication.templates'
    ) then raise exception 'integration_addon_not_enabled'; end if;

    begin
      v_template_id := nullif(p_payload ->> 'templateId', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_message_template';
    end;

    v_template_key := nullif(trim(p_payload ->> 'templateKey'), '');
    v_channel := coalesce(
      nullif(trim(p_payload ->> 'channel'), ''),
      'any'
    );
    v_subject := nullif(trim(p_payload ->> 'subject'), '');
    v_body := p_payload ->> 'body';

    if v_template_key is null
       or v_template_key !~ '^[a-z][a-z0-9_]{2,80}$' then
      raise exception 'invalid_message_template';
    end if;
    if v_channel not in ('any', 'whatsapp', 'email', 'api') then
      raise exception 'invalid_template_channel';
    end if;
    perform private_app.validate_message_template(v_subject, v_body);
    v_variables := private_app.message_template_variables(
      v_subject,
      v_body
    );

    if v_template_id is not null then
      select *
      into v_template
      from communication_hub.message_templates template
      where template.id = v_template_id
        and template.tenant_id = v_tenant.id
      for update;
      if v_template.id is null then
        raise exception 'message_template_not_found';
      end if;
      if v_template.template_key <> v_template_key then
        raise exception 'message_template_key_locked';
      end if;
    end if;

    insert into communication_hub.message_templates (
      id,
      tenant_id,
      template_key,
      event_key,
      channel,
      name_ar,
      description_ar,
      subject_template,
      body_template,
      default_subject_template,
      default_body_template,
      provider_template_name,
      locale,
      variables,
      status,
      is_system,
      created_by_subject_id,
      updated_by_subject_id
    )
    values (
      coalesce(v_template_id, gen_random_uuid()),
      v_tenant.id,
      v_template_key,
      coalesce(
        nullif(trim(p_payload ->> 'eventKey'), ''),
        'custom.' || v_template_key
      ),
      v_channel,
      coalesce(
        nullif(trim(p_payload ->> 'name'), ''),
        replace(v_template_key, '_', ' ')
      ),
      nullif(trim(p_payload ->> 'description'), ''),
      v_subject,
      v_body,
      coalesce(v_template.default_subject_template, v_subject),
      coalesce(v_template.default_body_template, v_body),
      nullif(trim(p_payload ->> 'providerTemplateName'), ''),
      coalesce(nullif(trim(p_payload ->> 'locale'), ''), 'ar'),
      v_variables,
      case
        when p_payload ->> 'status' = 'draft' then 'draft'
        else 'active'
      end,
      coalesce(v_template.is_system, false),
      coalesce(v_template.created_by_subject_id, v_actor_subject_id),
      v_actor_subject_id
    )
    on conflict (tenant_id, template_key, channel) do update
    set name_ar = excluded.name_ar,
        description_ar = excluded.description_ar,
        subject_template = excluded.subject_template,
        body_template = excluded.body_template,
        provider_template_name = excluded.provider_template_name,
        locale = excluded.locale,
        variables = excluded.variables,
        status = excluded.status,
        updated_by_subject_id = excluded.updated_by_subject_id,
        updated_at = now()
    returning * into v_template;

    perform private_app.write_audit(
      'communication.template.saved',
      'message_template',
      v_template.id::text,
      v_tenant.id,
      jsonb_build_object(
        'templateKey', v_template.template_key,
        'channel', v_template.channel,
        'variables', to_jsonb(v_template.variables)
      )
    );
    return jsonb_build_object(
      'templateId', v_template.id,
      'status', v_template.status
    );

  elsif p_action = 'restore_template' then
    begin
      v_template_id := (p_payload ->> 'templateId')::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_message_template';
    end;

    update communication_hub.message_templates
    set subject_template = default_subject_template,
        body_template = default_body_template,
        provider_template_name = null,
        variables = private_app.message_template_variables(
          default_subject_template,
          default_body_template
        ),
        status = 'active',
        updated_by_subject_id = v_actor_subject_id
    where id = v_template_id
      and tenant_id = v_tenant.id
      and is_system
    returning * into v_template;
    if v_template.id is null then
      raise exception 'message_template_not_found';
    end if;

    perform private_app.write_audit(
      'communication.template.restored',
      'message_template',
      v_template.id::text,
      v_tenant.id,
      jsonb_build_object('templateKey', v_template.template_key)
    );
    return jsonb_build_object(
      'templateId', v_template.id,
      'restored', true
    );
  else
    raise exception 'invalid_integration_hub_action';
  end if;
end;
$$;

create or replace function public.v2_tenant_integration_test_authorize(
  p_tenant_slug text,
  p_connection_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_connection communication_hub.provider_connections%rowtype;
  v_catalog communication_hub.provider_catalog%rowtype;
begin
  select *
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  select connection.*
  into v_connection
  from communication_hub.provider_connections connection
  where connection.id = p_connection_id
    and connection.tenant_id = v_tenant.id
    and connection.status <> 'disabled'
  limit 1;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select catalog.*
  into v_catalog
  from communication_hub.provider_catalog catalog
  where catalog.provider_key = v_connection.provider_key
  limit 1;

  if not private_app.tenant_addon_enabled(
    v_tenant.id,
    v_catalog.addon_key
  ) then raise exception 'integration_addon_not_enabled'; end if;

  update communication_hub.provider_connections
  set status = 'testing',
      last_error = null,
      updated_by_subject_id = private_app.current_subject_id()
  where id = v_connection.id;

  return jsonb_build_object(
    'tenantId', v_tenant.id,
    'connectionId', v_connection.id,
    'providerKey', v_connection.provider_key,
    'channel', v_connection.channel
  );
end;
$$;

create or replace function public.v2_integration_provider_configuration(
  p_tenant_id uuid,
  p_channel text,
  p_connection_id uuid default null,
  p_include_draft boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_secrets jsonb;
  v_templates jsonb;
begin
  select *
  into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = p_tenant_id
    and connection.channel = p_channel
    and (
      (p_connection_id is not null and connection.id = p_connection_id)
      or (
        p_connection_id is null
        and connection.is_default
      )
    )
    and connection.status <> 'disabled'
    and (
      p_include_draft
      or connection.status in ('active', 'degraded')
    )
  order by connection.is_default desc, connection.updated_at desc
  limit 1;

  if v_connection.id is null then return null; end if;

  select coalesce(
    jsonb_object_agg(reference.key, secret.decrypted_secret),
    '{}'::jsonb
  )
  into v_secrets
  from jsonb_each_text(v_connection.secret_refs) reference
  join vault.decrypted_secrets secret
    on secret.id::text = reference.value;

  select coalesce(
    jsonb_object_agg(
      template.template_key,
      jsonb_strip_nulls(jsonb_build_object(
        'name', template.provider_template_name,
        'locale', template.locale
      ))
    ),
    '{}'::jsonb
  )
  into v_templates
  from communication_hub.message_templates template
  where template.tenant_id = p_tenant_id
    and template.status = 'active'
    and template.channel in (p_channel, 'any')
    and template.provider_template_name is not null;

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'tenantId', v_connection.tenant_id,
    'channel', v_connection.channel,
    'providerKey', v_connection.provider_key,
    'displayName', v_connection.display_name,
    'publicConfig', v_connection.public_config,
    'secrets', v_secrets,
    'templates', v_templates
  );
end;
$$;

create or replace function public.v2_integration_test_complete(
  p_connection_id uuid,
  p_state text,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_status text;
  v_system_type text;
begin
  if p_state not in ('ready', 'error') then
    raise exception 'invalid_provider_state';
  end if;
  v_status := case p_state when 'ready' then 'active' else 'error' end;

  update communication_hub.provider_connections
  set status = v_status,
      last_checked_at = now(),
      last_error = case
        when p_state = 'error'
          then left(coalesce(nullif(p_detail, ''), 'connection_test_failed'), 500)
        else null
      end
  where id = p_connection_id
  returning * into v_connection;
  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  v_system_type := case v_connection.provider_key
    when 'meta_whatsapp' then 'whatsapp_cloud'
    when 'resend' then 'resend_email'
    when 'amazon_ses' then 'amazon_ses_email'
    when 'webhook_whatsapp' then 'whatsapp_custom_api'
    when 'webhook_email' then 'email_custom_api'
    else 'custom_webhook'
  end;

  insert into core.integrations (
    tenant_id,
    system_type,
    display_name,
    status,
    configuration,
    last_checked_at
  )
  values (
    v_connection.tenant_id,
    v_system_type,
    v_connection.display_name,
    case p_state when 'ready' then 'active' else 'error' end,
    jsonb_strip_nulls(jsonb_build_object(
      'connectionId', v_connection.id,
      'providerKey', v_connection.provider_key,
      'channel', v_connection.channel,
      'providerState', p_state,
      'statusDetail', left(nullif(p_detail, ''), 240),
      'dispatchMode', 'supabase_edge_function'
    )),
    now()
  )
  on conflict (tenant_id, system_type) where tenant_id is not null
  do update
  set display_name = excluded.display_name,
      status = excluded.status,
      configuration = excluded.configuration,
      last_checked_at = excluded.last_checked_at,
      updated_at = now();

  insert into audit_log.events (
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_connection.tenant_id,
    'integration.connection.test_' || p_state,
    'provider_connection',
    v_connection.id::text,
    jsonb_build_object(
      'providerKey', v_connection.provider_key,
      'channel', v_connection.channel
    )
  );

  return jsonb_build_object(
    'connectionId', v_connection.id,
    'state', p_state,
    'status', v_connection.status
  );
end;
$$;

revoke execute on function
  public.v2_tenant_integration_hub_snapshot(text)
from public, anon;

revoke execute on function
  public.v2_tenant_integration_hub_action(text, text, jsonb)
from public, anon;

revoke execute on function
  public.v2_tenant_integration_test_authorize(text, uuid)
from public, anon;

revoke execute on function
  public.v2_integration_provider_configuration(
    uuid,
    text,
    uuid,
    boolean
  )
from public, anon, authenticated;

revoke execute on function
  public.v2_integration_test_complete(uuid, text, text)
from public, anon, authenticated;

grant execute on function
  public.v2_tenant_integration_hub_snapshot(text)
to authenticated;

grant execute on function
  public.v2_tenant_integration_hub_action(text, text, jsonb)
to authenticated;

grant execute on function
  public.v2_tenant_integration_test_authorize(text, uuid)
to authenticated;

grant execute on function
  public.v2_integration_provider_configuration(
    uuid,
    text,
    uuid,
    boolean
  )
to service_role;

grant execute on function
  public.v2_integration_test_complete(uuid, text, text)
to service_role;

comment on schema communication_hub is
'Tenant-isolated provider connections, encrypted credential references, and reusable message templates.';

comment on table communication_hub.provider_connections is
'One independently entitled provider connection per tenant, channel, and provider.';

comment on table communication_hub.message_templates is
'Reusable tenant message templates with validated personalization variables.';

comment on function public.v2_tenant_integration_hub_snapshot(text) is
'Role-protected integration catalog, masked connection state, add-on availability, and message templates.';

comment on function public.v2_tenant_integration_hub_action(
  text,
  text,
  jsonb
) is
'Saves encrypted provider credentials or message templates after tenant permission and add-on checks.';

commit;
