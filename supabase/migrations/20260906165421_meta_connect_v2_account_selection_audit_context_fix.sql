-- Preserve the authenticated actor context until the account-selection audit
-- event is written, then restore the service-role request context.
-- Rollback: restore the prior function body from
-- 20260906162436_meta_connect_v2_ads_reporting.sql.

create or replace function public.v1_service_meta_connect_v2_bind_ad_account(
  p_connection_id uuid,
  p_actor_subject_id uuid,
  p_account jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_connection meta_connect_v2.connections%rowtype;
  v_marketing marketing_hub.connections%rowtype;
  v_account marketing_hub.ad_accounts%rowtype;
  v_secret_id uuid;
  v_external_id text:=regexp_replace(
    trim(coalesce(p_account->>'externalAccountId','')),'^act_','','i'
  );
  v_name text:=left(trim(coalesce(p_account->>'name','')),240);
  v_currency text:=upper(trim(coalesce(p_account->>'currency','')));
  v_timezone text:=left(nullif(trim(p_account->>'timezone'),''),120);
  v_status text:=lower(trim(coalesce(p_account->>'status','unknown')));
  v_actor_auth_user_id uuid;
  v_original_claims text:=current_setting('request.jwt.claims',true);
  v_original_sub text:=current_setting('request.jwt.claim.sub',true);
begin
  perform pg_advisory_xact_lock(hashtextextended('meta_connect_v2:control_plane',0));
  if jsonb_typeof(p_account)<>'object'
     or v_external_id !~ '^[0-9]{1,40}$'
     or v_name=''
     or v_currency !~ '^[A-Z]{3}$'
     or v_status not in ('active','inactive','closed','unknown') then
    raise exception 'meta_connect_v2_account_invalid';
  end if;

  select connection.* into v_connection
  from meta_connect_v2.connections connection
  where connection.id=p_connection_id
  for update;
  if v_connection.id is null or v_connection.status<>'connected'
     or v_connection.token_expires_at<=now() then
    raise exception 'meta_connect_v2_reauthorization_required';
  end if;
  if not exists (
    select 1 from meta_connect_v2.rollout_targets rollout
    where rollout.tenant_id=v_connection.tenant_id and rollout.status='pilot'
      and rollout.capabilities @> array['account_selection']::text[]
  ) or not coalesce((
    select switch.enabled from meta_connect_v2.kill_switches switch
    where switch.capability='account_selection'
  ),false) then raise exception 'meta_connect_v2_capability_disabled'; end if;

  select subject.auth_user_id into v_actor_auth_user_id
  from access_control.subjects subject
  where subject.id=p_actor_subject_id and subject.status='active'
    and not subject.must_change_password;
  if v_actor_auth_user_id is null then raise exception 'forbidden'; end if;
  perform set_config('request.jwt.claim.sub',v_actor_auth_user_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',v_actor_auth_user_id,'role','authenticated'
  )::text,true);
  if private_app.current_subject_id() is distinct from p_actor_subject_id
     or not private_app.has_tenant_permission(
       v_connection.tenant_id,'tenant.meta_connect.manage'
     ) then raise exception 'forbidden'; end if;

  select credential.vault_secret_id into v_secret_id
  from meta_connect_v2.credential_refs credential
  where credential.connection_id=v_connection.id
    and credential.credential_type='user_access_token';
  if v_secret_id is null then
    raise exception 'meta_connect_v2_credential_unavailable';
  end if;

  select existing.* into v_marketing
  from marketing_hub.connections existing
  where existing.tenant_id=v_connection.tenant_id
    and existing.provider_key='meta'
  for update;
  if v_marketing.id is not null
     and v_marketing.id is distinct from v_connection.marketing_connection_id then
    raise exception 'legacy_meta_connection_present';
  end if;

  if v_marketing.id is null then
    insert into marketing_hub.connections(
      tenant_id,provider_key,display_name,status,frequency,sync_lookback_days,
      api_version,configuration,secret_refs,created_by_subject_id,
      updated_by_subject_id
    ) values (
      v_connection.tenant_id,'meta',v_name,'draft','daily',30,
      'v26.0',jsonb_build_object(
        'accountId',v_external_id,'authSource','meta_connect_v2'
      ),jsonb_build_object('accessToken',v_secret_id),
      p_actor_subject_id,p_actor_subject_id
    ) returning * into v_marketing;
  else
    update marketing_hub.connections
    set display_name=v_name,status='draft',frequency='daily',
        sync_lookback_days=30,api_version='v26.0',
        configuration=jsonb_build_object(
          'accountId',v_external_id,'authSource','meta_connect_v2'
        ),secret_refs=jsonb_build_object('accessToken',v_secret_id),
        next_sync_at=null,last_error_code=null,last_error_detail=null,
        updated_by_subject_id=p_actor_subject_id
    where id=v_marketing.id
    returning * into v_marketing;
  end if;

  update marketing_hub.ad_accounts
  set is_selected=false
  where connection_id=v_marketing.id;
  insert into marketing_hub.ad_accounts(
    tenant_id,connection_id,provider_key,external_account_id,name,currency,
    timezone,status,is_selected,metadata
  ) values (
    v_connection.tenant_id,v_marketing.id,'meta',v_external_id,v_name,
    v_currency,v_timezone,v_status,true,
    jsonb_build_object(
      'businessId',nullif(p_account->>'businessId',''),
      'businessName',nullif(p_account->>'businessName',''),
      'accountStatus',p_account->'accountStatus'
    )
  ) on conflict(connection_id,external_account_id) do update
  set name=excluded.name,currency=excluded.currency,timezone=excluded.timezone,
      status=excluded.status,is_selected=true,metadata=excluded.metadata
  returning * into v_account;

  update meta_connect_v2.connections
  set marketing_connection_id=v_marketing.id,
      selected_external_account_id=v_external_id,last_error_code=null
  where id=v_connection.id;

  perform private_app.write_audit(
    'meta_connect_v2.ad_account_selected','meta_connect_v2_connection',
    v_connection.id::text,v_connection.tenant_id,
    jsonb_build_object(
      'marketingConnectionId',v_marketing.id,
      'externalAccountId',v_external_id,
      'readOnly',true
    )
  );
  perform set_config('request.jwt.claims',coalesce(v_original_claims,''),true);
  perform set_config('request.jwt.claim.sub',coalesce(v_original_sub,''),true);
  return jsonb_build_object(
    'status','selected','connectionId',v_connection.id,
    'marketingConnectionId',v_marketing.id,
    'externalAccountId',v_external_id,'accountName',v_name
  );
exception when others then
  perform set_config('request.jwt.claims',coalesce(v_original_claims,''),true);
  perform set_config('request.jwt.claim.sub',coalesce(v_original_sub,''),true);
  raise;
end;
$$;

revoke execute on function public.v1_service_meta_connect_v2_bind_ad_account(uuid,uuid,jsonb)
from public,anon,authenticated;
grant execute on function public.v1_service_meta_connect_v2_bind_ad_account(uuid,uuid,jsonb)
to service_role;
