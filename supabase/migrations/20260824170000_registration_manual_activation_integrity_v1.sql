-- Close the gap between a reviewed registration request and the tenant that is
-- shown in platform control. Manual approval and activation are one transaction;
-- linking an existing tenant is deliberately metadata-only and never mutates it.

begin;

create table platform.registration_external_account_claims (
  source_system text not null
    check (source_system in ('marktone_directory')),
  external_account_id uuid not null,
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  originating_request_id uuid not null
    references platform.registration_requests(id) on delete restrict,
  verification_method text not null
    check (verification_method in ('manual_review','directory_verified')),
  evidence_hash text not null
    check (evidence_hash ~ '^[a-f0-9]{64}$'),
  claimed_by_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  claimed_at timestamptz not null default now(),
  primary key (source_system,external_account_id),
  unique (originating_request_id)
);

create index platform_registration_external_claim_tenant_idx
on platform.registration_external_account_claims(tenant_id);

alter table platform.registration_external_account_claims enable row level security;

revoke all on table platform.registration_external_account_claims
from public,anon,authenticated,service_role;

alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check;
alter table platform.registration_request_events
  add constraint registration_request_events_action_check check (action in (
    'submitted','imported','email_confirmation_sent','email_confirmed',
    'start_review','approve','approve_and_activate','reject','reopen',
    'provision','auto_provision','trust_start','trust_approve','trust_restrict'
  ));

-- An approval is not proof that a usable tenant exists. Trust becomes final only
-- when the same transaction has attached a tenant to the converted request.
create or replace function private_app.registration_manual_trust_sync()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if new.activation_mode='manual_review' and new.status is distinct from old.status then
    if new.status='approved' and new.provisioned_tenant_id is null then
      raise exception 'registration_atomic_activation_required';
    end if;
    new.trust_status:=case new.status
      when 'pending_review' then 'pending_review'
      when 'under_review' then 'under_review'
      when 'approved' then 'pending_review'
      when 'rejected' then 'restricted'
      when 'converted' then case
        when new.provisioned_tenant_id is not null then 'trusted'
        else 'pending_review'
      end
      else new.trust_status
    end;
  end if;
  return new;
end;
$$;

revoke all on function private_app.registration_manual_trust_sync()
from public,anon,authenticated;

-- Repair the misleading state produced by the former approved => trusted rule.
-- No tenant, subscription, membership, integration, or tenant setting is touched.
update platform.registration_requests request
set trust_status='pending_review'
where request.activation_mode='manual_review'
  and request.status='approved'
  and request.provisioned_tenant_id is null
  and request.trust_status is distinct from 'pending_review';

-- A converted registration must always resolve to the current core tenant stack.
alter table platform.registration_requests
  add constraint platform_registration_converted_tenant_check
  check (status<>'converted' or provisioned_tenant_id is not null)
  not valid;

alter table platform.registration_requests
  validate constraint platform_registration_converted_tenant_check;

