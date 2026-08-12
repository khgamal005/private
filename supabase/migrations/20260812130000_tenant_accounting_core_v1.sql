-- Tenant accounting core v1: operational receivables, documents and collections.
-- Additive only. No tenant data is imported, backfilled or changed automatically.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('access_control.permissions') is null
     or to_regclass('access_control.roles') is null
     or to_regclass('access_control.role_permissions') is null
     or to_regclass('sales_core.contacts') is null
     or to_regclass('incentives_core.events') is null
     or to_regclass('academy.registration_handoffs') is null
     or to_regclass('audit_log.events') is null
     or to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure('private_app.has_platform_permission(text)') is null
     or to_regprocedure('private_app.set_updated_at()') is null
     or to_regprocedure('private_app.write_audit(text,text,text,uuid,jsonb)') is null then
    raise exception 'tenant_accounting_core_missing_prerequisite';
  end if;
end;
$preflight$;

-------------------------------------------------------------------------------
-- 1. Explicit permissions and finance roles
-------------------------------------------------------------------------------

insert into access_control.permissions(
  permission_key,module_key,name_ar,description
)
values
  ('tenant.accounting.read','accounting','عرض الحسابات والفوترة','عرض حسابات العملاء والمستندات والتحصيل والتقارير المالية التشغيلية.'),
  ('tenant.accounting.customers.write','accounting','إدارة حسابات العملاء','إنشاء وتحديث ملفات حسابات العملاء.'),
  ('tenant.accounting.quotes.write','accounting','إدارة عروض الأسعار','إنشاء وتحديث وإرسال عروض الأسعار.'),
  ('tenant.accounting.invoices.write','accounting','إعداد الفواتير','إنشاء مسودات الفواتير والإشعارات.'),
  ('tenant.accounting.invoices.issue','accounting','إصدار الفواتير','تثبيت وإصدار الفواتير والإشعارات.'),
  ('tenant.accounting.payments.record','accounting','تسجيل المدفوعات','تسجيل دفعات العملاء قيد التحقق.'),
  ('tenant.accounting.payments.approve','accounting','اعتماد المدفوعات','التحقق من الدفعات وتوزيعها وإصدار الإيصالات.'),
  ('tenant.accounting.refunds.request','accounting','طلب الاسترداد','تسجيل طلبات استرداد أموال العملاء.'),
  ('tenant.accounting.refunds.approve','accounting','اعتماد الاسترداد','اعتماد أو رفض وإتمام الاستردادات.'),
  ('tenant.accounting.incentives.approve','accounting','اعتماد الحوافز ماليًا','مراجعة الحوافز المستحقة واعتمادها ماليًا.'),
  ('tenant.accounting.incentives.pay','accounting','صرف الحوافز','إثبات صرف الحوافز المعتمدة.'),
  ('tenant.accounting.reports.read','accounting','التقارير المالية','عرض تقارير التحصيل والمستحقات والضريبة التشغيلية.'),
  ('tenant.accounting.settings.manage','accounting','إعدادات الحسابات','إدارة العملة والترقيم والضريبة وشروط السداد.'),
  ('tenant.zatca.manage','accounting','إدارة ربط زاتكا','إدارة البيانات اللازمة لربط الفوترة الإلكترونية.'),
  ('tenant.zatca.submit','accounting','إرسال مستندات زاتكا','إرسال المستندات الضريبية عبر الموصل المعتمد.'),
  ('platform.tenant_accounting.support','platform','دعم حسابات المنشآت','دخول دعم مالي صريح ومراقب إلى حسابات المنشآت.')
on conflict(permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

insert into access_control.roles(
  tenant_id,role_key,name_ar,name_en,scope,is_system
)
select null,seed.role_key,seed.name_ar,seed.name_en,'tenant',true
from (values
  ('finance_manager','المدير المالي','Finance manager'),
  ('accountant','المحاسب','Accountant'),
  ('cashier','أمين الصندوق','Cashier')
) seed(role_key,name_ar,name_en)
where not exists(
  select 1 from access_control.roles role
  where role.tenant_id is null and role.role_key=seed.role_key
);

insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope='tenant'
  and role.role_key in ('tenant_owner','tenant_admin','executive_manager','finance_manager')
  and permission.permission_key like 'tenant.accounting.%'
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope='tenant'
  and role.role_key in ('tenant_owner','tenant_admin','executive_manager','finance_manager')
  and permission.permission_key in ('tenant.zatca.manage','tenant.zatca.submit')
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope='tenant' and role.role_key='accountant'
  and permission.permission_key in (
    'tenant.accounting.read','tenant.accounting.customers.write',
    'tenant.accounting.quotes.write','tenant.accounting.invoices.write',
    'tenant.accounting.invoices.issue','tenant.accounting.payments.record',
    'tenant.accounting.payments.approve','tenant.accounting.refunds.request',
    'tenant.accounting.reports.read'
  )
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope='tenant' and role.role_key='cashier'
  and permission.permission_key in (
    'tenant.accounting.read','tenant.accounting.payments.record'
  )
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope='tenant' and role.role_key in ('sales_manager','sales_supervisor')
  and permission.permission_key in (
    'tenant.accounting.read','tenant.accounting.customers.write',
    'tenant.accounting.quotes.write'
  )
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,'platform.tenant_accounting.support'
from access_control.roles role
where role.scope='platform' and role.role_key='platform_owner'
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,'tenant.incentives.read'
from access_control.roles role
where role.scope='tenant' and role.role_key in ('finance_manager','accountant')
on conflict do nothing;

create or replace function private_app.accounting_permission_dependency()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if (new.permission_key like 'tenant.accounting.%'
      and new.permission_key<>'tenant.accounting.read')
     or new.permission_key like 'tenant.zatca.%' then
    insert into access_control.role_permissions(role_id,permission_key)
    values(new.role_id,'tenant.accounting.read')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger accounting_role_permission_dependency
after insert on access_control.role_permissions
for each row execute function private_app.accounting_permission_dependency();

revoke all on function private_app.accounting_permission_dependency()
from public,anon,authenticated,service_role;

create or replace function private_app.has_accounting_permission(
  p_tenant_id uuid,p_permission text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.tenant_accounting.support')
    or exists(
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
       and membership.tenant_id=p_tenant_id
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id and role.scope='tenant'
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and role_permission.permission_key=p_permission
    )
  )
$$;

revoke all on function private_app.has_accounting_permission(uuid,text)
from public,anon,authenticated,service_role;

-------------------------------------------------------------------------------
-- 2. Tenant-scoped receivables model
-------------------------------------------------------------------------------

create schema if not exists accounting_core;
revoke all on schema accounting_core from public,anon,authenticated;

-- sales_core.contacts already has the reviewed unique index
-- sales_contacts_tenant_id_id_uidx required by the composite tenant foreign keys.

create table accounting_core.tenant_profiles(
  tenant_id uuid primary key references core.tenants(id) on delete cascade,
  legal_name_ar text,
  commercial_registration_number text,
  vat_number text,
  tax_registered boolean not null default false,
  base_currency text not null default 'SAR' check(base_currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Riyadh',
  default_payment_terms_days integer not null default 0
    check(default_payment_terms_days between 0 and 3650),
  default_tax_rate_bps integer not null default 1500
    check(default_tax_rate_bps between 0 and 10000),
  quote_prefix text not null default 'Q' check(quote_prefix ~ '^[A-Z0-9-]{1,10}$'),
  invoice_prefix text not null default 'INV' check(invoice_prefix ~ '^[A-Z0-9-]{1,10}$'),
  credit_note_prefix text not null default 'CN' check(credit_note_prefix ~ '^[A-Z0-9-]{1,10}$'),
  debit_note_prefix text not null default 'DN' check(debit_note_prefix ~ '^[A-Z0-9-]{1,10}$'),
  receipt_prefix text not null default 'REC' check(receipt_prefix ~ '^[A-Z0-9-]{1,10}$'),
  auto_import_verified_admissions boolean not null default false,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table accounting_core.document_sequences(
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  sequence_key text not null check(sequence_key ~ '^[a-z][a-z0-9_]{2,40}$'),
  calendar_year integer not null check(calendar_year between 2000 and 2200),
  next_value bigint not null default 1 check(next_value>0),
  primary key(tenant_id,sequence_key,calendar_year)
);

create table accounting_core.customer_accounts(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  contact_id uuid,
  account_number text not null,
  display_name text not null check(length(btrim(display_name)) between 2 and 200),
  organization_name text,
  billing_email text,
  billing_phone text,
  tax_number text,
  billing_address text,
  payment_terms_days integer not null default 0 check(payment_terms_days between 0 and 3650),
  credit_limit_minor bigint check(credit_limit_minor is null or credit_limit_minor>=0),
  status text not null default 'active' check(status in ('active','on_hold','closed')),
  notes text,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,account_number),
  unique(tenant_id,contact_id),
  foreign key(tenant_id,contact_id)
    references sales_core.contacts(tenant_id,id) on delete restrict
);

create table accounting_core.sales_documents(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  document_type text not null
    check(document_type in ('quote','invoice','credit_note','debit_note')),
  document_number text not null,
  revision_number integer not null default 1 check(revision_number>0),
  status text not null default 'draft'
    check(status in ('draft','sent','accepted','rejected','expired','converted','issued','cancelled')),
  customer_account_id uuid not null,
  contact_id uuid,
  parent_document_id uuid,
  source_type text,
  source_id text,
  issue_date date not null default current_date,
  valid_until date,
  due_date date,
  currency text not null default 'SAR' check(currency ~ '^[A-Z]{3}$'),
  customer_name_snapshot text not null,
  customer_tax_number_snapshot text,
  customer_email_snapshot text,
  customer_phone_snapshot text,
  customer_address_snapshot text,
  subtotal_minor bigint not null default 0 check(subtotal_minor>=0),
  discount_minor bigint not null default 0 check(discount_minor>=0),
  tax_minor bigint not null default 0 check(tax_minor>=0),
  total_minor bigint not null default 0 check(total_minor>=0),
  notes text,
  terms text,
  metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  updated_by_subject_id uuid references access_control.subjects(id) on delete set null,
  issued_by_subject_id uuid references access_control.subjects(id) on delete set null,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,document_type,document_number),
  foreign key(tenant_id,customer_account_id)
    references accounting_core.customer_accounts(tenant_id,id) on delete restrict,
  foreign key(tenant_id,contact_id)
    references sales_core.contacts(tenant_id,id) on delete restrict,
  foreign key(tenant_id,parent_document_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict,
  check(valid_until is null or valid_until>=issue_date),
  check(due_date is null or due_date>=issue_date),
  check(discount_minor<=subtotal_minor),
  check(total_minor=subtotal_minor-discount_minor+tax_minor)
);

create unique index accounting_documents_source_idx
on accounting_core.sales_documents(tenant_id,source_type,source_id)
where source_id is not null;

create index accounting_documents_customer_date_idx
on accounting_core.sales_documents(tenant_id,customer_account_id,issue_date desc);

create index accounting_documents_status_due_idx
on accounting_core.sales_documents(tenant_id,status,due_date)
where document_type in ('invoice','debit_note');

create table accounting_core.sales_document_lines(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  document_id uuid not null,
  position integer not null check(position>0),
  item_type text not null default 'service'
    check(item_type in ('course','service','product','discount','custom')),
  source_id text,
  description text not null check(length(btrim(description)) between 1 and 500),
  quantity numeric(12,3) not null default 1 check(quantity>0),
  unit_amount_minor bigint not null check(unit_amount_minor>=0),
  subtotal_minor bigint not null check(subtotal_minor>=0),
  discount_minor bigint not null default 0 check(discount_minor>=0 and discount_minor<=subtotal_minor),
  tax_category text not null default 'standard'
    check(tax_category in ('standard','zero','exempt','out_of_scope')),
  tax_rate_bps integer not null default 1500 check(tax_rate_bps between 0 and 10000),
  tax_minor bigint not null default 0 check(tax_minor>=0),
  total_minor bigint not null check(total_minor>=0),
  metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,document_id,position),
  foreign key(tenant_id,document_id)
    references accounting_core.sales_documents(tenant_id,id) on delete cascade,
  check(total_minor=subtotal_minor-discount_minor+tax_minor),
  check((tax_category='standard') or tax_minor=0)
);

create table accounting_core.payment_schedules(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  invoice_id uuid not null,
  installment_number integer not null check(installment_number>0),
  due_date date not null,
  amount_minor bigint not null check(amount_minor>0),
  label text,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,invoice_id,installment_number),
  foreign key(tenant_id,invoice_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict
);

create table accounting_core.payments(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  customer_account_id uuid not null,
  payment_number text not null,
  amount_minor bigint not null check(amount_minor>0),
  currency text not null default 'SAR' check(currency ~ '^[A-Z]{3}$'),
  method text not null default 'bank_transfer'
    check(method in ('bank_transfer','cash','mada','tamara','paymob','paypal','store','other')),
  status text not null default 'pending_verification'
    check(status in ('pending_verification','verified','rejected','refunded')),
  external_reference text,
  source_type text,
  source_id text,
  received_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_by_subject_id uuid references access_control.subjects(id) on delete set null,
  rejection_reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,payment_number),
  foreign key(tenant_id,customer_account_id)
    references accounting_core.customer_accounts(tenant_id,id) on delete restrict,
  check((status='verified' and verified_at is not null and verified_by_subject_id is not null) or status<>'verified')
);

