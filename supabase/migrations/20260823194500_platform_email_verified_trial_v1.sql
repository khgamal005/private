begin;

alter table platform.registration_requests
  add column if not exists activation_mode text not null default 'manual_review'
    check (activation_mode in ('manual_review','email_verified_trial')),
  add column if not exists trust_status text not null default 'pending_review'
    check (trust_status in ('pending_review','under_review','trusted','restricted')),
  add column if not exists email_confirmation_token_hash text
    check (
      email_confirmation_token_hash is null
      or email_confirmation_token_hash ~ '^[a-f0-9]{64}$'
    ),
  add column if not exists email_confirmation_expires_at timestamptz,
  add column if not exists email_confirmation_sent_at timestamptz,
  add column if not exists email_confirmed_at timestamptz;

-- Rows that existed before this feature followed the manual workflow. Preserve
-- their completed review meaning instead of placing them in the new trust queue.
update platform.registration_requests request
set trust_status=case request.status
  when 'under_review' then 'under_review'
  when 'approved' then 'trusted'
  when 'converted' then 'trusted'
  when 'rejected' then 'restricted'
  else 'pending_review'
end
where request.activation_mode='manual_review';

create unique index if not exists platform_registration_confirmation_token_idx
on platform.registration_requests(email_confirmation_token_hash)
where email_confirmation_token_hash is not null;

create index if not exists platform_registration_trust_queue_idx
on platform.registration_requests(trust_status,created_at)
where status='converted';

