-- Final Paymob Hosted Redirect runtime hardening.
--
-- The previous scheduler crossed an unnecessary database -> Edge Function hop.
-- That hop was observable but could fail authorization while pg_cron itself still
-- reported a successful SQL call. This migration keeps the same immutable payment
-- ledger and provider applicator, but runs the already-reviewed read-only inquiry
-- worker directly from pg_cron. QuickLink reconciliation now prefers Paymob's
-- documented order_id inquiry whenever the durable provider order id is known.
-- No browser amount, redirect flag, or unsigned callback can settle a payment.

begin;

do $preflight$
declare
  v_definition text;
begin
  if to_regprocedure('private_app.paymob_reconcile_inline_v1(integer)') is null
     or to_regprocedure('public.v1_service_paymob_reconciliation_claim(text,integer)') is null
     or to_regprocedure('public.v1_service_paymob_reconciliation_runtime(uuid,uuid,text)') is null
     or to_regprocedure('public.v1_service_paymob_reconciliation_apply(uuid,uuid,text,uuid,text,text,text,text,text,text,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,boolean,bigint,text,bigint,bigint,text)') is null
     or to_regprocedure('public.v1_service_paymob_cleanup_checkout_secrets(integer)') is null
     or to_regprocedure('private_app.marketplace_release_expired_promotions_v1(integer)') is null
     or to_regprocedure('private_app.paymob_outbox_enqueue(uuid,uuid,uuid,text,text,jsonb)') is null
     or to_regclass('marketplace.payment_attempts') is null
     or to_regclass('marketplace.reconciliations') is null
     or to_regclass('marketplace.payment_events') is null
     or to_regclass('marketplace.webhook_deliveries') is null
     or to_regclass('marketplace.orders') is null then
    raise exception 'paymob_final_runtime_prerequisite_missing';
  end if;

  v_definition := pg_get_functiondef(
    'private_app.paymob_reconcile_inline_v1(integer)'::regprocedure
  );
  if position('https://ksa.paymob.com/api/ecommerce/orders/transaction_inquiry' in v_definition) = 0
     or position("jsonb_build_object('merchant_order_id',v_attempt_id::text)" in v_definition) = 0
     or position('if v_inquiry_response.status = 404 then' in v_definition) = 0 then
    raise exception 'paymob_inline_reconciler_contract_drift';
  end if;
end
$preflight$;

