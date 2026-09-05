-- Applied migration version: 20260905213000
begin;

-- A declined card attempt is authoritative provider evidence, but QuickLink may
-- not deliver its callback. Queue a read-only inquiry for every created link and
-- run the existing bounded reconciliation worker once per minute. No payment is
-- created, repeated, captured, or retried by this migration.
do $preflight$
begin
  if to_regclass('marketplace.payment_attempts') is null
     or to_regclass('marketplace.reconciliations') is null
     or to_regprocedure(
       'public.v1_service_paymob_reconciliation_claim(text,integer)'
     ) is null
     or to_regprocedure(
       'public.v1_service_paymob_reconciliation_runtime(uuid,uuid,text)'
     ) is null
     or to_regprocedure(
       'public.v1_service_paymob_reconciliation_apply(uuid,uuid,text,uuid,text,text,text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,bigint,text,bigint,bigint,text)'
     ) is null
     or to_regprocedure(
       'public.v1_service_paymob_reconciliation_reschedule(uuid,uuid,text,text,text)'
     ) is null
     or to_regnamespace('cron') is null
     or to_regnamespace('net') is null
     or to_regnamespace('vault') is null then
    raise exception 'paymob_decline_reconciliation_prerequisite_missing';
  end if;
end
$preflight$;

do $dispatcher_secret$
begin
  if not exists (
    select 1
    from vault.secrets secret
    where secret.name = 'paymob_reconcile_dispatcher_v1'
  ) then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(32),'hex'),
      'paymob_reconcile_dispatcher_v1',
      'Authorizes the internal scheduled Paymob reconciliation dispatcher.'
    );
  end if;
end
$dispatcher_secret$;

-- Service-only bridge used by the Edge worker. The secret remains unavailable
-- to browsers, authenticated tenants, logs, snapshots, and public APIs.
create or replace function public.v1_service_paymob_reconcile_dispatch_secret()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_secret text;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select decrypted.decrypted_secret into v_secret
  from vault.decrypted_secrets decrypted
  where decrypted.name = 'paymob_reconcile_dispatcher_v1';

  if v_secret !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_reconcile_dispatch_secret_unavailable';
  end if;

  return jsonb_build_object(
    'schemaVersion',1,
    'dispatcherSecret',v_secret
  );
end
$function$;

revoke all on function public.v1_service_paymob_reconcile_dispatch_secret()
from public,anon,authenticated;
grant execute on function public.v1_service_paymob_reconcile_dispatch_secret()
to service_role;

create or replace function private_app.paymob_queue_quicklink_reconciliation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.provider_key <> 'paymob'
     or new.checkout_flow <> 'quicklink'
     or new.status <> 'intention_created'
     or new.terminal_at is not null
     or new.provider_order_id !~ '^[1-9][0-9]{0,29}$' then
    return new;
  end if;

  -- Do not re-seed the same successful transition on unrelated updates.
  if tg_op = 'UPDATE'
     and old.status = 'intention_created'
     and old.provider_order_id is not distinct from new.provider_order_id then
    return new;
  end if;

  insert into marketplace.reconciliations(
    tenant_id,
    order_id,
    attempt_id,
    provider_key,
    environment,
    reconciliation_type,
    status,
    provider_transaction_id,
    provider_order_id,
    expected_amount_minor,
    expected_currency,
    error_code,
    due_at,
    max_attempts
  ) values (
    new.tenant_id,
    new.order_id,
    new.id,
    'paymob',
    new.environment,
    'transaction_inquiry',
    'queued',
    new.provider_transaction_id,
    new.provider_order_id,
    new.amount_minor,
    new.currency,
    'scheduled_transaction_inquiry',
    now() + interval '30 seconds',
    10
  )
  on conflict (attempt_id,reconciliation_type) do update
  set provider_transaction_id = coalesce(
        excluded.provider_transaction_id,
        marketplace.reconciliations.provider_transaction_id
      ),
      provider_order_id = coalesce(
        excluded.provider_order_id,
        marketplace.reconciliations.provider_order_id
      ),
      expected_amount_minor = excluded.expected_amount_minor,
      expected_currency = excluded.expected_currency,
      max_attempts = greatest(
        marketplace.reconciliations.max_attempts,
        excluded.max_attempts
      ),
      status = case
        when marketplace.reconciliations.status in (
          'running','matched','mismatch','review_required','resolved'
        ) then marketplace.reconciliations.status
        else 'queued'
      end,
      due_at = case
        when marketplace.reconciliations.status in (
          'running','matched','mismatch','review_required','resolved'
        ) then marketplace.reconciliations.due_at
        else least(marketplace.reconciliations.due_at,excluded.due_at)
      end,
      error_code = case
        when marketplace.reconciliations.status in (
          'running','matched','mismatch','review_required','resolved'
        ) then marketplace.reconciliations.error_code
        else excluded.error_code
      end,
      updated_at = now();

  return new;
