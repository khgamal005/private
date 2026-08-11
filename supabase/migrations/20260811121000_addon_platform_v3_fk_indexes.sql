-- Add-on platform v3 follow-up: cover every newly introduced foreign key.
-- Safe to rerun; no data is rewritten or removed.

begin;

create index if not exists addon_manifests_creator_idx_v3
on catalog.addon_manifests (created_by_subject_id)
where created_by_subject_id is not null;

create index if not exists addon_media_surface_reference_idx_v3
on catalog.addon_media (surface_id)
where surface_id is not null;

create index if not exists addon_price_versions_creator_idx_v3
on catalog.addon_price_versions (created_by_subject_id)
where created_by_subject_id is not null;

create index if not exists tenant_addon_events_actor_idx_v3
on catalog.tenant_addon_subscription_events (actor_subject_id)
where actor_subject_id is not null;

create index if not exists tenant_addon_events_product_time_idx_v3
on catalog.tenant_addon_subscription_events (product_id, effective_at desc);

commit;
