begin;

do $preflight$
declare
  v_provider marketplace.payment_provider_configs%rowtype;
  v_version marketplace.paymob_credential_versions%rowtype;
begin
  select provider.* into v_provider
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  for update;

  if v_provider.provider_key is null
     or v_provider.environment <> 'live'
     or v_provider.credentials_environment <> 'live'
     or v_provider.checkout_mode <> 'redirect'
     or v_provider.supported_currencies <> array['SAR']::text[]
     or v_provider.public_config ->> 'region' <> 'ksa'
     or v_provider.public_config ->> 'integrationPath' <> 'quicklink'
     or v_provider.public_config ->> 'merchantAccountId'
       !~ '^[1-9][0-9]{0,29}$'
     or v_provider.public_config ->> 'integrationId'
       !~ '^[1-9][0-9]{0,29}$'
     or v_provider.status not in ('configured','active')
     or v_provider.rollout_mode not in ('observe_only','live')
     or v_provider.last_verified_at is null
     or not private_app.v3_payment_provider_bundle_complete(
       v_provider.provider_key,
       v_provider.environment,
       v_provider.credentials_environment,
       v_provider.required_secret_keys,
       v_provider.required_public_config_keys,
       v_provider.public_config
     )
     or not private_app.paymob_evidence_passed(
       v_provider.readiness_evidence,'credentials'
     )
     or not private_app.paymob_evidence_passed(
       v_provider.readiness_evidence,'intention_create'
     ) then
    raise exception 'paymob_automatic_rollout_provider_not_ready';
  end if;

  select version.* into v_version
  from marketplace.paymob_credential_versions version
  where version.provider_key = 'paymob'
    and version.environment = 'live'
    and version.status = 'active'
    and version.revoked_at is null
    and private_app.paymob_version_matches_provider_v2(
      version.id,'live',v_provider.public_config
    )
  order by version.created_at desc,version.id desc
  limit 1
  for share;

  if v_version.id is null
     or not private_app.paymob_required_secret_refs_valid_v2(
       v_version.id,'live','quicklink'
     )
     or not private_app.paymob_live_credential_material_valid_v2(
       v_version.id,'quicklink'
     )
     or (
       select count(*)
       from marketplace.paymob_credential_versions version
       where version.provider_key = 'paymob'
         and version.environment = 'live'
         and version.status = 'active'
         and version.revoked_at is null
     ) <> 1 then
    raise exception 'paymob_automatic_rollout_credential_not_ready';
  end if;

  if exists (
    select 1
    from marketplace.payment_attempts attempt
    where attempt.provider_key = 'paymob'
      and attempt.status in (
        'prepared','creating_intention','intention_created',
        'pending','unknown','quarantined'
      )
      and greatest(
        attempt.expires_at,
        coalesce(attempt.provider_expires_at,attempt.expires_at)
      ) > now()
  ) then
    raise exception 'paymob_automatic_rollout_active_checkout_must_drain';
  end if;
end
$preflight$;

alter table marketplace.payment_tenant_rollouts
  drop constraint if exists payment_tenant_rollouts_check;

alter table marketplace.payment_tenant_rollouts
  add constraint payment_tenant_rollouts_check
  check (
    status = 'disabled'
    or (
      status = 'enabled'
      and approved_at is not null
      and (
        approved_by_subject_id is not null
        or approval_code = 'automatic_all_tenants'
      )
    )
  ) not valid;

alter table marketplace.payment_tenant_rollouts
  validate constraint payment_tenant_rollouts_check;

