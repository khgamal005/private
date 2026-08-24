-- Make manual activation atomic without ever binding a registration request to
-- an existing tenant. Existing directory institutions are verified through a
-- short-lived server attestation, then receive a newly isolated ODEIR tenant.

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

-- Directory evidence crosses two different trust boundaries. An authenticated
-- platform operator prepares a nonce bound to their subject, request, and row
-- version. Only the registration service can complete it with allowlisted
-- directory evidence. Activation consumes the completed attestation once.
create table platform.registration_activation_attestations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null
    references platform.registration_requests(id) on delete restrict,
  request_version integer not null check (request_version>0),
  requested_by_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  nonce_hash text not null unique
    check (nonce_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'prepared'
    check (status in ('prepared','completed','consumed','superseded')),
  source_system text
    check (source_system is null or source_system='marktone_directory'),
  external_account_id uuid,
  directory_evidence jsonb
    check (
      directory_evidence is null
      or jsonb_typeof(directory_evidence)='object'
    ),
  evidence_hash text
    check (evidence_hash is null or evidence_hash ~ '^[a-f0-9]{64}$'),
  prepared_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  consumed_at timestamptz,
  constraint registration_activation_attestation_expiry_check
    check (expires_at>prepared_at),
  constraint registration_activation_attestation_evidence_check check (
    status not in ('completed','consumed')
    or (
      source_system is not distinct from 'marktone_directory'
      and external_account_id is not null
      and directory_evidence is not null
      and evidence_hash is not null
      and completed_at is not null
    )
  ),
  constraint registration_activation_attestation_consumed_check check (
    status<>'consumed' or consumed_at is not null
  )
);

create index platform_registration_activation_attestation_request_idx
on platform.registration_activation_attestations(
  request_id,status,expires_at desc
);

alter table platform.registration_activation_attestations enable row level security;
revoke all on table platform.registration_activation_attestations
from public,anon,authenticated,service_role;

create or replace function private_app.registration_external_claim_immutable()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  raise exception 'registration_external_claim_immutable';
end;
$$;

revoke all on function private_app.registration_external_claim_immutable()
from public,anon,authenticated,service_role;

create trigger platform_registration_external_claim_immutable
before update or delete on platform.registration_external_account_claims
for each row execute function
private_app.registration_external_claim_immutable();

-- Identity claims are authoritative, not display data. Existing institutions
-- are identified only by the server-verified directory account UUID. For new
-- institutions, accept only an already-canonical raw CR/national value; never
-- strip labels, masking prefixes, letters, separators, or visible suffixes.
-- TVTC currently has no universal completeness contract and is never claimed.
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
  if new.provisioned_tenant_id is null
     or new.institution_state is distinct from 'new' then
    return new;
  end if;

  for v_type,v_value in
    select identifier.identifier_type,identifier.identifier_value
    from (values
      (
        'commercial',
        case
          when coalesce(new.commercial_registration,'') ~
                 '^[0-9]{10}$'
           and coalesce(new.commercial_registration,'') !~
                 '^([0-9])\1{9}$'
            then new.commercial_registration
          else null
        end
      ),
      (
        'national',
        case
          when coalesce(new.national_registration,'') ~
                 '^7[0-9]{9}$'
           and coalesce(new.national_registration,'') !~
                 '^([0-9])\1{9}$'
            then new.national_registration
          else null
        end
      )
    ) identifier(identifier_type,identifier_value)
    where identifier.identifier_value is not null
    order by identifier.identifier_type
  loop
    v_hash:=encode(
      extensions.digest(v_type||':'||v_value,'sha256'),'hex'
    );
    insert into platform.registration_identity_claims(
      identifier_type,identifier_hash,request_id,tenant_id
    ) values (
      v_type,v_hash,new.id,new.provisioned_tenant_id
    ) on conflict (identifier_type,identifier_hash) do nothing;

    select claim.*
    into v_claim
    from platform.registration_identity_claims claim
    where claim.identifier_type=v_type
      and claim.identifier_hash=v_hash;
    if v_claim.tenant_id is distinct from new.provisioned_tenant_id then
      raise exception 'registration_identifier_already_provisioned';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function private_app.registration_identity_claim_sync()