end
$function$;

revoke all on function private_app.paymob_queue_quicklink_reconciliation_v1()
from public,anon,authenticated,service_role;

drop trigger if exists paymob_queue_quicklink_reconciliation_v1
on marketplace.payment_attempts;
create trigger paymob_queue_quicklink_reconciliation_v1
after insert or update of status,provider_order_id
on marketplace.payment_attempts
for each row
execute function private_app.paymob_queue_quicklink_reconciliation_v1();

-- Backfill only non-terminal links. The existing lease, binding, amount,
-- currency, account and HMAC controls remain the sole settlement authority.
insert into marketplace.reconciliations(
  tenant_id,
  order_id,
  attempt_id,
  provider_key,
  environment,
  reconciliation_type,
  status,
  provider_transaction_id,
  provider_order_id,
  expected_amount_minor,
  expected_currency,
  error_code,
  due_at,
  max_attempts
)
select
  attempt.tenant_id,
  attempt.order_id,
  attempt.id,
  'paymob',
  attempt.environment,
  'transaction_inquiry',
  'queued',
  attempt.provider_transaction_id,
  attempt.provider_order_id,
  attempt.amount_minor,
  attempt.currency,
  'scheduled_transaction_inquiry',
  now(),
  10
from marketplace.payment_attempts attempt
join marketplace.orders orders
  on orders.id = attempt.order_id
 and orders.tenant_id = attempt.tenant_id
where attempt.provider_key = 'paymob'
  and attempt.checkout_flow = 'quicklink'
  and attempt.status in ('intention_created','pending','unknown')
  and attempt.terminal_at is null
  and attempt.provider_order_id ~ '^[1-9][0-9]{0,29}$'
  and orders.status = 'pending_payment'
  and orders.payment_status in ('pending','failed')
on conflict (attempt_id,reconciliation_type) do update
set provider_transaction_id = coalesce(
      excluded.provider_transaction_id,
      marketplace.reconciliations.provider_transaction_id
    ),
    provider_order_id = coalesce(
      excluded.provider_order_id,
      marketplace.reconciliations.provider_order_id
    ),
    expected_amount_minor = excluded.expected_amount_minor,
    expected_currency = excluded.expected_currency,
    max_attempts = greatest(
      marketplace.reconciliations.max_attempts,
      excluded.max_attempts
    ),
    status = case
      when marketplace.reconciliations.status in (
        'running','matched','mismatch','review_required','resolved'
      ) then marketplace.reconciliations.status
      else 'queued'
    end,
    due_at = case
      when marketplace.reconciliations.status in (
        'running','matched','mismatch','review_required','resolved'
      ) then marketplace.reconciliations.due_at
      else least(marketplace.reconciliations.due_at,excluded.due_at)
    end,
    error_code = case
      when marketplace.reconciliations.status in (
        'running','matched','mismatch','review_required','resolved'
      ) then marketplace.reconciliations.error_code
      else excluded.error_code
    end,
    updated_at = now();

create or replace function private_app.paymob_reconcile_dispatch_v1()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_secret text;
  v_request_id bigint;
