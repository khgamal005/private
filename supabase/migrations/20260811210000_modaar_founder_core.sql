begin;

update catalog.plans
set name_ar='النسخة الأساسية المجانية لمدة 12 شهرًا',
    description='النواة الأساسية من أودير مجانًا لمدة 12 شهرًا من تاريخ تفعيل المنشأة. الإضافات مستقلة.',
    interval='year',amount_minor=0,currency='SAR',updated_at=now()
where plan_key='free';

create or replace function private_app.enforce_free_year_subscription_period()
returns trigger language plpgsql set search_path='' as $$
declare v_plan_key text;
begin
 select plan.plan_key into v_plan_key from catalog.plans plan where plan.id=new.plan_id;
 if v_plan_key='free' then
  new.status:=case when new.status in ('cancelled','paused','past_due') then new.status else 'trialing' end;
  new.period_start:=coalesce(new.period_start,now());
  if new.period_end is null or new.period_end<=new.period_start then new.period_end:=new.period_start+interval '1 year'; end if;
 end if;
 return new;
end; $$;
revoke all on function private_app.enforce_free_year_subscription_period() from public,anon,authenticated;
drop trigger if exists subscriptions_free_year_guard on catalog.subscriptions;
create trigger subscriptions_free_year_guard before insert or update of plan_id,period_start,period_end,status on catalog.subscriptions
for each row execute function private_app.enforce_free_year_subscription_period();
update catalog.subscriptions subscription set period_end=subscription.period_start+interval '1 year',updated_at=now()
from catalog.plans plan where plan.id=subscription.plan_id and plan.plan_key='free'
and (subscription.period_end is null or subscription.period_end<=subscription.period_start);

update catalog.addon_price_versions price set valid_to=date '2026-08-11'
from catalog.addon_products product where product.id=price.product_id and product.product_key='templates'
and price.valid_to is null and price.valid_from<date '2026-08-11';
insert into catalog.addon_price_versions(product_id,pricing_mode,amount_minor,currency,billing_interval,valid_from,valid_to,tax_inclusive,tax_rate_bps,change_note)
select product.id,'free',0,'SAR','year',date '2026-08-11',null,true,0,'Founding launch: templates is a free add-on.'
from catalog.addon_products product where product.product_key='templates'
on conflict(product_id,currency,valid_from) do update set pricing_mode=excluded.pricing_mode,amount_minor=excluded.amount_minor,
billing_interval=excluded.billing_interval,valid_to=excluded.valid_to,tax_inclusive=excluded.tax_inclusive,tax_rate_bps=excluded.tax_rate_bps,change_note=excluded.change_note;
update catalog.addon_products set pricing_mode='free',amount_minor=0,currency='SAR',interval='year',badge_ar='مجاني',updated_at=now()
where product_key='templates';

create or replace function private_app.v3_payment_provider_config_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.provider_key='bank_transfer' then
  if new.checkout_mode<>'embedded' or not('SAR'=any(new.supported_currencies))
     or cardinality(new.required_secret_keys)<>0 or cardinality(new.required_public_config_keys)<>0
     or coalesce((new.public_config->>'manualReview')::boolean,false) is not true then
   raise exception 'payment_provider_configuration_incomplete';
  end if;
  new.credentials_environment:=new.environment;
  if new.status='active' and new.last_verified_at is null then new.last_verified_at:=now(); end if;
  return new;
 end if;
 if tg_op='UPDATE' and new.environment is distinct from old.environment
    and new.credentials_environment is distinct from new.environment then
  new.status:=case when new.status='disabled' then 'disabled' else 'draft' end;
  new.last_verified_at:=null;new.last_error_code:='credentials_rotation_required';
 end if;
 if new.status='active' then raise exception 'payment_provider_native_adapter_not_deployed'; end if;
 if new.status='configured' and not private_app.v3_payment_provider_bundle_complete(new.provider_key,new.environment,new.credentials_environment,new.required_secret_keys,new.required_public_config_keys,new.public_config) then
  raise exception 'payment_provider_configuration_incomplete';
 end if;
 return new;
