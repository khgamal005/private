-- Optional manual Paymob reconciliation gateway for platform billing admins.
-- The production scheduler invokes the private database tick directly.
begin;

create or replace function public.v2_platform_paymob_reconcile_now(
  p_max_jobs integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private_app.has_platform_permission('platform.billing.manage') then
    raise exception 'forbidden';
  end if;
  if p_max_jobs is null or p_max_jobs not between 1 and 10 then
    raise exception 'paymob_reconciliation_tick_limit_invalid';
  end if;
  return private_app.paymob_reconciliation_tick_v2(p_max_jobs);
end
$function$;

revoke all on function public.v2_platform_paymob_reconcile_now(integer)
from public,anon,service_role;
grant execute on function public.v2_platform_paymob_reconcile_now(integer)
to authenticated;

comment on function public.v2_platform_paymob_reconcile_now(integer) is
  'Permission-gated manual trigger for the database-owned Paymob reconciliation tick. It never creates a payment or provider mutation.';

commit;
