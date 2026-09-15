-- Additive GA4 reader, same Google Ads entitlement. No operational backfill or activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
-- Fail explicitly if the already shipped order/admission contract is absent.
do $$ begin
 if to_regclass('sales_core.commerce_admission_lines') is null or to_regprocedure('private_app.campaign_cash_v1(uuid)') is null then
  raise exception 'ga4_order_payment_contract_missing';
 end if;
end $$;
create unique index if not exists ga4_store_tenant_fk_idx on commerce_sync.connections(tenant_id,id);
create index if not exists ga4_order_number_idx on commerce_sync.external_entities(tenant_id,connection_id,(raw_payload->>'number')) where entity_type='order';
create index if not exists ga4_order_payload_id_idx on commerce_sync.external_entities(tenant_id,connection_id,(raw_payload->>'id')) where entity_type='order';

create table google_ads.ga4_settings(
 tenant_id uuid primary key references core.tenants(id),enabled boolean not null default false,
 config_id uuid not null default gen_random_uuid(),property_id text,property_name text,store_id uuid,
 currency text,timezone text,hostname text,updated_at timestamptz not null default now(),
 unique(tenant_id,config_id),foreign key(tenant_id,store_id) references commerce_sync.connections(tenant_id,id),
 check(not enabled or (property_id is not null and currency is not null and property_id ~ '^[0-9]{1,20}$' and store_id is not null and currency ~ '^[A-Z]{3}$' and timezone is not null and hostname is not null))
);
create table google_ads.ga4_properties(
 tenant_id uuid not null references core.tenants(id),property_id text not null check(property_id ~ '^[0-9]{1,20}$'),
 name text not null,credential_version bigint not null,primary key(tenant_id,property_id)
);
create table google_ads.ga4_runs(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),command_id uuid not null,
 kind text not null check(kind in('discover','configure','sync')),config_id uuid not null,credential_version bigint not null,
 actor_subject_id uuid not null references access_control.subjects(id),actor_auth_user_id uuid not null,
 property_id text,store_id uuid,date_from date,date_to date,
 lease_token uuid not null default gen_random_uuid(),lease_expires_at timestamptz not null default now()+interval '5 minutes',
 status text not null default 'running' check(status in('running','success','failed','superseded')),
 error_code text,quality jsonb,created_at timestamptz not null default now(),finished_at timestamptz,
 unique(tenant_id,id),unique(tenant_id,command_id),foreign key(tenant_id,store_id) references commerce_sync.connections(tenant_id,id)
);
create index ga4_runs_tenant_idx on google_ads.ga4_runs(tenant_id,created_at desc);
create table google_ads.ga4_rows(
 tenant_id uuid not null references core.tenants(id),config_id uuid not null,metric_date date not null,
 kind text not null check(kind in('transaction','traffic')),row_key text not null,payload jsonb not null,
 run_id uuid not null,primary key(tenant_id,config_id,kind,metric_date,row_key),
 foreign key(tenant_id,run_id) references google_ads.ga4_runs(tenant_id,id)
);
create index ga4_transaction_lookup_idx on google_ads.ga4_rows(tenant_id,config_id,(payload->>'transactionId')) where kind='transaction';
create table google_ads.ga4_coverage(
 tenant_id uuid not null references core.tenants(id),config_id uuid not null,metric_date date not null,run_id uuid not null,
 quality jsonb not null,synced_at timestamptz not null default now(),primary key(tenant_id,config_id,metric_date),
 foreign key(tenant_id,run_id) references google_ads.ga4_runs(tenant_id,id)
);
do $$ declare r record;begin
 for r in select tablename from pg_tables where schemaname='google_ads' and tablename like 'ga4_%' loop
  execute format('alter table google_ads.%I enable row level security',r.tablename);
  execute format('alter table google_ads.%I force row level security',r.tablename);
  execute format('revoke all on google_ads.%I from public,anon,authenticated,service_role',r.tablename);
 end loop;
end $$;

