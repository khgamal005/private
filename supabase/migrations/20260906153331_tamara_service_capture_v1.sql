-- Service capture is gated by an immutable platform delivery confirmation.
create table marketplace.tamara_service_deliveries (
 attempt_id uuid primary key references marketplace.tamara_attempts(id),
 tenant_id uuid not null references core.tenants(id),
 order_id uuid not null unique references marketplace.orders(id),
 confirmed_at timestamptz, confirmed_by uuid, delivery_reference text,
 cancel_started_at timestamptz,
 check ((confirmed_at is null and confirmed_by is null and delivery_reference is null)
   or (confirmed_at is not null and confirmed_by is not null and length(delivery_reference) between 5 and 1000))
);
create index tamara_service_deliveries_tenant_idx on marketplace.tamara_service_deliveries(tenant_id,order_id);
alter table marketplace.tamara_service_deliveries enable row level security;
revoke all on marketplace.tamara_service_deliveries from public,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION private_app.tamara_service_create_v1(p_slug text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_provider marketplace.payment_provider_configs%rowtype;
  v_product marketplace.service_products%rowtype;
  v_package marketplace.service_packages%rowtype;
  v_order marketplace.orders%rowtype;
  v_result jsonb;
  v_idempotency_key text;
  v_quantity integer;
  v_amount bigint;
  v_subtotal bigint;
  v_tax bigint;
  v_brief jsonb;
begin
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug = p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;
  v_actor := private_app.current_subject_id();

  if lower(btrim(coalesce(p_payload ->> 'paymentProvider','bank_transfer')))
       = 'tamara' then
    select provider.* into v_provider
    from marketplace.payment_provider_configs provider
    where provider.provider_key = 'tamara';
    if v_provider.provider_key is null
       or not private_app.tamara_eligible_v1(v_tenant.id) then
      raise exception 'marketplace_payment_provider_unavailable';
    end if;
    -- Bind the service to Tamara without rewriting another provider order.
    v_idempotency_key := left(nullif(
      pg_catalog.btrim(p_payload ->> 'idempotencyKey'),''
    ),120);
    if v_idempotency_key is null then
      raise exception 'marketplace_idempotency_required';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      v_tenant.id::text || ':service:idempotency:' || v_idempotency_key,0
    ));
    select orders.* into v_order
    from marketplace.orders orders
    where orders.tenant_id = v_tenant.id
      and orders.idempotency_key = v_idempotency_key
    for update;
    if v_order.id is not null then
      if v_order.order_kind <> 'service'
         or v_order.payment_provider is distinct from 'tamara' then
        raise exception 'marketplace_idempotency_payment_provider_conflict';
      end if;
      return private_app.marketplace_order_payload(v_order.id)
        || jsonb_build_object(
          'duplicate',true,'paymentProvider','tamara',
          'paymentInstructions','{}'::jsonb
        );
    end if;

    begin
      v_quantity := coalesce((p_payload ->> 'quantity')::integer,1);
    exception when others then
      raise exception 'marketplace_quantity_invalid';
    end;
    if v_quantity not between 1 and 100 then
      raise exception 'marketplace_quantity_invalid';
    end if;
    select product.* into v_product
    from marketplace.service_products product
    join marketplace.service_categories category
      on category.id = product.category_id and category.status = 'active'
    where product.product_key = lower(nullif(
        pg_catalog.btrim(p_payload ->> 'productKey'),''
      ))
      and product.marketplace_visible
      and product.status in ('beta','active')
      and (
        product.provider_id is null
        or exists (
          select 1 from marketplace.service_providers service_provider
          where service_provider.id = product.provider_id
            and service_provider.status = 'active'
        )
      );
    if v_product.id is null then
      raise exception 'marketplace_product_not_found';
    end if;
    begin
      v_package.id := nullif(p_payload ->> 'packageId','')::uuid;
    exception when others then
      raise exception 'service_package_invalid';
    end;
    if v_package.id is not null then
      select package.* into v_package
      from marketplace.service_packages package
      where package.id = v_package.id
        and package.service_product_id = v_product.id
        and package.status = 'active'
      for share;
      if v_package.id is null then raise exception 'service_package_not_found'; end if;
      v_amount := v_package.amount_minor;
    else
      if v_product.pricing_mode in ('quote','from') or v_product.amount_minor <= 0 then
        raise exception 'service_quote_required';
      end if;
      v_amount := v_product.amount_minor;
    end if;
    if coalesce(v_package.currency,v_product.currency) <> 'SAR' then
      raise exception 'marketplace_currency_unsupported';
    end if;
    v_brief := coalesce(p_payload -> 'brief','{}'::jsonb);
    if jsonb_typeof(v_brief) <> 'object'
       or pg_catalog.octet_length(v_brief::text) > 20000 then
      raise exception 'service_brief_invalid';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      v_tenant.id::text || ':service:product:' || v_product.product_key,0
    ));
    select orders.* into v_order
    from marketplace.orders orders
    join marketplace.order_items item on item.order_id = orders.id
    where orders.tenant_id = v_tenant.id
      and orders.status = 'pending_payment'
      and orders.payment_status = 'pending'
      and item.item_type = 'service'
      and item.product_key = v_product.product_key
    order by orders.created_at desc
    limit 1
    for update of orders;
    if v_order.id is not null then
      if v_order.payment_provider is distinct from 'tamara' then
        raise exception 'marketplace_payment_provider_conflict';
      end if;
      return private_app.marketplace_order_payload(v_order.id)
        || jsonb_build_object(
          'duplicate',true,'duplicateReason','pending_product_order',
          'paymentProvider','tamara','paymentInstructions','{}'::jsonb
        );
    end if;

    v_subtotal := v_amount * v_quantity;
    v_tax := round(v_subtotal * 0.15)::bigint;
    insert into marketplace.orders(
      tenant_id,requested_by_subject_id,order_kind,status,payment_status,
      activation_state,currency,subtotal_minor,tax_minor,total_minor,tax_rate_bps,
      payment_provider,notes,idempotency_key
    ) values (
      v_tenant.id,v_actor,'service','pending_payment','pending','not_applicable',
      'SAR',v_subtotal,v_tax,v_subtotal + v_tax,1500,'tamara',
      left(nullif(pg_catalog.btrim(p_payload ->> 'notes'),''),1000),
      v_idempotency_key
    ) returning * into v_order;
    insert into marketplace.order_items(
      order_id,item_type,service_product_id,service_package_id,product_key,
      product_name_ar,quantity,unit_amount_minor,line_total_minor,metadata
    ) values (
      v_order.id,'service',v_product.id,v_package.id,v_product.product_key,
      v_product.name_ar,v_quantity,v_amount,v_subtotal,
      jsonb_strip_nulls(jsonb_build_object(
        'pricingMode',case when v_package.id is null
          then 'catalog_price' else 'service_package' end,
        'providerId',v_product.provider_id,'packageId',v_package.id,
        'packageName',v_package.name_ar,
        'packageDescription',v_package.description_ar,
        'packageIncludedItems',v_package.included_items_ar,
        'packageRevisionsIncluded',v_package.revisions_included,
        'packageTurnaroundDays',v_package.turnaround_days,
        'courseId',v_product.course_id
      ))
    );
    insert into marketplace.service_order_briefs(
      order_id,tenant_id,provider_id,package_id,preferred_start_date,
      delivery_mode,brief
    ) values (
      v_order.id,v_tenant.id,v_product.provider_id,v_package.id,
      nullif(p_payload ->> 'preferredStartDate','')::date,
      nullif(p_payload ->> 'deliveryMode',''),v_brief
    );
    if v_product.provider_id is not null then
      insert into marketplace.service_order_assignments(
        order_id,tenant_id,provider_id,package_id,status
      ) values (
        v_order.id,v_tenant.id,v_product.provider_id,v_package.id,'pending'
      );
    end if;
    insert into marketplace.order_events(
      order_id,tenant_id,actor_subject_id,event_type,to_status,metadata
    ) values (
      v_order.id,v_tenant.id,v_actor,'service_order_created','pending_payment',
      jsonb_build_object(
        'productKey',v_product.product_key,'providerId',v_product.provider_id,
        'packageId',v_package.id,'paymentProvider','tamara'
      )
    );
    insert into audit_log.events(
      tenant_id,actor_subject_id,action,resource_type,resource_id,context
    ) values (
      v_tenant.id,v_actor,'marketplace.service_order.created',
      'marketplace_order',v_order.id::text,
      jsonb_build_object(
        'orderNumber',v_order.order_number,'totalMinor',v_order.total_minor,
        'providerId',v_product.provider_id,'packageId',v_package.id,
        'paymentProvider','tamara'
      )
    );
    return private_app.marketplace_order_payload(v_order.id)
      || jsonb_build_object(
        'duplicate',false,'providerId',v_product.provider_id,
        'packageId',v_package.id,'paymentProvider','tamara',
        'paymentInstructions','{}'::jsonb
      );
  end if;
  raise exception 'marketplace_payment_provider_mismatch';
