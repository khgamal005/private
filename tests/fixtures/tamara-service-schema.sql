-- Synthetic service columns grounded in the production schema; no live rows.
create table marketplace.service_categories(id uuid default gen_random_uuid() primary key,category_key text,status text default 'active');
create table marketplace.service_providers(id uuid default gen_random_uuid() primary key,status text default 'active');
create table marketplace.service_products(id uuid default gen_random_uuid() primary key,category_id uuid,product_key text,name_ar text,pricing_mode text default 'fixed',amount_minor bigint default 0,currency text default 'SAR',provider_id uuid,course_id uuid,marketplace_visible boolean default true,status text default 'active');
create table marketplace.service_packages(id uuid default gen_random_uuid() primary key,service_product_id uuid,amount_minor bigint,currency text default 'SAR',name_ar text,description_ar text,included_items_ar text[],revisions_included smallint,turnaround_days integer,status text default 'active');
create table marketplace.service_order_briefs(order_id uuid primary key,tenant_id uuid,provider_id uuid,package_id uuid,preferred_start_date date,delivery_mode text,brief jsonb default '{}');
create table marketplace.service_order_assignments(order_id uuid primary key,tenant_id uuid,provider_id uuid,package_id uuid,status text default 'pending');
create function private_app.has_platform_permission(text) returns boolean language sql as $$select current_setting('fixture.admin',true)='true'$$;
create or replace function private_app.current_subject_id() returns uuid language sql as $$select nullif(current_setting('fixture.tenant',true),'')::uuid$$;
create function private_app.fixture_price() returns trigger language plpgsql as $$begin new.list_subtotal_minor:=coalesce(new.list_subtotal_minor,new.subtotal_minor);return new;end$$;
create trigger fixture_price before insert on marketplace.orders for each row execute function private_app.fixture_price();
create or replace function private_app.marketplace_order_payload(uuid) returns jsonb language sql as $$select jsonb_build_object('id',id,'orderNumber',order_number,'totalMinor',total_minor,'paymentProvider',payment_provider) from marketplace.orders where id=$1$$;
