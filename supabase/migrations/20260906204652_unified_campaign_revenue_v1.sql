begin;

-- Reporting-only rollout. No customer, task, payment or historical attribution
-- is rewritten. Enable a reviewed tenant explicitly after staging reconciliation.
create table marketing_hub.campaign_report_rollouts (
  tenant_id uuid primary key references core.tenants(id) on delete restrict,
  enabled boolean not null default false
);
create table marketing_hub.campaign_source_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  command_id uuid not null,
  command_hash text not null,
  origin_key text not null check (origin_key ~ '^(import|contact):[0-9a-f-]{36}$'),
  original jsonb not null,
  campaign_id uuid references marketing_hub.campaigns(id) on delete restrict,
  ad_id uuid references marketing_hub.ads(id) on delete restrict,
  evidence text not null check (evidence in ('manual_name','manual_id','source_only')),
  received_at timestamptz not null,
  date_evidence text not null check (date_evidence in ('reported','upload_time','system_time')),
  previous_id uuid references marketing_hub.campaign_source_reviews(id) on delete restrict,
  actor_id uuid not null references access_control.subjects(id) on delete restrict,
  reason text not null check (length(reason) between 3 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id,command_id,origin_key),
  check (ad_id is null or campaign_id is not null)
);
create index campaign_reviews_origin_idx on marketing_hub.campaign_source_reviews(tenant_id,origin_key,created_at desc,id desc);
create index campaign_reviews_campaign_idx on marketing_hub.campaign_source_reviews(campaign_id);
create index campaign_reviews_ad_idx on marketing_hub.campaign_source_reviews(ad_id);
create index campaign_reviews_previous_idx on marketing_hub.campaign_source_reviews(previous_id);
create index campaign_reviews_actor_idx on marketing_hub.campaign_source_reviews(actor_id);
create index if not exists campaign_import_contact_idx on sales_core.lead_import_rows(tenant_id,contact_id) where validation_status='valid';
create index if not exists campaign_handoff_contact_verified_idx on academy.registration_handoffs(tenant_id,contact_id,payment_verified_at) where payment_status='verified';
create index if not exists campaign_opportunity_origin_idx on sales_core.opportunities(tenant_id,contact_id,created_at,id);

alter table marketing_hub.campaign_report_rollouts enable row level security;
alter table marketing_hub.campaign_report_rollouts force row level security;
alter table marketing_hub.campaign_source_reviews enable row level security;
alter table marketing_hub.campaign_source_reviews force row level security;
revoke all on marketing_hub.campaign_report_rollouts,marketing_hub.campaign_source_reviews from public,anon,authenticated,service_role;

create function private_app.campaign_review_immutable_v1() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'campaign_review_append_only'; end;
$$;
create trigger campaign_review_immutable before update or delete on marketing_hub.campaign_source_reviews
for each row execute function private_app.campaign_review_immutable_v1();

-- Only explicit ISO dates are accepted. Ambiguous day/month and Excel serials
-- remain visible as upload_time until the source is reviewed.
create function private_app.campaign_received_at_v1(p_value text,p_fallback timestamptz,p_timezone text)
returns timestamptz language plpgsql stable set search_path='' as $$
declare v_result timestamptz;
begin
  if p_value ~ '^\d{4}-\d{2}-\d{2}$' then
    v_result:=p_value::date::timestamp at time zone p_timezone;
  elsif p_value ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' then
    v_result:=p_value::timestamptz;
  else return p_fallback;
  end if;
  if v_result>p_fallback then return p_fallback; end if;
  return v_result;
exception when invalid_datetime_format or datetime_field_overflow then return p_fallback;
end;
$$;

-- Uses canonical IDs already resolved by intake. Never matches phone suffixes,
-- names, or provider-reported conversion counts to a customer.
create function private_app.campaign_origins_v1(p_tenant uuid)
returns table(origin_key text,contact_id uuid,batch_id uuid,received_at timestamptz,date_evidence text,
 source text,campaign_name text,ad_name text,ad_set_name text,external_campaign_id text,external_ad_id text,
 validation_status text,queue_status text,full_name text,lead_status text,lead_quality text,
 staff_id uuid,course_id uuid,original jsonb,campaign_id uuid,ad_id uuid,evidence text,review_id uuid)
