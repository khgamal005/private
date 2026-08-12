-- Tenant accounting: ZATCA add-on catalog contract and non-sensitive metadata.
-- Core quotes, invoices and collections remain usable without this add-on.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('access_control.permissions') is null
     or to_regclass('access_control.roles') is null
     or to_regclass('access_control.role_permissions') is null
     or to_regclass('catalog.features') is null
     or to_regclass('catalog.addon_products') is null
     or to_regclass('catalog.addon_manifests') is null
     or to_regclass('catalog.addon_surfaces') is null
     or to_regclass('catalog.addon_price_versions') is null
     or to_regclass('audit_log.events') is null
     or to_regclass('accounting_core.sales_documents') is null
     or to_regprocedure('private_app.set_updated_at()') is null
     or to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure('private_app.has_accounting_permission(uuid,text)') is null
     or to_regprocedure('private_app.tenant_addon_enabled(uuid,text)') is null then
    raise exception 'tenant_accounting_zatca_missing_prerequisite';
  end if;
end;
$preflight$;

insert into access_control.permissions (
  permission_key,module_key,name_ar,description
)
values (
  'tenant.zatca.manage','accounting','إدارة ربط زاتكا',
  'تهيئة ربط الفوترة الإلكترونية ومتابعة حالاته'
)
on conflict (permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

insert into access_control.role_permissions (role_id,permission_key)
select distinct role.id,'tenant.zatca.manage'
from access_control.roles role
where role.scope='tenant'
  and (
    role.role_key in ('tenant_owner','tenant_admin')
    or exists (
      select 1
      from access_control.role_permissions granted
      where granted.role_id=role.id
        and granted.permission_key='tenant.accounting.settings.manage'
    )
  )
on conflict do nothing;

-------------------------------------------------------------------------------
-- 1. Add-on catalog. This intentionally creates no tenant entitlement.
-------------------------------------------------------------------------------

insert into catalog.features (
  feature_key,name_ar,name_en,category,value_type,default_value,status
)
values (
  'addon.accounting.zatca',
  'الفوترة الإلكترونية وربط زاتكا',
  'ZATCA E-Invoicing',
  'addon',
  'boolean',
  'false'::jsonb,
  'active'
)
on conflict (feature_key) do update
set name_ar=excluded.name_ar,
    name_en=excluded.name_en,
    category=excluded.category,
    value_type=excluded.value_type,
    default_value=excluded.default_value,
    status=excluded.status,
    updated_at=now();

insert into catalog.addon_products (
  product_key,feature_id,name_ar,name_en,description_ar,pricing_mode,
  amount_minor,currency,interval,trial_days,usage_metric,default_limit,
  status,sort_order,marketplace_category,badge_ar,activation_mode
)
select
  'zatca',feature.id,'ربط زاتكا والفوترة الإلكترونية','ZATCA E-Invoicing',
  'تهيئة بيانات المنشأة ومتابعة حالات إرسال الفواتير الضريبية إلى زاتكا.',
  'contact_sales',0,'SAR','year',0,'submitted_documents',null,
  'beta',77,'accounting','تفعيل وربط منفصل','entitlement'
from catalog.features feature
where feature.feature_key='addon.accounting.zatca'
on conflict (product_key) do update
set feature_id=excluded.feature_id,
    name_ar=excluded.name_ar,
    name_en=excluded.name_en,
    description_ar=excluded.description_ar,
    pricing_mode=excluded.pricing_mode,
    amount_minor=excluded.amount_minor,
    currency=excluded.currency,
    interval=excluded.interval,
    trial_days=excluded.trial_days,
    usage_metric=excluded.usage_metric,
    default_limit=excluded.default_limit,
    status=excluded.status,
    sort_order=excluded.sort_order,
    marketplace_category=excluded.marketplace_category,
    badge_ar=excluded.badge_ar,
    activation_mode=excluded.activation_mode,
    updated_at=now();

insert into catalog.addon_manifests (
  product_id,manifest_version,contract_version,short_description_ar,
  long_description_ar,publisher_name,install_mode,data_policy,dependencies,
  required_permissions,configuration_schema,release_notes_ar,status,
  is_current,released_at
)
select
  product.id,'1.0.0',3,
  'طبقة اختيارية لإصدار الفاتورة الضريبية بعد تفعيل الربط.',
  product.description_ar,'Marktone','entitlement','preserve_on_disable',
  '[]'::jsonb,array['tenant.zatca.manage']::text[],
  jsonb_build_object(
    '$schema','https://json-schema.org/draft/2020-12/schema',
    'type','object',
    'additionalProperties',false,
    'properties',jsonb_build_object(
      'environment',jsonb_build_object(
        'type','string','enum',jsonb_build_array('simulation','production')
      ),
      'legalName',jsonb_build_object('type','string','maxLength',200),
      'vatNumber',jsonb_build_object(
        'type','string','pattern','^3[0-9]{13}3$'
      ),
      'branchName',jsonb_build_object('type','string','maxLength',160),
      'branchAddress',jsonb_build_object('type','string','maxLength',500),
      'businessCategory',jsonb_build_object('type','string','maxLength',160)
    )
  ),
  'عقد أولي لبيانات التهيئة وحالات الإرسال فقط؛ موصل زاتكا مستقل.',
  'published',true,timestamptz '2026-08-12 00:00:00+03'
from catalog.addon_products product
where product.product_key='zatca'
on conflict (product_id,manifest_version) do nothing;

insert into catalog.addon_surfaces (
  manifest_id,surface_key,surface_type,location_key,title_ar,description_ar,
  route_template,icon_key,required_permission,visibility_mode,status,
  sort_order,metadata
)
select
  manifest.id,surface.surface_key,surface.surface_type,surface.location_key,
  surface.title_ar,surface.description_ar,surface.route_template,
  surface.icon_key,surface.required_permission,surface.visibility_mode,
  'active',surface.sort_order,jsonb_build_object('productKey','zatca')
from catalog.addon_manifests manifest
join catalog.addon_products product on product.id=manifest.product_id
cross join (
  values
    (
      'tenant.addons','settings','tenant.addons','إدارة إضافة زاتكا',
      'حالة الترخيص وطلب التفعيل مع الاحتفاظ ببيانات التشغيل.',
      '/tenant/{slug}/addons?addon=zatca','puzzle','tenant.settings.manage',
      'always_locked',10
    ),
    (
      'tenant.accounting.zatca','settings','tenant.accounting.zatca',
      'زاتكا والفوترة الإلكترونية',
      'تهيئة المنشأة ومتابعة حالات إرسال المستندات الضريبية.',
      '/tenant/{slug}/accounting/zatca','receipt','tenant.zatca.manage',
      'when_entitled',20
    )
) surface(
  surface_key,surface_type,location_key,title_ar,description_ar,
  route_template,icon_key,required_permission,visibility_mode,sort_order
)
where product.product_key='zatca'
  and manifest.manifest_version='1.0.0'
on conflict (manifest_id,surface_key) do nothing;

insert into catalog.addon_price_versions (
  product_id,pricing_mode,amount_minor,currency,billing_interval,valid_from,
  valid_to,tax_inclusive,tax_rate_bps,change_note
)
select
  product.id,'contact_sales',0,'SAR','year',date '2026-08-12',null,false,1500,
  'ZATCA pricing is agreed with the tenant; no catalog amount is assumed.'
from catalog.addon_products product
where product.product_key='zatca'
on conflict (product_id,currency,valid_from) do nothing;

-------------------------------------------------------------------------------
-- 2. Typed operational metadata. No request/response document bodies are kept.
-------------------------------------------------------------------------------

create schema if not exists accounting_zatca;
revoke all on schema accounting_zatca from public,anon,authenticated;

create table accounting_zatca.tenant_configurations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  environment text not null default 'simulation'
    check (environment in ('simulation','production')),
  legal_name text check (legal_name is null or length(btrim(legal_name)) between 2 and 200),
  vat_number text check (vat_number is null or vat_number ~ '^3[0-9]{13}3$'),
  branch_name text check (branch_name is null or length(btrim(branch_name)) between 2 and 160),
  branch_address text check (branch_address is null or length(btrim(branch_address)) between 5 and 500),
  business_category text check (business_category is null or length(btrim(business_category)) between 2 and 160),
  onboarding_status text not null default 'draft'
    check (onboarding_status in ('draft','profile_ready','connected','suspended','error')),
  last_checked_at timestamptz,
  last_error_code text check (last_error_code is null or length(last_error_code)<=120),
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create table accounting_zatca.submission_metadata (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  document_id uuid not null,
  document_kind text not null
    check (document_kind in ('invoice','credit_note','debit_note')),
  submission_kind text not null
    check (submission_kind in ('reporting','clearance')),
  environment text not null
    check (environment in ('simulation','production')),
  status text not null default 'queued'
    check (status in ('queued','submitted','accepted','warning','rejected','failed')),
  external_document_uuid uuid,
  sequence_number bigint check (sequence_number is null or sequence_number>0),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 8 and 160),
  validation_code text check (validation_code is null or length(validation_code)<=120),
  retry_count integer not null default 0 check (retry_count between 0 and 100),
  submitted_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,idempotency_key)
  ,foreign key(tenant_id,document_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict
);

