-- Isolated test fixture only; the production migration reads these existing contracts.
create schema commerce_sync;
create table commerce_sync.connections(id uuid primary key,tenant_id uuid not null,store_url text);
create table commerce_sync.external_entities(id uuid primary key,tenant_id uuid not null,connection_id uuid,entity_type text,external_id text,raw_payload jsonb);
create table sales_core.commerce_order_work_items(id uuid primary key,tenant_id uuid not null,connection_id uuid,external_entity_id uuid unique,order_number text,order_status text,currency text,amount_minor bigint);
create table sales_core.commerce_admission_lines(tenant_id uuid,work_item_id uuid,handoff_id uuid,unique(tenant_id,handoff_id));