create or replace function public.v1_platform_registration_approve_and_activate(
  p_request_id uuid,
  p_expected_version integer,
  p_notes text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_actor uuid;
  v_from_status text;
  v_resolution text;
  v_provisioning jsonb;
  v_tenant core.tenants%rowtype;
  v_tenant_id uuid;
  v_tenant_updated integer;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
  v_display_name text;
  v_verified_external jsonb;
  v_official_identifiers jsonb;
  v_external_source text;
  v_external_account_id uuid;
  v_verified_name text;
  v_evidence_hash text;
  v_commercial text;
  v_national text;
  v_tvtc text;
  v_identifier_type text;
  v_identifier_value text;
  v_identifier_hash text;
  v_identifier_claim_tenant_id uuid;
  v_external_claim platform.registration_external_account_claims%rowtype;
  v_tenant_settings jsonb;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;

  v_actor:=private_app.current_subject_id();
  if v_actor is null then
    raise exception 'platform_subject_not_found';
  end if;

  select request.*
  into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;

  if v_request.id is null then
    raise exception 'registration_request_not_found';
  end if;
  if v_request.activation_mode<>'manual_review' then
    raise exception 'registration_manual_activation_required';
  end if;

  -- Retries are idempotent even if the caller still holds the pre-commit version.
  if v_request.status='converted' and v_request.provisioned_tenant_id is not null then
    select tenant.*
    into v_tenant
    from core.tenants tenant
    where tenant.id=v_request.provisioned_tenant_id;

    if v_tenant.id is null then
      raise exception 'registration_activation_target_missing';
    end if;

    return jsonb_build_object(
      'request',jsonb_build_object(
        'id',v_request.id,
        'reference',v_request.request_reference,
        'status',v_request.status,
        'queueStatus','converted',
        'trustStatus',v_request.trust_status,
        'version',v_request.version,
        'reviewedAt',v_request.reviewed_at,
        'provisionedTenantId',v_request.provisioned_tenant_id,
        'provisionedTenantSlug',v_tenant.slug
      ),
      'provisioning',jsonb_build_object(
        'id',v_tenant.id,
        'slug',v_tenant.slug,
        'status',v_tenant.status,
        'resolution',coalesce(
          v_request.metadata->>'manualActivationResolution','create_new'
        ),
        'replayed',true
      )
    );
  end if;

  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  if v_request.status not in ('under_review','approved') then
    raise exception 'registration_transition_invalid';
  end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'registration_payload_invalid';
  end if;
  if v_notes is not null and char_length(v_notes)>1200 then
    raise exception 'registration_notes_too_long';
  end if;
  if p_payload->'identityVerified' is distinct from 'true'::jsonb then
    raise exception 'registration_identity_verification_required';
  end if;

  v_resolution:=trim(coalesce(p_payload->>'resolution',''));
  if v_resolution not in ('create_new','link_existing') then
    raise exception 'registration_activation_resolution_invalid';
  end if;
  if v_request.institution_state='new' and v_resolution<>'create_new' then
    raise exception 'registration_new_institution_link_invalid';
  end if;

  if v_request.institution_state='existing' then
    if v_request.external_account_id is null then
      raise exception 'registration_external_account_required';
    end if;

    v_verified_external:=p_payload->'serverVerifiedExternalAccount';
    if v_verified_external is null
       or jsonb_typeof(v_verified_external)<>'object' then
      raise exception 'registration_server_verification_required';
    end if;

    v_external_source:=trim(coalesce(
      v_verified_external->>'sourceSystem',''
    ));
    if v_external_source<>'marktone_directory' then
      raise exception 'registration_external_source_invalid';
    end if;
    if coalesce(v_verified_external->>'accountId','') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'registration_external_account_invalid';
    end if;
    v_external_account_id:=(v_verified_external->>'accountId')::uuid;
    if v_external_account_id<>v_request.external_account_id then
      raise exception 'registration_external_account_mismatch';
    end if;

    v_verified_name:=trim(coalesce(
      v_verified_external->>'institutionName',''
    ));
    if char_length(v_verified_name) not between 2 and 240
       or lower(regexp_replace(
            pg_catalog."normalize"(v_verified_name,'NFKC'),
            '[[:space:]]+',' ','g'
          ))<>
          lower(regexp_replace(
            pg_catalog."normalize"(trim(v_request.institution_name),'NFKC'),
            '[[:space:]]+',' ','g'
          )) then
      raise exception 'registration_external_institution_mismatch';
    end if;

    v_evidence_hash:=lower(trim(coalesce(
      v_verified_external->>'evidenceHash',''
    )));
    if v_evidence_hash !~ '^[a-f0-9]{64}$' then
      raise exception 'registration_external_evidence_invalid';
    end if;

    v_official_identifiers:=coalesce(
      v_verified_external->'officialIdentifiers','{}'::jsonb
    );
    if jsonb_typeof(v_official_identifiers)<>'object' then
      raise exception 'registration_official_identifiers_invalid';
    end if;

    v_commercial:=nullif(regexp_replace(
      coalesce(v_official_identifiers->>'commercialRegistration',''),
      '[^0-9]','','g'
    ),'');
    v_national:=nullif(regexp_replace(
      coalesce(v_official_identifiers->>'nationalRegistration',''),
      '[^0-9]','','g'
    ),'');
    v_tvtc:=nullif(lower(trim(coalesce(
      v_official_identifiers->>'tvtcLicense',''
    ))),'');

    if (v_commercial is not null and char_length(v_commercial)>24)
       or (v_national is not null and char_length(v_national)>24)
       or (v_tvtc is not null and char_length(v_tvtc)>80) then
      raise exception 'registration_official_identifiers_invalid';
    end if;

    -- Serialize all claims for one official directory account, even when two
    -- independent registration requests are reviewed concurrently.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_external_source||':'||v_external_account_id::text,0
      )
    );

    select claim.*
    into v_external_claim
    from platform.registration_external_account_claims claim
    where claim.source_system=v_external_source
      and claim.external_account_id=v_external_account_id
    for update;

    if v_external_claim.external_account_id is not null
       and v_external_claim.originating_request_id<>v_request.id then
      raise exception 'registration_external_account_already_claimed';
    end if;
  else
    if v_request.external_account_id is not null
       or p_payload ? 'serverVerifiedExternalAccount' then
      raise exception 'registration_new_institution_external_account_invalid';
    end if;

    v_verified_name:=v_request.institution_name;
    v_commercial:=nullif(regexp_replace(
      coalesce(v_request.commercial_registration,''),'[^0-9]','','g'
    ),'');
    v_national:=nullif(regexp_replace(
      coalesce(v_request.national_registration,''),'[^0-9]','','g'
    ),'');
    v_tvtc:=nullif(lower(trim(coalesce(
      v_request.tvtc_license_number,''
    ))),'');
  end if;

  if v_resolution='link_existing' then
    if nullif(trim(coalesce(p_payload->>'targetTenantSlug','')),'') is null then
      raise exception 'registration_target_tenant_required';
    end if;

    select tenant.*
    into v_tenant
    from core.tenants tenant
    where tenant.slug=lower(trim(p_payload->>'targetTenantSlug'))
      and tenant.status='active'
    for update;

    if v_tenant.id is null then
      raise exception 'registration_target_tenant_invalid';
    end if;
    if exists(
      select 1
      from platform.registration_requests other
      where other.id<>v_request.id
        and other.provisioned_tenant_id=v_tenant.id
    ) then
      raise exception 'registration_target_tenant_already_claimed';
    end if;

    v_tenant_id:=v_tenant.id;
    v_provisioning:=jsonb_build_object(
      'id',v_tenant.id,
      'slug',v_tenant.slug,
      'status',v_tenant.status,
      'resolution','link_existing',
      'linkedExisting',true
    );
  else
    if p_payload->'confirmedNoExistingTenant' is distinct from 'true'::jsonb then
      raise exception 'registration_no_existing_tenant_confirmation_required';
    end if;
  end if;

  -- Official identifiers cannot create a second workspace. For a deliberate
  -- link, a prior identifier claim is accepted only when it names that target.
  for v_identifier_type,v_identifier_value in
    select identifier.identifier_type,identifier.identifier_value
    from (values
      ('commercial',v_commercial),
      ('national',v_national),
      ('tvtc',v_tvtc)
    ) identifier(identifier_type,identifier_value)
    where identifier.identifier_value is not null
  loop
    v_identifier_hash:=encode(extensions.digest(
      v_identifier_type||':'||v_identifier_value,'sha256'
    ),'hex');
    v_identifier_claim_tenant_id:=null;

    select claim.tenant_id
    into v_identifier_claim_tenant_id
    from platform.registration_identity_claims claim
    where claim.identifier_type=v_identifier_type
      and claim.identifier_hash=v_identifier_hash;

    if v_identifier_claim_tenant_id is not null
       and (
         v_resolution='create_new'
         or v_identifier_claim_tenant_id is distinct from v_tenant_id
       ) then
      raise exception 'registration_identifier_already_provisioned';
    end if;
  end loop;

  if v_resolution='create_new' then
    v_display_name:=coalesce(
      nullif(trim(p_payload->>'displayName'),''),v_verified_name
    );
    v_tenant_settings:=jsonb_strip_nulls(jsonb_build_object(
      'registrationRequestId',v_request.id::text,
      'registrationReference',v_request.request_reference,
      'registrationActivationMode','manual_review',
      'registrationTrustStatus','trusted',
      'registrationResolution','create_new',
      'registrationExternalSource',v_external_source,
      'registrationExternalAccountId',v_external_account_id,
      'registrationEvidenceHash',v_evidence_hash,
      'registrationActivatedAt',now()
    ));

    v_provisioning:=private_app.provision_tenant_core(
      v_display_name,
      coalesce(nullif(trim(p_payload->>'legalName'),''),v_display_name),
      p_payload->>'slug',
      coalesce(nullif(trim(p_payload->>'countryCode'),''),'SA'),
      coalesce(nullif(trim(p_payload->>'timezone'),''),'Asia/Riyadh'),
      coalesce(nullif(trim(p_payload->>'planKey'),''),'free'),
      coalesce(nullif(trim(p_payload->>'ownerName'),''),v_request.contact_name),
      coalesce(nullif(trim(p_payload->>'ownerEmail'),''),v_request.contact_email),
      nullif(lower(trim(coalesce(p_payload->>'hostname',''))),''),
      'verified_email',
      v_actor,
      v_tenant_settings
    );
    v_tenant_id:=(v_provisioning->>'id')::uuid;

    -- Activate only the tenant created above and only when its provenance is
    -- this request. The trialing subscription remains untouched.
    update core.tenants tenant
    set status='active'
    where tenant.id=v_tenant_id
      and tenant.status='trial'
      and tenant.settings->>'registrationRequestId'=v_request.id::text
      and tenant.settings->>'registrationActivationMode'='manual_review'
      and tenant.settings->>'registrationResolution'='create_new';
    get diagnostics v_tenant_updated=row_count;

    if v_tenant_updated<>1 then
      raise exception 'registration_created_tenant_activation_failed';
    end if;

    v_provisioning:=v_provisioning||jsonb_build_object(
      'status','active',
      'resolution','create_new'
    );
  end if;

  if v_external_account_id is not null then
    insert into platform.registration_external_account_claims(
      source_system,external_account_id,tenant_id,originating_request_id,
      verification_method,evidence_hash,claimed_by_subject_id
    ) values (
      v_external_source,v_external_account_id,v_tenant_id,v_request.id,
      'directory_verified',v_evidence_hash,v_actor
    )
    on conflict (source_system,external_account_id) do nothing;

    select claim.*
    into v_external_claim
    from platform.registration_external_account_claims claim
    where claim.source_system=v_external_source
      and claim.external_account_id=v_external_account_id;

    if v_external_claim.external_account_id is null
       or v_external_claim.tenant_id<>v_tenant_id
       or v_external_claim.originating_request_id<>v_request.id then
      raise exception 'registration_external_account_already_claimed';
    end if;
  end if;

  v_from_status:=v_request.status;
  update platform.registration_requests request
  set institution_name=v_verified_name,
      commercial_registration=v_commercial,
      national_registration=v_national,
      tvtc_license_number=v_tvtc,
      status='converted',
      trust_status='trusted',
      provisioned_tenant_id=v_tenant_id,
      reviewed_by_subject_id=v_actor,
      review_started_at=coalesce(request.review_started_at,now()),
      reviewed_at=now(),
      review_notes=coalesce(v_notes,request.review_notes),
      version=request.version+1,
      metadata=request.metadata||jsonb_strip_nulls(jsonb_build_object(
        'manualActivationResolution',v_resolution,
        'provisionedAt',now(),
        'provisionedSlug',v_provisioning->>'slug',
        'identityVerifiedAt',now(),
        'identityVerifiedBySubjectId',v_actor,
        'registrationExternalSource',v_external_source,
        'registrationExternalAccountId',v_external_account_id,
        'registrationEvidenceHash',v_evidence_hash
      ))
  where request.id=v_request.id
  returning request.* into v_request;

  insert into platform.registration_request_events(
    request_id,actor_subject_id,action,from_status,to_status,notes,metadata
  ) values (
    v_request.id,v_actor,'approve_and_activate',v_from_status,'converted',
    v_notes,jsonb_build_object(
      'tenantId',v_tenant_id,
      'tenantSlug',v_provisioning->>'slug',
      'resolution',v_resolution,
      'identityVerified',true
    )
  );

  perform private_app.write_audit(
    'platform.registration_request.approve_and_activate',
    'registration_request',v_request.id::text,null,
    jsonb_build_object(
      'reference',v_request.request_reference,
      'fromStatus',v_from_status,
      'toStatus','converted',
      'resolution',v_resolution,
      'tenantId',v_tenant_id
    )
  );

  return jsonb_build_object(
    'request',jsonb_build_object(
      'id',v_request.id,
      'reference',v_request.request_reference,
      'status','converted',
      'queueStatus','converted',
      'trustStatus','trusted',
      'version',v_request.version,
      'reviewedAt',v_request.reviewed_at,
      'provisionedTenantId',v_request.provisioned_tenant_id,
      'provisionedTenantSlug',v_provisioning->>'slug'
    ),
    'provisioning',v_provisioning
  );
end;
$$;

revoke all on function public.v1_platform_registration_approve_and_activate(
  uuid,integer,text,jsonb
) from public,anon,authenticated;

grant execute on function public.v1_platform_registration_approve_and_activate(
  uuid,integer,text,jsonb
) to authenticated;

comment on table platform.registration_external_account_claims is
'Immutable binding from a server-verified directory account to exactly one current core tenant and registration request.';

comment on function public.v1_platform_registration_approve_and_activate(
  uuid,integer,text,jsonb
) is
'Atomically approves a manual registration and either creates an isolated active tenant or safely binds an existing active tenant without mutating it.';

commit;
