-- GA4 site analytics is independent of order ingestion. No backfill or tenant activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

alter table google_ads.ga4_settings add column if not exists stream_id text check(stream_id ~ '^[0-9]{1,20}$');
alter table google_ads.ga4_runs add column if not exists stream_id text check(stream_id ~ '^[0-9]{1,20}$');
alter table google_ads.ga4_runs add column if not exists discovered_streams jsonb check(discovered_streams is null or (jsonb_typeof(discovered_streams)='array' and octet_length(discovered_streams::text)<=100000));
-- Expand configuration capability without changing any saved binding or observation.
alter table google_ads.ga4_settings drop constraint if exists ga4_settings_check;
alter table google_ads.ga4_settings add constraint ga4_settings_check check(not enabled or
 (property_id is not null and currency is not null and property_id ~ '^[0-9]{1,20}$'
 and (store_id is not null or stream_id is not null) and currency ~ '^[A-Z]{3}$' and timezone is not null and hostname is not null));
alter table google_ads.ga4_runs drop constraint if exists ga4_runs_kind_check;
alter table google_ads.ga4_runs add constraint ga4_runs_kind_check check(kind in('discover','streams','configure','sync'));


create or replace function public.v1_tenant_google_ads_ga4_status(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,false);c google_ads.connections%rowtype;s google_ads.ga4_settings%rowtype;manage boolean;
begin
 select * into c from google_ads.connections where tenant_id=t;select * into s from google_ads.ga4_settings where tenant_id=t;
 manage:=private_app.has_tenant_permission(t,'tenant.marketing.manage') or private_app.has_tenant_permission(t,'tenant.settings.manage');
 return jsonb_build_object('configured',coalesce(s.enabled,false),'consentGranted',c.status='connected' and c.scopes @> array['https://www.googleapis.com/auth/analytics.readonly'],
  'canManage',manage,'canReadMoney',private_app.has_accounting_permission(t,'tenant.accounting.reports.read'),
  'property',case when s.enabled then jsonb_build_object('id',s.property_id,'name',s.property_name,'currency',s.currency,'timezone',s.timezone,'hostname',s.hostname,'streamId',s.stream_id) end,
  'reconciliation',jsonb_build_object('enabled',coalesce(s.enabled and s.store_id is not null,false),'provider',case when s.store_id is not null then 'woocommerce' end,'connectionId',case when manage then s.store_id end),
  'stores',case when manage then coalesce((select jsonb_agg(jsonb_build_object('id',id,'url',store_url) order by store_url) from commerce_sync.connections where tenant_id=t),'[]'::jsonb) else '[]'::jsonb end,
  'properties',case when manage then coalesce((select jsonb_agg(jsonb_build_object('id',property_id,'name',name) order by name,property_id) from google_ads.ga4_properties where tenant_id=t and credential_version=c.credential_version),'[]'::jsonb) else '[]'::jsonb end,
  'latestRun',(select jsonb_build_object('status',status,'error',error_code,'at',coalesce(finished_at,created_at)) from google_ads.ga4_runs where tenant_id=t order by created_at desc,id desc limit 1));
end $$;

