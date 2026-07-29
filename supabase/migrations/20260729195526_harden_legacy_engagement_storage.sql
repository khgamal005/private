-- Harden legacy Engagement tables that may still exist on upgraded production databases.
-- Fresh v2 preview databases do not create these tables; the migration remains a safe no-op there.
do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_namespace where nspname = 'engagement') then
    revoke all on schema engagement from public, anon, authenticated;

    foreach v_table in array array[
      'announcements',
      'announcement_reads',
      'incentive_plans',
      'incentive_assignments',
      'incentive_events'
    ]
    loop
      if to_regclass(format('engagement.%I', v_table)) is not null then
        execute format('alter table engagement.%I enable row level security', v_table);
        execute format(
          'revoke all on table engagement.%I from public, anon, authenticated',
          v_table
        );
      end if;
    end loop;
  end if;
end
$$;
