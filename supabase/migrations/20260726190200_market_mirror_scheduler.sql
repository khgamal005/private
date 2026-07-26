create or replace function market_intelligence.market_mirror_fetch(p_table text,p_offset integer,p_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_url text; v_key text; v_secret text; v_response extensions.http_response;
begin
 select decrypted_secret into v_url from vault.decrypted_secrets where name='market_mirror_source_url';
 select decrypted_secret into v_key from vault.decrypted_secrets where name='market_mirror_source_key';
 select decrypted_secret into v_secret from vault.decrypted_secrets where name='market_mirror_transport_secret';
 if v_url is null or v_key is null or v_secret is null then raise exception 'market_mirror_credentials_missing'; end if;
 select * into v_response from extensions.http((
  'POST',rtrim(v_url,'/')||'/rest/v1/rpc/market_mirror_export',
  array[extensions.http_header('apikey',v_key),extensions.http_header('authorization','Bearer '||v_key)],
  'application/json',jsonb_build_object('p_secret',v_secret,'p_table',p_table,'p_offset',p_offset,'p_limit',p_limit)::text
 )::extensions.http_request);
 if v_response.status<200 or v_response.status>=300 then raise exception 'market_mirror_source_http_%: %',v_response.status,left(coalesce(v_response.content,''),500); end if;
 return v_response.content::jsonb;
end $$;

create or replace function market_intelligence.run_market_mirror_sync(p_run_type text default 'manual')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_tables constant text[]:=array['accounts','knowledge_questions','knowledge_answers','account_assessment_snapshots','contacts','account_contacts','contact_channels','account_scores','account_signals','account_snapshots','activities','tasks','phone_call_logs','opportunities','services'];
 v_table text; v_started timestamptz:=clock_timestamp(); v_run jsonb; v_run_id uuid; v_offset integer; v_total bigint; v_page jsonb; v_result jsonb;
 v_read bigint:=0; v_inserted bigint:=0; v_updated bigint:=0; v_unchanged bigint:=0; v_failed bigint:=0;
begin
 v_run:=public.market_sync_start(case when p_run_type in ('manual','full','incremental') then p_run_type else 'manual' end,v_tables);
 v_run_id:=(v_run->>'runId')::uuid;
 update market_intelligence.sync_sources set status='active',last_error=null,updated_at=now() where source_key='marktone_projects';
 foreach v_table in array v_tables loop
  v_offset:=0; v_total:=null;
  loop
   v_page:=market_intelligence.market_mirror_fetch(v_table,v_offset,500);
   v_total:=coalesce((v_page->>'total')::bigint,0);
   exit when jsonb_array_length(coalesce(v_page->'rows','[]'::jsonb))=0;
   if v_table='accounts' then v_result:=public.market_sync_import_accounts(v_page->'rows'); else v_result:=public.market_sync_import_records(v_table,v_page->'rows'); end if;
   v_read:=v_read+coalesce((v_result->>'read')::bigint,jsonb_array_length(v_page->'rows'));
   v_inserted:=v_inserted+coalesce((v_result->>'inserted')::bigint,0);
   v_updated:=v_updated+coalesce((v_result->>'updated')::bigint,0);
   v_unchanged:=v_unchanged+coalesce((v_result->>'unchanged')::bigint,0);
   v_offset:=v_offset+jsonb_array_length(v_page->'rows');
   exit when v_offset>=v_total;
  end loop;
  perform public.market_sync_prune(v_table,v_started);
 end loop;
 perform public.market_sync_finalize(v_run_id,'completed',v_read,v_inserted,v_updated,v_unchanged,v_failed,jsonb_build_object('completedAt',now()),'[]'::jsonb);
 update market_intelligence.sync_sources set status='active',last_error=null,updated_at=now() where source_key='marktone_projects';
 return jsonb_build_object('runId',v_run_id,'status','completed','rowsRead',v_read,'rowsInserted',v_inserted,'rowsUpdated',v_updated,'rowsUnchanged',v_unchanged,'rowsFailed',v_failed);
exception when others then
 if v_run_id is not null then perform public.market_sync_finalize(v_run_id,'failed',v_read,v_inserted,v_updated,v_unchanged,v_failed,'{}'::jsonb,jsonb_build_array(sqlerrm)); end if;
 update market_intelligence.sync_sources set status='error',last_error=sqlerrm,updated_at=now() where source_key='marktone_projects';
 raise;
end $$;

create or replace function market_intelligence.configure_market_mirror_schedule(p_frequency text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_cron text; v_job bigint;
begin
 if p_frequency not in ('manual','daily','weekly','monthly') then raise exception 'invalid_frequency'; end if;
 select jobid into v_job from cron.job where jobname='marktone-market-mirror' limit 1;
 if v_job is not null then perform cron.unschedule(v_job); end if;
 v_cron:=case p_frequency when 'daily' then '0 2 * * *' when 'weekly' then '0 2 * * 0' when 'monthly' then '0 2 1 * *' else null end;
 if v_cron is not null then perform cron.schedule('marktone-market-mirror',v_cron,$cron$select market_intelligence.run_market_mirror_sync('incremental');$cron$); end if;
 update market_intelligence.sync_sources set configuration=jsonb_set(coalesce(configuration,'{}'::jsonb),'{schedule}',to_jsonb(p_frequency),true),updated_at=now() where source_key='marktone_projects';
 return jsonb_build_object('frequency',p_frequency,'cron',v_cron,'scheduled',v_cron is not null);
end $$;

create or replace function public.market_sync_admin_snapshot()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_source market_intelligence.sync_sources%rowtype; v_run market_intelligence.sync_runs%rowtype;
begin
 if not platform.is_platform_operator(auth.uid()) then raise exception 'forbidden'; end if;
 select * into v_source from market_intelligence.sync_sources where source_key='marktone_projects';
 select * into v_run from market_intelligence.sync_runs where source_id=v_source.id order by started_at desc limit 1;
 return jsonb_build_object('status',v_source.status,'frequency',coalesce(v_source.configuration->>'schedule','weekly'),'lastStartedAt',v_source.last_started_at,'lastCompletedAt',v_source.last_completed_at,'lastSuccessAt',v_source.last_success_at,'lastError',v_source.last_error,'lastRunStatus',v_run.status,'lastRowsRead',coalesce(v_run.rows_read,0),'lastRunId',v_run.id);
end $$;
create or replace function public.market_sync_update_schedule(p_frequency text)
returns jsonb language plpgsql security definer set search_path='' as $$ begin if not platform.is_platform_operator(auth.uid()) then raise exception 'forbidden'; end if; return market_intelligence.configure_market_mirror_schedule(p_frequency); end $$;
create or replace function public.market_sync_run_now()
returns jsonb language plpgsql security definer set search_path='' as $$ begin if not platform.is_platform_operator(auth.uid()) then raise exception 'forbidden'; end if; return market_intelligence.run_market_mirror_sync('manual'); end $$;
revoke all on function public.market_sync_admin_snapshot(),public.market_sync_update_schedule(text),public.market_sync_run_now() from public,anon;
grant execute on function public.market_sync_admin_snapshot(),public.market_sync_update_schedule(text),public.market_sync_run_now() to authenticated;
select market_intelligence.configure_market_mirror_schedule('weekly');