create or replace function public.v1_tenant_google_ads_ga4_begin_v2(p_slug text,p_kind text,p_command uuid,p_property text default null,p_connection uuid default null,p_from date default null,p_to date default null,p_stream text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true);c google_ads.connections%rowtype;s google_ads.ga4_settings%rowtype;r google_ads.ga4_runs%rowtype;
begin
 if p_command is null or p_kind is null or p_kind not in('discover','streams','configure','sync') then raise exception 'invalid_request';end if;
 select * into c from google_ads.connections where tenant_id=t for update;
 if c.status is distinct from 'connected' or c.vault_secret_id is null then raise exception 'google_ads_connection_required';end if;
 if not c.scopes @> array['https://www.googleapis.com/auth/analytics.readonly'] then raise exception 'ga4_consent_required';end if;
 insert into google_ads.ga4_settings(tenant_id) values(t) on conflict do nothing;
 select * into s from google_ads.ga4_settings where tenant_id=t for update;
 if p_kind in('discover','streams') then p_connection:=null;p_stream:=null;p_from:=null;p_to:=null;end if;
 if p_kind='discover' then p_property:=null;end if;
 if p_stream is not null and p_stream !~ '^[0-9]{1,20}$' then raise exception 'ga4_stream_required';end if;
 if p_kind in('configure','streams') then
  if not exists(select 1 from google_ads.ga4_properties where tenant_id=t and property_id=p_property and credential_version=c.credential_version)
    or (p_connection is not null and not exists(select 1 from commerce_sync.connections where tenant_id=t and id=p_connection)) then raise exception 'ga4_invalid_property';end if;
   if p_kind='configure' and p_connection is null and p_stream is null then raise exception 'ga4_stream_required';end if;
 elsif p_kind='sync' then
  if not s.enabled then raise exception 'ga4_not_configured';end if;
  p_property:=s.property_id;p_connection:=s.store_id;p_stream:=s.stream_id;
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>30 or p_to>(now() at time zone s.timezone)::date then raise exception 'google_ads_range_invalid';end if;
 end if;
 select * into r from google_ads.ga4_runs where tenant_id=t and command_id=p_command;
 if r.id is not null then
  if r.kind<>p_kind or r.property_id is distinct from p_property or r.store_id is distinct from p_connection or r.stream_id is distinct from p_stream or r.credential_version<>c.credential_version or r.date_from is distinct from p_from or r.date_to is distinct from p_to then raise exception 'google_ads_command_reused';end if;
  return jsonb_build_object('duplicate',true,'status',r.status,'streams',case when r.kind='streams' then r.discovered_streams end);
 end if;
 if exists(select 1 from google_ads.ga4_runs where tenant_id=t and status='running' and lease_expires_at>now() and credential_version=c.credential_version and config_id=s.config_id) then raise exception 'google_ads_sync_in_progress';end if;
 update google_ads.ga4_runs set status='superseded',finished_at=now() where tenant_id=t and status='running';
 insert into google_ads.ga4_runs(tenant_id,command_id,kind,config_id,credential_version,actor_subject_id,actor_auth_user_id,property_id,store_id,store_url,date_from,date_to,stream_id)
 values(t,p_command,p_kind,s.config_id,c.credential_version,private_app.current_subject_id(),auth.uid(),p_property,p_connection,(select store_url from commerce_sync.connections where tenant_id=t and id=p_connection),p_from,p_to,p_stream) returning * into r;
 return jsonb_build_object('runId',r.id,'leaseToken',r.lease_token,'duplicate',false);
end $$;

create or replace function public.v1_tenant_google_ads_ga4_begin(p_slug text,p_kind text,p_command uuid,p_property text default null,p_connection uuid default null,p_from date default null,p_to date default null)
returns jsonb language sql security definer set search_path='' as $$
 select public.v1_tenant_google_ads_ga4_begin_v2(p_slug,p_kind,p_command,p_property,p_connection,p_from,p_to,null);
$$;

