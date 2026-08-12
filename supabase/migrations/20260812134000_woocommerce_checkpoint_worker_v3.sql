-- Applied migration version: 20260812134000
begin;

do $deployment_gate$
begin
  if exists (
    select 1
    from commerce_sync.sync_runs run
    where run.status = 'running'
  ) then
    raise exception 'woocommerce_sync_deployment_running_run';
  end if;
end;
$deployment_gate$;

alter table commerce_sync.sync_runs
  add column if not exists checkpoint_seq bigint not null default 0,
  add column if not exists worker_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists attempt_count integer not null default 0;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname =
      'commerce_sync_runs_checkpoint_seq_nonnegative'
      and constraint_row.conrelid =
        'commerce_sync.sync_runs'::regclass
  ) then
    alter table commerce_sync.sync_runs
      add constraint commerce_sync_runs_checkpoint_seq_nonnegative
      check (checkpoint_seq >= 0);
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname =
      'commerce_sync_runs_attempt_count_nonnegative'
      and constraint_row.conrelid =
        'commerce_sync.sync_runs'::regclass
  ) then
    alter table commerce_sync.sync_runs
      add constraint commerce_sync_runs_attempt_count_nonnegative
      check (attempt_count >= 0);
  end if;
end;
$constraints$;

create index if not exists commerce_sync_runs_recovery_v3_idx
on commerce_sync.sync_runs (next_attempt_at, started_at, id)
where status = 'running' and has_more = true;

create or replace function private_app.enqueue_woocommerce_continuation(
  p_run_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  if p_run_id is null then
    raise exception 'woocommerce_sync_run_invalid';
  end if;

  select secret.decrypted_secret
  into v_url
  from vault.decrypted_secrets secret
  where secret.name = 'woocommerce_function_url'
  limit 1;

  if v_url is null
     or v_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/functions/v1/woocommerce-sync$'
  then
    raise exception 'woocommerce_function_url_missing';
  end if;

  select secret.decrypted_secret
  into v_secret
  from vault.decrypted_secrets secret
  where secret.name = 'woocommerce_dispatch_secret'
  limit 1;

  if nullif(trim(v_secret), '') is null then
    raise exception 'woocommerce_dispatch_secret_missing';
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-marktone-woocommerce-secret', v_secret
    ),
    body := jsonb_build_object(
      'action', 'continue_sync',
      'runId', p_run_id,
      'requestedAt', now()
    ),
    timeout_milliseconds := 15000
  )
  into v_request_id;

  return v_request_id;
end;
$$;

create or replace function private_app.enqueue_woocommerce_dispatch()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  select secret.decrypted_secret
  into v_url
  from vault.decrypted_secrets secret
  where secret.name = 'woocommerce_function_url'
  limit 1;

  if v_url is null
     or v_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/functions/v1/woocommerce-sync$'
  then
    raise exception 'woocommerce_function_url_missing';
  end if;

  select secret.decrypted_secret
  into v_secret
  from vault.decrypted_secrets secret
  where secret.name = 'woocommerce_dispatch_secret'
  limit 1;

  if nullif(trim(v_secret), '') is null then
    raise exception 'woocommerce_dispatch_secret_missing';
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-marktone-woocommerce-secret', v_secret
    ),
    body := jsonb_build_object(
      'action', 'scheduled_sync',
      'requestedAt', now()
    ),
    timeout_milliseconds := 15000
  )
  into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function private_app.enqueue_woocommerce_continuation(uuid)
from public, anon, authenticated;
revoke all on function private_app.enqueue_woocommerce_dispatch()
from public, anon, authenticated;