create or replace function private_app.paymob_controlled_live_provider_ready_v1()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from marketplace.payment_provider_configs provider
    join marketplace.paymob_credential_versions version
      on version.provider_key = provider.provider_key
     and version.environment = 'live'
     and version.status = 'active'
     and version.revoked_at is null
     and private_app.paymob_version_matches_provider_v2(
       version.id,'live',provider.public_config
     )
    where provider.provider_key = 'paymob'
      and provider.environment = 'live'
      and provider.credentials_environment = 'live'
      and provider.status in ('configured','active')
      and provider.rollout_mode in ('observe_only','live')
      and provider.checkout_mode = 'redirect'
      and provider.supported_currencies = array['SAR']::text[]
      and provider.public_config ->> 'region' = 'ksa'
      and provider.public_config ->> 'integrationPath' = 'quicklink'
      and provider.public_config ->> 'merchantAccountId'
        ~ '^[1-9][0-9]{0,29}$'
      and provider.public_config ->> 'integrationId'
        ~ '^[1-9][0-9]{0,29}$'
      and provider.last_verified_at is not null
      and private_app.v3_payment_provider_bundle_complete(
        provider.provider_key,
        provider.environment,
        provider.credentials_environment,
        provider.required_secret_keys,
        provider.required_public_config_keys,
        provider.public_config
      )
      and private_app.paymob_evidence_passed(
        provider.readiness_evidence,'credentials'
      )
      and private_app.paymob_evidence_passed(
        provider.readiness_evidence,'intention_create'
      )
      and private_app.paymob_required_secret_refs_valid_v2(
        version.id,'live','quicklink'
      )
      and private_app.paymob_live_credential_material_valid_v2(
        version.id,'quicklink'
      )
      and (
        select count(*)
        from marketplace.paymob_credential_versions active_version
        where active_version.provider_key = 'paymob'
          and active_version.environment = 'live'
          and active_version.status = 'active'
          and active_version.revoked_at is null
      ) = 1
  )
$function$;

