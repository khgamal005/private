begin;

create or replace function public.v3_platform_bank_transfer_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 return jsonb_build_object(
  'generatedAt',now(),
  'summary',jsonb_build_object(
   'pending',(select count(*) from marketplace.bank_transfer_submissions where status in('pending','reviewing')),
   'approved',(select count(*) from marketplace.bank_transfer_submissions where status='approved'),
   'rejected',(select count(*) from marketplace.bank_transfer_submissions where status='rejected')
  ),
  'transfers',coalesce((select jsonb_agg(jsonb_build_object(
   'id',transfer.id,'orderId',transfer.order_id,'orderNumber',orders.order_number,
   'tenantId',tenant.id,'tenantName',tenant.name,'tenantSlug',tenant.slug,
   'reference',transfer.transfer_reference,'senderName',transfer.sender_name,'transferDate',transfer.transfer_date,
   'amountMinor',transfer.amount_minor,'currency',transfer.currency,'status',transfer.status,
   'reviewNote',transfer.review_note,'submittedAt',transfer.created_at,'reviewedAt',transfer.reviewed_at
  ) order by case when transfer.status in('pending','reviewing') then 0 else 1 end,transfer.created_at desc)
  from marketplace.bank_transfer_submissions transfer
  join marketplace.orders orders on orders.id=transfer.order_id
  join core.tenants tenant on tenant.id=transfer.tenant_id),'[]'::jsonb)
 );
end;$$;
revoke all on function public.v3_platform_bank_transfer_snapshot() from public,anon;
grant execute on function public.v3_platform_bank_transfer_snapshot() to authenticated;

create or replace function public.v3_platform_bank_transfer_action(
 p_order_id uuid,p_action text,p_note text default null,p_payment_reference text default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid;v_order marketplace.orders%rowtype;v_transfer marketplace.bank_transfer_submissions%rowtype;
 v_result jsonb;v_event_id text;v_reference text;v_payload_hash text;
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden';end if;
 v_actor:=private_app.current_subject_id();
 perform pg_advisory_xact_lock(hashtextextended(p_order_id::text,0));
 select * into v_order from marketplace.orders where id=p_order_id for update;
 if v_order.id is null then raise exception 'marketplace_order_not_found';end if;
 select * into v_transfer from marketplace.bank_transfer_submissions where order_id=p_order_id for update;
 if v_transfer.id is null then raise exception 'bank_transfer_not_found';end if;

 if p_action='approve' then
  if v_transfer.status='approved' and v_order.payment_status='paid' then
   return private_app.marketplace_order_payload(v_order.id)||jsonb_build_object('duplicate',true,'bankTransferStatus','approved');
  end if;
  if v_transfer.status not in('pending','reviewing') then raise exception 'bank_transfer_not_reviewable';end if;
  if v_order.status<>'pending_payment' or v_order.payment_status<>'pending' then raise exception 'marketplace_order_not_payable';end if;
  v_reference:=left(coalesce(nullif(trim(p_payment_reference),''),v_transfer.transfer_reference),200);
  v_event_id:='manual-bank-transfer:'||v_transfer.id::text;
  v_payload_hash:=encode(extensions.digest(v_order.id::text||':'||v_transfer.id::text||':'||v_reference,'sha256'),'hex');
  v_result:=private_app.marketplace_record_payment(
   v_order.id,'bank_transfer',v_event_id,v_reference,'paid',v_order.total_minor,v_order.currency,true,v_payload_hash,v_actor
  );
  update catalog.tenant_addon_subscriptions subscription
  set payment_provider_key='bank_transfer',marketplace_order_id=v_order.id,
      price_version_id=coalesce(subscription.price_version_id,(
       select price.id from marketplace.order_items item
       join catalog.addon_price_versions price on price.product_id=item.addon_product_id
       where item.order_id=v_order.id and item.item_type='addon' and price.valid_from<=current_date
         and(price.valid_to is null or price.valid_to>current_date)
       order by price.valid_from desc limit 1
      )),period_is_authoritative=true,updated_at=now()
  where subscription.tenant_id=v_order.tenant_id and subscription.status='active'
    and subscription.requested_note='marketplace_order:'||v_order.order_number;
  update marketplace.bank_transfer_submissions
  set status='approved',review_note=left(nullif(trim(p_note),''),1000),reviewed_by_subject_id=v_actor,reviewed_at=now(),updated_at=now()
  where id=v_transfer.id;
  return v_result||jsonb_build_object('bankTransferStatus','approved');
 end if;

 if p_action='reject' then
  if v_transfer.status='approved' then raise exception 'bank_transfer_already_approved';end if;
  update marketplace.bank_transfer_submissions
  set status='rejected',review_note=left(coalesce(nullif(trim(p_note),''),'رفض التحويل بعد المراجعة.'),1000),
      reviewed_by_subject_id=v_actor,reviewed_at=now(),updated_at=now()
  where id=v_transfer.id returning * into v_transfer;
  insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,from_status,to_status,metadata)
  values(v_order.id,v_order.tenant_id,v_actor,'bank_transfer_rejected',v_order.status,v_order.status,
    jsonb_build_object('transferSubmissionId',v_transfer.id,'note',v_transfer.review_note));
  return private_app.marketplace_order_payload(v_order.id)||jsonb_build_object(
   'bankTransferStatus','rejected','reviewNote',v_transfer.review_note
  );
 end if;

 if p_action='review' then
  if v_transfer.status<>'pending' then raise exception 'bank_transfer_not_reviewable';end if;
  update marketplace.bank_transfer_submissions set status='reviewing',reviewed_by_subject_id=v_actor,updated_at=now() where id=v_transfer.id;
  return jsonb_build_object('orderId',v_order.id,'bankTransferStatus','reviewing');
 end if;

 raise exception 'bank_transfer_action_invalid';
end;$$;
revoke all on function public.v3_platform_bank_transfer_action(uuid,text,text,text) from public,anon;
grant execute on function public.v3_platform_bank_transfer_action(uuid,text,text,text) to authenticated;

commit;

