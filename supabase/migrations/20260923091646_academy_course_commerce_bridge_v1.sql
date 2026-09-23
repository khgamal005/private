-- One course, multiple canonical delivery choices, and immutable commercial terms.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
alter table academy.store_offers drop constraint store_offers_net_minor_check;
alter table academy.store_offers add constraint store_offers_net_minor_check check(net_minor between 0 and 100000000);
alter table academy.store_offers add column installment_terms jsonb not null default '[]' check(jsonb_typeof(installment_terms)='array');
alter table academy.store_orders drop constraint store_orders_net_minor_check;
alter table academy.store_orders add constraint store_orders_net_minor_check check(net_minor>=0);
alter table academy.store_orders add column payment_policy text not null default 'full' check(payment_policy in ('full','installments'));
alter table academy.store_orders add column payment_schedule jsonb not null default '[]' check(jsonb_typeof(payment_schedule)='array');

create function private_app.academy_installment_terms_v1(terms jsonb,total bigint) returns jsonb
language plpgsql immutable set search_path='' as $$
declare item jsonb;amount bigint;days integer;previous integer:=-1;sum_amount bigint:=0;n integer:=0;result jsonb:='[]';
begin
 if jsonb_typeof(terms) is distinct from 'array' or jsonb_array_length(terms)>12 then raise exception 'academy_installments_invalid';end if;
 if terms='[]'::jsonb then return terms;end if;
 if jsonb_array_length(terms)<2 or total<=0 then raise exception 'academy_installments_invalid';end if;
 for item in select value from jsonb_array_elements(terms) loop
  if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'amountMinor','')!~'^[0-9]+$' or coalesce(item->>'dueDays','')!~'^[0-9]+$' then raise exception 'academy_installments_invalid';end if;
  amount:=(item->>'amountMinor')::bigint;days:=(item->>'dueDays')::integer;
  if amount not between 1 and total or days not between 0 and 730 or days<=previous or (n=0 and days<>0) then raise exception 'academy_installments_invalid';end if;
  sum_amount:=sum_amount+amount;n:=n+1;previous:=days;
  result:=result||jsonb_build_array(jsonb_build_object('amountMinor',amount,'dueDays',days));
 end loop;
 if sum_amount<>total then raise exception 'academy_installments_invalid';end if;
 return result;
end $$;

create function public.v1_academy_course_delivery_snapshot(p_slug text,p_course_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;course academy.courses%rowtype;profile accounting_core.tenant_profiles%rowtype;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);
 if private_app.academy_has_permission_v1(t,'manageLearning') is not true then raise exception 'forbidden' using errcode='42501';end if;
 if not private_app.academy_delivery_enabled_v1(t) then return jsonb_build_object('available',false);end if;
 select * into course from academy.courses where tenant_id=t and id=p_course_id;
 if course.id is null then raise exception 'academy_authoring_course_not_found';end if;
 select * into profile from accounting_core.tenant_profiles where tenant_id=t;
 return jsonb_build_object('available',true,'courseId',course.id,'title',course.title_ar,'currency',coalesce(profile.base_currency,course.currency),
 'taxRateBps',case when profile.tax_registered then profile.default_tax_rate_bps else 0 end,'financeReady',profile.tenant_id is not null,
 'canManageStore',private_app.academy_has_permission_v1(t,'manageStore'),'contentPublished',exists(select 1 from academy.training_course_versions where tenant_id=t and course_id=course.id and status='published'),
 'runs',coalesce((select jsonb_agg(x.row) from(select jsonb_build_object('id',r.id,'title',r.title,'status',r.status,'startsAt',r.starts_at,'endsAt',r.ends_at,
 'capacity',r.capacity,'enrolledCount',r.enrolled_count,'selfPaced',coalesce(r.metadata->>'trainingJourneySelfpaced','false')='true',
 'sessions',coalesce((select jsonb_agg(s.row) from(select jsonb_build_object('id',ss.id,'title',ss.title,'startsAt',ss.starts_at,'endsAt',ss.ends_at,'status',ss.status,
 'joinUrl',ss.meeting_join_url,'meetingStatus',ss.meeting_status,'providerManaged',ss.external_meeting_id is not null or ss.meeting_status in ('queued','ready')) row
 from academy.course_run_sessions ss where ss.tenant_id=t and ss.course_run_id=r.id order by ss.starts_at,ss.id limit 100)s),'[]')) row
 from academy.course_runs r where r.tenant_id=t and r.course_id=course.id and r.status in ('open','planned','in_progress') order by r.starts_at nulls first,r.id limit 100)x),'[]'),
 'offers',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'runId',o.run_id,'title',o.title,'netMinor',o.net_minor,'taxRateBps',o.tax_rate_bps,'currency',o.currency,
 'published',o.published,'version',o.version,'learningMode',o.learning_mode,'installmentTerms',o.installment_terms) order by o.created_at,o.id)
 from academy.store_offers o where o.tenant_id=t and o.course_id=course.id),'[]'));
