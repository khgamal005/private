-- Social Connect V2: read-only Meta ad-account selection and reporting bridge.
-- Additive, fail-closed, and isolated from every legacy Meta connection.

do $preflight$
begin
  if to_regclass('meta_connect_v2.connections') is null
     or to_regclass('marketing_hub.connections') is null
     or to_regclass('marketing_hub.ad_accounts') is null
     or to_regclass('marketing_hub.campaigns') is null
     or to_regclass('marketing_hub.daily_metrics') is null
     or to_regprocedure('private_app.marketing_next_sync(text,timestamptz)') is null then
    raise exception 'meta_connect_v2_ads_reporting_preflight_failed';
  end if;
end;
$preflight$;

alter table meta_connect_v2.connections
  add column if not exists marketing_connection_id uuid
    references marketing_hub.connections(id) on delete set null,
  add column if not exists selected_external_account_id text;
alter table meta_connect_v2.connections
  drop constraint if exists meta_connect_v2_selected_account_check;
alter table meta_connect_v2.connections
  add constraint meta_connect_v2_selected_account_check
    check (
      selected_external_account_id is null
      or selected_external_account_id ~ '^[0-9]{1,40}$'
    );

create unique index if not exists meta_connect_v2_marketing_connection_uidx
  on meta_connect_v2.connections(marketing_connection_id)
  where marketing_connection_id is not null;

alter table meta_connect_v2.kill_switches
  drop constraint if exists kill_switches_capability_check;
alter table meta_connect_v2.kill_switches
  add constraint kill_switches_capability_check
  check (capability in (
    'oauth','deauthorization','data_deletion',
    'asset_discovery','account_selection','sync'
  ));

alter table meta_connect_v2.rollout_targets
  drop constraint if exists rollout_targets_capabilities_check1;
alter table meta_connect_v2.rollout_targets
  add constraint rollout_targets_capabilities_check1
  check (capabilities <@ array[
    'oauth','deauthorization','data_deletion',
    'asset_discovery','account_selection','sync'
  ]::text[]);

insert into meta_connect_v2.kill_switches(capability,enabled)
values ('asset_discovery',false),('account_selection',false),('sync',false)
on conflict (capability) do nothing;

-- Rotating or removing the single Vault token must update the linked reporting
-- connection before the old secret can disappear. Legacy rows can never be
-- linked, so the trigger cannot touch Reef or any existing manual connection.
create or replace function meta_connect_v2.propagate_credential_reference()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_marketing_connection_id uuid;
begin
  select connection.marketing_connection_id
  into v_marketing_connection_id
  from meta_connect_v2.connections connection
  where connection.id=coalesce(new.connection_id,old.connection_id);

  if v_marketing_connection_id is null then
    return coalesce(new,old);
  end if;

  if tg_op='DELETE' then
    update marketing_hub.connections
    set secret_refs='{}'::jsonb,status='disabled',next_sync_at=null,
        last_error_code=null,last_error_detail=null
    where id=v_marketing_connection_id
      and configuration ->> 'authSource'='meta_connect_v2';
    return old;
  end if;

  update marketing_hub.connections
  set secret_refs=jsonb_build_object('accessToken',new.vault_secret_id),
      status='draft',next_sync_at=null,last_error_code=null,last_error_detail=null
  where id=v_marketing_connection_id
    and configuration ->> 'authSource'='meta_connect_v2';
  return new;
end;
$$;

revoke all on function meta_connect_v2.propagate_credential_reference()
from public,anon,authenticated,service_role;

drop trigger if exists meta_connect_v2_credential_reference_propagation
on meta_connect_v2.credential_refs;
create trigger meta_connect_v2_credential_reference_propagation
after insert or update of vault_secret_id or delete
on meta_connect_v2.credential_refs
for each row execute function meta_connect_v2.propagate_credential_reference();

