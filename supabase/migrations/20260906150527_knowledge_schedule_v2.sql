-- RELEASE ACTIVATION ONLY: run after knowledge-ingest reports version knowledge-v2
-- and its dry-run succeeds. Preserve the existing endpoint and vault secret.
-- The owner explicitly authorizes this phase when approving production deployment.
do $$
declare v_job bigint;
begin
 select jobid into v_job from cron.job where jobname='marktone-knowledge-ingestion';
 if v_job is null then raise exception 'knowledge_existing_schedule_missing';end if;
 perform cron.alter_job(v_job,schedule:='*/15 * * * *');
end;
$$;
