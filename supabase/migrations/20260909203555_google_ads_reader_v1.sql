-- ODEIR Google Ads reader v1. Isolated, additive, disabled by default.
-- Never inserts into legacy marketing_hub tables or invokes attribution refresh.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

insert into catalog.features(feature_key,name_ar,name_en,category,value_type,default_value,status)
values('addon.integrations.google_ads_connect','تحليلات إعلانات جوجل','Google Ads analytics','addon','boolean','false','beta')
on conflict(feature_key) do nothing;
insert into catalog.addon_products(product_key,feature_id,name_ar,name_en,description_ar,pricing_mode,amount_minor,currency,interval,trial_days,usage_metric,default_limit,status,sort_order,marketplace_category,badge_ar,activation_mode,is_marketplace_visible)
select 'google_ads_connect',id,'تحليلات إعلانات جوجل','Google Ads analytics','قراءة الحملات والإنفاق ونتائج جوجل مع ربط مصادر أودير يدويًا.','contact_sales',0,'SAR','month',0,'connected_accounts',1,'draft',96,'integrations','خاص — تجريبي','entitlement',false
from catalog.features where feature_key='addon.integrations.google_ads_connect'
on conflict(product_key) do nothing;
insert into catalog.addon_manifests(product_id,manifest_version,contract_version,short_description_ar,long_description_ar,publisher_name,install_mode,data_policy,dependencies,required_permissions,configuration_schema,release_notes_ar,status,is_current,released_at)
select id,'0.1.0-private',3,'قراءة الحملات والإنفاق ونتائج جوجل.','اتصال منفصل؛ الربط بالعملاء يدوي ومراجع.','Marktone','entitlement','preserve_on_disable','[]',array['tenant.reports.campaigns'],'{"type":"object","additionalProperties":false,"properties":{}}','إصدار خاص مغلق افتراضيًا؛ لا إدارة حملات ولا تتبع تلقائي.','draft',false,null
from catalog.addon_products where product_key='google_ads_connect'
on conflict(product_id,manifest_version) do nothing;
insert into catalog.addon_surfaces(manifest_id,surface_key,surface_type,location_key,title_ar,description_ar,route_template,icon_key,required_permission,visibility_mode,status,sort_order,metadata)
select m.id,'tenant.google_ads','report','tenant.google_ads','تحليلات إعلانات جوجل','اتصال جوجل وقراءة الحملات والربط اليدوي للمصادر.','/tenant/{slug}/reports/google-ads','chart','tenant.reports.campaigns','when_entitled','draft',20,'{"productKey":"google_ads_connect"}'
from catalog.addon_manifests m join catalog.addon_products p on p.id=m.product_id where p.product_key='google_ads_connect' and m.manifest_version='0.1.0-private'
on conflict(manifest_id,surface_key) do nothing;

