begin;

-- Only closes orders with no live financial obligation. Provider URLs and
-- evidence are never erased, and a browser return is never payment evidence.
create function public.v1_tenant_marketplace_cancel_unpaid_order(p_slug text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t core.tenants%rowtype; o marketplace.orders%rowtype; a marketplace.tamara_attempts%rowtype; oid uuid;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 oid:=(p_payload->>'orderId')::uuid;
 if not exists(select 1 from marketplace.orders where id=oid and tenant_id=t.id) then raise exception 'marketplace_order_not_found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('paymob:order:'||oid::text,0));
 -- The worker locks attempt before order. NOWAIT avoids waiting in the inverse
 -- order if a concurrent prepare creates an attempt after this first lookup.
 select * into a from marketplace.tamara_attempts where order_id=oid and tenant_id=t.id for update nowait;
 select * into o from marketplace.orders where id=oid and tenant_id=t.id for update nowait;
 select * into a from marketplace.tamara_attempts where order_id=oid and tenant_id=t.id for update nowait;
 if o.status not in ('pending_payment','cancelled') or o.payment_status not in ('pending','failed')
    or o.paid_at is not null then raise exception 'marketplace_order_not_payable'; end if;
 if exists(select 1 from marketplace.payment_events where order_id=o.id and state in ('paid','refunded'))
   or exists(select 1 from marketplace.payment_attempts x where x.order_id=o.id and
     (x.status<>'failed' or x.last_error_code is distinct from 'provider_intention_expired_no_payment'
      or coalesce(x.provider_expires_at,x.expires_at) is null or coalesce(x.provider_expires_at,x.expires_at)>now()))
   or exists(select 1 from marketplace.bank_transfer_submissions where order_id=o.id and status in ('pending','reviewing','approved'))
 then raise exception 'payment_cancellation_requires_resolution'; end if;
 if a.id is not null then
   if a.captured_minor<>0 or a.refunded_minor<>0 or a.provisioned_at is not null
      or a.authorise_started_at is not null or a.capture_started_at is not null
      or not (a.status='cancelled' or (a.status='prepared' and a.create_started_at is null and a.provider_order_id is null))
   then raise exception 'tamara_order_payment_review_hold'; end if;
   -- Fence any prepared worker: its create mutation can no longer claim this attempt.
   update marketplace.tamara_attempts set status='cancelled',claim_token=null,claim_until=null,updated_at=now() where id=a.id;
   perform set_config('odeir.tamara_verified_order_id',o.id::text,true);
 end if;
 if o.status='cancelled' then return private_app.marketplace_order_payload(o.id)||jsonb_build_object('duplicate',true); end if;
 if o.payment_provider<>'tamara' then
   if o.order_kind='service' then return public.v2_tenant_service_marketplace_action(p_slug,'cancel_order',p_payload); end if;
   return public.v2_tenant_marketplace_action(p_slug,'cancel_order',p_payload);
 end if;
 update marketplace.orders set status='cancelled',payment_status='failed',updated_at=now() where id=o.id;
 update marketplace.service_order_assignments set status='cancelled' where order_id=o.id and tenant_id=t.id and status='pending';
 insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata)
 values(o.id,t.id,private_app.current_subject_id(),'order_cancelled',o.status,'cancelled',jsonb_build_object('reason','customer_cancelled_unpaid','attemptId',a.id));
 insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
 values(t.id,private_app.current_subject_id(),'marketplace.order.cancelled','marketplace_order',o.id::text,jsonb_build_object('reason','customer_cancelled_unpaid'));
 return private_app.marketplace_order_payload(o.id);
exception when lock_not_available then raise exception 'payment_order_busy';
end $$;
revoke all on function public.v1_tenant_marketplace_cancel_unpaid_order(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_marketplace_cancel_unpaid_order(text,jsonb) to authenticated;

create or replace function public.v1_tenant_marketplace_replace_payment(p_slug text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
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
  'paymentProvider',target,'notes',o.notes,'idempotencyKey','replacement_'||o.id::text||'_'||target,'promotionCode',o.promotion_code);
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
end $$;
revoke all on function public.v1_tenant_marketplace_replace_payment(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_marketplace_replace_payment(text,jsonb) to authenticated;

commit;
