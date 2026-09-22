-- Native training-course commerce. Additive and disabled by default.
-- This is distinct from ODEIR's platform add-on/services marketplace.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

create table academy.store_settings (
 tenant_id uuid primary key references core.tenants(id),
 checkout_enabled boolean not null default false,
 bank_name text not null default '', account_name text not null default '', iban text not null default '',
 instructions text not null default '', refund_policy text not null default '',
 updated_by_subject_id uuid references access_control.subjects(id), updated_at timestamptz not null default now(),
 check(length(bank_name)<=120 and length(account_name)<=200 and length(iban)<=34 and length(instructions)<=2000 and length(refund_policy)<=4000),
 check(not checkout_enabled or (length(bank_name)>1 and length(account_name)>1 and iban ~ '^[A-Z]{2}[0-9A-Z]{13,32}$' and length(refund_policy)>=10))
);
create table academy.store_offers (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id),
 course_id uuid not null, run_id uuid not null, learning_mode text not null check(learning_mode in ('self_paced','cohort')),
 title text not null check(length(title) between 2 and 200), description text not null default '' check(length(description)<=6000),
 net_minor bigint not null check(net_minor between 1 and 100000000), tax_rate_bps integer not null check(tax_rate_bps between 0 and 10000),
 tax_category text not null check(tax_category in ('standard','out_of_scope')),
 currency text not null check(currency in ('SAR','EGP','USD')), published boolean not null default false,
 version integer not null default 1, created_by_subject_id uuid references access_control.subjects(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id), foreign key(tenant_id,course_id) references academy.courses(tenant_id,id),
 foreign key(tenant_id,run_id) references academy.course_runs(tenant_id,id),
 unique(tenant_id,course_id,run_id)
);
create index academy_store_offers_public_idx on academy.store_offers(tenant_id,published,created_at desc,id);
create table academy.store_orders (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id), offer_id uuid not null,
 command_id uuid not null, access_hash text not null check(access_hash ~ '^[0-9a-f]{64}$'), request_hash text not null,
 learner jsonb not null check(jsonb_typeof(learner)='object'), payer jsonb not null check(jsonb_typeof(payer)='object'),
 phone_key text not null, title text not null, net_minor bigint not null check(net_minor>0),
 tax_minor bigint not null check(tax_minor>=0), total_minor bigint not null check(total_minor=net_minor+tax_minor),
 tax_rate_bps integer not null, tax_category text not null, currency text not null,
 status text not null default 'pending_payment' check(status in ('pending_payment','payment_review','enrolled','rejected')),
 bank_snapshot jsonb not null, policy_snapshot text not null,
 reported_reference text, reported_at timestamptz, received_at timestamptz,
 verified_reference text, verified_by_subject_id uuid references access_control.subjects(id), verified_at timestamptz,
 review_note text, handoff_id uuid, student_id uuid, enrollment_id uuid, invoice_id uuid, payment_id uuid,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id), unique(tenant_id,command_id), unique(tenant_id,handoff_id), unique(tenant_id,enrollment_id),
 foreign key(tenant_id,offer_id) references academy.store_offers(tenant_id,id),
 foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
 foreign key(tenant_id,student_id) references academy.students(tenant_id,id),
 foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id),
 foreign key(tenant_id,invoice_id) references accounting_core.sales_documents(tenant_id,id),
 foreign key(tenant_id,payment_id) references accounting_core.payments(tenant_id,id)
);
create unique index academy_store_bank_reference_unique on academy.store_orders(tenant_id,verified_reference) where verified_reference is not null;
create index academy_store_orders_review_idx on academy.store_orders(tenant_id,status,created_at desc,id);
create index academy_store_orders_rate_idx on academy.store_orders(tenant_id,phone_key,created_at desc);
create index academy_store_orders_time_idx on academy.store_orders(tenant_id,created_at desc);
create table academy.store_commands (
 tenant_id uuid not null references core.tenants(id), command_id uuid not null, actor_subject_id uuid not null references access_control.subjects(id),
 action text not null, request_hash text not null, result jsonb, created_at timestamptz not null default now(), primary key(tenant_id,command_id)
);
alter table academy.store_settings enable row level security;
alter table academy.store_settings force row level security;
alter table academy.store_offers enable row level security;
alter table academy.store_offers force row level security;
alter table academy.store_orders enable row level security;
alter table academy.store_orders force row level security;
alter table academy.store_commands enable row level security;
alter table academy.store_commands force row level security;
revoke all on academy.store_settings,academy.store_offers,academy.store_orders,academy.store_commands from public,anon,authenticated,service_role;