-- Reauthorization may reuse only the reporting connection created and linked
-- by V2. Any other Meta row remains a hard legacy boundary.
create or replace function meta_connect_v2.assert_oauth_allowed(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_owned_marketing_connection_id uuid;
begin
  if auth.uid() is null or private_app.current_subject_id() is null then
    raise exception 'forbidden';
  end if;
  if not exists (
    select 1 from core.tenants tenant
    where tenant.id=p_tenant_id and tenant.status in ('trial','active')
  ) then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    p_tenant_id,'tenant.meta_connect.manage'
  ) then raise exception 'forbidden'; end if;
  if not private_app.tenant_addon_enabled(
    p_tenant_id,'addon.integrations.social_connect'
  ) then raise exception 'addon_not_enabled'; end if;
  if not exists (
    select 1 from meta_connect_v2.rollout_targets rollout
    where rollout.tenant_id=p_tenant_id and rollout.status='pilot'
      and rollout.capabilities @> array['oauth']::text[]
  ) then raise exception 'meta_connect_v2_not_in_rollout'; end if;
  if not coalesce((
    select switch.enabled from meta_connect_v2.kill_switches switch
    where switch.capability='oauth'
  ),false) then raise exception 'meta_connect_v2_oauth_disabled'; end if;

  select connection.marketing_connection_id
  into v_owned_marketing_connection_id
  from meta_connect_v2.connections connection
  where connection.tenant_id=p_tenant_id;

  if exists (
    select 1 from marketing_hub.connections legacy
    where legacy.tenant_id=p_tenant_id and legacy.provider_key='meta'
      and legacy.id is distinct from v_owned_marketing_connection_id
  ) then raise exception 'legacy_meta_connection_present'; end if;
end;
$$;

revoke all on function meta_connect_v2.assert_oauth_allowed(uuid)
from public,anon,authenticated,service_role;

-- Authenticated gate for account discovery, selection, and synchronization.
create or replace function public.v1_tenant_meta_connect_v2_authorize_ads_action(
  p_tenant_slug text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant_id uuid;
  v_connection meta_connect_v2.connections%rowtype;
  v_actor_subject_id uuid;
  v_capability text:=lower(trim(coalesce(p_action,'')));
begin
  if v_capability not in ('asset_discovery','account_selection','sync') then
    raise exception 'meta_connect_v2_action_invalid';
  end if;
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug=p_tenant_slug and tenant.status in ('trial','active');
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if auth.uid() is null
     or not private_app.has_tenant_permission(
       v_tenant_id,'tenant.meta_connect.manage'
     ) then raise exception 'forbidden'; end if;
  if not private_app.tenant_addon_enabled(
    v_tenant_id,'addon.integrations.social_connect'
  ) then raise exception 'addon_not_enabled'; end if;
  if not exists (
    select 1 from meta_connect_v2.rollout_targets rollout
    where rollout.tenant_id=v_tenant_id and rollout.status='pilot'
      and rollout.capabilities @> array[v_capability]::text[]
  ) then raise exception 'meta_connect_v2_not_in_rollout'; end if;
  if not coalesce((
    select switch.enabled from meta_connect_v2.kill_switches switch
    where switch.capability=v_capability
  ),false) then raise exception 'meta_connect_v2_capability_disabled'; end if;

  select connection.* into v_connection
  from meta_connect_v2.connections connection
  where connection.tenant_id=v_tenant_id
  for update;
  if v_connection.id is null or v_connection.status<>'connected'
     or v_connection.token_expires_at<=now()
     or (
       v_connection.data_access_expires_at is not null
       and v_connection.data_access_expires_at<=now()
     ) then raise exception 'meta_connect_v2_reauthorization_required'; end if;

  if exists (
    select 1 from marketing_hub.connections legacy
    where legacy.tenant_id=v_tenant_id and legacy.provider_key='meta'
      and legacy.id is distinct from v_connection.marketing_connection_id
  ) then raise exception 'legacy_meta_connection_present'; end if;

  v_actor_subject_id:=private_app.current_subject_id();
  if v_actor_subject_id is null then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'tenantId',v_tenant_id,
    'connectionId',v_connection.id,
    'marketingConnectionId',v_connection.marketing_connection_id,
    'actorSubjectId',v_actor_subject_id,
    'action',v_capability
  );
