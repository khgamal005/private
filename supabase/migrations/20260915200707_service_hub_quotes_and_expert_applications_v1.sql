-- Additive service discovery, reviewed expert applications and tenant quotations.
-- Existing catalog, orders, payment attempts and tenant records are not backfilled.
create table marketplace.service_hub_settings (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false
);
insert into marketplace.service_hub_settings(singleton,enabled) values(true,false);
create table marketplace.service_provider_publications (
  provider_id uuid primary key references marketplace.service_providers(id) on delete restrict,
  published boolean not null default false,
  updated_by uuid references access_control.subjects(id),
  updated_at timestamptz not null default now()
);
create index service_publications_actor_idx on marketplace.service_provider_publications(updated_by);
create table marketplace.expert_applications (
  id uuid primary key default gen_random_uuid(),
  email text not null check(length(email) between 5 and 254),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=18000),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  provider_id uuid references marketplace.service_providers(id) on delete restrict,
  reviewed_by uuid references access_control.subjects(id),
  review_note text check(length(review_note)<=2000),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique(email)
);
create index expert_applications_queue_idx on marketplace.expert_applications(status,created_at desc);
create index expert_applications_provider_idx on marketplace.expert_applications(provider_id);
create index expert_applications_actor_idx on marketplace.expert_applications(reviewed_by);
create table marketplace.expert_application_limits (
  singleton boolean primary key default true check(singleton),
  window_start timestamptz not null default now(),
  submissions integer not null default 0
);
insert into marketplace.expert_application_limits(singleton) values(true);
create table marketplace.service_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  requested_by uuid not null references access_control.subjects(id),
  provider_id uuid references marketplace.service_providers(id) on delete restrict,
  product_id uuid references marketplace.service_products(id) on delete restrict,
  request_key uuid not null,
  brief jsonb not null check(jsonb_typeof(brief)='object' and octet_length(brief::text)<=16000),
  status text not null default 'requested' check(status in ('requested','offered','accepted','declined','cancelled')),
  version integer not null default 1,
  offer jsonb check(offer is null or (jsonb_typeof(offer)='object' and octet_length(offer::text)<=16000)),
  offered_by uuid references access_control.subjects(id),
  offered_at timestamptz,
  expires_at timestamptz,
  order_id uuid unique references marketplace.orders(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,request_key),
  unique(id,tenant_id),
  check((status='accepted')=(order_id is not null))
);
create index service_requests_tenant_idx on marketplace.service_requests(tenant_id,created_at desc);
create index service_requests_queue_idx on marketplace.service_requests(status,created_at desc);
create index service_requests_provider_idx on marketplace.service_requests(provider_id);
create index service_requests_product_idx on marketplace.service_requests(product_id);
create index service_requests_actor_idx on marketplace.service_requests(requested_by);
create index service_requests_offerer_idx on marketplace.service_requests(offered_by);
create table marketplace.service_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  actor_id uuid references access_control.subjects(id),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key(request_id,tenant_id) references marketplace.service_requests(id,tenant_id) on delete restrict
);
create index service_request_events_request_idx on marketplace.service_request_events(request_id,created_at);
create index service_request_events_tenant_idx on marketplace.service_request_events(tenant_id,created_at);
create index service_request_events_actor_idx on marketplace.service_request_events(actor_id);
create table marketplace.service_order_updates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  order_id uuid not null references marketplace.orders(id) on delete restrict,
  actor_id uuid references access_control.subjects(id),
  message text not null check(length(message) between 2 and 2000),
  attachment_url text check(attachment_url is null or (length(attachment_url)<=2000 and attachment_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$')),
  from_platform boolean not null,
  request_key uuid not null,
  created_at timestamptz not null default now(),
  unique(tenant_id,request_key)
);
create index service_order_updates_order_idx on marketplace.service_order_updates(order_id,created_at);
create index service_order_updates_tenant_idx on marketplace.service_order_updates(tenant_id,created_at);
create index service_order_updates_actor_idx on marketplace.service_order_updates(actor_id);

do $$ declare n text; begin
  foreach n in array array['service_hub_settings','service_provider_publications','expert_applications','expert_application_limits','service_requests','service_request_events','service_order_updates'] loop
    execute format('alter table marketplace.%I enable row level security',n);
    execute format('revoke all on marketplace.%I from public,anon,authenticated,service_role',n);
  end loop;
end $$;

create function private_app.require_service_hub_v1() returns void
language plpgsql security definer set search_path='' as $$ begin
  if not exists(select 1 from marketplace.service_hub_settings where enabled) then raise exception 'service_hub_not_enabled'; end if;
end $$;

create function public.v1_public_expert_application(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_email text; v_limit marketplace.expert_application_limits%rowtype;
begin
  perform private_app.require_service_hub_v1();
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>18000
    or coalesce(p_payload->>'consent','')<>'true'
    or coalesce(p_payload->>'type','') not in ('lecturer','trainer','consultant')
    or coalesce(length(btrim(p_payload->>'name')),0) not between 2 and 150
    or coalesce(length(btrim(p_payload->>'title')),0) not between 2 and 180
    or coalesce(length(btrim(p_payload->>'bio')),0) not between 30 and 4000
    or coalesce(length(btrim(p_payload->>'expertise')),0) not between 2 and 1000
    or coalesce(length(btrim(p_payload->>'languages')),0) not between 2 and 300
    or cardinality(regexp_split_to_array(p_payload->>'languages','[,،\n]+'))>20
    or cardinality(regexp_split_to_array(p_payload->>'expertise','[,،\n]+'))>30
    or coalesce(length(btrim(p_payload->>'city')),0) not between 2 and 100
    or coalesce(p_payload->>'phone','') !~ '^\+?[0-9 ()-]{7,40}$'
    or coalesce(p_payload->>'yearsExperience','') !~ '^[0-9]{1,2}$'
  then raise exception 'service_application_invalid'; end if;
  if (p_payload->>'yearsExperience')::integer>80 then raise exception 'service_application_invalid'; end if;
  v_email:=lower(btrim(p_payload->>'email'));
  if coalesce(v_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email)>254
    or (coalesce(p_payload->>'portfolioUrl','')<>'' and (length(p_payload->>'portfolioUrl')>2000 or p_payload->>'portfolioUrl' !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'))
  then raise exception 'service_application_invalid'; end if;
  -- The singleton bounds anonymous writes and storage without trusting forwarded IPs.
  select * into v_limit from marketplace.expert_application_limits where singleton for update;
  if v_limit.window_start < now()-interval '1 hour' then
    update marketplace.expert_application_limits set window_start=now(),submissions=0 where singleton;
  elsif v_limit.submissions>=100 then raise exception 'service_application_rate_limited'; end if;
  update marketplace.expert_application_limits set submissions=submissions+1 where singleton;
  -- Same response for new and existing emails; never overwrite an earlier submission.
  insert into marketplace.expert_applications(email,payload)
  values(v_email,jsonb_build_object('name',btrim(p_payload->>'name'),'title',btrim(p_payload->>'title'),
    'email',v_email,'phone',btrim(p_payload->>'phone'),'bio',btrim(p_payload->>'bio'),
    'expertise',p_payload->>'expertise','languages',p_payload->>'languages','city',p_payload->>'city',
    'yearsExperience',(p_payload->>'yearsExperience')::integer,'type',p_payload->>'type',
    'portfolioUrl',nullif(p_payload->>'portfolioUrl',''),'consent',true,'consentVersion','expert-application-v1'))
  on conflict(email) do nothing;
  return jsonb_build_object('received',true);
end $$;

create function public.v1_public_expert_registration_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',coalesce((select enabled from marketplace.service_hub_settings where singleton),false));
$$;

create function private_app.service_provider_visible_v1(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from marketplace.service_providers p
    left join marketplace.service_provider_publications pub on pub.provider_id=p.id
    where p.id=p_id and p.status='active' and
    coalesce(pub.published,exists(select 1 from marketplace.service_products s join marketplace.service_categories c on c.id=s.category_id
      where s.provider_id=p.id and s.marketplace_visible and s.status in ('active','beta') and c.status='active')));
$$;

create function private_app.service_request_payload_v1(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',r.id,'tenantId',r.tenant_id,'tenantName',t.name,'status',r.status,'version',r.version,
    'brief',r.brief,'offer',r.offer,'expiresAt',r.expires_at,'orderId',r.order_id,'createdAt',r.created_at,
    'providerId',r.provider_id,'providerName',p.display_name_ar,'productId',r.product_id,
    'events',coalesce((select jsonb_agg(jsonb_build_object('type',e.event_type,'at',e.created_at) order by e.created_at)
      from marketplace.service_request_events e where e.request_id=r.id),'[]'::jsonb))
  from marketplace.service_requests r join core.tenants t on t.id=r.tenant_id
  left join marketplace.service_providers p on p.id=r.provider_id where r.id=p_id;
$$;

create function public.v1_service_hub_snapshot(p_slug text default null,p_page integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tid uuid; admin boolean:=false; result jsonb; skip_count integer:=greatest(0,least(coalesce(p_page,0),10000))*30;
begin
  if p_slug is null then
    if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden'; end if;
    admin:=true;
  else
    select id into tid from core.tenants where slug=p_slug;
    if tid is null or not private_app.has_tenant_permission(tid,'tenant.settings.manage') then raise exception 'forbidden'; end if;
  end if;
  if not exists(select 1 from marketplace.service_hub_settings where enabled) then return jsonb_build_object('enabled',false); end if;
  result:=jsonb_build_object('enabled',true,'page',coalesce(p_page,0),
    'requestCount',(select count(*) from marketplace.service_requests r where admin or r.tenant_id=tid),
    'requests',coalesce((select jsonb_agg(private_app.service_request_payload_v1(r.id) order by r.created_at desc) from (
      select id,created_at from marketplace.service_requests where admin or tenant_id=tid order by created_at desc,id limit 30 offset skip_count
    ) r),'[]'::jsonb),
    'expertCount',(select count(*) from marketplace.service_providers p where private_app.service_provider_visible_v1(p.id)),
    'experts',coalesce((select jsonb_agg(private_app.service_provider_public_payload(p.id)||jsonb_build_object(
      'courses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title_ar,'summary',c.summary_ar,
        'durationHours',c.duration_hours,'deliveryModes',c.delivery_modes,'language',c.language_ar))
        from marketplace.service_provider_courses c where c.provider_id=p.id and c.status='active'),'[]'::jsonb)) order by p.display_order,p.id)
      from (select id,display_order from marketplace.service_providers where private_app.service_provider_visible_v1(id) order by display_order,id limit 30 offset skip_count) p),'[]'::jsonb));
  if admin then
    result:=result||jsonb_build_object(
      'applicationCount',(select count(*) from marketplace.expert_applications where status='pending'),
      'applicationTotal',(select count(*) from marketplace.expert_applications),
      'applications',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from (
        select id,payload,status,provider_id,created_at,review_note from marketplace.expert_applications order by (status='pending') desc,created_at desc,id limit 30 offset skip_count
      ) a),'[]'::jsonb),
      'publications',coalesce((select jsonb_agg(jsonb_build_object('providerId',p.id,'published',private_app.service_provider_visible_v1(p.id))) from marketplace.service_providers p),'[]'::jsonb),
      'reviews',coalesce((select jsonb_agg(to_jsonb(r)) from (select id,rating,review_text,created_at from marketplace.service_reviews where moderation_status='pending' order by created_at limit 30) r),'[]'::jsonb));
  end if;
  return result;