language sql stable set search_path='' as $$
with raw as (
 select 'import:'||r.id origin_key,coalesce(r.contact_id,r.duplicate_contact_id) contact_id,r.batch_id,
  private_app.campaign_received_at_v1(r.raw_data->>'receivedAt',r.created_at,t.timezone) received_at,
  case when private_app.campaign_received_at_v1(r.raw_data->>'receivedAt',r.created_at,t.timezone)<>r.created_at then 'reported' else 'upload_time' end date_evidence,
  r.source,r.campaign_name,r.ad_name,r.ad_set_name,r.raw_data->>'campaignId' external_campaign_id,r.raw_data->>'adId' external_ad_id,
  r.validation_status,r.queue_status,r.full_name,c.lead_status,c.lead_quality,c.owner_staff_id staff_id,c.interest_course_id course_id,
  jsonb_build_object('batchId',r.batch_id,'rowNumber',r.row_number,'source',r.source,'campaignName',r.campaign_name,
   'adName',r.ad_name,'adSetName',r.ad_set_name,'campaignId',r.raw_data->>'campaignId','adId',r.raw_data->>'adId',
   'receivedAt',r.raw_data->>'receivedAt','moderator',r.raw_data->>'moderator','uploadedAt',r.created_at) original
 from sales_core.lead_import_rows r join core.tenants t on t.id=r.tenant_id
 left join sales_core.contacts c on c.tenant_id=r.tenant_id and c.id=coalesce(r.contact_id,r.duplicate_contact_id)
 where r.tenant_id=p_tenant
 union all
 select 'contact:'||c.id,c.id,null,c.created_at,'system_time',c.source,c.campaign_name,c.ad_name,null,
  c.metadata->>'campaignId',c.metadata->>'adId','valid','assigned',c.full_name,c.lead_status,c.lead_quality,c.owner_staff_id,c.interest_course_id,
  jsonb_build_object('source',c.source,'campaignName',c.campaign_name,'adName',c.ad_name,'createdAt',c.created_at)
 from sales_core.contacts c where c.tenant_id=p_tenant and not exists (
  select 1 from sales_core.lead_import_rows r where r.tenant_id=p_tenant and r.contact_id=c.id and r.validation_status='valid'
 )
)
select r.origin_key,r.contact_id,r.batch_id,coalesce(v.received_at,r.received_at),coalesce(v.date_evidence,r.date_evidence),
 coalesce(v.original->>'source',r.source),coalesce(v.original->>'campaignName',r.campaign_name),
 coalesce(v.original->>'adName',r.ad_name),coalesce(v.original->>'adSetName',r.ad_set_name),
 r.external_campaign_id,r.external_ad_id,r.validation_status,r.queue_status,r.full_name,r.lead_status,r.lead_quality,r.staff_id,r.course_id,
 coalesce(v.original,r.original),v.campaign_id,v.ad_id,coalesce(v.evidence,'unreviewed'),v.id
from raw r left join lateral (
 select v.* from marketing_hub.campaign_source_reviews v where v.tenant_id=p_tenant and v.origin_key=r.origin_key
 order by v.created_at desc,v.id desc limit 1
) v on true;
$$;

create function private_app.campaign_report_tenant_v1(p_slug text,p_manage boolean default false)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_id uuid;
begin
 select id into v_id from core.tenants where slug=p_slug and status in ('trial','active');
 if v_id is null then raise exception 'tenant_not_found'; end if;
 if not private_app.has_tenant_permission(v_id,'tenant.reports.campaigns') then raise exception 'forbidden'; end if;
 if not private_app.tenant_addon_enabled(v_id,'addon.integrations.social_connect') then raise exception 'addon_not_enabled'; end if;
 if p_manage and not private_app.has_tenant_permission(v_id,'tenant.meta_connect.manage') then raise exception 'forbidden'; end if;
 return v_id;
end;
$$;