from public,anon,authenticated,service_role;

alter table platform.registration_request_events
  drop constraint if exists registration_request_events_action_check;
alter table platform.registration_request_events
  add constraint registration_request_events_action_check check (action in (
    'submitted','imported','email_confirmation_sent','email_confirmed',
    'start_review','approve','approve_and_activate','reject','reopen',
    'provision','auto_provision','trust_start','trust_approve','trust_restrict',
    'manual_trust_repair'
  ));

-- Approval remains a compatible, transitional review state. It must never be
-- presented as final trust until a tenant is attached by a later transaction.
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
from public,anon,authenticated,service_role;

-- Repair only the exact misleading legacy state. The version increment makes
-- every pre-migration reviewer snapshot stale, while event and audit rows keep
-- the correction explainable without touching any tenant row.
with repaired as (
  update platform.registration_requests request
  set trust_status='pending_review',
      version=request.version+1,
      metadata=request.metadata||jsonb_build_object(
        'manualTrustRepairAt',now(),
        'manualTrustRepairReason','approved_without_tenant'
      )
  where request.activation_mode='manual_review'
    and request.status='approved'
    and request.provisioned_tenant_id is null
    and request.trust_status='trusted'
  returning request.id,request.request_reference,request.version
), recorded as (
  insert into platform.registration_request_events(
    request_id,action,from_status,to_status,metadata
  )
  select
    repaired.id,'manual_trust_repair','approved','approved',
    jsonb_build_object(
      'fromTrustStatus','trusted',
      'toTrustStatus','pending_review',
      'version',repaired.version
    )
  from repaired
  returning request_id
)
insert into audit_log.events(
  tenant_id,actor_subject_id,action,resource_type,resource_id,context
)
select
  null,null,'platform.registration_request.manual_trust_repair',
  'registration_request',repaired.id::text,
  jsonb_build_object(
    'reference',repaired.request_reference,
    'fromTrustStatus','trusted',
    'toTrustStatus','pending_review',
    'version',repaired.version
  )
from repaired
join recorded on recorded.request_id=repaired.id;

alter table platform.registration_requests
  add constraint platform_registration_converted_tenant_check
  check (status<>'converted' or provisioned_tenant_id is not null)
  not valid;

alter table platform.registration_requests
  validate constraint platform_registration_converted_tenant_check;

