-- Retire the superseded database -> Edge reconciliation dispatcher.
-- Production scheduling is now database-owned through
-- private_app.paymob_reconciliation_tick_v2(integer).

begin;

do $preflight$
declare
  v_active_runtime_jobs integer;
begin
  if to_regprocedure('private_app.paymob_reconciliation_tick_v2(integer)') is null
     or to_regprocedure('public.v2_platform_paymob_reconcile_now(integer)') is null then
    raise exception 'paymob_database_owned_runtime_missing';
  end if;

  select count(*) into v_active_runtime_jobs
  from cron.job
  where jobname = 'odeir-paymob-runtime-v2'
    and active
    and schedule = '* * * * *'
    and command = 'select private_app.paymob_reconciliation_tick_v2(10);';
  if v_active_runtime_jobs <> 1 then
    raise exception 'paymob_database_owned_scheduler_not_ready';
  end if;

  if exists (
    select 1 from cron.job
    where jobname = 'odeir-paymob-reconcile-v1'
  ) then
    raise exception 'paymob_legacy_scheduler_still_active';
  end if;
end
$preflight$;

drop function if exists private_app.paymob_reconcile_dispatch_v1();
drop function if exists public.v1_service_paymob_reconcile_dispatch_secret();

do $retire$
declare
  v_deleted integer := 0;
begin
  delete from vault.secrets
  where name = 'paymob_reconcile_dispatcher_v1';
  get diagnostics v_deleted = row_count;
  if v_deleted > 1 then
    raise exception 'paymob_dispatcher_secret_cardinality_invalid';
  end if;

  insert into audit_log.events(action,resource_type,resource_id,context)
  values (
    'marketplace.paymob.legacy_dispatcher_retired_v1',
    'payment_provider','paymob',
    jsonb_build_object(
      'scheduler','database_owned',
      'retiredFunctions',jsonb_build_array(
        'private_app.paymob_reconcile_dispatch_v1()',
        'public.v1_service_paymob_reconcile_dispatch_secret()'
      ),
      'dispatcherSecretsDeleted',v_deleted,
      'providerMutation',false,
      'paymentStateChanged',false
    )
  );
end
$retire$;

commit;
