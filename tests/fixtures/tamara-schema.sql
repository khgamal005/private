-- Minimal local fixture copied from the read-only live column/constraint contract.
-- No production rows or credentials. Permission and Vault are deterministic stubs.
create schema core; create schema catalog; create schema marketplace; create schema private_app; create schema audit_log; create schema auth; create schema vault;
create role anon; create role authenticated; create role service_role;
create sequence marketplace.order_number_seq;
create table catalog.features (
id uuid default gen_random_uuid() not null,
feature_key text not null,
name_ar text not null,
name_en text,
category text default 'module'::text not null,
value_type text default 'boolean'::text not null,
default_value jsonb default 'false'::jsonb not null,
status text default 'active'::text not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null
);
alter table catalog.features add primary key(id);
create table audit_log.events (
id uuid default gen_random_uuid() not null,
tenant_id uuid,
actor_subject_id uuid,
action text not null,
resource_type text not null,
resource_id text,
context jsonb default '{}'::jsonb not null,
occurred_at timestamp with time zone default now() not null
);
alter table audit_log.events add primary key(id);
create table core.tenants (
id uuid default gen_random_uuid() not null,
organization_id uuid not null,
tenant_key text not null,
slug text not null,
name text not null,
legal_name text,
status text default 'trial'::text not null,
country_code text default 'SA'::text not null,
timezone text default 'Asia/Riyadh'::text not null,
default_locale text default 'ar-SA'::text not null,
settings jsonb default '{}'::jsonb not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null
);
alter table core.tenants add primary key(id);
create table core.modules (
id uuid default gen_random_uuid() not null,
module_key text not null,
name_ar text not null,
name_en text,
description text,
enabled_by_default boolean default false not null,
status text default 'active'::text not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null
);
alter table core.modules add primary key(id);
create table core.tenant_modules (
tenant_id uuid not null,
module_id uuid not null,
enabled boolean default true not null,
configuration jsonb default '{}'::jsonb not null,
enabled_at timestamp with time zone,
updated_at timestamp with time zone default now() not null,
constraint tenant_modules_pkey PRIMARY KEY (tenant_id, module_id)
);
create table marketplace.orders (
id uuid default gen_random_uuid() not null,
order_number text default ((('ODR-'::text || to_char((CURRENT_DATE)::timestamp with time zone, 'YYMM'::text)) || '-'::text) || lpad((nextval('marketplace.order_number_seq'::regclass))::text, 6, '0'::text)) not null,
tenant_id uuid not null,
requested_by_subject_id uuid,
order_kind text not null,
status text default 'pending_payment'::text not null,
payment_status text default 'pending'::text not null,
activation_state text default 'not_applicable'::text not null,
currency text default 'SAR'::text not null,
subtotal_minor bigint not null,
tax_minor bigint default 0 not null,
total_minor bigint not null,
tax_rate_bps integer default 1500 not null,
notes text,
payment_provider text,
payment_reference text,
paid_at timestamp with time zone,
idempotency_key text not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
list_subtotal_minor bigint not null,
discount_minor bigint default 0 not null,
promotion_id uuid,
promotion_code text,
constraint orders_activation_state_check CHECK ((activation_state = ANY (ARRAY['not_applicable'::text, 'pending'::text, 'active'::text, 'failed'::text, 'cancelled'::text]))),
constraint orders_check CHECK ((total_minor = (subtotal_minor + tax_minor))),
constraint orders_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
constraint orders_order_kind_check CHECK ((order_kind = ANY (ARRAY['service'::text, 'addon'::text]))),
constraint orders_order_number_key UNIQUE (order_number),
constraint orders_payment_status_check CHECK ((payment_status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'refunded'::text, 'waived'::text]))),
constraint orders_pkey PRIMARY KEY (id),
constraint orders_promotion_pricing_integrity_v1 CHECK (((list_subtotal_minor >= subtotal_minor) AND (discount_minor = (list_subtotal_minor - subtotal_minor)) AND (((promotion_id IS NULL) AND (promotion_code IS NULL) AND (discount_minor = 0)) OR ((promotion_id IS NOT NULL) AND (promotion_code IS NOT NULL) AND (discount_minor > 0))))),
constraint orders_status_check CHECK ((status = ANY (ARRAY['pending_payment'::text, 'paid'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text]))),
constraint orders_subtotal_minor_check CHECK ((subtotal_minor >= 0)),
constraint orders_tax_minor_check CHECK ((tax_minor >= 0)),
constraint orders_tax_rate_bps_check CHECK (((tax_rate_bps >= 0) AND (tax_rate_bps <= 10000))),
constraint orders_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key),
constraint orders_total_minor_check CHECK ((total_minor >= 0))
);
create table marketplace.order_items (
id uuid default gen_random_uuid() not null,
order_id uuid not null,
item_type text not null,
service_product_id uuid,
addon_product_id uuid,
product_key text not null,
product_name_ar text not null,
quantity integer default 1 not null,
unit_amount_minor bigint not null,
line_total_minor bigint not null,
metadata jsonb default '{}'::jsonb not null,
created_at timestamp with time zone default now() not null,
service_package_id uuid
);
alter table marketplace.order_items add primary key(id);
create table marketplace.order_events (
id uuid default gen_random_uuid() not null,
order_id uuid not null,
tenant_id uuid not null,
actor_subject_id uuid,
event_type text not null,
from_status text,
to_status text,
metadata jsonb default '{}'::jsonb not null,
created_at timestamp with time zone default now() not null,
constraint order_events_pkey PRIMARY KEY (id)
);
create table marketplace.payment_events (
id uuid default gen_random_uuid() not null,
order_id uuid not null,
provider_key text not null,
provider_event_id text not null,
payment_reference text,
state text not null,
amount_minor bigint not null,
currency text not null,
signature_verified boolean default false not null,
payload_sha256 text,
processed_at timestamp with time zone default now() not null,
constraint payment_events_amount_minor_check CHECK ((amount_minor >= 0)),
constraint payment_events_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
constraint payment_events_pkey PRIMARY KEY (id),
constraint payment_events_provider_key_provider_event_id_key UNIQUE (provider_key, provider_event_id),
constraint payment_events_state_check CHECK ((state = ANY (ARRAY['paid'::text, 'failed'::text, 'refunded'::text])))
);
create table catalog.addon_products (
id uuid default gen_random_uuid() not null,
product_key text not null,
feature_id uuid not null,
name_ar text not null,
name_en text,
description_ar text,
pricing_mode text default 'contact_sales'::text not null,
amount_minor bigint default 0 not null,
currency text default 'SAR'::text not null,
interval text default 'month'::text not null,
trial_days integer default 14 not null,
usage_metric text not null,
default_limit bigint,
status text default 'beta'::text not null,
sort_order integer default 100 not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
marketplace_category text default 'integrations'::text not null,
badge_ar text,
activation_mode text default 'entitlement'::text not null,
category_id uuid,
is_marketplace_visible boolean default true not null
);
alter table catalog.addon_products add primary key(id);
create table catalog.tenant_addon_subscriptions (
id uuid default gen_random_uuid() not null,
tenant_id uuid not null,
product_id uuid not null,
status text default 'pending'::text not null,
source text default 'tenant_request'::text not null,
custom_limit bigint,
usage_alert_percent integer default 80 not null,
trial_start timestamp with time zone,
trial_end timestamp with time zone,
period_start timestamp with time zone,
period_end timestamp with time zone,
requested_note text,
decision_note text,
cancel_at_period_end boolean default false not null,
requested_by_subject_id uuid,
decided_by_subject_id uuid,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
price_version_id uuid,
payment_provider_key text,
marketplace_order_id uuid,
external_subscription_ref text,
auto_renew boolean default false not null,
activated_at timestamp with time zone,
ended_at timestamp with time zone,
period_is_authoritative boolean default false not null,
lifecycle_protected_until timestamp with time zone,
constraint tenant_addon_subscriptions_custom_limit_check CHECK (((custom_limit IS NULL) OR (custom_limit >= 0))),
constraint tenant_addon_subscriptions_pkey PRIMARY KEY (id),
constraint tenant_addon_subscriptions_source_check CHECK ((source = ANY (ARRAY['tenant_request'::text, 'platform'::text, 'billing'::text, 'migration'::text]))),
constraint tenant_addon_subscriptions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'trialing'::text, 'active'::text, 'paused'::text, 'cancelled'::text, 'expired'::text]))),
constraint tenant_addon_subscriptions_usage_alert_percent_check CHECK (((usage_alert_percent >= 10) AND (usage_alert_percent <= 100))),
constraint tenant_addons_ended_after_activation_check_v3 CHECK (((ended_at IS NULL) OR (activated_at IS NULL) OR (ended_at >= activated_at))),
constraint tenant_addons_period_order_check_v3 CHECK (((period_end IS NULL) OR (period_start IS NULL) OR (period_end > period_start))),
constraint tenant_addons_protection_window_check_v3 CHECK (((lifecycle_protected_until IS NULL) OR ((period_end IS NOT NULL) AND (lifecycle_protected_until <= period_end))))
);
create table catalog.tenant_addon_subscription_events (
id uuid default gen_random_uuid() not null,
subscription_id uuid not null,
tenant_id uuid not null,
product_id uuid not null,
event_key text not null,
event_type text not null,
from_status text,
to_status text,
effective_at timestamp with time zone default now() not null,
actor_subject_id uuid,
metadata jsonb default '{}'::jsonb not null,
created_at timestamp with time zone default now() not null,
constraint tenant_addon_subscription_eve_tenant_id_product_id_event_ke_key UNIQUE (tenant_id, product_id, event_key),
constraint tenant_addon_subscription_events_event_type_check CHECK ((event_type = ANY (ARRAY['requested'::text, 'trial_started'::text, 'activated'::text, 'renewed'::text, 'paused'::text, 'resumed'::text, 'cancel_scheduled'::text, 'cancelled'::text, 'expired'::text, 'payment_linked'::text, 'migration_grant'::text]))),
constraint tenant_addon_subscription_events_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
constraint tenant_addon_subscription_events_pkey PRIMARY KEY (id)
);
create table marketplace.payment_provider_secret_refs (
provider_key text not null,
secret_key text not null,
vault_secret_id uuid not null,
last_rotated_at timestamp with time zone default now() not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
credentials_environment text
);
create table marketplace.bank_transfer_submissions (
id uuid default gen_random_uuid() not null,
order_id uuid not null,
tenant_id uuid not null,
submitted_by_subject_id uuid,
transfer_reference text not null,
sender_name text not null,
transfer_date date not null,
amount_minor bigint not null,
currency text default 'SAR'::text not null,
status text default 'pending'::text not null,
review_note text,
reviewed_by_subject_id uuid,
reviewed_at timestamp with time zone,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null
);
alter table marketplace.bank_transfer_submissions add primary key(id);
create table marketplace.payment_attempts (
id uuid not null,
tenant_id uuid not null,
order_id uuid not null,
requested_by_subject_id uuid,
provider_key text default 'paymob'::text not null,
environment text not null,
credential_version_id uuid not null,
idempotency_key text not null,
special_reference text not null,
status text default 'prepared'::text not null,
order_number_snapshot text not null,
order_kind_snapshot text not null,
subtotal_minor bigint not null,
tax_minor bigint not null,
tax_rate_bps integer not null,
amount_minor bigint not null,
currency text not null,
billing_contact_sha256 text not null,
items_snapshot_sha256 text not null,
provider_intention_id text,
provider_order_id text,
provider_transaction_id text,
provider_request_id text,
checkout_secret_id uuid,
checkout_secret_expires_at timestamp with time zone,
claim_token uuid,
claim_expires_at timestamp with time zone,
last_error_code text,
response_sha256 text,
provider_expires_at timestamp with time zone,
prepared_at timestamp with time zone default now() not null,
expires_at timestamp with time zone not null,
intention_recorded_at timestamp with time zone,
terminal_at timestamp with time zone,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
checkout_flow text default 'intention'::text not null,
payment_option text default 'hosted'::text not null,
selected_integration_id text
);
alter table marketplace.payment_attempts add primary key(id);
create table marketplace.promotion_redemptions (
id uuid default gen_random_uuid() not null,
promotion_id uuid not null,
order_id uuid not null,
tenant_id uuid not null,
requested_by_subject_id uuid,
status text default 'reserved'::text not null,
code_key_snapshot text not null,
terms_snapshot jsonb not null,
base_subtotal_minor bigint not null,
eligible_subtotal_minor bigint not null,
discount_minor bigint not null,
tax_minor_after bigint not null,
total_minor_after bigint not null,
currency text not null,
payment_provider_snapshot text,
reserved_at timestamp with time zone default now() not null,
reservation_expires_at timestamp with time zone not null,
redeemed_at timestamp with time zone,
released_at timestamp with time zone,
release_reason text,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null
);
alter table marketplace.promotion_redemptions add primary key(id);
create table marketplace.payment_provider_configs (
provider_key text not null,
name_ar text not null,
name_en text,
status text default 'draft'::text not null,
environment text default 'sandbox'::text not null,
checkout_mode text default 'redirect'::text not null,
supported_currencies text[] default ARRAY['SAR'::text] not null,
required_secret_keys text[] default '{}'::text[] not null,
optional_secret_keys text[] default '{}'::text[] not null,
public_config jsonb default '{}'::jsonb not null,
last_verified_at timestamp with time zone,
last_error_code text,
sort_order integer default 100 not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
credentials_environment text,
required_public_config_keys text[] default '{}'::text[] not null,
rollout_mode text default 'observe_only'::text not null,
readiness_evidence jsonb default '{}'::jsonb not null,
readiness_updated_at timestamp with time zone,
activated_by_subject_id uuid,
activated_at timestamp with time zone,
activation_requested_by_subject_id uuid,
activation_requested_at timestamp with time zone,
activation_requested_mode text,
sandbox_canary_version_id uuid,
sandbox_canary_started_at timestamp with time zone
);
create unique index fixture_active_sub on catalog.tenant_addon_subscriptions(tenant_id,product_id) where status in ('pending','trialing','active','paused');
create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text,name text);
create view vault.decrypted_secrets as select id,secret as decrypted_secret from vault.secrets;
create function vault.create_secret(text,text,text) returns uuid language sql as $$ insert into vault.secrets(secret,name) values($1,$2) returning id $$;
create function auth.jwt() returns jsonb language sql as $$ select jsonb_build_object('role',current_setting('fixture.role',true)) $$;
create function private_app.has_tenant_permission(uuid,text) returns boolean language sql as $$ select $1::text=current_setting('fixture.tenant',true) $$;
create function private_app.current_subject_id() returns uuid language sql as $$ select null::uuid $$;
create function public.v3_platform_payment_provider_admin_snapshot() returns jsonb language plpgsql as $$ begin if current_setting('fixture.admin',true) is distinct from 'true' then raise exception 'forbidden'; end if; return '{}'::jsonb; end $$;