create table if not exists platform.registration_settings (
  singleton boolean primary key default true check (singleton),
  activation_mode text not null default 'manual_review'
    check (activation_mode in ('manual_review','email_verified_trial')),
  email_confirmation_ttl_minutes integer not null default 60
    check (email_confirmation_ttl_minutes between 15 and 1440),
  trial_plan_key text not null default 'free'
    check (trial_plan_key ~ '^[a-z0-9_]+$'),
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists platform.registration_identity_claims (
  identifier_type text not null
    check (identifier_type in ('commercial','national','tvtc')),
  identifier_hash text not null check (identifier_hash ~ '^[a-f0-9]{64}$'),
  request_id uuid
    references platform.registration_requests(id) on delete restrict,
  tenant_id uuid not null references core.tenants(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (identifier_type,identifier_hash)
);

create index if not exists platform_registration_identity_tenant_idx
on platform.registration_identity_claims(tenant_id);

-- Reserve identifiers already attached to a tenant before public auto-activation
-- exists. A null request_id means the identifier came from an established tenant,
-- not from the public registration flow.
-- Some non-production environments predate accounting_core.  Keep the
-- expand migration portable and fail closed: only import exact Saudi CRs
-- when the authoritative legacy relation is actually present.  Existing
-- account detection remains the primary guard for established tenants.
do $registration_existing_claim_backfill$
begin
  if to_regclass('accounting_core.tenant_profiles') is not null then
    execute $sql$
      insert into platform.registration_identity_claims(
        identifier_type,identifier_hash,request_id,tenant_id
      )
      select
        'commercial',
        encode(extensions.digest(
          'commercial:'||trim(profile.commercial_registration_number),
          'sha256'
        ),'hex'),
        null,
        profile.tenant_id
      from accounting_core.tenant_profiles profile
      where trim(profile.commercial_registration_number) ~ '^[0-9]{10}$'
        and trim(profile.commercial_registration_number) !~ '^([0-9])\1{9}$'
      on conflict (identifier_type,identifier_hash) do nothing
    $sql$;
  end if;
end
$registration_existing_claim_backfill$;

insert into platform.registration_settings(singleton)
values (true)
on conflict (singleton) do nothing;

alter table platform.registration_settings enable row level security;
alter table platform.registration_identity_claims enable row level security;
revoke all on table platform.registration_settings
from public,anon,authenticated;
grant select on table platform.registration_settings to service_role;
revoke all on table platform.registration_identity_claims
from public,anon,authenticated;
grant select,insert on table platform.registration_identity_claims to service_role;

alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check;
alter table platform.registration_request_events
  add constraint registration_request_events_action_check check (action in (
    'submitted','imported','email_confirmation_sent','email_confirmed',
    'start_review','approve','reject','reopen','provision','auto_provision',
    'trust_start','trust_approve','trust_restrict'
  ));

create or replace function private_app.link_email_verified_tenant_user(
  p_tenant_id uuid,
  p_full_name text,
  p_email text,
  p_role_key text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_auth_user_id uuid;
  v_subject_id uuid;
  v_subject_status text;
  v_membership_id uuid;
  v_role_id uuid;
begin
  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(auth_user.email)=lower(trim(p_email))
    and auth_user.email_confirmed_at is not null
  limit 1;
  if v_auth_user_id is null then
    return jsonb_build_object('linked',false);
  end if;

  select subject.id,subject.status
  into v_subject_id,v_subject_status
  from access_control.subjects subject
  where subject.auth_user_id=v_auth_user_id
  limit 1;
  if v_subject_id is not null and v_subject_status<>'active' then
    return jsonb_build_object('linked',false,'blocked',true);
  end if;
  if v_subject_id is null then
    insert into access_control.subjects(
      auth_user_id,email,full_name,status,must_change_password
    ) values (
      v_auth_user_id,lower(trim(p_email)),trim(p_full_name),'active',false
    ) returning id into v_subject_id;
  end if;

  select role.id into v_role_id
  from access_control.roles role
  where role.scope='tenant'
    and role.role_key=p_role_key
    and (role.tenant_id is null or role.tenant_id=p_tenant_id)
  order by (role.tenant_id=p_tenant_id) desc
  limit 1;
  if v_role_id is null then raise exception 'invalid_role'; end if;

  insert into access_control.memberships(subject_id,tenant_id,scope,status)
  values (v_subject_id,p_tenant_id,'tenant','active')
  on conflict (subject_id,tenant_id) where scope='tenant' do nothing
  returning id into v_membership_id;
  if v_membership_id is null then
    select membership.id into v_membership_id
    from access_control.memberships membership
    where membership.subject_id=v_subject_id
      and membership.tenant_id=p_tenant_id
      and membership.scope='tenant'
      and membership.status='active';
  end if;
  if v_membership_id is null then
    return jsonb_build_object('linked',false,'blocked',true);
  end if;

  insert into access_control.membership_roles(membership_id,role_id)
  values (v_membership_id,v_role_id)
  on conflict do nothing;
  return jsonb_build_object(
    'linked',true,
    'subjectId',v_subject_id,
    'membershipId',v_membership_id
  );
end;
$$;

revoke all on function private_app.link_email_verified_tenant_user(
  uuid,text,text,text
) from public,anon,authenticated;

create or replace function private_app.provision_tenant_core(
  p_display_name text,
  p_legal_name text,
  p_slug text,
  p_country_code text,
  p_timezone text,
  p_plan_key text,
  p_owner_name text,
  p_owner_email text,
  p_hostname text,
  p_link_policy text,
  p_invited_by_subject_id uuid,
  p_tenant_settings jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_organization_id uuid;
  v_tenant_id uuid;
  v_plan_id uuid;
  v_hostname text;
  v_owner_email text;
  v_owner_link jsonb;
  v_invitation_token text;
  v_invitation_id uuid;
  v_domain_id uuid;
begin
  if p_display_name is null or length(trim(p_display_name))<2 then
    raise exception 'display_name_required';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid_slug';
  end if;
  if exists(select 1 from core.tenants tenant where tenant.slug=p_slug) then
    raise exception 'slug_exists';
  end if;
  if p_owner_name is null or length(trim(p_owner_name))<2 then
    raise exception 'owner_name_required';
  end if;
  if p_link_policy not in ('platform_admin','verified_email') then
    raise exception 'invalid_provision_link_policy';
  end if;
  if p_tenant_settings is null or jsonb_typeof(p_tenant_settings)<>'object' then
    raise exception 'invalid_tenant_settings';
  end if;

  v_owner_email:=lower(trim(coalesce(p_owner_email,'')));
  if v_owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_owner_email';
  end if;
  select plan.id into v_plan_id
  from catalog.plans plan
  where plan.plan_key=coalesce(nullif(trim(p_plan_key),''),'free')
    and plan.status='active'
  limit 1;
  if v_plan_id is null then raise exception 'plan_not_found'; end if;

  v_hostname:=lower(trim(coalesce(p_hostname,'')));
  if v_hostname<>'' then
    v_hostname:=regexp_replace(v_hostname,'\.$','');
    if v_hostname !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' then
      raise exception 'invalid_hostname';
    end if;
    if exists(select 1 from core.domains domain where domain.hostname=v_hostname) then
      raise exception 'domain_exists';
    end if;
  end if;

  insert into core.organizations(
    organization_key,legal_name,display_name,country_code
  ) values (
    'org-'||p_slug,
    coalesce(nullif(trim(p_legal_name),''),trim(p_display_name)),
    trim(p_display_name),
    upper(coalesce(nullif(trim(p_country_code),''),'SA'))
  ) returning id into v_organization_id;

  insert into core.tenants(
    organization_id,tenant_key,slug,name,legal_name,status,
    country_code,timezone,settings
  ) values (
    v_organization_id,'tenant-'||p_slug,p_slug,trim(p_display_name),
    coalesce(nullif(trim(p_legal_name),''),trim(p_display_name)),'trial',
    upper(coalesce(nullif(trim(p_country_code),''),'SA')),
    coalesce(nullif(trim(p_timezone),''),'Asia/Riyadh'),p_tenant_settings
  ) returning id into v_tenant_id;

  -- A newly activated workspace must receive every module explicitly included
  -- in its selected plan, in addition to the platform defaults. Some modules
  -- (for example the website/CMS) are intentionally not enabled by default.
  insert into core.tenant_modules(tenant_id,module_id,enabled,enabled_at)
  select v_tenant_id,module.id,true,now()
  from core.modules module
  where module.status in ('active','beta')
    and (
      module.enabled_by_default
      or exists(
        select 1
        from catalog.plan_features plan_feature
        join catalog.features feature on feature.id=plan_feature.feature_id
        where plan_feature.plan_id=v_plan_id
          and feature.feature_key='module.'||module.module_key
          and feature.status in ('active','beta')
          and feature.value_type='boolean'
          and plan_feature.value='true'::jsonb
      )
    )
  on conflict (tenant_id,module_id) do update
  set enabled=true,
      enabled_at=coalesce(core.tenant_modules.enabled_at,excluded.enabled_at),
      updated_at=now();

  insert into catalog.subscriptions(tenant_id,plan_id,status)
  values (v_tenant_id,v_plan_id,'trialing');

  if v_hostname<>'' then
    insert into core.domains(
      tenant_id,hostname,domain_type,status,is_primary
    ) values (
      v_tenant_id,v_hostname,
      case when v_hostname=p_slug||'.marktone.sa'
        then 'subdomain' else 'custom' end,
      'pending',true
    ) returning id into v_domain_id;
  end if;

  v_owner_link:=case when p_link_policy='verified_email'
    then private_app.link_email_verified_tenant_user(
      v_tenant_id,trim(p_owner_name),v_owner_email,'tenant_owner'
    )
    else private_app.link_existing_tenant_user(
      v_tenant_id,trim(p_owner_name),v_owner_email,'tenant_owner'
    ) end;

  if coalesce((v_owner_link->>'blocked')::boolean,false) then
    raise exception 'registration_owner_account_blocked';
  end if;

  if not coalesce((v_owner_link->>'linked')::boolean,false) then
    v_invitation_token:=encode(extensions.gen_random_bytes(32),'hex');
    insert into access_control.tenant_invitations(
      tenant_id,email,full_name,role_key,token_hash,invited_by_subject_id
    ) values (
      v_tenant_id,v_owner_email,trim(p_owner_name),'tenant_owner',
      encode(extensions.digest(v_invitation_token,'sha256'),'hex'),
      p_invited_by_subject_id
    ) returning id into v_invitation_id;
  end if;

  return jsonb_build_object(
    'id',v_tenant_id,
    'slug',p_slug,
    'status','trial',
    'planKey',coalesce(nullif(trim(p_plan_key),''),'free'),
    'domain',case when v_domain_id is null then null else jsonb_build_object(
      'id',v_domain_id,'hostname',v_hostname,'status','pending'
    ) end,
    'owner',jsonb_build_object(
      'name',trim(p_owner_name),
      'email',v_owner_email,
      'status',case when coalesce((v_owner_link->>'linked')::boolean,false)
        then 'linked' else 'invited' end,
      'invitationId',v_invitation_id,
      'invitationToken',v_invitation_token
    )
  );
end;
$$;

revoke all on function private_app.provision_tenant_core(
  text,text,text,text,text,text,text,text,text,text,uuid,jsonb
) from public,anon,authenticated;

create or replace function public.v2_platform_provision_tenant(
  p_display_name text,
  p_legal_name text,
  p_slug text,
  p_country_code text,
  p_timezone text,
  p_plan_key text,
  p_owner_name text,
  p_owner_email text,
  p_hostname text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_result jsonb;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_result:=private_app.provision_tenant_core(
    p_display_name,p_legal_name,p_slug,p_country_code,p_timezone,p_plan_key,
    p_owner_name,p_owner_email,p_hostname,'platform_admin',
    private_app.current_subject_id(),'{}'::jsonb
  );
  perform private_app.write_audit(
    'tenant.provisioned','tenant',v_result->>'id',(v_result->>'id')::uuid,
    jsonb_strip_nulls(jsonb_build_object(
      'slug',v_result->>'slug',
      'name',trim(p_display_name),
      'planKey',v_result->>'planKey',
      'ownerEmail',lower(trim(p_owner_email)),
      'ownerLinked',v_result#>>'{owner,status}'='linked',
      'domain',nullif(lower(trim(coalesce(p_hostname,''))),'')
    ))
  );
  return v_result;
end;
$$;

create or replace function public.v1_platform_registration_policy_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  return (
    select jsonb_build_object(
      'activationMode',setting.activation_mode,
      'emailConfirmationTtlMinutes',setting.email_confirmation_ttl_minutes,
      'trialPlanKey',setting.trial_plan_key,
      'updatedAt',setting.updated_at,
      'updatedBy',subject.full_name
    )
    from platform.registration_settings setting
    left join access_control.subjects subject
      on subject.id=setting.updated_by_subject_id
    where setting.singleton
  );
end;
$$;

create or replace function public.v1_platform_registration_policy_save(
  p_activation_mode text,
  p_email_confirmation_ttl_minutes integer,
  p_trial_plan_key text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_mode text:=trim(coalesce(p_activation_mode,''));
  v_ttl integer:=coalesce(p_email_confirmation_ttl_minutes,60);
  v_plan_key text:=lower(trim(coalesce(p_trial_plan_key,'free')));
  v_subject uuid;
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  if v_mode not in ('manual_review','email_verified_trial') then
    raise exception 'registration_activation_mode_invalid';
  end if;
  if v_ttl not between 15 and 1440 then
    raise exception 'registration_confirmation_ttl_invalid';
  end if;
  if not exists(
    select 1 from catalog.plans plan
    where plan.plan_key=v_plan_key and plan.status='active'
  ) then raise exception 'plan_not_found'; end if;
  v_subject:=private_app.current_subject_id();
  update platform.registration_settings
  set activation_mode=v_mode,
      email_confirmation_ttl_minutes=v_ttl,
      trial_plan_key=v_plan_key,
      updated_by_subject_id=v_subject,
      updated_at=now()
  where singleton;
  perform private_app.write_audit(
    'platform.registration_policy.saved','registration_policy','default',null,
    jsonb_build_object(
      'activationMode',v_mode,
      'emailConfirmationTtlMinutes',v_ttl,
      'trialPlanKey',v_plan_key
    )
  );
  return public.v1_platform_registration_policy_snapshot();
end;
$$;

create or replace function public.v1_public_submit_registration_request(
  p_payload jsonb,
  p_ip_hash text,
  p_user_agent_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_state text:=trim(coalesce(p_payload->>'institutionState',''));
  v_account_id uuid;
  v_name text:=trim(coalesce(p_payload->>'institutionName',''));
  v_contact_name text:=trim(coalesce(p_payload->>'contactName',''));
  v_contact_title text:=trim(coalesce(p_payload->>'contactJobTitle',''));
  v_contact_email text:=lower(trim(coalesce(p_payload->>'contactEmail','')));
  v_contact_phone text:=trim(coalesce(p_payload->>'contactPhone',''));
  v_commercial text:=nullif(regexp_replace(
    coalesce(p_payload->>'commercialRegistration',''),'[^0-9]','','g'
  ),'');
  v_national text:=nullif(regexp_replace(
    coalesce(p_payload->>'nationalRegistration',''),'[^0-9]','','g'
  ),'');
  v_tvtc text:=nullif(trim(coalesce(p_payload->>'tvtcLicenseNumber','')),'');
  v_duplicate platform.registration_requests%rowtype;
  v_request platform.registration_requests%rowtype;
  v_reference text;
  v_attempt integer;
  v_mode text;
  v_ttl integer;
  v_token text;
  v_token_hash text;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'registration_payload_invalid';
  end if;
  if v_state not in ('existing','new') then raise exception 'invalid_institution_state'; end if;
  if coalesce((p_payload->>'tvtcAcknowledged')::boolean,false) is not true
     or coalesce((p_payload->>'privacyConsent')::boolean,false) is not true then
    raise exception 'consent_required';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
     or (p_user_agent_hash is not null and p_user_agent_hash !~ '^[a-f0-9]{64}$') then
    raise exception 'registration_fingerprint_invalid';
  end if;
  if char_length(v_name) not between 2 and 240 then raise exception 'institution_name_required'; end if;
  if char_length(v_contact_name) not between 2 and 160 then raise exception 'contact_name_required'; end if;
  if char_length(v_contact_title) not between 2 and 160 then raise exception 'job_title_required'; end if;
  if v_contact_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(v_contact_email)>240 then raise exception 'invalid_email'; end if;
  if char_length(v_contact_phone) not between 8 and 24 then raise exception 'invalid_phone'; end if;
  if (v_commercial is not null and char_length(v_commercial)>24)
     or (v_national is not null and char_length(v_national)>24)
     or (v_tvtc is not null and char_length(v_tvtc)>80) then
    raise exception 'registration_identifier_invalid';
  end if;

  if nullif(trim(coalesce(p_payload->>'accountId','')),'') is not null then
    if (p_payload->>'accountId') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
      raise exception 'invalid_external_account';
    end if;
    v_account_id:=(p_payload->>'accountId')::uuid;
  end if;
  if v_state='existing' and v_account_id is null then raise exception 'institution_required'; end if;
  if v_state='new' and v_account_id is not null then
    raise exception 'invalid_external_account';
  end if;

  select setting.activation_mode,setting.email_confirmation_ttl_minutes
  into v_mode,v_ttl
  from platform.registration_settings setting where setting.singleton;
  v_mode:=case when v_state='new' then coalesce(v_mode,'manual_review')
    else 'manual_review' end;
  if v_mode='email_verified_trial' and (
    (v_commercial is null and v_national is null and v_tvtc is null)
    or
    (v_commercial is not null and exists(
      select 1 from platform.registration_identity_claims claim
      where claim.identifier_type='commercial'
        and claim.identifier_hash=encode(
          extensions.digest('commercial:'||v_commercial,'sha256'),'hex'
        )
    ))
    or (v_national is not null and exists(
      select 1 from platform.registration_identity_claims claim
      where claim.identifier_type='national'
        and claim.identifier_hash=encode(
          extensions.digest('national:'||v_national,'sha256'),'hex'
        )
    ))
    or (v_tvtc is not null and exists(
      select 1 from platform.registration_identity_claims claim
      where claim.identifier_type='tvtc'
        and claim.identifier_hash=encode(
          extensions.digest('tvtc:'||lower(v_tvtc),'sha256'),'hex'
        )
    ))
  ) then
    v_mode:='manual_review';
  end if;

  select request.* into v_duplicate
  from platform.registration_requests request
  where lower(request.contact_email)=v_contact_email
    and request.created_at>=now()-interval '24 hours'
    and (
      (v_account_id is not null and request.external_account_id=v_account_id)
      or (v_account_id is null and request.institution_state='new')
    )
  order by request.created_at desc limit 1;

  if v_duplicate.id is not null then
    if v_mode='email_verified_trial'
       and v_duplicate.activation_mode='email_verified_trial'
       and v_duplicate.email_confirmed_at is null
       and v_duplicate.status='pending_review' then
      if v_duplicate.email_confirmation_sent_at>now()-interval '2 minutes'
         and v_duplicate.email_confirmation_expires_at>now() then
        return jsonb_build_object(
          'duplicate',true,'reference',v_duplicate.request_reference,
          'status',v_duplicate.status,'activationMode',v_duplicate.activation_mode,
          'confirmationRequired',true,'confirmationAlreadySent',true
        );
      end if;
      v_token:=encode(extensions.gen_random_bytes(32),'hex');
      v_token_hash:=encode(extensions.digest(v_token,'sha256'),'hex');
      update platform.registration_requests
      set email_confirmation_token_hash=v_token_hash,
          email_confirmation_expires_at=now()+make_interval(mins=>coalesce(v_ttl,60)),
          email_confirmation_sent_at=null,
          version=version+1
      where id=v_duplicate.id
      returning * into v_duplicate;
      return jsonb_build_object(
        'duplicate',true,'reference',v_duplicate.request_reference,
        'status',v_duplicate.status,'activationMode',v_duplicate.activation_mode,
        'confirmationRequired',true,'requestId',v_duplicate.id,
        'contactEmail',v_duplicate.contact_email,
        '_confirmationToken',v_token
      );
    end if;
    return jsonb_build_object(
      'duplicate',true,'reference',v_duplicate.request_reference,
      'status',v_duplicate.status,'activationMode',v_duplicate.activation_mode,
      'confirmationRequired',false,'message','request_already_received'
    );
  end if;

  for v_attempt in 1..8 loop
    v_reference:='MT-'||to_char(current_date,'YYYYMMDD')||'-'||upper(substr(
      replace(gen_random_uuid()::text,'-',''),1,6
    ));
    exit when not exists(
      select 1 from platform.registration_requests request
      where request.request_reference=v_reference
    );
  end loop;
  if exists(select 1 from platform.registration_requests request
    where request.request_reference=v_reference) then
    raise exception 'registration_reference_unavailable';
  end if;

  if v_mode='email_verified_trial' then
    v_token:=encode(extensions.gen_random_bytes(32),'hex');
    v_token_hash:=encode(extensions.digest(v_token,'sha256'),'hex');
  end if;
  insert into platform.registration_requests(
    request_reference,source,external_account_id,institution_state,
    institution_name,commercial_registration,national_registration,
    tvtc_license_number,contact_name,contact_job_title,contact_email,
    contact_phone,tvtc_notice_acknowledged,privacy_consent_at,
    request_ip_hash,user_agent_hash,activation_mode,trust_status,
    email_confirmation_token_hash,email_confirmation_expires_at,metadata
  ) values (
    v_reference,'odeir_public_registration',v_account_id,v_state,
    v_name,v_commercial,v_national,v_tvtc,v_contact_name,v_contact_title,
    v_contact_email,v_contact_phone,true,now(),p_ip_hash,p_user_agent_hash,
    v_mode,'pending_review',v_token_hash,
    case when v_token_hash is null then null
      else now()+make_interval(mins=>coalesce(v_ttl,60)) end,
    jsonb_build_object(
      'page','registration-modal','locale','ar-SA','submittedAt',now()
    )
  ) returning * into v_request;
  insert into platform.registration_request_events(
    request_id,action,to_status,metadata
  ) values (
    v_request.id,'submitted',v_request.status,
    jsonb_build_object(
      'source',v_request.source,'activationMode',v_request.activation_mode
    )
  );
  return jsonb_build_object(
    'duplicate',false,'reference',v_request.request_reference,
    'status',v_request.status,'activationMode',v_request.activation_mode,
    'confirmationRequired',v_token is not null,
    'requestId',v_request.id,
    'contactEmail',case when v_token is null then null else v_request.contact_email end,
    '_confirmationToken',v_token,
    'expectedResponse',case when v_token is null then 'one_business_day'
      else 'email_confirmation' end
  );
end;
$$;

create or replace function public.v1_registration_mark_confirmation_sent(
  p_request_id uuid,
  p_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  v_updated integer;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_invalid';
  end if;
  update platform.registration_requests request
  set email_confirmation_sent_at=now()
  where request.id=p_request_id
    and request.activation_mode='email_verified_trial'
    and request.email_confirmation_token_hash=p_token_hash
    and request.email_confirmed_at is null;
  get diagnostics v_updated=row_count;
  if v_updated=1 then
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status
    ) select request.id,'email_confirmation_sent',request.status,request.status
      from platform.registration_requests request where request.id=p_request_id;
  end if;
  return v_updated=1;
end;
$$;

create or replace function public.v1_registration_confirm_email_and_provision(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_hash text;
  v_request platform.registration_requests%rowtype;
  v_plan_key text;
  v_current_mode text;
  v_slug text;
  v_provisioning jsonb;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    raise exception 'registration_confirmation_invalid';
  end if;
  v_hash:=encode(extensions.digest(p_token,'sha256'),'hex');
  select request.* into v_request
  from platform.registration_requests request
  where request.email_confirmation_token_hash=v_hash
    and request.activation_mode='email_verified_trial'
    and request.institution_state='new'
    and request.external_account_id is null
    and request.email_confirmed_at is null
    and request.email_confirmation_expires_at>now()
  for update;
  if v_request.id is null then raise exception 'registration_confirmation_invalid'; end if;
  if v_request.provisioned_tenant_id is not null then
    raise exception 'registration_confirmation_already_used';
  end if;

  select setting.activation_mode,setting.trial_plan_key
  into v_current_mode,v_plan_key
  from platform.registration_settings setting
  where setting.singleton
  for share;
  if v_current_mode<>'email_verified_trial' then
    update platform.registration_requests
    set activation_mode='manual_review',
        email_confirmed_at=now(),
        email_confirmation_token_hash=null,
        email_confirmation_expires_at=null,
        version=version+1,
        metadata=metadata||jsonb_build_object(
          'emailConfirmedAt',now(),
          'manualHoldReason','automatic_activation_disabled'
        )
    where id=v_request.id
    returning * into v_request;
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status,metadata
    ) values (
      v_request.id,'email_confirmed','pending_review','pending_review',
      jsonb_build_object('manualReviewRequired',true,'killSwitchApplied',true)
    );
    return jsonb_build_object(
      'reference',v_request.request_reference,
      'manualReviewRequired',true,
      'trustStatus','pending_review'
    );
  end if;

  -- Re-evaluate official identity ownership at the moment of confirmation. This
  -- closes the window between request submission and the explicit email click.
  if (
    (nullif(regexp_replace(v_request.commercial_registration,'[^0-9]','','g'),'') is null
      and nullif(regexp_replace(v_request.national_registration,'[^0-9]','','g'),'') is null
      and nullif(lower(trim(v_request.tvtc_license_number)),'') is null)
    or exists(
      select 1
      from platform.registration_identity_claims claim
      where (
        nullif(regexp_replace(v_request.commercial_registration,'[^0-9]','','g'),'') is not null
        and claim.identifier_type='commercial'
        and claim.identifier_hash=encode(extensions.digest(
          'commercial:'||regexp_replace(v_request.commercial_registration,'[^0-9]','','g'),
          'sha256'
        ),'hex')
      ) or (
        nullif(regexp_replace(v_request.national_registration,'[^0-9]','','g'),'') is not null
        and claim.identifier_type='national'
        and claim.identifier_hash=encode(extensions.digest(
          'national:'||regexp_replace(v_request.national_registration,'[^0-9]','','g'),
          'sha256'
        ),'hex')
      ) or (
        nullif(lower(trim(v_request.tvtc_license_number)),'') is not null
        and claim.identifier_type='tvtc'
        and claim.identifier_hash=encode(extensions.digest(
          'tvtc:'||lower(trim(v_request.tvtc_license_number)),
          'sha256'
        ),'hex')
      )
    )
  ) then
    update platform.registration_requests
    set activation_mode='manual_review',
        email_confirmed_at=now(),
        email_confirmation_token_hash=null,
        email_confirmation_expires_at=null,
        version=version+1,
        metadata=metadata||jsonb_build_object(
          'emailConfirmedAt',now(),
          'manualHoldReason','official_identifier_requires_review'
        )
    where id=v_request.id
    returning * into v_request;
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status,metadata
    ) values (
      v_request.id,'email_confirmed','pending_review','pending_review',
      jsonb_build_object('manualReviewRequired',true,'identityGuardApplied',true)
    );
    return jsonb_build_object(
      'reference',v_request.request_reference,
      'manualReviewRequired',true,
      'trustStatus','pending_review'
    );
  end if;

  if exists(
    select 1
    from auth.users auth_user
    join access_control.subjects subject
      on subject.auth_user_id=auth_user.id
    where lower(auth_user.email)=lower(v_request.contact_email)
      and subject.status<>'active'
  ) then
    update platform.registration_requests
    set activation_mode='manual_review',
        email_confirmed_at=now(),
        email_confirmation_token_hash=null,
        email_confirmation_expires_at=null,
        version=version+1,
        metadata=metadata||jsonb_build_object(
          'emailConfirmedAt',now(),
          'manualHoldReason','existing_account_restricted'
        )
    where id=v_request.id
    returning * into v_request;
    insert into platform.registration_request_events(
      request_id,action,from_status,to_status,metadata
    ) values (
      v_request.id,'email_confirmed','pending_review','pending_review',
      jsonb_build_object('manualReviewRequired',true)
    );
    return jsonb_build_object(
      'reference',v_request.request_reference,
      'manualReviewRequired',true,
      'trustStatus','pending_review'
    );
  end if;

  v_slug:='odeir-'||lower(substr(v_request.request_reference,4));
  v_provisioning:=private_app.provision_tenant_core(
    v_request.institution_name,v_request.institution_name,v_slug,
    'SA','Asia/Riyadh',coalesce(v_plan_key,'free'),
    v_request.contact_name,v_request.contact_email,null,
    'verified_email',null,
    jsonb_build_object(
      'registrationTrustStatus','pending_review',
      'registrationRequestId',v_request.id,
      'registrationReference',v_request.request_reference,
      'registrationActivationMode','email_verified_trial'
    )
  );
  -- Tenant lifecycle becomes active immediately so every route in the selected
  -- plan behaves exactly like a normally activated workspace. Commercial plan
  -- state remains independently represented by catalog.subscriptions.
  update core.tenants tenant
  set status='active'
  where tenant.id=(v_provisioning->>'id')::uuid
    and tenant.settings->>'registrationRequestId'=v_request.id::text
    and tenant.settings->>'registrationActivationMode'='email_verified_trial'
    and tenant.status='trial';
  update platform.registration_requests
  set email_confirmed_at=now(),
      email_confirmation_token_hash=null,
      email_confirmation_expires_at=null,
      status='converted',
      trust_status='pending_review',
      provisioned_tenant_id=(v_provisioning->>'id')::uuid,
      version=version+1,
      metadata=metadata||jsonb_build_object(
        'emailConfirmedAt',now(),
        'provisionedAt',now(),
        'provisionedSlug',v_provisioning->>'slug'
      )
  where id=v_request.id
  returning * into v_request;

  insert into platform.registration_request_events(
    request_id,action,from_status,to_status,metadata
  ) values
    (v_request.id,'email_confirmed','pending_review','converted',
      jsonb_build_object('emailVerified',true)),
    (v_request.id,'auto_provision','pending_review','converted',
      jsonb_build_object(
        'tenantId',v_request.provisioned_tenant_id,
        'tenantSlug',v_provisioning->>'slug',
        'trustStatus','pending_review'
      ));
  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_request.provisioned_tenant_id,null,'tenant.auto_provisioned',
    'tenant',v_request.provisioned_tenant_id::text,
    jsonb_build_object(
      'registrationRequestId',v_request.id,
      'registrationReference',v_request.request_reference,
      'trustStatus','pending_review'
    )
  );
  return jsonb_build_object(
    'reference',v_request.request_reference,
    'tenantId',v_request.provisioned_tenant_id,
    'tenantSlug',v_provisioning->>'slug',
    'trustStatus','pending_review',
    'ownerStatus',v_provisioning#>>'{owner,status}',
    'invitationToken',v_provisioning#>>'{owner,invitationToken}'
  );
end;
$$;

create or replace function private_app.registration_manual_trust_sync()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if new.activation_mode='manual_review' and new.status is distinct from old.status then
    new.trust_status:=case new.status
      when 'pending_review' then 'pending_review'
      when 'under_review' then 'under_review'
      when 'approved' then 'trusted'
      when 'rejected' then 'restricted'
      else new.trust_status
    end;
  end if;
  return new;
end;
$$;

create or replace function private_app.registration_identity_claim_sync()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_type text;
  v_value text;
  v_hash text;
  v_claim platform.registration_identity_claims%rowtype;
begin
  if new.provisioned_tenant_id is null then return new; end if;
  for v_type,v_value in
    select * from (values
      ('commercial',nullif(regexp_replace(new.commercial_registration,'[^0-9]','','g'),'')),
      ('national',nullif(regexp_replace(new.national_registration,'[^0-9]','','g'),'')),
      ('tvtc',nullif(lower(trim(new.tvtc_license_number)),''))
    ) identifier(identifier_type,identifier_value)
    where identifier.identifier_value is not null
  loop
    v_hash:=encode(
      extensions.digest(v_type||':'||v_value,'sha256'),'hex'
    );
    insert into platform.registration_identity_claims(
      identifier_type,identifier_hash,request_id,tenant_id
    ) values (
      v_type,v_hash,new.id,new.provisioned_tenant_id
    ) on conflict (identifier_type,identifier_hash) do nothing;
    select claim.* into v_claim
    from platform.registration_identity_claims claim
    where claim.identifier_type=v_type and claim.identifier_hash=v_hash;
    if v_claim.tenant_id<>new.provisioned_tenant_id then
      raise exception 'registration_identifier_already_provisioned';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function private_app.registration_identity_claim_sync()
from public,anon,authenticated;

drop trigger if exists platform_registration_identity_claim_sync
on platform.registration_requests;
create trigger platform_registration_identity_claim_sync
after insert or update of provisioned_tenant_id
on platform.registration_requests
for each row when (new.provisioned_tenant_id is not null)
execute function private_app.registration_identity_claim_sync();

revoke all on function private_app.registration_manual_trust_sync()
from public,anon,authenticated;

drop trigger if exists platform_registration_manual_trust_sync
on platform.registration_requests;
create trigger platform_registration_manual_trust_sync
before update of status on platform.registration_requests
for each row execute function private_app.registration_manual_trust_sync();

create or replace function public.v1_platform_registration_trust_action(
  p_request_id uuid,
  p_action text,
  p_expected_version integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_actor uuid;
  v_action text:=trim(coalesce(p_action,''));
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
  v_from_trust text;
  v_to_trust text;
  v_tenant_slug text;
  v_tenant_updated integer;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  if v_notes is not null and char_length(v_notes)>1200 then
    raise exception 'registration_notes_too_long';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null then raise exception 'registration_request_not_found'; end if;
  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  if v_request.status<>'converted'
     or v_request.provisioned_tenant_id is null
     or v_request.activation_mode<>'email_verified_trial' then
    raise exception 'registration_trust_transition_invalid';
  end if;
  -- Lock the exact provisioned workspace before changing trust state. This
  -- prevents a concurrent suspension/status change from leaving the request
  -- and tenant with contradictory states.
  perform 1
  from core.tenants tenant
  where tenant.id=v_request.provisioned_tenant_id
    and tenant.settings->>'registrationRequestId'=v_request.id::text
    and tenant.settings->>'registrationActivationMode'='email_verified_trial'
    and tenant.status in ('trial','active')
  for update;
  if not found then
    raise exception 'registration_trust_target_invalid';
  end if;
  v_from_trust:=v_request.trust_status;

  if v_action='trust_start' then
    if v_request.trust_status<>'pending_review' then
      raise exception 'registration_trust_transition_invalid';
    end if;
    v_to_trust:='under_review';
  elsif v_action='trust_approve' then
    if v_request.trust_status<>'under_review' then
      raise exception 'registration_trust_transition_invalid';
    end if;
    v_to_trust:='trusted';
  elsif v_action='trust_restrict' then
    if v_request.trust_status<>'under_review' then
      raise exception 'registration_trust_transition_invalid';
    end if;
    if v_notes is null or char_length(v_notes)<3 then
      raise exception 'registration_trust_reason_required';
    end if;
    v_to_trust:='restricted';
  else
    raise exception 'registration_trust_action_invalid';
  end if;

  update platform.registration_requests
  set trust_status=v_to_trust,
      reviewed_by_subject_id=v_actor,
      review_started_at=case when v_action='trust_start' then now()
        else review_started_at end,
      reviewed_at=case when v_action in ('trust_approve','trust_restrict')
        then now() else reviewed_at end,
      review_notes=case when v_action in ('trust_approve','trust_restrict')
        then v_notes else review_notes end,
      version=version+1
  where id=v_request.id
  returning * into v_request;

  if v_action='trust_restrict' then
    update core.tenants tenant
    set status='suspended',
        settings=tenant.settings||jsonb_build_object(
          'registrationTrustStatus','restricted',
          'registrationTrustUpdatedAt',now()
        )
    where tenant.id=v_request.provisioned_tenant_id
      and tenant.settings->>'registrationRequestId'=v_request.id::text
      and tenant.settings->>'registrationActivationMode'='email_verified_trial'
      and tenant.status in ('trial','active');
  else
    update core.tenants tenant
    set settings=tenant.settings||jsonb_build_object(
      'registrationTrustStatus',v_to_trust,
      'registrationTrustUpdatedAt',now()
    )
    where tenant.id=v_request.provisioned_tenant_id
      and tenant.settings->>'registrationRequestId'=v_request.id::text
      and tenant.settings->>'registrationActivationMode'='email_verified_trial';
  end if;
  get diagnostics v_tenant_updated=row_count;
  if v_tenant_updated<>1 then
    raise exception 'registration_trust_target_invalid';
  end if;

  select tenant.slug into v_tenant_slug
  from core.tenants tenant where tenant.id=v_request.provisioned_tenant_id;
  insert into platform.registration_request_events(
    request_id,actor_subject_id,action,from_status,to_status,notes,metadata
  ) values (
    v_request.id,v_actor,v_action,
    'converted:'||v_from_trust,'converted:'||v_to_trust,v_notes,
    jsonb_build_object('tenantId',v_request.provisioned_tenant_id)
  );
  perform private_app.write_audit(
    'platform.registration_request.'||v_action,
    'registration_request',v_request.id::text,null,
    jsonb_build_object(
      'reference',v_request.request_reference,
      'fromTrustStatus',v_from_trust,
      'toTrustStatus',v_to_trust,
      'tenantId',v_request.provisioned_tenant_id
    )
  );
  return jsonb_build_object(
    'request',jsonb_build_object(
      'id',v_request.id,
      'reference',v_request.request_reference,
      'status','converted',
      'queueStatus',case v_to_trust
        when 'pending_review' then 'trust_pending'
        when 'under_review' then 'trust_review'
        when 'restricted' then 'trust_restricted'
        else 'converted' end,
      'trustStatus',v_to_trust,
      'version',v_request.version,
      'provisionedTenantId',v_request.provisioned_tenant_id,
      'provisionedTenantSlug',v_tenant_slug
    )
  );
end;
$$;

create or replace function private_app.can_access_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
      join core.tenants tenant
        on tenant.id=membership.tenant_id
       and tenant.status in ('trial','active')
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and membership.tenant_id=p_tenant_id
    )
  )
$$;

create or replace function private_app.has_tenant_permission(
  p_tenant_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select auth.uid() is not null and (
    private_app.has_platform_permission('platform.control.read')
    or exists (
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
      join core.tenants tenant
        on tenant.id=membership.tenant_id
       and tenant.status in ('trial','active')
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id
       and role.scope='tenant'
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
        and membership.tenant_id=p_tenant_id
        and role_permission.permission_key=p_permission
    )
  )
$$;

revoke all on function private_app.can_access_tenant(uuid)
from public,anon,authenticated;
revoke all on function private_app.has_tenant_permission(uuid,text)
from public,anon,authenticated;

revoke all on function public.v1_platform_registration_policy_snapshot()
from public,anon,authenticated;
revoke all on function public.v1_platform_registration_policy_save(text,integer,text)
from public,anon,authenticated;
revoke all on function public.v1_registration_mark_confirmation_sent(uuid,text)
from public,anon,authenticated;
revoke all on function public.v1_registration_confirm_email_and_provision(text)
from public,anon,authenticated;
revoke all on function public.v1_platform_registration_trust_action(
  uuid,text,integer,text
) from public,anon,authenticated;

grant execute on function public.v1_platform_registration_policy_snapshot()
to authenticated;
grant execute on function public.v1_platform_registration_policy_save(text,integer,text)
to authenticated;
grant execute on function public.v1_registration_mark_confirmation_sent(uuid,text)
to service_role;
grant execute on function public.v1_registration_confirm_email_and_provision(text)
to service_role;
grant execute on function public.v1_platform_registration_trust_action(
  uuid,text,integer,text
) to authenticated;

comment on table platform.registration_settings is
'Global ODEIR registration activation policy. Existing institutions always remain manual-review only.';
comment on function public.v1_registration_confirm_email_and_provision(text) is
'One-time email confirmation for new institutions only. Creates an isolated trial with trust review pending.';

commit;
