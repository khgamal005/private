-- Production pilot: ODEIR model center only. Fail-closed for all other tenants.
-- Rollback: disable/delete the rollout target and disable kill switches; the entitlement grant is non-authoritative.

do $pilot$
declare
  v_tenant_id uuid;
  v_product_id uuid;
  v_subscription_id uuid;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug='modaar-training-center'
    and tenant.status in ('trial','active');
  if v_tenant_id is null then raise exception 'model_tenant_not_found'; end if;

  if exists (
    select 1 from marketing_hub.connections connection
    where connection.tenant_id=v_tenant_id and connection.provider_key='meta'
  ) then raise exception 'model_tenant_has_legacy_meta_connection'; end if;

  select product.id into v_product_id
  from catalog.addon_products product
  where product.product_key='social_connect';
  if v_product_id is null then raise exception 'social_connect_product_not_found'; end if;

  select subscription.id into v_subscription_id
  from catalog.tenant_addon_subscriptions subscription
  where subscription.tenant_id=v_tenant_id
    and subscription.product_id=v_product_id
    and subscription.status in ('pending','trialing','active','paused')
  order by subscription.created_at desc
  limit 1;

  if v_subscription_id is null then
    insert into catalog.tenant_addon_subscriptions(
      tenant_id,product_id,status,source,decision_note,period_start,
      activated_at,auto_renew,period_is_authoritative
    ) values (
      v_tenant_id,v_product_id,'active','migration',
      'ODEIR model-center production pilot for read-only Meta ads reporting.',
      now(),now(),false,false
    ) returning id into v_subscription_id;
  end if;

  insert into catalog.tenant_addon_subscription_events(
    subscription_id,tenant_id,product_id,event_key,event_type,
    from_status,to_status,effective_at,metadata
  ) values (
    v_subscription_id,v_tenant_id,v_product_id,
    'social-connect-model-pilot-v1','migration_grant',
    null,'active',now(),jsonb_build_object(
      'scope','model_center_only','permissions',jsonb_build_array('ads_read'),
      'rollback','disable rollout target and kill switches'
    )
  ) on conflict(tenant_id,product_id,event_key) do nothing;

  insert into meta_connect_v2.rollout_targets(
    tenant_id,status,capabilities,approved_at
  ) values (
    v_tenant_id,'pilot',array[
      'oauth','asset_discovery','account_selection','sync',
      'deauthorization','data_deletion'
    ]::text[],now()
  ) on conflict(tenant_id) do update
  set status='pilot',capabilities=excluded.capabilities,
      approved_at=excluded.approved_at;

  update meta_connect_v2.kill_switches
  set enabled=true,changed_at=now()
  where capability in (
    'oauth','asset_discovery','account_selection','sync',
    'deauthorization','data_deletion'
  );
end;
$pilot$;