create or replace function private_app.paymob_controlled_live_eligible_v1(
  p_tenant_id uuid,
  p_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_environment = 'live'
    and private_app.paymob_controlled_live_provider_ready_v1()
    and exists (
      select 1
      from core.tenants tenant
      join marketplace.payment_tenant_rollouts rollout
        on rollout.tenant_id = tenant.id
       and rollout.provider_key = 'paymob'
       and rollout.environment = 'live'
       and rollout.status = 'enabled'
      where tenant.id = p_tenant_id
    )
$function$;

create or replace function private_app.paymob_live_canary_eligible_v1(
  p_tenant_id uuid,
  p_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- Compatibility alias retained for older audited payment functions.
  -- The policy is now controlled automatic Live enrollment, not one-tenant canary.
  select private_app.paymob_controlled_live_eligible_v1(
    p_tenant_id,p_environment
  )
$function$;

create or replace function private_app.paymob_tenant_checkout_eligible_v1(
  p_tenant_id uuid,
  p_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private_app.paymob_controlled_live_eligible_v1(
    p_tenant_id,p_environment
  ) or exists (
    select 1
    from core.tenants tenant
    join marketplace.payment_provider_configs provider
      on provider.provider_key = 'paymob'
    join marketplace.payment_tenant_rollouts rollout
      on rollout.tenant_id = tenant.id
     and rollout.provider_key = provider.provider_key
     and rollout.environment = provider.environment
     and rollout.status = 'enabled'
    join marketplace.paymob_credential_versions version
      on version.provider_key = provider.provider_key
     and version.environment = provider.environment
     and version.status = 'active'
     and version.revoked_at is null
     and private_app.paymob_version_matches_provider_v2(
       version.id,provider.environment,provider.public_config
     )
    where tenant.id = p_tenant_id
      and p_environment in ('sandbox','live')
      and provider.environment = p_environment
      and provider.credentials_environment = p_environment
      and provider.rollout_mode = p_environment
      and (
        (p_environment = 'sandbox' and provider.status = 'configured')
        or (p_environment = 'live' and provider.status = 'active')
      )
      and provider.last_verified_at is not null
      and provider.checkout_mode = 'redirect'
      and provider.supported_currencies = array['SAR']::text[]
      and provider.public_config ->> 'region' = 'ksa'
      and private_app.v3_payment_provider_bundle_complete(
        provider.provider_key,provider.environment,
        provider.credentials_environment,provider.required_secret_keys,
        provider.required_public_config_keys,provider.public_config
      )
      and (
        p_environment <> 'live'
        or private_app.paymob_live_credential_material_valid_v2(
          version.id,
          coalesce(provider.public_config ->> 'integrationPath','intention')
        )
      )
      and cardinality(private_app.paymob_missing_checks(
        provider.readiness_evidence,p_environment
      )) = 0
  )
$function$;

revoke all on function private_app.paymob_controlled_live_provider_ready_v1()
  from public,anon,authenticated,service_role;
revoke all on function private_app.paymob_controlled_live_eligible_v1(uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function private_app.paymob_live_canary_eligible_v1(uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function private_app.paymob_tenant_checkout_eligible_v1(uuid,text)
  from public,anon,authenticated,service_role;

create or replace function private_app.paymob_auto_enroll_tenant_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_environment text;
begin
  select provider.environment into v_environment
  from marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob';

  if v_environment in ('sandbox','live') then
    insert into marketplace.payment_tenant_rollouts(
      tenant_id,provider_key,environment,status,approval_code,
      requested_by_subject_id,requested_at,
      approved_by_subject_id,approved_at
    ) values (
      new.id,'paymob',v_environment,'enabled','automatic_all_tenants',
      null,null,null,now()
    )
    on conflict (tenant_id,provider_key,environment) do nothing;
  end if;

  return new;
end
$function$;

revoke all on function private_app.paymob_auto_enroll_tenant_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists zz_tenants_paymob_auto_enroll_after_insert
  on core.tenants;
create trigger zz_tenants_paymob_auto_enroll_after_insert
after insert on core.tenants
for each row execute function private_app.paymob_auto_enroll_tenant_v1();

with enrolled as (
  insert into marketplace.payment_tenant_rollouts(
    tenant_id,provider_key,environment,status,approval_code,
    requested_by_subject_id,requested_at,
    approved_by_subject_id,approved_at
  )
  select
    tenant.id,'paymob',provider.environment,'enabled',
    'automatic_all_tenants',null,null,null,now()
  from core.tenants tenant
  cross join marketplace.payment_provider_configs provider
  where provider.provider_key = 'paymob'
  on conflict (tenant_id,provider_key,environment) do update
  set status = 'enabled',
      approval_code = 'automatic_all_tenants',
      approved_at = coalesce(
        marketplace.payment_tenant_rollouts.approved_at,now()
      ),
      updated_at = now()
  returning id,tenant_id,environment
)
insert into audit_log.events(
  tenant_id,action,resource_type,resource_id,context
)
select
  enrolled.tenant_id,
  'marketplace.paymob.tenant_auto_enrolled',
  'payment_tenant_rollout',
  enrolled.id::text,
  jsonb_build_object(
    'environment',enrolled.environment,
    'policy','automatic_all_tenants',
    'existingAndFutureTenants',true,
    'secretReturned',false
  )
from enrolled;

do $patch_prepare$
declare
  v_definition text;
  v_old text;
begin
  select pg_get_functiondef(
    'public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'::regprocedure
  ) into v_definition;

  v_old := $old$  if v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills' then
    raise exception 'paymob_reef_skills_rollout_prohibited';
  end if;
$old$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,'');
  end if;

  v_old := $old$  if private_app.paymob_live_canary_eligible_v1(
       v_tenant.id,v_provider.environment
     )
     and v_order.total_minor > 50000 then
    raise exception 'paymob_live_canary_amount_limit';
  end if;
$old$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,'');
  end if;

  if position('paymob_reef_skills_rollout_prohibited' in v_definition) > 0
     or position('paymob_live_canary_amount_limit' in v_definition) > 0 then
    raise exception 'paymob_automatic_rollout_prepare_patch_failed';
  end if;

  execute v_definition;
end
$patch_prepare$;

do $patch_runtime$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.v1_service_paymob_runtime_config(uuid,text,text)'::regprocedure
  ) into v_definition;

  v_old := $old$     or v_tenant.id is null
     or v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills'
     or v_rollout.id is null
$old$;
  v_new := $new$     or v_tenant.id is null
     or v_rollout.id is null
$new$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,v_new);
  end if;

  if position('v_tenant.slug = ''reef-skills''' in v_definition) > 0
     or position('v_tenant.tenant_key = ''tenant-reef-skills''' in v_definition) > 0 then
    raise exception 'paymob_automatic_rollout_runtime_patch_failed';
  end if;

  execute v_definition;
end
$patch_runtime$;

do $patch_resume$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.v1_service_paymob_resume_checkout(uuid)'::regprocedure
  ) into v_definition;

  v_old := $old$     or v_tenant.id is null
     or v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills'
     or v_rollout.id is null
