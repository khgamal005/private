begin;

create or replace function public.v2_tenant_marketplace_snapshot(p_slug text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_tenant core.tenants%rowtype;v_base jsonb;
begin
 select * into v_tenant from core.tenants where slug=p_slug limit 1;
 if v_tenant.id is null then raise exception 'tenant_not_found';end if;
 if not private_app.has_tenant_permission(v_tenant.id,'tenant.workspace.read') then raise exception 'forbidden';end if;
 v_base:=public.v1_tenant_marketplace_snapshot(p_slug);
 return v_base||jsonb_build_object(
  'schemaVersion',2,
  'summary',coalesce(v_base->'summary','{}'::jsonb)||jsonb_build_object(
   'addonProducts',(select count(*) from catalog.addon_products where status in('beta','active') and pricing_mode in('fixed','free') and(pricing_mode='free' or amount_minor>0)),
   'freeAddonProducts',(select count(*) from catalog.addon_products where status in('beta','active') and pricing_mode='free')
  ),
  'addons',coalesce((select jsonb_agg(jsonb_build_object(
   'id',product.id,'key',product.product_key,'featureKey',feature.feature_key,'categoryKey',product.marketplace_category,
   'name',product.name_ar,'description',product.description_ar,'pricingMode',product.pricing_mode,'amountMinor',product.amount_minor,
   'currency',product.currency,'interval',product.interval,'trialDays',product.trial_days,'badge',product.badge_ar,
   'activationMode',product.activation_mode,'entitlement',private_app.addon_entitlement(v_tenant.id,feature.feature_key)
  ) order by product.sort_order,product.product_key)
  from catalog.addon_products product join catalog.features feature on feature.id=product.feature_id
  where product.status in('beta','active') and product.pricing_mode in('fixed','free') and(product.pricing_mode='free' or product.amount_minor>0)),'[]'::jsonb),
  'paymentMethods',coalesce((select jsonb_agg(jsonb_build_object(
   'key',provider.provider_key,'name',provider.name_ar,'nameEn',provider.name_en,'checkoutMode',provider.checkout_mode,
   'supportedCurrencies',to_jsonb(provider.supported_currencies),'publicConfig',provider.public_config
  ) order by provider.sort_order,provider.provider_key)
  from marketplace.payment_provider_configs provider
  where provider.status='active' and provider.last_verified_at is not null and 'SAR'=any(provider.supported_currencies)),'[]'::jsonb),
  'bankTransferSubmissions',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'id',transfer.id,'orderId',transfer.order_id,'reference',transfer.transfer_reference,'senderName',transfer.sender_name,
   'transferDate',transfer.transfer_date,'amountMinor',transfer.amount_minor,'currency',transfer.currency,'status',transfer.status,
   'reviewNote',transfer.review_note,'reviewedAt',transfer.reviewed_at,'createdAt',transfer.created_at
  )) order by transfer.created_at desc) from marketplace.bank_transfer_submissions transfer where transfer.tenant_id=v_tenant.id),'[]'::jsonb)
 );
end;$$;
revoke all on function public.v2_tenant_marketplace_snapshot(text) from public,anon;
grant execute on function public.v2_tenant_marketplace_snapshot(text) to authenticated;

