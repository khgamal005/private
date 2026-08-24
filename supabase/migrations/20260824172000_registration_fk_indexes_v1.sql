begin;

-- Cover every registration foreign key that participates in review,
-- diagnostics, cleanup, or subject deletion.  These indexes keep referential
-- checks and operational joins predictable as the SaaS control plane grows.
create index if not exists platform_registration_attestation_requester_idx
on platform.registration_activation_attestations(requested_by_subject_id);

create index if not exists platform_registration_webhook_delivery_idx
on platform.registration_email_webhook_events(delivery_id)
where delivery_id is not null;

create index if not exists platform_registration_worker_config_actor_idx
on platform.registration_email_worker_config(configured_by_subject_id)
where configured_by_subject_id is not null;

create index if not exists platform_registration_external_claim_actor_idx
on platform.registration_external_account_claims(claimed_by_subject_id);

create index if not exists platform_registration_identity_request_idx
on platform.registration_identity_claims(request_id)
where request_id is not null;

create index if not exists platform_registration_event_actor_idx
on platform.registration_request_events(actor_subject_id)
where actor_subject_id is not null;

create index if not exists platform_registration_reviewer_idx
on platform.registration_requests(reviewed_by_subject_id)
where reviewed_by_subject_id is not null;

create index if not exists platform_registration_settings_actor_idx
on platform.registration_settings(updated_by_subject_id)
where updated_by_subject_id is not null;

commit;