$old$;
  v_new := $new$     or v_tenant.id is null
     or v_rollout.id is null
$new$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,v_new);
  end if;

  if position('v_tenant.slug = ''reef-skills''' in v_definition) > 0
     or position('v_tenant.tenant_key = ''tenant-reef-skills''' in v_definition) > 0 then
    raise exception 'paymob_automatic_rollout_resume_patch_failed';
  end if;

  execute v_definition;
end
$patch_resume$;

do $patch_record$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.v1_service_paymob_record_intention(uuid,uuid,text,text,text,text,timestamptz,text,text,text)'::regprocedure
  ) into v_definition;

  v_old := $old$    if v_tenant.id is null
       or v_tenant.slug = 'reef-skills'
       or v_tenant.tenant_key = 'tenant-reef-skills' then
      v_gate_error_code := 'reef_skills_gate_closed_after_claim';
    elsif v_provider.provider_key is null
$old$;
  v_new := $new$    if v_tenant.id is null then
      v_gate_error_code := 'provider_gate_closed_after_claim';
    elsif v_provider.provider_key is null
$new$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,v_new);
  end if;

  if position('reef_skills_gate_closed_after_claim' in v_definition) > 0
     or position('v_tenant.slug = ''reef-skills''' in v_definition) > 0
     or position('v_tenant.tenant_key = ''tenant-reef-skills''' in v_definition) > 0 then
    raise exception 'paymob_automatic_rollout_record_patch_failed';
  end if;

  execute v_definition;
end
$patch_record$;

do $patch_rollout_action$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.v1_platform_paymob_tenant_rollout_action(uuid,text,boolean,text)'::regprocedure
  ) into v_definition;

  v_old := $old$  if v_tenant.slug = 'reef-skills'
     or v_tenant.tenant_key = 'tenant-reef-skills' then
    raise exception 'paymob_reef_skills_rollout_prohibited';
  end if;
$old$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,'');
  end if;

  v_old := $old$  v_live_validation := p_environment = 'live'
    and v_tenant.slug = 'modaar-training-center'
    and v_provider.environment = 'live'
    and v_provider.credentials_environment = 'live'
    and v_provider.status = 'configured'
    and v_provider.rollout_mode = 'observe_only'
    and v_provider.last_verified_at is not null
    and private_app.paymob_live_bundle_ready_v2();
$old$;
  v_new := $new$  v_live_validation := p_environment = 'live'
    and private_app.paymob_controlled_live_provider_ready_v1();
$new$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,v_new);
  end if;

  v_old := $old$    if v_live_validation and exists (
      select 1
      from marketplace.payment_tenant_rollouts other_rollout
      where other_rollout.provider_key = 'paymob'
        and other_rollout.environment = 'live'
        and other_rollout.status = 'enabled'
        and other_rollout.tenant_id <> p_tenant_id
    ) then
      raise exception 'paymob_live_canary_single_tenant_required';
    end if;

$old$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,'');
  end if;

  v_definition := replace(
    v_definition,'live_canary_approved','controlled_live_approved'
  );
  v_definition := replace(
    v_definition,'''liveValidationCanary''','''controlledLiveRollout'''
  );
  v_definition := replace(
    v_definition,'''reefSkillsExcluded'',true',
    '''automaticTenantEnrollment'',true'
  );

  if position('paymob_reef_skills_rollout_prohibited' in v_definition) > 0
     or position('paymob_live_canary_single_tenant_required' in v_definition) > 0
     or position('modaar-training-center' in v_definition) > 0 then
    raise exception 'paymob_automatic_rollout_action_patch_failed';
  end if;

  execute v_definition;
end
$patch_rollout_action$;

do $patch_readiness$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.v1_platform_paymob_readiness_snapshot()'::regprocedure
  ) into v_definition;

  v_old := $old$    'active',v_provider.status = 'active' and v_provider.rollout_mode = 'live',
    'nativeAdapterDeployed',true,'verifiedAt',v_provider.last_verified_at,
