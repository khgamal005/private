-- Cover marketplace foreign keys used by delete checks, audit lookups and catalog joins.

create index if not exists marketplace_orders_requested_by_subject_idx
  on marketplace.orders(requested_by_subject_id);
create index if not exists marketplace_order_items_service_product_idx
  on marketplace.order_items(service_product_id);
create index if not exists marketplace_order_items_addon_product_idx
  on marketplace.order_items(addon_product_id);
create index if not exists marketplace_order_events_tenant_idx
  on marketplace.order_events(tenant_id,created_at desc);
create index if not exists marketplace_order_events_actor_subject_idx
  on marketplace.order_events(actor_subject_id);