end $$;

create function private_app.service_order_thread_v1(p_order_id uuid,p_tenant_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('updates',coalesce((select jsonb_agg(to_jsonb(u) order by u.created_at) from (
   select id,message,attachment_url,from_platform,created_at from marketplace.service_order_updates where order_id=p_order_id and tenant_id=p_tenant_id order by created_at desc limit 100
 ) u),'[]'::jsonb),'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from (
   select event_type,to_status,created_at from marketplace.order_events where order_id=p_order_id and tenant_id=p_tenant_id order by created_at desc limit 100
 ) e),'[]'::jsonb));
$$;

create function private_app.service_order_note_v1(p_payload jsonb,p_tenant_id uuid,p_admin boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o marketplace.orders%rowtype; note_id uuid;
begin
 select * into o from marketplace.orders where id=(p_payload->>'orderId')::uuid and (p_admin or tenant_id=p_tenant_id) and order_kind='service' for update;
 if o.id is null then raise exception 'service_request_not_found'; end if;
 if coalesce(length(btrim(p_payload->>'message')),0) not between 2 and 2000 or nullif(p_payload->>'requestKey','') is null
   or (coalesce(p_payload->>'attachmentUrl','')<>'' and (length(p_payload->>'attachmentUrl')>2000 or p_payload->>'attachmentUrl' !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'))
 then raise exception 'service_request_invalid'; end if;
 insert into marketplace.service_order_updates(tenant_id,order_id,actor_id,message,attachment_url,from_platform,request_key)
 values(o.tenant_id,o.id,private_app.current_subject_id(),btrim(p_payload->>'message'),nullif(p_payload->>'attachmentUrl',''),p_admin,(p_payload->>'requestKey')::uuid)
 on conflict(tenant_id,request_key) do nothing returning id into note_id;
 return jsonb_build_object('saved',true);
end $$;

create function public.v1_tenant_service_hub_action(p_slug text,p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tid uuid; actor uuid; r marketplace.service_requests%rowtype; o marketplace.orders%rowtype;
  p marketplace.service_products%rowtype; provider marketplace.payment_provider_configs%rowtype;
  amount bigint; tax bigint; request_id uuid; v_request_key uuid; v_provider uuid; v_product uuid;
begin
 select id into tid from core.tenants where slug=p_slug;
 if tid is null or not private_app.has_tenant_permission(tid,'tenant.settings.manage') then raise exception 'forbidden'; end if;
 perform private_app.require_service_hub_v1(); actor:=private_app.current_subject_id();
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>22000 then raise exception 'service_request_invalid'; end if;
 if p_action='snapshot' then return public.v1_service_hub_snapshot(p_slug,coalesce((p_payload->>'page')::integer,0)); end if;
 if p_action='order_thread' then
   select * into o from marketplace.orders where id=(p_payload->>'orderId')::uuid and tenant_id=tid and order_kind='service';
   if o.id is null then raise exception 'service_request_not_found'; end if;
   return private_app.service_order_thread_v1(o.id,tid);
 end if;
 if p_action='order_note' then return private_app.service_order_note_v1(p_payload,tid,false); end if;
 if p_action='request' then
   v_request_key:=(p_payload->>'requestKey')::uuid;
   if v_request_key is null or coalesce(length(btrim(p_payload->>'title')),0) not between 2 and 180
     or coalesce(length(btrim(p_payload->>'details')),0) not between 10 and 4000
     or coalesce(p_payload->>'deliveryMode','') not in ('online','onsite','hybrid')
     or (p_payload->>'deliveryMode' in ('onsite','hybrid') and coalesce(length(btrim(p_payload->>'city')),0) not between 2 and 100)
   then raise exception 'service_request_invalid'; end if;
   perform pg_advisory_xact_lock(hashtextextended(tid::text||':service-requests',0));
   select * into r from marketplace.service_requests where tenant_id=tid and service_requests.request_key=v_request_key;
   if r.id is not null then return private_app.service_request_payload_v1(r.id); end if;
   if (select count(*) from marketplace.service_requests where tenant_id=tid and created_at>now()-interval '1 hour')>=20 then raise exception 'service_application_rate_limited'; end if;
   v_provider:=nullif(p_payload->>'providerId','')::uuid; v_product:=nullif(p_payload->>'productId','')::uuid;
   if v_provider is not null and not private_app.service_provider_visible_v1(v_provider) then raise exception 'service_provider_not_ready'; end if;
   if v_product is not null then
     select s.* into p from marketplace.service_products s join marketplace.service_categories c on c.id=s.category_id
       where s.id=v_product and s.marketplace_visible and s.status in ('active','beta') and c.status='active';
     if p.id is null or (p.provider_id is not null and not exists(select 1 from marketplace.service_providers where id=p.provider_id and status='active')) then raise exception 'service_request_invalid'; end if;
     if v_provider is not null and p.provider_id is distinct from v_provider then raise exception 'service_request_invalid'; end if;
     v_provider:=p.provider_id;
   end if;
   -- The date is a preferred date, confirmed in the offer; it is not a UTC deadline.
   if coalesce(p_payload->>'participants','')<>'' and (p_payload->>'participants')::integer not between 1 and 100000 then raise exception 'service_request_invalid'; end if;
   insert into marketplace.service_requests(tenant_id,requested_by,provider_id,product_id,request_key,brief)
   values(tid,actor,v_provider,v_product,v_request_key,jsonb_build_object('title',btrim(p_payload->>'title'),'details',btrim(p_payload->>'details'),
     'date',nullif(p_payload->>'date',''),'deliveryMode',p_payload->>'deliveryMode','city',left(p_payload->>'city',100),
     'participants',nullif(p_payload->>'participants','')::integer,'budget',left(p_payload->>'budget',100))) returning id into request_id;
   insert into marketplace.service_request_events(request_id,tenant_id,actor_id,event_type) values(request_id,tid,actor,'requested');
   return private_app.service_request_payload_v1(request_id);
 end if;
 select * into r from marketplace.service_requests where id=(p_payload->>'id')::uuid and tenant_id=tid for update;
 if r.id is null then raise exception 'service_request_not_found'; end if;
 if p_action='accept' and r.status='accepted' then
   return private_app.marketplace_order_payload(r.order_id)||jsonb_build_object('quoteId',r.id,'duplicate',true);
 end if;
 if r.version is distinct from (p_payload->>'version')::integer then raise exception 'service_request_conflict'; end if;
 if p_action in ('decline','cancel') then
   if r.status not in ('requested','offered') then raise exception 'service_request_conflict'; end if;
   update marketplace.service_requests set status=case when p_action='cancel' then 'cancelled' else 'declined' end,version=version+1,updated_at=now() where id=r.id;
 elsif p_action='accept' then
   if r.status<>'offered' then raise exception 'service_request_conflict'; end if;
   if r.expires_at<=now() then raise exception 'service_offer_expired'; end if;
   select * into p from marketplace.service_products where id=r.product_id for share;
   if p.id is null or p.status not in ('active','beta') then raise exception 'service_request_invalid'; end if;
   if r.provider_id is not null and not exists(select 1 from marketplace.service_providers where id=r.provider_id and status='active') then raise exception 'service_provider_not_ready'; end if;
   select * into provider from marketplace.payment_provider_configs where provider_key=p_payload->>'paymentProvider';
   if provider.provider_key is null or provider.provider_key not in ('bank_transfer','paymob','tamara') then raise exception 'marketplace_payment_provider_unavailable'; end if;
   if provider.provider_key='paymob' then
     if not private_app.paymob_tenant_checkout_eligible_v1(tid,provider.environment) then raise exception 'marketplace_payment_provider_unavailable'; end if;
   elsif provider.provider_key='tamara' then
     if not private_app.tamara_eligible_v1(tid) then raise exception 'marketplace_payment_provider_unavailable'; end if;
   elsif provider.status<>'active' or provider.last_verified_at is null or not ('SAR'=any(provider.supported_currencies)) then raise exception 'marketplace_payment_provider_unavailable'; end if;
   amount:=(r.offer->>'amountMinor')::bigint; tax:=round(amount*0.15)::bigint;
   insert into marketplace.orders(tenant_id,requested_by_subject_id,order_kind,status,payment_status,activation_state,currency,
     subtotal_minor,list_subtotal_minor,discount_minor,tax_minor,total_minor,tax_rate_bps,payment_provider,notes,idempotency_key)
   values(tid,actor,'service','pending_payment','pending','not_applicable','SAR',amount,amount,0,tax,amount+tax,1500,
     provider.provider_key,'عرض خدمة معتمد','service-quote:'||r.id) returning * into o;
   insert into marketplace.order_items(order_id,item_type,service_product_id,product_key,product_name_ar,quantity,unit_amount_minor,line_total_minor,metadata)
   values(o.id,'service',p.id,p.product_key,r.offer->>'title',1,amount,amount,jsonb_build_object('quoteId',r.id,'quoteVersion',r.version,'quote',r.offer));
   insert into marketplace.service_order_briefs(order_id,tenant_id,provider_id,preferred_start_date,delivery_mode,brief)
   values(o.id,tid,r.provider_id,nullif(r.brief->>'date','')::date,r.brief->>'deliveryMode',r.brief||jsonb_build_object('approvedOffer',r.offer));
   if r.provider_id is not null then
     insert into marketplace.service_order_assignments(order_id,tenant_id,provider_id,status) values(o.id,tid,r.provider_id,'pending');
   end if;
   update marketplace.service_requests set status='accepted',order_id=o.id,version=version+1,updated_at=now() where id=r.id;
   insert into marketplace.order_events(order_id,tenant_id,actor_subject_id,event_type,to_status,metadata)
   values(o.id,tid,actor,'service_quote_accepted','pending_payment',jsonb_build_object('quoteId',r.id,'offer',r.offer));
 else raise exception 'service_request_invalid'; end if;
 insert into marketplace.service_request_events(request_id,tenant_id,actor_id,event_type,payload)
 values(r.id,tid,actor,p_action,jsonb_build_object('version',r.version,'orderId',o.id));
 if o.id is not null then return private_app.marketplace_order_payload(o.id)||jsonb_build_object('quoteId',r.id); end if;
 return private_app.service_request_payload_v1(r.id);
end $$;

create function public.v1_platform_service_hub_action(p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a marketplace.expert_applications%rowtype; p marketplace.service_providers%rowtype; r marketplace.service_requests%rowtype;
  v_provider uuid; v_product uuid; amount bigint; expiry timestamptz; o marketplace.orders%rowtype;
begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>22000 then raise exception 'service_request_invalid'; end if;
 perform private_app.require_service_hub_v1();
 if p_action='snapshot' then return public.v1_service_hub_snapshot(null,coalesce((p_payload->>'page')::integer,0)); end if;
 if p_action='order_note' then return private_app.service_order_note_v1(p_payload,null,true); end if;
 if p_action='order_thread' then
   select * into o from marketplace.orders where id=(p_payload->>'orderId')::uuid and order_kind='service';
   if o.id is null then raise exception 'service_request_not_found'; end if;
   return private_app.service_order_thread_v1(o.id,o.tenant_id);
 end if;
 if p_action in ('approve_application','reject_application') then
   select * into a from marketplace.expert_applications where id=(p_payload->>'id')::uuid for update;
   if a.id is null then raise exception 'service_request_not_found'; end if;
   if a.status<>'pending' then return jsonb_build_object('status',a.status,'providerId',a.provider_id); end if;
   if p_action='approve_application' then
     v_provider:=nullif(p_payload->>'providerId','')::uuid;
     perform pg_advisory_xact_lock(hashtextextended('expert-email:'||a.email,0));
     if v_provider is null then
       if exists(select 1 from marketplace.service_provider_contacts where lower(email)=a.email) then raise exception 'service_application_duplicate_provider'; end if;
       insert into marketplace.service_providers(provider_key,provider_type,display_name_ar,professional_title_ar,short_bio_ar,bio_ar,city_ar,
         years_experience,languages,expertise_tags,status,verification_status)
       values('expert_'||replace(a.id::text,'-',''),a.payload->>'type',a.payload->>'name',a.payload->>'title',left(a.payload->>'bio',500),a.payload->>'bio',a.payload->>'city',
         (a.payload->>'yearsExperience')::smallint,regexp_split_to_array(a.payload->>'languages','[,،\n]+'),regexp_split_to_array(a.payload->>'expertise','[,،\n]+'),'draft','pending') returning id into v_provider;
       insert into marketplace.service_provider_contacts(provider_id,email,phone,website_url) values(v_provider,a.email,a.payload->>'phone',a.payload->>'portfolioUrl');
     elsif not exists(select 1 from marketplace.service_providers where id=v_provider) then raise exception 'service_request_invalid'; end if;
   end if;
   update marketplace.expert_applications set status=case when p_action='approve_application' then 'approved' else 'rejected' end,
     provider_id=v_provider,reviewed_by=private_app.current_subject_id(),reviewed_at=now(),review_note=left(p_payload->>'note',2000) where id=a.id;
   insert into audit_log.events(actor_subject_id,action,resource_type,resource_id,context)
   values(private_app.current_subject_id(),'marketplace.expert_application.reviewed','expert_application',a.id::text,jsonb_build_object('decision',p_action,'providerId',v_provider));
   return jsonb_build_object('providerId',v_provider);
 elsif p_action='publish_provider' then
   select * into p from marketplace.service_providers where id=(p_payload->>'providerId')::uuid for update;
   if p.id is null then raise exception 'service_request_invalid'; end if;
   if coalesce((p_payload->>'published')::boolean,false) and (p.status<>'active' or coalesce(length(p.short_bio_ar),0)<10 or cardinality(p.expertise_tags)=0) then raise exception 'service_provider_not_ready'; end if;
   insert into marketplace.service_provider_publications(provider_id,published,updated_by)
   values(p.id,(p_payload->>'published')::boolean,private_app.current_subject_id())
   on conflict(provider_id) do update set published=excluded.published,updated_by=excluded.updated_by,updated_at=now();
   insert into audit_log.events(actor_subject_id,action,resource_type,resource_id,context)
   values(private_app.current_subject_id(),'marketplace.expert.published','service_provider',p.id::text,jsonb_build_object('published',p_payload->'published'));
   return jsonb_build_object('saved',true);
 elsif p_action='moderate_review' then
   if coalesce(p_payload->>'status','') not in ('approved','rejected','hidden') then raise exception 'service_request_invalid'; end if;
   update marketplace.service_reviews set moderation_status=p_payload->>'status',updated_at=now() where id=(p_payload->>'id')::uuid;
   if not found then raise exception 'service_request_not_found'; end if;
   insert into audit_log.events(actor_subject_id,action,resource_type,resource_id,context)
   values(private_app.current_subject_id(),'marketplace.service_review.moderated','service_review',p_payload->>'id',jsonb_build_object('status',p_payload->>'status'));
   return jsonb_build_object('saved',true);
 elsif p_action='offer' then
   select * into r from marketplace.service_requests where id=(p_payload->>'id')::uuid for update;
   if r.id is null then raise exception 'service_request_not_found'; end if;
   if r.status not in ('requested','offered','declined') or r.version is distinct from (p_payload->>'version')::integer then raise exception 'service_request_conflict'; end if;
   v_product:=(p_payload->>'productId')::uuid; v_provider:=nullif(p_payload->>'providerId','')::uuid;
   amount:=(p_payload->>'amountMinor')::bigint; expiry:=(p_payload->>'expiresAt')::timestamptz;
   if amount is null or amount not between 1 and 100000000 or expiry is null or expiry<=now() or expiry>now()+interval '90 days'
     or coalesce(length(btrim(p_payload->>'title')),0) not between 2 and 180
     or coalesce(length(btrim(p_payload->>'scope')),0) not between 10 and 4000
     or not exists(select 1 from marketplace.service_products where id=v_product and status in ('active','beta'))
     or (v_provider is not null and not exists(select 1 from marketplace.service_providers where id=v_provider and status='active'))
   then raise exception 'service_request_invalid'; end if;
   update marketplace.service_requests set status='offered',product_id=v_product,provider_id=v_provider,
     offer=jsonb_build_object('title',btrim(p_payload->>'title'),'scope',btrim(p_payload->>'scope'),'exclusions',left(p_payload->>'exclusions',2000),
       'delivery',left(p_payload->>'delivery',500),'revisions',left(p_payload->>'revisions',300),'amountMinor',amount,'currency','SAR',
       'taxMinor',round(amount*0.15)::bigint,'totalMinor',amount+round(amount*0.15)::bigint),
     version=version+1,offered_by=private_app.current_subject_id(),offered_at=now(),expires_at=expiry,updated_at=now() where id=r.id;
   insert into marketplace.service_request_events(request_id,tenant_id,actor_id,event_type,payload)
   select r.id,r.tenant_id,private_app.current_subject_id(),'offered',jsonb_build_object('offer',s.offer,'version',s.version,'expiresAt',s.expires_at) from marketplace.service_requests s where id=r.id;
   return private_app.service_request_payload_v1(r.id);
 end if;
 raise exception 'service_request_invalid';
end $$;

-- An accepted quotation is immutable even if the catalog or discounts change.
create function private_app.service_quote_order_matches_v1(p_order_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from marketplace.service_requests r join marketplace.orders o on o.id=r.order_id and o.tenant_id=r.tenant_id
   join marketplace.order_items i on i.order_id=o.id
   where o.id=p_order_id and r.status='accepted' and i.service_product_id=r.product_id and i.quantity=1
   and i.unit_amount_minor=(r.offer->>'amountMinor')::bigint and o.subtotal_minor=i.unit_amount_minor
   and i.line_total_minor=i.unit_amount_minor and i.item_type='service' and o.order_kind='service'
   and o.list_subtotal_minor=o.subtotal_minor and o.discount_minor=0 and o.currency='SAR'
   and o.tax_minor=(r.offer->>'taxMinor')::bigint and o.tax_rate_bps=1500
   and o.total_minor=(r.offer->>'totalMinor')::bigint and i.metadata->>'quoteId'=r.id::text
   and (select count(*) from marketplace.order_items where order_id=o.id)=1);
$$;
create function private_app.service_quote_order_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if exists(select 1 from marketplace.service_requests where order_id=old.id) and
   (new.tenant_id,new.order_kind,new.payment_provider,new.subtotal_minor,new.list_subtotal_minor,new.discount_minor,new.total_minor,new.tax_minor,new.tax_rate_bps,new.currency)
   is distinct from (old.tenant_id,old.order_kind,old.payment_provider,old.subtotal_minor,old.list_subtotal_minor,old.discount_minor,old.total_minor,old.tax_minor,old.tax_rate_bps,old.currency)
 then raise exception 'service_quote_payment_locked'; end if;
 return new;
end $$;
create trigger service_quote_order_guard before update on marketplace.orders for each row execute function private_app.service_quote_order_guard_v1();

create function private_app.service_quote_item_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if exists(select 1 from marketplace.service_requests where order_id in (old.order_id,new.order_id))
 then raise exception 'service_quote_payment_locked'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger service_quote_item_guard before insert or update or delete on marketplace.order_items
 for each row execute function private_app.service_quote_item_guard_v1();

-- Amend only the catalog-package check. All existing eligibility, intent, expiry,
-- signature, payment reconciliation and amount checks remain in the payment RPC.
-- Fail closed if the expected deployed contracts have changed.
do $patch$
declare definition text; needle text; replacement text;
begin
 select pg_get_functiondef('public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'::regprocedure) into definition;
 needle:='and product.pricing_mode in (''from'',''quote'')';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'service_hub_paymob_contract_changed'; end if;
 replacement:=needle||E'\n      and not private_app.service_quote_order_matches_v1(v_order.id)';
 execute replace(definition,needle,replacement);
 select pg_get_functiondef('public.v1_tenant_marketplace_replace_payment(text,jsonb)'::regprocedure) into definition;
 needle:='if o.id is null or i.id is null then raise exception ''marketplace_order_not_found''; end if;';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'service_hub_payment_replace_contract_changed'; end if;
 replacement:=needle||E'\n if exists(select 1 from marketplace.service_requests where order_id=o.id and tenant_id=t.id) then raise exception ''service_quote_payment_locked''; end if;';
 execute replace(definition,needle,replacement);
end $patch$;

-- Least privilege: private helpers and all new tables are reachable only through checked RPCs.
revoke all on function private_app.require_service_hub_v1(),private_app.service_provider_visible_v1(uuid),
 private_app.service_request_payload_v1(uuid),private_app.service_order_thread_v1(uuid,uuid),private_app.service_order_note_v1(jsonb,uuid,boolean),
 private_app.service_quote_order_matches_v1(uuid),private_app.service_quote_order_guard_v1(),private_app.service_quote_item_guard_v1() from public,anon,authenticated,service_role;
revoke all on function public.v1_public_expert_registration_status(),public.v1_public_expert_application(jsonb),public.v1_service_hub_snapshot(text,integer),
 public.v1_tenant_service_hub_action(text,text,jsonb),public.v1_platform_service_hub_action(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_public_expert_application(jsonb),public.v1_public_expert_registration_status() to anon;
grant execute on function public.v1_service_hub_snapshot(text,integer),public.v1_tenant_service_hub_action(text,text,jsonb),public.v1_platform_service_hub_action(text,jsonb) to authenticated;
notify pgrst,'reload schema';
