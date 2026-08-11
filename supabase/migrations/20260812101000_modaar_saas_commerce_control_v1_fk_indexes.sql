begin;

-- Cover the reverse lookup used by the plan-limit definition foreign key.
create index if not exists catalog_plan_limits_limit_key_idx
  on catalog.plan_limits(limit_key);

commit;
