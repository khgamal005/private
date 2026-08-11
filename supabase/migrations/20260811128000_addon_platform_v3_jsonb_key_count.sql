-- Add-on platform v3 follow-up: PostgreSQL exposes jsonb_array_length but no
-- built-in jsonb_object_length. Keep the already-applied bundle immutable and
-- provide the narrowly scoped helper its fail-closed size checks expect.

begin;

create or replace function private_app.jsonb_object_length(
  p_value jsonb
)
returns integer
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'object' then (
      select count(*)::integer
      from jsonb_object_keys(p_value)
    )
    else null
  end
$$;

revoke all on function private_app.jsonb_object_length(jsonb)
from public, anon, authenticated, service_role;

alter function private_app.v3_payment_provider_bundle_core(
  text,
  text,
  text,
  text[],
  boolean,
  jsonb,
  jsonb,
  uuid
) set search_path to pg_catalog, private_app;

comment on function private_app.jsonb_object_length(jsonb) is
  'Private compatibility helper for bounded payment configuration objects; returns null for non-objects.';

commit;
