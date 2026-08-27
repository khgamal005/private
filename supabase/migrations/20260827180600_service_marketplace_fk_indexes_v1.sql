begin;

-- Cover the remaining service-marketplace foreign keys reported by the
-- production database advisor. These indexes are additive and do not rewrite
-- existing orders or tenant data.
create index if not exists service_order_briefs_package_idx
  on marketplace.service_order_briefs(package_id);
create index if not exists service_assignments_package_idx
  on marketplace.service_order_assignments(package_id);
create index if not exists service_assignments_assigned_by_idx
  on marketplace.service_order_assignments(assigned_by_subject_id);
create index if not exists service_assignment_events_tenant_idx
  on marketplace.service_assignment_events(tenant_id);
create index if not exists service_assignment_events_from_provider_idx
  on marketplace.service_assignment_events(from_provider_id);
create index if not exists service_assignment_events_actor_idx
  on marketplace.service_assignment_events(actor_subject_id);
create index if not exists service_reviews_created_by_idx
  on marketplace.service_reviews(created_by_subject_id);

commit;