end $$;

create function public.v1_academy_course_delivery_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid;actor uuid:=private_app.current_subject_id();cached academy.store_commands%rowtype;hash text;result jsonb;cid uuid;rid uuid;
 offer academy.store_offers%rowtype;course academy.courses%rowtype;run academy.course_runs%rowtype;profile accounting_core.tenant_profiles%rowtype;
 net bigint;rate integer;terms jsonb;mode text;
begin
 t:=private_app.academy_delivery_tenant_v1(p_slug);
 if private_app.academy_has_permission_v1(t,'manageCourses') is not true or private_app.academy_has_permission_v1(t,'manageStore') is not true then raise exception 'forbidden' using errcode='42501';end if;
 if p_action='publish_offer' then return public.v1_academy_commerce_action(p_slug,p_action,p_command_id,p_payload);end if;
 if p_action<>'save_offer' or p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>12000 then raise exception 'invalid_request';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-store-command:'||p_command_id::text,220926));
 hash:=md5(p_payload::text);
 select * into cached from academy.store_commands where tenant_id=t and command_id=p_command_id;
 if cached.command_id is not null then
  if cached.actor_subject_id<>actor or cached.action<>'course_delivery.save_offer' or cached.request_hash<>hash then raise exception 'command_conflict';end if;
  return cached.result;
 end if;
 cid:=(p_payload->>'courseId')::uuid;
 select * into course from academy.courses where tenant_id=t and id=cid for update;
 if course.id is null or course.program_kind is distinct from 'short_course' or course.status not in ('draft','active') then raise exception 'academy_short_course_required';end if;
 select * into profile from accounting_core.tenant_profiles where tenant_id=t;
 if profile.tenant_id is null then raise exception 'academy_finance_setup_required';end if;
 if coalesce(p_payload->>'netMinor','')!~'^[0-9]+$' or (p_payload->>'netMinor')::bigint not between 0 and 100000000 then raise exception 'invalid_request';end if;
 net:=(p_payload->>'netMinor')::bigint;rate:=case when profile.tax_registered and net>0 then profile.default_tax_rate_bps else 0 end;
 terms:=private_app.academy_installment_terms_v1(coalesce(p_payload->'installmentTerms','[]'),net+round(net::numeric*rate/10000)::bigint);
 rid:=nullif(p_payload->>'runId','')::uuid;mode:=p_payload->>'learningMode';
 if mode is null or mode not in ('cohort','self_paced') then raise exception 'invalid_request';end if;
 if rid is null and mode='self_paced' then
  select id into rid from academy.course_runs where tenant_id=t and course_id=cid and status='open' and metadata->>'trainingJourneySelfpaced'='true' order by created_at,id limit 1;
  if rid is null then
   insert into academy.course_runs(tenant_id,course_id,run_code,title,delivery_mode,status,price_minor,currency,metadata)
   values(t,cid,'ACS-'||upper(left(replace(gen_random_uuid()::text,'-',''),16)),'تعلم ذاتي مستمر','online','open',net,profile.base_currency,jsonb_build_object('source','academy_store','trainingJourneySelfpaced',true,'hiddenDeliveryRun',true)) returning id into rid;
  end if;
 end if;
 select * into run from academy.course_runs where tenant_id=t and id=rid and course_id=cid and status='open' for update;
 if run.id is null or (mode='self_paced') is distinct from (coalesce(run.metadata->>'trainingJourneySelfpaced','false')='true') then raise exception 'invalid_course_run';end if;
 select * into offer from academy.store_offers where tenant_id=t and course_id=cid and run_id=rid for update;
 if coalesce((p_payload->>'expectedVersion')::integer,-1)<>coalesce(offer.version,0) then raise exception 'command_conflict';end if;
 if offer.id is null then
  insert into academy.store_offers(tenant_id,course_id,run_id,learning_mode,title,description,net_minor,tax_rate_bps,tax_category,currency,created_by_subject_id,installment_terms)
  values(t,cid,rid,mode,left(course.title_ar,200),left(coalesce(course.description,''),6000),net,rate,case when rate>0 then 'standard' else 'out_of_scope' end,profile.base_currency,actor,terms) returning * into offer;
 else
  update academy.store_offers set net_minor=net,tax_rate_bps=rate,tax_category=case when rate>0 then 'standard' else 'out_of_scope' end,
   currency=profile.base_currency,installment_terms=terms,title=left(course.title_ar,200),description=left(coalesce(course.description,''),6000),version=version+1,updated_at=now()
   where tenant_id=t and id=offer.id returning * into offer;
 end if;
 result:=jsonb_build_object('offerId',offer.id,'courseId',cid,'runId',rid,'version',offer.version,'published',offer.published);
 insert into academy.store_commands(tenant_id,command_id,actor_subject_id,action,request_hash,result) values(t,p_command_id,actor,'course_delivery.save_offer',hash,result);
 perform private_app.write_audit('academy.course.selling_saved','academy_store',offer.id::text,t,jsonb_build_object('commandId',p_command_id,'courseId',cid,'runId',rid));
 return result;
