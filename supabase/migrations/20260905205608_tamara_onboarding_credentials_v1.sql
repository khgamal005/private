-- Credential onboarding only. Tamara's Bearer API token identifies the
-- merchant; a Webhook ID is the result of registering a receiver, not a
-- prerequisite to storing credentials. Keep receiver readiness independent.
-- No tenant rows, payment state, secrets or rollout settings are changed.
begin;

do $migration$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
begin
  select * into v_provider
  from marketplace.payment_provider_configs
  where provider_key = 'tamara'
  for update;

  if not found then
    raise exception 'tamara_provider_not_found';
  end if;
  if v_provider.status not in ('draft','configured','disabled')
     or v_provider.rollout_mode <> 'observe_only'
     or v_provider.required_secret_keys
       <> array['apiToken','notificationToken']::text[] then
    raise exception 'tamara_onboarding_contract_changed';
  end if;

  -- Reapplication is harmless. Unexpected contracts need a fresh review.
  if v_provider.required_public_config_keys = '{}'::text[] then
    return;
  end if;
  if v_provider.required_public_config_keys
     <> array['merchantId','webhookId']::text[] then
    raise exception 'tamara_onboarding_contract_changed';
  end if;

  update marketplace.payment_provider_configs
  set required_public_config_keys = '{}'::text[]
  where provider_key = 'tamara';

  insert into audit_log.events(action,resource_type,resource_id,context)
  values (
    'marketplace.tamara.onboarding_contract_updated_v1',
    'payment_provider',
    'tamara',
    jsonb_build_object(
      'previousRequiredPublicConfigKeys',
        to_jsonb(v_provider.required_public_config_keys),
      'requiredPublicConfigKeys','[]'::jsonb,
      'source','migration',
      'activationChanged',false,
      'tenantRowsChanged',0
    )
  );
end;
$migration$;

commit;