end;
$function$;


create function public.v1_tenant_tamara_service_create(p_slug text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; oid uuid; tid uuid;
begin
 r:=private_app.tamara_service_create_v1(p_slug,p_payload);
 oid:=(r->>'id')::uuid;
 select tenant_id into tid from marketplace.orders where id=oid;
 if nullif(btrim(p_payload->>'promotionCode'),'') is not null and not exists(select 1 from marketplace.tamara_attempts where order_id=oid) then
  perform private_app.marketplace_apply_promotion_v1(tid,oid,p_payload->>'promotionCode',private_app.current_subject_id());
 end if;
 return private_app.marketplace_order_payload(oid)||jsonb_build_object('paymentProvider','tamara','duplicate',r->'duplicate');
end $$;


CREATE OR REPLACE FUNCTION public.v1_tenant_tamara_prepare(p_slug text, p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t core.tenants%rowtype; o marketplace.orders%rowtype; a marketplace.tamara_attempts%rowtype;
 v marketplace.tamara_credential_versions%rowtype; items jsonb;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 select * into o from marketplace.orders where id=p_order_id and tenant_id=t.id for update;
 if o.id is null or o.payment_provider is distinct from 'tamara' then raise exception 'marketplace_order_not_found'; end if;
 select * into a from marketplace.tamara_attempts where order_id=o.id;
 if a.id is not null then return jsonb_build_object('attemptId',a.id,'orderId',o.id,'status',a.status); end if;
 if not private_app.tamara_eligible_v1(t.id) then raise exception 'marketplace_payment_provider_unavailable'; end if;
 if o.order_kind not in ('addon','service') or o.status<>'pending_payment' or o.payment_status<>'pending' or o.currency<>'SAR' or o.total_minor<=0 then raise exception 'marketplace_order_not_payable'; end if;
 select v1.* into v from marketplace.tamara_credential_versions v1 join marketplace.payment_provider_configs c
 on c.provider_key='tamara' and c.environment=v1.environment where v1.enabled and v1.revoked_at is null;
 select jsonb_agg(to_jsonb(i)||jsonb_build_object('billing_interval',p.interval,'feature_id',p.feature_id,'activation_mode',p.activation_mode))
 into items from marketplace.order_items i join catalog.addon_products p on p.id=i.addon_product_id
 where i.order_id=o.id and i.item_type='addon' and i.quantity=1 and p.interval in ('month','year','one_time');
 if o.order_kind='service' then
   select jsonb_agg(to_jsonb(i)) into items from marketplace.order_items i
   join marketplace.service_order_briefs b on b.order_id=i.order_id and b.tenant_id=t.id
   where i.order_id=o.id and i.item_type='service' and i.quantity between 1 and 100;
 end if;
 if jsonb_array_length(coalesce(items,'[]'::jsonb))<>1
   or (items->0->>'line_total_minor')::bigint<>o.list_subtotal_minor then raise exception 'tamara_snapshot_invalid'; end if;
 if o.promotion_id is not null and not exists(select 1 from marketplace.promotion_redemptions r
   where r.order_id=o.id and r.tenant_id=t.id and r.status='reserved' and r.reservation_expires_at>now()
   and r.total_minor_after=o.total_minor and r.discount_minor=o.discount_minor
   and (coalesce(r.terms_snapshot->'paymentProviders','[]'::jsonb)='[]'::jsonb or r.terms_snapshot->'paymentProviders' ? 'tamara'))
 then raise exception 'promotion_reservation_expired'; end if;
 insert into marketplace.tamara_attempts(tenant_id,order_id,version_id,environment,snapshot)
 values(t.id,o.id,v.id,v.environment,to_jsonb(o)||jsonb_build_object('slug',t.slug,'amount_minor',o.total_minor,'items',items)) returning * into a;
 if o.order_kind='service' then insert into marketplace.tamara_service_deliveries(attempt_id,tenant_id,order_id) values(a.id,t.id,o.id); end if;
 return jsonb_build_object('attemptId',a.id,'orderId',o.id,'status',a.status);
end $function$;


alter function private_app.tamara_provision_v1(uuid) rename to tamara_addon_provision_v1;
create function private_app.tamara_provision_v1(p_attempt_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare a marketplace.tamara_attempts%rowtype;
begin
 select * into a from marketplace.tamara_attempts where id=p_attempt_id for update;
 if a.snapshot->>'order_kind' is distinct from 'service' then return private_app.tamara_addon_provision_v1(p_attempt_id); end if;
 if a.status<>'authorised' then return false; end if;
 perform set_config('odeir.tamara_verified_order_id',a.order_id::text,true);
 update marketplace.orders set status='in_progress',updated_at=now() where id=a.order_id and tenant_id=a.tenant_id and status='pending_payment';
 return true;
end $$;


CREATE OR REPLACE FUNCTION public.v1_service_tamara_observe(p_attempt_id uuid, p_claim uuid, p_evidence jsonb, p_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a marketplace.tamara_attempts%rowtype; o marketplace.orders%rowtype; state text;
 captured bigint; refunded bigint; reversed boolean;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 select * into a from marketplace.tamara_attempts where id=p_attempt_id and claim_token=p_claim and claim_until>now() for update;
 if a.id is null then raise exception 'tamara_claim_lost'; end if;
 select * into o from marketplace.orders where id=a.order_id and tenant_id=a.tenant_id for update;
 if o.id is null or o.payment_provider is distinct from 'tamara' or o.total_minor<>(a.snapshot->>'amount_minor')::bigint
   or p_sha256 !~ '^[a-f0-9]{64}$' or (p_evidence->>'providerOrderId')::uuid is null
   or (a.provider_order_id is not null and a.provider_order_id<>(p_evidence->>'providerOrderId')::uuid)
 then raise exception 'tamara_binding_invalid'; end if;
 state:=p_evidence->>'status'; captured:=(p_evidence->>'capturedMinor')::bigint; refunded:=(p_evidence->>'refundedMinor')::bigint;
 if captured is null or refunded is null or captured<0 or refunded<0 or captured>o.total_minor or refunded>captured
 then raise exception 'tamara_evidence_invalid'; end if;
 -- Older inquiries and notifications cannot undo a later financial observation.
 if captured<a.captured_minor or refunded<a.refunded_minor then return jsonb_build_object('status',a.status,'stale',true); end if;
 insert into marketplace.tamara_evidence(tenant_id,order_id,attempt_id,evidence_sha256,provider_status,captured_minor,refunded_minor)
 values(a.tenant_id,o.id,a.id,p_sha256,state,captured,refunded) on conflict do nothing;
 update marketplace.tamara_attempts set provider_order_id=(p_evidence->>'providerOrderId')::uuid,captured_minor=captured,refunded_minor=refunded,updated_at=now() where id=a.id;
 perform set_config('odeir.tamara_verified_order_id',o.id::text,true);
 if state='fully_captured' and captured=o.total_minor and refunded=0 then
   if a.provisioned_at is null then
     update marketplace.tamara_attempts set status='review_required',last_error_code='capture_without_delivery' where id=a.id;
   elsif a.status<>'paid' then
     insert into marketplace.payment_events(order_id,provider_key,provider_event_id,payment_reference,state,amount_minor,currency,signature_verified,payload_sha256)
     values(o.id,'tamara',a.environment||':'||(p_evidence->>'providerOrderId')||':paid',p_evidence->>'providerOrderId','paid',o.total_minor,'SAR',false,p_sha256)
     on conflict(provider_key,provider_event_id) do nothing;
     update marketplace.orders set status='completed',payment_status='paid',activation_state=case when o.order_kind='service' then 'not_applicable' else 'active' end,payment_reference=p_evidence->>'providerOrderId',paid_at=coalesce(paid_at,now()),updated_at=now() where id=o.id;
     update marketplace.tamara_attempts set status='paid',last_error_code=null where id=a.id;
     update marketplace.tamara_entitlement_sources src set state='paid',updated_at=now() where src.attempt_id=a.id and src.state='provisioned';
     insert into marketplace.order_events(order_id,tenant_id,event_type,from_status,to_status,metadata)
     values(o.id,o.tenant_id,'tamara_payment_confirmed',o.status,'completed',jsonb_build_object('attemptId',a.id,'evidenceSha256',p_sha256));
   end if;
 elsif state='fully_refunded' and refunded=o.total_minor and captured=o.total_minor then
   reversed:=private_app.tamara_reverse_v1(a.id);
   insert into marketplace.payment_events(order_id,provider_key,provider_event_id,payment_reference,state,amount_minor,currency,signature_verified,payload_sha256)
   values(o.id,'tamara',a.environment||':'||(p_evidence->>'providerOrderId')||':refunded',p_evidence->>'providerOrderId','refunded',refunded,'SAR',false,p_sha256)
   on conflict(provider_key,provider_event_id) do nothing;
   update marketplace.orders set status='refunded',payment_status='refunded',activation_state=case when reversed then 'cancelled' else 'failed' end,updated_at=now() where id=o.id;
   update marketplace.tamara_attempts set status=case when reversed then 'refunded' else 'review_required' end,last_error_code=case when reversed then null else 'entitlement_state_changed' end where id=a.id;
 elsif state in ('declined','expired','canceled','cancelled') and captured=0 and a.status<>'paid' then
   reversed:=private_app.tamara_reverse_v1(a.id);
   update marketplace.orders set status='cancelled',payment_status='failed',activation_state=case when reversed then 'cancelled' else 'failed' end,updated_at=now() where id=o.id;
   update marketplace.tamara_attempts set status=case when reversed then 'cancelled' else 'review_required' end where id=a.id;
 elsif state='approved' and a.status in ('prepared','creating','pending','approved') then
   update marketplace.tamara_attempts set status='approved' where id=a.id;
 elsif state='authorised' and a.status in ('prepared','creating','pending','approved','authorised') then
   update marketplace.tamara_attempts set status='authorised' where id=a.id;
   if not private_app.tamara_provision_v1(a.id) then
     update marketplace.tamara_attempts set status='review_required',last_error_code='entitlement_state_changed' where id=a.id;
   end if;
 elsif state in ('partially_captured','partially_refunded') then
   update marketplace.tamara_attempts set status='review_required',last_error_code='partial_payment_requires_review' where id=a.id;
 end if;
 if exists(select 1 from marketplace.tamara_attempts changed where changed.id=a.id and changed.status<>a.status) then
   insert into audit_log.events(tenant_id,action,resource_type,resource_id,context)
   values(a.tenant_id,'marketplace.tamara.state_changed','marketplace_order',o.id::text,jsonb_build_object('attemptId',a.id,'providerStatus',state,'capturedMinor',captured,'refundedMinor',refunded,'evidenceSha256',p_sha256));
 end if;
 select * into a from marketplace.tamara_attempts where id=a.id;
 return jsonb_build_object('status',a.status,'provisioned_at',a.provisioned_at);
end $function$;


create function public.v1_platform_tamara_service_delivered(p_order_id uuid,p_reference text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a marketplace.tamara_attempts%rowtype; d marketplace.tamara_service_deliveries%rowtype;
begin
 if not private_app.has_platform_permission('platform.billing.manage') or private_app.current_subject_id() is null then raise exception 'forbidden'; end if;
 if coalesce(length(btrim(p_reference)),0) not between 5 and 1000 then raise exception 'tamara_delivery_reference_required'; end if;
 select * into a from marketplace.tamara_attempts where order_id=p_order_id for update;
 select * into d from marketplace.tamara_service_deliveries where attempt_id=a.id and tenant_id=a.tenant_id for update;
 if d.attempt_id is null then raise exception 'marketplace_order_not_found'; end if;
 if d.confirmed_at is not null then return jsonb_build_object('confirmed',true,'duplicate',true); end if;
 if a.status<>'authorised' or a.captured_minor<>0 or d.cancel_started_at is not null
   or a.create_started_at is null or now()>=a.create_started_at+interval '20 days' then raise exception 'tamara_delivery_window_closed'; end if;
 update marketplace.tamara_service_deliveries set confirmed_at=now(),confirmed_by=private_app.current_subject_id(),delivery_reference=btrim(p_reference) where attempt_id=a.id;
 update marketplace.tamara_attempts set provisioned_at=now(),status='provisioned',next_check_at=now(),updated_at=now() where id=a.id;
 insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,metadata)
 values(a.order_id,a.tenant_id,private_app.current_subject_id(),'tamara_service_delivered',jsonb_build_object('attemptId',a.id,'reference',btrim(p_reference)));
 insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
 values(a.tenant_id,private_app.current_subject_id(),'marketplace.tamara.service_delivered','marketplace_order',a.order_id::text,jsonb_build_object('attemptId',a.id));
 return jsonb_build_object('confirmed',true);
end $$;


CREATE OR REPLACE FUNCTION public.v1_service_tamara_mutation(p_attempt_id uuid, p_claim uuid, p_operation text, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a marketplace.tamara_attempts%rowtype;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 select * into a from marketplace.tamara_attempts where id=p_attempt_id and claim_token=p_claim and claim_until>now() for update;
 if a.id is null then return false; end if;
 if p_operation='create' and a.status='prepared' and a.create_started_at is null then
   update marketplace.tamara_attempts set create_started_at=now(),status='creating',checkout_payload=p_payload-'consumer'-'billing_address'-'shipping_address' where id=a.id;
 elsif p_operation='authorise' and a.status='approved' and a.authorise_started_at is null then
   update marketplace.tamara_attempts set authorise_started_at=now() where id=a.id;
 elsif p_operation='capture' and a.status='provisioned' and a.provisioned_at is not null and a.capture_started_at is null then
   if a.snapshot->>'order_kind'='service' and not exists(select 1 from marketplace.tamara_service_deliveries d where d.attempt_id=a.id and d.tenant_id=a.tenant_id and d.confirmed_at=a.provisioned_at and d.cancel_started_at is null) then return false; end if;
   update marketplace.tamara_attempts set capture_started_at=now() where id=a.id;
 elsif p_operation='cancel' and a.snapshot->>'order_kind'='service' and a.status='authorised' and a.provisioned_at is null and a.captured_minor=0 and a.create_started_at+interval '20 days'<=now() then
   update marketplace.tamara_service_deliveries set cancel_started_at=now() where attempt_id=a.id and tenant_id=a.tenant_id and confirmed_at is null and cancel_started_at is null;
   if not found then return false; end if;
 else return false; end if;
 return true;
end $function$;


create function public.v3_tenant_service_marketplace_snapshot(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b jsonb; m jsonb;
begin
 b:=public.v2_tenant_service_marketplace_snapshot(p_slug);
 m:=public.v3_tenant_marketplace_snapshot(p_slug);
 return jsonb_set(b,'{paymentMethods}',coalesce(m->'paymentMethods','[]'::jsonb));
end $$;


revoke all on function private_app.tamara_service_create_v1(text,jsonb) from public,anon,authenticated,service_role;

revoke all on function private_app.tamara_provision_v1(uuid) from public,anon,authenticated,service_role;

revoke all on function public.v1_tenant_tamara_service_create(text,jsonb) from public,anon,authenticated,service_role;

grant execute on function public.v1_tenant_tamara_service_create(text,jsonb) to authenticated;

revoke all on function public.v1_platform_tamara_service_delivered(uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.v1_platform_tamara_service_delivered(uuid,text) to authenticated;

revoke all on function public.v3_tenant_service_marketplace_snapshot(text) from public,anon,authenticated,service_role;

grant execute on function public.v3_tenant_service_marketplace_snapshot(text) to authenticated;-- Retire only an unpaid, expired Paymob order; keep its provider binding and all
-- attempt evidence. A new canonical order owns the newly selected payment.
create function public.v1_tenant_marketplace_replace_payment(p_slug text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t core.tenants%rowtype; o marketplace.orders%rowtype; i marketplace.order_items%rowtype;
 b marketplace.service_order_briefs%rowtype; r jsonb; target text; next_id uuid; payload jsonb;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 target:=p_payload->>'paymentProvider';
 if target not in ('bank_transfer','tamara') or target is null then raise exception 'marketplace_payment_provider_unavailable'; end if;
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
 select * into o from marketplace.orders where id=(p_payload->>'orderId')::uuid and tenant_id=t.id for update;
 if o.id is null or o.payment_provider is distinct from 'paymob' then raise exception 'marketplace_order_not_found'; end if;
 select (metadata->>'replacementOrderId')::uuid into next_id from marketplace.order_events
 where order_id=o.id and tenant_id=t.id and event_type='payment_order_replaced' limit 1;
 if next_id is not null then
  if not exists(select 1 from marketplace.orders where id=next_id and tenant_id=t.id and payment_provider=target) then raise exception 'marketplace_payment_provider_mismatch'; end if;
  return private_app.marketplace_order_payload(next_id)||jsonb_build_object('paymentProvider',target,'duplicate',true);
 end if;
 if o.status<>'pending_payment' or o.payment_status not in ('pending','failed') then raise exception 'marketplace_order_not_payable'; end if;
 if exists(select 1 from marketplace.payment_attempts a where a.order_id=o.id and
   (a.status<>'failed' or a.last_error_code is distinct from 'provider_intention_expired_no_payment'
    or coalesce(a.provider_expires_at,a.expires_at) is null or coalesce(a.provider_expires_at,a.expires_at)>now()))
   or exists(select 1 from marketplace.payment_events e where e.order_id=o.id and e.state in ('paid','refunded'))
   or exists(select 1 from marketplace.bank_transfer_submissions x where x.order_id=o.id and x.status in ('pending','reviewing','approved'))
 then raise exception 'payment_replacement_requires_resolution'; end if;
 if (select count(*) from marketplace.order_items where order_id=o.id)<>1 then raise exception 'marketplace_product_invalid'; end if;
 select * into i from marketplace.order_items where order_id=o.id;
 payload:=jsonb_build_object('productKey',i.product_key,'quantity',i.quantity,'itemType',o.order_kind,
  'paymentProvider',target,'notes',o.notes,'idempotencyKey','replacement_'||o.id::text||'_'||target,'promotionCode',o.promotion_code);
 update marketplace.orders set status='cancelled',updated_at=now() where id=o.id;
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
end $$;
revoke all on function public.v1_tenant_marketplace_replace_payment(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_marketplace_replace_payment(text,jsonb) to authenticated;

create or replace function public.v1_tenant_tamara_status(p_slug text,p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t core.tenants%rowtype; a marketplace.tamara_attempts%rowtype; o marketplace.orders%rowtype;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 select * into a from marketplace.tamara_attempts where id=p_attempt_id and tenant_id=t.id;
 if a.id is null then raise exception 'marketplace_order_not_found'; end if;
 select * into o from marketplace.orders where id=a.order_id;
 return jsonb_build_object('attemptId',a.id,'orderId',a.order_id,'orderNumber',o.order_number,'status',a.status,
   'paymentStatus',o.payment_status,'activationState',o.activation_state,'environment',a.environment,'orderKind',o.order_kind,
   'checkoutUrl',case when a.status='pending' then a.checkout_url else null end);
end $$;

create function public.v2_platform_service_marketplace_snapshot() returns jsonb
language plpgsql security definer set search_path='' as $$
declare b jsonb; rows jsonb;
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden'; end if;
 b:=public.v1_platform_service_marketplace_snapshot();
 select coalesce(jsonb_agg(x.value||jsonb_build_object('paymentProvider',o.payment_provider,'tamaraStatus',a.status,'tamaraDeadline',a.create_started_at+interval '20 days','tamaraError',a.last_error_code) order by x.ordinality),'[]'::jsonb) into rows
 from jsonb_array_elements(coalesce(b->'orders','[]'::jsonb)) with ordinality x(value,ordinality)
 join marketplace.orders o on o.id=(x.value->>'id')::uuid and o.order_kind='service'
 left join marketplace.tamara_attempts a on a.order_id=o.id and a.tenant_id=o.tenant_id;
 return jsonb_set(b,'{orders}',rows);
end $$;
revoke all on function public.v2_platform_service_marketplace_snapshot() from public,anon,authenticated,service_role;
grant execute on function public.v2_platform_service_marketplace_snapshot() to authenticated;
