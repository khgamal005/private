begin;

-- Keep the append-only history private while making its service boundary
-- explicit to the database linter.
drop policy if exists task_history_service_read
on work_core.task_history;

create policy task_history_service_read
on work_core.task_history
for select
to service_role
using (true);

-- Cover every nullable foreign key used by ON DELETE maintenance. The
-- tenant/task and tenant/contact timeline indexes remain optimized for reads.
create index if not exists work_task_history_contact_reference_idx
on work_core.task_history (contact_id)
where contact_id is not null;

create index if not exists work_task_history_opportunity_reference_idx
on work_core.task_history (opportunity_id)
where opportunity_id is not null;

create index if not exists work_task_history_actor_reference_idx
on work_core.task_history (actor_subject_id)
where actor_subject_id is not null;

create index if not exists work_task_history_previous_assignee_reference_idx
on work_core.task_history (previous_assigned_staff_id)
where previous_assigned_staff_id is not null;

create index if not exists work_task_history_next_assignee_reference_idx
on work_core.task_history (next_assigned_staff_id)
where next_assigned_staff_id is not null;

commit;
