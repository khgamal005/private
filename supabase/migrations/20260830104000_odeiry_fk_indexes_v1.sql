begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regclass('core.odeiry_runs') is null
     or to_regclass('core.odeiry_messages') is null
     or to_regclass('core.odeiry_ticket_escalations') is null then
    raise exception 'odeiry_fk_indexes_missing_foundation';
  end if;
end;
$preflight$;

-- Cover the complete child-side column order of each composite foreign key.
-- The tables are additive and empty at rollout, so these builds are bounded.
create index if not exists core_odeiry_runs_thread_owner_fk_idx
on core.odeiry_runs(
  tenant_id,thread_id,requested_by_subject_id
);

create index if not exists core_odeiry_messages_run_thread_fk_idx
on core.odeiry_messages(
  tenant_id,run_id,thread_id
);

create index if not exists core_odeiry_escalations_run_thread_fk_idx
on core.odeiry_ticket_escalations(
  tenant_id,run_id,thread_id
);

commit;
