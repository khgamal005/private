create schema if not exists marktone_mirror;
revoke all on schema marktone_mirror from public, anon, authenticated;
create table if not exists marktone_mirror.transport_config (
  singleton boolean primary key default true check (singleton),
  secret_hash text not null,
  updated_at timestamptz not null default now()
);
revoke all on marktone_mirror.transport_config from public, anon, authenticated;
create or replace function public.market_mirror_export(
  p_secret text,p_table text,p_offset integer default 0,p_limit integer default 500
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_allowed constant text[] := array['accounts','knowledge_questions','knowledge_answers','account_assessment_snapshots','contacts','account_contacts','contact_channels','account_scores','account_signals','account_snapshots','activities','tasks','phone_call_logs','opportunities','services'];
  v_hash text; v_rows jsonb := '[]'::jsonb; v_total bigint := 0;
  v_limit integer := least(greatest(coalesce(p_limit,500),1),500);
  v_offset integer := greatest(coalesce(p_offset,0),0);
  v_key_expression text; v_confidential boolean;
begin
  select secret_hash into v_hash from marktone_mirror.transport_config where singleton=true;
  if v_hash is null or p_secret is null or encode(extensions.digest(p_secret,'sha256'),'hex')<>v_hash then raise exception 'invalid_transport_secret'; end if;
  if not (p_table=any(v_allowed)) then raise exception 'unsupported_source_table'; end if;
  execute format('select count(*) from public.%I',p_table) into v_total;
  if p_table='accounts' then
    execute format('select coalesce(jsonb_agg(to_jsonb(t) - ''search_vector''),''[]''::jsonb) from (select * from public.%I order by id offset $1 limit $2) t',p_table) into v_rows using v_offset,v_limit;
  else
    v_key_expression:=case when p_table='account_contacts' then 'coalesce(j->>''account_id'','''') || '':'' || coalesce(j->>''contact_id'','''')' else 'j->>''id''' end;
    v_confidential:=p_table=any(array['knowledge_answers','contacts','account_contacts','contact_channels','phone_call_logs']);
    execute format(
      'select coalesce(jsonb_agg(jsonb_build_object(
       ''source_record_key'',%s,
       ''source_organization_id'',nullif(j->>''organization_id'',''''),
       ''source_account_id'',nullif(j->>''account_id'',''''),
       ''record_data'',j,
       ''confidential'',%L::boolean,
       ''market_intelligence_allowed'',%L::boolean,
       ''source_created_at'',coalesce(j->>''created_at'',j->>''answered_at'',j->>''computed_at'',j->>''observed_at'',j->>''captured_at''),
       ''source_updated_at'',coalesce(j->>''updated_at'',j->>''created_at'',j->>''answered_at'',j->>''computed_at'',j->>''observed_at'',j->>''captured_at'')
      )),''[]''::jsonb) from (select to_jsonb(t) j from (select * from public.%I order by %s offset $1 limit $2) t) rows',
      v_key_expression,v_confidential,not v_confidential,p_table,
      case when p_table='account_contacts' then 'account_id,contact_id' else 'id' end
    ) into v_rows using v_offset,v_limit;
  end if;
  return jsonb_build_object('table',p_table,'offset',v_offset,'limit',v_limit,'total',v_total,'rows',coalesce(v_rows,'[]'::jsonb));
end $$;
revoke all on function public.market_mirror_export(text,text,integer,integer) from public,authenticated;
grant execute on function public.market_mirror_export(text,text,integer,integer) to anon,service_role;
comment on function public.market_mirror_export(text,text,integer,integer) is 'Read-only, secret-protected batch export for Marktone Platform Control Market Mirror.';