create unique index accounting_payments_source_idx
on accounting_core.payments(tenant_id,source_type,source_id)
where source_id is not null;

create index accounting_payments_customer_time_idx
on accounting_core.payments(tenant_id,customer_account_id,received_at desc);

create table accounting_core.payment_allocations(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  payment_id uuid not null,
  invoice_id uuid not null,
  amount_minor bigint not null check(amount_minor>0),
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,payment_id,invoice_id),
  foreign key(tenant_id,payment_id)
    references accounting_core.payments(tenant_id,id) on delete restrict,
  foreign key(tenant_id,invoice_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict
);

create table accounting_core.receipts(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  payment_id uuid not null,
  receipt_number text not null,
  issued_at timestamptz not null default now(),
  issued_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  unique(tenant_id,payment_id),
  unique(tenant_id,receipt_number),
  foreign key(tenant_id,payment_id)
    references accounting_core.payments(tenant_id,id) on delete restrict
);

create table accounting_core.collection_actions(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  customer_account_id uuid not null,
  invoice_id uuid,
  action_type text not null
    check(action_type in ('note','call','whatsapp','email','payment_promise')),
  summary text not null check(length(btrim(summary)) between 2 and 2000),
  promised_date date,
  promised_amount_minor bigint check(promised_amount_minor is null or promised_amount_minor>0),
  next_action_at timestamptz,
  created_by_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,customer_account_id)
    references accounting_core.customer_accounts(tenant_id,id) on delete restrict,
  foreign key(tenant_id,invoice_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict,
  check((action_type='payment_promise' and promised_date is not null) or action_type<>'payment_promise')
);

