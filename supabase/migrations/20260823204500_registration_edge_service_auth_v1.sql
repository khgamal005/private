begin;

-- The public application may authenticate its server-to-server hop with the
-- project's server key when a dedicated ingress token is not configured.
-- PostgREST exposes this probe only to service_role; anon/authenticated keys
-- cannot use it to authorize an Edge intake request.
create or replace function public.v1_registration_edge_authorize()
returns boolean
language sql
stable
set search_path=''
as $$
  select true
$$;

revoke all on function public.v1_registration_edge_authorize()
from public,anon,authenticated;
grant execute on function public.v1_registration_edge_authorize()
to service_role;

commit;