-- Preview is bounded, tenant-scoped and carries an optimistic concurrency token.
-- Group review may select at most 200 rows from this preview in one command.
create function public.v1_tenant_campaign_sources(p_slug text,p_batch_id uuid default null,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_id uuid:=private_app.campaign_report_tenant_v1(p_slug,true); v_result jsonb;
begin
 if not exists(select 1 from marketing_hub.campaign_report_rollouts where tenant_id=v_id and enabled) then raise exception 'campaign_report_not_enabled'; end if;
 if p_offset<0 or p_offset>1000000 then raise exception 'invalid_page'; end if;
 with origins as materialized (select * from private_app.campaign_origins_v1(v_id) where p_batch_id is null or batch_id=p_batch_id),
 page as (select * from origins order by received_at desc,origin_key limit 200 offset p_offset)
 select jsonb_build_object('total',(select count(*) from origins),'offset',p_offset,'rows',coalesce((select jsonb_agg(
  jsonb_build_object('key',origin_key,'batchId',batch_id,'source',source,'campaignName',campaign_name,'adName',ad_name,'adSetName',ad_set_name,
   'campaignId',campaign_id,'adId',ad_id,'externalCampaignId',external_campaign_id,'externalAdId',external_ad_id,
   'receivedAt',received_at,'dateEvidence',date_evidence,'evidence',evidence,'validation',validation_status,
   'reviewId',review_id,'original',original,'token',md5(original::text||coalesce(review_id::text,''))) order by received_at desc,origin_key) from page),'[]'::jsonb),
 'targets',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'externalId',c.external_campaign_id,
   'accountId',a.id,'accountName',a.name,'currency',a.currency))
  from marketing_hub.campaigns c join marketing_hub.ad_accounts a on a.tenant_id=v_id and a.id=c.ad_account_id
  where c.tenant_id=v_id and c.provider_key='meta'),'[]'::jsonb),
 'batches',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.file_name,'createdAt',b.created_at)) from
  (select * from sales_core.lead_import_batches where tenant_id=v_id order by created_at desc limit 100) b),'[]'::jsonb)) into v_result;
 return v_result;
end;
$$;