create table accounting_core.refunds(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  customer_account_id uuid not null,
  payment_id uuid not null,
  invoice_id uuid,
  credit_note_id uuid,
  amount_minor bigint not null check(amount_minor>0),
  reason text not null check(length(btrim(reason)) between 3 and 1000),
  status text not null default 'requested'
    check(status in ('requested','approved','rejected','completed','cancelled')),
  requested_by_subject_id uuid references access_control.subjects(id) on delete set null,
  approved_by_subject_id uuid references access_control.subjects(id) on delete set null,
  approved_at timestamptz,
  completed_by_subject_id uuid references access_control.subjects(id) on delete set null,
  completed_at timestamptz,
  external_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,id),
  foreign key(tenant_id,customer_account_id)
    references accounting_core.customer_accounts(tenant_id,id) on delete restrict,
  foreign key(tenant_id,payment_id)
    references accounting_core.payments(tenant_id,id) on delete restrict,
  foreign key(tenant_id,invoice_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict,
  foreign key(tenant_id,credit_note_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict
);

create index accounting_refunds_tenant_status_idx
on accounting_core.refunds(tenant_id,status,created_at desc);

create table accounting_core.document_events(
  id bigint generated always as identity primary key,
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  document_id uuid not null,
  event_type text not null,
  from_status text,
  to_status text,
  actor_subject_id uuid references access_control.subjects(id) on delete set null,
  details jsonb not null default '{}'::jsonb check(jsonb_typeof(details)='object'),
  created_at timestamptz not null default now(),
  foreign key(tenant_id,document_id)
    references accounting_core.sales_documents(tenant_id,id) on delete restrict
);

create index accounting_document_events_idx
on accounting_core.document_events(tenant_id,document_id,created_at desc);

create table accounting_core.commands(
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  command_id uuid not null,
  action text not null,
  request_hash text not null,
  response jsonb not null,
  actor_subject_id uuid references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key(tenant_id,command_id)
);

-------------------------------------------------------------------------------
-- 3. Integrity, immutability and private helpers
-------------------------------------------------------------------------------

create or replace function private_app.accounting_next_number(
  p_tenant_id uuid,p_sequence_key text,p_on_date date,p_prefix text
)
returns text
language plpgsql
security definer
set search_path=''
as $$
declare
  v_year integer:=extract(year from coalesce(p_on_date,current_date))::integer;
  v_number bigint;
begin
  insert into accounting_core.document_sequences(
    tenant_id,sequence_key,calendar_year,next_value
  ) values(p_tenant_id,p_sequence_key,v_year,2)
  on conflict(tenant_id,sequence_key,calendar_year) do update
  set next_value=accounting_core.document_sequences.next_value+1
  returning next_value-1 into v_number;
  return upper(p_prefix)||'-'||v_year::text||'-'||lpad(v_number::text,6,'0');
end;
$$;

revoke all on function private_app.accounting_next_number(uuid,text,date,text)
from public,anon,authenticated,service_role;

create or replace function private_app.accounting_guard_document()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='DELETE' then
    if old.status<>'draft' then raise exception 'issued_document_immutable'; end if;
    return old;
  end if;
  if old.status in ('issued','converted','cancelled','rejected','expired') then
    raise exception 'issued_document_immutable';
  end if;
  if old.status<>'draft' and (
    new.document_type is distinct from old.document_type
    or new.customer_account_id is distinct from old.customer_account_id
    or new.contact_id is distinct from old.contact_id
    or new.issue_date is distinct from old.issue_date
    or new.valid_until is distinct from old.valid_until
    or new.due_date is distinct from old.due_date
    or new.currency is distinct from old.currency
    or new.customer_name_snapshot is distinct from old.customer_name_snapshot
    or new.customer_tax_number_snapshot is distinct from old.customer_tax_number_snapshot
    or new.subtotal_minor is distinct from old.subtotal_minor
    or new.discount_minor is distinct from old.discount_minor
    or new.tax_minor is distinct from old.tax_minor
    or new.total_minor is distinct from old.total_minor
    or new.notes is distinct from old.notes
    or new.terms is distinct from old.terms
  ) then raise exception 'issued_document_immutable'; end if;
  return new;
end;
$$;

create trigger accounting_document_immutable
before update or delete on accounting_core.sales_documents
for each row execute function private_app.accounting_guard_document();

revoke all on function private_app.accounting_guard_document()
from public,anon,authenticated,service_role;

create or replace function private_app.accounting_guard_line()
returns trigger
language plpgsql
set search_path=''
as $$
declare v_status text;
begin
  select status into v_status from accounting_core.sales_documents
  where tenant_id=coalesce(new.tenant_id,old.tenant_id)
    and id=coalesce(new.document_id,old.document_id);
  if v_status is distinct from 'draft' then raise exception 'issued_document_immutable'; end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

create trigger accounting_line_immutable
before insert or update or delete on accounting_core.sales_document_lines
for each row execute function private_app.accounting_guard_line();

revoke all on function private_app.accounting_guard_line()
from public,anon,authenticated,service_role;

create or replace function private_app.accounting_append_only()
returns trigger language plpgsql set search_path=''
as $$ begin raise exception 'accounting_event_append_only'; end; $$;

create trigger accounting_document_events_append_only
before update or delete on accounting_core.document_events
for each row execute function private_app.accounting_append_only();

revoke all on function private_app.accounting_append_only()
from public,anon,authenticated,service_role;

create trigger accounting_profile_updated_at
before update on accounting_core.tenant_profiles
for each row execute function private_app.set_updated_at();
create trigger accounting_customer_updated_at
before update on accounting_core.customer_accounts
for each row execute function private_app.set_updated_at();
create trigger accounting_document_updated_at
before update on accounting_core.sales_documents
for each row execute function private_app.set_updated_at();
create trigger accounting_payment_updated_at
before update on accounting_core.payments
for each row execute function private_app.set_updated_at();
create trigger accounting_refund_updated_at
before update on accounting_core.refunds
for each row execute function private_app.set_updated_at();

alter table accounting_core.tenant_profiles enable row level security;
alter table accounting_core.tenant_profiles force row level security;
alter table accounting_core.document_sequences enable row level security;
alter table accounting_core.document_sequences force row level security;
alter table accounting_core.customer_accounts enable row level security;
alter table accounting_core.customer_accounts force row level security;
alter table accounting_core.sales_documents enable row level security;
alter table accounting_core.sales_documents force row level security;
alter table accounting_core.sales_document_lines enable row level security;
alter table accounting_core.sales_document_lines force row level security;
alter table accounting_core.payment_schedules enable row level security;
alter table accounting_core.payment_schedules force row level security;
alter table accounting_core.payments enable row level security;
alter table accounting_core.payments force row level security;
alter table accounting_core.payment_allocations enable row level security;
alter table accounting_core.payment_allocations force row level security;
alter table accounting_core.receipts enable row level security;
alter table accounting_core.receipts force row level security;
alter table accounting_core.collection_actions enable row level security;
alter table accounting_core.collection_actions force row level security;
alter table accounting_core.refunds enable row level security;
alter table accounting_core.refunds force row level security;
alter table accounting_core.document_events enable row level security;
alter table accounting_core.document_events force row level security;
alter table accounting_core.commands enable row level security;
alter table accounting_core.commands force row level security;

revoke all on all tables in schema accounting_core from public,anon,authenticated;
revoke all on all sequences in schema accounting_core from public,anon,authenticated;

-------------------------------------------------------------------------------
-- 4. One read model for every accounting screen
-------------------------------------------------------------------------------

create or replace function public.v1_tenant_accounting_snapshot(
  p_slug text,p_from date default null,p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_from date:=coalesce(p_from,date_trunc('month',current_date)::date);
  v_to date:=coalesce(p_to,current_date);
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if v_from>v_to or v_to-v_from>1095 then raise exception 'invalid_date_range'; end if;
  select * into v_tenant from core.tenants
  where slug=p_slug and status in ('trial','active') limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.read') then
    raise exception 'forbidden' using errcode='42501';
  end if;

  return jsonb_build_object(
    'schemaVersion',1,'generatedAt',now(),'tenantId',v_tenant.id,
    'period',jsonb_build_object('from',v_from,'to',v_to),
    'viewer',jsonb_build_object(
      'canRead',true,
      'canManageCustomers',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.customers.write'),
      'canWriteQuotes',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.quotes.write'),
      'canWriteInvoices',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.invoices.write'),
      'canIssueInvoices',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.invoices.issue'),
      'canRecordPayments',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.payments.record'),
      'canApprovePayments',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.payments.approve'),
      'canRequestRefunds',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.refunds.request'),
      'canApproveRefunds',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.refunds.approve'),
      'canReadReports',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.reports.read'),
      'canManageSettings',private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.settings.manage')
    ),
    'profile',coalesce((
      select jsonb_strip_nulls(jsonb_build_object(
        'legalNameAr',profile.legal_name_ar,
        'commercialRegistrationNumber',profile.commercial_registration_number,
        'vatNumber',profile.vat_number,'taxRegistered',profile.tax_registered,
        'baseCurrency',profile.base_currency,'timezone',profile.timezone,
        'defaultPaymentTermsDays',profile.default_payment_terms_days,
        'defaultTaxRateBps',profile.default_tax_rate_bps,
        'quotePrefix',profile.quote_prefix,'invoicePrefix',profile.invoice_prefix,
        'creditNotePrefix',profile.credit_note_prefix,
        'debitNotePrefix',profile.debit_note_prefix,
        'receiptPrefix',profile.receipt_prefix,
        'autoImportVerifiedAdmissions',profile.auto_import_verified_admissions
      )) from accounting_core.tenant_profiles profile
      where profile.tenant_id=v_tenant.id
    ),jsonb_build_object(
      'legalNameAr',coalesce(v_tenant.legal_name,v_tenant.name),
      'taxRegistered',false,'baseCurrency','SAR','timezone',v_tenant.timezone,
      'defaultPaymentTermsDays',0,'defaultTaxRateBps',1500,
      'quotePrefix','Q','invoicePrefix','INV','creditNotePrefix','CN',
      'debitNotePrefix','DN','receiptPrefix','REC',
      'autoImportVerifiedAdmissions',false
    )),
    'summary',(
      with document_totals as(
        select
          coalesce(sum(case when document_type in ('invoice','debit_note') then total_minor when document_type='credit_note' then -total_minor else 0 end),0)::bigint net_invoiced,
          coalesce(sum(case when document_type in ('invoice','debit_note') then tax_minor when document_type='credit_note' then -tax_minor else 0 end),0)::bigint tax_invoiced
        from accounting_core.sales_documents
        where tenant_id=v_tenant.id and status='issued'
          and issue_date between v_from and v_to
      ), payment_totals as(
        select coalesce(sum(amount_minor),0)::bigint collected
        from accounting_core.payments
        where tenant_id=v_tenant.id and status in ('verified','refunded')
          and received_at::date between v_from and v_to
      ), refund_totals as(
        select coalesce(sum(amount_minor),0)::bigint refunded
        from accounting_core.refunds
        where tenant_id=v_tenant.id and status='completed'
          and completed_at::date between v_from and v_to
      ), invoice_balances as(
        select document.id,document.due_date,
          greatest(document.total_minor-coalesce(sum(allocation.amount_minor),0),0)::bigint outstanding
        from accounting_core.sales_documents document
        left join accounting_core.payment_allocations allocation
          on allocation.tenant_id=document.tenant_id and allocation.invoice_id=document.id
        where document.tenant_id=v_tenant.id and document.status='issued'
          and document.document_type in ('invoice','debit_note')
        group by document.id,document.due_date,document.total_minor
      )
      select jsonb_build_object(
        'netInvoicedMinor',document_totals.net_invoiced,
        'taxInvoicedMinor',document_totals.tax_invoiced,
        'collectedMinor',payment_totals.collected-refund_totals.refunded,
        'refundedMinor',refund_totals.refunded,
        'outstandingMinor',coalesce(sum(invoice_balances.outstanding),0)::bigint,
        'overdueMinor',coalesce(sum(invoice_balances.outstanding) filter(where invoice_balances.due_date<current_date),0)::bigint,
        'pendingPayments',(
          select count(*) from accounting_core.payments
          where tenant_id=v_tenant.id and status='pending_verification'
        ),
        'pendingRefunds',(
          select count(*) from accounting_core.refunds
          where tenant_id=v_tenant.id and status in ('requested','approved')
        ),
        'dueIncentivesMinor',(
          select coalesce(round(sum(incentive_amount)*100),0)::bigint
          from incentives_core.events
          where tenant_id=v_tenant.id and state in ('due','approved')
        )
      )
      from document_totals,payment_totals,refund_totals
      left join invoice_balances on true
      group by document_totals.net_invoiced,document_totals.tax_invoiced,
        payment_totals.collected,refund_totals.refunded
    ),
    'aging',(
      with balances as(
        select document.due_date,
          greatest(document.total_minor-coalesce(sum(allocation.amount_minor),0),0)::bigint amount
        from accounting_core.sales_documents document
        left join accounting_core.payment_allocations allocation
          on allocation.tenant_id=document.tenant_id and allocation.invoice_id=document.id
        where document.tenant_id=v_tenant.id and document.status='issued'
          and document.document_type in ('invoice','debit_note')
        group by document.id,document.due_date,document.total_minor
      ) select jsonb_build_object(
        'current',coalesce(sum(amount) filter(where due_date>=current_date),0)::bigint,
        'days1to30',coalesce(sum(amount) filter(where current_date-due_date between 1 and 30),0)::bigint,
        'days31to60',coalesce(sum(amount) filter(where current_date-due_date between 31 and 60),0)::bigint,
        'days61to90',coalesce(sum(amount) filter(where current_date-due_date between 61 and 90),0)::bigint,
        'over90',coalesce(sum(amount) filter(where current_date-due_date>90),0)::bigint
      ) from balances
    ),
    'accounts',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',account.id,'accountNumber',account.account_number,
        'contactId',account.contact_id,'displayName',account.display_name,
        'organizationName',account.organization_name,'billingEmail',account.billing_email,
        'billingPhone',account.billing_phone,'taxNumber',account.tax_number,
        'billingAddress',account.billing_address,'paymentTermsDays',account.payment_terms_days,
        'creditLimitMinor',account.credit_limit_minor,'status',account.status,
        'invoicedMinor',coalesce(balance.invoiced,0),
        'creditNotesMinor',coalesce(balance.credits,0),
        'collectedMinor',coalesce(balance.allocated,0),
        'refundedMinor',coalesce(balance.refunded,0),
        'balanceMinor',coalesce(balance.invoiced,0)-coalesce(balance.credits,0)-coalesce(balance.allocated,0)+coalesce(balance.refunded,0),
        'updatedAt',account.updated_at
      )) order by account.display_name)
      from accounting_core.customer_accounts account
      left join lateral(
        select
          coalesce(sum(document.total_minor) filter(where document.status='issued' and document.document_type in ('invoice','debit_note')),0)::bigint invoiced,
          coalesce(sum(document.total_minor) filter(where document.status='issued' and document.document_type='credit_note'),0)::bigint credits,
          (select coalesce(sum(allocation.amount_minor),0)::bigint
           from accounting_core.payment_allocations allocation
           join accounting_core.payments payment on payment.tenant_id=allocation.tenant_id and payment.id=allocation.payment_id
           where allocation.tenant_id=account.tenant_id and payment.customer_account_id=account.id) allocated,
          (select coalesce(sum(refund.amount_minor),0)::bigint
           from accounting_core.refunds refund
           where refund.tenant_id=account.tenant_id and refund.customer_account_id=account.id and refund.status='completed') refunded
        from accounting_core.sales_documents document
        where document.tenant_id=account.tenant_id and document.customer_account_id=account.id
      ) balance on true
      where account.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'customerCandidates',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',candidate.id,'name',candidate.full_name,
        'organizationName',candidate.organization_name,'phone',candidate.phone,
        'email',candidate.email
      )) order by candidate.full_name)
      from(
        select contact.* from sales_core.contacts contact
        where contact.tenant_id=v_tenant.id and contact.status='active'
          and not exists(
            select 1 from accounting_core.customer_accounts account
            where account.tenant_id=contact.tenant_id and account.contact_id=contact.id
          )
        order by contact.updated_at desc limit 200
      ) candidate
    ),'[]'::jsonb),
    'documents',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',document.id,'type',document.document_type,
        'number',document.document_number,'revisionNumber',document.revision_number,
        'status',document.status,'customerAccountId',document.customer_account_id,
        'customerName',document.customer_name_snapshot,'parentDocumentId',document.parent_document_id,
        'sourceType',document.source_type,'sourceId',document.source_id,
        'issueDate',document.issue_date,'validUntil',document.valid_until,'dueDate',document.due_date,
        'currency',document.currency,'subtotalMinor',document.subtotal_minor,
        'discountMinor',document.discount_minor,'taxMinor',document.tax_minor,
        'totalMinor',document.total_minor,'allocatedMinor',coalesce(document.allocated_minor,0),
        'outstandingMinor',case when document.document_type in ('invoice','debit_note')
          then greatest(document.total_minor-coalesce(document.allocated_minor,0),0) else 0 end,
        'paymentStatus',case
          when document.document_type not in ('invoice','debit_note') then null
          when document.total_minor<=coalesce(document.allocated_minor,0) then 'paid'
          when coalesce(document.allocated_minor,0)>0 then 'partially_paid'
          when document.status='issued' and document.due_date<current_date then 'overdue'
          else 'unpaid' end,
        'notes',document.notes,'terms',document.terms,
        'issuedAt',document.issued_at,'createdAt',document.created_at,
        'lines',document.lines
      )) order by document.created_at desc)
      from(
        select header.*,
          (select coalesce(sum(allocation.amount_minor),0)::bigint
           from accounting_core.payment_allocations allocation
           where allocation.tenant_id=header.tenant_id and allocation.invoice_id=header.id) allocated_minor,
          (select coalesce(jsonb_agg(jsonb_build_object(
            'id',line.id,'position',line.position,'itemType',line.item_type,
            'description',line.description,'quantity',line.quantity,
            'unitAmountMinor',line.unit_amount_minor,'subtotalMinor',line.subtotal_minor,
            'discountMinor',line.discount_minor,'taxCategory',line.tax_category,
            'taxRateBps',line.tax_rate_bps,'taxMinor',line.tax_minor,
            'totalMinor',line.total_minor
          ) order by line.position),'[]'::jsonb)
           from accounting_core.sales_document_lines line
           where line.tenant_id=header.tenant_id and line.document_id=header.id) lines
        from accounting_core.sales_documents header
        where header.tenant_id=v_tenant.id
        order by header.created_at desc limit 500
      ) document
    ),'[]'::jsonb),
    'payments',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',payment.id,'number',payment.payment_number,
        'customerAccountId',payment.customer_account_id,
        'customerName',account.display_name,'amountMinor',payment.amount_minor,
        'allocatedMinor',coalesce(allocation.amount,0),
        'unallocatedMinor',greatest(payment.amount_minor-coalesce(allocation.amount,0)-coalesce(refund.amount,0),0),
        'currency',payment.currency,'method',payment.method,'status',payment.status,
        'externalReference',payment.external_reference,'sourceType',payment.source_type,
        'sourceId',payment.source_id,'receivedAt',payment.received_at,
        'verifiedAt',payment.verified_at,'rejectionReason',payment.rejection_reason,
        'receipt',case when receipt.id is null then null else jsonb_build_object(
          'id',receipt.id,'number',receipt.receipt_number,'issuedAt',receipt.issued_at
        ) end
      )) order by payment.received_at desc)
      from accounting_core.payments payment
      join accounting_core.customer_accounts account
        on account.tenant_id=payment.tenant_id and account.id=payment.customer_account_id
      left join lateral(
        select coalesce(sum(amount_minor),0)::bigint amount
        from accounting_core.payment_allocations
        where tenant_id=payment.tenant_id and payment_id=payment.id
      ) allocation on true
      left join lateral(
        select coalesce(sum(amount_minor),0)::bigint amount
        from accounting_core.refunds
        where tenant_id=payment.tenant_id and payment_id=payment.id and status='completed'
      ) refund on true
      left join accounting_core.receipts receipt
        on receipt.tenant_id=payment.tenant_id and receipt.payment_id=payment.id
      where payment.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'paymentSchedules',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',schedule.id,'invoiceId',schedule.invoice_id,
        'installmentNumber',schedule.installment_number,
        'dueDate',schedule.due_date,'amountMinor',schedule.amount_minor,
        'label',schedule.label
      ) order by schedule.due_date,schedule.installment_number)
      from accounting_core.payment_schedules schedule
      where schedule.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'collections',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',action.id,'customerAccountId',action.customer_account_id,
        'invoiceId',action.invoice_id,'type',action.action_type,
        'summary',action.summary,'promisedDate',action.promised_date,
        'promisedAmountMinor',action.promised_amount_minor,
        'nextActionAt',action.next_action_at,'createdAt',action.created_at
      )) order by action.created_at desc)
      from(
        select * from accounting_core.collection_actions
        where tenant_id=v_tenant.id order by created_at desc limit 200
      ) action
    ),'[]'::jsonb),
    'refunds',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',refund.id,'customerAccountId',refund.customer_account_id,
        'paymentId',refund.payment_id,'invoiceId',refund.invoice_id,
        'creditNoteId',refund.credit_note_id,'amountMinor',refund.amount_minor,
        'reason',refund.reason,'status',refund.status,
        'externalReference',refund.external_reference,
        'approvedAt',refund.approved_at,'completedAt',refund.completed_at,
        'createdAt',refund.created_at
      )) order by refund.created_at desc)
      from accounting_core.refunds refund where refund.tenant_id=v_tenant.id
    ),'[]'::jsonb),
    'incentives',(
      select jsonb_build_object(
        'source','incentives_core.events','currency','SAR','sourceAmountUnit','major',
        'expectedMinor',coalesce(round(sum(incentive_amount) filter(where state='expected')*100),0)::bigint,
        'pendingMinor',coalesce(round(sum(incentive_amount) filter(where state='pending')*100),0)::bigint,
        'dueMinor',coalesce(round(sum(incentive_amount) filter(where state='due')*100),0)::bigint,
        'approvedMinor',coalesce(round(sum(incentive_amount) filter(where state='approved')*100),0)::bigint,
        'paidMinor',coalesce(round(sum(incentive_amount) filter(where state='paid')*100),0)::bigint,
        'refundedMinor',coalesce(round(sum(incentive_amount) filter(where state='refunded')*100),0)::bigint,
        'counts',jsonb_build_object(
          'expected',count(*) filter(where state='expected'),
          'pending',count(*) filter(where state='pending'),
          'due',count(*) filter(where state='due'),
          'approved',count(*) filter(where state='approved'),
          'paid',count(*) filter(where state='paid')
        )
      ) from incentives_core.events where tenant_id=v_tenant.id
    ),
    'admissionPaymentInbox',coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',handoff.id,'contactId',handoff.contact_id,
        'amountMinor',handoff.payment_amount_minor,
        'reference',handoff.payment_reference,'status',handoff.payment_status,
        'reportedAt',handoff.payment_reported_at,
        'verifiedAt',handoff.payment_verified_at,
        'canImport',handoff.payment_status='verified'
          and handoff.payment_verified_at is not null
          and handoff.payment_amount_minor>0
      )) order by handoff.payment_reported_at desc)
      from(
        select item.* from academy.registration_handoffs item
        where item.tenant_id=v_tenant.id
          and item.payment_status in ('pending_verification','verified')
          and not exists(
            select 1 from accounting_core.payments payment
            where payment.tenant_id=item.tenant_id
              and payment.source_type='registration_handoff'
              and payment.source_id=item.id::text
          )
        order by item.payment_reported_at desc limit 100
      ) handoff
    ),'[]'::jsonb)
  );
