-- GA4 site analytics requests transaction details only when reconciliation is configured.
-- No backfill, tenant activation or operational data changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

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
  -- An omitted transaction report is allowed only when the leased configuration has no source.
  if p_payload->'quality'->'transactions' ? 'status' then
   if p_payload->'quality'->'transactions'->>'status' is distinct from 'not_requested'
    or r.store_id is not null or jsonb_array_length(p_payload->'transactions')<>0
    or exists(select 1 from jsonb_each(p_payload->'quality'->'transactions') q where q.value='true'::jsonb)
    then raise exception 'ga4_invalid_response';end if;
  end if;
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
 return jsonb_build_object('status','success','transactionRows',case when p_payload->'quality'->'transactions'->>'status'='not_requested' then null else jsonb_array_length(p_payload->'transactions') end,'streams',case when r.kind='streams' then (select discovered_streams from google_ads.ga4_runs where id=r.id) end);
end $$;

create or replace function google_ads.ga4_site_summary(p_tenant uuid,p_config uuid,p_from date,p_to date)
returns jsonb language sql stable set search_path='' as $$
 with coverage as(
  select count(*) n,min(synced_at) oldest,max(synced_at) latest,
   bool_or(quality->'transactions'->>'status'='not_requested') tx_skipped,
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
  'coverage',(select jsonb_build_object('complete',n=p_to-p_from+1,'missingDays',p_to-p_from+1-n,'oldestSync',oldest,'latestSync',latest,'transactionReportAvailable',n>0 and not coalesce(tx_skipped,false),'transactionDataLimited',coalesce(tx_limited,false),'trafficDataLimited',coalesce(traffic_limited,false)) from coverage),
  'traffic',(select jsonb_build_object(
   'sessions',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'sessions')::bigint),0) end,
   'engagedSessions',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'engagedSessions')::bigint),0) end,
   'pageViews',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'screenPageViews')::bigint),0) end,
   'addToCarts',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'addToCarts')::bigint),0) end,
   'checkouts',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'checkouts')::bigint),0) end,
   'purchases',case when (select n from coverage)=0 then null else coalesce(sum((payload->>'ecommercePurchases')::bigint),0) end) from traffic),
  'transactions',case when (select n=0 or coalesce(tx_skipped,false) from coverage) then null else (select count(distinct payload->>'transactionId') from google_ads.ga4_rows
    where tenant_id=p_tenant and config_id=p_config and kind='transaction' and metric_date between p_from and p_to and payload->>'transactionId' not in('','(not set)','(other)')) end,
  'trafficSourceCount',(select count(*) from sources),
  'trafficSources',coalesce((select jsonb_agg(jsonb_build_object('source',source,'medium',medium,'sessions',sessions,'engagedSessions',engaged,'pageViews',views,'purchases',purchases) order by sessions desc,source,medium) from top_sources),'[]'::jsonb)
 );
$$;

-- CREATE OR REPLACE preserves the existing RPC and internal-function ACLs.
commit;
