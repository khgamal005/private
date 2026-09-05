-- Applied migration version: 20260905214500
begin;

do $attestation$
begin
  if to_regprocedure(
       'public.v1_service_paymob_reconcile_dispatch_secret()'
     ) is null
     or to_regprocedure(
       'private_app.paymob_reconcile_dispatch_v1()'
     ) is null
     or to_regprocedure(
       'private_app.paymob_queue_quicklink_reconciliation_v1()'
     ) is null
     or to_regprocedure(
       'public.v1_tenant_paymob_checkout_status(text,uuid)'
     ) is null
     or not exists (
       select 1
       from pg_trigger trigger_row
       where trigger_row.tgrelid='marketplace.payment_attempts'::regclass
         and trigger_row.tgname='paymob_queue_quicklink_reconciliation_v1'
         and not trigger_row.tgisinternal
         and trigger_row.tgenabled <> 'D'
     )
     or not exists (
       select 1
       from cron.job job
       where job.jobname='odeir-paymob-reconcile-v1'
         and job.active
         and job.schedule='* * * * *'
     ) then
    raise exception 'paymob_decline_reconciliation_attestation_failed';
  end if;
end
$attestation$;

comment on function private_app.paymob_reconcile_dispatch_v1() is
  'Verified scheduled dispatcher for bounded, read-only Paymob transaction inquiry.';

commit;
