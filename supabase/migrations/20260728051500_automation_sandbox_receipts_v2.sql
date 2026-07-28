begin;

alter table communication_hub.sandbox_receipts
  add column message_outbox_id uuid
    references communication_hub.message_outbox(id)
    on delete set null;

create index sandbox_receipts_outbox_reference_idx
on communication_hub.sandbox_receipts (message_outbox_id)
where message_outbox_id is not null;

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
  v_training_job_id uuid;
  v_outbox_job_id uuid;
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
    if p_payload ->> 'queue' = 'automation' then
      v_outbox_job_id := nullif(p_payload ->> 'jobId', '')::uuid;
    else
      v_training_job_id := nullif(p_payload ->> 'jobId', '')::uuid;
    end if;
  exception when invalid_text_representation then
    v_training_job_id := null;
    v_outbox_job_id := null;
  end;

  insert into communication_hub.sandbox_receipts (
    tenant_id,
    connection_id,
    job_id,
    message_outbox_id,
    receipt_type,
    external_id,
    channel,
    payload
  )
  values (
    v_connection.tenant_id,
    v_connection.id,
    v_training_job_id,
    v_outbox_job_id,
    v_receipt_type,
    v_external_id,
    v_connection.channel,
    jsonb_strip_nulls(jsonb_build_object(
      'event', p_payload ->> 'event',
      'queue', p_payload ->> 'queue',
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
      'trainingJobId', v_training_job_id,
      'messageOutboxId', v_outbox_job_id,
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

revoke execute on function public.v2_sandbox_delivery_receive(
  uuid,
  text,
  jsonb
) from public, anon, authenticated;

grant execute on function public.v2_sandbox_delivery_receive(
  uuid,
  text,
  jsonb
) to service_role;

comment on column
  communication_hub.sandbox_receipts.message_outbox_id is
'Optional reference to a generic automation message; training jobs keep their original typed reference.';

commit;
