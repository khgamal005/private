CREATE OR REPLACE FUNCTION public.v1_tenant_marketplace_replace_payment(p_slug text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t core.tenants%rowtype; o marketplace.orders%rowtype; i marketplace.order_items%rowtype;
 b marketplace.service_order_briefs%rowtype; r jsonb; target text; next_id uuid; payload jsonb;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 target:=p_payload->>'paymentProvider';
 if target not in ('bank_transfer','tamara','paymob') or target is null then raise exception 'marketplace_payment_provider_unavailable'; end if;
 select * into o from marketplace.orders where id=(p_payload->>'orderId')::uuid and tenant_id=t.id;
 select * into i from marketplace.order_items where order_id=o.id limit 1;
 if o.id is null or i.id is null then raise exception 'marketplace_order_not_found'; end if;
 if o.order_kind='service' then
  perform pg_advisory_xact_lock(hashtextextended(t.id::text||':service:idempotency:replacement_'||o.id::text||'_'||target,0));
  perform pg_advisory_xact_lock(hashtextextended(t.id::text||':service:product:'||i.product_key,0));
 else
  perform pg_advisory_xact_lock(hashtextextended(t.id::text||':addon:'||i.product_key,0));
 end if;
 perform pg_advisory_xact_lock(hashtextextended('paymob:order:'||(p_payload->>'orderId')::uuid::text,0));
 perform 1 from marketplace.tamara_attempts where order_id=o.id and tenant_id=t.id for update nowait;
 select * into o from marketplace.orders where id=(p_payload->>'orderId')::uuid and tenant_id=t.id for update nowait;
 if o.id is null or o.payment_provider not in ('paymob','tamara','bank_transfer') then raise exception 'marketplace_order_not_found'; end if;
 select (metadata->>'replacementOrderId')::uuid into next_id from marketplace.order_events
 where order_id=o.id and tenant_id=t.id and event_type='payment_order_replaced' limit 1;
 if next_id is not null then
  if not exists(select 1 from marketplace.orders where id=next_id and tenant_id=t.id and payment_provider=target) then raise exception 'marketplace_payment_provider_mismatch'; end if;
  return private_app.marketplace_order_payload(next_id)||jsonb_build_object('paymentProvider',target,'duplicate',true);
 end if;
 if o.status not in ('pending_payment','cancelled') or o.payment_status not in ('pending','failed') then raise exception 'marketplace_order_not_payable'; end if;
 if exists(select 1 from marketplace.payment_attempts a where a.order_id=o.id and
   (a.status<>'failed' or a.last_error_code is distinct from 'provider_intention_expired_no_payment'
    or coalesce(a.provider_expires_at,a.expires_at) is null or coalesce(a.provider_expires_at,a.expires_at)>now()))
   or exists(select 1 from marketplace.payment_events e where e.order_id=o.id and e.state in ('paid','refunded'))
   or exists(select 1 from marketplace.bank_transfer_submissions x where x.order_id=o.id and x.status in ('pending','reviewing','approved'))
 then raise exception 'payment_replacement_requires_resolution'; end if;
 if (select count(*) from marketplace.order_items where order_id=o.id)<>1 then raise exception 'marketplace_product_invalid'; end if;
 select * into i from marketplace.order_items where order_id=o.id;
 payload:=jsonb_build_object('productKey',i.product_key,'quantity',i.quantity,'itemType',o.order_kind,
  'paymentProvider',target,'notes',o.notes,'idempotencyKey','replacement_'||o.id::text||'_'||target,'promotionCode',o.promotion_code,'billingInterval',coalesce(i.metadata->>'billingInterval','year'));
 if o.payment_provider='tamara' then
  perform public.v1_tenant_marketplace_cancel_unpaid_order(p_slug,jsonb_build_object('orderId',o.id));
 else
  update marketplace.orders set status='cancelled',updated_at=now() where id=o.id;
  update marketplace.service_order_assignments set status='cancelled' where order_id=o.id and tenant_id=t.id and status='pending';
 end if;
 if o.order_kind='service' then
  select * into b from marketplace.service_order_briefs where order_id=o.id and tenant_id=t.id;
  payload:=payload||jsonb_build_object('packageId',i.service_package_id,'brief',coalesce(b.brief,'{}'::jsonb),'preferredStartDate',b.preferred_start_date,'deliveryMode',b.delivery_mode);
  if target='tamara' then r:=public.v1_tenant_tamara_service_create(p_slug,payload);
  elsif o.promotion_code is not null then r:=public.v1_tenant_service_marketplace_create_order_with_promotion(p_slug,payload);
  else r:=public.v2_tenant_service_marketplace_action(p_slug,'create_service_order',payload); end if;
 else
  if target='tamara' then r:=public.v1_tenant_tamara_create_order(p_slug,payload);
  elsif o.promotion_code is not null then r:=public.v1_tenant_marketplace_create_order_with_promotion(p_slug,payload);
  else r:=public.v2_tenant_marketplace_action(p_slug,'create_order',payload); end if;
 end if;
 next_id:=coalesce(r->>'id',r->>'orderId')::uuid;
 if next_id is null or next_id=o.id or coalesce((r->>'duplicate')::boolean,false)
   or not exists(select 1 from marketplace.orders n where n.id=next_id and n.tenant_id=t.id and n.payment_provider=target and n.total_minor=o.total_minor)
 then raise exception 'payment_replacement_price_changed'; end if;
 insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata)
 values(o.id,t.id,private_app.current_subject_id(),'payment_order_replaced',o.status,'cancelled',jsonb_build_object('replacementOrderId',next_id,'paymentProvider',target));
 insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
 values(t.id,private_app.current_subject_id(),'marketplace.payment_replaced','marketplace_order',o.id::text,jsonb_build_object('replacementOrderId',next_id,'paymentProvider',target));
 return r;