end $$;

revoke all on function private_app.academy_installment_terms_v1(jsonb,bigint),public.v1_academy_course_delivery_snapshot(text,uuid),public.v1_academy_course_delivery_action(text,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_academy_course_delivery_snapshot(text,uuid),public.v1_academy_course_delivery_action(text,text,uuid,jsonb) to authenticated;
-- Native checkout extensions and operations bridge follow below.


create or replace function private_app.academy_store_order_view_v1(o academy.store_orders) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',o.id,'reference','TR-'||upper(left(replace(o.id::text,'-',''),12)),
 'title',o.title,'status',o.status,'paymentPolicy',o.payment_policy,'paymentSchedule',o.payment_schedule,'requiredMinor',case when o.payment_policy='installments' then (o.payment_schedule->0->>'amountMinor')::bigint else o.total_minor end,'netMinor',o.net_minor,'taxMinor',o.tax_minor,'totalMinor',o.total_minor,'currency',o.currency,
 'bank',o.bank_snapshot,'refundPolicy',o.policy_snapshot,'reportedReference',o.reported_reference,'reviewNote',o.review_note,'createdAt',o.created_at)
$$;

create or replace function public.v1_academy_storefront(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid; result jsonb; cfg academy.store_settings%rowtype;
begin
 t:=private_app.academy_store_tenant_v1(p_slug);
 select * into cfg from academy.store_settings where tenant_id=t;
 select jsonb_build_object('tenant',jsonb_build_object('slug',c.slug,'name',c.name),'checkoutEnabled',coalesce(cfg.checkout_enabled,false),'refundPolicy',coalesce(cfg.refund_policy,''),
 'offers',coalesce((select jsonb_agg(x.row) from (select jsonb_build_object('id',o.id,'title',o.title,'description',o.description,
 'courseId',o.course_id,'runId',o.run_id,'runTitle',r.title,'installmentTerms',o.installment_terms,'learningMode',o.learning_mode,'totalMinor',o.net_minor+round(o.net_minor::numeric*o.tax_rate_bps/10000)::bigint,
 'netMinor',o.net_minor,'taxMinor',round(o.net_minor::numeric*o.tax_rate_bps/10000)::bigint,'currency',o.currency,
 'startsAt',r.starts_at,'endsAt',r.ends_at,'available',r.status='open' and (r.capacity is null or r.enrolled_count<r.capacity)
 and (r.registration_opens_at is null or r.registration_opens_at<=now()) and (r.registration_closes_at is null or r.registration_closes_at>now())) row
 from academy.store_offers o join academy.course_runs r on r.tenant_id=t and r.id=o.run_id
 join academy.courses course on course.tenant_id=t and course.id=o.course_id and course.status='active' and course.program_kind='short_course'
 where o.tenant_id=t and o.published and (o.net_minor>0 or private_app.academy_delivery_enabled_v1(t)) and exists(select 1 from academy.training_course_versions v where v.tenant_id=t and v.course_id=o.course_id and v.status='published' and (o.learning_mode<>'self_paced' or v.learning_mode='self_paced'))
 order by o.created_at desc,o.id limit 100)x),'[]')) into result from core.tenants c where c.id=t;
 return result;
end $$;

create or replace function public.v1_academy_store_order(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
   if o.total_minor=0 then raise exception 'academy_free_order_no_transfer';end if;
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
 if coalesce(p_payload->>'paymentPlan','full') not in ('full','installments') then raise exception 'invalid_request';end if;
 if (offer.net_minor=0 or p_payload->>'paymentPlan'='installments') and not private_app.academy_delivery_enabled_v1(t) then raise exception 'academy_delivery_disabled';end if;
 if p_payload->>'paymentPlan'='installments' and jsonb_array_length(offer.installment_terms)<2 then raise exception 'academy_installments_unavailable';end if;
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
 if p_payload->>'paymentPlan'='installments' then
  update academy.store_orders set payment_policy='installments',payment_schedule=(
   select jsonb_agg(jsonb_build_object('amountMinor',item.value->'amountMinor','dueDate',((o.created_at at time zone tenant.timezone)::date+(item.value->>'dueDays')::integer)::text) order by item.ordinality)
   from core.tenants tenant cross join jsonb_array_elements(offer.installment_terms) with ordinality item(value,ordinality) where tenant.id=t)
  where id=o.id returning * into o;
 end if;
 return private_app.academy_store_order_view_v1(o);
end $$;

create or replace function public.v1_academy_commerce_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid; actor uuid:=private_app.current_subject_id(); saved academy.store_commands%rowtype; hash text;
 result jsonb; profile accounting_core.tenant_profiles%rowtype; cfg academy.store_settings%rowtype;
 offer academy.store_offers%rowtype; run academy.course_runs%rowtype; o academy.store_orders%rowtype;
 cid uuid; rid uuid; learner_id uuid; payer_id uuid; account_id uuid; student uuid; handoff uuid; invoice uuid; payment uuid; enrollment uuid; content uuid;
 total_enrolled integer; identity_phone text; receipt_reference text; received bigint; currency text; rate integer; category text; when_paid timestamptz; policy_source text; course_code text;
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
   if (o.status<>'payment_review' and not (o.status='pending_payment' and o.total_minor=0)) or p_payload->>'identityConfirmed' is distinct from 'true' then raise exception 'academy_identity_confirmation_required';end if;
   if (o.total_minor=0 or o.payment_policy='installments') and not private_app.academy_delivery_enabled_v1(t) then raise exception 'academy_delivery_disabled';end if;
   received:=case when o.payment_policy='installments' then (o.payment_schedule->0->>'amountMinor')::bigint else o.total_minor end;
   if received is null or (p_payload->>'receivedMinor')::bigint is distinct from received then raise exception 'academy_received_amount_mismatch';end if;
   receipt_reference:=upper(btrim(coalesce(p_payload->>'bankReference','')));
   if o.total_minor>0 and length(receipt_reference) not between 4 and 120 then raise exception 'academy_payment_reference_required';end if;
   if o.total_minor=0 then receipt_reference:=null;end if;
   when_paid:=case when o.total_minor=0 then now() else (p_payload->>'receivedAt')::timestamptz end;
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
   values(t,'academy-store-'||o.id::text,learner_id,offer.course_id,run.id,received,receipt_reference,when_paid,actor,jsonb_build_object('source','academy_store','storeOrderId',o.id,'currency',o.currency,'paymentMethod','bank_transfer')) returning id into handoff;
   -- Establish the source link before verifying handoff: the canonical handoff
   -- import trigger must see the existing invoice link and avoid duplicate cash.
   update academy.store_orders set handoff_id=handoff,student_id=student where id=o.id;
   insert into accounting_core.sales_documents(tenant_id,document_type,document_number,customer_account_id,contact_id,source_type,source_id,issue_date,currency,customer_name_snapshot,customer_email_snapshot,customer_phone_snapshot,subtotal_minor,tax_minor,total_minor,created_by_subject_id,metadata)
   values(t,'invoice','ACS-'||upper(replace(o.id::text,'-','')),account_id,payer_id,'academy_store',o.id::text,(when_paid at time zone coalesce(profile.timezone,'Asia/Riyadh'))::date,o.currency,o.payer->>'name',o.payer->>'email',o.payer->>'phone',o.net_minor,o.tax_minor,o.total_minor,actor,jsonb_build_object('storeOrderId',o.id,'learnerContactId',learner_id)) returning id into invoice;
   insert into accounting_core.sales_document_lines(tenant_id,document_id,position,item_type,source_id,description,quantity,unit_amount_minor,subtotal_minor,tax_category,tax_rate_bps,tax_minor,total_minor)
   values(t,invoice,1,'course',offer.course_id::text,o.title,1,o.net_minor,o.net_minor,o.tax_category,o.tax_rate_bps,o.tax_minor,o.total_minor);
   update accounting_core.sales_documents set status='issued',issued_by_subject_id=actor,issued_at=now() where tenant_id=t and id=invoice;
   insert into accounting_core.document_events(tenant_id,document_id,event_type,to_status,actor_subject_id,details) values(t,invoice,'academy_store_invoice','issued',actor,jsonb_build_object('storeOrderId',o.id));
   insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,sponsor,created_by_subject_id) values(t,handoff,invoice,account_id,o.payment_policy,payer_id<>learner_id,actor);
   if o.payment_policy='installments' then
    insert into accounting_core.payment_schedules(tenant_id,invoice_id,installment_number,due_date,amount_minor,created_by_subject_id)
    select t,invoice,ordinality::integer,(value->>'dueDate')::date,(value->>'amountMinor')::bigint,actor from jsonb_array_elements(o.payment_schedule) with ordinality;
   end if;
   if received>0 then
   insert into accounting_core.payments(tenant_id,customer_account_id,payment_number,amount_minor,currency,method,status,external_reference,source_type,source_id,received_at,verified_at,verified_by_subject_id,created_by_subject_id,metadata)
   values(t,account_id,'ACS-'||upper(replace(o.id::text,'-','')),received,o.currency,'bank_transfer','verified',receipt_reference,'academy_store',o.id::text,when_paid,now(),actor,actor,jsonb_build_object('storeOrderId',o.id,'handoffId',handoff)) returning id into payment;
   insert into accounting_core.payment_allocations(tenant_id,payment_id,invoice_id,amount_minor,created_by_subject_id) values(t,payment,invoice,received,actor);
   end if;
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


do $free_guard$
declare definition text;old text:='native.status=''payment_review''';
begin
 definition:=pg_get_functiondef('private_app.training_journey_guard_finance_v1()'::regprocedure);
 if (length(definition)-length(replace(definition,old,'')))/length(old)<>1 then raise exception 'academy_finance_guard_baseline_changed';end if;
 execute replace(definition,old,'(native.status=''payment_review'' or (native.status=''pending_payment'' and native.total_minor=0 and private_app.academy_delivery_enabled_v1(new.tenant_id)))');
end $free_guard$;


create or replace function private_app.admission_financial_eligibility_v1(p_tenant_id uuid,p_handoff_id uuid)
 returns jsonb language plpgsql stable security definer set search_path='' as $$
declare h academy.registration_handoffs%rowtype;c academy.courses%rowtype; required_amount bigint;cash bigint;program_type text;agreed_currency text;cash_currency text;invoice_id uuid;invoice_net jsonb;
begin
 select * into h from academy.registration_handoffs where tenant_id=p_tenant_id and id=p_handoff_id;
 select * into c from academy.courses where tenant_id=p_tenant_id and id=h.course_id;
 if h.id is null or c.id is null then return jsonb_build_object('eligible',false,'reason','course_required');end if;
 program_type:=to_jsonb(c)->>'program_kind';
 if program_type='diploma' then return private_app.diploma_admission_eligibility_v1(p_tenant_id,p_handoff_id);end if;
 if program_type is distinct from 'short_course' then return jsonb_build_object('eligible',false,'reason','program_classification_required');end if;
 if exists(select 1 from academy.admission_governance_exceptions where tenant_id=p_tenant_id and handoff_id=h.id and agreed_course_id=h.course_id and kind='payment_waiver')
 then return jsonb_build_object('eligible',true,'reason','approved_payment_waiver','waiverApproved',true);end if;
 -- Legacy opportunity values may have been overwritten by a partial receipt. Require an explicit agreement.
 select terms.amount_minor,terms.currency into required_amount,agreed_currency from academy.admission_commercial_terms terms
  where terms.tenant_id=p_tenant_id and terms.handoff_id=h.id and terms.course_id=h.course_id order by terms.approved_at desc,terms.id desc limit 1;
 select link.invoice_id into invoice_id from academy.training_financial_links link where link.tenant_id=p_tenant_id and link.handoff_id=h.id;
 if invoice_id is not null then
  invoice_net:=private_app.accounting_invoice_net_v1(p_tenant_id,invoice_id);
  if invoice_net->>'totalMinor' is null then return jsonb_build_object('eligible',false,'reason','issued_invoice_required');end if;
  if coalesce((invoice_net->>'requiresReview')::boolean,false) then return jsonb_build_object('eligible',false,'reason','refund_invoice_allocation_required');end if;
  if required_amount is not null and (required_amount<>(invoice_net->>'totalMinor')::bigint or agreed_currency is distinct from invoice_net->>'currency') then
   return jsonb_build_object('eligible',false,'reason','commercial_terms_invoice_mismatch');
  end if;
  required_amount:=(invoice_net->>'totalMinor')::bigint;agreed_currency:=invoice_net->>'currency';
 end if;
 if required_amount is null then return jsonb_build_object('eligible',false,'reason','agreed_price_required');end if;
 -- A zero price is an explicit commercial choice; no fictional payment is inserted.
 if required_amount=0 then return jsonb_build_object('eligible',true,'reason','zero_price_agreement','requiredAmountMinor',0);end if;
 cash:=private_app.admission_verified_cash_v1(p_tenant_id,p_handoff_id);
 cash_currency:=private_app.admission_cash_currency_v1(p_tenant_id,p_handoff_id);
 if cash>0 and cash_currency is distinct from agreed_currency then return jsonb_build_object('eligible',false,'reason','payment_currency_mismatch');end if;
 if private_app.academy_delivery_enabled_v1(p_tenant_id) and exists(select 1 from academy.store_orders o join academy.training_financial_links l on l.tenant_id=o.tenant_id and l.handoff_id=o.handoff_id
   where o.tenant_id=p_tenant_id and o.handoff_id=h.id and o.payment_policy='installments' and l.policy='installments' and o.status in ('payment_review','enrolled')) then
  return jsonb_build_object('eligible',coalesce((private_app.training_journey_handoff_finance_v1(h.id)->>'trainingAllowed')::boolean,false),'reason','installment_policy','requiredAmountMinor',required_amount,'verifiedAmountMinor',cash,'waiverApproved',false);
 end if;
 return jsonb_build_object('eligible',cash>=required_amount,'reason',case when cash>=required_amount then 'financially_eligible' else 'full_payment_required' end,
  'requiredAmountMinor',required_amount,'verifiedAmountMinor',cash,'waiverApproved',false);
end $$;
commit;
