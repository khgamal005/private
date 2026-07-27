begin;

create index provider_connections_provider_reference_idx
  on communication_hub.provider_connections(provider_key);

create index provider_connections_creator_reference_idx
  on communication_hub.provider_connections(created_by_subject_id)
  where created_by_subject_id is not null;

create index provider_connections_updater_reference_idx
  on communication_hub.provider_connections(updated_by_subject_id)
  where updated_by_subject_id is not null;

create index message_templates_creator_reference_idx
  on communication_hub.message_templates(created_by_subject_id)
  where created_by_subject_id is not null;

create index message_templates_updater_reference_idx
  on communication_hub.message_templates(updated_by_subject_id)
  where updated_by_subject_id is not null;

commit;
