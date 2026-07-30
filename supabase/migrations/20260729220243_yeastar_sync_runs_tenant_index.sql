create index if not exists telephony_sync_runs_tenant_started_idx
on telephony.sync_runs (tenant_id, started_at desc);
