-- Additive Tamara engine. No rollout, credentials or tenant records are changed.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table marketplace.tamara_credential_versions (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('sandbox','live')),
  api_secret_id uuid not null references vault.secrets(id),
  notification_secret_id uuid not null references vault.secrets(id),
  source_rotated_at timestamptz not null,
  webhook_id uuid,
  webhook_registration_started_at timestamptz,
  enabled boolean not null default false,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index tamara_one_enabled_version on marketplace.tamara_credential_versions(environment) where enabled;
create table marketplace.tamara_tenant_rollouts (
  tenant_id uuid not null references core.tenants(id),
  environment text not null check (environment in ('sandbox','live')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (tenant_id,environment)
);
create table marketplace.tamara_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id),
  order_id uuid not null unique references marketplace.orders(id),
  version_id uuid not null references marketplace.tamara_credential_versions(id),
  environment text not null check (environment in ('sandbox','live')),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object'),
  status text not null default 'prepared' check (status in
    ('prepared','creating','pending','approved','authorised','provisioned','paid','cancelled','refunded','review_required')),
  provider_order_id uuid,
  checkout_url text,
  checkout_payload jsonb,
  provisioned_at timestamptz,
  create_started_at timestamptz,
  authorise_started_at timestamptz,
  capture_started_at timestamptz,
  captured_minor bigint not null default 0 check(captured_minor>=0),
  refunded_minor bigint not null default 0 check(refunded_minor>=0 and refunded_minor<=captured_minor),
  claim_token uuid,
  claim_until timestamptz,
  next_check_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(environment,provider_order_id),
  unique(id,tenant_id,order_id)
);
create index tamara_reconcile_due on marketplace.tamara_attempts(next_check_at,id)
  where status not in ('cancelled','refunded');