end;
$$;

-- Service-only decryption boundary. Plaintext is returned only to the Edge
-- worker after the authenticated gate above; browser roles have no EXECUTE.
create or replace function public.v1_service_meta_connect_v2_token_context(
  p_connection_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_connection meta_connect_v2.connections%rowtype;
  v_secret_id uuid;
  v_access_token text;
begin
  select connection.* into v_connection
  from meta_connect_v2.connections connection
  where connection.id=p_connection_id;
  if v_connection.id is null or v_connection.status<>'connected'
     or v_connection.token_expires_at<=now()
     or (
       v_connection.data_access_expires_at is not null
       and v_connection.data_access_expires_at<=now()
     ) then raise exception 'meta_connect_v2_reauthorization_required'; end if;

  select credential.vault_secret_id into v_secret_id
  from meta_connect_v2.credential_refs credential
  where credential.connection_id=v_connection.id
    and credential.credential_type='user_access_token';
  select decrypted.decrypted_secret into v_access_token
  from vault.decrypted_secrets decrypted
  where decrypted.id=v_secret_id
    and decrypted.name like 'meta-connect-v2:'||v_connection.tenant_id::text||':%';
  if coalesce(length(v_access_token),0) not between 32 and 8192 then
    raise exception 'meta_connect_v2_credential_unavailable';
  end if;
  return jsonb_build_object(
    'connectionId',v_connection.id,
    'tenantId',v_connection.tenant_id,
    'accessToken',v_access_token,
    'tokenExpiresAt',v_connection.token_expires_at
  );
end;
$$;

-- The account object reaches this function only after the Edge worker has
-- verified it against /me/adaccounts using the current token and appsecret_proof.
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
  perform set_config('request.jwt.claims',coalesce(v_original_claims,''),true);
  perform set_config('request.jwt.claim.sub',coalesce(v_original_sub,''),true);

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

-- Dedicated authorization for the existing ads-sync worker. This preserves
-- Social Connect as an independent add-on and never requires Marketing Hub.
create or replace function public.v1_tenant_meta_connect_v2_authorize_sync(
  p_tenant_slug text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_auth jsonb;
  v_marketing marketing_hub.connections%rowtype;
begin
  if lower(trim(coalesce(p_action,''))) not in ('test_connection','sync_now') then
    raise exception 'marketing_action_invalid';
  end if;
  v_auth:=public.v1_tenant_meta_connect_v2_authorize_ads_action(
    p_tenant_slug,'sync'
  );
  select connection.* into v_marketing
  from marketing_hub.connections connection
  where connection.id=(v_auth->>'marketingConnectionId')::uuid
    and connection.provider_key='meta'
    and connection.configuration->>'authSource'='meta_connect_v2'
    and connection.status<>'disabled';
  if v_marketing.id is null then
    raise exception 'marketing_connection_not_found';
  end if;
  return jsonb_build_object(
    'tenantId',v_marketing.tenant_id,'connectionId',v_marketing.id,
    'providerKey','meta','action',lower(trim(p_action))
  );
end;
$$;

-- Compact Social Connect read model. It intentionally aggregates only the
-- selected account and campaign-level daily rows to avoid double counting.
create or replace function public.v1_tenant_meta_connect_v2_snapshot(
  p_tenant_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant_id uuid;
  v_connection meta_connect_v2.connections%rowtype;
  v_marketing marketing_hub.connections%rowtype;
  v_account marketing_hub.ad_accounts%rowtype;
  v_summary jsonb:='{}'::jsonb;
  v_campaigns jsonb:='[]'::jsonb;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug=p_tenant_slug and tenant.status in ('trial','active');
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not (
    private_app.has_tenant_permission(v_tenant_id,'tenant.meta_connect.read')
    or private_app.has_tenant_permission(v_tenant_id,'tenant.meta_connect.manage')
  ) then raise exception 'forbidden'; end if;

  select connection.* into v_connection
  from meta_connect_v2.connections connection
  where connection.tenant_id=v_tenant_id;
  if v_connection.marketing_connection_id is not null then
    select connection.* into v_marketing
    from marketing_hub.connections connection
    where connection.id=v_connection.marketing_connection_id
      and connection.tenant_id=v_tenant_id
      and connection.configuration->>'authSource'='meta_connect_v2';
    select account.* into v_account
    from marketing_hub.ad_accounts account
    where account.connection_id=v_marketing.id and account.is_selected
    order by account.updated_at desc limit 1;
  end if;

  if v_account.id is not null then
    select jsonb_build_object(
      'currency',v_account.currency,
      'impressions',coalesce(sum(metric.impressions),0)::bigint,
      'clicks',coalesce(sum(metric.clicks),0)::bigint,
      'linkClicks',coalesce(sum(metric.link_clicks),0)::bigint,
      'spendMinor',coalesce(sum(metric.spend_minor),0)::bigint,
      'platformLeads',round(coalesce(sum(metric.platform_leads),0),2),
      'platformConversions',round(coalesce(sum(metric.platform_conversions),0),2),
      'platformRevenueMinor',coalesce(sum(metric.platform_revenue_minor),0)::bigint,
      'videoViews',coalesce(sum(metric.video_views),0)::bigint,
      'ctr',case when coalesce(sum(metric.impressions),0)>0 then
        round(100.0*sum(metric.clicks)/sum(metric.impressions),2) end,
      'cpcMinor',case when coalesce(sum(metric.clicks),0)>0 then
        round(sum(metric.spend_minor)::numeric/sum(metric.clicks)) end,
      'from',current_date-29,'to',current_date
    ) into v_summary
    from marketing_hub.daily_metrics metric
    where metric.tenant_id=v_tenant_id
      and metric.ad_account_id=v_account.id
      and metric.entity_level='campaign'
      and metric.metric_date between current_date-29 and current_date;

    select coalesce(jsonb_agg(row.value order by row.spend_minor desc,row.name),'[]'::jsonb)
    into v_campaigns
    from (
      select campaign.name,
        coalesce(sum(metric.spend_minor),0)::bigint spend_minor,
        jsonb_build_object(
          'id',campaign.id,'externalCampaignId',campaign.external_campaign_id,
          'name',campaign.name,'objective',campaign.objective,
          'status',campaign.status,'effectiveStatus',campaign.effective_status,
          'currency',v_account.currency,
          'impressions',coalesce(sum(metric.impressions),0)::bigint,
          'clicks',coalesce(sum(metric.clicks),0)::bigint,
          'linkClicks',coalesce(sum(metric.link_clicks),0)::bigint,
          'spendMinor',coalesce(sum(metric.spend_minor),0)::bigint,
          'platformLeads',round(coalesce(sum(metric.platform_leads),0),2),
          'platformConversions',round(coalesce(sum(metric.platform_conversions),0),2),
          'platformRevenueMinor',coalesce(sum(metric.platform_revenue_minor),0)::bigint,
          'videoViews',coalesce(sum(metric.video_views),0)::bigint,
          'ctr',case when coalesce(sum(metric.impressions),0)>0 then
            round(100.0*sum(metric.clicks)/sum(metric.impressions),2) end,
          'cpcMinor',case when coalesce(sum(metric.clicks),0)>0 then
            round(sum(metric.spend_minor)::numeric/sum(metric.clicks)) end
        ) value
      from marketing_hub.campaigns campaign
      left join marketing_hub.daily_metrics metric
        on metric.campaign_id=campaign.id
       and metric.ad_account_id=v_account.id
       and metric.entity_level='campaign'
       and metric.metric_date between current_date-29 and current_date
      where campaign.tenant_id=v_tenant_id
        and campaign.ad_account_id=v_account.id
      group by campaign.id,campaign.name,campaign.external_campaign_id,
        campaign.objective,campaign.status,campaign.effective_status
      order by spend_minor desc,campaign.name
      limit 50
    ) row;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'addonEnabled',private_app.tenant_addon_enabled(
      v_tenant_id,'addon.integrations.social_connect'
    ),
    'rolloutEnabled',exists(
      select 1 from meta_connect_v2.rollout_targets rollout
      where rollout.tenant_id=v_tenant_id and rollout.status='pilot'
        and rollout.capabilities @> array['oauth']::text[]
    ),
    'oauthEnabled',coalesce((select enabled from meta_connect_v2.kill_switches where capability='oauth'),false),
    'assetDiscoveryEnabled',coalesce((select enabled from meta_connect_v2.kill_switches where capability='asset_discovery'),false),
    'accountSelectionEnabled',coalesce((select enabled from meta_connect_v2.kill_switches where capability='account_selection'),false),
    'syncEnabled',coalesce((select enabled from meta_connect_v2.kill_switches where capability='sync'),false),
    'legacyProtected',exists(
      select 1 from marketing_hub.connections legacy
      where legacy.tenant_id=v_tenant_id and legacy.provider_key='meta'
        and legacy.id is distinct from v_connection.marketing_connection_id
    ),
    'status',case when v_connection.status='connected' and (
      v_connection.token_expires_at<=now()
      or v_connection.data_access_expires_at<=now()
    ) then 'reauth_required' else v_connection.status end,
    'grantedScopes',v_connection.granted_scopes,
    'tokenExpiresAt',v_connection.token_expires_at,
    'dataAccessExpiresAt',v_connection.data_access_expires_at,
    'lastAuthorizedAt',v_connection.last_authorized_at,
    'selectedAccount',case when v_account.id is null then null else jsonb_build_object(
      'externalAccountId',v_account.external_account_id,'name',v_account.name,
      'currency',v_account.currency,'timezone',v_account.timezone,
      'status',v_account.status
    ) end,
    'sync',case when v_marketing.id is null then null else jsonb_build_object(
      'status',v_marketing.status,'lastSyncedAt',v_marketing.last_synced_at,
      'nextSyncAt',v_marketing.next_sync_at,'lastErrorCode',v_marketing.last_error_code
    ) end,
    'summary',v_summary,'campaigns',v_campaigns
  ));
end;
$$;

revoke execute on function public.v1_tenant_meta_connect_v2_authorize_ads_action(text,text)
from public,anon,authenticated;
revoke execute on function public.v1_tenant_meta_connect_v2_authorize_sync(text,text)
from public,anon,authenticated;
revoke execute on function public.v1_service_meta_connect_v2_token_context(uuid)
from public,anon,authenticated;
revoke execute on function public.v1_service_meta_connect_v2_bind_ad_account(uuid,uuid,jsonb)
from public,anon,authenticated;

grant execute on function public.v1_tenant_meta_connect_v2_authorize_ads_action(text,text)
to authenticated;
grant execute on function public.v1_tenant_meta_connect_v2_authorize_sync(text,text)
to authenticated;
grant execute on function public.v1_service_meta_connect_v2_token_context(uuid)
to service_role;
grant execute on function public.v1_service_meta_connect_v2_bind_ad_account(uuid,uuid,jsonb)
to service_role;

-- Snapshot grant is recreated defensively after CREATE OR REPLACE.
revoke execute on function public.v1_tenant_meta_connect_v2_snapshot(text)
from public,anon,authenticated;
grant execute on function public.v1_tenant_meta_connect_v2_snapshot(text)
to authenticated;

