revoke execute on function public.market_account_detail(uuid)
  from public, anon;
revoke execute on function public.market_intelligence_snapshot(text, integer, integer)
  from public, anon;
revoke execute on function public.market_intelligence_summary()
  from public, anon;
revoke execute on function public.market_tenant_intelligence_profile(text)
  from public, anon;

alter function operations.try_uuid(text)
  set search_path = '';
alter function operations.try_timestamptz(text)
  set search_path = '';
alter function operations.normalize_role(text)
  set search_path = '';