create function public.v1_tenant_google_ads_ga4_status(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,false);c google_ads.connections%rowtype;s google_ads.ga4_settings%rowtype;manage boolean;
begin
 select * into c from google_ads.connections where tenant_id=t;select * into s from google_ads.ga4_settings where tenant_id=t;
 manage:=private_app.has_tenant_permission(t,'tenant.marketing.manage') or private_app.has_tenant_permission(t,'tenant.settings.manage');
 return jsonb_build_object('configured',coalesce(s.enabled,false),'consentGranted',c.status='connected' and c.scopes @> array['https://www.googleapis.com/auth/analytics.readonly'],
  'canManage',manage,'canReadMoney',private_app.has_accounting_permission(t,'tenant.accounting.reports.read'),
  'property',case when s.enabled then jsonb_build_object('id',s.property_id,'name',s.property_name,'currency',s.currency,'timezone',s.timezone,'hostname',s.hostname) end,
  'stores',case when manage then coalesce((select jsonb_agg(jsonb_build_object('id',id,'url',store_url) order by store_url) from commerce_sync.connections where tenant_id=t),'[]'::jsonb) else '[]'::jsonb end,
  'properties',case when manage then coalesce((select jsonb_agg(jsonb_build_object('id',property_id,'name',name) order by name,property_id) from google_ads.ga4_properties where tenant_id=t and credential_version=c.credential_version),'[]'::jsonb) else '[]'::jsonb end,
  'latestRun',(select jsonb_build_object('status',status,'error',error_code,'at',coalesce(finished_at,created_at)) from google_ads.ga4_runs where tenant_id=t order by created_at desc,id desc limit 1));
end $$;
create function public.v1_tenant_google_ads_ga4_disable(p_slug text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true,false);
begin
 perform 1 from google_ads.connections where tenant_id=t for update;
 update google_ads.ga4_settings set enabled=false,config_id=gen_random_uuid(),updated_at=now() where tenant_id=t;
 update google_ads.ga4_runs set status='superseded',finished_at=now() where tenant_id=t and status='running';
 insert into google_ads.audit_events(tenant_id,actor_subject_id,action) values(t,private_app.current_subject_id(),'ga4_disabled');
 return jsonb_build_object('status','disabled');
end $$;
create function public.v1_tenant_google_ads_ga4_begin(p_slug text,p_kind text,p_command uuid,p_property text default null,p_connection uuid default null,p_from date default null,p_to date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true);c google_ads.connections%rowtype;s google_ads.ga4_settings%rowtype;r google_ads.ga4_runs%rowtype;
begin
 if p_command is null or p_kind is null or p_kind not in('discover','configure','sync') then raise exception 'invalid_request';end if;
 select * into c from google_ads.connections where tenant_id=t for update;
 if c.status is distinct from 'connected' or c.vault_secret_id is null then raise exception 'google_ads_connection_required';end if;
 if not c.scopes @> array['https://www.googleapis.com/auth/analytics.readonly'] then raise exception 'ga4_consent_required';end if;
 insert into google_ads.ga4_settings(tenant_id) values(t) on conflict do nothing;
 select * into s from google_ads.ga4_settings where tenant_id=t for update;
 if p_kind='configure' then
  if not exists(select 1 from google_ads.ga4_properties where tenant_id=t and property_id=p_property and credential_version=c.credential_version)
    or not exists(select 1 from commerce_sync.connections where tenant_id=t and id=p_connection) then raise exception 'ga4_invalid_property';end if;
 elsif p_kind='sync' then
  if not s.enabled then raise exception 'ga4_not_configured';end if;
  p_property:=s.property_id;p_connection:=s.store_id;
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>30 or p_to>(now() at time zone s.timezone)::date then raise exception 'google_ads_range_invalid';end if;
 end if;
 select * into r from google_ads.ga4_runs where tenant_id=t and command_id=p_command;
 if r.id is not null then
  if r.kind<>p_kind or r.property_id is distinct from p_property or r.store_id is distinct from p_connection or r.date_from is distinct from p_from or r.date_to is distinct from p_to then raise exception 'google_ads_command_reused';end if;
  return jsonb_build_object('duplicate',true,'status',r.status);
 end if;
 if exists(select 1 from google_ads.ga4_runs where tenant_id=t and status='running' and lease_expires_at>now() and credential_version=c.credential_version and config_id=s.config_id) then raise exception 'google_ads_sync_in_progress';end if;
 update google_ads.ga4_runs set status='superseded',finished_at=now() where tenant_id=t and status='running';
 insert into google_ads.ga4_runs(tenant_id,command_id,kind,config_id,credential_version,actor_subject_id,actor_auth_user_id,property_id,store_id,date_from,date_to)
 values(t,p_command,p_kind,s.config_id,c.credential_version,private_app.current_subject_id(),auth.uid(),p_property,p_connection,p_from,p_to) returning * into r;
 return jsonb_build_object('runId',r.id,'leaseToken',r.lease_token,'duplicate',false);
