CREATE OR REPLACE FUNCTION private_app.paymob_order_payment_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_expected_order text;
  v_sensitive_transition boolean;
  v_has_paymob_attempt boolean := false;
begin
  if tg_op = 'UPDATE' then
    select exists (
      select 1
      from marketplace.payment_attempts attempt
      where attempt.order_id = old.id
        and attempt.tenant_id = old.tenant_id
        and attempt.provider_key = 'paymob'
    ) into v_has_paymob_attempt;
  end if;
  if tg_op = 'UPDATE'
     and new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and exists (
       select 1
       from marketplace.payment_attempts attempt
       where attempt.order_id = old.id
         and attempt.tenant_id = old.tenant_id
         and attempt.provider_key = 'paymob'
         and attempt.status in (
           'prepared','creating_intention','intention_created','pending',
           'unknown','quarantined','paid'
         )
     ) then
    raise exception 'paymob_order_cancel_requires_payment_resolution';
  end if;

  if tg_op = 'UPDATE'
     and v_has_paymob_attempt
     and old.payment_provider = 'paymob'
     and new.payment_provider is distinct from 'paymob'
     and current_setting('odeir.paymob_verified_order_id', true)
       is distinct from new.id::text then
    raise exception 'paymob_payment_provider_change_requires_governed_path';
  end if;

  v_sensitive_transition :=
    (
      new.payment_provider = 'paymob'
      or (tg_op = 'UPDATE' and old.payment_provider = 'paymob')
      or v_has_paymob_attempt
    )
    and new.payment_status in ('paid','refunded')
    and (
      tg_op = 'INSERT'
      or old.payment_provider is distinct from new.payment_provider
      or old.payment_status is distinct from new.payment_status
    );

  if v_sensitive_transition then
    v_expected_order := current_setting(
      'odeir.paymob_verified_order_id',
      true
    );
    if v_expected_order is distinct from new.id::text then
      raise exception 'paymob_verified_receipt_required';
    end if;
  end if;

  return new;
end;
$function$;
create trigger paymob_order_guard before insert or update on marketplace.orders for each row execute function private_app.paymob_order_payment_guard_v1();