end; $$;
revoke all on function private_app.v3_payment_provider_config_guard() from public,anon,authenticated,service_role;
insert into marketplace.payment_provider_configs(provider_key,name_ar,name_en,status,environment,credentials_environment,checkout_mode,supported_currencies,required_secret_keys,optional_secret_keys,required_public_config_keys,public_config,last_verified_at,last_error_code,sort_order)
values('bank_transfer','التحويل البنكي','Bank transfer','active','live','live','embedded',array['SAR']::text[],'{}'::text[],'{}'::text[],'{}'::text[],
jsonb_build_object('displayLabelAr','التحويل البنكي','manualReview',true,'instructionsAr','أنشئ الطلب ثم أرسل مرجع التحويل واسم المحوّل وتاريخ التحويل. لا يتم تفعيل الإضافة قبل اعتماد التحويل من إدارة المنصة.'),now(),null,5)
on conflict(provider_key) do update set name_ar=excluded.name_ar,name_en=excluded.name_en,status=excluded.status,environment=excluded.environment,
credentials_environment=excluded.credentials_environment,checkout_mode=excluded.checkout_mode,supported_currencies=excluded.supported_currencies,
required_secret_keys=excluded.required_secret_keys,optional_secret_keys=excluded.optional_secret_keys,required_public_config_keys=excluded.required_public_config_keys,
public_config=excluded.public_config,last_verified_at=excluded.last_verified_at,last_error_code=null,sort_order=excluded.sort_order,updated_at=now();

create table if not exists marketplace.bank_transfer_submissions(
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null unique references marketplace.orders(id) on delete restrict,
 tenant_id uuid not null references core.tenants(id) on delete restrict,
 submitted_by_subject_id uuid references access_control.subjects(id) on delete set null,
 transfer_reference text not null,sender_name text not null,transfer_date date not null,
 amount_minor bigint not null check(amount_minor>0),currency text not null default 'SAR' check(currency='SAR'),
 status text not null default 'pending' check(status in('pending','reviewing','approved','rejected','cancelled')),
 review_note text,reviewed_by_subject_id uuid references access_control.subjects(id) on delete set null,reviewed_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(length(trim(transfer_reference)) between 3 and 160),check(length(trim(sender_name)) between 2 and 160)
);
create index if not exists bank_transfer_submissions_tenant_status_idx on marketplace.bank_transfer_submissions(tenant_id,status,created_at desc);
create index if not exists bank_transfer_submissions_status_created_idx on marketplace.bank_transfer_submissions(status,created_at desc);
create index if not exists bank_transfer_submissions_submitted_by_subject_idx on marketplace.bank_transfer_submissions(submitted_by_subject_id) where submitted_by_subject_id is not null;
create index if not exists bank_transfer_submissions_reviewed_by_subject_idx on marketplace.bank_transfer_submissions(reviewed_by_subject_id) where reviewed_by_subject_id is not null;
drop trigger if exists bank_transfer_submissions_set_updated_at on marketplace.bank_transfer_submissions;
create trigger bank_transfer_submissions_set_updated_at before update on marketplace.bank_transfer_submissions for each row execute function private_app.set_updated_at();
alter table marketplace.bank_transfer_submissions enable row level security;
alter table marketplace.bank_transfer_submissions force row level security;
revoke all on table marketplace.bank_transfer_submissions from public,anon,authenticated;
drop policy if exists bank_transfer_submissions_tenant_read on marketplace.bank_transfer_submissions;
create policy bank_transfer_submissions_tenant_read on marketplace.bank_transfer_submissions for select to authenticated
using(private_app.can_access_tenant(tenant_id) or private_app.has_platform_permission('platform.billing.manage'));