begin
  select decrypted.decrypted_secret into v_secret
  from vault.decrypted_secrets decrypted
  where decrypted.name = 'paymob_reconcile_dispatcher_v1';

  if v_secret !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_reconcile_dispatch_secret_unavailable';
  end if;

  select net.http_post(
    url := 'https://gswpbwdactcstkasddta.supabase.co/functions/v1/paymob-reconcile',
    body := jsonb_build_object('maxJobs',10),
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Accept','application/json',
      'x-odeir-paymob-reconcile-secret',v_secret
    ),
    timeout_milliseconds := 15000
  ) into v_request_id;

  return v_request_id;
end
$function$;

revoke all on function private_app.paymob_reconcile_dispatch_v1()
from public,anon,authenticated,service_role;

do $schedule$
begin
  if exists (
    select 1 from cron.job
    where jobname = 'odeir-paymob-reconcile-v1'
  ) then
    perform cron.unschedule('odeir-paymob-reconcile-v1');
  end if;

  perform cron.schedule(
    'odeir-paymob-reconcile-v1',
    '* * * * *',
    $job$select private_app.paymob_reconcile_dispatch_v1();$job$
  );
end
$schedule$;

-- Expose only a small, user-safe classification. Provider response text and
-- internal binding details never reach the browser.
create or replace function public.v1_tenant_paymob_checkout_status(
  p_slug text,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant core.tenants%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_order marketplace.orders%rowtype;
  v_terminal boolean;
  v_result_code text;
  v_retry_allowed boolean;
begin
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.tenant_id = v_tenant.id
    and attempt.provider_key = 'paymob';
  if v_attempt.id is null then raise exception 'paymob_attempt_not_found'; end if;

  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = v_attempt.order_id
    and orders.tenant_id = v_tenant.id;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;

  v_terminal := v_attempt.status in ('paid','failed','refunded','cancelled');
  v_result_code := case
    when v_order.payment_status = 'paid' then 'paid'
    when v_attempt.status = 'quarantined' then 'review_required'
    when v_attempt.last_error_code = 'payment_child_failed_inquiry_required'
      then 'issuer_declined_retry_available'
    when v_attempt.status = 'failed'
      and v_attempt.last_error_code in (
        'provider_intention_expired_no_payment',
        'checkout_expired_before_provider_call',
        'checkout_expired_requires_inquiry'
      ) then 'payment_expired'
    when v_attempt.status = 'failed' then 'payment_failed'
    when v_attempt.status = 'cancelled' then 'payment_cancelled'
    else null
  end;
  v_retry_allowed :=
    v_result_code = 'issuer_declined_retry_available'
    and v_order.status = 'pending_payment'
    and v_order.payment_status in ('pending','failed')
    and coalesce(v_attempt.provider_expires_at,v_attempt.expires_at) > now();

  return jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion',1,
    'attemptId',v_attempt.id,
    'orderId',v_order.id,
    'orderNumber',v_order.order_number,
    'orderKind',v_order.order_kind,
    'attemptStatus',v_attempt.status,
    'orderStatus',v_order.status,
    'paymentStatus',v_order.payment_status,
    'terminal',v_terminal,
    'resultCode',v_result_code,
    'retryAllowed',v_retry_allowed,
    'refreshAfterMs',case
      when v_terminal or v_result_code = 'issuer_declined_retry_available' then 0
      when v_attempt.status in ('unknown','quarantined') then 5000
      else 1500
    end
  ));
end
$function$;

revoke all on function public.v1_tenant_paymob_checkout_status(text,uuid)
from public,anon,service_role;
grant execute on function public.v1_tenant_paymob_checkout_status(text,uuid)
to authenticated;

comment on function private_app.paymob_reconcile_dispatch_v1() is
  'Queues one bounded, authenticated invocation of the Paymob read-only reconciliation worker.';
comment on function private_app.paymob_queue_quicklink_reconciliation_v1() is
  'Seeds read-only transaction inquiry after a QuickLink is durably recorded.';

commit;
