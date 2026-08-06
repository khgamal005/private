create table if not exists private_app.yeastar_gateway_requests (
  id uuid primary key default gen_random_uuid(),
  request_hash text not null
    check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  check (expires_at > created_at)
);

create index if not exists yeastar_gateway_requests_expires_idx
  on private_app.yeastar_gateway_requests (expires_at);

alter table private_app.yeastar_gateway_requests enable row level security;

revoke all on table private_app.yeastar_gateway_requests
  from public, anon, authenticated, service_role;

create or replace function public.v4_yeastar_gateway_issue(
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := lower(trim(coalesce(p_request_hash, '')));
  v_token uuid := gen_random_uuid();
  v_expires_at timestamptz := clock_timestamp() + interval '90 seconds';
begin
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_yeastar_gateway_request_hash';
  end if;

  delete from private_app.yeastar_gateway_requests
  where expires_at < clock_timestamp() - interval '10 minutes';

  insert into private_app.yeastar_gateway_requests (
    id,
    request_hash,
    expires_at
  )
  values (
    v_token,
    v_hash,
    v_expires_at
  );

  return jsonb_build_object(
    'token', v_token,
    'expiresAt', v_expires_at
  );
end;
$$;

create or replace function public.v4_yeastar_gateway_claim(
  p_token uuid,
  p_request_hash text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update private_app.yeastar_gateway_requests
    set claimed_at = clock_timestamp()
    where id = p_token
      and request_hash = lower(trim(coalesce(p_request_hash, '')))
      and claimed_at is null
      and expires_at > clock_timestamp()
    returning id
  )
  select exists(select 1 from claimed);
$$;

revoke all on function public.v4_yeastar_gateway_issue(text)
  from public, anon, authenticated;
revoke all on function public.v4_yeastar_gateway_claim(uuid, text)
  from public, anon, authenticated;

grant execute on function public.v4_yeastar_gateway_issue(text)
  to service_role;
grant execute on function public.v4_yeastar_gateway_claim(uuid, text)
  to anon;

comment on table private_app.yeastar_gateway_requests is
  'Short-lived, single-use grants for the Marktone Hostinger Yeastar egress gateway.';
comment on function public.v4_yeastar_gateway_issue(text) is
  'Issues a 90-second gateway grant. Callable only by the service role.';
comment on function public.v4_yeastar_gateway_claim(uuid, text) is
  'Atomically validates and consumes one Hostinger gateway grant.';