create or replace function public.v3_woocommerce_start_sync(
  p_connection_id uuid,
  p_trigger text,
  p_scope jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_run commerce_sync.sync_runs%rowtype;
  v_run_id uuid;
  v_duplicate boolean;
begin
  v_result := public.v2_woocommerce_start_sync(
    p_connection_id,
    p_trigger,
    p_scope,
    p_idempotency_key
  );
  v_run_id := (v_result ->> 'runId')::uuid;
  v_duplicate := coalesce((v_result ->> 'duplicate')::boolean, false);

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = v_run_id
    and run.connection_id = p_connection_id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;

  if not v_duplicate then
    update commerce_sync.sync_runs run
    set current_cursor = jsonb_build_object(
          'v', 2,
          'step', 0,
          'mode', 'metadata',
          'page', 1,
          'totals', '{}'::jsonb,
          'pages', '{}'::jsonb,
          'remoteMetadata', '{}'::jsonb,
          'retryCount', 0,
          'startedAt', now()
        ),
        has_more = true,
        checkpoint_seq = 0,
        worker_id = null,
        lease_expires_at = null,
        next_attempt_at = now(),
        attempt_count = 0
    where run.id = v_run.id;

    perform private_app.enqueue_woocommerce_continuation(v_run.id);
  elsif v_run.status = 'running'
        and coalesce((v_run.current_cursor ->> 'v')::integer, 0) = 2
        and (
          v_run.lease_expires_at is null
          or v_run.lease_expires_at <= now()
        )
        and v_run.next_attempt_at <= now()
  then
    perform private_app.enqueue_woocommerce_continuation(v_run.id);
  end if;

  return v_result || jsonb_build_object(
    'accepted', (v_result ->> 'status') = 'running',
    'checkpointSeq', coalesce(v_run.checkpoint_seq, 0)
  );
end;
$$;

create or replace function public.v3_woocommerce_claim_run(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run commerce_sync.sync_runs%rowtype;
  v_worker text := nullif(trim(p_worker_id), '');
  v_lease_seconds integer := coalesce(p_lease_seconds, 60);
begin
  if v_worker is null or length(v_worker) < 8 or length(v_worker) > 200 then
    raise exception 'woocommerce_worker_id_invalid';
  end if;
  if v_lease_seconds < 15 or v_lease_seconds > 120 then
    raise exception 'woocommerce_worker_lease_invalid';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.status = 'running'
    and run.has_more = true
    and run.next_attempt_at <= now()
    and (
      run.lease_expires_at is null
      or run.lease_expires_at <= now()
    )
  for update skip locked;

  if v_run.id is null then return null; end if;
  if coalesce((v_run.current_cursor ->> 'v')::integer, 0) <> 2 then
    raise exception 'woocommerce_sync_cursor_version_invalid';
  end if;

  update commerce_sync.sync_runs run
  set worker_id = v_worker,
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      attempt_count = run.attempt_count + 1
  where run.id = v_run.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'connectionId', v_run.connection_id,
    'scope', to_jsonb(v_run.scope),
    'cursor', v_run.current_cursor,
    'checkpointSeq', v_run.checkpoint_seq,
    'attemptCount', v_run.attempt_count + 1,
    'workerId', v_worker
  );
end;
$$;

create or replace function public.v3_woocommerce_store_batch_and_yield(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_entity_type text,
  p_items jsonb,
  p_next_cursor jsonb,
  p_has_more boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run commerce_sync.sync_runs%rowtype;
  v_result jsonb;
  v_next_seq bigint;
begin
  if jsonb_typeof(p_next_cursor) <> 'object'
     or coalesce((p_next_cursor ->> 'v')::integer, 0) <> 2
  then
    raise exception 'woocommerce_sync_cursor_version_invalid';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then raise exception 'sync_run_not_running'; end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  if v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  v_result := public.v2_woocommerce_store_batch(
    p_connection_id,
    p_run_id,
    p_entity_type,
    p_items,
    p_next_cursor,
    coalesce(p_has_more, true)
  );
  v_next_seq := v_run.checkpoint_seq + 1;

  update commerce_sync.sync_runs run
  set checkpoint_seq = v_next_seq,
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where run.id = v_run.id;

  if coalesce(p_has_more, true) then
    perform private_app.enqueue_woocommerce_continuation(v_run.id);
  end if;

  return v_result || jsonb_build_object('checkpointSeq', v_next_seq);
end;
$$;

create or replace function public.v3_woocommerce_checkpoint_and_yield(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_next_cursor jsonb,
  p_has_more boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run commerce_sync.sync_runs%rowtype;
  v_next_seq bigint;
begin
  if jsonb_typeof(p_next_cursor) <> 'object'
     or coalesce((p_next_cursor ->> 'v')::integer, 0) <> 2
  then
    raise exception 'woocommerce_sync_cursor_version_invalid';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then raise exception 'sync_run_not_running'; end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  if v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  v_next_seq := v_run.checkpoint_seq + 1;
  update commerce_sync.sync_runs run
  set current_cursor = p_next_cursor,
      has_more = coalesce(p_has_more, true),
      checkpoint_seq = v_next_seq,
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where run.id = v_run.id;

  if coalesce(p_has_more, true) then
    perform private_app.enqueue_woocommerce_continuation(v_run.id);
  end if;

  return jsonb_build_object(
    'runId', v_run.id,
    'checkpointSeq', v_next_seq,
    'cursor', p_next_cursor,
    'hasMore', coalesce(p_has_more, true)
  );
end;
$$;

create or replace function public.v3_woocommerce_complete_claimed_run(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_stats jsonb,
  p_remote_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_result jsonb;
begin
  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  if v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    raise exception 'woocommerce_sync_lease_expired';
  end if;
  if v_run.current_cursor ->> 'mode' <> 'complete' then
    raise exception 'woocommerce_sync_not_complete';
  end if;

  v_result := public.v2_woocommerce_complete_sync(
    p_connection_id,
    p_run_id,
    p_stats,
    p_remote_metadata
  );

  update commerce_sync.sync_runs run
  set worker_id = null,
      lease_expires_at = null,
      next_attempt_at = now()
  where run.id = v_run.id;

  return v_result;
end;
$$;

create or replace function public.v3_woocommerce_fail_claimed_run(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_result jsonb;
begin
  select *
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  if v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  v_result := public.v2_woocommerce_fail_sync(
    p_connection_id,
    p_run_id,
    left(coalesce(nullif(trim(p_error), ''), 'woocommerce_sync_failed'), 200)
  );

  update commerce_sync.sync_runs run
  set worker_id = null,
      lease_expires_at = null
  where run.id = v_run.id;

  return v_result;
end;
$$;

create or replace function public.v3_woocommerce_release_run(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_error text,
  p_delay_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run commerce_sync.sync_runs%rowtype;
  v_delay integer := greatest(15, least(coalesce(p_delay_seconds, 60), 900));
  v_retry_count integer;
  v_next_attempt_at timestamptz;
begin
  select *
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = p_connection_id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  if v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  v_retry_count := case
    when coalesce(v_run.current_cursor ->> 'retryCount', '') ~ '^[0-9]+$'
      then (v_run.current_cursor ->> 'retryCount')::integer + 1
    else 1
  end;
  v_next_attempt_at := now() + make_interval(secs => v_delay);

  update commerce_sync.sync_runs run
  set current_cursor = jsonb_set(
        jsonb_set(
          run.current_cursor,
          '{retryCount}',
          to_jsonb(v_retry_count),
          true
        ),
        '{lastRetryError}',
        to_jsonb(left(coalesce(nullif(trim(p_error), ''), 'retry'), 160)),
        true
      ),
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = v_next_attempt_at
  where run.id = v_run.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'status', 'running',
    'retryCount', v_retry_count,
    'nextAttemptAt', v_next_attempt_at
  );
end;
$$;

create or replace function public.v3_woocommerce_requeue_recoverable(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
  v_run record;
  v_ids jsonb := '[]'::jsonb;
begin
  for v_run in
    select run.id
    from commerce_sync.sync_runs run
    where run.status = 'running'
      and run.has_more = true
      and run.next_attempt_at <= now()
      and (
        run.lease_expires_at is null
        or run.lease_expires_at <= now()
      )
      and coalesce((run.current_cursor ->> 'v')::integer, 0) = 2
    order by run.next_attempt_at, run.started_at, run.id
    for update skip locked
    limit v_limit
  loop
    perform private_app.enqueue_woocommerce_continuation(v_run.id);
    v_ids := v_ids || jsonb_build_array(v_run.id);
  end loop;

  return jsonb_build_object(
    'queued', jsonb_array_length(v_ids),
    'runIds', v_ids
  );
end;
$$;

revoke all on function public.v3_woocommerce_start_sync(
  uuid,text,jsonb,text
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_claim_run(
  uuid,text,integer
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_store_batch_and_yield(
  uuid,uuid,text,bigint,text,jsonb,jsonb,boolean
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_checkpoint_and_yield(
  uuid,uuid,text,bigint,jsonb,boolean
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_complete_claimed_run(
  uuid,uuid,text,bigint,jsonb,jsonb
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_fail_claimed_run(
  uuid,uuid,text,bigint,text
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_release_run(
  uuid,uuid,text,bigint,text,integer
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_requeue_recoverable(integer)
from public, anon, authenticated;

grant execute on function public.v3_woocommerce_start_sync(
  uuid,text,jsonb,text
) to service_role;
grant execute on function public.v3_woocommerce_claim_run(
  uuid,text,integer
) to service_role;
grant execute on function public.v3_woocommerce_store_batch_and_yield(
  uuid,uuid,text,bigint,text,jsonb,jsonb,boolean
) to service_role;
grant execute on function public.v3_woocommerce_checkpoint_and_yield(
  uuid,uuid,text,bigint,jsonb,boolean
) to service_role;
grant execute on function public.v3_woocommerce_complete_claimed_run(
  uuid,uuid,text,bigint,jsonb,jsonb
) to service_role;
grant execute on function public.v3_woocommerce_fail_claimed_run(
  uuid,uuid,text,bigint,text
) to service_role;
grant execute on function public.v3_woocommerce_release_run(
  uuid,uuid,text,bigint,text,integer
) to service_role;
grant execute on function public.v3_woocommerce_requeue_recoverable(integer)
to service_role;

do $schedule$
declare
  v_job_id bigint;
begin
  select job.jobid
  into v_job_id
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
      select private_app.enqueue_woocommerce_dispatch();
    $command$
  );
end;
$schedule$;

comment on function public.v3_woocommerce_start_sync(uuid,text,jsonb,text) is
'Starts a checkpointed WooCommerce run and transactionally queues its first page.';
comment on function public.v3_woocommerce_claim_run(uuid,text,integer) is
'Claims one resumable WooCommerce run with a bounded worker lease.';
comment on function public.v3_woocommerce_store_batch_and_yield(
  uuid,uuid,text,bigint,text,jsonb,jsonb,boolean
) is
'Stores one WooCommerce page, advances its CAS checkpoint, and queues the next page atomically.';

commit;
