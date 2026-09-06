create or replace function public.v1_tenant_marketplace_cancel_unpaid_order(p_slug text,p_payload jsonb) returns jsonb
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
 -- Resolved Paymob attempts have payment_status=failed; legacy cancellation only accepts pending.
 if o.payment_provider<>'tamara' and not (o.payment_provider='paymob' and o.payment_status='failed') then
   if o.order_kind='service' then return public.v2_tenant_service_marketplace_action(p_slug,'cancel_order',p_payload); end if;
   return public.v2_tenant_marketplace_action(p_slug,'cancel_order',p_payload);
 end if;
 update marketplace.orders set status='cancelled',payment_status='failed',
   activation_state=case when o.payment_provider='paymob' then 'cancelled' else o.activation_state end,
   updated_at=now() where id=o.id;
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

