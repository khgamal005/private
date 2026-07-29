-- Historical preview migration marker.
--
-- This version was recorded by the existing PR preview before the incentives
-- migration was finalized. The actual title_ar correction now lives in
-- 20260729213000_goals_incentives_v2.sql, which runs after this marker on a
-- fresh database. Keep this file so existing preview migration history stays
-- consistent without referencing incentives_core before it is created.
do $$
begin
  null;
end
$$;