create index zatca_submission_tenant_time_idx
on accounting_zatca.submission_metadata(tenant_id,created_at desc);

create index zatca_submission_document_idx
on accounting_zatca.submission_metadata(tenant_id,document_id,created_at desc);

create trigger zatca_configuration_set_updated_at
before update on accounting_zatca.tenant_configurations
for each row execute function private_app.set_updated_at();

create trigger zatca_submission_set_updated_at
before update on accounting_zatca.submission_metadata
for each row execute function private_app.set_updated_at();

alter table accounting_zatca.tenant_configurations enable row level security;
alter table accounting_zatca.tenant_configurations force row level security;
alter table accounting_zatca.submission_metadata enable row level security;
alter table accounting_zatca.submission_metadata force row level security;

revoke all on table accounting_zatca.tenant_configurations
from public,anon,authenticated;
revoke all on table accounting_zatca.submission_metadata
from public,anon,authenticated;

-------------------------------------------------------------------------------
-- 3. Tenant RPCs. Reading accounting never requires the ZATCA entitlement.
-------------------------------------------------------------------------------

create or replace function public.v1_tenant_zatca_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_enabled boolean;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_tenant
  from core.tenants
  where slug=p_slug and status in ('trial','active');
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.read') then
    raise exception 'forbidden' using errcode='42501';
  end if;
  v_enabled:=private_app.tenant_addon_enabled(
    v_tenant.id,'addon.accounting.zatca'
  );
  return jsonb_build_object(
    'addonEnabled',v_enabled,
    'availability',case when v_enabled then 'available' else 'addon_required' end,
    'canManage',v_enabled and private_app.has_accounting_permission(
      v_tenant.id,'tenant.zatca.manage'
    ),
    'configuration',(
      select jsonb_strip_nulls(jsonb_build_object(
        'id',config.id,'environment',config.environment,
        'legalName',config.legal_name,'vatNumber',config.vat_number,
        'branchName',config.branch_name,'branchAddress',config.branch_address,
        'businessCategory',config.business_category,
        'status',config.onboarding_status,'lastCheckedAt',config.last_checked_at,
        'lastErrorCode',config.last_error_code,'updatedAt',config.updated_at
      ))
      from accounting_zatca.tenant_configurations config
      where config.tenant_id=v_tenant.id
    ),
    'recentSubmissions',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',recent.id,'documentId',recent.document_id,
        'documentKind',recent.document_kind,
        'submissionKind',recent.submission_kind,
        'environment',recent.environment,'status',recent.status,
        'externalDocumentUuid',recent.external_document_uuid,
        'sequenceNumber',recent.sequence_number,
        'validationCode',recent.validation_code,'retryCount',recent.retry_count,
        'submittedAt',recent.submitted_at,
        'acknowledgedAt',recent.acknowledged_at,'createdAt',recent.created_at
      )) order by recent.created_at desc)
      from (
        select * from accounting_zatca.submission_metadata submission
        where submission.tenant_id=v_tenant.id
        order by submission.created_at desc limit 30
      ) recent
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function public.v1_tenant_zatca_action(
  p_slug text,p_action text,p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_actor uuid;
  v_config accounting_zatca.tenant_configurations%rowtype;
  v_environment text;
  v_legal_name text;
  v_vat_number text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_tenant
  from core.tenants
  where slug=p_slug and status in ('trial','active');
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_accounting_permission(v_tenant.id,'tenant.zatca.manage') then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if not private_app.tenant_addon_enabled(
    v_tenant.id,'addon.accounting.zatca'
  ) then raise exception 'addon_required' using errcode='42501'; end if;
  if p_action<>'save_config' or jsonb_typeof(coalesce(p_payload,'{}'::jsonb))<>'object' then
    raise exception 'zatca_action_invalid';
  end if;

  v_environment:=coalesce(nullif(btrim(p_payload->>'environment'),''),'simulation');
  v_legal_name:=nullif(btrim(p_payload->>'legalName'),'');
  v_vat_number:=nullif(btrim(p_payload->>'vatNumber'),'');
  if v_environment not in ('simulation','production')
     or (v_legal_name is not null and length(v_legal_name) not between 2 and 200)
     or (v_vat_number is not null and v_vat_number !~ '^3[0-9]{13}3$')
     or length(coalesce(p_payload->>'branchName',''))>160
     or length(coalesce(p_payload->>'branchAddress',''))>500
     or length(coalesce(p_payload->>'businessCategory',''))>160 then
    raise exception 'zatca_config_invalid';
  end if;

  v_actor:=private_app.current_subject_id();
  insert into accounting_zatca.tenant_configurations (
    tenant_id,environment,legal_name,vat_number,branch_name,branch_address,
    business_category,onboarding_status,created_by_subject_id,
    updated_by_subject_id
  ) values (
    v_tenant.id,v_environment,v_legal_name,v_vat_number,
    nullif(btrim(p_payload->>'branchName'),''),
    nullif(btrim(p_payload->>'branchAddress'),''),
    nullif(btrim(p_payload->>'businessCategory'),''),
    case when v_legal_name is not null and v_vat_number is not null
      then 'profile_ready' else 'draft' end,
    v_actor,v_actor
  )
  on conflict (tenant_id) do update
  set environment=excluded.environment,
      legal_name=excluded.legal_name,
      vat_number=excluded.vat_number,
      branch_name=excluded.branch_name,
      branch_address=excluded.branch_address,
      business_category=excluded.business_category,
      onboarding_status=excluded.onboarding_status,
      last_error_code=null,
      updated_by_subject_id=excluded.updated_by_subject_id,
      updated_at=now()
  returning * into v_config;

  insert into audit_log.events (
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_tenant.id,v_actor,'accounting.zatca.configuration_saved',
    'zatca_configuration',v_config.id::text,
    jsonb_build_object(
      'environment',v_config.environment,
      'status',v_config.onboarding_status,
      'vatNumberPresent',v_config.vat_number is not null
    )
  );
  return jsonb_build_object(
    'success',true,'configurationId',v_config.id,
    'status',v_config.onboarding_status
  );
end;
$$;

revoke all on function public.v1_tenant_zatca_snapshot(text)
from public,anon;
revoke all on function public.v1_tenant_zatca_action(text,text,jsonb)
from public,anon;
grant execute on function public.v1_tenant_zatca_snapshot(text)
to authenticated;
grant execute on function public.v1_tenant_zatca_action(text,text,jsonb)
to authenticated;

commit;