create function public.v1_tenant_campaign_source_review(p_slug text,p_command_id uuid,p_rows jsonb,
 p_campaign_id uuid default null,p_ad_external_id text default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid:=private_app.campaign_report_tenant_v1(p_slug,true); v_hash text;
 v_item jsonb; v_origin record; v_ad uuid; v_actor uuid:=private_app.current_subject_id(); v_count integer:=0;
begin
 if not exists(select 1 from marketing_hub.campaign_report_rollouts where tenant_id=v_id and enabled) then raise exception 'campaign_report_not_enabled'; end if;
 if p_command_id is null or v_actor is null or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 200
  or length(btrim(coalesce(p_reason,''))) not between 3 and 500 then raise exception 'invalid_review'; end if;
 if (select count(distinct x->>'key') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then raise exception 'duplicate_review_rows'; end if;
 perform pg_advisory_xact_lock(hashtextextended('campaign-review:'||v_id::text,0));
 v_hash:=md5(jsonb_build_object('rows',p_rows,'campaign',p_campaign_id,'ad',p_ad_external_id,'reason',p_reason)::text);
 if exists(select 1 from marketing_hub.campaign_source_reviews where tenant_id=v_id and command_id=p_command_id) then
  if exists(select 1 from marketing_hub.campaign_source_reviews where tenant_id=v_id and command_id=p_command_id and command_hash<>v_hash) then raise exception 'command_id_reused'; end if;
  return jsonb_build_object('ok',true,'replayed',true);
 end if;
 if p_campaign_id is not null and not exists(select 1 from marketing_hub.campaigns c join marketing_hub.ad_accounts a
  on a.id=c.ad_account_id and a.tenant_id=v_id where c.id=p_campaign_id and c.tenant_id=v_id and c.provider_key='meta') then raise exception 'campaign_not_found'; end if;
 if nullif(btrim(p_ad_external_id),'') is not null then
  select ad.id into v_ad from marketing_hub.ads ad join marketing_hub.campaigns c on c.id=ad.campaign_id and c.tenant_id=v_id
  where ad.tenant_id=v_id and ad.campaign_id=p_campaign_id and ad.ad_account_id=c.ad_account_id and ad.external_ad_id=p_ad_external_id;
  if v_ad is null then raise exception 'ad_not_found'; end if;
 end if;
 for v_item in select value from jsonb_array_elements(p_rows) loop
  select * into v_origin from private_app.campaign_origins_v1(v_id) where origin_key=v_item->>'key';
  if not found then raise exception 'source_not_found'; end if;
  if v_item->>'token' is distinct from md5(v_origin.original::text||coalesce(v_origin.review_id::text,'')) then raise exception 'source_changed_refresh_preview'; end if;
  insert into marketing_hub.campaign_source_reviews(tenant_id,command_id,command_hash,origin_key,original,campaign_id,ad_id,evidence,
   received_at,date_evidence,previous_id,actor_id,reason)
  values(v_id,p_command_id,v_hash,v_origin.origin_key,v_origin.original,p_campaign_id,v_ad,
   case when p_campaign_id is null then 'source_only' when (v_ad is not null and v_origin.external_ad_id=p_ad_external_id)
    or (v_ad is null and v_origin.external_campaign_id=(select external_campaign_id from marketing_hub.campaigns where id=p_campaign_id and tenant_id=v_id)) then 'manual_id' else 'manual_name' end,
   v_origin.received_at,v_origin.date_evidence,v_origin.review_id,v_actor,btrim(p_reason));
  v_count:=v_count+1;
 end loop;
 return jsonb_build_object('ok',true,'reviewed',v_count);
end;
$$;

-- Each cash source appears once. An accounting import replaces the handoff
-- amount, preserving the registrar's verification date. Refunds stay separate.
create function private_app.campaign_cash_v1(p_tenant uuid)
returns table(event_key text,contact_id uuid,opportunity_id uuid,occurred_at timestamptz,amount_minor bigint,currency text,kind text,handoff_id uuid)
language sql stable set search_path='' as $$
 select 'handoff:'||h.id,h.contact_id,h.opportunity_id,h.payment_verified_at,h.payment_amount_minor,
  coalesce(nullif(h.metadata->>'currency',''),'SAR'),'collection',h.id
 from academy.registration_handoffs h where h.tenant_id=p_tenant and h.payment_status='verified' and h.payment_verified_at is not null
  and h.payment_amount_minor>0 and not exists(select 1 from accounting_core.payments p
   where p.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text and p.status in ('verified','refunded'))
 union all
 select 'payment:'||p.id,a.contact_id,h.opportunity_id,coalesce(h.payment_verified_at,p.verified_at),p.amount_minor,p.currency,'collection',h.id
 from accounting_core.payments p join accounting_core.customer_accounts a on a.tenant_id=p_tenant and a.id=p.customer_account_id
 left join academy.registration_handoffs h on h.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text
 where p.tenant_id=p_tenant and p.status in ('verified','refunded') and p.verified_at is not null
  and (p.source_type is distinct from 'registration_handoff' or (h.payment_status='verified' and h.payment_verified_at is not null))
 union all
 select 'refund:'||r.id,a.contact_id,h.opportunity_id,r.completed_at,-r.amount_minor,p.currency,'refund',h.id
 from accounting_core.refunds r join accounting_core.payments p on p.tenant_id=p_tenant and p.id=r.payment_id
 join accounting_core.customer_accounts a on a.tenant_id=p_tenant and a.id=p.customer_account_id
 left join academy.registration_handoffs h on h.tenant_id=p_tenant and p.source_type='registration_handoff' and p.source_id=h.id::text
 where r.tenant_id=p_tenant and r.status='completed' and r.completed_at is not null;
$$;

-- A sale belongs to the source that created its opportunity. A later purchase
-- without a recorded origin is held outside campaign revenue, never guessed
-- from a phone number or credited again to the original acquisition.
create function private_app.campaign_cash_origin_v1(p_tenant uuid,p_contact uuid,p_opportunity uuid)
returns text language sql stable set search_path='' as $$
 with opportunity as (
  select o.* from sales_core.opportunities o where o.tenant_id=p_tenant and o.contact_id=p_contact and o.id=p_opportunity
 ), explicit_origin as (
  select r.origin_key from private_app.campaign_origins_v1(p_tenant) r join opportunity o
   on r.origin_key='import:'||(o.metadata->>'importRowId') and r.contact_id=p_contact
 ), first_opportunity as (
  select o.id from sales_core.opportunities o where o.tenant_id=p_tenant and o.contact_id=p_contact order by o.created_at,o.id limit 1
 )
 select coalesce((select origin_key from explicit_origin limit 1),
  case when p_opportunity=(select id from first_opportunity) then
   (select origin_key from private_app.campaign_origins_v1(p_tenant) where contact_id=p_contact and validation_status='valid' order by received_at,origin_key limit 1) end);
$$;
revoke all on function private_app.campaign_cash_origin_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.v1_tenant_campaign_revenue_report(p_slug text,p_from date,p_to date,p_as_of date default null,
 p_mode text default 'cohort',p_campaign_id uuid default null,p_staff_id uuid default null,p_course_id uuid default null,
 p_query text default '',p_offset integer default 0,p_group_key text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_id uuid:=private_app.campaign_report_tenant_v1(p_slug); v_tz text; v_today date; v_start timestamptz; v_end timestamptz; v_cutoff timestamptz;
 v_finance boolean; v_details boolean; v_result jsonb;
begin
 if not exists(select 1 from marketing_hub.campaign_report_rollouts where tenant_id=v_id and enabled) then return jsonb_build_object('enabled',false); end if;
 select timezone into v_tz from core.tenants where id=v_id;
 v_today:=(now() at time zone v_tz)::date;
 p_as_of:=coalesce(p_as_of,v_today);
 if p_from is null or p_to is null or p_from>p_to or p_to>v_today or p_to-p_from>92 or p_as_of<p_to or p_as_of>v_today
  or p_mode is null or p_mode not in ('cohort','cash') or p_offset is null or p_offset<0 or p_offset>1000000 or length(coalesce(p_query,''))>80 then raise exception 'campaign_report_filter_invalid'; end if;
 v_start:=p_from::timestamp at time zone v_tz; v_end:=(p_to+1)::timestamp at time zone v_tz;
 v_cutoff:=least((p_as_of+1)::timestamp at time zone v_tz,now());
 v_finance:=private_app.has_accounting_permission(v_id,'tenant.accounting.reports.read');
 v_details:=private_app.has_tenant_permission(v_id,'tenant.leads.read') or private_app.has_tenant_permission(v_id,'tenant.crm.read');
 with origins as materialized (select * from private_app.campaign_origins_v1(v_id)),
 ranked as (
  select o.*,row_number() over(partition by coalesce(contact_id::text,origin_key) order by received_at,origin_key) n
  from origins o where validation_status='valid'
 ),
 people as materialized (
  select r.*,coalesce(c.name,nullif(r.campaign_name,''),'مصدر فقط / غير محدد') campaign_label,
   coalesce('campaign:'||r.campaign_id,'source:'||md5(concat_ws('|',r.source,r.campaign_name,r.ad_name))) group_key
  from ranked r left join marketing_hub.campaigns c on c.tenant_id=v_id and c.id=r.campaign_id where r.n=1
 ),
 confirmed as materialized (
  select h.contact_id,private_app.campaign_cash_origin_v1(v_id,h.contact_id,h.opportunity_id) origin_key,
   min(h.payment_verified_at) first_verified_at,count(distinct coalesce(h.opportunity_id::text,h.id::text)) registrations
  from academy.registration_handoffs h where h.tenant_id=v_id and h.payment_status='verified' and h.payment_verified_at is not null
   and h.payment_verified_at<v_cutoff group by h.contact_id,private_app.campaign_cash_origin_v1(v_id,h.contact_id,h.opportunity_id)
 ),
 cash as materialized (select e.*,private_app.campaign_cash_origin_v1(v_id,e.contact_id,e.opportunity_id) origin_key
  from private_app.campaign_cash_v1(v_id) e where occurred_at<v_cutoff),
 selected as materialized (
  select p.*,v.first_verified_at,v.registrations from people p left join confirmed v on v.contact_id=p.contact_id and v.origin_key=p.origin_key
  where (p_campaign_id is null or p.campaign_id=p_campaign_id) and (p_staff_id is null or p.staff_id=p_staff_id)
   and (p_course_id is null or p.course_id=p_course_id)
   and (coalesce(p_query,'')='' or lower(concat_ws(' ',p.source,p.campaign_label,p.ad_name)) like '%'||lower(p_query)||'%')
   and (case when p_mode='cohort' then p.received_at>=v_start and p.received_at<v_end
    else exists(select 1 from cash e where e.contact_id=p.contact_id and e.occurred_at>=v_start and e.occurred_at<v_end) end)
 ),
 money as (
  select s.group_key,e.currency,sum(e.amount_minor) net,sum(e.amount_minor) filter(where e.kind='collection') gross,
   -sum(e.amount_minor) filter(where e.kind='refund') refunds
  from selected s join cash e on e.contact_id=s.contact_id and e.origin_key=s.origin_key and e.occurred_at>=s.received_at
  where (p_mode='cohort' or (e.occurred_at>=v_start and e.occurred_at<v_end))
  group by s.group_key,e.currency
 ),
 groups as (
  select s.group_key,s.campaign_id,max(s.campaign_label) label,max(s.source) source,count(*) leads,
   count(*) filter(where s.queue_status='awaiting_distribution') waiting,
   count(*) filter(where s.lead_status in ('interested','very_interested','awaiting_payment')) interested,
   count(*) filter(where s.lead_quality in ('qualified','good','excellent')) qualified,
   count(*) filter(where s.lead_status in ('unqualified','wrong_number') or s.lead_quality='unqualified') unqualified,
   count(*) filter(where s.first_verified_at>=s.received_at) payers,
   coalesce(sum(s.registrations) filter(where s.first_verified_at>=s.received_at),0) registrations,
   count(*) filter(where s.evidence='unreviewed') unreviewed,
   count(*) filter(where s.date_evidence='upload_time') estimated_dates
  from selected s group by s.group_key,s.campaign_id
 ),
 group_json as (
  select g.*,jsonb_build_object('key',g.group_key,'campaignId',g.campaign_id,'name',g.label,'source',g.source,'leads',g.leads,
   'waiting',g.waiting,'interested',g.interested,'qualified',g.qualified,'unqualified',g.unqualified,'payers',g.payers,'registrations',g.registrations,
   'unreviewed',g.unreviewed,'estimatedDates',g.estimated_dates,
   'performance',case when private_app.has_tenant_permission(v_id,'tenant.meta_connect.read')
      or private_app.has_tenant_permission(v_id,'tenant.meta_connect.manage') then
    (select jsonb_build_object('metricRows',count(*),'spendMinor',case when count(*)>0 and count(distinct m.currency)=1 then sum(m.spend_minor) end,
       'currency',case when count(distinct m.currency)=1 then min(m.currency) end,
       'coverageConfirmed',exists(select 1 from marketing_hub.campaigns c join marketing_hub.ad_accounts a on a.tenant_id=v_id and a.id=c.ad_account_id
        join marketing_hub.sync_runs run on run.tenant_id=v_id and run.connection_id=a.connection_id
        where c.id=g.campaign_id and c.tenant_id=v_id and run.status='success' and run.date_from<=p_from and run.date_to>=p_to))
     from marketing_hub.daily_metrics m where m.tenant_id=v_id and m.campaign_id=g.campaign_id
       and m.entity_level='ad' and m.breakdown_key='all' and m.metric_date between p_from and p_to) else null end,
   'conversion',case when p_mode='cohort' then round(g.payers*100.0/nullif(g.leads,0),2) else null end,
   'money',case when v_finance then coalesce((select jsonb_agg(jsonb_build_object('currency',currency,'netMinor',net,'grossMinor',coalesce(gross,0),'refundMinor',coalesce(refunds,0))) from money where group_key=g.group_key),'[]'::jsonb) else null end) data
  from groups g
 )
 select jsonb_build_object('enabled',true,'generatedAt',now(),'range',jsonb_build_object('from',p_from,'to',p_to,'asOf',p_as_of,'timezone',v_tz,'mode',p_mode),
  'canReadMoney',v_finance,'canReadDetails',v_details,'canReview',private_app.has_tenant_permission(v_id,'tenant.meta_connect.manage'),
  'summary',jsonb_build_object('leads',(select count(*) from selected),'payers',(select count(*) from selected where first_verified_at>=received_at),
   'waiting',(select count(*) from selected where queue_status='awaiting_distribution'),'unreviewed',(select count(*) from selected where evidence='unreviewed'),
   'duplicates',(select count(*) from origins where validation_status='duplicate' and received_at>=v_start and received_at<v_end),
   'invalid',(select count(*) from origins where validation_status='invalid' and received_at>=v_start and received_at<v_end)),
  'groups',coalesce((select jsonb_agg(data order by payers desc,leads desc,group_key) from group_json),'[]'::jsonb),
  'totalDetails',(select count(*) from selected where p_group_key is null or group_key=p_group_key),'offset',p_offset,
  'details',case when v_details then coalesce((select jsonb_agg(jsonb_build_object('key',origin_key,'contactId',contact_id,'name',full_name,
   'campaign',campaign_label,'source',source,'ad',ad_name,'receivedAt',received_at,'dateEvidence',date_evidence,'evidence',evidence,
   'status',lead_status,'queueStatus',queue_status,'verifiedAt',first_verified_at,'groupKey',group_key,
   'cash',case when v_finance then coalesce((select jsonb_agg(jsonb_build_object('reference',e.event_key,'kind',e.kind,'at',e.occurred_at,'amountMinor',e.amount_minor,'currency',e.currency) order by e.occurred_at)
    from cash e where e.contact_id=detail.contact_id and e.origin_key=detail.origin_key and e.occurred_at>=detail.received_at
     and (p_mode='cohort' or (e.occurred_at>=v_start and e.occurred_at<v_end))),'[]'::jsonb) else null end) order by received_at desc,origin_key)
   from (select * from selected where p_group_key is null or group_key=p_group_key order by received_at desc,origin_key limit 50 offset p_offset) detail),'[]'::jsonb) else '[]'::jsonb end,
  'staff',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.full_name)) from people.staff_profiles s where s.tenant_id=v_id),'[]'::jsonb),
  'courses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.title_ar)) from academy.courses c where c.tenant_id=v_id),'[]'::jsonb),
  'additionalCash',case when v_finance then coalesce((select jsonb_agg(x) from (
   select coalesce(c.name,o.campaign_name,o.source,'غير محدد') campaign,e.currency,sum(e.amount_minor) "netMinor",count(distinct e.contact_id) customers
   from cash e join origins o on o.origin_key=e.origin_key and o.contact_id=e.contact_id
   left join marketing_hub.campaigns c on c.tenant_id=v_id and c.id=o.campaign_id
   where not exists(select 1 from people p where p.origin_key=e.origin_key)
    and e.occurred_at>=o.received_at
    and (case when p_mode='cohort' then o.received_at>=v_start and o.received_at<v_end else e.occurred_at>=v_start and e.occurred_at<v_end end)
    and (p_campaign_id is null or o.campaign_id=p_campaign_id) and (p_staff_id is null or o.staff_id=p_staff_id) and (p_course_id is null or o.course_id=p_course_id)
    and (coalesce(p_query,'')='' or lower(concat_ws(' ',o.source,c.name,o.campaign_name,o.ad_name)) like '%'||lower(p_query)||'%')
   group by coalesce(c.name,o.campaign_name,o.source,'غير محدد'),e.currency) x),'[]'::jsonb) else null end,
  'unattributedCash',case when v_finance then coalesce((select jsonb_agg(x) from (select e.currency,sum(e.amount_minor) "netMinor" from cash e
   where e.occurred_at>=v_start and e.occurred_at<v_end and not exists(select 1 from origins p where p.contact_id=e.contact_id and p.origin_key=e.origin_key and p.received_at<=e.occurred_at)
   group by e.currency) x),'[]'::jsonb) else null end
 ) into v_result;
 return v_result;
