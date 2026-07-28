begin;

alter table academy.training_automation_jobs
  drop constraint training_automation_jobs_status_check;

alter table academy.training_automation_jobs
  add constraint training_automation_jobs_status_check
  check (
    status in (
      'pending',
      'processing',
      'sent',
      'simulated',
      'failed',
      'waiting_configuration',
      'cancelled'
    )
  );

create table communication_hub.sandbox_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references communication_hub.provider_connections(id)
    on delete cascade,
  job_id uuid
    references academy.training_automation_jobs(id)
    on delete set null,
  receipt_type text not null
    check (receipt_type in ('connection_test', 'message_simulated')),
  external_id text not null,
  channel text not null
    check (channel in ('whatsapp', 'email')),
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique (connection_id, external_id)
);

create index sandbox_receipts_tenant_time_idx
on communication_hub.sandbox_receipts (
  tenant_id,
  received_at desc
);

create index sandbox_receipts_job_reference_idx
on communication_hub.sandbox_receipts (job_id)
where job_id is not null;

alter table communication_hub.sandbox_receipts
enable row level security;

revoke all on table communication_hub.sandbox_receipts
from public, anon, authenticated;

insert into communication_hub.provider_catalog (
  provider_key,
  channel,
  name_ar,
  description_ar,
  addon_key,
  setup_fields,
  secret_fields,
  docs_url,
  supports_test,
  status,
  sort_order
)
values
  (
    'marktone_sandbox_whatsapp',
    'whatsapp',
    'بوابة ماركتون التجريبية — واتساب',
    'اختبار حي للطابور والتشفير والاستلام دون إرسال رسالة إلى العميل.',
    'addon.integration.whatsapp',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'key', 'sandboxToken',
      'label', 'رمز بوابة الاختبار',
      'type', 'password',
      'required', true
    )),
    null,
    true,
    'beta',
    90
  ),
  (
    'marktone_sandbox_email',
    'email',
    'بوابة ماركتون التجريبية — بريد',
    'اختبار حي للطابور والتشفير والاستلام دون إرسال رسالة إلى العميل.',
    'addon.integration.email',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'key', 'sandboxToken',
      'label', 'رمز بوابة الاختبار',
      'type', 'password',
      'required', true
    )),
    null,
    true,
    'beta',
    90
  )
on conflict (provider_key) do update
set name_ar = excluded.name_ar,
    description_ar = excluded.description_ar,
    secret_fields = excluded.secret_fields,
    supports_test = excluded.supports_test,
    status = excluded.status,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function private_app.sandbox_secret_valid(
  p_connection_id uuid,
  p_token text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from communication_hub.provider_connections connection
    join lateral jsonb_each_text(connection.secret_refs) reference
      on reference.key = 'sandboxToken'
    join vault.decrypted_secrets secret
      on secret.id::text = reference.value
    where connection.id = p_connection_id
      and connection.provider_key in (
        'marktone_sandbox_whatsapp',
        'marktone_sandbox_email'
      )
      and connection.status <> 'disabled'
      and secret.decrypted_secret = p_token
  );
$$;

revoke all on function
  private_app.sandbox_secret_valid(uuid, text)
from public, anon, authenticated;

create or replace function public.v2_sandbox_delivery_receive(
  p_connection_id uuid,
  p_token text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection communication_hub.provider_connections%rowtype;
  v_receipt_type text;
  v_external_id text;
  v_job_id uuid;
  v_receipt_id uuid;
begin
  if not private_app.sandbox_secret_valid(
    p_connection_id,
    p_token
  ) then raise exception 'forbidden'; end if;

  select *
  into v_connection
  from communication_hub.provider_connections connection
  where connection.id = p_connection_id;

  v_receipt_type := case
    when p_payload ->> 'event' = 'marktone.integration.test'
      then 'connection_test'
    else 'message_simulated'
  end;
  v_external_id := coalesce(
    nullif(p_payload ->> 'externalId', ''),
    'sandbox-' || gen_random_uuid()::text
  );

  begin
    v_job_id := nullif(p_payload ->> 'jobId', '')::uuid;
  exception when invalid_text_representation then
    v_job_id := null;
  end;

  insert into communication_hub.sandbox_receipts (
    tenant_id,
    connection_id,
    job_id,
    receipt_type,
    external_id,
    channel,
    payload
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    v_job_id,
    v_receipt_type,
    v_external_id,
    v_connection.channel,
    jsonb_strip_nulls(jsonb_build_object(
      'event', p_payload ->> 'event',
      'jobType', p_payload ->> 'jobType',
      'recipientMasked',
        case
          when length(coalesce(p_payload ->> 'recipient', '')) > 4
            then repeat(
              '•',
              least(
                length(p_payload ->> 'recipient') - 4,
                12
              )
            ) || right(p_payload ->> 'recipient', 4)
          else null
        end,
      'subject', left(p_payload ->> 'subject', 160),
      'messageLength',
        length(coalesce(p_payload ->> 'message', '')),
      'receivedAt', now()
    ))
  )
  on conflict (connection_id, external_id) do update
  set payload = excluded.payload,
      received_at = excluded.received_at
  returning id into v_receipt_id;

  insert into audit_log.events (
    tenant_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_connection.tenant_id,
    'integration.sandbox.' || v_receipt_type,
    'sandbox_receipt',
    v_receipt_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'connectionId', v_connection.id,
      'jobId', v_job_id,
      'channel', v_connection.channel,
      'externalId', v_external_id
    ))
  );

  return jsonb_build_object(
    'receiptId', v_receipt_id,
    'externalId', v_external_id,
    'state', case
      when v_receipt_type = 'connection_test' then 'ready'
      else 'simulated'
    end
  );