create function private_app.academy_store_tenant_v1(p_slug text) returns uuid language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 select id into t from core.tenants where slug=p_slug and status in ('trial','active');
 if t is null or private_app.academy_platform_enabled_v1(t,'store') is not true then raise exception 'academy_store_unavailable' using errcode='42501'; end if;
 return t;
end $$;
create function private_app.academy_store_settings_authorized_v1(t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(private_app.academy_has_permission_v1(t,'manageStore') and
  ((exists(select 1 from academy.platform_settings where tenant_id=t and mode='standalone') and private_app.academy_has_permission_v1(t,'verifyPayments'))
   or private_app.has_accounting_permission(t,'tenant.accounting.settings.manage')),false)
$$;
create function private_app.academy_store_order_view_v1(o academy.store_orders) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',o.id,'reference','TR-'||upper(left(replace(o.id::text,'-',''),12)),
 'title',o.title,'status',o.status,'netMinor',o.net_minor,'taxMinor',o.tax_minor,'totalMinor',o.total_minor,'currency',o.currency,
 'bank',o.bank_snapshot,'refundPolicy',o.policy_snapshot,'reportedReference',o.reported_reference,'reviewNote',o.review_note,'createdAt',o.created_at)
$$;
create function public.v1_academy_storefront(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid; result jsonb; cfg academy.store_settings%rowtype;
begin
 t:=private_app.academy_store_tenant_v1(p_slug);
 select * into cfg from academy.store_settings where tenant_id=t;
 select jsonb_build_object('tenant',jsonb_build_object('slug',c.slug,'name',c.name),'checkoutEnabled',coalesce(cfg.checkout_enabled,false),'refundPolicy',coalesce(cfg.refund_policy,''),
 'offers',coalesce((select jsonb_agg(x.row) from (select jsonb_build_object('id',o.id,'title',o.title,'description',o.description,
 'learningMode',o.learning_mode,'totalMinor',o.net_minor+round(o.net_minor::numeric*o.tax_rate_bps/10000)::bigint,
 'netMinor',o.net_minor,'taxMinor',round(o.net_minor::numeric*o.tax_rate_bps/10000)::bigint,'currency',o.currency,
 'startsAt',r.starts_at,'endsAt',r.ends_at,'available',r.status='open' and (r.capacity is null or r.enrolled_count<r.capacity)
 and (r.registration_opens_at is null or r.registration_opens_at<=now()) and (r.registration_closes_at is null or r.registration_closes_at>now())) row
 from academy.store_offers o join academy.course_runs r on r.tenant_id=t and r.id=o.run_id
 join academy.courses course on course.tenant_id=t and course.id=o.course_id and course.status='active' and course.program_kind='short_course'
 where o.tenant_id=t and o.published and exists(select 1 from academy.training_course_versions v where v.tenant_id=t and v.course_id=o.course_id and v.status='published' and (o.learning_mode<>'self_paced' or v.learning_mode='self_paced'))
 order by o.created_at desc,o.id limit 100)x),'[]')) into result from core.tenants c where c.id=t;
 return result;
end $$;

-- Anonymous checkout creates a bounded pending request only: never a contact,
-- paid record, enrollment, staff membership or a learner account.
create function public.v1_academy_store_order(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; cfg academy.store_settings%rowtype; offer academy.store_offers%rowtype; run academy.course_runs%rowtype;
 o academy.store_orders%rowtype; learner jsonb; payer jsonb; phone text; hash text; token text; ref text;
begin
 t:=private_app.academy_store_tenant_v1(p_slug);
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>12000 then raise exception 'invalid_request';end if;
 token:=p_payload->>'tokenHash';
 if token is null or token!~'^[0-9a-f]{64}$' then raise exception 'invalid_request';end if;
 if p_action in ('view','report_transfer') then
  select * into o from academy.store_orders where tenant_id=t and id=(p_payload->>'orderId')::uuid and access_hash=token for update;
  if o.id is null then raise exception 'academy_order_not_found';end if;
  if p_action='report_transfer' then
   if o.status not in ('pending_payment','payment_review') then raise exception 'academy_order_not_editable';end if;
   ref:=btrim(coalesce(p_payload->>'reference',''));
   if length(ref) not between 4 and 120 then raise exception 'academy_payment_reference_required';end if;
   update academy.store_orders set reported_reference=ref,reported_at=now(),status='payment_review',updated_at=now() where id=o.id returning * into o;
  end if;
  return private_app.academy_store_order_view_v1(o);
 end if;
 if p_action<>'create_order' or p_command_id is null or p_payload->>'acceptedPolicy' is distinct from 'true' then raise exception 'invalid_request';end if;
 -- This lock serializes the tenant rate check, including direct RPC calls.
 perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-store-intake',220926));
 hash:=md5(p_payload::text);
 select * into o from academy.store_orders where tenant_id=t and command_id=p_command_id;
 if o.id is not null then
  if o.access_hash<>token or o.request_hash<>hash then raise exception 'command_conflict';end if;
  return private_app.academy_store_order_view_v1(o);
 end if;
 select * into cfg from academy.store_settings where tenant_id=t and checkout_enabled;
 if cfg.tenant_id is null then raise exception 'academy_checkout_disabled';end if;
 select * into offer from academy.store_offers where tenant_id=t and id=(p_payload->>'offerId')::uuid and published;
 if offer.id is null then raise exception 'academy_offer_unavailable';end if;
 select * into run from academy.course_runs where tenant_id=t and id=offer.run_id and course_id=offer.course_id and status='open';
 if run.id is null or (run.registration_opens_at is not null and run.registration_opens_at>now()) or (run.registration_closes_at is not null and run.registration_closes_at<=now()) then raise exception 'academy_offer_unavailable';end if;
 if run.capacity is not null and run.enrolled_count>=run.capacity then raise exception 'course_run_full';end if;
 if not exists(select 1 from academy.courses where tenant_id=t and id=offer.course_id and status='active' and program_kind='short_course') or not exists(select 1 from academy.training_course_versions where tenant_id=t and course_id=offer.course_id and status='published' and (offer.learning_mode<>'self_paced' or learning_mode='self_paced')) then raise exception 'academy_learning_not_published';end if;
 learner:=jsonb_build_object('name',btrim(p_payload#>>'{learner,name}'),'phone',private_app.normalize_lead_phone(p_payload#>>'{learner,phone}'),'email',lower(btrim(p_payload#>>'{learner,email}')));
 payer:=case when p_payload->>'payerIsLearner'='true' then learner else jsonb_build_object('name',btrim(p_payload#>>'{payer,name}'),'phone',private_app.normalize_lead_phone(p_payload#>>'{payer,phone}'),'email',lower(btrim(p_payload#>>'{payer,email}'))) end;
 if coalesce(length(learner->>'name'),0) not between 2 and 200 or coalesce(length(payer->>'name'),0) not between 2 and 200
 or learner->>'phone' is null or payer->>'phone' is null or coalesce(learner->>'email','')!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 or coalesce(payer->>'email','')!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(learner->>'email')>254 or length(payer->>'email')>254 then raise exception 'academy_identity_required';end if;
 phone:=md5(learner->>'phone');
 if (select count(*) from academy.store_orders where tenant_id=t and created_at>now()-interval '1 minute')>=30
 or (select count(*) from academy.store_orders where tenant_id=t and created_at>now()-interval '1 day')>=300
 or (select count(*) from academy.store_orders where tenant_id=t and phone_key=phone and created_at>now()-interval '1 day')>=3 then raise exception 'academy_rate_limited' using errcode='P0001';end if;
 insert into academy.store_orders(tenant_id,offer_id,command_id,access_hash,request_hash,learner,payer,phone_key,title,net_minor,tax_minor,total_minor,tax_rate_bps,tax_category,currency,bank_snapshot,policy_snapshot)
 values(t,offer.id,p_command_id,token,hash,learner,payer,phone,offer.title,offer.net_minor,round(offer.net_minor::numeric*offer.tax_rate_bps/10000)::bigint,
 offer.net_minor+round(offer.net_minor::numeric*offer.tax_rate_bps/10000)::bigint,offer.tax_rate_bps,offer.tax_category,offer.currency,
 jsonb_build_object('bankName',cfg.bank_name,'accountName',cfg.account_name,'iban',cfg.iban,'instructions',cfg.instructions),cfg.refund_policy) returning * into o;
 return private_app.academy_store_order_view_v1(o);
end $$;

-- Resolve an approved identity within the tenant. Existing CRM ownership and
-- identity fields are never overwritten from an anonymous request.
create function private_app.academy_store_contact_v1(t uuid,person jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare c sales_core.contacts%rowtype; v_phone text:=private_app.normalize_lead_phone(person->>'phone'); actor uuid:=private_app.current_subject_id();
begin
 if v_phone is null then raise exception 'primary_phone_required';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-person:'||v_phone,220926));
 select * into c from sales_core.contacts where tenant_id=t and (id in(select contact_id from sales_core.contact_identities where tenant_id=t and identity_type='phone' and identity_value=v_phone) or private_app.normalize_lead_phone(sales_core.contacts.phone)=v_phone) order by created_at,id limit 1 for update;
 if c.id is not null then
  if lower(coalesce(c.email,''))<>person->>'email' then raise exception 'academy_identity_review_required';end if;
  return c.id;
 end if;
 insert into sales_core.contacts(tenant_id,contact_key,full_name,phone,email,source,created_by_subject_id,metadata)
 values(t,'academy-'||gen_random_uuid()::text,person->>'name',v_phone,person->>'email','academy_store',actor,jsonb_build_object('source','academy_store')) returning id into c.id;
 return c.id;
end $$;

create function public.v1_academy_commerce_snapshot(p_slug text,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid; result jsonb;
begin
 t:=private_app.academy_store_tenant_v1(p_slug);
 if auth.uid() is null or private_app.current_subject_id() is null or (private_app.academy_has_permission_v1(t,'manageStore') or private_app.academy_has_permission_v1(t,'manageAdmissions') or private_app.academy_has_permission_v1(t,'verifyPayments')) is not true then raise exception 'forbidden' using errcode='42501';end if;
 if p_offset not between 0 and 100000 then raise exception 'invalid_request';end if;
 select jsonb_build_object('tenant',jsonb_build_object('id',c.id,'slug',c.slug,'name',c.name),'canManageStore',private_app.academy_has_permission_v1(t,'manageStore'),'canConfigureStore',private_app.academy_store_settings_authorized_v1(t),'canVerifyPayments',private_app.academy_has_permission_v1(t,'verifyPayments'),'canInviteLearners',private_app.academy_has_permission_v1(t,'manageLearning'),'canManageAdmissions',private_app.academy_has_permission_v1(t,'manageAdmissions'),
 'settings',(select jsonb_build_object('checkoutEnabled',s.checkout_enabled,'bankName',s.bank_name,'accountName',s.account_name,'iban',s.iban,'instructions',s.instructions,'refundPolicy',s.refund_policy) from academy.store_settings s where s.tenant_id=t),
 'finance',(select jsonb_build_object('configured',true,'currency',base_currency,'taxRegistered',tax_registered,'taxRateBps',default_tax_rate_bps) from accounting_core.tenant_profiles where tenant_id=t),
 'courses',coalesce((select jsonb_agg(row) from(select jsonb_build_object('id',id,'title',title_ar) row from academy.courses where tenant_id=t and status='active' and program_kind='short_course' order by title_ar,id limit 100)x),'[]'),
 'runs',coalesce((select jsonb_agg(row) from(select jsonb_build_object('id',id,'courseId',course_id,'title',title,'status',status) row from academy.course_runs where tenant_id=t and status='open' order by created_at desc,id limit 100)x),'[]'),
 'offers',coalesce((select jsonb_agg(row) from(select jsonb_build_object('id',o.id,'courseId',o.course_id,'title',o.title,'description',o.description,'learningMode',o.learning_mode,'published',o.published,'version',o.version,'currency',o.currency,'totalMinor',o.net_minor+round(o.net_minor::numeric*o.tax_rate_bps/10000)::bigint,'netMinor',o.net_minor,'learningReady',exists(select 1 from academy.training_course_versions where tenant_id=t and course_id=o.course_id and status='published' and (o.learning_mode<>'self_paced' or learning_mode='self_paced'))) row from academy.store_offers o where tenant_id=t order by created_at desc,id limit 100)x),'[]'),
 'orders',coalesce((select jsonb_agg(row) from(select private_app.academy_store_order_view_v1(o)||jsonb_build_object('learner',o.learner,'payer',o.payer,'studentId',o.student_id,'enrollmentId',o.enrollment_id,'verifiedReference',o.verified_reference) row from academy.store_orders o where tenant_id=t order by created_at desc,id limit 50 offset p_offset)x),'[]'),
 'offset',p_offset,'hasMore',p_offset+50<(select count(*) from academy.store_orders where tenant_id=t)) into result from core.tenants c where c.id=t;
 return result;
end $$;

create function public.v1_academy_commerce_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid; actor uuid:=private_app.current_subject_id(); saved academy.store_commands%rowtype; hash text;
 result jsonb; profile accounting_core.tenant_profiles%rowtype; cfg academy.store_settings%rowtype;
 offer academy.store_offers%rowtype; run academy.course_runs%rowtype; o academy.store_orders%rowtype;
 cid uuid; rid uuid; learner_id uuid; payer_id uuid; account_id uuid; student uuid; handoff uuid; invoice uuid; payment uuid; enrollment uuid; content uuid;
 total_enrolled integer; identity_phone text; receipt_reference text; currency text; rate integer; category text; when_paid timestamptz; policy_source text; course_code text;
begin
 t:=private_app.academy_store_tenant_v1(p_slug);
 if actor is null or auth.uid() is null then raise exception 'authentication_required' using errcode='42501';end if;
 if p_action='save_settings' then
  if private_app.academy_store_settings_authorized_v1(t) is not true then raise exception 'forbidden' using errcode='42501';end if;
 elsif p_action in ('save_offer','publish_offer') then
  if private_app.academy_has_permission_v1(t,'manageStore') is not true then raise exception 'forbidden' using errcode='42501';end if;
 elsif p_action='verify_order' then
  if private_app.academy_has_permission_v1(t,'verifyPayments') is not true then raise exception 'forbidden' using errcode='42501';end if;
 elsif p_action='reject_order' then
  if private_app.academy_has_permission_v1(t,'manageAdmissions') is not true then raise exception 'forbidden' using errcode='42501';end if;
 else raise exception 'invalid_request';end if;
 if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>24000 then raise exception 'invalid_request';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-store-command:'||p_command_id::text,220926));
 hash:=md5(p_payload::text);
 select * into saved from academy.store_commands where tenant_id=t and command_id=p_command_id;
 if saved.command_id is not null then
  if saved.actor_subject_id<>actor or saved.action<>p_action or saved.request_hash<>hash then raise exception 'command_conflict';end if;
  return saved.result;
 end if;
 insert into academy.store_commands(tenant_id,command_id,actor_subject_id,action,request_hash) values(t,p_command_id,actor,p_action,hash);
 select * into profile from accounting_core.tenant_profiles where tenant_id=t;
 if p_action='save_settings' then
  if profile.tenant_id is null then
   if (select mode from academy.platform_settings where tenant_id=t)<>'standalone' then raise exception 'academy_finance_setup_required';end if;
   if coalesce(p_payload->>'currency','') not in ('SAR','EGP','USD') or jsonb_typeof(p_payload->'taxRegistered') is distinct from 'boolean' then raise exception 'invalid_request';end if;
   insert into accounting_core.tenant_profiles(tenant_id,legal_name_ar,base_currency,timezone,tax_registered,default_tax_rate_bps,created_by_subject_id,updated_by_subject_id)
   select t,name,p_payload->>'currency',timezone,(p_payload->>'taxRegistered')::boolean,coalesce((p_payload->>'taxRateBps')::integer,1500),actor,actor from core.tenants where id=t;
  end if;
  insert into academy.store_settings(tenant_id,checkout_enabled,bank_name,account_name,iban,instructions,refund_policy,updated_by_subject_id)
  values(t,coalesce((p_payload->>'checkoutEnabled')::boolean,false),btrim(coalesce(p_payload->>'bankName','')),btrim(coalesce(p_payload->>'accountName','')),
  upper(regexp_replace(coalesce(p_payload->>'iban',''),'[[:space:]]','','g')),btrim(coalesce(p_payload->>'instructions','')),btrim(coalesce(p_payload->>'refundPolicy','')),actor)
  on conflict(tenant_id) do update set checkout_enabled=excluded.checkout_enabled,bank_name=excluded.bank_name,account_name=excluded.account_name,iban=excluded.iban,instructions=excluded.instructions,refund_policy=excluded.refund_policy,updated_by_subject_id=actor,updated_at=now();
  result:=jsonb_build_object('saved',true);
 elsif p_action='save_offer' then
  if profile.tenant_id is null then raise exception 'academy_finance_setup_required';end if;
  if p_payload->>'programKind' is distinct from 'short_course' then raise exception 'academy_short_course_required';end if;
  if p_payload->>'learningMode' not in ('self_paced','cohort') or coalesce(length(btrim(p_payload->>'title')),0) not between 2 and 200 then raise exception 'invalid_request';end if;
  cid:=nullif(p_payload->>'courseId','')::uuid;
  if cid is null then
   course_code:=upper(regexp_replace(coalesce(p_payload->>'courseCode',''),'[^A-Za-z0-9_-]','','g'));
   if length(course_code) not between 2 and 40 then raise exception 'course_code_required';end if;
   insert into academy.courses(tenant_id,course_code,title_ar,category,description,delivery_mode,price_minor,currency,status,program_kind,metadata)
   values(t,course_code,btrim(p_payload->>'title'),'academy',btrim(coalesce(p_payload->>'description','')),'online',(p_payload->>'netMinor')::bigint,profile.base_currency,'active','short_course',jsonb_build_object('source','academy_store')) returning id into cid;
  elsif not exists(select 1 from academy.courses where tenant_id=t and id=cid and status='active' and program_kind='short_course') then raise exception 'invalid_course';end if;
  rid:=nullif(p_payload->>'runId','')::uuid;
  if rid is not null then
   select * into run from academy.course_runs where tenant_id=t and id=rid and course_id=cid and status='open' for update;
   if run.id is null or (p_payload->>'learningMode'='self_paced') is distinct from (coalesce(run.metadata->>'trainingJourneySelfpaced','false')='true') then raise exception 'invalid_course_run';end if;
  else
   if p_payload->>'learningMode'='cohort' and (nullif(p_payload->>'startsAt','') is null or nullif(p_payload->>'endsAt','') is null or (p_payload->>'endsAt')::timestamptz<=(p_payload->>'startsAt')::timestamptz or coalesce((p_payload->>'capacity')::integer,0)<1) then raise exception 'academy_cohort_schedule_required';end if;
   insert into academy.course_runs(tenant_id,course_id,run_code,title,delivery_mode,status,capacity,starts_at,ends_at,price_minor,currency,metadata)
   values(t,cid,'ACS-'||upper(left(replace(gen_random_uuid()::text,'-',''),16)),case when p_payload->>'learningMode'='self_paced' then 'تعلم ذاتي مستمر' else btrim(p_payload->>'title') end,'online','open',
   case when p_payload->>'learningMode'='cohort' then (p_payload->>'capacity')::integer end,
   case when p_payload->>'learningMode'='cohort' then (p_payload->>'startsAt')::timestamptz end,case when p_payload->>'learningMode'='cohort' then (p_payload->>'endsAt')::timestamptz end,
   (p_payload->>'netMinor')::bigint,profile.base_currency,jsonb_build_object('source','academy_store','trainingJourneySelfpaced',p_payload->>'learningMode'='self_paced','hiddenDeliveryRun',p_payload->>'learningMode'='self_paced')) returning id into rid;
  end if;
  rate:=case when profile.tax_registered then profile.default_tax_rate_bps else 0 end;
  category:=case when profile.tax_registered then 'standard' else 'out_of_scope' end;
  insert into academy.store_offers(tenant_id,course_id,run_id,learning_mode,title,description,net_minor,tax_rate_bps,tax_category,currency,created_by_subject_id)
  values(t,cid,rid,p_payload->>'learningMode',btrim(p_payload->>'title'),btrim(coalesce(p_payload->>'description','')),(p_payload->>'netMinor')::bigint,rate,category,profile.base_currency,actor) returning * into offer;
  result:=jsonb_build_object('offerId',offer.id,'courseId',cid,'runId',rid,'published',false);
 elsif p_action='publish_offer' then
  select * into offer from academy.store_offers where tenant_id=t and id=(p_payload->>'offerId')::uuid for update;
  if offer.id is null or offer.version is distinct from (p_payload->>'expectedVersion')::integer then raise exception 'command_conflict';end if;
  if jsonb_typeof(p_payload->'published') is distinct from 'boolean' then raise exception 'invalid_request';end if;
  if (p_payload->>'published')::boolean and not exists(select 1 from academy.training_course_versions where tenant_id=t and course_id=offer.course_id and status='published' and (offer.learning_mode<>'self_paced' or learning_mode='self_paced')) then raise exception 'academy_learning_not_published';end if;
  update academy.store_offers set published=(p_payload->>'published')::boolean,version=version+1,updated_at=now() where id=offer.id;
  result:=jsonb_build_object('offerId',offer.id,'published',(p_payload->>'published')::boolean);
 else
  select * into o from academy.store_orders where tenant_id=t and id=(p_payload->>'orderId')::uuid for update;
  if o.id is null then raise exception 'academy_order_not_found';end if;
  if p_action='reject_order' then
   if o.status not in ('pending_payment','payment_review') or length(btrim(coalesce(p_payload->>'reason','')))<5 then raise exception 'academy_order_not_editable';end if;
   update academy.store_orders set status='rejected',review_note=left(btrim(p_payload->>'reason'),1000),updated_at=now() where id=o.id;
   result:=jsonb_build_object('orderId',o.id,'status','rejected');
  elsif o.status='enrolled' then result:=jsonb_build_object('orderId',o.id,'status','enrolled','studentId',o.student_id,'enrollmentId',o.enrollment_id);
  else
   if o.status<>'payment_review' or p_payload->>'identityConfirmed' is distinct from 'true' then raise exception 'academy_identity_confirmation_required';end if;
   if (p_payload->>'receivedMinor')::bigint is distinct from o.total_minor then raise exception 'academy_received_amount_mismatch';end if;
   receipt_reference:=upper(btrim(coalesce(p_payload->>'bankReference','')));
   if length(receipt_reference) not between 4 and 120 then raise exception 'academy_payment_reference_required';end if;
   when_paid:=(p_payload->>'receivedAt')::timestamptz;
   if when_paid is null or when_paid>now()+interval '5 minutes' then raise exception 'invalid_payment_date';end if;
   select * into offer from academy.store_offers where tenant_id=t and id=o.offer_id;
   if not exists(select 1 from academy.courses where tenant_id=t and id=offer.course_id and status='active' and program_kind='short_course') then raise exception 'academy_short_course_required';end if;
   select * into run from academy.course_runs where tenant_id=t and id=offer.run_id and course_id=offer.course_id for update;
   if run.id is null or run.status<>'open' or (run.registration_opens_at is not null and run.registration_opens_at>now()) or (run.registration_closes_at is not null and run.registration_closes_at<=now()) then raise exception 'course_run_not_open';end if;
   select count(*) into total_enrolled from academy.enrollments where tenant_id=t and course_run_id=run.id and status in ('confirmed','active','completed');
   if run.capacity is not null and total_enrolled>=run.capacity then raise exception 'course_run_full';end if;
   select id into content from academy.training_course_versions where tenant_id=t and course_id=offer.course_id and status='published' and (offer.learning_mode<>'self_paced' or learning_mode='self_paced') order by version desc limit 1;
   if content is null then raise exception 'academy_learning_not_published';end if;
   for identity_phone in select distinct value from unnest(array[o.learner->>'phone',o.payer->>'phone']) phones(value) order by value loop
    perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-person:'||identity_phone,220926));
   end loop;
   learner_id:=private_app.academy_store_contact_v1(t,o.learner);
   payer_id:=case when o.payer=o.learner then learner_id else private_app.academy_store_contact_v1(t,o.payer) end;
   select id into student from academy.students where tenant_id=t and contact_id=learner_id;
   if student is null then
    insert into academy.students(tenant_id,student_key,student_number,contact_id,full_name,phone,email,created_by_subject_id,metadata)
    select t,'contact-'||c.id::text,'STU-'||upper(replace(c.id::text,'-','')),c.id,c.full_name,c.phone,c.email,actor,jsonb_build_object('source','academy_store') from sales_core.contacts c where c.tenant_id=t and c.id=learner_id returning id into student;
   elsif exists(select 1 from academy.students where tenant_id=t and id=student and status='blocked') then raise exception 'academy_learner_blocked';end if;
   if exists(select 1 from academy.enrollments where tenant_id=t and student_id=student and course_run_id=run.id) then raise exception 'already_registered';end if;
   select id into account_id from accounting_core.customer_accounts where tenant_id=t and contact_id=payer_id and status='active';
   if account_id is null then
    if exists(select 1 from accounting_core.customer_accounts where tenant_id=t and contact_id=payer_id) then raise exception 'academy_payer_account_blocked';end if;
    insert into accounting_core.customer_accounts(tenant_id,contact_id,account_number,display_name,billing_email,billing_phone,created_by_subject_id)
    select t,c.id,'ACS-'||upper(replace(c.id::text,'-','')),c.full_name,c.email,c.phone,actor from sales_core.contacts c where tenant_id=t and id=payer_id returning id into account_id;
   end if;
   insert into academy.registration_handoffs(tenant_id,handoff_key,contact_id,course_id,course_run_id,payment_amount_minor,payment_reference,paid_at,created_by_subject_id,metadata)
   values(t,'academy-store-'||o.id::text,learner_id,offer.course_id,run.id,o.total_minor,receipt_reference,when_paid,actor,jsonb_build_object('source','academy_store','storeOrderId',o.id,'currency',o.currency,'paymentMethod','bank_transfer')) returning id into handoff;
   -- Establish the source link before verifying handoff: the canonical handoff
   -- import trigger must see the existing invoice link and avoid duplicate cash.
   update academy.store_orders set handoff_id=handoff,student_id=student where id=o.id;
   insert into accounting_core.sales_documents(tenant_id,document_type,document_number,customer_account_id,contact_id,source_type,source_id,issue_date,currency,customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,subtotal_minor,tax_minor,total_minor,created_by_subject_id,metadata)
   values(t,'invoice','ACS-'||upper(replace(o.id::text,'-','')),account_id,payer_id,'academy_store',o.id::text,(when_paid at time zone coalesce(profile.timezone,'Asia/Riyadh'))::date,o.currency,o.payer->>'name',o.payer->>'email',o.payer->>'phone',o.net_minor,o.tax_minor,o.total_minor,actor,jsonb_build_object('storeOrderId',o.id,'learnerContactId',learner_id)) returning id into invoice;
   insert into accounting_core.sales_document_lines(tenant_id,document_id,position,item_type,source_id,description,quantity,unit_amount_minor,subtotal_minor,tax_category,tax_rate_bps,tax_minor,total_minor)
   values(t,invoice,1,'course',offer.course_id::text,o.title,1,o.net_minor,o.net_minor,o.tax_category,o.tax_rate_bps,o.tax_minor,o.total_minor);
   update accounting_core.sales_documents set status='issued',issued_by_subject_id=actor,issued_at=now() where tenant_id=t and id=invoice;
   insert into accounting_core.document_events(tenant_id,document_id,event_type,to_status,actor_subject_id,details) values(t,invoice,'academy_store_invoice','issued',actor,jsonb_build_object('storeOrderId',o.id));
   insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,sponsor,created_by_subject_id) values(t,handoff,invoice,account_id,'full',payer_id<>learner_id,actor);
   insert into accounting_core.payments(tenant_id,customer_account_id,payment_number,amount_minor,currency,method,status,external_reference,source_type,source_id,received_at,verified_at,verified_by_subject_id,created_by_subject_id,metadata)
   values(t,account_id,'ACS-'||upper(replace(o.id::text,'-','')),o.total_minor,o.currency,'bank_transfer','verified',receipt_reference,'academy_store',o.id::text,when_paid,now(),actor,actor,jsonb_build_object('storeOrderId',o.id,'handoffId',handoff)) returning id into payment;
   insert into accounting_core.payment_allocations(tenant_id,payment_id,invoice_id,amount_minor,created_by_subject_id) values(t,payment,invoice,o.total_minor,actor);
   update academy.registration_handoffs set payment_status='verified',payment_verified_at=now(),payment_verified_by_subject_id=actor where tenant_id=t and id=handoff;
   -- The live admission/finance triggers also validate this canonical insert.
   insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id,status,confirmed_by_subject_id,metadata)
   values(t,'academy-store-'||o.id::text,handoff,student,offer.course_id,run.id,'confirmed',actor,jsonb_build_object('source','academy_store','storeOrderId',o.id)) returning id into enrollment;
   insert into academy.training_enrollment_versions(tenant_id,enrollment_id,version_id,assigned_by_subject_id) values(t,enrollment,content,actor);
   update academy.registration_handoffs set status='completed',accepted_at=now(),accepted_by_subject_id=actor,completed_at=now(),completed_by_subject_id=actor where tenant_id=t and id=handoff;
   update academy.course_runs set enrolled_count=(select count(*) from academy.enrollments where tenant_id=t and course_run_id=run.id and status in ('confirmed','active','completed')) where tenant_id=t and id=run.id;
   update academy.store_orders set status='enrolled',invoice_id=invoice,payment_id=payment,enrollment_id=enrollment,verified_reference=receipt_reference,received_at=when_paid,verified_at=now(),verified_by_subject_id=actor,updated_at=now() where id=o.id;
   result:=jsonb_build_object('orderId',o.id,'status','enrolled','studentId',student,'enrollmentId',enrollment);
  end if;
 end if;
 perform private_app.write_audit('academy.store.'||p_action,'academy_store',coalesce(result->>'orderId',result->>'offerId',t::text),t,jsonb_build_object('commandId',p_command_id));
 update academy.store_commands set result=operation.result where tenant_id=t and command_id=p_command_id;
 return result;
end $$;

-- Extend the old guard only for an authenticated authorized approver acting on
-- the handoff of a native store order. All existing financial tests still apply.
do $guard$
declare definition text; needle text:='not private_app.training_journey_payment_authorized_v1(new.tenant_id)';
begin
 definition:=pg_get_functiondef('private_app.training_journey_guard_finance_v1()'::regprocedure);
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'academy_finance_guard_baseline_changed';end if;
 execute replace(definition,needle,$replacement$not (private_app.training_journey_payment_authorized_v1(new.tenant_id) or
  (private_app.academy_platform_enabled_v1(new.tenant_id,'store') and private_app.academy_has_permission_v1(new.tenant_id,'verifyPayments')
   and new.metadata->>'source'='academy_store' and exists(select 1 from academy.store_orders native where native.tenant_id=new.tenant_id and native.handoff_id=new.id and native.status='payment_review')))$replacement$);
end $guard$;
revoke all on function private_app.academy_store_tenant_v1(text),private_app.academy_store_settings_authorized_v1(uuid),private_app.academy_store_order_view_v1(academy.store_orders),private_app.academy_store_contact_v1(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.v1_academy_storefront(text),public.v1_academy_store_order(text,text,uuid,jsonb),public.v1_academy_commerce_snapshot(text,integer),public.v1_academy_commerce_action(text,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_academy_storefront(text),public.v1_academy_store_order(text,text,uuid,jsonb) to anon,authenticated;
grant execute on function public.v1_academy_commerce_snapshot(text,integer),public.v1_academy_commerce_action(text,text,uuid,jsonb) to authenticated;
commit;