create or replace function private_app.paymob_finalize_no_transaction_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_response_sha256 text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order_id uuid;
  v_job marketplace.reconciliations%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_order marketplace.orders%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role','') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_job_id is null
     or p_lease_token is null
     or coalesce(p_worker_id,'') !~ '^[A-Za-z0-9_-]{3,80}$'
     or coalesce(p_response_sha256,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'paymob_no_transaction_resolution_invalid';
  end if;

  select reconciliation.order_id into v_order_id
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
    and reconciliation.provider_key = 'paymob'
    and reconciliation.reconciliation_type = 'intention_unknown'
    and reconciliation.status = 'running'
    and reconciliation.lease_token = p_lease_token
    and reconciliation.lease_owner = p_worker_id
    and reconciliation.lease_expires_at > now();
  if v_order_id is null then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || v_order_id::text,0
  ));

  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = v_order_id
  for update;

  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.id = (
    select reconciliation.attempt_id
    from marketplace.reconciliations reconciliation
    where reconciliation.id = p_job_id
  )
    and attempt.order_id = v_order_id
  for update;

  select reconciliation.* into v_job
  from marketplace.reconciliations reconciliation
  where reconciliation.id = p_job_id
  for update;

  -- A 404 is accepted as authoritative absence only for the exact, already
  -- expired QuickLink order id. Any payment/webhook evidence, active sibling,
  -- mutable binding drift, or missing lease keeps the case fail-closed.
  if v_job.id is null
     or v_attempt.id is null
     or v_order.id is null
     or v_job.status <> 'running'
     or v_job.lease_token is distinct from p_lease_token
     or v_job.lease_owner is distinct from p_worker_id
     or v_job.lease_expires_at <= now()
     or v_job.reconciliation_type <> 'intention_unknown'
     or v_attempt.provider_key <> 'paymob'
     or v_attempt.checkout_flow <> 'quicklink'
     or v_attempt.status not in ('intention_created','pending','unknown')
     or coalesce(v_attempt.provider_order_id,'') !~ '^[1-9][0-9]{0,29}$'
     or v_attempt.provider_transaction_id is not null
     or v_job.provider_order_id is distinct from v_attempt.provider_order_id
     or coalesce(v_attempt.provider_expires_at,v_attempt.expires_at)
          + interval '30 minutes' > now()
     or v_order.status <> 'pending_payment'
     or v_order.payment_status not in ('pending','failed')
     or v_order.payment_provider <> 'paymob'
     or v_order.tenant_id <> v_attempt.tenant_id
     or v_order.total_minor <> v_attempt.amount_minor
     or v_order.currency <> v_attempt.currency
     or exists (
       select 1 from marketplace.payment_events event
       where event.order_id = v_order.id
     )
     or exists (
       select 1 from marketplace.webhook_deliveries delivery
       where delivery.order_id = v_order.id
     )
     or exists (
       select 1
       from marketplace.payment_attempts sibling
       where sibling.order_id = v_order.id
         and sibling.id <> v_attempt.id
         and sibling.status in (
           'prepared','creating_intention','intention_created',
           'pending','unknown','quarantined'
         )
         and greatest(
           sibling.expires_at,
           coalesce(sibling.provider_expires_at,sibling.expires_at)
         ) > now()
     ) then
    return false;
  end if;

  update marketplace.payment_attempts
  set status = 'failed',
      last_error_code = 'provider_intention_expired_no_payment',
      terminal_at = coalesce(terminal_at,now()),
      claim_token = null,
      claim_expires_at = null,
      updated_at = now()
  where id = v_attempt.id
    and status in ('intention_created','pending','unknown');

  update marketplace.orders
  set payment_status = 'failed',updated_at = now()
  where id = v_order.id
    and status = 'pending_payment'
    and payment_status in ('pending','failed')
    and payment_provider = 'paymob';

  update marketplace.reconciliations
  set status = 'matched',
      observed_state = 'provider_order_expired_no_transaction',
      evidence_sha256 = p_response_sha256,
      error_code = null,
      checked_at = now(),
      lease_token = null,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where id = v_job.id
    and status = 'running'
    and lease_token = p_lease_token
    and lease_owner = p_worker_id;

  insert into marketplace.order_events(
    order_id,tenant_id,event_type,from_status,to_status,metadata
  ) values (
    v_order.id,v_order.tenant_id,'paymob_payment_failed',
    v_order.status,v_order.status,
    jsonb_build_object(
      'attemptId',v_attempt.id,
      'reasonCode','provider_intention_expired_no_payment',
      'source','authenticated_order_id_inquiry',
      'providerOrderIdPresent',true
    )
  );

  perform private_app.paymob_outbox_enqueue(
    v_order.tenant_id,v_order.id,v_attempt.id,'payment_failed',
    'payment_failed:order_id_absence:' || v_job.id::text,
    jsonb_build_object(
      'jobId',v_job.id,
      'attemptId',v_attempt.id,
      'orderNumber',v_attempt.order_number_snapshot,
      'provider','paymob',
      'environment',v_attempt.environment,
      'errorCode','provider_intention_expired_no_payment'
    )
  );

  insert into audit_log.events(action,resource_type,resource_id,context)
  values (
    'marketplace.paymob.no_transaction_resolved_v1',
    'payment_attempt',v_attempt.id::text,
    jsonb_build_object(
      'orderId',v_order.id,
      'reconciliationId',v_job.id,
      'environment',v_attempt.environment,
      'source','authenticated_order_id_inquiry',
      'paymentAccepted',false
    )
  );
  return true;
end
$function$;

-- Patch the already-reviewed inline worker in place with three exact, drift-
-- guarded substitutions. This keeps the mature parser/applicator untouched.
do $patch$
declare
  v_definition text;
  v_before text;
  v_old text;
  v_new text;
begin
  v_definition := pg_get_functiondef(
    'private_app.paymob_reconcile_inline_v1(integer)'::regprocedure
  );
  if position('ODEIR_PAYMOB_ORDER_ID_RECOVERY_V1' in v_definition) > 0 then
    return;
  end if;

  v_old := $old$
      v_inquiry_mode := v_runtime ->> 'inquiryMode';
      if length(coalesce(v_api_key,'')) < 20
         or v_inquiry_mode not in ('transaction_id','merchant_order_id') then
        raise exception 'paymob_inline_runtime_invalid';
      end if;