create schema google_ads;
revoke all on schema google_ads from public,anon,authenticated,service_role;
create table google_ads.rollouts(tenant_id uuid primary key references core.tenants(id) on delete restrict,enabled boolean not null default false);
create table google_ads.connections(
 tenant_id uuid primary key references core.tenants(id) on delete restrict,
 status text not null default 'disconnected' check(status in('disconnected','connected','reauth_required')),
 credential_version bigint not null default 0, oauth_generation bigint not null default 0, vault_secret_id uuid,
 selected_account_id text, scopes text[] not null default '{}',
 updated_at timestamptz not null default now(),last_synced_at timestamptz,last_error_code text
);
create table google_ads.oauth_transactions(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id) on delete restrict,
 actor_subject_id uuid not null references access_control.subjects(id) on delete restrict,actor_auth_user_id uuid not null,
 state_sha256 text not null unique check(state_sha256 ~ '^[a-f0-9]{64}$'),
 pkce_challenge text not null check(pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),return_path text not null,
 authorization_generation bigint not null,status text not null default 'pending' check(status in('pending','claimed','finalized','cancelled')),
 expires_at timestamptz not null default now()+interval '10 minutes',claimed_at timestamptz,created_at timestamptz not null default now()
);
create index google_ads_oauth_tenant_status_idx on google_ads.oauth_transactions(tenant_id,status,expires_at);
create table google_ads.accounts(
 tenant_id uuid not null references core.tenants(id) on delete restrict,customer_id text not null check(customer_id ~ '^[0-9]{1,20}$'),
 name text not null,currency text not null check(currency ~ '^[A-Z]{3}$'),timezone text not null,
 login_customer_id text check(login_customer_id is null or login_customer_id ~ '^[0-9]{1,20}$'),
 credential_version bigint not null,primary key(tenant_id,customer_id)
);
alter table google_ads.connections add constraint google_ads_selected_account_fk foreign key(tenant_id,selected_account_id) references google_ads.accounts(tenant_id,customer_id) on delete restrict;
create table google_ads.campaigns(
 tenant_id uuid not null references core.tenants(id) on delete restrict,account_id text not null,
 campaign_id text not null check(campaign_id ~ '^[0-9]{1,30}$'),name text not null,status text not null,channel_type text,
 updated_at timestamptz not null default now(),primary key(tenant_id,account_id,campaign_id),
 foreign key(tenant_id,account_id) references google_ads.accounts(tenant_id,customer_id) on delete restrict
);
create table google_ads.daily_metrics(
 tenant_id uuid not null,account_id text not null,campaign_id text not null,metric_date date not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),cost_micros numeric(30,0) not null,spend_minor bigint not null,
 impressions bigint not null check(impressions>=0),clicks bigint not null check(clicks>=0),
 google_conversions numeric not null check(abs(google_conversions)<=1e24),
 google_conversion_value numeric not null check(abs(google_conversion_value)<=1e24),
 primary key(tenant_id,account_id,campaign_id,metric_date),
 foreign key(tenant_id,account_id,campaign_id) references google_ads.campaigns(tenant_id,account_id,campaign_id) on delete restrict
);
create index google_ads_metrics_window_idx on google_ads.daily_metrics(tenant_id,account_id,metric_date);
create table google_ads.sync_runs(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id) on delete restrict,
 command_id uuid not null,actor_subject_id uuid not null references access_control.subjects(id) on delete restrict,actor_auth_user_id uuid not null,
 account_id text not null,credential_version bigint not null,date_from date not null,date_to date not null,
 lease_token uuid not null default gen_random_uuid(),lease_expires_at timestamptz not null default now()+interval '10 minutes',
 status text not null default 'running' check(status in('running','success','failed','superseded')),error_code text,
 created_at timestamptz not null default now(),finished_at timestamptz,unique(tenant_id,command_id),unique(tenant_id,id),check(date_to>=date_from and date_to-date_from<=30),
 foreign key(tenant_id,account_id) references google_ads.accounts(tenant_id,customer_id) on delete restrict
);
create index google_ads_runs_lease_idx on google_ads.sync_runs(tenant_id,status,lease_expires_at);
create table google_ads.coverage_days(
 tenant_id uuid not null references core.tenants(id) on delete restrict,account_id text not null,metric_date date not null,
 run_id uuid not null,synced_at timestamptz not null default now(),
 primary key(tenant_id,account_id,metric_date),
 foreign key(tenant_id,account_id) references google_ads.accounts(tenant_id,customer_id) on delete restrict,
 foreign key(tenant_id,run_id) references google_ads.sync_runs(tenant_id,id) on delete restrict
);
create table google_ads.review_commands(
 tenant_id uuid not null references core.tenants(id) on delete restrict,command_id uuid not null,command_hash text not null,
 row_count integer not null,created_at timestamptz not null default now(),primary key(tenant_id,command_id)
);
create table google_ads.source_reviews(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id) on delete restrict,
 command_id uuid not null,origin_key text not null check(origin_key ~ '^(import|contact):[0-9a-f-]{36}$'),
 account_id text not null,campaign_id text not null,evidence text not null default 'manual_review' check(evidence='manual_review'),
 original jsonb not null,previous_id uuid references google_ads.source_reviews(id) on delete restrict,
 reason text not null,actor_subject_id uuid not null references access_control.subjects(id) on delete restrict,
 created_at timestamptz not null default now(),unique(tenant_id,command_id,origin_key),
 foreign key(tenant_id,command_id) references google_ads.review_commands(tenant_id,command_id) on delete restrict,
 foreign key(tenant_id,account_id,campaign_id) references google_ads.campaigns(tenant_id,account_id,campaign_id) on delete restrict
);
create index google_ads_review_origin_idx on google_ads.source_reviews(tenant_id,origin_key,created_at desc,id desc);
create table google_ads.audit_events(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id) on delete restrict,
 actor_subject_id uuid references access_control.subjects(id) on delete restrict,action text not null,
 resource_id text,context jsonb not null default '{}',created_at timestamptz not null default now()
);
create index google_ads_audit_tenant_idx on google_ads.audit_events(tenant_id,created_at desc);

do $$ declare r record; begin
 for r in select tablename from pg_tables where schemaname='google_ads' loop
  execute format('alter table google_ads.%I enable row level security',r.tablename);
  execute format('alter table google_ads.%I force row level security',r.tablename);
 end loop;
end $$;

-- Local preview of existing canonical sources; never edits contacts or imports.
create function google_ads.origins(p_tenant uuid)
returns table(origin_key text,contact_id uuid,received_at timestamptz,date_evidence text,source text,campaign_name text,full_name text,validation_status text,queue_status text,original jsonb,account_id text,campaign_id text,review_id uuid,preview_token text,review_stale boolean)
language sql stable set search_path='' as $$
 select o.origin_key,o.contact_id,o.received_at,o.date_evidence,o.source,o.campaign_name,o.full_name,o.validation_status,o.queue_status,o.original,r.account_id,r.campaign_id,r.id,
 md5(jsonb_build_object('origin',o.origin_key,'original',o.original,'contactId',o.contact_id,'validation',o.validation_status,'date',o.received_at,'reviewId',r.id)::text),r.id is not null and r.original is distinct from o.original
 from private_app.campaign_origins_v1(p_tenant) o left join lateral(
  select * from google_ads.source_reviews r where r.tenant_id=p_tenant and r.origin_key=o.origin_key order by r.created_at desc,r.id desc limit 1
 ) r on true
 where o.review_id is null;
$$;
create function public.v1_tenant_google_ads_sources(p_slug text,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true);a text;details boolean;result jsonb;
begin
 if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'google_ads_page_invalid'; end if;
 select selected_account_id into a from google_ads.connections where tenant_id=t;
 details:=private_app.has_tenant_permission(t,'tenant.leads.read') or private_app.has_tenant_permission(t,'tenant.crm.read');
 with origins as materialized(select * from google_ads.origins(t) where validation_status='valid'),
 page as(select * from origins order by origin_key offset p_offset limit 200)
 select jsonb_build_object('offset',p_offset,'totalRows',(select count(*) from origins),'hasMore',(select count(*) from origins)>p_offset+200,
 'rows',coalesce((select jsonb_agg(jsonb_build_object('originKey',origin_key,'previewToken',preview_token,'contactId',case when details then contact_id end,'name',case when details then full_name end,'source',source,'campaignName',campaign_name,'campaignId',case when account_id=a and not review_stale then campaign_id end,'evidence',case when review_id is null then 'unreviewed' when review_stale then 'stale_review' else 'manual_review' end) order by origin_key) from page),'[]'::jsonb),
 'campaigns',coalesce((select jsonb_agg(jsonb_build_object('campaignId',campaign_id,'name',name) order by name,campaign_id) from google_ads.campaigns where tenant_id=t and account_id=a),'[]'::jsonb)) into result;
 return result;