create or replace function public.v2_tenant_marketplace_action(p_slug text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_tenant core.tenants%rowtype;v_actor uuid;v_product catalog.addon_products%rowtype;v_feature catalog.features%rowtype;
 v_subscription catalog.tenant_addon_subscriptions%rowtype;v_price_id uuid;v_module_id uuid;v_result jsonb;
 v_order marketplace.orders%rowtype;v_provider_key text;v_reference text;v_sender_name text;v_transfer_date date;
 v_transfer marketplace.bank_transfer_submissions%rowtype;
begin
 select * into v_tenant from core.tenants where slug=p_slug limit 1;
 if v_tenant.id is null then raise exception 'tenant_not_found';end if;
 if not private_app.has_tenant_permission(v_tenant.id,'tenant.settings.manage') then raise exception 'forbidden';end if;
 v_actor:=private_app.current_subject_id();

 if p_action='activate_free_addon' then
  select * into v_product from catalog.addon_products product
  where product.product_key=lower(nullif(trim(p_payload->>'productKey'),'')) and product.status in('beta','active')
   and product.pricing_mode='free' and product.amount_minor=0 limit 1;
  if v_product.id is null then raise exception 'marketplace_product_not_found';end if;
  select * into v_feature from catalog.features feature where feature.id=v_product.feature_id limit 1;
  if v_feature.id is null then raise exception 'addon_feature_not_found';end if;
  if coalesce((private_app.addon_entitlement(v_tenant.id,v_feature.feature_key)->>'enabled')::boolean,false) then
   return jsonb_build_object('status','already_active','productKey',v_product.product_key,
    'entitlement',private_app.addon_entitlement(v_tenant.id,v_feature.feature_key));
  end if;
  select price.id into v_price_id from catalog.addon_price_versions price where price.product_id=v_product.id
   and price.pricing_mode='free' and price.valid_from<=current_date and(price.valid_to is null or price.valid_to>current_date)
   order by price.valid_from desc limit 1;
  insert into catalog.tenant_addon_subscriptions as current_subscription(
   tenant_id,product_id,status,source,period_start,period_end,requested_note,requested_by_subject_id,
   decided_by_subject_id,decision_note,price_version_id,auto_renew,activated_at
  )values(v_tenant.id,v_product.id,'active','tenant_request',now(),null,'free_addon_self_activation',v_actor,v_actor,
   'activated_free_addon',v_price_id,false,now())
  on conflict(tenant_id,product_id) where status in('pending','trialing','active','paused') do update set
   status='active',source='tenant_request',period_start=coalesce(current_subscription.period_start,now()),period_end=null,
   cancel_at_period_end=false,requested_by_subject_id=coalesce(v_actor,current_subscription.requested_by_subject_id),
   decided_by_subject_id=coalesce(v_actor,current_subscription.decided_by_subject_id),decision_note='activated_free_addon',
   price_version_id=coalesce(v_price_id,current_subscription.price_version_id),auto_renew=false,
   activated_at=coalesce(current_subscription.activated_at,now()),ended_at=null,updated_at=now()
  returning * into v_subscription;
  if v_product.activation_mode='module' then
   select module.id into v_module_id from core.modules module where v_feature.feature_key='module.'||module.module_key limit 1;
   if v_module_id is null then raise exception 'addon_module_not_found';end if;
   insert into core.tenant_modules(tenant_id,module_id,enabled,configuration,enabled_at,updated_at)
   values(v_tenant.id,v_module_id,true,jsonb_build_object('source','free_addon','productKey',v_product.product_key),now(),now())
   on conflict(tenant_id,module_id) do update set enabled=true,
    configuration=core.tenant_modules.configuration||excluded.configuration,
    enabled_at=coalesce(core.tenant_modules.enabled_at,now()),updated_at=now();
  end if;
  insert into catalog.tenant_addon_subscription_events(subscription_id,tenant_id,product_id,event_key,event_type,from_status,to_status,effective_at,actor_subject_id,metadata)
  values(v_subscription.id,v_tenant.id,v_product.id,'free_activation_'||v_subscription.id::text,'activated',null,'active',now(),v_actor,
   jsonb_build_object('productKey',v_product.product_key,'pricingMode','free'))
  on conflict(tenant_id,product_id,event_key) do nothing;
  perform private_app.write_audit('marketplace.addon.free_activated','addon_subscription',v_subscription.id::text,v_tenant.id,
   jsonb_build_object('productKey',v_product.product_key));
  return jsonb_build_object('status','active','productKey',v_product.product_key,'subscriptionId',v_subscription.id,
   'entitlement',private_app.addon_entitlement(v_tenant.id,v_feature.feature_key));
 end if;

 if p_action='create_order' then
  v_provider_key:=lower(coalesce(nullif(trim(p_payload->>'paymentProvider'),''),'bank_transfer'));
  if not exists(select 1 from marketplace.payment_provider_configs provider where provider.provider_key=v_provider_key
   and provider.status='active' and provider.last_verified_at is not null and 'SAR'=any(provider.supported_currencies)) then
   raise exception 'marketplace_payment_provider_unavailable';
  end if;
  v_result:=public.v1_tenant_marketplace_action(p_slug,p_action,p_payload-'paymentProvider');
  if nullif(v_result->>'id','') is not null then
   update marketplace.orders set payment_provider=v_provider_key,updated_at=now()
   where id=(v_result->>'id')::uuid and tenant_id=v_tenant.id and payment_status='pending' and status='pending_payment';
  end if;
  return v_result||jsonb_build_object('paymentProvider',v_provider_key,'paymentInstructions',(
   select provider.public_config from marketplace.payment_provider_configs provider where provider.provider_key=v_provider_key));
 end if;

 if p_action='submit_bank_transfer' then
  begin
   select * into v_order from marketplace.orders orders
   where orders.id=(p_payload->>'orderId')::uuid and orders.tenant_id=v_tenant.id for update;
  exception when invalid_text_representation then raise exception 'marketplace_order_not_found';end;
  if v_order.id is null then raise exception 'marketplace_order_not_found';end if;
  if v_order.status<>'pending_payment' or v_order.payment_status<>'pending' then raise exception 'marketplace_order_not_payable';end if;
  if coalesce(v_order.payment_provider,'bank_transfer')<>'bank_transfer' then raise exception 'marketplace_payment_provider_mismatch';end if;
  v_reference:=nullif(trim(p_payload->>'transferReference'),'');v_sender_name:=nullif(trim(p_payload->>'senderName'),'');
  if v_reference is null or length(v_reference) not between 3 and 160 then raise exception 'bank_transfer_reference_required';end if;
  if v_sender_name is null or length(v_sender_name) not between 2 and 160 then raise exception 'bank_transfer_sender_required';end if;
  begin v_transfer_date:=coalesce(nullif(p_payload->>'transferDate','')::date,current_date);
  exception when others then raise exception 'bank_transfer_date_invalid';end;
  if v_transfer_date>current_date+1 or v_transfer_date<current_date-60 then raise exception 'bank_transfer_date_invalid';end if;
  insert into marketplace.bank_transfer_submissions as current_transfer(
   order_id,tenant_id,submitted_by_subject_id,transfer_reference,sender_name,transfer_date,amount_minor,currency,status,
   review_note,reviewed_by_subject_id,reviewed_at
  )values(v_order.id,v_tenant.id,v_actor,v_reference,v_sender_name,v_transfer_date,v_order.total_minor,v_order.currency,'pending',null,null,null)
  on conflict(order_id) do update set submitted_by_subject_id=excluded.submitted_by_subject_id,
   transfer_reference=excluded.transfer_reference,sender_name=excluded.sender_name,transfer_date=excluded.transfer_date,
   amount_minor=excluded.amount_minor,currency=excluded.currency,
   status=case when current_transfer.status='approved' then 'approved' else 'pending' end,
   review_note=case when current_transfer.status='approved' then current_transfer.review_note else null end,
   reviewed_by_subject_id=case when current_transfer.status='approved' then current_transfer.reviewed_by_subject_id else null end,
   reviewed_at=case when current_transfer.status='approved' then current_transfer.reviewed_at else null end,updated_at=now()
  returning * into v_transfer;
  if v_transfer.status='approved' then raise exception 'bank_transfer_already_approved';end if;
  update marketplace.orders set payment_provider='bank_transfer',updated_at=now() where id=v_order.id;
  insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata)
  values(v_order.id,v_tenant.id,v_actor,'bank_transfer_submitted',v_order.status,v_order.status,
   jsonb_build_object('transferSubmissionId',v_transfer.id,'transferDate',v_transfer.transfer_date));
  insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
  values(v_tenant.id,v_actor,'marketplace.bank_transfer.submitted','marketplace_order',v_order.id::text,
   jsonb_build_object('orderNumber',v_order.order_number,'transferSubmissionId',v_transfer.id));
  return private_app.marketplace_order_payload(v_order.id)||jsonb_build_object('bankTransfer',jsonb_build_object(
   'id',v_transfer.id,'status',v_transfer.status,'reference',v_transfer.transfer_reference,'transferDate',v_transfer.transfer_date));
 end if;

 if p_action='cancel_order' then
  v_result:=public.v1_tenant_marketplace_action(p_slug,p_action,p_payload);
  begin
   update marketplace.bank_transfer_submissions set status='cancelled',updated_at=now()
   where order_id=(p_payload->>'orderId')::uuid and tenant_id=v_tenant.id and status in('pending','reviewing','rejected');
  exception when invalid_text_representation then null;end;
  return v_result;
 end if;
 raise exception 'marketplace_action_invalid';
end;$$;
revoke all on function public.v2_tenant_marketplace_action(text,text,jsonb) from public,anon;
grant execute on function public.v2_tenant_marketplace_action(text,text,jsonb) to authenticated;

commit;