end;
$$;

revoke all on function private_app.campaign_review_immutable_v1(),private_app.campaign_received_at_v1(text,timestamptz,text),
 private_app.campaign_origins_v1(uuid),private_app.campaign_report_tenant_v1(text,boolean),private_app.campaign_cash_v1(uuid)
 from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_campaign_sources(text,uuid,integer),
 public.v1_tenant_campaign_source_review(text,uuid,jsonb,uuid,text,text),
 public.v1_tenant_campaign_revenue_report(text,date,date,date,text,uuid,uuid,uuid,text,integer,text)
 from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_campaign_sources(text,uuid,integer),
 public.v1_tenant_campaign_source_review(text,uuid,jsonb,uuid,text,text),
 public.v1_tenant_campaign_revenue_report(text,date,date,date,text,uuid,uuid,uuid,text,integer,text) to authenticated;

create function public.v1_tenant_campaign_report_access(p_slug text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_id uuid;
begin
 select id into v_id from core.tenants where slug=p_slug and status in ('trial','active');
 if v_id is null or not private_app.has_tenant_permission(v_id,'tenant.reports.campaigns') then raise exception 'forbidden'; end if;
 return jsonb_build_object('timezone',(select timezone from core.tenants where id=v_id),'enabled',private_app.tenant_addon_enabled(v_id,'addon.integrations.social_connect')
  and exists(select 1 from marketing_hub.campaign_report_rollouts where tenant_id=v_id and enabled));
end;
$$;

-- The existing Meta read API remains intact. This version distinguishes a
-- missing metric row from a measured zero and never sums unique daily reach.
create function public.v3_tenant_campaign_meta_report(p_slug text,p_from date,p_to date,p_campaign_id uuid default null,p_page integer default 1,p_query text default '',p_status text default 'all')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_report jsonb; v_id uuid; v_items jsonb; v_collection text;
begin
 p_query:=left(trim(coalesce(p_query,'')),80);p_status:=lower(trim(coalesce(p_status,'all')));
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>92 or p_to>current_date+1 then raise exception 'marketing_report_range_invalid'; end if;
 -- The existing provider reader uses UTC current_date. Tenant midnight can
 -- precede it; expose the provider's available range instead of breaking CRM.
 v_report:=public.v2_tenant_meta_connect_v2_report(p_slug,least(p_from,current_date),least(p_to,current_date),p_query,p_campaign_id,p_status,p_page,25);
 if p_from>current_date then
  return v_report||jsonb_build_object('metricRows',0,'summary','{}'::jsonb,'analysis','{}'::jsonb,'campaigns','[]'::jsonb,'ads','[]'::jsonb,
   'range',jsonb_build_object('from',p_from,'to',p_to,'availableThrough',current_date));
 end if;
 select id into v_id from core.tenants where slug=p_slug;
 v_report:=jsonb_set(v_report,'{summary,reach}','null'::jsonb);
 if (v_report->>'metricRows')::integer=0 then
  v_report:=jsonb_set(v_report,'{summary}',(select jsonb_object_agg(key,case when key='currency' then value else 'null'::jsonb end)
   from jsonb_each(v_report->'summary')));
  v_report:=jsonb_set(v_report,'{analysis}','{}'::jsonb);
 end if;
 foreach v_collection in array array['campaigns','ads'] loop
  select coalesce(jsonb_agg(case when metric.n=0 then
   (select jsonb_object_agg(key,case when key in ('spendMinor','impressions','clicks','platformConversions','platformRevenueMinor','ctr','cpaMinor','cpcMinor','reach') then 'null'::jsonb else value end) from jsonb_each(item))
   ||jsonb_build_object('metricRows',0) else item||jsonb_build_object('metricRows',metric.n) end),'[]'::jsonb)
  into v_items from jsonb_array_elements(v_report->v_collection) item
  cross join lateral (select count(*) n from marketing_hub.daily_metrics m
   join marketing_hub.ads ad on ad.tenant_id=v_id and ad.id=m.ad_id
   join marketing_hub.campaigns campaign on campaign.tenant_id=v_id and campaign.id=ad.campaign_id
   left join marketing_hub.ad_groups ad_group on ad_group.tenant_id=v_id and ad_group.id=ad.ad_group_id
   where m.tenant_id=v_id and m.entity_level='ad'
   and (coalesce(p_query,'')='' or lower(concat_ws(' ',ad.name,ad.external_ad_id,campaign.name,campaign.external_campaign_id,ad_group.name,ad_group.external_ad_group_id)) like '%'||lower(p_query)||'%')
   and (p_status='all' or (p_status='active' and lower(coalesce(ad.effective_status,ad.status,''))='active')
    or (p_status='paused' and lower(coalesce(ad.effective_status,ad.status,'')) in ('paused','campaign_paused','adset_paused'))
    or (p_status='other' and lower(coalesce(ad.effective_status,ad.status,'')) not in ('active','paused','campaign_paused','adset_paused')))
   and m.breakdown_key='all' and m.metric_date between p_from and p_to and
   (case when v_collection='campaigns' then m.campaign_id else m.ad_id end)=(item->>'id')::uuid) metric;
  v_report:=jsonb_set(v_report,array[v_collection],v_items);
 end loop;
 return v_report;
end;
$$;
revoke all on function public.v1_tenant_campaign_report_access(text),public.v3_tenant_campaign_meta_report(text,date,date,uuid,integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_campaign_report_access(text),public.v3_tenant_campaign_meta_report(text,date,date,uuid,integer,text,text) to authenticated;

commit;