end;
$$;

-------------------------------------------------------------------------------
-- 5. Single idempotent action boundary
-------------------------------------------------------------------------------

create or replace function public.v1_tenant_accounting_action(
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
  v_required_permission text;
  v_command_id uuid;
  v_request_hash text:=md5(coalesce(p_payload,'{}'::jsonb)::text);
  v_existing accounting_core.commands%rowtype;
  v_result jsonb;
  v_account accounting_core.customer_accounts%rowtype;
  v_document accounting_core.sales_documents%rowtype;
  v_parent accounting_core.sales_documents%rowtype;
  v_payment accounting_core.payments%rowtype;
  v_refund accounting_core.refunds%rowtype;
  v_receipt accounting_core.receipts%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_profile accounting_core.tenant_profiles%rowtype;
  v_id uuid;
  v_document_type text;
  v_target_status text;
  v_line jsonb;
  v_lines jsonb;
  v_position integer:=0;
  v_quantity numeric(12,3);
  v_unit bigint;
  v_subtotal bigint;
  v_discount bigint;
  v_tax_rate integer;
  v_tax bigint;
  v_total bigint;
  v_sum_subtotal bigint:=0;
  v_sum_discount bigint:=0;
  v_sum_tax bigint:=0;
  v_sum_total bigint:=0;
  v_amount bigint;
  v_allocated bigint;
  v_refunded bigint;
  v_prefix text;
  v_status text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if jsonb_typeof(coalesce(p_payload,'{}'::jsonb))<>'object' then
    raise exception 'accounting_payload_invalid';
  end if;
  select * into v_tenant from core.tenants
  where slug=p_slug and status in ('trial','active') limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;

  v_required_permission:=case p_action
    when 'create_customer_account' then 'tenant.accounting.customers.write'
    when 'update_customer_account' then 'tenant.accounting.customers.write'
    when 'create_document' then case when p_payload->>'documentType'='quote'
      then 'tenant.accounting.quotes.write' else 'tenant.accounting.invoices.write' end
    when 'update_document' then case when p_payload->>'documentType'='quote'
      then 'tenant.accounting.quotes.write' else 'tenant.accounting.invoices.write' end
    when 'issue_document' then 'tenant.accounting.read'
    when 'cancel_document' then 'tenant.accounting.read'
    when 'record_payment' then 'tenant.accounting.payments.record'
    when 'verify_payment' then 'tenant.accounting.payments.approve'
    when 'allocate_payment' then 'tenant.accounting.payments.approve'
    when 'issue_receipt' then 'tenant.accounting.payments.approve'
    when 'create_schedule' then 'tenant.accounting.invoices.write'
    when 'record_collection_action' then 'tenant.accounting.read'
    when 'request_refund' then 'tenant.accounting.refunds.request'
    when 'approve_refund' then 'tenant.accounting.refunds.approve'
    when 'reject_refund' then 'tenant.accounting.refunds.approve'
    when 'complete_refund' then 'tenant.accounting.refunds.approve'
    when 'save_settings' then 'tenant.accounting.settings.manage'
    when 'import_handoff_payment' then 'tenant.accounting.payments.approve'
    else null end;
  if v_required_permission is null then raise exception 'accounting_action_invalid'; end if;
  if not private_app.has_accounting_permission(v_tenant.id,v_required_permission) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_action in ('issue_document','cancel_document') then
    select document_type into v_document_type
    from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'documentId')::uuid;
    if v_document_type is null then raise exception 'document_not_found'; end if;
    if v_document_type='quote' and not private_app.has_accounting_permission(
      v_tenant.id,'tenant.accounting.quotes.write'
    ) then raise exception 'forbidden' using errcode='42501'; end if;
    if v_document_type<>'quote' and not private_app.has_accounting_permission(
      v_tenant.id,case when p_action='issue_document'
        then 'tenant.accounting.invoices.issue' else 'tenant.accounting.invoices.write' end
    ) then raise exception 'forbidden' using errcode='42501'; end if;
  end if;
  v_actor:=private_app.current_subject_id();
  begin v_command_id:=nullif(p_payload->>'commandId','')::uuid;
  exception when invalid_text_representation then raise exception 'command_id_invalid'; end;
  if v_command_id is not null then
    select * into v_existing from accounting_core.commands
    where tenant_id=v_tenant.id and command_id=v_command_id;
    if v_existing.command_id is not null then
      if v_existing.action<>p_action or v_existing.request_hash<>v_request_hash then
        raise exception 'command_id_reused_with_different_payload';
      end if;
      return v_existing.response;
    end if;
  end if;

  select * into v_profile from accounting_core.tenant_profiles
  where tenant_id=v_tenant.id;

  if p_action='save_settings' then
    insert into accounting_core.tenant_profiles(
      tenant_id,legal_name_ar,commercial_registration_number,vat_number,
      tax_registered,base_currency,timezone,default_payment_terms_days,
      default_tax_rate_bps,quote_prefix,invoice_prefix,credit_note_prefix,
      debit_note_prefix,receipt_prefix,auto_import_verified_admissions,
      created_by_subject_id,updated_by_subject_id
    ) values(
      v_tenant.id,nullif(btrim(p_payload->>'legalNameAr'),''),
      nullif(btrim(p_payload->>'commercialRegistrationNumber'),''),
      nullif(btrim(p_payload->>'vatNumber'),''),
      coalesce((p_payload->>'taxRegistered')::boolean,false),
      coalesce(nullif(upper(btrim(p_payload->>'baseCurrency')),''),'SAR'),
      coalesce(nullif(btrim(p_payload->>'timezone'),''),'Asia/Riyadh'),
      coalesce((p_payload->>'defaultPaymentTermsDays')::integer,0),
      coalesce((p_payload->>'defaultTaxRateBps')::integer,1500),
      coalesce(nullif(upper(btrim(p_payload->>'quotePrefix')),''),'Q'),
      coalesce(nullif(upper(btrim(p_payload->>'invoicePrefix')),''),'INV'),
      coalesce(nullif(upper(btrim(p_payload->>'creditNotePrefix')),''),'CN'),
      coalesce(nullif(upper(btrim(p_payload->>'debitNotePrefix')),''),'DN'),
      coalesce(nullif(upper(btrim(p_payload->>'receiptPrefix')),''),'REC'),
      coalesce((p_payload->>'autoImportVerifiedAdmissions')::boolean,false),
      v_actor,v_actor
    ) on conflict(tenant_id) do update set
      legal_name_ar=excluded.legal_name_ar,
      commercial_registration_number=excluded.commercial_registration_number,
      vat_number=excluded.vat_number,tax_registered=excluded.tax_registered,
      base_currency=excluded.base_currency,timezone=excluded.timezone,
      default_payment_terms_days=excluded.default_payment_terms_days,
      default_tax_rate_bps=excluded.default_tax_rate_bps,
      quote_prefix=excluded.quote_prefix,invoice_prefix=excluded.invoice_prefix,
      credit_note_prefix=excluded.credit_note_prefix,
      debit_note_prefix=excluded.debit_note_prefix,receipt_prefix=excluded.receipt_prefix,
      auto_import_verified_admissions=excluded.auto_import_verified_admissions,
      updated_by_subject_id=excluded.updated_by_subject_id,updated_at=now();
    v_result:=jsonb_build_object('success',true,'action',p_action);

  elsif p_action in ('create_customer_account','update_customer_account') then
    if p_action='create_customer_account' then
      if nullif(p_payload->>'contactId','') is not null then
        select * into v_contact from sales_core.contacts
        where tenant_id=v_tenant.id and id=(p_payload->>'contactId')::uuid;
        if v_contact.id is null then raise exception 'contact_not_found'; end if;
      end if;
      insert into accounting_core.customer_accounts(
        tenant_id,contact_id,account_number,display_name,organization_name,
        billing_email,billing_phone,tax_number,billing_address,
        payment_terms_days,credit_limit_minor,status,notes,
        created_by_subject_id,updated_by_subject_id
      ) values(
        v_tenant.id,v_contact.id,
        private_app.accounting_next_number(v_tenant.id,'customer',current_date,'CUS'),
        coalesce(nullif(btrim(p_payload->>'displayName'),''),v_contact.full_name),
        coalesce(nullif(btrim(p_payload->>'organizationName'),''),v_contact.organization_name),
        coalesce(nullif(btrim(p_payload->>'billingEmail'),''),v_contact.email),
        coalesce(nullif(btrim(p_payload->>'billingPhone'),''),v_contact.phone),
        nullif(btrim(p_payload->>'taxNumber'),''),nullif(btrim(p_payload->>'billingAddress'),''),
        coalesce((p_payload->>'paymentTermsDays')::integer,v_profile.default_payment_terms_days,0),
        (p_payload->>'creditLimitMinor')::bigint,'active',nullif(btrim(p_payload->>'notes'),''),
        v_actor,v_actor
      ) returning * into v_account;
    else
      update accounting_core.customer_accounts set
        display_name=coalesce(nullif(btrim(p_payload->>'displayName'),''),display_name),
        organization_name=case when p_payload?'organizationName' then nullif(btrim(p_payload->>'organizationName'),'') else organization_name end,
        billing_email=case when p_payload?'billingEmail' then nullif(btrim(p_payload->>'billingEmail'),'') else billing_email end,
        billing_phone=case when p_payload?'billingPhone' then nullif(btrim(p_payload->>'billingPhone'),'') else billing_phone end,
        tax_number=case when p_payload?'taxNumber' then nullif(btrim(p_payload->>'taxNumber'),'') else tax_number end,
        billing_address=case when p_payload?'billingAddress' then nullif(btrim(p_payload->>'billingAddress'),'') else billing_address end,
        payment_terms_days=coalesce((p_payload->>'paymentTermsDays')::integer,payment_terms_days),
        credit_limit_minor=case when p_payload?'creditLimitMinor' then (p_payload->>'creditLimitMinor')::bigint else credit_limit_minor end,
        status=coalesce(nullif(p_payload->>'status',''),status),
        notes=case when p_payload?'notes' then nullif(btrim(p_payload->>'notes'),'') else notes end,
        updated_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=(p_payload->>'accountId')::uuid
      returning * into v_account;
      if v_account.id is null then raise exception 'customer_account_not_found'; end if;
    end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,'accountId',v_account.id);

  elsif p_action in ('create_document','update_document') then
    v_document_type:=coalesce(nullif(p_payload->>'documentType',''),'invoice');
    if v_document_type not in ('quote','invoice','credit_note','debit_note') then
      raise exception 'document_type_invalid';
    end if;
    if jsonb_typeof(p_payload->'lines')<>'array' or jsonb_array_length(p_payload->'lines')=0
       or jsonb_array_length(p_payload->'lines')>100 then raise exception 'document_lines_required'; end if;
    select * into v_account from accounting_core.customer_accounts
    where tenant_id=v_tenant.id and id=(p_payload->>'customerAccountId')::uuid and status<>'closed';
    if v_account.id is null then raise exception 'customer_account_not_found'; end if;
    if p_action='update_document' then
      select * into v_document from accounting_core.sales_documents
      where tenant_id=v_tenant.id and id=(p_payload->>'documentId')::uuid and status='draft'
      for update;
      if v_document.id is null then raise exception 'document_not_editable'; end if;
      if v_document.document_type<>v_document_type then raise exception 'document_type_immutable'; end if;
      delete from accounting_core.sales_document_lines
      where tenant_id=v_tenant.id and document_id=v_document.id;
    else
      if nullif(p_payload->>'parentDocumentId','') is not null then
        select * into v_parent from accounting_core.sales_documents
        where tenant_id=v_tenant.id and id=(p_payload->>'parentDocumentId')::uuid;
        if v_parent.id is null then raise exception 'parent_document_not_found'; end if;
        if v_document_type='invoice' and (v_parent.document_type<>'quote' or v_parent.status<>'accepted') then
          raise exception 'quote_not_convertible';
        end if;
      end if;
      v_prefix:=case v_document_type
        when 'quote' then coalesce(v_profile.quote_prefix,'Q')
        when 'invoice' then coalesce(v_profile.invoice_prefix,'INV')
        when 'credit_note' then coalesce(v_profile.credit_note_prefix,'CN')
        else coalesce(v_profile.debit_note_prefix,'DN') end;
      insert into accounting_core.sales_documents(
        tenant_id,document_type,document_number,status,customer_account_id,
        contact_id,parent_document_id,source_type,source_id,issue_date,
        valid_until,due_date,currency,customer_name_snapshot,
        customer_tax_number_snapshot,customer_email_snapshot,
        customer_phone_snapshot,customer_address_snapshot,notes,terms,
        metadata,created_by_subject_id,updated_by_subject_id
      ) values(
        v_tenant.id,v_document_type,
        private_app.accounting_next_number(v_tenant.id,v_document_type,
          coalesce((p_payload->>'issueDate')::date,current_date),v_prefix),
        'draft',v_account.id,v_account.contact_id,v_parent.id,
        nullif(p_payload->>'sourceType',''),nullif(p_payload->>'sourceId',''),
        coalesce((p_payload->>'issueDate')::date,current_date),
        (p_payload->>'validUntil')::date,
        coalesce((p_payload->>'dueDate')::date,
          case when v_document_type in ('invoice','debit_note') then current_date+v_account.payment_terms_days else null end),
        coalesce(nullif(upper(p_payload->>'currency'),''),v_profile.base_currency,'SAR'),
        v_account.display_name,v_account.tax_number,v_account.billing_email,
        v_account.billing_phone,v_account.billing_address,
        nullif(btrim(p_payload->>'notes'),''),nullif(btrim(p_payload->>'terms'),''),
        coalesce(p_payload->'metadata','{}'::jsonb),v_actor,v_actor
      ) returning * into v_document;
    end if;
    v_lines:=p_payload->'lines';
    v_position:=0;v_sum_subtotal:=0;v_sum_discount:=0;v_sum_tax:=0;v_sum_total:=0;
    for v_line in select value from jsonb_array_elements(v_lines) loop
      v_position:=v_position+1;
      v_quantity:=coalesce((v_line->>'quantity')::numeric,1);
      v_unit:=coalesce((v_line->>'unitAmountMinor')::bigint,0);
      v_subtotal:=round(v_quantity*v_unit)::bigint;
      v_discount:=coalesce((v_line->>'discountMinor')::bigint,0);
      v_tax_rate:=case when coalesce(v_line->>'taxCategory','standard')='standard'
        then coalesce((v_line->>'taxRateBps')::integer,v_profile.default_tax_rate_bps,1500) else 0 end;
      if v_quantity<=0 or v_unit<0 or v_discount<0 or v_discount>v_subtotal then
        raise exception 'document_line_invalid';
      end if;
      v_tax:=case when coalesce(v_line->>'taxCategory','standard')='standard'
        then round((v_subtotal-v_discount)::numeric*v_tax_rate/10000)::bigint else 0 end;
      v_total:=v_subtotal-v_discount+v_tax;
      insert into accounting_core.sales_document_lines(
        tenant_id,document_id,position,item_type,source_id,description,
        quantity,unit_amount_minor,subtotal_minor,discount_minor,
        tax_category,tax_rate_bps,tax_minor,total_minor,metadata
      ) values(
        v_tenant.id,v_document.id,v_position,
        coalesce(nullif(v_line->>'itemType',''),'service'),
        nullif(v_line->>'sourceId',''),
        btrim(v_line->>'description'),v_quantity,v_unit,v_subtotal,v_discount,
        coalesce(nullif(v_line->>'taxCategory',''),'standard'),v_tax_rate,v_tax,v_total,
        coalesce(v_line->'metadata','{}'::jsonb)
      );
      v_sum_subtotal:=v_sum_subtotal+v_subtotal;
      v_sum_discount:=v_sum_discount+v_discount;
      v_sum_tax:=v_sum_tax+v_tax;
      v_sum_total:=v_sum_total+v_total;
    end loop;
    update accounting_core.sales_documents set
      customer_account_id=v_account.id,contact_id=v_account.contact_id,
      issue_date=coalesce((p_payload->>'issueDate')::date,issue_date),
      valid_until=(p_payload->>'validUntil')::date,
      due_date=coalesce((p_payload->>'dueDate')::date,due_date),
      customer_name_snapshot=v_account.display_name,
      customer_tax_number_snapshot=v_account.tax_number,
      customer_email_snapshot=v_account.billing_email,
      customer_phone_snapshot=v_account.billing_phone,
      customer_address_snapshot=v_account.billing_address,
      subtotal_minor=v_sum_subtotal,discount_minor=v_sum_discount,
      tax_minor=v_sum_tax,total_minor=v_sum_total,
      notes=nullif(btrim(p_payload->>'notes'),''),
      terms=nullif(btrim(p_payload->>'terms'),''),
      updated_by_subject_id=v_actor,updated_at=now()
    where tenant_id=v_tenant.id and id=v_document.id returning * into v_document;
    if v_parent.id is not null and v_document_type='invoice' then
      update accounting_core.sales_documents set status='converted',updated_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=v_parent.id;
    end if;
    insert into accounting_core.document_events(
      tenant_id,document_id,event_type,to_status,actor_subject_id,details
    ) values(v_tenant.id,v_document.id,p_action,'draft',v_actor,jsonb_build_object('totalMinor',v_document.total_minor));
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'documentId',v_document.id,'documentNumber',v_document.document_number,
      'totalMinor',v_document.total_minor);

  elsif p_action in ('issue_document','cancel_document') then
    select * into v_document from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'documentId')::uuid
    for update;
    if v_document.id is null then raise exception 'document_not_found'; end if;
    v_status:=v_document.status;
    if p_action='cancel_document' then
      if v_document.status not in ('draft','sent') then raise exception 'issued_document_requires_adjustment'; end if;
      v_target_status:='cancelled';
    elsif v_document.document_type='quote' then
      v_target_status:=coalesce(nullif(p_payload->>'status',''),'sent');
      if not ((v_document.status='draft' and v_target_status in ('sent','cancelled'))
        or (v_document.status='sent' and v_target_status in ('accepted','rejected','expired','cancelled'))) then
        raise exception 'invalid_document_transition';
      end if;
    else
      if v_document.status<>'draft' then raise exception 'invalid_document_transition'; end if;
      v_target_status:='issued';
    end if;
    update accounting_core.sales_documents set
      status=v_target_status,issued_at=case when v_target_status='issued' then now() else issued_at end,
      issued_by_subject_id=case when v_target_status='issued' then v_actor else issued_by_subject_id end,
      updated_by_subject_id=v_actor,updated_at=now()
    where tenant_id=v_tenant.id and id=v_document.id returning * into v_document;
    insert into accounting_core.document_events(
      tenant_id,document_id,event_type,from_status,to_status,actor_subject_id
    ) values(v_tenant.id,v_document.id,p_action,v_status,v_target_status,v_actor);
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'documentId',v_document.id,'status',v_target_status);

  elsif p_action in ('record_payment','import_handoff_payment') then
    if p_action='import_handoff_payment' then
      select handoff.contact_id,handoff.payment_amount_minor,handoff.payment_reference
        into v_id,v_amount,v_prefix
      from academy.registration_handoffs handoff
      where handoff.tenant_id=v_tenant.id
        and handoff.id=(p_payload->>'handoffId')::uuid
        and handoff.payment_status='verified'
        and handoff.payment_verified_at is not null
        and handoff.payment_amount_minor>0;
      if v_id is null then raise exception 'verified_handoff_not_found'; end if;
      select * into v_account from accounting_core.customer_accounts
      where tenant_id=v_tenant.id and contact_id=v_id;
      if v_account.id is null then
        select * into v_contact from sales_core.contacts where tenant_id=v_tenant.id and id=v_id;
        insert into accounting_core.customer_accounts(
          tenant_id,contact_id,account_number,display_name,organization_name,
          billing_email,billing_phone,payment_terms_days,created_by_subject_id,updated_by_subject_id
        ) values(
          v_tenant.id,v_contact.id,
          private_app.accounting_next_number(v_tenant.id,'customer',current_date,'CUS'),
          v_contact.full_name,v_contact.organization_name,v_contact.email,v_contact.phone,
          coalesce(v_profile.default_payment_terms_days,0),v_actor,v_actor
        ) returning * into v_account;
      end if;
      if exists(select 1 from accounting_core.payments where tenant_id=v_tenant.id
        and source_type='registration_handoff' and source_id=p_payload->>'handoffId') then
        raise exception 'payment_source_already_imported';
      end if;
      insert into accounting_core.payments(
        tenant_id,customer_account_id,payment_number,amount_minor,currency,method,
        status,external_reference,source_type,source_id,received_at,verified_at,
        verified_by_subject_id,created_by_subject_id
      ) values(
        v_tenant.id,v_account.id,
        private_app.accounting_next_number(v_tenant.id,'payment',current_date,'PAY'),
        v_amount,coalesce(v_profile.base_currency,'SAR'),'bank_transfer','verified',v_prefix,
        'registration_handoff',p_payload->>'handoffId',now(),now(),v_actor,v_actor
      ) returning * into v_payment;
    else
      select * into v_account from accounting_core.customer_accounts
      where tenant_id=v_tenant.id and id=(p_payload->>'customerAccountId')::uuid;
      if v_account.id is null then raise exception 'customer_account_not_found'; end if;
      v_amount:=(p_payload->>'amountMinor')::bigint;
      if v_amount<=0 then raise exception 'payment_amount_invalid'; end if;
      v_status:=case when coalesce((p_payload->>'verifyNow')::boolean,false)
        and private_app.has_accounting_permission(v_tenant.id,'tenant.accounting.payments.approve')
        then 'verified' else 'pending_verification' end;
      insert into accounting_core.payments(
        tenant_id,customer_account_id,payment_number,amount_minor,currency,method,
        status,external_reference,source_type,source_id,received_at,verified_at,
        verified_by_subject_id,notes,metadata,created_by_subject_id
      ) values(
        v_tenant.id,v_account.id,
        private_app.accounting_next_number(v_tenant.id,'payment',
          coalesce((p_payload->>'receivedAt')::timestamptz::date,current_date),'PAY'),
        v_amount,coalesce(nullif(upper(p_payload->>'currency'),''),v_profile.base_currency,'SAR'),
        coalesce(nullif(p_payload->>'method',''),'bank_transfer'),v_status,
        nullif(btrim(p_payload->>'externalReference'),''),
        nullif(p_payload->>'sourceType',''),nullif(p_payload->>'sourceId',''),
        coalesce((p_payload->>'receivedAt')::timestamptz,now()),
        case when v_status='verified' then now() end,
        case when v_status='verified' then v_actor end,
        nullif(btrim(p_payload->>'notes'),''),coalesce(p_payload->'metadata','{}'::jsonb),v_actor
      ) returning * into v_payment;
    end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'paymentId',v_payment.id,'paymentNumber',v_payment.payment_number,'status',v_payment.status);

  elsif p_action='verify_payment' then
    update accounting_core.payments set status='verified',verified_at=now(),
      verified_by_subject_id=v_actor,rejection_reason=null,updated_at=now()
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid
      and status='pending_verification' returning * into v_payment;
    if v_payment.id is null then raise exception 'payment_not_verifiable'; end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,'paymentId',v_payment.id,'status','verified');

  elsif p_action='allocate_payment' then
    select * into v_payment from accounting_core.payments
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid and status='verified'
    for update;
    select * into v_document from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'invoiceId')::uuid
      and status='issued' and document_type in ('invoice','debit_note')
    for update;
    if v_payment.id is null or v_document.id is null then raise exception 'allocation_target_invalid'; end if;
    if v_payment.customer_account_id<>v_document.customer_account_id then raise exception 'allocation_customer_mismatch'; end if;
    v_amount:=(p_payload->>'amountMinor')::bigint;
    select coalesce(sum(amount_minor),0)::bigint into v_allocated
    from accounting_core.payment_allocations where tenant_id=v_tenant.id and payment_id=v_payment.id;
    if v_amount<=0 or v_allocated+v_amount>v_payment.amount_minor then raise exception 'payment_allocation_exceeds_available'; end if;
    select coalesce(sum(amount_minor),0)::bigint into v_allocated
    from accounting_core.payment_allocations where tenant_id=v_tenant.id and invoice_id=v_document.id;
    if v_allocated+v_amount>v_document.total_minor then raise exception 'payment_allocation_exceeds_invoice'; end if;
    insert into accounting_core.payment_allocations(
      tenant_id,payment_id,invoice_id,amount_minor,created_by_subject_id
    ) values(v_tenant.id,v_payment.id,v_document.id,v_amount,v_actor)
    on conflict(tenant_id,payment_id,invoice_id) do update
    set amount_minor=accounting_core.payment_allocations.amount_minor+excluded.amount_minor;
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'paymentId',v_payment.id,'invoiceId',v_document.id,'allocatedMinor',v_amount);

  elsif p_action='issue_receipt' then
    select * into v_payment from accounting_core.payments
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid and status in ('verified','refunded');
    if v_payment.id is null then raise exception 'payment_not_receiptable'; end if;
    insert into accounting_core.receipts(
      tenant_id,payment_id,receipt_number,issued_by_subject_id
    ) values(
      v_tenant.id,v_payment.id,
      private_app.accounting_next_number(v_tenant.id,'receipt',current_date,coalesce(v_profile.receipt_prefix,'REC')),
      v_actor
    ) on conflict(tenant_id,payment_id) do update set payment_id=excluded.payment_id
    returning * into v_receipt;
    v_result:=jsonb_build_object('success',true,'action',p_action,
      'receiptId',v_receipt.id,'receiptNumber',v_receipt.receipt_number);

  elsif p_action='create_schedule' then
    select * into v_document from accounting_core.sales_documents
    where tenant_id=v_tenant.id and id=(p_payload->>'invoiceId')::uuid
      and status='draft' and document_type in ('invoice','debit_note')
    for update;
    if v_document.id is null then raise exception 'schedule_invoice_not_editable'; end if;
    v_amount:=(p_payload->>'amountMinor')::bigint;
    select coalesce(sum(amount_minor),0)::bigint into v_allocated
    from accounting_core.payment_schedules where tenant_id=v_tenant.id and invoice_id=v_document.id;
    if v_amount<=0 or v_allocated+v_amount>v_document.total_minor then raise exception 'schedule_exceeds_invoice'; end if;
    insert into accounting_core.payment_schedules(
      tenant_id,invoice_id,installment_number,due_date,amount_minor,label,created_by_subject_id
    ) values(
      v_tenant.id,v_document.id,(p_payload->>'installmentNumber')::integer,
      (p_payload->>'dueDate')::date,v_amount,nullif(btrim(p_payload->>'label'),''),v_actor
    ) returning id into v_id;
    v_result:=jsonb_build_object('success',true,'action',p_action,'scheduleId',v_id);

  elsif p_action='record_collection_action' then
    if nullif(p_payload->>'invoiceId','') is not null and not exists(
      select 1 from accounting_core.sales_documents document
      where document.tenant_id=v_tenant.id
        and document.id=(p_payload->>'invoiceId')::uuid
        and document.customer_account_id=(p_payload->>'customerAccountId')::uuid
    ) then raise exception 'collection_invoice_customer_mismatch'; end if;
    insert into accounting_core.collection_actions(
      tenant_id,customer_account_id,invoice_id,action_type,summary,
      promised_date,promised_amount_minor,next_action_at,created_by_subject_id
    ) values(
      v_tenant.id,(p_payload->>'customerAccountId')::uuid,
      nullif(p_payload->>'invoiceId','')::uuid,coalesce(nullif(p_payload->>'type',''),'note'),
      btrim(p_payload->>'summary'),nullif(p_payload->>'promisedDate','')::date,
      (p_payload->>'promisedAmountMinor')::bigint,
      (p_payload->>'nextActionAt')::timestamptz,v_actor
    ) returning id into v_id;
    v_result:=jsonb_build_object('success',true,'action',p_action,'collectionActionId',v_id);

  elsif p_action='request_refund' then
    select * into v_payment from accounting_core.payments
    where tenant_id=v_tenant.id and id=(p_payload->>'paymentId')::uuid and status in ('verified','refunded')
    for update;
    if v_payment.id is null then raise exception 'payment_not_refundable'; end if;
    v_amount:=(p_payload->>'amountMinor')::bigint;
    select coalesce(sum(amount_minor),0)::bigint into v_refunded
    from accounting_core.refunds where tenant_id=v_tenant.id and payment_id=v_payment.id
      and status in ('requested','approved','completed');
    if v_amount<=0 or v_refunded+v_amount>v_payment.amount_minor then raise exception 'refund_exceeds_payment'; end if;
    if nullif(p_payload->>'invoiceId','') is not null and not exists(
      select 1 from accounting_core.sales_documents document
      where document.tenant_id=v_tenant.id
        and document.id=(p_payload->>'invoiceId')::uuid
        and document.customer_account_id=v_payment.customer_account_id
        and document.document_type='invoice'
    ) then raise exception 'refund_invoice_customer_mismatch'; end if;
    if nullif(p_payload->>'creditNoteId','') is not null and not exists(
      select 1 from accounting_core.sales_documents document
      where document.tenant_id=v_tenant.id
        and document.id=(p_payload->>'creditNoteId')::uuid
        and document.customer_account_id=v_payment.customer_account_id
        and document.document_type='credit_note' and document.status='issued'
    ) then raise exception 'refund_credit_note_invalid'; end if;
    insert into accounting_core.refunds(
      tenant_id,customer_account_id,payment_id,invoice_id,credit_note_id,
      amount_minor,reason,status,requested_by_subject_id
    ) values(
      v_tenant.id,v_payment.customer_account_id,v_payment.id,
      nullif(p_payload->>'invoiceId','')::uuid,nullif(p_payload->>'creditNoteId','')::uuid,
      v_amount,btrim(p_payload->>'reason'),'requested',v_actor
    ) returning * into v_refund;
    v_result:=jsonb_build_object('success',true,'action',p_action,'refundId',v_refund.id,'status',v_refund.status);

  elsif p_action in ('approve_refund','reject_refund','complete_refund') then
    select * into v_refund from accounting_core.refunds
    where tenant_id=v_tenant.id and id=(p_payload->>'refundId')::uuid for update;
    if v_refund.id is null then raise exception 'refund_not_found'; end if;
    if p_action='approve_refund' then
      if v_refund.status<>'requested' then raise exception 'refund_transition_invalid'; end if;
      v_target_status:='approved';
      update accounting_core.refunds set status='approved',approved_at=now(),approved_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=v_refund.id;
    elsif p_action='reject_refund' then
      if v_refund.status not in ('requested','approved') then raise exception 'refund_transition_invalid'; end if;
      v_target_status:='rejected';
      update accounting_core.refunds set status='rejected',approved_at=now(),approved_by_subject_id=v_actor,updated_at=now()
      where tenant_id=v_tenant.id and id=v_refund.id;
    else
      if v_refund.status<>'approved' then raise exception 'refund_transition_invalid'; end if;
      v_target_status:='completed';
      update accounting_core.refunds set status='completed',completed_at=now(),completed_by_subject_id=v_actor,
        external_reference=nullif(btrim(p_payload->>'externalReference'),''),updated_at=now()
      where tenant_id=v_tenant.id and id=v_refund.id;
      select coalesce(sum(amount_minor),0)::bigint into v_refunded
      from accounting_core.refunds where tenant_id=v_tenant.id and payment_id=v_refund.payment_id and status='completed';
      if v_refunded>=(select amount_minor from accounting_core.payments where tenant_id=v_tenant.id and id=v_refund.payment_id) then
        update accounting_core.payments set status='refunded',updated_at=now()
        where tenant_id=v_tenant.id and id=v_refund.payment_id;
      end if;
    end if;
    v_result:=jsonb_build_object('success',true,'action',p_action,'refundId',v_refund.id,'status',v_target_status);
  end if;

  perform private_app.write_audit(
    'accounting.'||p_action,'tenant_accounting',
    coalesce(v_result->>'documentId',v_result->>'paymentId',v_result->>'refundId',v_result->>'accountId'),
    v_tenant.id,jsonb_build_object('commandId',v_command_id,'result',v_result)
  );
  if v_command_id is not null then
    insert into accounting_core.commands(
      tenant_id,command_id,action,request_hash,response,actor_subject_id
    ) values(v_tenant.id,v_command_id,p_action,v_request_hash,v_result,v_actor);
  end if;
  return v_result;
end;
$$;

revoke all on function public.v1_tenant_accounting_snapshot(text,date,date)
from public,anon;
revoke all on function public.v1_tenant_accounting_action(text,text,jsonb)
from public,anon;
grant execute on function public.v1_tenant_accounting_snapshot(text,date,date)
to authenticated;
grant execute on function public.v1_tenant_accounting_action(text,text,jsonb)
to authenticated;

comment on function public.v1_tenant_accounting_snapshot(text,date,date) is
  'Operational receivables snapshot; base accounting works without the ZATCA add-on.';
comment on function public.v1_tenant_accounting_action(text,text,jsonb) is
  'Permission-gated and optionally idempotent accounting mutation boundary.';

notify pgrst,'reload schema';

commit;