create or replace function public.v1_service_google_ads_ga4_credentials(p_run uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r google_ads.ga4_runs%rowtype:=google_ads.ga4_run(p_run,p_lease);s google_ads.ga4_settings%rowtype;token text;
begin
 select v.decrypted_secret into token from google_ads.connections c join vault.decrypted_secrets v on v.id=c.vault_secret_id where c.tenant_id=r.tenant_id;
 if token is null then raise exception 'google_ads_credential_missing';end if;
 select * into s from google_ads.ga4_settings where tenant_id=r.tenant_id;
 return jsonb_build_object('refreshToken',token,'propertyId',r.property_id,'storeUrl',r.store_url,'streamId',r.stream_id,
 'dateFrom',r.date_from,'dateTo',r.date_to,'property',jsonb_build_object('id',s.property_id,'currency',s.currency,'timezone',s.timezone,'hostname',s.hostname,'streamId',s.stream_id));
end $$;

create or replace function public.v1_service_google_ads_ga4_finish(p_run uuid,p_lease uuid,p_payload jsonb,p_success boolean,p_error text default null)
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
 elsif r.kind='streams' then
  if jsonb_typeof(p_payload->'streams') is distinct from 'array' or jsonb_array_length(p_payload->'streams')>100 then raise exception 'ga4_invalid_response';end if;
  for x in select value from jsonb_array_elements(p_payload->'streams') loop
   if coalesce(x->>'id','') !~ '^[0-9]{1,20}$' or length(coalesce(x->>'name','')) not between 1 and 300
     or coalesce(x->>'hostname','') !~ '^[a-z0-9][a-z0-9.-]{0,252}$' then raise exception 'ga4_invalid_response';end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_payload->'streams'))<>jsonb_array_length(p_payload->'streams') then raise exception 'ga4_invalid_response';end if;
  update google_ads.ga4_runs set discovered_streams=coalesce((select jsonb_agg(jsonb_build_object('id',value->>'id','name',value->>'name','hostname',value->>'hostname')) from jsonb_array_elements(p_payload->'streams')),'[]'::jsonb) where id=r.id;
 elsif r.kind='configure' then
  x:=p_payload->'property';
  if x->>'id' is distinct from r.property_id or coalesce(x->>'currency','') !~ '^[A-Z]{3}$' or not exists(select 1 from pg_timezone_names where name=x->>'timezone')
    or coalesce(x->>'hostname','') !~ '^[a-z0-9][a-z0-9.-]{0,252}$' or length(coalesce(x->>'name','')) not between 1 and 300 then raise exception 'ga4_invalid_response';end if;
  if r.stream_id is not null and x->>'streamId' is distinct from r.stream_id then raise exception 'ga4_invalid_response';end if;
  if r.store_id is null and r.stream_id is null then raise exception 'ga4_stream_required';end if;
  -- The service verified this property's exact web stream; a store remains optional.
  update google_ads.ga4_settings set enabled=true,config_id=case when enabled and property_id=r.property_id and store_id is not distinct from r.store_id and stream_id is not distinct from r.stream_id and currency=x->>'currency' and timezone=x->>'timezone' and hostname=x->>'hostname' then config_id else gen_random_uuid() end,property_id=r.property_id,store_id=r.store_id,stream_id=r.stream_id,
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
 return jsonb_build_object('status','success','transactionRows',jsonb_array_length(p_payload->'transactions'),'streams',case when r.kind='streams' then (select discovered_streams from google_ads.ga4_runs where id=r.id) end);
end $$;