$old$;
  v_new := $new$    'active',(
      v_provider.status = 'active' and v_provider.rollout_mode = 'live'
    ) or private_app.paymob_controlled_live_provider_ready_v1(),
    'nativeAdapterDeployed',true,
    'automaticTenantEnrollment',true,
    'controlledLiveActive',private_app.paymob_controlled_live_provider_ready_v1(),
    'verifiedAt',v_provider.last_verified_at,
$new$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,v_new);
  end if;

  v_old := $old$          and tenant.slug is distinct from 'reef-skills'
          and tenant.tenant_key is distinct from 'tenant-reef-skills'
$old$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,'');
  end if;

  if position('automaticTenantEnrollment' in v_definition) = 0
     or position('controlledLiveActive' in v_definition) = 0
     or position('tenant.slug is distinct from ''reef-skills''' in v_definition) > 0 then
    raise exception 'paymob_automatic_rollout_readiness_patch_failed';
  end if;

  execute v_definition;
end
$patch_readiness$;

do $patch_tenant_delete$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.v1_platform_tenant_delete(uuid,text,text,text,uuid)'::regprocedure
  ) into v_definition;

  v_old := $old$  delete from audit_log.events item where item.tenant_id=v_tenant.id;

  delete from core.tenants tenant where tenant.id=v_tenant.id;
$old$;
  v_new := $new$  delete from audit_log.events item where item.tenant_id=v_tenant.id;

  -- Automatic payment rollout rows are configuration, not retained financial evidence.
  delete from marketplace.payment_tenant_rollouts item
  where item.tenant_id=v_tenant.id;

  delete from core.tenants tenant where tenant.id=v_tenant.id;
$new$;
  if position(v_old in v_definition) > 0 then
    v_definition := replace(v_definition,v_old,v_new);
  end if;

  if position(
    'delete from marketplace.payment_tenant_rollouts item' in v_definition
  ) = 0 then
    raise exception 'paymob_automatic_rollout_tenant_delete_patch_failed';
  end if;

  execute v_definition;
end
$patch_tenant_delete$;

comment on function private_app.paymob_controlled_live_provider_ready_v1() is
  'Fail-closed structural readiness gate for controlled Paymob Live checkout while full operational evidence continues to be collected.';
comment on function private_app.paymob_controlled_live_eligible_v1(uuid,text) is
  'Effective Paymob Live eligibility for automatically enrolled tenants with explicit per-tenant disable support.';
comment on function private_app.paymob_auto_enroll_tenant_v1() is
  'Automatically creates an enabled Paymob rollout row for every newly created tenant.';

insert into audit_log.events(
  action,resource_type,resource_id,context
) values (
  'marketplace.paymob.automatic_tenant_rollout_enabled',
  'payment_provider',
  'paymob',
  jsonb_build_object(
    'policy','automatic_all_tenants',
    'existingTenantCount',(select count(*) from core.tenants),
    'enabledLiveTenantCount',(
      select count(*)
      from marketplace.payment_tenant_rollouts
      where provider_key='paymob'
        and environment='live'
        and status='enabled'
    ),
    'futureTenantTrigger','zz_tenants_paymob_auto_enroll_after_insert',
    'controlledLiveProviderReady',
      private_app.paymob_controlled_live_provider_ready_v1(),
    'fullOperationalEvidenceStillRequired',true,
    'secretReturned',false
  )
);

do $postflight$
declare
  v_tenants bigint;
  v_enabled bigint;
begin
  select count(*) into v_tenants from core.tenants;
  select count(*) into v_enabled
  from marketplace.payment_tenant_rollouts rollout
  where rollout.provider_key='paymob'
    and rollout.environment='live'
    and rollout.status='enabled';

  if not private_app.paymob_controlled_live_provider_ready_v1()
     or v_enabled <> v_tenants
     or exists (
       select 1
       from core.tenants tenant
       where not private_app.paymob_tenant_checkout_eligible_v1(
         tenant.id,'live'
       )
     )
     or not exists (
       select 1 from pg_trigger trigger
       where trigger.tgrelid='core.tenants'::regclass
         and trigger.tgname='zz_tenants_paymob_auto_enroll_after_insert'
         and not trigger.tgisinternal
         and trigger.tgenabled <> 'D'
     ) then
    raise exception 'paymob_automatic_rollout_postflight_failed';
  end if;
end
$postflight$;

commit;