end $$;
create function google_ads.ga4_run(p_run uuid,p_lease uuid) returns google_ads.ga4_runs language plpgsql set search_path='' as $$
declare r google_ads.ga4_runs%rowtype;c google_ads.connections%rowtype;s google_ads.ga4_settings%rowtype;
begin
 perform google_ads.assert_service();select * into r from google_ads.ga4_runs where id=p_run;
 if r.id is null then raise exception 'google_ads_stale_lease';end if;
 perform google_ads.assert_actor(r.tenant_id,r.actor_auth_user_id,r.actor_subject_id);
 select * into c from google_ads.connections where tenant_id=r.tenant_id for update;
 select * into s from google_ads.ga4_settings where tenant_id=r.tenant_id for update;
 select * into r from google_ads.ga4_runs where id=p_run for update;
 if r.lease_token is distinct from p_lease or r.status<>'running' or r.lease_expires_at<=now() or c.status<>'connected'
  or c.credential_version<>r.credential_version or s.config_id<>r.config_id or (r.kind='sync' and not s.enabled)
  or not c.scopes @> array['https://www.googleapis.com/auth/analytics.readonly'] then raise exception 'google_ads_stale_lease';end if;
 return r;
end $$;
create function public.v1_service_google_ads_ga4_credentials(p_run uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r google_ads.ga4_runs%rowtype:=google_ads.ga4_run(p_run,p_lease);s google_ads.ga4_settings%rowtype;token text;
begin
 select v.decrypted_secret into token from google_ads.connections c join vault.decrypted_secrets v on v.id=c.vault_secret_id where c.tenant_id=r.tenant_id;
 if token is null then raise exception 'google_ads_credential_missing';end if;
 select * into s from google_ads.ga4_settings where tenant_id=r.tenant_id;
 return jsonb_build_object('refreshToken',token,'propertyId',r.property_id,'storeUrl',(select store_url from commerce_sync.connections where tenant_id=r.tenant_id and id=r.store_id),
 'dateFrom',r.date_from,'dateTo',r.date_to,'property',jsonb_build_object('id',s.property_id,'currency',s.currency,'timezone',s.timezone,'hostname',s.hostname));
end $$;
create function public.v1_service_google_ads_ga4_finish(p_run uuid,p_lease uuid,p_payload jsonb,p_success boolean,p_error text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r google_ads.ga4_runs%rowtype:=google_ads.ga4_run(p_run,p_lease);s google_ads.ga4_settings%rowtype;x jsonb;d date;k text;dims jsonb;
begin
 if p_success is distinct from true then
  update google_ads.ga4_runs set status='failed',finished_at=now(),error_code=case when p_error ~ '^[a-z0-9_]{1,100}$' then p_error else 'ga4_request_failed' end where id=r.id;
  return jsonb_build_object('status','failed','preservedPreviousData',true);
 end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>24000000 then raise exception 'ga4_invalid_response';end if;
 select * into s from google_ads.ga4_settings where tenant_id=r.tenant_id;
 if r.kind='discover' then
  if jsonb_typeof(p_payload->'properties') is distinct from 'array' or jsonb_array_length(p_payload->'properties')>500 then raise exception 'ga4_invalid_response';end if;
  delete from google_ads.ga4_properties where tenant_id=r.tenant_id;
  for x in select value from jsonb_array_elements(p_payload->'properties') loop
   if coalesce(x->>'id','') !~ '^[0-9]{1,20}$' or length(coalesce(x->>'name','')) not between 1 and 300 then raise exception 'ga4_invalid_response';end if;
   insert into google_ads.ga4_properties values(r.tenant_id,x->>'id',x->>'name',r.credential_version);
  end loop;
 elsif r.kind='configure' then
  x:=p_payload->'property';
  if x->>'id' is distinct from r.property_id or coalesce(x->>'currency','') !~ '^[A-Z]{3}$' or not exists(select 1 from pg_timezone_names where name=x->>'timezone')
    or coalesce(x->>'hostname','') !~ '^[a-z0-9][a-z0-9.-]{0,252}$' or length(coalesce(x->>'name','')) not between 1 and 300 then raise exception 'ga4_invalid_response';end if;
  -- Exact store selection was authorized before the server verified its GA4 web stream.
  update google_ads.ga4_settings set enabled=true,config_id=case when enabled and property_id=r.property_id and store_id=r.store_id and currency=x->>'currency' and timezone=x->>'timezone' and hostname=x->>'hostname' then config_id else gen_random_uuid() end,property_id=r.property_id,store_id=r.store_id,
    property_name=x->>'name',currency=x->>'currency',timezone=x->>'timezone',hostname=x->>'hostname',updated_at=now() where tenant_id=r.tenant_id;
 else
  if jsonb_typeof(p_payload->'transactions') is distinct from 'array' or jsonb_typeof(p_payload->'traffic') is distinct from 'array'
   or jsonb_array_length(p_payload->'transactions')>20000 or jsonb_array_length(p_payload->'traffic')>20000
   or jsonb_typeof(p_payload->'quality') is distinct from 'object' then raise exception 'ga4_invalid_response';end if;
  foreach k in array array['transactions','traffic'] loop
   foreach dims in array array['"thresholded"'::jsonb,'"otherRow"'::jsonb,'"sampled"'::jsonb,'"restricted"'::jsonb] loop
    if jsonb_typeof(p_payload->'quality'->k->(dims#>>'{}')) is distinct from 'boolean' then raise exception 'ga4_invalid_response';end if;
   end loop;
  end loop;
  delete from google_ads.ga4_rows where tenant_id=r.tenant_id and config_id=r.config_id and metric_date between r.date_from and r.date_to;
  foreach k in array array['transactions','traffic'] loop
   for x in select value from jsonb_array_elements(p_payload->k) loop
    d:=(x->>'date')::date;
    if d is null or d not between r.date_from and r.date_to or length(x::text)>10000 or coalesce(x->>'ecommercePurchases','') !~ '^[0-9]{1,15}$' then raise exception 'ga4_invalid_response';end if;
    if k='transactions' then
     if length(coalesce(x->>'transactionId','')) not between 1 and 300 or lower(x->>'hostName') not in(s.hostname,'www.'||s.hostname)
      or coalesce(x->>'grossPurchaseRevenue','') !~ '^[0-9]{1,18}(\.[0-9]{1,9})?$' then raise exception 'ga4_invalid_response';end if;
     dims:=x-array['ecommercePurchases','grossPurchaseRevenue'];
    else
     if coalesce(x->>'sessions','') !~ '^[0-9]{1,15}$' or coalesce(x->>'engagedSessions','') !~ '^[0-9]{1,15}$'
      or coalesce(x->>'screenPageViews','') !~ '^[0-9]{1,15}$' or coalesce(x->>'addToCarts','') !~ '^[0-9]{1,15}$' or coalesce(x->>'checkouts','') !~ '^[0-9]{1,15}$' then raise exception 'ga4_invalid_response';end if;
     dims:=x-array['sessions','engagedSessions','screenPageViews','addToCarts','checkouts','ecommercePurchases'];
    end if;
    insert into google_ads.ga4_rows values(r.tenant_id,r.config_id,d,case when k='transactions' then 'transaction' else 'traffic' end,md5(dims::text),x,r.id);
   end loop;
  end loop;
  insert into google_ads.ga4_coverage(tenant_id,config_id,metric_date,run_id,quality)
   select r.tenant_id,r.config_id,day::date,r.id,p_payload->'quality' from generate_series(r.date_from::timestamp,r.date_to::timestamp,interval '1 day') day
   on conflict(tenant_id,config_id,metric_date) do update set run_id=excluded.run_id,quality=excluded.quality,synced_at=now();
 end if;
 update google_ads.ga4_runs set status='success',quality=p_payload->'quality',finished_at=now() where id=r.id;
 insert into google_ads.audit_events(tenant_id,actor_subject_id,action,resource_id,context)
  values(r.tenant_id,r.actor_subject_id,'ga4_'||r.kind||'_completed',r.id::text,jsonb_build_object('from',r.date_from,'to',r.date_to));
 return jsonb_build_object('status','success','transactionRows',jsonb_array_length(p_payload->'transactions'));
end $$;

-- Read-only reconciliation. All candidate matching is exact, scoped to the selected store.
-- No phone/name heuristics, finance mutations, duplicate customer creation or attribution refresh.
create function google_ads.ga4_matches(p_tenant uuid,p_from date,p_to date,p_cutoff timestamptz)
returns table(transaction_id text,purchase_date date,source text,medium text,campaign_id text,account_id text,campaign_name text,
 order_id uuid,order_number text,order_status text,match_status text,ga4_value numeric,order_currency text,order_total bigint,
 collections bigint,refunds bigint,net_collections bigint,verified_registrations bigint,finance_currency_ok boolean,amount_check text,session_campaign_verified boolean)
language sql stable set search_path='' as $$
 with settings as materialized(select * from google_ads.ga4_settings where tenant_id=p_tenant and enabled),
 tx as materialized(
  select payload->>'transactionId' tid,min(g.metric_date) filter(where g.metric_date between p_from and p_to) purchase_date,count(*) evidence_rows,sum((payload->>'ecommercePurchases')::bigint) purchases,
   (array_agg(payload order by g.metric_date,row_key))[1] data,
   bool_or(exists(select 1 from jsonb_each(c.quality->'transactions') q where q.value='true'::jsonb)) limited
  from google_ads.ga4_rows g join settings s on g.config_id=s.config_id
  join google_ads.ga4_coverage c on c.tenant_id=g.tenant_id and c.config_id=g.config_id and c.metric_date=g.metric_date
  where g.tenant_id=p_tenant and g.kind='transaction' group by payload->>'transactionId'
 ), candidates as materialized(
  select tx.*,o.ids,cardinality(o.ids) candidate_count,o.ids[1] candidate_id from tx cross join settings s
  left join lateral(select array_agg(e.id order by e.id) ids from commerce_sync.external_entities e
   where e.tenant_id=p_tenant and e.connection_id=s.store_id and e.entity_type='order' and
   (e.external_id=tx.tid or e.raw_payload->>'number'=tx.tid or e.raw_payload->>'id'=tx.tid)) o on true
 ), collisions as(select candidate_id,count(*) n from candidates where candidate_count=1 group by candidate_id),
 facts as materialized(
  select c.*,e.raw_payload,w.id work_id,w.currency,w.amount_minor,w.order_number,w.order_status,
   case when c.tid in('(not set)','(other)','') then 'missing_transaction_id'
    when c.evidence_rows<>1 or c.purchases<>1 then 'duplicate_transaction'
    when c.limited then 'limited_ga4_data'
    when coalesce(c.candidate_count,0)=0 then 'order_not_found'
    when c.candidate_count<>1 then 'ambiguous_order'
    when coalesce(x.n,0)<>1 then 'order_reused'
    when w.id is null then 'order_not_routed'
    else 'matched' end status
  from candidates c left join collisions x on x.candidate_id=c.candidate_id
  left join commerce_sync.external_entities e on e.tenant_id=p_tenant and e.id=c.candidate_id and c.candidate_count=1
  left join sales_core.commerce_order_work_items w on w.tenant_id=p_tenant and w.external_entity_id=e.id and w.connection_id=e.connection_id
 ), cash as materialized(select * from private_app.campaign_cash_v1(p_tenant) where occurred_at<p_cutoff),
 financial as(
  select f.candidate_id,coalesce(sum(c.amount_minor) filter(where c.kind='collection' and c.currency=f.currency),0)::bigint gross,
   -coalesce(sum(c.amount_minor) filter(where c.kind='refund' and c.currency=f.currency),0)::bigint refunded,
   coalesce(bool_and(c.currency=f.currency),true) currency_ok,
   count(distinct l.handoff_id) filter(where h.payment_status='verified' and h.payment_verified_at is not null and h.payment_verified_at<p_cutoff) registrations
  from facts f join sales_core.commerce_admission_lines l on l.tenant_id=p_tenant and l.work_item_id=f.work_id
  join academy.registration_handoffs h on h.tenant_id=p_tenant and h.id=l.handoff_id
  left join cash c on c.handoff_id=h.id where f.status='matched' group by f.candidate_id
 )
 select f.tid,f.purchase_date,f.data->>'sessionSource',f.data->>'sessionMedium',f.data->>'sessionGoogleAdsCampaignId',
 f.data->>'sessionGoogleAdsCustomerId',f.data->>'sessionCampaignName',case when f.status='matched' then f.candidate_id end,f.order_number,f.order_status,
 case when f.status='matched' and fin.currency_ok is false then 'finance_currency_conflict' when f.status='matched' and coalesce(fin.gross,0)>0 then 'verified' when f.status='matched' then 'payment_pending' else f.status end,
 (f.data->>'grossPurchaseRevenue')::numeric,f.currency,f.amount_minor,coalesce(fin.gross,0),coalesce(fin.refunded,0),coalesce(fin.gross-fin.refunded,0),coalesce(fin.registrations,0),coalesce(fin.currency_ok,true),
 case when f.status<>'matched' then 'not_comparable'
  when f.currency is distinct from s.currency or f.data->>'currencyCode' is distinct from s.currency then 'currency_mismatch'
  when jsonb_typeof(f.raw_payload->'line_items') is distinct from 'array' or jsonb_array_length(f.raw_payload->'line_items')=0
   or exists(select 1 from jsonb_array_elements(f.raw_payload->'line_items') i where coalesce(i->>'total','') !~ '^[0-9]{1,18}(\.[0-9]{1,9})?$') then 'item_value_missing'
  when abs((f.data->>'grossPurchaseRevenue')::numeric-(select sum((i->>'total')::numeric) from jsonb_array_elements(f.raw_payload->'line_items') i)) <= 1/power(10::numeric,google_ads.minor_digits(s.currency)) then 'consistent_item_value'
  else 'value_difference' end,
 exists(select 1 from google_ads.campaigns c join google_ads.connections a on a.tenant_id=c.tenant_id and a.selected_account_id=c.account_id
  where c.tenant_id=p_tenant and c.account_id=f.data->>'sessionGoogleAdsCustomerId' and c.campaign_id=f.data->>'sessionGoogleAdsCampaignId')
 from facts f cross join settings s left join financial fin on fin.candidate_id=f.candidate_id
 where f.purchase_date between p_from and p_to;
$$;

create function public.v1_tenant_google_ads_ga4_report(p_slug text,p_from date,p_to date,p_as_of date default null,p_page integer default 1,p_status text default 'all',p_campaign text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,false);s google_ads.ga4_settings%rowtype;tz text;cutoff timestamptz;money boolean;details boolean;result jsonb;
begin
 select * into s from google_ads.ga4_settings where tenant_id=t;
 if not coalesce(s.enabled,false) then return jsonb_build_object('configured',false);end if;
 select timezone into tz from core.tenants where id=t;p_as_of:=coalesce(p_as_of,(now() at time zone tz)::date);
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>30 or p_to>(now() at time zone s.timezone)::date
  or p_as_of<p_to or p_as_of>(now() at time zone tz)::date or p_page is null or p_page not between 1 and 10000
  or p_status not in('all','verified','payment_pending','unmatched') or (p_campaign is not null and p_campaign !~ '^[0-9]{1,20}$') then raise exception 'google_ads_range_invalid';end if;
 cutoff:=least((p_as_of+1)::timestamp at time zone tz,now());
 money:=private_app.has_accounting_permission(t,'tenant.accounting.reports.read');
 details:=private_app.has_tenant_permission(t,'tenant.leads.read') or private_app.has_tenant_permission(t,'tenant.crm.read');
 with matches as materialized(select * from google_ads.ga4_matches(t,p_from,p_to,cutoff)),
 visible as materialized(select * from matches where (p_status='all' or match_status=p_status or (p_status='unmatched' and match_status not in('verified','payment_pending')))
  and (p_campaign is null or (session_campaign_verified and campaign_id=p_campaign))),
 page as(select * from visible order by purchase_date desc,transaction_id offset (p_page-1)*50 limit 50),
 coverage as(select count(*) n,min(synced_at) oldest,max(synced_at) latest,bool_or(exists(select 1 from jsonb_each(quality->'transactions') q where q.value='true'::jsonb)) tx_limited,
  bool_or(exists(select 1 from jsonb_each(quality->'traffic') q where q.value='true'::jsonb)) traffic_limited
  from google_ads.ga4_coverage where tenant_id=t and config_id=s.config_id and metric_date between p_from and p_to),
 traffic as materialized(select payload from google_ads.ga4_rows where tenant_id=t and config_id=s.config_id and kind='traffic' and metric_date between p_from and p_to),
 money_groups as(select order_currency currency,sum(collections) gross,sum(refunds) refunded,sum(net_collections) net
  from matches where match_status='verified' group by order_currency),
 campaign_results as(select account_id,campaign_id,max(campaign_name) name,count(*) orders,count(*) filter(where match_status='verified') verified,
  sum(verified_registrations) registrations,count(*) filter(where match_status not in('verified','payment_pending')) unmatched
  from matches where session_campaign_verified group by account_id,campaign_id)
 select jsonb_build_object('configured',true,'canReadMoney',money,'canReadDetails',details,'range',jsonb_build_object('from',p_from,'to',p_to,'asOf',p_as_of),
 'property',jsonb_build_object('id',s.property_id,'name',s.property_name,'currency',s.currency,'timezone',s.timezone,'hostname',s.hostname),
 'basis','purchase_session_orders','coverage',(select jsonb_build_object('complete',n=p_to-p_from+1,'missingDays',p_to-p_from+1-n,'oldestSync',oldest,'latestSync',latest,'transactionDataLimited',coalesce(tx_limited,false),'trafficDataLimited',coalesce(traffic_limited,false)) from coverage),
 'summary',(select jsonb_build_object('transactions',count(*),'matchedOrders',count(*) filter(where match_status in('verified','payment_pending')),
  'verifiedOrders',count(*) filter(where match_status='verified'),'pendingPayments',count(*) filter(where match_status='payment_pending'),
  'unmatched',count(*) filter(where match_status not in('verified','payment_pending')),'sessionAttributedOrders',count(*) filter(where session_campaign_verified and match_status in('verified','payment_pending')),
  'verifiedRegistrations',coalesce(sum(verified_registrations),0),'valueDifferences',case when money then count(*) filter(where amount_check='value_difference') end) from matches),
 'traffic',(select jsonb_build_object('sessions',case when (select n from coverage)=p_to-p_from+1 then coalesce(sum((payload->>'sessions')::bigint),0) else sum((payload->>'sessions')::bigint) end,'engagedSessions',case when (select n from coverage)=p_to-p_from+1 then coalesce(sum((payload->>'engagedSessions')::bigint),0) else sum((payload->>'engagedSessions')::bigint) end,
  'pageViews',case when (select n from coverage)=p_to-p_from+1 then coalesce(sum((payload->>'screenPageViews')::bigint),0) else sum((payload->>'screenPageViews')::bigint) end,'addToCarts',case when (select n from coverage)=p_to-p_from+1 then coalesce(sum((payload->>'addToCarts')::bigint),0) else sum((payload->>'addToCarts')::bigint) end,'checkouts',case when (select n from coverage)=p_to-p_from+1 then coalesce(sum((payload->>'checkouts')::bigint),0) else sum((payload->>'checkouts')::bigint) end,'purchases',case when (select n from coverage)=p_to-p_from+1 then coalesce(sum((payload->>'ecommercePurchases')::bigint),0) else sum((payload->>'ecommercePurchases')::bigint) end) from traffic),
 'finances',case when money then coalesce((select jsonb_agg(jsonb_build_object('currency',currency,'collectionsMinor',gross,'refundsMinor',refunded,'netMinor',net) order by currency) from money_groups),'[]'::jsonb) else '[]'::jsonb end,
 'campaigns',coalesce((select jsonb_agg(jsonb_build_object('id',campaign_id,'accountId',account_id,'name',name,'orders',orders,'verifiedOrders',verified,'verifiedRegistrations',registrations,'unmatched',unmatched,'finances',case when money then coalesce((select jsonb_agg(jsonb_build_object('currency',f.currency,'collectionsMinor',f.gross,'refundsMinor',f.refunded,'netMinor',f.net)) from (select m.order_currency currency,sum(m.collections) gross,sum(m.refunds) refunded,sum(m.net_collections) net from matches m where m.session_campaign_verified and m.campaign_id=campaign_results.campaign_id and m.account_id=campaign_results.account_id and m.match_status='verified' group by m.order_currency) f),'[]'::jsonb) else '[]'::jsonb end) order by orders desc,campaign_id) from campaign_results),'[]'::jsonb),
 'issues',coalesce((select jsonb_agg(jsonb_build_object('reason',match_status,'count',n)) from(select match_status,count(*) n from matches where match_status not in('verified','payment_pending') group by match_status) q),'[]'::jsonb),
 'page',p_page,'totalRows',(select count(*) from visible),'hasMore',(select count(*) from visible)>p_page*50,
 'rows',case when details then coalesce((select jsonb_agg(jsonb_build_object('transactionId',transaction_id,'date',purchase_date,'source',source,'medium',medium,
  'campaignId',case when session_campaign_verified then campaign_id end,'campaignName',campaign_name,'orderNumber',order_number,'orderStatus',order_status,'status',match_status,
  'verifiedRegistrations',verified_registrations,'financeCurrencyOk',case when money then finance_currency_ok end,'amountCheck',case when money then amount_check end,
  'currency',case when money then order_currency end,'orderTotalMinor',case when money then order_total end,'ga4Value',case when money then ga4_value end,
  'collectionsMinor',case when money then collections end,'refundsMinor',case when money then refunds end,'netMinor',case when money then net_collections end) order by purchase_date desc,transaction_id) from page),'[]'::jsonb) else '[]'::jsonb end) into result;
 return result;
end $$;
revoke all on function google_ads.ga4_run(uuid,uuid),google_ads.ga4_matches(uuid,date,date,timestamptz) from public,anon,authenticated,service_role;
do $$ declare r record;begin
 for r in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'v1_tenant_google_ads_ga4_%' or p.proname like 'v1_service_google_ads_ga4_%') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
  execute format('grant execute on function %s to %I',r.signature,case when r.proname like 'v1_service_%' then 'service_role' else 'authenticated' end);
 end loop;
end $$;
commit;