do $modaar_founder_center$
declare v_organization_id uuid;v_tenant_id uuid;v_plan_id uuid;v_owner_subject_id uuid;v_membership_id uuid;v_owner_role_id uuid;
begin
 select id into v_organization_id from core.organizations where organization_key='org-modaar-training-center' limit 1;
 if v_organization_id is null then
  insert into core.organizations(organization_key,legal_name,display_name,country_code,status)
  values('org-modaar-training-center','مركز أودير النموذجي للتدريب','مركز أودير النموذجي للتدريب','SA','active') returning id into v_organization_id;
 end if;
 select id into v_tenant_id from core.tenants where slug='modaar-training-center' limit 1;
 if v_tenant_id is null then
  insert into core.tenants(organization_id,tenant_key,slug,name,legal_name,status,country_code,timezone,default_locale,settings)
  values(v_organization_id,'tenant-modaar-training-center','modaar-training-center','مركز أودير النموذجي للتدريب','مركز أودير النموذجي للتدريب','trial','SA','Asia/Riyadh','ar-SA',
  jsonb_build_object('founderTenant',true,'trainingCenter',true,'demoData',true,'dataDisclaimerAr','جميع البيانات داخل هذه المنشأة تجريبية وغير حقيقية.','planLabelAr','النسخة الأساسية المجانية لمدة 12 شهرًا','addonsInitiallyEnabled',false)) returning id into v_tenant_id;
 else
  update core.tenants set settings=settings||jsonb_build_object('founderTenant',true,'trainingCenter',true,'demoData',true,'dataDisclaimerAr','جميع البيانات داخل هذه المنشأة تجريبية وغير حقيقية.','planLabelAr','النسخة الأساسية المجانية لمدة 12 شهرًا','addonsInitiallyEnabled',false),updated_at=now() where id=v_tenant_id;
 end if;
 insert into core.tenant_modules(tenant_id,module_id,enabled,enabled_at)
 select v_tenant_id,module.id,true,now() from core.modules module where module.enabled_by_default on conflict(tenant_id,module_id) do nothing;
 select id into v_plan_id from catalog.plans where plan_key='free' and status='active' limit 1;
 if v_plan_id is null then raise exception 'free_plan_not_found'; end if;
 if not exists(select 1 from catalog.subscriptions where tenant_id=v_tenant_id and status in('trialing','active','paused','past_due')) then
  insert into catalog.subscriptions(tenant_id,plan_id,status,period_start,period_end)
  values(v_tenant_id,v_plan_id,'trialing',timestamptz '2026-08-11 00:00:00+03',timestamptz '2027-08-11 00:00:00+03');
 end if;
 select id into v_owner_subject_id from access_control.subjects where lower(email)='admin@marktone.sa' and status='active' limit 1;
 -- Supabase preview branches do not copy Auth users. Provision the founder
 -- membership when the real platform owner exists, without blocking an
 -- otherwise valid isolated preview migration.
 if v_owner_subject_id is not null then
  select id into v_membership_id from access_control.memberships where subject_id=v_owner_subject_id and tenant_id=v_tenant_id and scope='tenant' limit 1;
  if v_membership_id is null then insert into access_control.memberships(subject_id,tenant_id,scope,status) values(v_owner_subject_id,v_tenant_id,'tenant','active') returning id into v_membership_id;
  else update access_control.memberships set status='active' where id=v_membership_id;end if;
  select id into v_owner_role_id from access_control.roles where scope='tenant' and role_key='tenant_owner' and(tenant_id is null or tenant_id=v_tenant_id)
  order by(tenant_id=v_tenant_id) desc limit 1;
  if v_owner_role_id is null then raise exception 'tenant_owner_role_not_found';end if;
  insert into access_control.membership_roles(membership_id,role_id) values(v_membership_id,v_owner_role_id) on conflict do nothing;
 end if;
 if exists(select 1 from catalog.tenant_addon_subscriptions where tenant_id=v_tenant_id) then raise exception 'modaar_founder_center_must_start_without_addons';end if;
 insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
 select v_tenant_id,v_owner_subject_id,'tenant.modaar_founder_created','tenant',v_tenant_id::text,
 jsonb_build_object('planKey','free','freePeriodStart',timestamptz '2026-08-11 00:00:00+03','freePeriodEnd',timestamptz '2027-08-11 00:00:00+03','addonSubscriptions',0,'demoData',true)
 where not exists(select 1 from audit_log.events event where event.tenant_id=v_tenant_id and event.action='tenant.modaar_founder_created');
end;$modaar_founder_center$;

commit;