create or replace function google_ads.ga4_site_summary(p_tenant uuid,p_config uuid,p_from date,p_to date)
returns jsonb language sql stable set search_path='' as $$
 with coverage as(
  select count(*) n,min(synced_at) oldest,max(synced_at) latest,
   bool_or(exists(select 1 from jsonb_each(quality->'transactions') q where q.value='true'::jsonb)) tx_limited,
   bool_or(exists(select 1 from jsonb_each(quality->'traffic') q where q.value='true'::jsonb)) traffic_limited
  from google_ads.ga4_coverage where tenant_id=p_tenant and config_id=p_config and metric_date between p_from and p_to
 ), traffic as materialized(
  select payload from google_ads.ga4_rows where tenant_id=p_tenant and config_id=p_config and kind='traffic' and metric_date between p_from and p_to
 ), sources as materialized(
  select payload->>'sessionSource' source,payload->>'sessionMedium' medium,sum((payload->>'sessions')::bigint) sessions,
   sum((payload->>'engagedSessions')::bigint) engaged,sum((payload->>'screenPageViews')::bigint) views,
   sum((payload->>'ecommercePurchases')::bigint) purchases
  from traffic group by payload->>'sessionSource',payload->>'sessionMedium'
 ), top_sources as(select * from sources order by sessions desc,source,medium limit 20)
 select jsonb_build_object(
  'coverage',(select jsonb_build_object('complete',n=p_to-p_from+1,'missingDays',p_to-p_from+1-n,'oldestSync',oldest,'latestSync',latest,'transactionDataLimited',coalesce(tx_limited,false),'trafficDataLimited',coalesce(traffic_limited,false)) from coverage),
  'traffic',(select jsonb_build_object(
   'sessions',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'sessions')::bigint),0) end,
   'engagedSessions',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'engagedSessions')::bigint),0) end,
   'pageViews',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'screenPageViews')::bigint),0) end,
   'addToCarts',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'addToCarts')::bigint),0) end,
   'checkouts',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'checkouts')::bigint),0) end,
   'purchases',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'ecommercePurchases')::bigint),0) end) from traffic),
  'transactions',case when (select n from coverage)=0 then null else (select count(distinct payload->>'transactionId') from google_ads.ga4_rows
    where tenant_id=p_tenant and config_id=p_config and kind='transaction' and metric_date between p_from and p_to and payload->>'transactionId' not in('','(not set)','(other)')) end,
  'trafficSourceCount',(select count(*) from sources),
  'trafficSources',coalesce((select jsonb_agg(jsonb_build_object('source',source,'medium',medium,'sessions',sessions,'engagedSessions',engaged,'pageViews',views,'purchases',purchases) order by sessions desc,source,medium) from top_sources),'[]'::jsonb)
 );
$$;

create or replace function public.v1_tenant_google_ads_ga4_report(p_slug text,p_from date,p_to date,p_as_of date default null,p_page integer default 1,p_status text default 'all',p_campaign text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,false);s google_ads.ga4_settings%rowtype;tz text;cutoff timestamptz;money boolean;details boolean;result jsonb;site jsonb;
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
 site:=google_ads.ga4_site_summary(t,s.config_id,p_from,p_to);
 if s.store_id is null then
  return site||jsonb_build_object('configured',true,'canReadMoney',money,'canReadDetails',details,
   'range',jsonb_build_object('from',p_from,'to',p_to,'asOf',p_as_of),
   'property',jsonb_build_object('id',s.property_id,'name',s.property_name,'currency',s.currency,'timezone',s.timezone,'hostname',s.hostname,'streamId',s.stream_id),
   'basis','site_activity','reconciliation',jsonb_build_object('enabled',false,'provider',null),
   'summary',jsonb_build_object('transactions',site->'transactions','matchedOrders',null,'verifiedOrders',null,'pendingPayments',null,
    'unmatched',null,'sessionAttributedOrders',null,'verifiedRegistrations',null,'valueDifferences',null),
   'finances','[]'::jsonb,'campaigns','[]'::jsonb,'issues','[]'::jsonb,'rows','[]'::jsonb,'page',p_page,'totalRows',0,'hasMore',false);
 end if;
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
 'property',jsonb_build_object('id',s.property_id,'name',s.property_name,'currency',s.currency,'timezone',s.timezone,'hostname',s.hostname,'streamId',s.stream_id),
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
 return result||jsonb_build_object('reconciliation',jsonb_build_object('enabled',true,'provider','woocommerce'),
  'trafficSources',site->'trafficSources','trafficSourceCount',site->'trafficSourceCount');
end $$;

revoke all on function google_ads.ga4_site_summary(uuid,uuid,date,date) from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_google_ads_ga4_begin_v2(text,text,uuid,text,uuid,date,date,text) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_google_ads_ga4_begin_v2(text,text,uuid,text,uuid,date,date,text) to authenticated;
-- CREATE OR REPLACE preserves existing ACLs on all prior RPCs.
commit;

