-- Minimal source contracts copied from the reviewed migrations; fixtures only.
create role anon; create role authenticated; create role service_role;
create schema core; create schema access_control; create schema people;
create schema academy; create schema sales_core; create schema accounting_core;
create schema marketing_hub; create schema private_app;
create table core.tenants(id uuid primary key,slug text,status text default 'active',timezone text default 'Asia/Riyadh');
create table access_control.subjects(id uuid primary key);
create table people.staff_profiles(id uuid primary key,tenant_id uuid,full_name text);
create table academy.courses(id uuid primary key,tenant_id uuid,title_ar text);
create table sales_core.contacts(id uuid primary key,tenant_id uuid,full_name text,source text,campaign_name text,ad_name text,
 created_at timestamptz default now(),lead_status text default 'new',lead_quality text default 'unrated',owner_staff_id uuid,interest_course_id uuid,metadata jsonb default '{}');
create table sales_core.lead_import_batches(id uuid primary key,tenant_id uuid,file_name text,created_at timestamptz default now());
create table sales_core.lead_import_rows(id uuid primary key,tenant_id uuid,batch_id uuid,contact_id uuid,duplicate_contact_id uuid,
 row_number integer,source text,campaign_name text,ad_name text,ad_set_name text,full_name text,validation_status text default 'valid',
 queue_status text default 'awaiting_distribution',raw_data jsonb default '{}',created_at timestamptz default now());
create table academy.registration_handoffs(id uuid primary key,tenant_id uuid,contact_id uuid,opportunity_id uuid,course_id uuid,
 payment_status text,payment_verified_at timestamptz,payment_amount_minor bigint,payment_verified_by_subject_id uuid,status text,metadata jsonb default '{}');
create table sales_core.opportunities(id uuid primary key,tenant_id uuid,contact_id uuid,created_at timestamptz,metadata jsonb default '{}');
create table accounting_core.customer_accounts(id uuid primary key,tenant_id uuid,contact_id uuid);
create table accounting_core.payments(id uuid primary key,tenant_id uuid,customer_account_id uuid,source_type text,source_id text,
 status text,verified_at timestamptz,amount_minor bigint,currency text,metadata jsonb default '{}');
create table accounting_core.refunds(id uuid primary key,tenant_id uuid,payment_id uuid,status text,completed_at timestamptz,amount_minor bigint);
create table marketing_hub.ad_accounts(id uuid primary key,tenant_id uuid,name text,currency text,connection_id uuid);
create table marketing_hub.sync_runs(tenant_id uuid,connection_id uuid,status text,date_from date,date_to date);
create table marketing_hub.campaigns(id uuid primary key,tenant_id uuid,ad_account_id uuid,name text,provider_key text,external_campaign_id text);
create table marketing_hub.ads(id uuid primary key,tenant_id uuid,ad_account_id uuid,campaign_id uuid,external_ad_id text,ad_group_id uuid,name text,status text,effective_status text);
create table marketing_hub.ad_groups(id uuid primary key,tenant_id uuid,name text,external_ad_group_id text);
create table marketing_hub.daily_metrics(id uuid primary key default gen_random_uuid(),tenant_id uuid,campaign_id uuid,ad_id uuid,
 metric_date date,entity_level text,breakdown_key text default 'all',currency text,spend_minor bigint);
create function private_app.current_subject_id() returns uuid language sql as $$select '10000000-0000-4000-8000-000000000099'::uuid$$;
create function private_app.has_tenant_permission(t uuid,p text) returns boolean language sql as $$
 select t::text=current_setting('fixture.tenant',true) and coalesce(current_setting('fixture.deny',true),'')<>p $$;
create function private_app.has_accounting_permission(t uuid,p text) returns boolean language sql as $$
 select private_app.has_tenant_permission(t,p) and coalesce(current_setting('fixture.finance',true),'yes')<>'no' $$;
create function private_app.tenant_addon_enabled(t uuid,p text) returns boolean language sql as $$
 select t::text=current_setting('fixture.tenant',true) and coalesce(current_setting('fixture.addon',true),'yes')<>'no' $$;
create function public.v2_tenant_meta_connect_v2_report(text,date,date,text,uuid,text,integer,integer) returns jsonb language sql as $$
 select '{"metricRows":0,"summary":{"spendMinor":0,"reach":100,"currency":"EGP"},"analysis":{"zeroResultSpendMinor":0},"campaigns":[],"ads":[]}'::jsonb $$;