exception when lock_not_available then raise exception 'payment_order_busy';
end $function$
;
CREATE OR REPLACE FUNCTION public.v1_tenant_paymob_prepare_checkout(p_slug text, p_order_id uuid, p_idempotency_key text, p_billing_contact jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_order marketplace.orders%rowtype;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_credential_version marketplace.paymob_credential_versions%rowtype;
  v_attempt marketplace.payment_attempts%rowtype;
  v_active_attempt marketplace.payment_attempts%rowtype;
  v_actor uuid;
  v_billing jsonb;
  v_items jsonb;
  v_settlement_snapshot jsonb;
  v_billing_hash text;
  v_items_hash text;
  v_idempotency_key text;
  v_now timestamptz := now();
  v_create_allowed boolean := false;
begin
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();
  if v_actor is null then raise exception 'tenant_subject_not_found'; end if;

  v_idempotency_key := nullif(btrim(p_idempotency_key), '');
  if v_idempotency_key is null
     or v_idempotency_key !~ '^[A-Za-z0-9_-]{16,120}$' then
    raise exception 'paymob_idempotency_required';
  end if;

  if jsonb_typeof(coalesce(p_billing_contact, '{}'::jsonb)) <> 'object'
     or (select pg_catalog.count(*)
       from pg_catalog.jsonb_object_keys(
         coalesce(p_billing_contact, '{}'::jsonb)
       ) as billing_contact_key) > 4
     or exists (
       select 1
       from jsonb_object_keys(coalesce(p_billing_contact, '{}'::jsonb)) key_name
       where key_name not in ('firstName','lastName','email','phoneNumber')
     ) then
    raise exception 'paymob_billing_contact_invalid';
  end if;

  v_billing := jsonb_build_object(
    'firstName', btrim(coalesce(p_billing_contact ->> 'firstName', '')),
    'lastName', btrim(coalesce(p_billing_contact ->> 'lastName', '')),
    'email', lower(btrim(coalesce(p_billing_contact ->> 'email', ''))),
    'phoneNumber', btrim(coalesce(p_billing_contact ->> 'phoneNumber', ''))
  );
  if length(v_billing ->> 'firstName') not between 1 and 100
     or length(v_billing ->> 'lastName') not between 1 and 100
     or length(v_billing ->> 'email') not between 3 and 254
     or v_billing ->> 'email' !~
       '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or length(v_billing ->> 'phoneNumber') not between 7 and 30
     or v_billing ->> 'phoneNumber' !~ '^[+0-9][0-9 +()_-]{6,29}$' then
    raise exception 'paymob_billing_contact_invalid';
  end if;
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for share;
  if v_provider.provider_key is null
     or v_provider.checkout_mode <> 'redirect'
     or v_provider.public_config ->> 'region' <> 'ksa'
     or v_provider.public_config ->> 'merchantAccountId'
       !~ '^[1-9][0-9]{0,29}$'
     or v_provider.public_config ->> 'integrationId'
       !~ '^[1-9][0-9]{0,29}$'
     or not private_app.v3_payment_provider_bundle_complete(
       v_provider.provider_key,
       v_provider.environment,
       v_provider.credentials_environment,
       v_provider.required_secret_keys,
       v_provider.required_public_config_keys,
       v_provider.public_config
     ) then
    raise exception 'paymob_provider_unavailable';
  end if;
  if not (
    (
      v_provider.rollout_mode = 'sandbox'
      and v_provider.environment = 'sandbox'
      and v_provider.status = 'configured'
      and v_provider.last_verified_at is not null
    )
    or (
      v_provider.rollout_mode = 'live'
      and v_provider.environment = 'live'
      and v_provider.status = 'active'
      and v_provider.last_verified_at is not null
    )
    or private_app.paymob_live_canary_eligible_v1(
      v_tenant.id,v_provider.environment
    )
  ) then
    raise exception 'paymob_rollout_not_enabled';
  end if;
  if not private_app.paymob_live_canary_eligible_v1(
       v_tenant.id,v_provider.environment
     )
     and cardinality(private_app.paymob_missing_checks(
       v_provider.readiness_evidence,
       case when v_provider.environment = 'live' then 'live' else 'sandbox' end
     )) <> 0 then
    raise exception 'paymob_readiness_evidence_stale';
  end if;
  select version.* into v_credential_version
  from marketplace.paymob_credential_versions version
  where version.provider_key = 'paymob'
    and version.status = 'active'
    and version.environment = v_provider.environment
    and version.integration_id = v_provider.public_config ->> 'integrationId'
    and version.owner_id = v_provider.public_config ->> 'merchantAccountId'
  for share;
  if v_credential_version.id is null then
    raise exception 'paymob_active_credential_version_required';
  end if;
  v_billing_hash := private_app.paymob_billing_contact_digest_v1(
    v_billing,v_credential_version.id
  );
  if not exists (
    select 1
    from marketplace.payment_tenant_rollouts rollout
    where rollout.tenant_id = v_tenant.id
      and rollout.provider_key = 'paymob'
      and rollout.environment = v_provider.environment
      and rollout.status = 'enabled'
  ) then
    raise exception 'paymob_tenant_not_enabled';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:order:' || p_order_id::text,0
  ));
  select orders.* into v_order
  from marketplace.orders orders
  where orders.id = p_order_id
    and orders.tenant_id = v_tenant.id
  for update;
  if v_order.id is null then raise exception 'marketplace_order_not_found'; end if;
  if private_app.paymob_order_review_hold_v1(v_order.id) then
    raise exception 'paymob_order_payment_review_hold';
  end if;
  if v_order.status <> 'pending_payment'
     or v_order.payment_status not in ('pending','failed')
     or v_order.total_minor <= 0
     or v_order.total_minor > 100000000000
     or v_order.currency <> any(v_provider.supported_currencies) then
    raise exception 'marketplace_order_not_payable';
  end if;
  if v_order.payment_provider is not null
     and v_order.payment_provider not in ('paymob','bank_transfer') then
    raise exception 'marketplace_payment_provider_mismatch';
  end if;
  if v_order.payment_provider = 'bank_transfer' and exists (
    select 1
    from marketplace.bank_transfer_submissions transfer
    where transfer.order_id = v_order.id
      and transfer.tenant_id = v_tenant.id
      and transfer.status in ('pending','reviewing','approved')
  ) then
    raise exception 'marketplace_payment_provider_mismatch';
  end if;

  -- Lock every commercial row that feeds the provider items and the eventual
  -- fulfillment snapshot.  Both representations are then materialized from
  -- the same locked values, so a same-total catalog/order edit cannot swap
  -- the product, package, feature, interval, or activation mode mid-checkout.
  perform item.id
  from marketplace.order_items item
  where item.order_id = v_order.id
  order by item.id
  for share;
  perform product.id
  from catalog.addon_products product
  where product.id in (
    select item.addon_product_id
    from marketplace.order_items item
    where item.order_id = v_order.id
      and item.addon_product_id is not null
  )
  order by product.id
  for share;
  perform feature.id
  from catalog.features feature
  where feature.id in (
    select product.feature_id
    from catalog.addon_products product
    join marketplace.order_items item
      on item.addon_product_id = product.id
    where item.order_id = v_order.id
  )
  order by feature.id
  for share;
  perform product.id
  from marketplace.service_products product
  where product.id in (
    select item.service_product_id
    from marketplace.order_items item
    where item.order_id = v_order.id
      and item.service_product_id is not null
  )
  order by product.id
  for share;
  perform package.id
  from marketplace.service_packages package
  where package.id in (
    select item.service_package_id
    from marketplace.order_items item
    where item.order_id = v_order.id
      and item.service_package_id is not null
  )
  order by package.id
  for share;

  if not exists (
    select 1 from marketplace.order_items item
    where item.order_id = v_order.id
  )
     or exists (
       select 1 from marketplace.order_items item
       where item.order_id = v_order.id
         and item.item_type <> v_order.order_kind
     ) then
    raise exception 'marketplace_order_items_invalid';
  end if;
  if v_order.order_kind = 'addon' and exists (
    select 1 from marketplace.order_items item
    where item.order_id = v_order.id
      and item.quantity <> 1
  ) then
    raise exception 'paymob_addon_quantity_must_equal_one';
  end if;

  -- A `from` or `quote` service is never charged at its teaser/catalog amount.
  -- It needs an explicit, currently active package whose fixed commercial
  -- amount and currency exactly match the immutable order item snapshot.
  if v_order.order_kind = 'service' and exists (
    select 1
    from marketplace.order_items item
    join marketplace.service_products product
      on product.id = item.service_product_id
    left join marketplace.service_packages package
      on package.id = item.service_package_id
    where item.order_id = v_order.id
      and product.pricing_mode in ('from','quote')
      and (
        package.id is null
        or package.status <> 'active'
        or package.service_product_id <> product.id
        or package.amount_minor <> item.unit_amount_minor
        or package.currency <> v_order.currency
      )
  ) then
    raise exception 'paymob_service_fixed_package_required';
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'orderItemId',item.id,
    'itemType',item.item_type,
    'productKey',item.product_key,
    'productName',left(item.product_name_ar,160),
    'addonProductId',item.addon_product_id,
    'featureId',addon.feature_id,
    'activationMode',addon.activation_mode,
    'serviceProductId',item.service_product_id,
    'servicePackageId',item.service_package_id,
    'pricingMode',case when item.item_type = 'addon'
      then addon.pricing_mode else service.pricing_mode end,
    'billingInterval',case when item.item_type = 'addon'
      then coalesce(item.metadata->>'billingInterval',addon.interval) else null end,
    'quantity',item.quantity,
    'unitAmountMinor',item.unit_amount_minor,
    'lineTotalMinor',item.line_total_minor,
    'currency',v_order.currency
  )) order by item.created_at,item.id), '[]'::jsonb)
  into v_settlement_snapshot
  from marketplace.order_items item
  left join catalog.addon_products addon
    on addon.id = item.addon_product_id
  left join marketplace.service_products service
    on service.id = item.service_product_id
  where item.order_id = v_order.id;

  select coalesce(jsonb_agg(line.provider_item order by line.sort_order),'[]'::jsonb)
  into v_items
  from (
    select entry.ordinality::bigint as sort_order,
      jsonb_build_object(
        'name',entry.value ->> 'productName',
        -- Paymob Intention items use a line total. Quantity is descriptive
        -- metadata and must not be multiplied again by the provider.
        'amount',(entry.value ->> 'lineTotalMinor')::bigint,
        'description',left(entry.value ->> 'productKey',160),
        'quantity',(entry.value ->> 'quantity')::integer
      ) as provider_item
    from jsonb_array_elements(v_settlement_snapshot)
      with ordinality entry(value,ordinality)
    union all
    select 9223372036854775807::bigint,
      jsonb_build_object(
        'name','ضريبة القيمة المضافة',
        'amount',v_order.tax_minor,
        'description','VAT',
        'quantity',1
      )
    where v_order.tax_minor > 0

  ) line;
  -- ODEIR_PROMOTION_NET_PROVIDER_ITEMS_V1
  if v_order.discount_minor > 0 then
    v_items := jsonb_build_array(jsonb_build_object(
      'name','قيمة الطلب بعد الخصم',
      'amount',v_order.subtotal_minor,
      'description','ODEIR_PROMOTION_NET_SUBTOTAL',
      'quantity',1
    ));
    if v_order.tax_minor > 0 then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'name','ضريبة القيمة المضافة',
        'amount',v_order.tax_minor,
        'description','VAT',
        'quantity',1
      ));
    end if;
  end if;
  if jsonb_array_length(v_items) = 0
     or (
       select coalesce(sum((entry ->> 'amount')::bigint), 0)
       from jsonb_array_elements(v_items) entry
     ) <> v_order.total_minor then
    raise exception 'paymob_item_amount_mismatch';
  end if;
  v_items_hash := encode(extensions.digest(
    convert_to(jsonb_build_object(
      'orderItems',v_settlement_snapshot,
      'subtotalMinor',v_order.subtotal_minor,
      'taxMinor',v_order.tax_minor,
      'taxRateBps',v_order.tax_rate_bps,
      'totalMinor',v_order.total_minor,
      'currency',v_order.currency
    )::text, 'utf8'),
    'sha256'
  ), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'paymob:prepare:' || v_provider.environment || ':' || v_order.id::text,
    0
  ));

  select attempt.* into v_active_attempt
  from marketplace.payment_attempts attempt
  where attempt.provider_key = 'paymob'
    and attempt.environment = v_provider.environment
    and attempt.order_id = v_order.id
    and attempt.status = 'prepared'
    and attempt.expires_at <= v_now
    and attempt.claim_token is null
    and attempt.provider_intention_id is null
    and attempt.provider_order_id is null
    and attempt.provider_transaction_id is null
  order by attempt.created_at desc
  limit 1
  for update;
  if v_active_attempt.id is not null then
    update marketplace.payment_attempts
    set status = 'failed',
        last_error_code = 'checkout_expired_before_provider_call',
        terminal_at = v_now,
        updated_at = v_now
    where id = v_active_attempt.id;
    perform private_app.paymob_outbox_enqueue(
      v_active_attempt.tenant_id,
      v_active_attempt.order_id,
      v_active_attempt.id,
      'payment_failed',
      'payment_failed:prepared_expired:' || v_active_attempt.id::text,
      jsonb_build_object(
        'attemptId', v_active_attempt.id,
        'provider', 'paymob',
        'environment', v_active_attempt.environment,
        'errorCode', 'checkout_expired_before_provider_call',
        'providerCallStarted', false
      )
    );
  end if;

  select attempt.* into v_attempt
  from marketplace.payment_attempts attempt
  where attempt.provider_key = 'paymob'
    and attempt.environment = v_provider.environment
    and attempt.tenant_id = v_tenant.id
    and attempt.idempotency_key = v_idempotency_key
  for update;
  if v_attempt.id is not null then
    v_billing_hash := private_app.paymob_billing_contact_digest_v1(
      v_billing,v_attempt.credential_version_id
    );
    if v_attempt.order_id <> v_order.id
       or v_attempt.amount_minor <> v_order.total_minor
       or v_attempt.currency <> v_order.currency
       or v_attempt.items_snapshot_sha256 <> v_items_hash then
      raise exception 'paymob_idempotency_conflict';
    end if;
    if v_attempt.status = 'prepared'
       and v_attempt.billing_contact_sha256 <> v_billing_hash then
      raise exception 'paymob_billing_contact_changed';
    end if;
    v_create_allowed :=
      v_attempt.status = 'prepared' and v_attempt.expires_at > v_now;
    return jsonb_build_object(
      'schemaVersion', 1,
      'createAllowed', v_create_allowed,
      'attemptId', v_attempt.id,
      'attemptStatus', v_attempt.status,
      'expiresAt', v_attempt.expires_at,
      'billingDataValidated', v_create_allowed,
      'order', jsonb_build_object(
        'id', v_order.id,
        'number', v_order.order_number,
        'kind', v_order.order_kind,
        'status', v_order.status,
        'paymentStatus', v_order.payment_status,
        'amountMinor', v_order.total_minor,
        'currency', v_order.currency
      ),
      'provider', jsonb_build_object(
        'key', 'paymob',
        'region', 'ksa',
        'environment', v_provider.environment,
        'checkoutMode', v_provider.checkout_mode
      ),
      'items', v_items
    );
  end if;

  select attempt.* into v_active_attempt
  from marketplace.payment_attempts attempt
  where attempt.provider_key = 'paymob'
    and attempt.environment = v_provider.environment
    and attempt.order_id = v_order.id
    and attempt.status in (
      'prepared','creating_intention','intention_created',
      'pending','unknown','quarantined'
    )
  order by attempt.created_at desc
  limit 1
  for update;
  if v_active_attempt.id is not null then
    return jsonb_build_object(
      'schemaVersion', 1,
      'createAllowed', false,
      'attemptId', v_active_attempt.id,
      'attemptStatus', v_active_attempt.status,
      'expiresAt', v_active_attempt.expires_at,
      'billingDataValidated', false,
      'order', jsonb_build_object(
        'id', v_order.id,
        'number', v_order.order_number,
        'kind', v_order.order_kind,
        'status', v_order.status,
        'paymentStatus', v_order.payment_status,
        'amountMinor', v_order.total_minor,
        'currency', v_order.currency
      ),
      'provider', jsonb_build_object(
        'key', 'paymob',
        'region', 'ksa',
        'environment', v_provider.environment,
        'checkoutMode', v_provider.checkout_mode
      ),
      'items', v_items
    );
  end if;

  v_attempt.id := gen_random_uuid();
  insert into marketplace.payment_attempts(
    id,
    tenant_id,
    order_id,
    requested_by_subject_id,
    provider_key,
    environment,
    credential_version_id,
    idempotency_key,
    special_reference,
    status,
    order_number_snapshot,
    order_kind_snapshot,
    subtotal_minor,
    tax_minor,
    tax_rate_bps,
    amount_minor,
    currency,
    billing_contact_sha256,
    items_snapshot_sha256,
    prepared_at,
    expires_at,
    created_at,
    updated_at
  ) values (
    v_attempt.id,
    v_tenant.id,
    v_order.id,
    v_actor,
    'paymob',
    v_provider.environment,
    v_credential_version.id,
    v_idempotency_key,
    v_attempt.id::text,
    'prepared',
    v_order.order_number,
    v_order.order_kind,
    v_order.subtotal_minor,
    v_order.tax_minor,
    v_order.tax_rate_bps,
    v_order.total_minor,
    v_order.currency,
    v_billing_hash,
    v_items_hash,
    v_now,
    v_now + interval '1 hour',
    v_now,
    v_now
  ) returning * into v_attempt;

  insert into marketplace.payment_attempt_items(
    tenant_id,
    attempt_id,
    order_id,
    order_item_id,
    item_type,
    product_key,
    addon_product_id,
    feature_id,
    activation_mode_snapshot,
    service_product_id,
    service_package_id,
    pricing_mode_snapshot,
    billing_interval_snapshot,
    quantity,
    unit_amount_minor,
    line_total_minor,
    currency
  )
  select
    v_tenant.id,
    v_attempt.id,
    v_order.id,
    (entry.value ->> 'orderItemId')::uuid,
    entry.value ->> 'itemType',
    entry.value ->> 'productKey',
    nullif(entry.value ->> 'addonProductId','')::uuid,
    nullif(entry.value ->> 'featureId','')::uuid,
    entry.value ->> 'activationMode',
    nullif(entry.value ->> 'serviceProductId','')::uuid,
    nullif(entry.value ->> 'servicePackageId','')::uuid,
    entry.value ->> 'pricingMode',
    entry.value ->> 'billingInterval',
    (entry.value ->> 'quantity')::integer,
    (entry.value ->> 'unitAmountMinor')::bigint,
    (entry.value ->> 'lineTotalMinor')::bigint,
    v_order.currency
  from jsonb_array_elements(v_settlement_snapshot) entry(value);

  if (
    select coalesce(sum(snapshot.line_total_minor), 0)
    from marketplace.payment_attempt_items snapshot
    where snapshot.attempt_id = v_attempt.id
      and snapshot.tenant_id = v_tenant.id
      and snapshot.order_id = v_order.id
  ) <> v_attempt.subtotal_minor + v_order.discount_minor then
    raise exception 'paymob_attempt_snapshot_mismatch';
  end if;

  update marketplace.orders
  set payment_provider = 'paymob',
      payment_status = 'pending',
      payment_reference = null,
      updated_at = now()
  where id = v_order.id;

  insert into marketplace.order_events(
    order_id,
    tenant_id,
    actor_subject_id,
    event_type,
    from_status,
    to_status,
    metadata
  ) values (
    v_order.id,
    v_tenant.id,
    v_actor,
    'paymob_checkout_prepared',
    v_order.status,
    v_order.status,
    jsonb_build_object(
      'attemptId', v_attempt.id,
      'environment', v_attempt.environment,
      'expiresAt', v_attempt.expires_at
    )
  );

  perform private_app.paymob_outbox_enqueue(
    v_tenant.id,
    v_order.id,
    v_attempt.id,
    'checkout_created',
    'checkout:' || v_attempt.id::text,
    jsonb_build_object(
      'attemptId', v_attempt.id,
      'orderNumber', v_order.order_number,
      'provider', 'paymob',
      'environment', v_attempt.environment,
      'amountMinor', v_attempt.amount_minor,
      'currency', v_attempt.currency,
      'expiresAt', v_attempt.expires_at
    )
  );

  insert into audit_log.events(
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  ) values (
    v_tenant.id,
    v_actor,
    'marketplace.paymob.checkout_prepared',
    'payment_attempt',
    v_attempt.id::text,
    jsonb_build_object(
      'orderId', v_order.id,
      'orderNumber', v_order.order_number,
      'environment', v_attempt.environment,
      'amountMinor', v_attempt.amount_minor,
      'currency', v_attempt.currency,
      'rawBillingStored', false,
      'pseudonymousBillingDigestStored', true,
      'billingDigestProtection', 'credential_keyed_hmac_sha256',
      'secretStored', false
    )
  );

  return jsonb_build_object(
    'schemaVersion', 1,
    'createAllowed', true,
    'attemptId', v_attempt.id,
    'attemptStatus', v_attempt.status,
    'expiresAt', v_attempt.expires_at,
    'billingDataValidated', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'number', v_order.order_number,
      'kind', v_order.order_kind,
      'status', v_order.status,
      'paymentStatus', 'pending',
      'amountMinor', v_order.total_minor,
      'currency', v_order.currency
    ),
    'provider', jsonb_build_object(
      'key', 'paymob',
      'region', 'ksa',
      'environment', v_provider.environment,
      'checkoutMode', v_provider.checkout_mode
    ),
    'items', v_items
  );
end;
$function$
;