$old$;
  v_new := $new$
      v_inquiry_mode := v_runtime ->> 'inquiryMode';
      -- ODEIR_PAYMOB_ORDER_ID_RECOVERY_V1: QuickLink persists Paymob's order id.
      -- Prefer the documented order_id inquiry while preserving the existing
      -- merchant_order_id binding passed to the immutable SQL applicator.
      select nullif(btrim(attempt.provider_order_id),'')
      into v_provider_order_id
      from marketplace.payment_attempts attempt
      where attempt.id = v_attempt_id;
      if length(coalesce(v_api_key,'')) < 20
         or v_inquiry_mode not in ('transaction_id','merchant_order_id') then
        raise exception 'paymob_inline_runtime_invalid';
      end if;
$new$;
  v_before := v_definition;
  v_definition := replace(v_definition,v_old,v_new);
  if v_definition = v_before then
    raise exception 'paymob_inline_runtime_patch_anchor_missing';
  end if;

  v_old := $old$
      else
        v_inquiry_response := extensions.http((
          'POST'::extensions.http_method,
          'https://ksa.paymob.com/api/ecommerce/orders/transaction_inquiry'::varchar,
          array[
            extensions.http_header('Accept','application/json'),
            extensions.http_header('Authorization','Bearer ' || v_auth_token)
          ]::extensions.http_header[],
          'application/json'::varchar,
          jsonb_build_object('merchant_order_id',v_attempt_id::text)::text::varchar
        )::extensions.http_request);
      end if;
$old$;
  v_new := $new$
      elsif v_provider_order_id ~ '^[1-9][0-9]{0,29}$' then
        v_inquiry_response := extensions.http((
          'POST'::extensions.http_method,
          'https://ksa.paymob.com/api/ecommerce/orders/transaction_inquiry'::varchar,
          array[
            extensions.http_header('Accept','application/json'),
            extensions.http_header('Authorization','Bearer ' || v_auth_token)
          ]::extensions.http_header[],
          'application/json'::varchar,
          jsonb_build_object('order_id',v_provider_order_id)::text::varchar
        )::extensions.http_request);
      else
        v_inquiry_response := extensions.http((
          'POST'::extensions.http_method,
          'https://ksa.paymob.com/api/ecommerce/orders/transaction_inquiry'::varchar,
          array[
            extensions.http_header('Accept','application/json'),
            extensions.http_header('Authorization','Bearer ' || v_auth_token)
          ]::extensions.http_header[],
          'application/json'::varchar,
          jsonb_build_object('merchant_order_id',v_attempt_id::text)::text::varchar
        )::extensions.http_request);
      end if;
$new$;
  v_before := v_definition;
  v_definition := replace(v_definition,v_old,v_new);
  if v_definition = v_before then
    raise exception 'paymob_inline_order_id_patch_anchor_missing';
  end if;

  v_old := $old$
      if v_inquiry_response.status = 404 then
        perform public.v1_service_paymob_reconciliation_reschedule(
          v_job_id,v_lease_token,v_worker_id,
          'retry','provider_merchant_reference_not_found'
        );
        v_rescheduled := v_rescheduled + 1;
        continue;
      end if;
$old$;
  v_new := $new$
      if v_inquiry_response.status = 404 then
        v_response_sha256 := encode(
          extensions.digest(
            convert_to(coalesce(v_inquiry_response.content,''),'UTF8'),
            'sha256'
          ),
          'hex'
        );
        if v_provider_order_id ~ '^[1-9][0-9]{0,29}$'
           and private_app.paymob_finalize_no_transaction_v1(
             v_job_id,v_lease_token,v_worker_id,v_response_sha256
           ) then
          v_processed := v_processed + 1;
          continue;
        end if;
        perform public.v1_service_paymob_reconciliation_reschedule(
          v_job_id,v_lease_token,v_worker_id,
          'retry','provider_order_reference_not_found'
        );
        v_rescheduled := v_rescheduled + 1;
        continue;
      end if;
$old$;
  v_before := v_definition;
  v_definition := replace(v_definition,v_old,v_new);
  if v_definition = v_before then
    raise exception 'paymob_inline_404_patch_anchor_missing';
  end if;

  execute v_definition;
end
$patch$;