end;
$$;

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
begin
  if p_result_state <> 'simulated' then
    return public.v2_training_automation_complete_job(
      p_secret,
      p_job_id,
      p_result_state,
      p_external_id,
      p_external_url,
      p_error
    );
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

revoke execute on function public.v2_sandbox_delivery_receive(
  uuid,
  text,
  jsonb
) from public, anon, authenticated;

revoke execute on function
  public.v2_training_automation_complete_job_v2(
    text,
    uuid,
    text,
    text,
    text,
    text,
    uuid,
    text
  )
from public, anon, authenticated;

grant execute on function public.v2_sandbox_delivery_receive(
  uuid,
  text,
  jsonb
) to service_role;

grant execute on function
  public.v2_training_automation_complete_job_v2(
    text,
    uuid,
    text,
    text,
    text,
    text,
    uuid,
    text
  )
to service_role;

do $seed_sandbox$
declare
  v_tenant_id uuid;
  v_provider record;
  v_connection_id uuid;
  v_secret_id uuid;
  v_secret_refs jsonb;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = 'reef-skills'
  limit 1;

  if v_tenant_id is null then
    return;
  end if;

  for v_provider in
    select *
    from (
      values
        (
          'marktone_sandbox_whatsapp'::text,
          'whatsapp'::text,
          'بوابة ماركتون التجريبية — واتساب'::text
        ),
        (
          'marktone_sandbox_email'::text,
          'email'::text,
          'بوابة ماركتون التجريبية — بريد'::text
        )
    ) value(provider_key, channel, display_name)
  loop
    insert into communication_hub.provider_connections (
      tenant_id,
      channel,
      provider_key,
      display_name,
      status,
      is_default,
      public_config
    )
    values (
      v_tenant_id,
      v_provider.channel,
      v_provider.provider_key,
      v_provider.display_name,
      'draft',
      true,
      jsonb_build_object(
        'sandbox', true,
        'sentToRecipient', false
      )
    )
    on conflict (tenant_id, channel, provider_key) do update
    set display_name = excluded.display_name,
        status = case
          when communication_hub.provider_connections.status = 'active'
            then 'active'
          else 'draft'
        end,
        is_default = true,
        public_config = excluded.public_config,
        last_error = null,
        updated_at = now()
    returning id, secret_refs
    into v_connection_id, v_secret_refs;

    begin
      v_secret_id :=
        nullif(v_secret_refs ->> 'sandboxToken', '')::uuid;
    exception when invalid_text_representation then
      v_secret_id := null;
    end;

    if v_secret_id is null
       or not exists (
         select 1
         from vault.secrets secret
         where secret.id = v_secret_id
       ) then
      select vault.create_secret(
        encode(gen_random_bytes(32), 'hex'),
        'integration:' || v_tenant_id::text
          || ':' || v_connection_id::text
          || ':sandboxToken',
        'Encrypted Marktone sandbox gateway token.'
      )
      into v_secret_id;

      update communication_hub.provider_connections
      set secret_refs = jsonb_set(
        coalesce(secret_refs, '{}'::jsonb),
        '{sandboxToken}',
        to_jsonb(v_secret_id::text),
        true
      )
      where id = v_connection_id;
    end if;
  end loop;
end;
$seed_sandbox$;

comment on table communication_hub.sandbox_receipts is
'Truthfully labeled live integration receipts for preview tests; no customer delivery is claimed.';

comment on function public.v2_sandbox_delivery_receive(
  uuid,
  text,
  jsonb
) is
'Accepts a signed preview delivery or connection test and stores a masked receipt.';

commit;
