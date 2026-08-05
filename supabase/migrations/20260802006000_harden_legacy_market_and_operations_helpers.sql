do $$
begin
  if to_regprocedure('public.market_account_detail(uuid)') is not null then
    revoke execute on function public.market_account_detail(uuid)
      from public, anon;
  end if;

  if to_regprocedure('public.market_intelligence_snapshot(text,integer,integer)') is not null then
    revoke execute on function public.market_intelligence_snapshot(text, integer, integer)
      from public, anon;
  end if;

  if to_regprocedure('public.market_intelligence_summary()') is not null then
    revoke execute on function public.market_intelligence_summary()
      from public, anon;
  end if;

  if to_regprocedure('public.market_tenant_intelligence_profile(text)') is not null then
    revoke execute on function public.market_tenant_intelligence_profile(text)
      from public, anon;
  end if;

  if to_regprocedure('operations.try_uuid(text)') is not null then
    alter function operations.try_uuid(text)
      set search_path = '';
  end if;

  if to_regprocedure('operations.try_timestamptz(text)') is not null then
    alter function operations.try_timestamptz(text)
      set search_path = '';
  end if;

  if to_regprocedure('operations.normalize_role(text)') is not null then
    alter function operations.normalize_role(text)
      set search_path = '';
  end if;
end;
$$;