end $$;
create function public.v1_tenant_google_ads_review_sources(p_slug text,p_command_id uuid,p_campaign_id text,p_rows jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true);c google_ads.connections%rowtype;cmd google_ads.review_commands%rowtype;h text;n integer:=0;
begin
 if p_command_id is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 200 or length(trim(coalesce(p_reason,''))) not between 5 and 500 then raise exception 'google_ads_review_invalid'; end if;
 if exists(select 1 from jsonb_array_elements(p_rows) r group by r->>'originKey' having count(*)>1) then raise exception 'google_ads_review_duplicate_origin'; end if;
 select * into c from google_ads.connections where tenant_id=t for update;
 if c.status is distinct from 'connected' or not exists(select 1 from google_ads.campaigns where tenant_id=t and account_id=c.selected_account_id and campaign_id=p_campaign_id) then raise exception 'google_ads_campaign_not_found'; end if;
 h:=md5(jsonb_build_object('account',c.selected_account_id,'campaign',p_campaign_id,'rows',p_rows,'reason',p_reason)::text);
 select * into cmd from google_ads.review_commands where tenant_id=t and command_id=p_command_id;
 if cmd.command_id is not null then
  if cmd.command_hash<>h then raise exception 'google_ads_command_reused'; end if;
  return jsonb_build_object('reviewed',cmd.row_count,'replayed',true);
 end if;
 insert into google_ads.review_commands(tenant_id,command_id,command_hash,row_count) values(t,p_command_id,h,jsonb_array_length(p_rows));
 with selected as materialized(select o.* from google_ads.origins(t) o join jsonb_to_recordset(p_rows) q("originKey" text,"previewToken" text)
  on q."originKey"=o.origin_key and q."previewToken"=o.preview_token where o.validation_status='valid')
 insert into google_ads.source_reviews(tenant_id,command_id,origin_key,account_id,campaign_id,original,previous_id,reason,actor_subject_id)
 select t,p_command_id,o.origin_key,c.selected_account_id,p_campaign_id,o.original,o.review_id,p_reason,private_app.current_subject_id() from selected o;
 get diagnostics n=row_count;
 if n<>jsonb_array_length(p_rows) then raise exception 'google_ads_source_changed_refresh_preview'; end if;
 insert into google_ads.audit_events(tenant_id,actor_subject_id,action,resource_id,context) values(t,private_app.current_subject_id(),'source_reviewed',p_command_id::text,jsonb_build_object('count',n,'evidence','manual_review'));
 return jsonb_build_object('reviewed',n,'replayed',false);
end $$;

create function google_ads.minor_digits(p_currency text) returns integer language sql immutable set search_path='' as $$
 select case when p_currency in('BIF','CLP','DJF','GNF','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') then 0
 when p_currency in('BHD','IQD','JOD','KWD','LYD','OMR','TND') then 3 when p_currency in('CLF','UYW') then 4 else 2 end;
$$;
create function public.v1_tenant_google_ads_report(p_slug text,p_from date,p_to date,p_as_of date default null,p_page integer default 1,p_query text default '')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,false);a google_ads.accounts%rowtype;tz text;today date;start_at timestamptz;end_at timestamptz;cutoff timestamptz;
 money boolean;details boolean;missing integer;result jsonb;digits integer;