create index tamara_tenant_orders on marketplace.tamara_attempts(tenant_id,created_at desc);
create table marketplace.tamara_entitlement_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id),
  order_id uuid not null references marketplace.orders(id),
  attempt_id uuid not null,
  order_item_id uuid not null unique references marketplace.order_items(id),
  product_id uuid not null references catalog.addon_products(id),
  subscription_id uuid references catalog.tenant_addon_subscriptions(id),
  subscription_after jsonb,
  module_id uuid references core.modules(id),
  module_before jsonb,
  module_after jsonb,
  state text not null check(state in ('provisioned','paid','reversed','review_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(attempt_id,tenant_id,order_id) references marketplace.tamara_attempts(id,tenant_id,order_id)
);
create index tamara_sources_tenant on marketplace.tamara_entitlement_sources(tenant_id,product_id);
create table marketplace.tamara_evidence (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references core.tenants(id),
  order_id uuid not null references marketplace.orders(id),
  attempt_id uuid not null,
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  provider_status text not null,
  captured_minor bigint not null,
  refunded_minor bigint not null,
  created_at timestamptz not null default now(),
  foreign key(attempt_id,tenant_id,order_id) references marketplace.tamara_attempts(id,tenant_id,order_id),
  unique(attempt_id,evidence_sha256)
);
-- All access goes through permission-checked RPCs, including service workers.
alter table marketplace.tamara_credential_versions enable row level security;
alter table marketplace.tamara_tenant_rollouts enable row level security;
alter table marketplace.tamara_attempts enable row level security;
alter table marketplace.tamara_entitlement_sources enable row level security;
alter table marketplace.tamara_evidence enable row level security;
revoke all on marketplace.tamara_credential_versions,marketplace.tamara_tenant_rollouts,
 marketplace.tamara_attempts,marketplace.tamara_entitlement_sources,marketplace.tamara_evidence
 from public,anon,authenticated,service_role;

create function private_app.tamara_eligible_v1(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from marketplace.payment_provider_configs c
 join marketplace.tamara_credential_versions v on v.environment=c.environment and v.enabled and v.revoked_at is null
 join marketplace.tamara_tenant_rollouts r on r.tenant_id=p_tenant_id and r.environment=v.environment and r.enabled
 where c.provider_key='tamara' and c.credentials_environment=c.environment and v.webhook_id is not null
 and not exists(select 1 from marketplace.payment_provider_secret_refs s where s.provider_key='tamara'
   and (s.last_rotated_at>v.source_rotated_at or s.credentials_environment<>v.environment)));
$$;

create function public.v1_tenant_tamara_create_order(p_slug text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t core.tenants%rowtype; o marketplace.orders%rowtype; result jsonb; oid uuid;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 if not private_app.tamara_eligible_v1(t.id) then raise exception 'marketplace_payment_provider_unavailable'; end if;
 if p_payload->>'itemType' is distinct from 'addon' or p_payload->>'paymentProvider' is distinct from 'tamara'
   or coalesce(p_payload->>'idempotencyKey','') !~ '^[A-Za-z0-9_-]{16,120}$' then raise exception 'marketplace_product_invalid'; end if;
 result:=private_app.v1_tenant_marketplace_action_paymob_legacy_v1(p_slug,'create_order',p_payload-'paymentProvider'-'promotionCode');
 oid:=coalesce(result->>'id',result->>'orderId')::uuid;
 select * into o from marketplace.orders where id=oid and tenant_id=t.id for update;
 if o.id is null or o.order_kind<>'addon' or o.status<>'pending_payment' or o.payment_status<>'pending'
   or (o.payment_provider is not null and o.payment_provider<>'tamara')
   or exists(select 1 from marketplace.bank_transfer_submissions b where b.order_id=o.id and b.status in ('pending','reviewing','approved'))
 then raise exception 'marketplace_payment_provider_mismatch'; end if;
 if coalesce((result->>'duplicate')::boolean,false) and o.payment_provider is distinct from 'tamara' then
   raise exception 'marketplace_payment_provider_mismatch'; end if;
 update marketplace.orders set payment_provider='tamara',updated_at=now() where id=o.id;
 if nullif(btrim(p_payload->>'promotionCode'),'') is not null and not exists(select 1 from marketplace.tamara_attempts where order_id=o.id) then
   perform private_app.marketplace_apply_promotion_v1(t.id,o.id,p_payload->>'promotionCode',private_app.current_subject_id());
 end if;
 return private_app.marketplace_order_payload(o.id)||jsonb_build_object('duplicate',result->'duplicate','paymentProvider','tamara','paymentInstructions','{}'::jsonb);
end $$;

create function public.v1_tenant_tamara_prepare(p_slug text,p_order_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
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
 if o.order_kind<>'addon' or o.status<>'pending_payment' or o.payment_status<>'pending' or o.currency<>'SAR' or o.total_minor<=0 then raise exception 'marketplace_order_not_payable'; end if;
 select v1.* into v from marketplace.tamara_credential_versions v1 join marketplace.payment_provider_configs c
 on c.provider_key='tamara' and c.environment=v1.environment where v1.enabled and v1.revoked_at is null;
 select jsonb_agg(to_jsonb(i)||jsonb_build_object('billing_interval',p.interval,'feature_id',p.feature_id,'activation_mode',p.activation_mode))
 into items from marketplace.order_items i join catalog.addon_products p on p.id=i.addon_product_id
 where i.order_id=o.id and i.item_type='addon' and i.quantity=1 and p.interval in ('month','year','one_time');
 if jsonb_array_length(coalesce(items,'[]'::jsonb))<>1
   or (items->0->>'line_total_minor')::bigint<>o.list_subtotal_minor then raise exception 'tamara_snapshot_invalid'; end if;
 if o.promotion_id is not null and not exists(select 1 from marketplace.promotion_redemptions r
   where r.order_id=o.id and r.tenant_id=t.id and r.status='reserved' and r.reservation_expires_at>now()
   and r.total_minor_after=o.total_minor and r.discount_minor=o.discount_minor
   and (coalesce(r.terms_snapshot->'paymentProviders','[]'::jsonb)='[]'::jsonb or r.terms_snapshot->'paymentProviders' ? 'tamara'))
 then raise exception 'promotion_reservation_expired'; end if;
 insert into marketplace.tamara_attempts(tenant_id,order_id,version_id,environment,snapshot)
 values(t.id,o.id,v.id,v.environment,to_jsonb(o)||jsonb_build_object('slug',t.slug,'amount_minor',o.total_minor,'items',items)) returning * into a;
 return jsonb_build_object('attemptId',a.id,'orderId',o.id,'status',a.status);
end $$;

create function public.v1_tenant_tamara_status(p_slug text,p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t core.tenants%rowtype; a marketplace.tamara_attempts%rowtype; o marketplace.orders%rowtype;
begin
 select * into t from core.tenants where slug=p_slug;
 if t.id is null or not private_app.has_tenant_permission(t.id,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 select * into a from marketplace.tamara_attempts where id=p_attempt_id and tenant_id=t.id;
 if a.id is null then raise exception 'marketplace_order_not_found'; end if;
 select * into o from marketplace.orders where id=a.order_id;
 return jsonb_build_object('attemptId',a.id,'orderId',a.order_id,'orderNumber',o.order_number,'status',a.status,
   'paymentStatus',o.payment_status,'activationState',o.activation_state,'environment',a.environment,
   'checkoutUrl',case when a.status='pending' then a.checkout_url else null end);
end $$;

create function private_app.tamara_order_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from marketplace.tamara_attempts where order_id=old.id) then
   if (new.tenant_id,new.payment_provider,new.currency,new.subtotal_minor,new.tax_minor,new.total_minor,new.discount_minor,new.promotion_id,new.promotion_code,new.order_kind,new.order_number,new.list_subtotal_minor,new.tax_rate_bps)
    is distinct from (old.tenant_id,old.payment_provider,old.currency,old.subtotal_minor,old.tax_minor,old.total_minor,old.discount_minor,old.promotion_id,old.promotion_code,old.order_kind,old.order_number,old.list_subtotal_minor,old.tax_rate_bps)
    then raise exception 'promotion_order_payment_locked'; end if;
   if (new.status,new.payment_status,new.activation_state) is distinct from (old.status,old.payment_status,old.activation_state)
    and current_setting('odeir.tamara_verified_order_id',true) is distinct from old.id::text then raise exception 'tamara_order_payment_review_hold'; end if;
 end if;
 return new;
end $$;
create trigger tamara_order_guard before update on marketplace.orders for each row execute function private_app.tamara_order_guard_v1();

-- Service claims are fenced. A started mutation is NEVER reissued after timeout.
create function public.v1_service_tamara_claim(p_attempt_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a marketplace.tamara_attempts%rowtype; v marketplace.tamara_credential_versions%rowtype; api text;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 select * into a from marketplace.tamara_attempts
 where (p_attempt_id is null or id=p_attempt_id) and (claim_until is null or claim_until<now())
 and (p_attempt_id is not null or next_check_at<=now()) and status not in ('cancelled','refunded')
 order by next_check_at,id limit 1 for update skip locked;
 if a.id is null then return null; end if;
 select * into v from marketplace.tamara_credential_versions where id=a.version_id and revoked_at is null;
 if v.id is null then return null; end if;
 select decrypted_secret into api from vault.decrypted_secrets where id=v.api_secret_id;
 update marketplace.tamara_attempts set claim_token=gen_random_uuid(),claim_until=now()+interval '90 seconds',next_check_at=now()+interval '2 minutes'
 where id=a.id returning * into a;
 return to_jsonb(a)||jsonb_build_object('apiToken',api,'snapshot',a.snapshot||jsonb_build_object('id',a.id,'provider_order_id',a.provider_order_id,'provisioned_at',a.provisioned_at));
end $$;

create function public.v1_service_tamara_mutation(p_attempt_id uuid,p_claim uuid,p_operation text,p_payload jsonb default null) returns boolean
language plpgsql security definer set search_path='' as $$
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
   update marketplace.tamara_attempts set capture_started_at=now() where id=a.id;
 else return false; end if;
 return true;
end $$;

create function public.v1_service_tamara_release(p_attempt_id uuid,p_claim uuid,p_provider_order_id uuid default null,p_checkout_url text default null,p_error_code text default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare a marketplace.tamara_attempts%rowtype;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 select * into a from marketplace.tamara_attempts where id=p_attempt_id and claim_token=p_claim and claim_until>now() for update;
 if a.id is null then return false; end if;
 if p_provider_order_id is not null and a.provider_order_id is not null and p_provider_order_id<>a.provider_order_id then raise exception 'tamara_binding_invalid'; end if;
 if p_checkout_url is not null and p_checkout_url !~ '^https://checkout(-sandbox)?\.tamara\.co/' then raise exception 'tamara_checkout_url_invalid'; end if;
 update marketplace.tamara_attempts set provider_order_id=coalesce(provider_order_id,p_provider_order_id),checkout_url=coalesce(checkout_url,p_checkout_url),
 status=case when status='creating' and p_provider_order_id is not null then 'pending' else status end,
 claim_token=null,claim_until=null,last_error_code=case when status='review_required' then last_error_code else left(p_error_code,80) end,updated_at=now(),
 next_check_at=now()+case when status='paid' then interval '12 hours' else interval '1 minute' end where id=a.id;
 return true;
end $$;

create function private_app.tamara_provision_v1(p_attempt_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare a marketplace.tamara_attempts%rowtype; item jsonb; product catalog.addon_products%rowtype;
 sub catalog.tenant_addon_subscriptions%rowtype; mod core.tenant_modules%rowtype; before_mod jsonb;
 mid uuid; finish timestamptz; sid uuid;
begin
 select * into a from marketplace.tamara_attempts where id=p_attempt_id for update;
 if a.status<>'authorised' then return a.provisioned_at is not null; end if;
 item:=a.snapshot->'items'->0;
 -- Shared lock identity coordinates this product with existing Paymob grants.
 perform pg_advisory_xact_lock(hashtextextended('paymob:entitlement:'||a.tenant_id::text||':'||(item->>'addon_product_id'),0));
 select * into product from catalog.addon_products where id=(item->>'addon_product_id')::uuid for share;
 if product.id is null or product.feature_id::text is distinct from item->>'feature_id'
   or product.activation_mode is distinct from item->>'activation_mode' then return false; end if;
 if exists(select 1 from marketplace.tamara_entitlement_sources where attempt_id=a.id) then return false; end if;
 -- Add-on checkout buys a new entitlement. Never overwrite a later manual grant,
 -- a trial, another provider's subscription or its renewal period.
 perform 1 from catalog.tenant_addon_subscriptions where tenant_id=a.tenant_id and product_id=product.id
 and status in ('pending','trialing','active','paused') for update;
 if found then return false; end if;
 if product.activation_mode='module' then
   select m.id into mid from core.modules m join catalog.features f on f.feature_key='module.'||m.module_key where f.id=product.feature_id;
   if mid is null then return false; end if;
   select * into mod from core.tenant_modules where tenant_id=a.tenant_id and module_id=mid for update;
   before_mod:=case when mod.module_id is null then null else to_jsonb(mod) end;
 end if;
 finish:=case item->>'billing_interval' when 'month' then now()+interval '1 month' when 'year' then now()+interval '1 year' else null end;
 insert into catalog.tenant_addon_subscriptions(tenant_id,product_id,status,source,period_start,period_end,requested_by_subject_id,
 requested_note,decision_note,payment_provider_key,marketplace_order_id,auto_renew,activated_at)
 values(a.tenant_id,product.id,'active','billing',now(),finish,(a.snapshot->>'requested_by_subject_id')::uuid,
 'tamara_order:'||(a.snapshot->>'order_number'),'provisioned_after_tamara_authorisation','tamara',a.order_id,false,now())
 returning * into sub;
 insert into marketplace.tamara_entitlement_sources(tenant_id,order_id,attempt_id,order_item_id,product_id,subscription_id,subscription_after,module_id,module_before,state)
 values(a.tenant_id,a.order_id,a.id,(item->>'id')::uuid,product.id,sub.id,to_jsonb(sub),mid,before_mod,'provisioned') returning id into sid;
 if mid is not null then
   if mod.module_id is null then
     insert into core.tenant_modules(tenant_id,module_id,enabled,configuration,enabled_at,updated_at)
     values(a.tenant_id,mid,true,jsonb_build_object('source','tamara_order','orderId',a.order_id),now(),now()) returning * into mod;
   elsif not mod.enabled then
     update core.tenant_modules set enabled=true,enabled_at=coalesce(enabled_at,now()),updated_at=now()
     where tenant_id=a.tenant_id and module_id=mid returning * into mod;
   end if;
   update marketplace.tamara_entitlement_sources set module_after=to_jsonb(mod) where id=sid;
 end if;
 insert into catalog.tenant_addon_subscription_events(subscription_id,tenant_id,product_id,event_key,event_type,to_status,effective_at,metadata)
 values(sub.id,a.tenant_id,product.id,'tamara_provisioned:'||a.id::text,'activated','active',now(),jsonb_build_object('attemptId',a.id,'provider','tamara','paymentPending',true));
 update marketplace.tamara_attempts set provisioned_at=now(),status='provisioned',updated_at=now() where id=a.id;
 insert into marketplace.order_events(order_id,tenant_id,event_type,metadata)
 values(a.order_id,a.tenant_id,'tamara_digital_delivery',jsonb_build_object('attemptId',a.id,'subscriptionId',sub.id));
 return true;
end $$;

create function private_app.tamara_reverse_v1(p_attempt_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s marketplace.tamara_entitlement_sources%rowtype; sub catalog.tenant_addon_subscriptions%rowtype;
 mod core.tenant_modules%rowtype; ok boolean:=true;
begin
 for s in select * from marketplace.tamara_entitlement_sources where attempt_id=p_attempt_id and state<>'reversed' order by product_id for update loop
   perform pg_advisory_xact_lock(hashtextextended('paymob:entitlement:'||s.tenant_id::text||':'||s.product_id::text,0));
   select * into sub from catalog.tenant_addon_subscriptions where id=s.subscription_id and tenant_id=s.tenant_id for update;
   if to_jsonb(sub) is distinct from s.subscription_after then
     update marketplace.tamara_entitlement_sources set state='review_required',updated_at=now() where id=s.id;
     ok:=false; continue;
   end if;
   if s.module_id is not null then
     select * into mod from core.tenant_modules where tenant_id=s.tenant_id and module_id=s.module_id for update;
     if to_jsonb(mod) is distinct from s.module_after then
       update marketplace.tamara_entitlement_sources set state='review_required',updated_at=now() where id=s.id;
       ok:=false; continue;
     end if;
   end if;
   update catalog.tenant_addon_subscriptions set status='cancelled',ended_at=now(),decision_note='tamara_payment_reversed',updated_at=now() where id=s.subscription_id;
   if s.module_id is not null then
     if s.module_before is null then
       -- Preserve the module row and history; only revoke this source's enablement.
       update core.tenant_modules set enabled=false,updated_at=now() where tenant_id=s.tenant_id and module_id=s.module_id;
     else
       update core.tenant_modules set enabled=(s.module_before->>'enabled')::boolean,
       configuration=s.module_before->'configuration',enabled_at=(s.module_before->>'enabled_at')::timestamptz,updated_at=now()
       where tenant_id=s.tenant_id and module_id=s.module_id;
     end if;
   end if;
   update marketplace.tamara_entitlement_sources set state='reversed',updated_at=now() where id=s.id;
   insert into catalog.tenant_addon_subscription_events(subscription_id,tenant_id,product_id,event_key,event_type,from_status,to_status,effective_at,metadata)
   values(sub.id,s.tenant_id,s.product_id,'tamara_reversed:'||s.id::text,'cancelled',sub.status,'cancelled',now(),jsonb_build_object('attemptId',p_attempt_id,'provider','tamara'));
 end loop;
 return ok;
end $$;

create function public.v1_service_tamara_observe(p_attempt_id uuid,p_claim uuid,p_evidence jsonb,p_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
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
     update marketplace.orders set status='completed',payment_status='paid',activation_state='active',payment_reference=p_evidence->>'providerOrderId',paid_at=coalesce(paid_at,now()),updated_at=now() where id=o.id;
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
end $$;

create function public.v1_service_tamara_notification_keys(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 return(select jsonb_build_object('notificationToken',s.decrypted_secret)
 from marketplace.tamara_attempts a join marketplace.tamara_credential_versions v on v.id=a.version_id and v.revoked_at is null
 join vault.decrypted_secrets s on s.id=v.notification_secret_id where a.id=p_attempt_id);
end $$;

create function public.v1_service_tamara_wake(p_attempt_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 update marketplace.tamara_attempts set next_check_at=least(next_check_at,now()) where id=p_attempt_id;
end $$;

-- Platform administrator can prepare immutable Vault copies; no automatic rollout.
create function public.v1_platform_tamara_prepare_version() returns uuid
language plpgsql security definer set search_path='' as $$
declare c marketplace.payment_provider_configs%rowtype; api text; notification text; vid uuid:=gen_random_uuid(); ar uuid; nr uuid; rotated timestamptz;
begin
 perform public.v3_platform_payment_provider_admin_snapshot();
 select * into c from marketplace.payment_provider_configs where provider_key='tamara' for update;
 if c.credentials_environment is distinct from c.environment then raise exception 'tamara_credentials_invalid'; end if;
 select s.decrypted_secret into api from marketplace.payment_provider_secret_refs r join vault.decrypted_secrets s on s.id=r.vault_secret_id
 where r.provider_key='tamara' and r.secret_key='apiToken' and r.credentials_environment=c.environment;
 select s.decrypted_secret into notification from marketplace.payment_provider_secret_refs r join vault.decrypted_secrets s on s.id=r.vault_secret_id
 where r.provider_key='tamara' and r.secret_key='notificationToken' and r.credentials_environment=c.environment;
 if nullif(api,'') is null or nullif(notification,'') is null then raise exception 'tamara_credentials_invalid'; end if;
 select max(last_rotated_at) into rotated from marketplace.payment_provider_secret_refs where provider_key='tamara';
 select id into vid from marketplace.tamara_credential_versions where environment=c.environment and source_rotated_at=rotated and revoked_at is null order by created_at desc limit 1;
 if vid is not null then return vid; end if;
 vid:=gen_random_uuid();
 ar:=vault.create_secret(api,'odeir_tamara_api_'||vid::text,'Immutable Tamara attempt credentials');
 nr:=vault.create_secret(notification,'odeir_tamara_notification_'||vid::text,'Immutable Tamara notification credentials');
 insert into marketplace.tamara_credential_versions(id,environment,api_secret_id,notification_secret_id,source_rotated_at)
 values(vid,c.environment,ar,nr,rotated);
 insert into audit_log.events(actor_subject_id,action,resource_type,resource_id,context)
 values(private_app.current_subject_id(),'marketplace.tamara.version_prepared','payment_provider',vid::text,jsonb_build_object('environment',c.environment));
 return vid;
end $$;

create function public.v3_tenant_marketplace_snapshot(p_slug text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b jsonb; tid uuid;
begin
 b:=public.v2_tenant_marketplace_snapshot(p_slug);
 select id into tid from core.tenants where slug=p_slug;
 if private_app.tamara_eligible_v1(tid) then
   b:=jsonb_set(b,'{paymentMethods}',coalesce(b->'paymentMethods','[]'::jsonb)||jsonb_build_array(jsonb_build_object('key','tamara','name','تمارا','checkoutMode','redirect','supportedCurrencies',jsonb_build_array('SAR'))));
 end if;
 return b;
end $$;
CREATE OR REPLACE FUNCTION private_app.marketplace_promotion_attempt_active(p_order_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from marketplace.payment_attempts attempt
    where attempt.order_id = p_order_id
      and (
        attempt.status in (
          'creating_intention','intention_created','pending','unknown',
          'quarantined','paid'
        )
        or (
          attempt.status = 'prepared'
          and attempt.expires_at > now()
        )
        or (
          attempt.status = 'failed'
          and (
            attempt.provider_order_id is not null
            or attempt.provider_intention_id is not null
          )
          and coalesce(attempt.provider_expires_at,attempt.expires_at) > now()
        )
      )
  ) or exists (select 1 from marketplace.tamara_attempts a where a.order_id=p_order_id and a.status not in ('cancelled','refunded'))
$function$;

create function private_app.tamara_item_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from marketplace.tamara_attempts where order_id=old.order_id or order_id=new.order_id) then raise exception 'tamara_snapshot_immutable'; end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger tamara_item_guard before insert or update or delete on marketplace.order_items for each row execute function private_app.tamara_item_guard_v1();

-- Explicit activation requires a separately verified webhook. No data seeded.
create function public.v1_platform_tamara_rollout(p_version_id uuid,p_tenant_id uuid,p_enabled boolean) returns void
language plpgsql security definer set search_path='' as $$
declare v marketplace.tamara_credential_versions%rowtype;
begin
 perform public.v3_platform_payment_provider_admin_snapshot();
 select * into v from marketplace.tamara_credential_versions where id=p_version_id for update;
 if v.id is null or v.revoked_at is not null or (p_enabled and v.webhook_id is null) then raise exception 'tamara_runtime_not_ready'; end if;
 if p_enabled then
   update marketplace.tamara_credential_versions set enabled=false where environment=v.environment and id<>v.id and enabled;
   update marketplace.tamara_credential_versions set enabled=true where id=v.id;
 end if;
 insert into marketplace.tamara_tenant_rollouts(tenant_id,environment,enabled) values(p_tenant_id,v.environment,p_enabled)
 on conflict(tenant_id,environment) do update set enabled=excluded.enabled,updated_at=now();
 insert into audit_log.events(actor_subject_id,tenant_id,action,resource_type,resource_id,context)
 values(private_app.current_subject_id(),p_tenant_id,'marketplace.tamara.rollout_changed','payment_provider',v.id::text,jsonb_build_object('enabled',p_enabled,'environment',v.environment));
end $$;

-- Explicit privileges, including private helpers. No PUBLIC execute defaults.
revoke all on function private_app.tamara_eligible_v1(uuid),private_app.tamara_order_guard_v1(),private_app.tamara_item_guard_v1(),private_app.tamara_provision_v1(uuid),private_app.tamara_reverse_v1(uuid) from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_tamara_create_order(text,jsonb),public.v1_tenant_tamara_prepare(text,uuid),public.v1_tenant_tamara_status(text,uuid),public.v3_tenant_marketplace_snapshot(text),public.v1_platform_tamara_prepare_version(),public.v1_platform_tamara_rollout(uuid,uuid,boolean) from public,anon,service_role;
grant execute on function public.v1_tenant_tamara_create_order(text,jsonb),public.v1_tenant_tamara_prepare(text,uuid),public.v1_tenant_tamara_status(text,uuid),public.v3_tenant_marketplace_snapshot(text),public.v1_platform_tamara_prepare_version(),public.v1_platform_tamara_rollout(uuid,uuid,boolean) to authenticated;
revoke all on function public.v1_service_tamara_claim(uuid),public.v1_service_tamara_mutation(uuid,uuid,text,jsonb),public.v1_service_tamara_release(uuid,uuid,uuid,text,text),public.v1_service_tamara_observe(uuid,uuid,jsonb,text),public.v1_service_tamara_notification_keys(uuid),public.v1_service_tamara_wake(uuid) from public,anon,authenticated;
grant execute on function public.v1_service_tamara_claim(uuid),public.v1_service_tamara_mutation(uuid,uuid,text,jsonb),public.v1_service_tamara_release(uuid,uuid,uuid,text,text),public.v1_service_tamara_observe(uuid,uuid,jsonb,text),public.v1_service_tamara_notification_keys(uuid),public.v1_service_tamara_wake(uuid) to service_role;
create function public.v1_service_tamara_version(p_version_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 return(select jsonb_build_object('id',v.id,'environment',v.environment,'webhook_id',v.webhook_id,'apiToken',s.decrypted_secret)
 from marketplace.tamara_credential_versions v join vault.decrypted_secrets s on s.id=v.api_secret_id where v.id=p_version_id and v.revoked_at is null);
end $$;
create function public.v1_service_tamara_claim_webhook(p_version_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 update marketplace.tamara_credential_versions set webhook_registration_started_at=now()
 where id=p_version_id and webhook_registration_started_at is null and webhook_id is null and revoked_at is null;
 return found;
end $$;
revoke all on function public.v1_service_tamara_claim_webhook(uuid) from public,anon,authenticated;
grant execute on function public.v1_service_tamara_claim_webhook(uuid) to service_role;
create function public.v1_service_tamara_bind_webhook(p_version_id uuid,p_webhook_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 if p_webhook_id is null then raise exception 'tamara_webhook_invalid'; end if;
 update marketplace.tamara_credential_versions set webhook_id=p_webhook_id where id=p_version_id and not enabled and revoked_at is null;
 if not found then raise exception 'tamara_version_not_found'; end if;
end $$;
revoke all on function public.v1_service_tamara_version(uuid),public.v1_service_tamara_bind_webhook(uuid,uuid) from public,anon,authenticated;
grant execute on function public.v1_service_tamara_version(uuid),public.v1_service_tamara_bind_webhook(uuid,uuid) to service_role;

create function public.v1_service_tamara_schedule() returns void
language plpgsql security definer set search_path='' as $$
declare secret_id uuid; worker_key text;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 -- Distinct dispatcher and credential; never touch Paymob's job or Vault refs.
 select id into secret_id from vault.secrets where name='odeir_tamara_worker_v1';
 if secret_id is null then
   worker_key:=gen_random_uuid()::text||gen_random_uuid()::text;
   secret_id:=vault.create_secret(worker_key,'odeir_tamara_worker_v1','Tamara reconciliation dispatcher only');
 end if;
 perform cron.schedule('odeir-tamara-runtime-v1','* * * * *',$job$
   select net.http_post(
     url:='https://gswpbwdactcstkasddta.supabase.co/functions/v1/tamara-reconcile',
     headers:=jsonb_build_object('Content-Type','application/json','x-odeir-tamara-worker-token',
       (select decrypted_secret from vault.decrypted_secrets where name='odeir_tamara_worker_v1')),
     body:='{}'::jsonb,timeout_milliseconds:=55000
   );
 $job$);
end $$;
create function public.v1_service_tamara_worker_authenticated(p_token text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden'; end if;
 if p_token is null or length(p_token)<>72 then return false; end if;
 return exists(select 1 from vault.decrypted_secrets where name='odeir_tamara_worker_v1'
   and extensions.digest(decrypted_secret,'sha256')=extensions.digest(p_token,'sha256'));
end $$;
revoke all on function public.v1_service_tamara_schedule(),public.v1_service_tamara_worker_authenticated(text) from public,anon,authenticated;
grant execute on function public.v1_service_tamara_schedule(),public.v1_service_tamara_worker_authenticated(text) to service_role;

create function public.v1_platform_tamara_runtime_snapshot() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v marketplace.tamara_credential_versions%rowtype; env text;
begin
 perform public.v3_platform_payment_provider_admin_snapshot();
 select environment into env from marketplace.payment_provider_configs where provider_key='tamara';
 select * into v from marketplace.tamara_credential_versions where environment=env and revoked_at is null order by created_at desc limit 1;
 return jsonb_build_object('versionId',v.id,'environment',env,'webhookVerified',v.webhook_id is not null and not exists(select 1 from marketplace.payment_provider_secret_refs where provider_key='tamara' and last_rotated_at>v.source_rotated_at),
 'tenants',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'enabled',coalesce(r.enabled,false)) order by t.name),'[]'::jsonb)
 from core.tenants t left join marketplace.tamara_tenant_rollouts r on r.tenant_id=t.id and r.environment=env));
end $$;
revoke all on function public.v1_platform_tamara_runtime_snapshot() from public,anon,service_role;
grant execute on function public.v1_platform_tamara_runtime_snapshot() to authenticated;

commit;