-- Classify the queue before applying filters. This keeps virtual statuses,
-- search, totals, and pagination on the server while the summary always spans
-- the complete inbox rather than only the current page.
create or replace function public.v1_platform_registration_requests_snapshot(
  p_status text default null,
  p_query text default null,
  p_offset integer default 0,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_status text:=nullif(trim(coalesce(p_status,'')),'');
  v_query text:=lower(nullif(trim(coalesce(p_query,'')),''));
  v_offset integer:=greatest(0,least(coalesce(p_offset,0),100000));
  v_limit integer:=greatest(1,least(coalesce(p_limit,25),50));
  v_result jsonb;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  if v_status is not null and v_status not in (
    'pending_review','under_review','approved','rejected','converted',
    'awaiting_email','trust_pending','trust_review','trust_restricted',
    'manual_attention','trust_attention','restricted'
  ) then
    raise exception 'registration_status_invalid';
  end if;
  if v_query is not null and char_length(v_query)>80 then
    raise exception 'registration_query_invalid';
  end if;

  with classified as materialized (
    select
      request.*,
      case
        when request.status='pending_review'
          and request.activation_mode='email_verified_trial'
          and request.email_confirmed_at is null
          then 'awaiting_email'
        when request.status='converted'
          and request.activation_mode='email_verified_trial'
          and request.trust_status='pending_review'
          then 'trust_pending'
        when request.status='converted'
          and request.activation_mode='email_verified_trial'
          and request.trust_status='under_review'
          then 'trust_review'
        when request.status='converted'
          and request.activation_mode='email_verified_trial'
          and request.trust_status='restricted'
          then 'trust_restricted'
        else request.status
      end as queue_status
    from platform.registration_requests request
  ), matched as materialized (
    select request.*
    from classified request
    where (
        v_status is null
        or request.queue_status=v_status
        or (
          v_status='manual_attention'
          and request.queue_status in ('pending_review','under_review')
        )
        or (
          v_status='trust_attention'
          and request.queue_status in ('trust_pending','trust_review')
        )
        or (
          v_status='restricted'
          and request.queue_status in ('rejected','trust_restricted')
        )
      )
      and (
        v_query is null
        or position(v_query in lower(request.request_reference))>0
        or position(v_query in lower(request.institution_name))>0
        or position(v_query in lower(coalesce(
          request.commercial_registration,''
        )))>0
        or position(v_query in lower(coalesce(
          request.national_registration,''
        )))>0
        or position(v_query in lower(coalesce(
          request.tvtc_license_number,''
        )))>0
        or position(v_query in lower(request.contact_email))>0
        or position(v_query in lower(request.contact_phone))>0
      )
  )
  select jsonb_build_object(
    'summary',(
      select jsonb_build_object(
        'total',count(*),
        'pendingReview',count(*) filter(
          where request.queue_status='pending_review'
        ),
        'awaitingEmail',count(*) filter(
          where request.queue_status='awaiting_email'
        ),
        'underReview',count(*) filter(
          where request.queue_status='under_review'
        ),
        'approved',count(*) filter(
          where request.queue_status='approved'
        ),
        'rejected',count(*) filter(
          where request.queue_status='rejected'
        ),
        'converted',count(*) filter(
          where request.status='converted'
        ),
        'trustPending',count(*) filter(
          where request.queue_status in ('trust_pending','trust_review')
        ),
        'trusted',count(*) filter(
          where request.status='converted'
            and request.trust_status='trusted'
        ),
        'trustRestricted',count(*) filter(
          where request.queue_status='trust_restricted'
        ),
        'overdue',count(*) filter(
          where request.queue_status in ('pending_review','under_review')
            and request.created_at<now()-interval '24 hours'
        ),
        'oldestPendingAt',min(request.created_at) filter(
          where request.queue_status in ('pending_review','under_review')
        )
      )
      from classified request
    ),
    'total',(select count(*) from matched),
    'offset',v_offset,
    'limit',v_limit,
    'items',coalesce((
      select jsonb_agg(row_data.payload order by
        row_data.active_rank,row_data.active_created,row_data.created_at desc,
        row_data.id
      )
      from (
        select
          filtered.id,
          case when filtered.queue_status in (
            'pending_review','under_review','trust_pending','trust_review'
          ) then 0 else 1 end as active_rank,
          case when filtered.queue_status in (
            'pending_review','under_review','trust_pending','trust_review'
          ) then filtered.created_at end as active_created,
          filtered.created_at,
          jsonb_build_object(
            'id',filtered.id,
            'reference',filtered.request_reference,
            'institutionState',filtered.institution_state,
            'institutionName',filtered.institution_name,
            'commercialRegistration',filtered.commercial_registration,
            'nationalRegistration',filtered.national_registration,
            'tvtcLicenseNumber',filtered.tvtc_license_number,
            'status',filtered.queue_status,
            'requestStatus',filtered.status,
            'activationMode',filtered.activation_mode,
            'trustStatus',filtered.trust_status,
            'emailConfirmedAt',filtered.email_confirmed_at,
            'reviewerName',reviewer.full_name,
            'reviewStartedAt',filtered.review_started_at,
            'reviewedAt',filtered.reviewed_at,
            'provisionedTenantId',filtered.provisioned_tenant_id,
            'provisionedTenantSlug',tenant.slug,
            'version',filtered.version,
            'createdAt',filtered.created_at,
            'updatedAt',filtered.updated_at
          ) as payload
        from matched filtered
        left join access_control.subjects reviewer
          on reviewer.id=filtered.reviewed_by_subject_id
        left join core.tenants tenant
          on tenant.id=filtered.provisioned_tenant_id
        order by
          case when filtered.queue_status in (
            'pending_review','under_review','trust_pending','trust_review'
          ) then 0 else 1 end,
          case when filtered.queue_status in (
            'pending_review','under_review','trust_pending','trust_review'
          ) then filtered.created_at end,
          filtered.created_at desc,
          filtered.id
        limit v_limit offset v_offset
      ) row_data
    ),'[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.v1_platform_registration_activation_attestation_prepare(
  p_request_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_actor uuid;
  v_attestation_id uuid;
  v_nonce text;
  v_prepared_at timestamptz;
  v_expires_at timestamptz;
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
  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  if v_request.activation_mode<>'manual_review'
     or v_request.institution_state<>'existing'
     or v_request.external_account_id is null
     or v_request.status not in ('under_review','approved')
     or v_request.provisioned_tenant_id is not null then
    raise exception 'registration_attestation_not_allowed';
  end if;

  update platform.registration_activation_attestations attestation
  set status='superseded'
  where attestation.request_id=v_request.id
    and attestation.requested_by_subject_id=v_actor
    and attestation.status in ('prepared','completed');

  v_prepared_at:=pg_catalog.clock_timestamp();
  v_expires_at:=v_prepared_at+interval '5 minutes';
  v_nonce:=encode(extensions.gen_random_bytes(32),'hex');
  insert into platform.registration_activation_attestations(
    request_id,request_version,requested_by_subject_id,nonce_hash,
    prepared_at,expires_at
  ) values (
    v_request.id,v_request.version,v_actor,
    encode(extensions.digest(v_nonce,'sha256'),'hex'),
    v_prepared_at,v_expires_at
  ) returning id into v_attestation_id;

  perform private_app.write_audit(
    'platform.registration_request.activation_attestation_prepared',
    'registration_request',v_request.id::text,null,
    jsonb_build_object(
      'reference',v_request.request_reference,
      'attestationId',v_attestation_id,
      'requestVersion',v_request.version,
      'expiresAt',v_expires_at
    )
  );

  return jsonb_build_object(
    'attestationId',v_attestation_id,
    'nonce',v_nonce,
    'requestId',v_request.id,
    'requestVersion',v_request.version,
    'expiresAt',v_expires_at
  );
end;
$$;

create or replace function public.v1_registration_activation_attestation_complete(
  p_attestation_id uuid,
  p_nonce text,
  p_directory_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request_id uuid;
  v_request platform.registration_requests%rowtype;
  v_attestation platform.registration_activation_attestations%rowtype;
  v_source text;
  v_external_account_id uuid;
  v_verified_name text;
  v_snapshot jsonb;
  v_evidence_hash text;
begin
  if p_nonce is null or p_nonce !~ '^[a-f0-9]{64}$'
     or p_directory_evidence is null
     or jsonb_typeof(p_directory_evidence)<>'object'
     or pg_catalog.pg_column_size(p_directory_evidence)>131072 then
    raise exception 'registration_attestation_invalid';
  end if;

  select attestation.request_id
  into v_request_id
  from platform.registration_activation_attestations attestation
  where attestation.id=p_attestation_id;
  if v_request_id is null then
    raise exception 'registration_attestation_invalid';
  end if;

  -- Every attestation function locks request before attestation.
  select request.*
  into v_request
  from platform.registration_requests request
  where request.id=v_request_id
  for update;

  select attestation.*
  into v_attestation
  from platform.registration_activation_attestations attestation
  where attestation.id=p_attestation_id
  for update;

  if v_request.id is null
     or v_attestation.id is null
     or v_attestation.request_id is distinct from v_request.id
     or v_attestation.request_version is distinct from v_request.version
     or v_attestation.expires_at<=pg_catalog.clock_timestamp()
     or v_attestation.nonce_hash is distinct from encode(
       extensions.digest(p_nonce,'sha256'),'hex'
     )
     or v_request.activation_mode<>'manual_review'
     or v_request.institution_state<>'existing'
     or v_request.external_account_id is null
     or v_request.status not in ('under_review','approved')
     or v_request.provisioned_tenant_id is not null then
    raise exception 'registration_attestation_invalid';
  end if;

  v_source:=trim(coalesce(p_directory_evidence->>'sourceSystem',''));
  if v_source<>'marktone_directory' then
    raise exception 'registration_external_source_invalid';
  end if;
  if coalesce(p_directory_evidence->>'accountId','') !~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'registration_external_account_invalid';
  end if;
  v_external_account_id:=(p_directory_evidence->>'accountId')::uuid;
  if v_external_account_id<>v_request.external_account_id then
    raise exception 'registration_external_account_mismatch';
  end if;

  v_verified_name:=trim(coalesce(
    p_directory_evidence->>'institutionName',''
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

  -- Public-directory registration numbers are intentionally display-only.
  -- No completeness contract exists, so ignore even apparently canonical
  -- values and persist only the exact account UUID plus its matched name.
  v_snapshot:=jsonb_strip_nulls(jsonb_build_object(
    'sourceSystem',v_source,
    'accountId',v_external_account_id,
    'institutionName',v_verified_name
  ));
  v_evidence_hash:=encode(extensions.digest(v_snapshot::text,'sha256'),'hex');

  if v_attestation.status='completed' then
    if v_attestation.evidence_hash<>v_evidence_hash then
      raise exception 'registration_attestation_conflict';
    end if;
    return jsonb_build_object(
      'attestationId',v_attestation.id,
      'status','completed',
      'expiresAt',v_attestation.expires_at,
      'replayed',true
    );
  end if;
  if v_attestation.status<>'prepared' then
    raise exception 'registration_attestation_invalid';
  end if;

  update platform.registration_activation_attestations attestation
  set status='completed',
      source_system=v_source,
      external_account_id=v_external_account_id,
      directory_evidence=v_snapshot,
      evidence_hash=v_evidence_hash,
      completed_at=now()
  where attestation.id=v_attestation.id;

  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    null,v_attestation.requested_by_subject_id,
    'platform.registration_request.activation_attestation_completed',
    'registration_request',v_request.id::text,
    jsonb_build_object(
      'reference',v_request.request_reference,
      'attestationId',v_attestation.id,
      'requestVersion',v_request.version,
      'requestedBySubjectId',v_attestation.requested_by_subject_id,
      'sourceSystem',v_source,
      'externalAccountId',v_external_account_id,
      'evidenceHash',v_evidence_hash
    )
  );

  return jsonb_build_object(
    'attestationId',v_attestation.id,
    'status','completed',
    'expiresAt',v_attestation.expires_at,
    'evidenceHash',v_evidence_hash,
    'replayed',false
  );
end;
$$;

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
  v_provisioning jsonb;
  v_tenant core.tenants%rowtype;
  v_tenant_id uuid;
  v_tenant_updated integer;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
  v_display_name text;
  v_attestation platform.registration_activation_attestations%rowtype;
  v_attestation_id uuid;
  v_verified_external jsonb;
  v_external_source text;
  v_external_account_id uuid;
  v_verified_name text;
  v_evidence_hash text;
  v_commercial text;
  v_national text;
  v_identifier_type text;
  v_identifier_value text;
  v_identifier_hash text;
  v_identifier_claim_tenant_id uuid;
  v_external_claim platform.registration_external_account_claims%rowtype;
  v_tenant_settings jsonb;
  v_invitation access_control.tenant_invitations%rowtype;
  v_invitation_token text;
  v_owner_status text;
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

  -- A committed activation can be retried with the caller's stale version. If
  -- the original owner invitation response was lost, rotate only the exact
  -- pending invitation recorded by this request and audit the recovery.
  if v_request.status='converted' and v_request.provisioned_tenant_id is not null then
    select tenant.*
    into v_tenant
    from core.tenants tenant
    where tenant.id=v_request.provisioned_tenant_id;
    if v_tenant.id is null then
      raise exception 'registration_activation_target_missing';
    end if;
    if v_tenant.settings->>'registrationRequestId' is distinct from
         v_request.id::text
       or v_tenant.settings->>'registrationActivationMode' is distinct from
         'manual_review'
       or v_tenant.settings->>'registrationResolution' is distinct from
         'create_new'
       or v_request.metadata->>'manualActivationResolution' is distinct from
         'create_new' then
      raise exception 'registration_activation_replay_invalid';
    end if;

    v_provisioning:=jsonb_build_object(
      'id',v_tenant.id,
      'slug',v_tenant.slug,
      'status',v_tenant.status,
      'resolution','create_new',
      'replayed',true
    );
    v_owner_status:=v_request.metadata->>'ownerProvisioningStatus';

    if v_tenant.status='active'
       and coalesce(v_request.metadata->>'ownerInvitationId','') ~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select invitation.*
      into v_invitation
      from access_control.tenant_invitations invitation
      where invitation.id=(v_request.metadata->>'ownerInvitationId')::uuid
        and invitation.tenant_id=v_tenant.id
        and invitation.role_key='tenant_owner'
        and invitation.email=lower(trim(
          v_request.metadata->>'ownerProvisioningEmail'
        ))
      for update;

      if v_invitation.id is not null and v_invitation.status='pending' then
        v_invitation_token:=encode(extensions.gen_random_bytes(32),'hex');
        update access_control.tenant_invitations invitation
        set token_hash=encode(
              extensions.digest(v_invitation_token,'sha256'),'hex'
            ),
            expires_at=now()+interval '7 days',
            invited_by_subject_id=v_actor
        where invitation.id=v_invitation.id
          and invitation.status='pending';

        perform private_app.write_audit(
          'platform.registration_request.owner_invitation_rotated',
          'invitation',v_invitation.id::text,v_tenant.id,
          jsonb_build_object(
            'registrationRequestId',v_request.id,
            'registrationReference',v_request.request_reference,
            'reason','activation_response_replay'
          )
        );
        v_owner_status:='invited';
      elsif v_invitation.id is not null and v_invitation.status='accepted' then
        v_owner_status:='linked';
      end if;
    end if;

    if v_owner_status is not null then
      v_provisioning:=v_provisioning||jsonb_build_object(
        'owner',jsonb_strip_nulls(jsonb_build_object(
          'status',v_owner_status,
          'invitationId',v_invitation.id,
          'invitationToken',v_invitation_token
        ))
      );
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
      'provisioning',v_provisioning
    );
  end if;

  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  if v_request.status not in ('under_review','approved') then
    raise exception 'registration_transition_invalid';
  end if;
  if p_payload is null
     or jsonb_typeof(p_payload)<>'object'
     or pg_catalog.pg_column_size(p_payload)>32768 then
    raise exception 'registration_payload_invalid';
  end if;
  if v_notes is not null and char_length(v_notes)>1200 then
    raise exception 'registration_notes_too_long';
  end if;
  if p_payload->'identityVerified' is distinct from 'true'::jsonb then
    raise exception 'registration_identity_verification_required';
  end if;
  if trim(coalesce(p_payload->>'resolution',''))<>'create_new'
     or p_payload ? 'targetTenantSlug' then
    raise exception 'registration_activation_resolution_invalid';
  end if;
  if p_payload->'confirmedNoExistingTenant' is distinct from 'true'::jsonb then
    raise exception 'registration_no_existing_tenant_confirmation_required';
  end if;
  if p_payload ? 'serverVerifiedExternalAccount' then
    raise exception 'registration_server_verification_payload_forbidden';
  end if;

  if v_request.institution_state='existing' then
    if v_request.external_account_id is null then
      raise exception 'registration_external_account_required';
    end if;
    if coalesce(p_payload->>'attestationId','') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'registration_attestation_required';
    end if;
    v_attestation_id:=(p_payload->>'attestationId')::uuid;

    select attestation.*
    into v_attestation
    from platform.registration_activation_attestations attestation
    where attestation.id=v_attestation_id
    for update;

    if v_attestation.id is null
       or v_attestation.request_id is distinct from v_request.id
       or v_attestation.request_version is distinct from v_request.version
       or v_attestation.requested_by_subject_id is distinct from v_actor
       or v_attestation.status<>'completed'
       or v_attestation.expires_at<=pg_catalog.clock_timestamp()
       or v_attestation.source_system is distinct from 'marktone_directory'
       or v_attestation.external_account_id is distinct from
          v_request.external_account_id
       or v_attestation.directory_evidence is null
       or v_attestation.evidence_hash is null then
      raise exception 'registration_attestation_invalid';
    end if;

    v_verified_external:=v_attestation.directory_evidence;
    v_external_source:=v_attestation.source_system;
    v_external_account_id:=v_attestation.external_account_id;
    v_evidence_hash:=v_attestation.evidence_hash;
    v_verified_name:=trim(coalesce(
      v_verified_external->>'institutionName',''
    ));
    -- Public directory identifiers remain display-only. The verified account
    -- UUID is the sole external uniqueness claim for an existing institution.
    v_commercial:=null;
    v_national:=null;

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
       or nullif(trim(coalesce(p_payload->>'attestationId','')),'') is not null then
      raise exception 'registration_new_institution_external_account_invalid';
    end if;
    v_verified_name:=v_request.institution_name;
    v_commercial:=case
      when coalesce(v_request.commercial_registration,'') ~
             '^[0-9]{10}$'
       and coalesce(v_request.commercial_registration,'') !~
             '^([0-9])\1{9}$'
        then v_request.commercial_registration
      else null
    end;
    v_national:=case
      when coalesce(v_request.national_registration,'') ~
             '^7[0-9]{9}$'
       and coalesce(v_request.national_registration,'') !~
             '^([0-9])\1{9}$'
        then v_request.national_registration
      else null
    end;
  end if;

  -- Deterministic advisory locks avoid provisioning two tenants before the
  -- identity-claim trigger detects the collision and rolls one transaction back.
  for v_identifier_type,v_identifier_value in
    select identifier.identifier_type,identifier.identifier_value
    from (values
      ('commercial',v_commercial),
      ('national',v_national)
    ) identifier(identifier_type,identifier_value)
    where identifier.identifier_value is not null
    order by identifier.identifier_type
  loop
    v_identifier_hash:=encode(extensions.digest(
      v_identifier_type||':'||v_identifier_value,'sha256'
    ),'hex');
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'registration-identity:'||v_identifier_type||':'||v_identifier_hash,0
      )
    );
    v_identifier_claim_tenant_id:=null;
    select claim.tenant_id
    into v_identifier_claim_tenant_id
    from platform.registration_identity_claims claim
    where claim.identifier_type=v_identifier_type
      and claim.identifier_hash=v_identifier_hash
    for update;
    if v_identifier_claim_tenant_id is not null then
      raise exception 'registration_identifier_already_provisioned';
    end if;
  end loop;

  v_display_name:=case when v_request.institution_state='existing'
    then v_verified_name
    else coalesce(nullif(trim(p_payload->>'displayName'),''),v_verified_name)
  end;
  v_tenant_settings:=jsonb_strip_nulls(jsonb_build_object(
    'registrationRequestId',v_request.id::text,
    'registrationReference',v_request.request_reference,
    'registrationActivationMode','manual_review',
    'registrationTrustStatus','trusted',
    'registrationResolution','create_new',
    'registrationExternalSource',v_external_source,
    'registrationExternalAccountId',v_external_account_id,
    'registrationEvidenceHash',v_evidence_hash,
    'registrationActivationAttestationId',v_attestation_id,
    'registrationActivatedAt',now()
  ));

  v_provisioning:=private_app.provision_tenant_core(
    v_display_name,
    case when v_request.institution_state='existing'
      then v_verified_name
      else coalesce(nullif(trim(p_payload->>'legalName'),''),v_display_name)
    end,
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
    'status','active','resolution','create_new'
  );

  if v_external_account_id is not null then
    insert into platform.registration_external_account_claims(
      source_system,external_account_id,tenant_id,originating_request_id,
      verification_method,evidence_hash,claimed_by_subject_id
    ) values (
      v_external_source,v_external_account_id,v_tenant_id,v_request.id,
      'directory_verified',v_evidence_hash,v_actor
    ) on conflict (source_system,external_account_id) do nothing;

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

    update platform.registration_activation_attestations attestation
    set status='consumed',consumed_at=now()
    where attestation.id=v_attestation.id
      and attestation.status='completed';
    get diagnostics v_tenant_updated=row_count;
    if v_tenant_updated<>1 then
      raise exception 'registration_attestation_invalid';
    end if;
  end if;

  v_from_status:=v_request.status;
  update platform.registration_requests request
  set institution_name=v_verified_name,
      status='converted',
      trust_status='trusted',
      provisioned_tenant_id=v_tenant_id,
      reviewed_by_subject_id=v_actor,
      review_started_at=coalesce(request.review_started_at,now()),
      reviewed_at=now(),
      review_notes=coalesce(v_notes,request.review_notes),
      version=request.version+1,
      metadata=request.metadata||jsonb_strip_nulls(jsonb_build_object(
        'manualActivationResolution','create_new',
        'provisionedAt',now(),
        'provisionedSlug',v_provisioning->>'slug',
        'identityVerifiedAt',now(),
        'identityVerifiedBySubjectId',v_actor,
        'activationAttestationId',v_attestation_id,
        'registrationExternalSource',v_external_source,
        'registrationExternalAccountId',v_external_account_id,
        'registrationEvidenceHash',v_evidence_hash,
        'ownerProvisioningStatus',v_provisioning#>>'{owner,status}',
        'ownerProvisioningEmail',v_provisioning#>>'{owner,email}',
        'ownerInvitationId',v_provisioning#>>'{owner,invitationId}'
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
      'resolution','create_new',
      'identityVerified',true,
      'attestationId',v_attestation_id
    )
  );

  perform private_app.write_audit(
    'platform.registration_request.approve_and_activate',
    'registration_request',v_request.id::text,null,
    jsonb_build_object(
      'reference',v_request.request_reference,
      'fromStatus',v_from_status,
      'toStatus','converted',
      'resolution','create_new',
      'tenantId',v_tenant_id,
      'attestationId',v_attestation_id
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

revoke all on function public.v1_platform_registration_activation_attestation_prepare(
  uuid,integer
) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_registration_activation_attestation_prepare(
  uuid,integer
) to authenticated;

revoke all on function public.v1_platform_registration_requests_snapshot(
  text,text,integer,integer
) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_registration_requests_snapshot(
  text,text,integer,integer
) to authenticated;

revoke all on function public.v1_registration_activation_attestation_complete(
  uuid,text,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.v1_registration_activation_attestation_complete(
  uuid,text,jsonb
) to service_role;

revoke all on function public.v1_platform_registration_approve_and_activate(
  uuid,integer,text,jsonb
) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_registration_approve_and_activate(
  uuid,integer,text,jsonb
) to authenticated;

comment on table platform.registration_external_account_claims is
'Immutable binding from one server-attested directory account to one newly created current-stack tenant and registration request.';
comment on table platform.registration_activation_attestations is
'Private, short-lived, actor/request/version-bound handoff between platform review and server-side directory verification.';
comment on function public.v1_platform_registration_activation_attestation_prepare(
  uuid,integer
) is
'Creates a five-minute nonce for an authorized reviewer and one existing-institution request version.';
comment on function public.v1_registration_activation_attestation_complete(
  uuid,text,jsonb
) is
'Service-role-only completion of allowlisted directory evidence; safe identical retries do not rewrite evidence.';
comment on function public.v1_platform_registration_approve_and_activate(
  uuid,integer,text,jsonb
) is
'Atomically approves a manual request and creates only a new isolated active tenant; existing directory requests require a consumed-once server attestation.';

commit;