begin
 select timezone into tz from core.tenants where id=t;today:=(now() at time zone tz)::date;p_as_of:=coalesce(p_as_of,today);
 if p_from is null or p_to is null or p_from>p_to or p_to>today or p_to-p_from>30 or p_as_of<p_to or p_as_of>today or p_page is null or p_page<1 or p_page>10000 or length(coalesce(p_query,''))>80 then raise exception 'google_ads_range_invalid'; end if;
 select ac.* into a from google_ads.accounts ac join google_ads.connections c on c.tenant_id=ac.tenant_id and c.selected_account_id=ac.customer_id where ac.tenant_id=t;
 start_at:=p_from::timestamp at time zone tz;end_at:=(p_to+1)::timestamp at time zone tz;cutoff:=least((p_as_of+1)::timestamp at time zone tz,now());
 money:=private_app.has_accounting_permission(t,'tenant.accounting.reports.read');details:=private_app.has_tenant_permission(t,'tenant.leads.read') or private_app.has_tenant_permission(t,'tenant.crm.read');digits:=google_ads.minor_digits(a.currency);
 select (p_to-p_from+1)-count(*) into missing from google_ads.coverage_days where tenant_id=t and account_id=a.customer_id and metric_date between p_from and p_to;
 with origins as materialized(select * from private_app.campaign_origins_v1(t)),
 ranked as(select o.*,row_number() over(partition by coalesce(contact_id::text,origin_key) order by received_at,origin_key) n from origins o where validation_status='valid'),
 people as materialized(
  select o.origin_key,o.contact_id,o.full_name,o.received_at,o.date_evidence,r.campaign_id
  from ranked o join lateral(select * from google_ads.source_reviews r where r.tenant_id=t and r.origin_key=o.origin_key order by r.created_at desc,r.id desc limit 1) r on true
  where o.n=1 and o.review_id is null and r.original=o.original and r.account_id=a.customer_id and o.received_at>=start_at and o.received_at<end_at
 ), confirmed as materialized(
  select h.contact_id,private_app.campaign_cash_origin_v1(t,h.contact_id,h.opportunity_id) origin_key,
   count(distinct coalesce(h.opportunity_id::text,h.id::text)) registrations,min(h.payment_verified_at) verified_at
  from academy.registration_handoffs h where h.tenant_id=t and h.payment_status='verified' and h.payment_verified_at is not null and h.payment_verified_at<cutoff
  group by h.contact_id,private_app.campaign_cash_origin_v1(t,h.contact_id,h.opportunity_id)
 ), cash as materialized(
  select e.*,private_app.campaign_cash_origin_v1(t,e.contact_id,e.opportunity_id) origin_key from private_app.campaign_cash_v1(t) e where e.occurred_at<cutoff
 ), matched_cash as materialized(
  select p.campaign_id,e.* from people p join cash e on e.origin_key=p.origin_key and e.contact_id=p.contact_id and e.occurred_at>=p.received_at
 ), crm as(
  select p.campaign_id,count(*) leads,count(distinct p.contact_id) filter(where f.contact_id is not null) payers,
   coalesce(sum(f.registrations),0) registrations,bool_and(p.date_evidence<>'upload_time') dates_reliable
  from people p left join confirmed f on f.contact_id=p.contact_id and f.origin_key=p.origin_key and f.verified_at>=p.received_at group by p.campaign_id
 ), finances as(
  select campaign_id,sum(amount_minor) filter(where currency=a.currency) net,bool_and(currency=a.currency) currency_matches from matched_cash group by campaign_id
 ), performance as(
  select m.campaign_id,round(sum(m.cost_micros)*power(10::numeric,digits)/1000000)::bigint spend,
   sum(m.clicks) clicks,sum(m.impressions) impressions,sum(m.google_conversions) conversions
  from google_ads.daily_metrics m where m.tenant_id=t and m.account_id=a.customer_id and m.metric_date between p_from and p_to group by m.campaign_id
 ), combined as materialized(
  select c.campaign_id,c.name,c.status,
   case when missing=0 then coalesce(p.spend,0) else p.spend end spend,
   case when missing=0 then coalesce(p.clicks,0) else p.clicks end clicks,
   case when missing=0 then coalesce(p.impressions,0) else p.impressions end impressions,
   case when missing=0 then coalesce(p.conversions,0) else p.conversions end conversions,
   coalesce(crm.leads,0) leads,coalesce(crm.payers,0) payers,coalesce(crm.registrations,0) registrations,
   coalesce(crm.dates_reliable,true) dates_reliable,coalesce(f.currency_matches,true) and digits=2 currency_matches,
   case when money and coalesce(f.currency_matches,true) and digits=2 then coalesce(f.net,0) end net
  from google_ads.campaigns c left join performance p on p.campaign_id=c.campaign_id left join crm on crm.campaign_id=c.campaign_id left join finances f on f.campaign_id=c.campaign_id
  where c.tenant_id=t and c.account_id=a.customer_id and (coalesce(p_query,'')='' or c.name ilike '%'||replace(replace(replace(p_query,'\','\\'),'%','\%'),'_','\_')||'%' or c.campaign_id=p_query)
 ), page as(select * from combined order by spend desc nulls last,campaign_id offset (p_page-1)*50 limit 50)
 select jsonb_build_object('enabled',true,'canReadMoney',money,'canReadDetails',details,'currency',a.currency,'minorDigits',digits,'range',jsonb_build_object('from',p_from,'to',p_to,'asOf',p_as_of),
 'coverage',jsonb_build_object('spendComplete',missing=0,'missingDays',missing,'manual',true,'currencyMatches',coalesce((select bool_and(currency_matches) from combined),digits=2),'timeBasisMatches',a.timezone=tz,'sourceDatesReliable',coalesce((select bool_and(dates_reliable) from combined),true)),
 'summary',jsonb_build_object('spendMinor',case when missing=0 then coalesce((select sum(spend) from combined),0) else (select sum(spend) from combined) end,
 'clicks',case when missing=0 then coalesce((select sum(clicks) from combined),0) else (select sum(clicks) from combined) end,
 'impressions',case when missing=0 then coalesce((select sum(impressions) from combined),0) else (select sum(impressions) from combined) end,
 'googleConversions',case when missing=0 then coalesce((select sum(conversions) from combined),0) else (select sum(conversions) from combined) end,
 'manualLeads',coalesce((select sum(leads) from combined),0),'verifiedPayers',coalesce((select sum(payers) from combined),0),'registrations',coalesce((select sum(registrations) from combined),0),
 'netCollectionsMinor',case when money and coalesce((select bool_and(currency_matches) from combined),digits=2) then coalesce((select sum(net) from combined),0) end),
 'campaigns',coalesce((select jsonb_agg(jsonb_build_object('campaignId',campaign_id,'name',name,'status',status,'spendMinor',spend,'clicks',clicks,'impressions',impressions,'googleConversions',conversions,
 'manualLeads',leads,'verifiedPayers',payers,'registrations',registrations,'netCollectionsMinor',net,
 'manualCostPerPayerMinor',case when missing=0 and a.timezone=tz and currency_matches and dates_reliable and spend>0 and payers>0 then round(spend::numeric/payers) end,
 'manualCollectionRoas',case when money and missing=0 and a.timezone=tz and currency_matches and dates_reliable and spend>0 then round(net::numeric/spend,4) end) order by spend desc nulls last,campaign_id) from page),'[]'::jsonb),
 'totalCampaigns',(select count(*) from combined),'page',p_page,
 'details',case when details then coalesce((select jsonb_agg(jsonb_build_object('originKey',p.origin_key,'name',p.full_name,'campaignId',p.campaign_id,'paid',exists(select 1 from confirmed f where f.contact_id=p.contact_id and f.origin_key=p.origin_key and f.verified_at>=p.received_at))) from(select p.* from people p join page c on c.campaign_id=p.campaign_id order by p.received_at,p.origin_key limit 50) p),'[]'::jsonb) else null end,
 'limitations',jsonb_build_object('sourceEvidence','manual_review','cohort','first_acquisition','additionalPurchasesExcluded',true,'historicalSnapshot',false)) into result;
 return result;
end $$;
revoke all on all tables in schema google_ads from public,anon,authenticated,service_role;

create function google_ads.immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'google_ads_history_append_only'; end $$;
create trigger google_ads_review_immutable before update or delete on google_ads.source_reviews for each row execute function google_ads.immutable();
create trigger google_ads_command_immutable before update or delete on google_ads.review_commands for each row execute function google_ads.immutable();
create trigger google_ads_audit_immutable before update or delete on google_ads.audit_events for each row execute function google_ads.immutable();

create function google_ads.tenant(p_slug text,p_manage boolean default false,p_enabled boolean default true)
returns uuid language plpgsql stable set search_path='' as $$
declare t core.tenants%rowtype;
begin
 select * into t from core.tenants where slug=p_slug and status in('trial','active');
 if t.id is null then raise exception 'google_ads_tenant_not_found'; end if;
 if t.slug in('reef-skills','reefskills') then raise exception 'google_ads_protected_tenant'; end if;
 if auth.uid() is null or private_app.current_subject_id() is null or not coalesce(private_app.has_tenant_permission(t.id,'tenant.reports.campaigns'),false) then raise exception 'google_ads_forbidden'; end if;
 if p_manage and not (private_app.has_tenant_permission(t.id,'tenant.marketing.manage') or private_app.has_tenant_permission(t.id,'tenant.settings.manage')) then raise exception 'google_ads_forbidden'; end if;
 if p_enabled and (not coalesce(private_app.tenant_addon_enabled(t.id,'addon.integrations.google_ads_connect'),false) or not exists(select 1 from google_ads.rollouts where tenant_id=t.id and enabled)) then raise exception 'google_ads_not_enabled'; end if;
 return t.id;
end $$;
create function google_ads.assert_service() returns void language plpgsql set search_path='' as $$
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then raise exception 'google_ads_service_only'; end if;
end $$;
-- Service continuations re-evaluate the actor saved by an authenticated RPC.
-- Server-owned minimal claims are restored even when authorization fails.
create function google_ads.assert_actor(p_tenant uuid,p_auth uuid,p_subject uuid) returns void language plpgsql set search_path='' as $$
declare old_claims text:=current_setting('request.jwt.claims',true);old_sub text:=current_setting('request.jwt.claim.sub',true);s text;
begin
 select slug into s from core.tenants where id=p_tenant;
 perform set_config('request.jwt.claim.sub',p_auth::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',p_auth,'role','authenticated')::text,true);
 if private_app.current_subject_id() is distinct from p_subject then raise exception 'google_ads_forbidden'; end if;
 perform google_ads.tenant(s,true,true);
 perform set_config('request.jwt.claims',coalesce(old_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
exception when others then
 perform set_config('request.jwt.claims',coalesce(old_claims,''),true);perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);raise;
end $$;

create function public.v1_tenant_google_ads_snapshot(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,false,false);c google_ads.connections%rowtype;enabled boolean;
begin
 enabled:=private_app.tenant_addon_enabled(t,'addon.integrations.google_ads_connect') and exists(select 1 from google_ads.rollouts rollout where rollout.tenant_id=t and rollout.enabled);
 select * into c from google_ads.connections where tenant_id=t;
 return jsonb_build_object('tenantTimezone',(select timezone from core.tenants where id=t),'enabled',enabled,'addonEnabled',enabled,'canManage',private_app.has_tenant_permission(t,'tenant.marketing.manage') or private_app.has_tenant_permission(t,'tenant.settings.manage'),
 'canReadMoney',private_app.has_accounting_permission(t,'tenant.accounting.reports.read'),'canReadDetails',private_app.has_tenant_permission(t,'tenant.leads.read') or private_app.has_tenant_permission(t,'tenant.crm.read'),
 'status',case when enabled then coalesce(c.status,'disconnected') else 'disabled' end,
 'selectedAccount',case when enabled then(select jsonb_build_object('customerId',a.customer_id,'name',a.name,'currency',a.currency,'timezone',a.timezone,'loginCustomerId',a.login_customer_id) from google_ads.accounts a where a.tenant_id=t and a.customer_id=c.selected_account_id) end,
 'accounts',case when enabled and (private_app.has_tenant_permission(t,'tenant.marketing.manage') or private_app.has_tenant_permission(t,'tenant.settings.manage')) then coalesce((select jsonb_agg(jsonb_build_object('customerId',a.customer_id,'name',a.name,'currency',a.currency,'timezone',a.timezone,'loginCustomerId',a.login_customer_id) order by a.name,a.customer_id) from google_ads.accounts a where a.tenant_id=t and a.credential_version=c.credential_version),'[]'::jsonb) else '[]'::jsonb end,
 'sync',case when enabled then jsonb_build_object('lastSyncedAt',c.last_synced_at,'errorCode',c.last_error_code,'status',coalesce((select r.status from google_ads.sync_runs r where r.tenant_id=t order by r.created_at desc,r.id desc limit 1),'never')) end);
end $$;

create function public.v1_tenant_google_ads_begin_oauth(p_slug text,p_state_sha256 text,p_return_path text,p_pkce_challenge text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true);v bigint;i uuid;
begin
 if p_state_sha256 is null or p_state_sha256 !~ '^[a-f0-9]{64}$' or p_pkce_challenge is null or p_pkce_challenge !~ '^[A-Za-z0-9_-]{43}$' or p_return_path is distinct from '/tenant/'||p_slug||'/reports/google-ads' then raise exception 'google_ads_invalid_oauth'; end if;
 insert into google_ads.connections(tenant_id) values(t) on conflict do nothing;
 update google_ads.connections set oauth_generation=oauth_generation+1,updated_at=now() where tenant_id=t returning oauth_generation into v;
 update google_ads.oauth_transactions set status='cancelled' where tenant_id=t and status in('pending','claimed');
 insert into google_ads.oauth_transactions(tenant_id,actor_subject_id,actor_auth_user_id,state_sha256,pkce_challenge,return_path,authorization_generation)
 values(t,private_app.current_subject_id(),auth.uid(),p_state_sha256,p_pkce_challenge,p_return_path,v) returning id into i;
 insert into google_ads.audit_events(tenant_id,actor_subject_id,action,resource_id) values(t,private_app.current_subject_id(),'oauth_started',i::text);
 return jsonb_build_object('transactionId',i,'expiresAt',now()+interval '10 minutes');
end $$;
create function public.v1_tenant_google_ads_claim_oauth(p_state_sha256 text,p_pkce_challenge text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare x google_ads.oauth_transactions%rowtype;s text;
begin
 select * into x from google_ads.oauth_transactions where state_sha256=p_state_sha256;
 if x.id is null then raise exception 'google_ads_oauth_invalid'; end if;
 select slug into s from core.tenants where id=x.tenant_id;perform google_ads.tenant(s,true);
 perform 1 from google_ads.connections where tenant_id=x.tenant_id for update;
 select * into x from google_ads.oauth_transactions where id=x.id for update;
 if x.status<>'pending' or x.expires_at<=now() or x.pkce_challenge is distinct from p_pkce_challenge or x.actor_auth_user_id is distinct from auth.uid() or x.actor_subject_id is distinct from private_app.current_subject_id()
 or x.authorization_generation<>(select oauth_generation from google_ads.connections where tenant_id=x.tenant_id) then raise exception 'google_ads_oauth_invalid'; end if;
 update google_ads.oauth_transactions set status='claimed',claimed_at=now() where id=x.id;
 return jsonb_build_object('transactionId',x.id,'tenantSlug',s,'returnPath',x.return_path);
end $$;
create function public.v1_service_google_ads_finalize_oauth(p_transaction_id uuid,p_refresh_token text,p_accounts jsonb,p_scopes text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare x google_ads.oauth_transactions%rowtype;c google_ads.connections%rowtype;secret_id uuid;a jsonb;n integer:=0;
begin
 perform google_ads.assert_service();
 select * into x from google_ads.oauth_transactions where id=p_transaction_id;
 if x.id is null then raise exception 'google_ads_oauth_invalid'; end if;
 perform google_ads.assert_actor(x.tenant_id,x.actor_auth_user_id,x.actor_subject_id);
 select * into c from google_ads.connections where tenant_id=x.tenant_id for update;
 select * into x from google_ads.oauth_transactions where id=p_transaction_id for update;
 if x.status<>'claimed' or x.expires_at<=now() or x.claimed_at<=now()-interval '5 minutes' or x.authorization_generation<>c.oauth_generation then raise exception 'google_ads_oauth_stale'; end if;
 if coalesce(length(p_refresh_token),0) not between 16 and 8192 or not coalesce(p_scopes,'{}') @> array['https://www.googleapis.com/auth/adwords']::text[] or array_position(p_scopes,null) is not null or jsonb_typeof(p_accounts) is distinct from 'array' or jsonb_array_length(p_accounts)>200 then raise exception 'google_ads_oauth_payload_invalid'; end if;
 for a in select value from jsonb_array_elements(p_accounts) loop
  if coalesce((a->>'selectable')::boolean,true) and not coalesce((a->>'manager')::boolean,false) and not coalesce((a->>'testAccount')::boolean,false) then
   if coalesce(a->>'customerId','') !~ '^[0-9]{1,20}$' or coalesce(a->>'currency','') !~ '^[A-Z]{3}$' or not exists(select 1 from pg_timezone_names where name=a->>'timezone') or length(coalesce(a->>'name','')) not between 1 and 300 then raise exception 'google_ads_account_invalid'; end if;
   insert into google_ads.accounts(tenant_id,customer_id,name,currency,timezone,login_customer_id,credential_version)
   values(x.tenant_id,a->>'customerId',a->>'name',a->>'currency',a->>'timezone',nullif(a->>'loginCustomerId',''),c.credential_version+1)
   on conflict(tenant_id,customer_id) do update set name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,login_customer_id=excluded.login_customer_id,credential_version=excluded.credential_version;
   n:=n+1;
  end if;
 end loop;
 if n=0 then raise exception 'google_ads_no_eligible_accounts'; end if;
 select vault.create_secret(p_refresh_token,'google-ads:'||x.tenant_id||':'||gen_random_uuid(),'ODEIR Google Ads refresh credential.',null) into secret_id;
 update google_ads.connections set status='connected',credential_version=credential_version+1,vault_secret_id=secret_id,scopes=p_scopes,updated_at=now(),last_error_code=null,
 selected_account_id=case when exists(select 1 from google_ads.accounts a where a.tenant_id=x.tenant_id and a.customer_id=c.selected_account_id and a.credential_version=c.credential_version+1) then c.selected_account_id else null end where tenant_id=x.tenant_id;
 if c.vault_secret_id is not null then delete from vault.secrets where id=c.vault_secret_id; end if;
 update google_ads.oauth_transactions set status='finalized' where id=x.id;
 insert into google_ads.audit_events(tenant_id,actor_subject_id,action,resource_id,context) values(x.tenant_id,x.actor_subject_id,'connected',x.id::text,jsonb_build_object('accountCount',n));
 return jsonb_build_object('status','connected','accountCount',n);
end $$;

create function public.v1_tenant_google_ads_select_account(p_slug text,p_account_id text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true);c google_ads.connections%rowtype;
begin
 select * into c from google_ads.connections where tenant_id=t for update;
 if c.status is distinct from 'connected' or not exists(select 1 from google_ads.accounts where tenant_id=t and customer_id=p_account_id and credential_version=c.credential_version) then raise exception 'google_ads_account_not_discovered'; end if;
 if c.selected_account_id is distinct from p_account_id then
  update google_ads.connections set selected_account_id=p_account_id,credential_version=credential_version+1,oauth_generation=oauth_generation+1,last_synced_at=null,last_error_code=null,updated_at=now() where tenant_id=t;
  update google_ads.accounts set credential_version=c.credential_version+1 where tenant_id=t and credential_version=c.credential_version;
  update google_ads.oauth_transactions set status='cancelled' where tenant_id=t and status in('pending','claimed');
  insert into google_ads.audit_events(tenant_id,actor_subject_id,action,resource_id) values(t,private_app.current_subject_id(),'account_selected',p_account_id);
 end if;
 return jsonb_build_object('selectedAccountId',p_account_id);
end $$;
create function public.v1_tenant_google_ads_disconnect(p_slug text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true,false);c google_ads.connections%rowtype;
begin
 select * into c from google_ads.connections where tenant_id=t for update;
 if c.vault_secret_id is not null then delete from vault.secrets where id=c.vault_secret_id; end if;
 update google_ads.connections set status='disconnected',credential_version=credential_version+1,oauth_generation=oauth_generation+1,vault_secret_id=null,scopes='{}',updated_at=now() where tenant_id=t;
 update google_ads.oauth_transactions set status='cancelled' where tenant_id=t and status in('pending','claimed');
 insert into google_ads.audit_events(tenant_id,actor_subject_id,action) values(t,private_app.current_subject_id(),'disconnected');
 return jsonb_build_object('status','disconnected');
end $$;

create function public.v1_tenant_google_ads_begin_sync(p_slug text,p_from date,p_to date,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=google_ads.tenant(p_slug,true);c google_ads.connections%rowtype;r google_ads.sync_runs%rowtype;tz text;
begin
 select * into c from google_ads.connections where tenant_id=t for update;
 if c.status is distinct from 'connected' or c.vault_secret_id is null or c.selected_account_id is null then raise exception 'google_ads_connection_required'; end if;
 select timezone into tz from google_ads.accounts where tenant_id=t and customer_id=c.selected_account_id and credential_version=c.credential_version;
 if tz is null then raise exception 'google_ads_account_not_discovered'; end if;
 if p_command_id is null or p_from is null or p_to is null or p_from>p_to or p_to-p_from>30 or p_to>(now() at time zone tz)::date then raise exception 'google_ads_range_invalid'; end if;
 select * into r from google_ads.sync_runs where tenant_id=t and command_id=p_command_id;
 if r.id is not null then
  if r.account_id<>c.selected_account_id or r.date_from<>p_from or r.date_to<>p_to then raise exception 'google_ads_command_reused'; end if;
  return jsonb_build_object('runId',r.id,'leaseToken',r.lease_token,'credentialVersion',r.credential_version,'duplicate',true,'status',r.status);
 end if;
 if exists(select 1 from google_ads.sync_runs where tenant_id=t and status='running' and lease_expires_at>now() and credential_version=c.credential_version) then raise exception 'google_ads_sync_in_progress'; end if;
 update google_ads.sync_runs set status='superseded',finished_at=now() where tenant_id=t and status='running';
 insert into google_ads.sync_runs(tenant_id,command_id,actor_subject_id,actor_auth_user_id,account_id,credential_version,date_from,date_to)
 values(t,p_command_id,private_app.current_subject_id(),auth.uid(),c.selected_account_id,c.credential_version,p_from,p_to) returning * into r;
 return jsonb_build_object('runId',r.id,'leaseToken',r.lease_token,'credentialVersion',r.credential_version,'duplicate',false,'status','running');
end $$;
create function google_ads.run(p_run_id uuid,p_lease_token uuid) returns google_ads.sync_runs language plpgsql set search_path='' as $$
declare r google_ads.sync_runs%rowtype;c google_ads.connections%rowtype;
begin
 perform google_ads.assert_service();select * into r from google_ads.sync_runs where id=p_run_id;
 if r.id is null then raise exception 'google_ads_run_invalid'; end if;
 perform google_ads.assert_actor(r.tenant_id,r.actor_auth_user_id,r.actor_subject_id);
 select * into c from google_ads.connections where tenant_id=r.tenant_id for update;
 select * into r from google_ads.sync_runs where id=p_run_id for update;
 if r.lease_token is distinct from p_lease_token or r.lease_expires_at<=now() or r.status<>'running' or c.status<>'connected' or c.credential_version<>r.credential_version or c.selected_account_id is distinct from r.account_id then raise exception 'google_ads_stale_lease'; end if;
 return r;
end $$;
create function public.v1_service_google_ads_sync_credentials(p_run_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r google_ads.sync_runs%rowtype:=google_ads.run(p_run_id,p_lease_token);s text;a google_ads.accounts%rowtype;
begin
 select v.decrypted_secret into s from google_ads.connections c join vault.decrypted_secrets v on v.id=c.vault_secret_id where c.tenant_id=r.tenant_id;
 select * into a from google_ads.accounts where tenant_id=r.tenant_id and customer_id=r.account_id;
 if s is null then raise exception 'google_ads_credential_missing'; end if;
 return jsonb_build_object('refreshToken',s,'credentialVersion',r.credential_version,'range',jsonb_build_object('from',r.date_from,'to',r.date_to),
 'account',jsonb_build_object('customerId',a.customer_id,'name',a.name,'currency',a.currency,'timezone',a.timezone,'loginCustomerId',a.login_customer_id));
end $$;
create function public.v1_service_google_ads_finish_sync(p_run_id uuid,p_lease_token uuid,p_campaigns jsonb,p_metrics jsonb,p_success boolean,p_error_code text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r google_ads.sync_runs%rowtype:=google_ads.run(p_run_id,p_lease_token);a google_ads.accounts%rowtype;x jsonb;d date;
begin
 if p_success is distinct from true then
  update google_ads.sync_runs set status='failed',finished_at=now(),error_code=case when p_error_code ~ '^[a-z0-9_]{1,100}$' then p_error_code else 'google_ads_sync_failed' end where id=r.id;
  update google_ads.connections set status=case when p_error_code in('reauth_required','google_reconnect_required') then 'reauth_required' else status end,last_error_code=case when p_error_code ~ '^[a-z0-9_]{1,100}$' then p_error_code else 'google_ads_sync_failed' end where tenant_id=r.tenant_id;
  return jsonb_build_object('status','failed','preservedPreviousData',true);
 end if;
 select * into a from google_ads.accounts where tenant_id=r.tenant_id and customer_id=r.account_id;
 if jsonb_typeof(p_campaigns) is distinct from 'array' or jsonb_typeof(p_metrics) is distinct from 'array' or jsonb_array_length(p_campaigns)>2000 or jsonb_array_length(p_metrics)>50000 then raise exception 'google_ads_sync_payload_invalid'; end if;
 if exists(select 1 from jsonb_array_elements(p_campaigns) q group by q->>'externalCampaignId' having count(*)>1) or exists(select 1 from jsonb_array_elements(p_metrics) q group by q->>'externalCampaignId',q->>'date' having count(*)>1) then raise exception 'google_ads_duplicate_metric'; end if;
 for x in select value from jsonb_array_elements(p_campaigns) loop
  if coalesce(x->>'externalCampaignId','') !~ '^[0-9]{1,30}$' or length(coalesce(x->>'name','')) not between 1 and 500 or coalesce(x->>'status','') not in('ENABLED','PAUSED','REMOVED','UNKNOWN','UNSPECIFIED','enabled','paused','removed','unknown','unspecified') then raise exception 'google_ads_campaign_invalid'; end if;
  insert into google_ads.campaigns(tenant_id,account_id,campaign_id,name,status,channel_type) values(r.tenant_id,r.account_id,x->>'externalCampaignId',x->>'name',lower(x->>'status'),left(x->>'channelType',80))
  on conflict(tenant_id,account_id,campaign_id) do update set name=excluded.name,status=excluded.status,channel_type=excluded.channel_type,updated_at=now();
 end loop;
 -- Validation and replacement are one transaction. Any invalid row rolls back
 -- the entire window, dimensions and coverage; a genuinely empty success clears.
 delete from google_ads.daily_metrics where tenant_id=r.tenant_id and account_id=r.account_id and metric_date between r.date_from and r.date_to;
 if exists(with campaigns as materialized(select value->>'externalCampaignId' id from jsonb_array_elements(p_campaigns))
  select 1 from jsonb_array_elements(p_metrics) m left join campaigns c on c.id=m->>'externalCampaignId'
  where c.id is null or (m->>'date')::date is null or (m->>'date')::date not between r.date_from and r.date_to or m->>'currency' is distinct from a.currency) then raise exception 'google_ads_metric_invalid'; end if;
 insert into google_ads.daily_metrics(tenant_id,account_id,campaign_id,metric_date,currency,cost_micros,spend_minor,impressions,clicks,google_conversions,google_conversion_value)
 select r.tenant_id,r.account_id,x."externalCampaignId",x.date,a.currency,x."costMicros",x."costMinor",x.impressions,x.clicks,x."googleConversions",x."googleConversionValue"
 from jsonb_to_recordset(p_metrics) x("externalCampaignId" text,date date,"costMicros" numeric,"costMinor" bigint,impressions bigint,clicks bigint,"googleConversions" numeric,"googleConversionValue" numeric);
 insert into google_ads.coverage_days(tenant_id,account_id,metric_date,run_id) select r.tenant_id,r.account_id,day::date,r.id from generate_series(r.date_from::timestamp,r.date_to::timestamp,interval '1 day') day
 on conflict(tenant_id,account_id,metric_date) do update set run_id=excluded.run_id,synced_at=now();
 update google_ads.sync_runs set status='success',finished_at=now() where id=r.id;
 update google_ads.connections set last_synced_at=now(),last_error_code=null where tenant_id=r.tenant_id;
 insert into google_ads.audit_events(tenant_id,actor_subject_id,action,resource_id,context) values(r.tenant_id,r.actor_subject_id,'sync_completed',r.id::text,jsonb_build_object('from',r.date_from,'to',r.date_to,'rows',jsonb_array_length(p_metrics)));
 return jsonb_build_object('status','success','metricRows',jsonb_array_length(p_metrics));
end $$;

-- No browser or service has table privileges; only these checked RPCs are exposed.
revoke all on all functions in schema google_ads from public,anon,authenticated,service_role;
do $$ declare r record; begin
 for r in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'v1_tenant_google_ads_%' or p.proname like 'v1_service_google_ads_%') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
  execute format('grant execute on function %s to %I',r.signature,case when r.proname like 'v1_service_google_ads_%' then 'service_role' else 'authenticated' end);
 end loop;
end $$;
commit;
