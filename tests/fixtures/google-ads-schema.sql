-- Synthetic fixture extension; never apply this file to a connected database.
-- Tests load the existing campaign-revenue-schema fixture and its migration first.
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
$$;
alter table access_control.subjects add column auth_user_id uuid;
alter table access_control.subjects add column status text default 'active';
alter table access_control.subjects add column must_change_password boolean default false;
create or replace function private_app.current_subject_id() returns uuid language sql stable as $$
 select id from access_control.subjects where auth_user_id=auth.uid() and status='active' and not must_change_password limit 1;
$$;
create or replace function private_app.has_tenant_permission(t uuid,p text) returns boolean language sql stable as $$
 select auth.uid() is not null and private_app.current_subject_id() is not null and t::text=current_setting('fixture.tenant',true)
 and not p=any(string_to_array(coalesce(current_setting('fixture.deny',true),''),','));
$$;
create schema catalog;
create table catalog.features(id uuid primary key default gen_random_uuid(),feature_key text unique,name_ar text,name_en text,category text,value_type text,default_value jsonb,status text);
create table catalog.addon_products(id uuid primary key default gen_random_uuid(),product_key text unique,feature_id uuid references catalog.features(id),name_ar text,name_en text,description_ar text,pricing_mode text,amount_minor bigint,currency text,interval text,trial_days integer,usage_metric text,default_limit integer,status text,sort_order integer,marketplace_category text,badge_ar text,activation_mode text);
alter table catalog.addon_products add column is_marketplace_visible boolean not null default true;
create table catalog.addon_manifests(id uuid primary key default gen_random_uuid(),product_id uuid references catalog.addon_products(id),manifest_version text,contract_version integer,short_description_ar text,long_description_ar text,publisher_name text,install_mode text,data_policy text,dependencies jsonb,required_permissions text[],configuration_schema jsonb,release_notes_ar text,status text,is_current boolean,released_at timestamptz,unique(product_id,manifest_version));
create table catalog.addon_surfaces(id uuid primary key default gen_random_uuid(),manifest_id uuid references catalog.addon_manifests(id),surface_key text,surface_type text,location_key text,title_ar text,description_ar text,route_template text,icon_key text,required_permission text,visibility_mode text,status text,sort_order integer,metadata jsonb,unique(manifest_id,surface_key));
-- Vault is substituted only in this isolated fixture; token contents are synthetic.
create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text,name text,description text);
create view vault.decrypted_secrets as select id,secret as decrypted_secret from vault.secrets;
create function vault.create_secret(p_secret text,p_name text,p_description text,p_key uuid default null) returns uuid language plpgsql as $$
declare i uuid;begin insert into vault.secrets(secret,name,description) values(p_secret,p_name,p_description) returning id into i;return i;end;
$$;