create or replace function private_app.paymob_reconciliation_tick_v2(
  p_max_jobs integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reconcile jsonb;
  v_promotion_releases integer;
  v_secret_cleanup jsonb;
begin
  if p_max_jobs is null or p_max_jobs not between 1 and 10 then
    raise exception 'paymob_reconciliation_tick_limit_invalid';
  end if;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  v_reconcile := private_app.paymob_reconcile_inline_v1(p_max_jobs);
  v_promotion_releases := private_app.marketplace_release_expired_promotions_v1(200);
  v_secret_cleanup := public.v1_service_paymob_cleanup_checkout_secrets(100);
  return jsonb_build_object(
    'schemaVersion',2,
    'ok',true,
    'reconciliation',v_reconcile,
    'promotionReservationsReleased',v_promotion_releases,
    'checkoutSecretCleanup',v_secret_cleanup
  );
end
$function$;

revoke all on function private_app.paymob_finalize_no_transaction_v1(
  uuid,uuid,text,text
) from public,anon,authenticated,service_role;
revoke all on function private_app.paymob_reconciliation_tick_v2(integer)
  from public,anon,authenticated,service_role;

-- Requeue only expired QuickLink jobs that have a durable Paymob order id and
-- no payment, callback, or active-sibling evidence. The operation is read-only
-- against Paymob and cannot settle or activate an order by itself.
do $requeue$
declare
  v_requeued integer := 0;
begin
  update marketplace.reconciliations reconciliation
  set status = 'queued',
      attempt_count = 0,
      max_attempts = greatest(reconciliation.max_attempts,12),
      due_at = now(),
      error_code = 'order_id_recovery_queued',
      lease_token = null,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  from marketplace.payment_attempts attempt,
       marketplace.orders orders
  where reconciliation.attempt_id = attempt.id
    and reconciliation.order_id = orders.id
    and reconciliation.provider_key = 'paymob'
    and reconciliation.reconciliation_type = 'intention_unknown'
    and reconciliation.status in (
      'queued','unknown','failed','review_required'
    )
    and attempt.provider_key = 'paymob'
    and attempt.checkout_flow = 'quicklink'
    and attempt.status = 'unknown'
    and coalesce(attempt.provider_order_id,'') ~ '^[1-9][0-9]{0,29}$'
    and attempt.provider_transaction_id is null
    and coalesce(attempt.provider_expires_at,attempt.expires_at)
          + interval '30 minutes' <= now()
    and orders.status = 'pending_payment'
    and orders.payment_status in ('pending','failed')
    and orders.payment_provider = 'paymob'
    and not exists (
      select 1 from marketplace.payment_events event
      where event.order_id = orders.id
    )
    and not exists (
      select 1 from marketplace.webhook_deliveries delivery
      where delivery.order_id = orders.id
    )
    and not exists (
      select 1 from marketplace.payment_attempts sibling
      where sibling.order_id = orders.id
        and sibling.id <> attempt.id
        and sibling.status in (
          'prepared','creating_intention','intention_created',
          'pending','unknown','quarantined'
        )
        and greatest(
          sibling.expires_at,
          coalesce(sibling.provider_expires_at,sibling.expires_at)
        ) > now()
    );
  get diagnostics v_requeued = row_count;

  insert into audit_log.events(action,resource_type,resource_id,context)
  values (
    'marketplace.paymob.order_id_recovery_enabled_v1',
    'payment_provider','paymob',
    jsonb_build_object(
      'requeuedJobs',v_requeued,
      'providerMutation',false,
      'settlementChanged',false,
      'scheduler','database_owned'
    )
  );
end
$requeue$;

-- Replace the unreliable HTTP dispatcher with one database-owned minute tick.
-- The worker still calls only Paymob's fixed HTTPS hosts and the immutable SQL
-- applicator remains the sole component allowed to change financial state.
do $schedule$
declare
  v_job record;
begin
  if to_regnamespace('cron') is null then
    raise exception 'paymob_final_runtime_cron_unavailable';
  end if;
  for v_job in
    select jobid from cron.job
    where jobname in (
      'odeir-paymob-reconcile-v1',
      'odeir-paymob-runtime-v2'
    )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
  perform cron.schedule(
    'odeir-paymob-runtime-v2',
    '* * * * *',
    $cron$select private_app.paymob_reconciliation_tick_v2(10);$cron$
  );
end
$schedule$;

comment on function private_app.paymob_finalize_no_transaction_v1(
  uuid,uuid,text,text
) is
  'Closes an expired QuickLink attempt only after an authenticated Paymob order_id inquiry returns no transaction and every local evidence gate remains empty.';
comment on function private_app.paymob_reconciliation_tick_v2(integer) is
  'Database-owned bounded Paymob reconciliation, promotion reservation cleanup, and checkout-secret cleanup tick.';

commit;
