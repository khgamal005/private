begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Cover support foreign keys before ticket volume grows. All support tables
-- are empty at rollout, so these indexes are created without rewriting tenant
-- business data.
create index if not exists core_support_requests_requested_by_subject_idx
  on core.support_requests(requested_by_subject_id);
create index if not exists core_support_requests_requester_staff_idx
  on core.support_requests(requester_staff_id);
create index if not exists core_support_messages_author_staff_idx
  on core.support_messages(author_staff_id);
create index if not exists core_support_events_actor_subject_idx
  on core.support_events(actor_subject_id);
create index if not exists core_support_attachments_uploader_subject_idx
  on core.support_attachments(uploaded_by_subject_id);
-- The canonical ticket table is core.support_requests and its requester
-- foreign key is covered above. There is no platform.support_requests table;
-- platform support operates on the same tenant-scoped canonical tickets.
create index if not exists platform_support_cleanup_config_subject_idx
  on platform.support_attachment_cleanup_worker_config(
    configured_by_subject_id
  );

commit;
