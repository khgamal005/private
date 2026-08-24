import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260824170000_registration_manual_activation_integrity_v1.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
}

test('external directory claims are current-stack tenant references and immutable',async()=>{
  const migration=await read(MIGRATION);
  const claims=section(
    migration,
    'create table platform.registration_external_account_claims',
    'create table platform.registration_activation_attestations'
  );

  assert.match(claims,/tenant_id uuid not null[\s\S]*?references core\.tenants\(id\) on delete restrict/);
  assert.match(claims,/primary key \(source_system,external_account_id\)/);
  assert.match(claims,/unique \(originating_request_id\)/);
  assert.match(migration,/alter table platform\.registration_external_account_claims enable row level security/);
  assert.match(migration,/revoke all on table platform\.registration_external_account_claims[\s\S]*?from public,anon,authenticated,service_role/);
  assert.match(migration,/create trigger platform_registration_external_claim_immutable[\s\S]*?before update or delete/);
  assert.match(migration,/raise exception 'registration_external_claim_immutable'/);
  assert.doesNotMatch(claims,/platform\.tenants/);
});

test('directory proof uses a short-lived actor/request/version-bound two-step attestation',async()=>{
  const migration=await read(MIGRATION);
  const prepare=section(
    migration,
    'create or replace function public.v1_platform_registration_activation_attestation_prepare',
    'create or replace function public.v1_registration_activation_attestation_complete'
  );
  const complete=section(
    migration,
    'create or replace function public.v1_registration_activation_attestation_complete',
    'create or replace function public.v1_platform_registration_approve_and_activate'
  );

  assert.match(migration,/create table platform\.registration_activation_attestations/);
  assert.match(migration,/request_version integer not null/);
  assert.match(migration,/requested_by_subject_id uuid not null/);
  assert.match(migration,/nonce_hash text not null unique/);
  assert.match(migration,/status in \('prepared','completed','consumed','superseded'\)/);
  assert.match(migration,/expires_at>prepared_at/);
  assert.match(migration,/source_system is not distinct from 'marktone_directory'/);
  assert.match(migration,/alter table platform\.registration_activation_attestations enable row level security/);
  assert.match(migration,/revoke all on table platform\.registration_activation_attestations[\s\S]*?from public,anon,authenticated,service_role/);

  assert.match(prepare,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(prepare,/v_actor:=private_app\.current_subject_id\(\)/);
  assert.match(prepare,/p_expected_version<>v_request\.version/);
  assert.match(prepare,/for update/);
  assert.match(prepare,/v_prepared_at:=pg_catalog\.clock_timestamp\(\)/);
  assert.match(prepare,/v_expires_at:=v_prepared_at\+interval '5 minutes'/);
  assert.match(prepare,/request_id,request_version,requested_by_subject_id,nonce_hash,[\s\S]*?prepared_at,expires_at/);
  assert.match(prepare,/set status='superseded'/);

  assert.match(complete,/v_attestation\.request_version is distinct from v_request\.version/);
  assert.match(complete,/v_attestation\.expires_at<=pg_catalog\.clock_timestamp\(\)/);
  assert.match(complete,/extensions\.digest\(p_nonce,'sha256'\)/);
  assert.match(complete,/v_external_account_id<>v_request\.external_account_id/);
  const evidenceSnapshot=section(
    complete,
    'v_snapshot:=jsonb_strip_nulls',
    'v_evidence_hash:='
  );
  assert.match(evidenceSnapshot,/'sourceSystem',v_source/);
  assert.match(evidenceSnapshot,/'accountId',v_external_account_id/);
  assert.match(evidenceSnapshot,/'institutionName',v_verified_name/);
  assert.doesNotMatch(evidenceSnapshot,/officialIdentifiers|commercial|national|tvtc/i);
  assert.doesNotMatch(complete,/p_directory_evidence->'officialIdentifiers'/);
  assert.match(complete,/set status='completed'/);
  assert.match(complete,/directory_evidence=v_snapshot/);
  assert.match(complete,/pg_catalog\.pg_column_size\(p_directory_evidence\)>131072/);
  assert.match(complete,/activation_attestation_completed/);
  assert.match(complete,/insert into audit_log\.events\([\s\S]*?null,v_attestation\.requested_by_subject_id/);
  assert.doesNotMatch(complete,/private_app\.write_audit\(/);
  assert.match(complete,/if v_attestation\.status='completed'[\s\S]*?'replayed',true/);

  const compact=migration.replace(/\s+/g,'');
  assert.ok(compact.includes(
    'grantexecuteonfunctionpublic.v1_platform_registration_activation_attestation_prepare(uuid,integer)toauthenticated;'
  ));
  assert.ok(compact.includes(
    'grantexecuteonfunctionpublic.v1_registration_activation_attestation_complete(uuid,text,jsonb)toservice_role;'
  ));
  assert.equal(
    /grantexecuteonfunctionpublic\.v1_registration_activation_attestation_complete\(uuid,text,jsonb\)to(?:anon|authenticated);/.test(compact),
    false
  );
});

test('identity claims accept raw canonical CR or national values only and never directory or TVTC display data',async()=>{
  const migration=await read(MIGRATION);
  const claimSync=section(
    migration,
    'create or replace function private_app.registration_identity_claim_sync',
    'revoke all on function private_app.registration_identity_claim_sync'
  );
  const approve=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    'revoke all on function public.v1_platform_registration_activation_attestation_prepare'
  );
  const existingBranch=section(
    approve,
    "if v_request.institution_state='existing' then",
    'else\n    if v_request.external_account_id is not null'
  );
  const newBranch=section(
    approve,
    'else\n    if v_request.external_account_id is not null',
    '-- Deterministic advisory locks'
  );
  const claimLocks=section(
    approve,
    '-- Deterministic advisory locks',
    'v_display_name:=case'
  );

  assert.match(claimSync,/new\.institution_state is distinct from 'new'/);
  assert.match(claimSync,/coalesce\(new\.commercial_registration,''\) ~\s*'\^\[0-9\]\{10\}\$'/);
  assert.match(claimSync,/coalesce\(new\.national_registration,''\) ~\s*'\^7\[0-9\]\{9\}\$'/);
  assert.doesNotMatch(claimSync,/regexp_replace|translate\(|trim\(|tvtc/i);
  assert.match(existingBranch,/v_commercial:=null/);
  assert.match(existingBranch,/v_national:=null/);
  assert.doesNotMatch(existingBranch,/officialIdentifiers|regexp_replace|tvtc/i);
  assert.match(newBranch,/'\^\[0-9\]\{10\}\$'/);
  assert.match(newBranch,/'\^7\[0-9\]\{9\}\$'/);
  assert.doesNotMatch(newBranch,/regexp_replace|tvtc/i);
  assert.doesNotMatch(claimLocks,/\('tvtc'|v_tvtc/i);

  const commercialClaimable=value=>
    /^[0-9]{10}$/.test(value)&&!/^([0-9])\1{9}$/.test(value);
  const nationalClaimable=value=>
    /^7[0-9]{9}$/.test(value)&&!/^([0-9])\1{9}$/.test(value);
  const unsafe=[
    'MASKED-1234567890',
    'hidden-7123456789',
    '7890',
    'N-A',
    ' 1234567890 ',
    '12345-67890',
    'رقم7123456789',
    'رقم-٧١٢٣٤٥٦٧٨٩',
    'ABC1234567890'
  ];
  for(const value of unsafe){
    assert.equal(commercialClaimable(value),false,`unsafe CR became claimable: ${value}`);
    assert.equal(nationalClaimable(value),false,`unsafe national became claimable: ${value}`);
  }
  assert.equal(commercialClaimable('1234567890'),true);
  assert.equal(nationalClaimable('7123456789'),true);
  assert.equal(commercialClaimable('1111111111'),false);
});

test('approved stays a compatible review state and only misleading trusted legacy rows are repaired',async()=>{
  const migration=await read(MIGRATION);
  const trust=section(
    migration,
    'create or replace function private_app.registration_manual_trust_sync',
    '-- Repair only the exact misleading legacy state.'
  );
  const repair=section(
    migration,
    '-- Repair only the exact misleading legacy state.',
    'alter table platform.registration_requests'
  );

  assert.match(trust,/when 'approved' then 'pending_review'/);
  assert.doesNotMatch(trust,/registration_atomic_activation_required/);
  assert.match(repair,/request\.activation_mode='manual_review'/);
  assert.match(repair,/request\.status='approved'/);
  assert.match(repair,/request\.provisioned_tenant_id is null/);
  assert.match(repair,/request\.trust_status='trusted'/);
  assert.match(repair,/version=request\.version\+1/);
  assert.match(repair,/'manual_trust_repair'/);
  assert.match(repair,/insert into audit_log\.events/);
  assert.match(migration,/check \(status<>'converted' or provisioned_tenant_id is not null\)/);
});

test('snapshot filters virtual queue statuses before pagination and keeps its summary global',async()=>{
  const migration=await read(MIGRATION);
  const snapshot=section(
    migration,
    'create or replace function public.v1_platform_registration_requests_snapshot',
    'create or replace function public.v1_platform_registration_activation_attestation_prepare'
  );

  assert.match(snapshot,/has_platform_permission\('platform\.tenants\.manage'\)/);
  for(const status of [
    'awaiting_email','trust_pending','trust_review','trust_restricted',
    'manual_attention','trust_attention','restricted'
  ]){
    assert.match(snapshot,new RegExp(`'${status}'`));
  }
  assert.match(snapshot,/with classified as materialized/);
  assert.match(snapshot,/end as queue_status/);
  assert.match(snapshot,/matched as materialized/);
  assert.match(snapshot,/v_status is null[\s\S]*?or request\.queue_status=v_status/);
  assert.match(snapshot,/v_status='manual_attention'[\s\S]*?request\.queue_status in \('pending_review','under_review'\)/);
  assert.match(snapshot,/v_status='trust_attention'[\s\S]*?request\.queue_status in \('trust_pending','trust_review'\)/);
  assert.match(snapshot,/v_status='restricted'[\s\S]*?request\.queue_status in \('rejected','trust_restricted'\)/);
  assert.match(snapshot,/position\(v_query in lower\(request\.request_reference\)\)>0/);
  assert.match(snapshot,/'summary',[\s\S]*?from classified request/);
  assert.match(snapshot,/'total',\(select count\(\*\) from matched\)/);
  assert.ok(
    snapshot.indexOf('from matched filtered')<snapshot.indexOf('limit v_limit offset v_offset'),
    'virtual filtering and search must happen before pagination'
  );
  assert.match(snapshot,/'status',filtered\.queue_status/);

  const compact=migration.replace(/\s+/g,'');
  assert.ok(compact.includes(
    'grantexecuteonfunctionpublic.v1_platform_registration_requests_snapshot(text,text,integer,integer)toauthenticated;'
  ));
});

test('manual activation accepts create_new only and never resolves an existing tenant',async()=>{
  const migration=await read(MIGRATION);
  const approve=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    'revoke all on function public.v1_platform_registration_activation_attestation_prepare'
  );

  assert.match(approve,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(approve,/v_actor:=private_app\.current_subject_id\(\)/);
  assert.match(approve,/v_request\.status not in \('under_review','approved'\)/);
  assert.match(approve,/trim\(coalesce\(p_payload->>'resolution',''\)\)<>'create_new'/);
  assert.match(approve,/p_payload \? 'targetTenantSlug'/);
  assert.match(approve,/v_provisioning:=private_app\.provision_tenant_core\(/);
  assert.match(approve,/'verified_email'/);
  assert.match(approve,/tenant\.id=v_tenant_id/);
  assert.match(approve,/tenant\.settings->>'registrationRequestId'=v_request\.id::text/);
  assert.match(approve,/tenant\.settings->>'registrationResolution'='create_new'/);
  assert.match(approve,/v_display_name:=case when v_request\.institution_state='existing'[\s\S]*?then v_verified_name/);
  assert.match(approve,/case when v_request\.institution_state='existing'[\s\S]*?then v_verified_name[\s\S]*?else coalesce\(nullif\(trim\(p_payload->>'legalName'/);
  assert.doesNotMatch(migration,/link_existing/);
  assert.doesNotMatch(approve,/select[\s\S]*?from core\.tenants[\s\S]*?(?:slug|organization_id)\s*=/i);
});

test('existing institutions require one completed attestation owned by the same reviewer',async()=>{
  const migration=await read(MIGRATION);
  const approve=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    'revoke all on function public.v1_platform_registration_activation_attestation_prepare'
  );

  assert.match(approve,/if v_request\.institution_state='existing' then/);
  assert.match(approve,/v_attestation\.request_id is distinct from v_request\.id/);
  assert.match(approve,/v_attestation\.request_version is distinct from v_request\.version/);
  assert.match(approve,/v_attestation\.requested_by_subject_id is distinct from v_actor/);
  assert.match(approve,/v_attestation\.status<>'completed'/);
  assert.match(approve,/v_attestation\.expires_at<=pg_catalog\.clock_timestamp\(\)/);
  assert.match(approve,/v_attestation\.external_account_id is distinct from[\s\S]*?v_request\.external_account_id/);
  assert.match(approve,/set status='consumed',consumed_at=now\(\)/);
  assert.match(approve,/if v_tenant_updated<>1 then[\s\S]*?registration_attestation_invalid/);
  assert.match(approve,/p_payload \? 'serverVerifiedExternalAccount'[\s\S]*?registration_server_verification_payload_forbidden/);
  assert.doesNotMatch(approve,/p_payload->'serverVerifiedExternalAccount'/);
});

test('new institutions cannot smuggle external proof or an attestation',async()=>{
  const migration=await read(MIGRATION);
  const approve=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    'revoke all on function public.v1_platform_registration_activation_attestation_prepare'
  );
  const newBranch=section(
    approve,
    'else\n    if v_request.external_account_id is not null',
    '-- Deterministic advisory locks'
  );

  assert.match(newBranch,/nullif\(trim\(coalesce\(p_payload->>'attestationId',''\)\),''\) is not null/);
  assert.doesNotMatch(newBranch,/p_payload \? 'attestationId'/);
  assert.match(newBranch,/registration_new_institution_external_account_invalid/);
});

test('identifier and external-account claims are serialized before provisioning',async()=>{
  const migration=await read(MIGRATION);
  const approve=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    'revoke all on function public.v1_platform_registration_activation_attestation_prepare'
  );
  const provisionAt=approve.indexOf('v_provisioning:=private_app.provision_tenant_core');
  assert.notEqual(provisionAt,-1);

  const externalLockAt=approve.indexOf("v_external_source||':'||v_external_account_id::text");
  const identifierLockAt=approve.indexOf("'registration-identity:'||v_identifier_type");
  assert.ok(externalLockAt>-1&&externalLockAt<provisionAt);
  assert.ok(identifierLockAt>-1&&identifierLockAt<provisionAt);
  assert.match(approve,/order by identifier\.identifier_type/);
  assert.match(approve,/from platform\.registration_identity_claims claim[\s\S]*?for update/);
  assert.match(approve,/registration_identifier_already_provisioned/);
  assert.match(approve,/on conflict \(source_system,external_account_id\) do nothing/);
  assert.match(approve,/registration_external_account_already_claimed/);
});

test('activation replay returns only exact tenant provenance and safely recovers pending owner invitation',async()=>{
  const migration=await read(MIGRATION);
  const approve=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    'revoke all on function public.v1_platform_registration_activation_attestation_prepare'
  );
  const replay=section(
    approve,
    "if v_request.status='converted' and v_request.provisioned_tenant_id is not null then",
    'if p_expected_version is null'
  );

  assert.match(replay,/tenant\.id=v_request\.provisioned_tenant_id/);
  assert.match(replay,/v_tenant\.settings->>'registrationRequestId' is distinct from[\s\S]*?v_request\.id::text/);
  assert.match(replay,/v_tenant\.settings->>'registrationActivationMode' is distinct from[\s\S]*?'manual_review'/);
  assert.match(replay,/v_tenant\.settings->>'registrationResolution' is distinct from[\s\S]*?'create_new'/);
  assert.match(replay,/v_request\.metadata->>'manualActivationResolution' is distinct from[\s\S]*?'create_new'/);
  assert.match(replay,/registration_activation_replay_invalid/);
  assert.match(replay,/if v_tenant\.status='active'/);
  assert.match(replay,/invitation\.id=\(v_request\.metadata->>'ownerInvitationId'\)::uuid/);
  assert.match(replay,/invitation\.tenant_id=v_tenant\.id/);
  assert.match(replay,/invitation\.role_key='tenant_owner'/);
  assert.match(replay,/invitation\.email=lower\(trim\([\s\S]*?ownerProvisioningEmail/);
  assert.match(replay,/v_invitation\.status='pending'/);
  assert.match(replay,/set token_hash=encode\([\s\S]*?expires_at=now\(\)\+interval '7 days'/);
  assert.match(replay,/owner_invitation_rotated/);
  assert.match(replay,/v_invitation\.status='accepted'[\s\S]*?v_owner_status:='linked'/);
  assert.match(replay,/'invitationToken',v_invitation_token/);
  assert.match(approve,/'ownerInvitationId',v_provisioning#>>'\{owner,invitationId\}'/);
  assert.match(approve,/'ownerProvisioningEmail',v_provisioning#>>'\{owner,email\}'/);
});

test('migration remains tenant-neutral',async()=>{
  const migration=await read(MIGRATION);
  assert.doesNotMatch(migration,/reef|ريف/i);
  assert.doesNotMatch(
    migration,
    /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i
  );
  assert.doesNotMatch(migration,/delete from core\.tenants|update core\.tenants[\s\S]*?where tenant\.slug=/i);
});
