-- Add-on platform v3 follow-up: atomically save provider config and secrets.

begin;

create or replace function public.v3_service_payment_provider_bundle_action(
  p_provider_key text,
  p_environment text,
  p_checkout_mode text,
  p_supported_currencies text[],
  p_enabled boolean,
  p_secrets jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_secret record;
  v_currencies text[];
  v_complete boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;

  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = p_provider_key
  for update;
  if v_provider.provider_key is null then
    raise exception 'payment_provider_not_found';
  end if;
  if p_environment not in ('sandbox', 'live') then
    raise exception 'invalid_payment_provider_environment';
  end if;
  if p_checkout_mode not in ('redirect', 'embedded', 'api') then
    raise exception 'invalid_payment_provider_checkout_mode';
  end if;
  if jsonb_typeof(coalesce(p_secrets, '{}'::jsonb)) <> 'object'
     or jsonb_object_length(coalesce(p_secrets, '{}'::jsonb)) > 20 then
    raise exception 'invalid_payment_provider_secrets';
  end if;

  select array_agg(currency order by currency)
  into v_currencies
  from (
    select distinct upper(trim(value)) as currency
    from unnest(coalesce(p_supported_currencies, '{}'::text[])) item(value)
    where nullif(trim(value), '') is not null
  ) normalized;
  if cardinality(v_currencies) not between 1 and 20
     or exists (
       select 1 from unnest(v_currencies) currency
       where currency !~ '^[A-Z]{3}$'
     ) then raise exception 'invalid_payment_provider_currencies'; end if;

  for v_secret in
    select item.key, item.value
    from jsonb_each(coalesce(p_secrets, '{}'::jsonb)) item
  loop
    if jsonb_typeof(v_secret.value) <> 'string'
       or length(v_secret.value #>> '{}') not between 1 and 8192 then
      raise exception 'invalid_payment_provider_secret';
    end if;
    perform public.v3_service_payment_provider_secret_action(
      'store',
      p_provider_key,
      v_secret.key,
      v_secret.value #>> '{}'
    );
  end loop;

  select not exists (
    select 1
    from unnest(v_provider.required_secret_keys) required(secret_key)
    where not exists (
      select 1
      from marketplace.payment_provider_secret_refs secret_ref
      where secret_ref.provider_key = p_provider_key
        and secret_ref.secret_key = required.secret_key
    )
  ) into v_complete;

  update marketplace.payment_provider_configs
  set environment = p_environment,
      checkout_mode = p_checkout_mode,
      supported_currencies = v_currencies,
      status = case
        when not coalesce(p_enabled, true) then 'disabled'
        when v_complete then 'configured'
        else 'draft'
      end,
      last_verified_at = null,
      last_error_code = null,
      updated_at = now()
  where provider_key = p_provider_key
  returning * into v_provider;

  insert into audit_log.events (
    action, resource_type, resource_id, context
  ) values (
    'marketplace.payment_provider.bundle_saved',
    'payment_provider',
    p_provider_key,
    jsonb_build_object(
      'environment', v_provider.environment,
      'checkoutMode', v_provider.checkout_mode,
      'status', v_provider.status,
      'configured', v_complete,
      'secretKeysSubmitted', coalesce(
        (select jsonb_agg(item.key order by item.key)
         from jsonb_each(coalesce(p_secrets, '{}'::jsonb)) item),
        '[]'::jsonb
      ),
      'secretReturned', false
    )
  );

  return jsonb_build_object(
    'providerKey', v_provider.provider_key,
    'status', v_provider.status,
    'environment', v_provider.environment,
    'configured', v_complete,
    'secretReturned', false
  );
end;
$$;

revoke all on function public.v3_service_payment_provider_bundle_action(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb
) from public, anon, authenticated;
grant execute on function public.v3_service_payment_provider_bundle_action(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb
) to service_role;

comment on function public.v3_service_payment_provider_bundle_action(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb
) is
  'Service-only atomic provider configuration. Secret values go directly to Vault and are never returned.';

commit;
