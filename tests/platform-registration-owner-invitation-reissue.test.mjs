import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260825213500_registration_owner_invitation_reissue_v1.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
}

function assertOrdered(source,needles){
  let cursor=-1;
  for(const needle of needles){
    const next=source.indexOf(needle,cursor+1);
    assert.notEqual(next,-1,`missing ordered contract: ${needle}`);
    assert.ok(next>cursor,`out-of-order contract: ${needle}`);
    cursor=next;
  }
}

test('owner invitation reissue is permissioned, request-versioned, and manual-only',async()=>{
  const migration=await read(MIGRATION);
  const rpc=section(
    migration,
    'create or replace function public.v1_platform_registration_owner_invitation_reissue',
    'revoke all on function public.v1_platform_registration_owner_invitation_reissue'
  );

  assert.match(rpc,/security definer\s+set search_path=''/);
  assert.match(rpc,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(rpc,/v_actor:=private_app\.current_subject_id\(\)/);
  assertOrdered(rpc,[
    'where request.id=p_request_id\n  for update',
    'p_expected_version<>v_request.version',
    "v_request.status<>'converted'",
    "v_request.activation_mode<>'manual_review'",
    "v_invitation_token:=encode(extensions.gen_random_bytes(32),'hex')",
    'set version=request.version+1'
  ]);
  assert.match(rpc,/where request\.id=v_request\.id\s+and request\.version=p_expected_version/);
  assert.match(rpc,/raise exception 'registration_request_conflict'/);
  assert.doesNotMatch(rpc,/reef|from platform\.tenants|update platform\.tenants/i);
});

test('reissue verifies exact tenant provenance and the recorded owner identity',async()=>{
  const migration=await read(MIGRATION);
  const rpc=section(
    migration,
    'create or replace function public.v1_platform_registration_owner_invitation_reissue',
    'revoke all on function public.v1_platform_registration_owner_invitation_reissue'
  );

  for(const contract of [
    "tenant.id=v_request.provisioned_tenant_id",
    "v_tenant.status<>'active'",
    "v_tenant.settings->>'registrationRequestId' is distinct from",
    "v_tenant.settings->>'registrationActivationMode' is distinct from",
    "v_tenant.settings->>'registrationResolution' is distinct from",
    "v_request.metadata->>'manualActivationResolution' is distinct from",
    "v_request.metadata->>'ownerProvisioningEmail'",
    'invitation.id=v_old_invitation_id',
    'invitation.tenant_id=v_tenant.id',
    "invitation.role_key='tenant_owner'",
    'invitation.email=v_owner_email'
  ])assert.ok(rpc.includes(contract),`missing provenance contract: ${contract}`);

  assert.match(rpc,/registration_owner_identity_conflict/);
  assert.match(rpc,/registration_owner_invitation_provenance_mismatch/);
  assert.doesNotMatch(rpc,/p_owner|p_email|p_tenant/);
});

test('live owner membership is authoritative and accepted invitations cannot restore removed access',async()=>{
  const migration=await read(MIGRATION);
  const rpc=section(
    migration,
    'create or replace function public.v1_platform_registration_owner_invitation_reissue',
    'revoke all on function public.v1_platform_registration_owner_invitation_reissue'
  );

  for(const contract of [
    "membership.scope='tenant'",
    "membership.status='active'",
    "subject.status='active'",
    'lower(subject.email)=v_owner_email',
    "role.role_key='tenant_owner'",
    "'status','linked'",
    "if v_invitation.status='accepted' then",
    "raise exception 'registration_owner_access_inactive'"
  ])assert.ok(rpc.includes(contract),`missing live-owner contract: ${contract}`);

  const accepted=section(
    rpc,
    "if v_invitation.status='accepted' then",
    "if v_invitation.status='revoked' then"
  );
  assert.match(accepted,/access_control\.memberships/);
  assert.match(accepted,/registration_owner_access_inactive/);
  assert.doesNotMatch(accepted,/insert into access_control\.memberships|update access_control\.memberships/);
});

test('pending links rotate, expired rows remain historical, and revoked links fail closed',async()=>{
  const migration=await read(MIGRATION);
  const rpc=section(
    migration,
    'create or replace function public.v1_platform_registration_owner_invitation_reissue',
    'revoke all on function public.v1_platform_registration_owner_invitation_reissue'
  );

  assert.match(rpc,/v_invitation\.status not in \('pending','expired'\)/);
  assert.match(rpc,/if v_invitation\.status='pending' then[\s\S]*?update access_control\.tenant_invitations/);
  assert.match(rpc,/set token_hash=encode\([\s\S]*?extensions\.digest\(v_invitation_token,'sha256'\)/);
  assert.match(rpc,/v_invitation_expires_at:=now\(\)\+interval '7 days'/);
  assert.match(rpc,/else[\s\S]*?insert into access_control\.tenant_invitations/);
  assert.match(rpc,/exception when unique_violation then\s+raise exception 'registration_owner_invitation_conflict'/);
  assert.match(rpc,/if v_invitation\.status='revoked' then\s+raise exception 'registration_owner_invitation_revoked'/);
  assert.doesNotMatch(rpc,/set status='pending'[\s\S]*?where invitation\.id=v_invitation\.id/);
});

test('token is returned once, while metadata, event, and audit keep only safe identifiers',async()=>{
  const migration=await read(MIGRATION);
  const eventAndAudit=section(
    migration,
    'insert into platform.registration_request_events(',
    'return jsonb_build_object('
  );
  const metadataUpdate=section(
    migration,
    'update platform.registration_requests request',
    'insert into platform.registration_request_events('
  );
  const compact=migration.replace(/\s+/g,'');

  assert.doesNotMatch(metadataUpdate,/v_invitation_token|token_hash|invitationToken/);
  assert.doesNotMatch(eventAndAudit,/v_invitation_token|token_hash|invitationToken/);
  assert.match(eventAndAudit,/platform\.registration_request\.owner_invitation_reissued/);
  assert.match(migration,/'invitationToken',v_invitation_token/);
  assert.match(migration,/'invitationExpiresAt',v_invitation_expires_at/);
  assert.ok(compact.includes(
    'revokeallonfunctionpublic.v1_platform_registration_owner_invitation_reissue(uuid,integer)frompublic,anon,authenticated,service_role;'
  ));
  assert.ok(compact.includes(
    'grantexecuteonfunctionpublic.v1_platform_registration_owner_invitation_reissue(uuid,integer)toauthenticated;'
  ));
});

test('API exposes only the dedicated RPC and validates before converting the token to a URL',async()=>{
  const route=await read('app/api/platform/registration-requests/route.js');
  const post=section(route,'export async function POST','function activationPayload');
  const validator=section(
    route,
    'function validOwnerInvitationReissueResult',
    'function withInvitationUrl'
  );

  assert.match(route,/'reissue_owner_invitation'/);
  assert.match(post,/\?'v1_platform_registration_owner_invitation_reissue'/);
  assert.match(post,/p_request_id:requestId,\s+p_expected_version:expectedVersion/);
  assertOrdered(post,[
    "action==='reissue_owner_invitation'",
    'validOwnerInvitationReissueResult(result.data,requestId)',
    'const data=withInvitationUrl(result.data)'
  ]);
  for(const contract of [
    "requestActivationMode!=='manual_review'",
    "tenantActivationMode!=='manual_review'",
    "!['invited','linked'].includes(ownerStatus)",
    'isUuid(invitationId)',
    '/^[0-9a-f]{64}$/i.test(invitationToken)',
    'invitationExpiresAt>Date.now()'
  ])assert.ok(validator.includes(contract),`missing API response contract: ${contract}`);
  assert.match(route,/delete safeOwner\.invitationToken/);
  assert.match(route,/private, no-store, no-cache, max-age=0, must-revalidate/);
});

test('UI confirms invalidation, prevents double submit, and reuses the secure WhatsApp handoff',async()=>{
  const component=await read('components/platform-registration-requests.js');

  for(const copy of [
    'إصدار دعوة جديدة للمالك',
    'إصدار رابط تفعيل جديد للمالك الحالي؟',
    'سيتوقف رابط التفعيل السابق فورًا',
    'إلغاء الرابط القديم وإصدار الجديد',
    'سأرسل الرابط الجديد فقط في محادثة خاصة إلى المالك الصحيح',
    'تم إصدار رابط تفعيل جديد',
    'المالك فعّل حسابه بالفعل',
    'تم، العودة لتفاصيل الطلب'
  ])assert.ok(component.includes(copy),`missing reissue UI copy: ${copy}`);

  assert.match(component,/currentStatus==='converted'[\s\S]*?currentActivationMode==='manual_review'/);
  assert.match(component,/aria-haspopup="dialog"/);
  assert.match(component,/const actionLockRef=useRef\(false\)/);
  assert.match(component,/if\(!selected\?\.id\|\|busy\|\|actionLockRef\.current\)return false/);
  assert.match(component,/actionLockRef\.current=true/);
  assert.match(component,/actionLockRef\.current=false/);
  assert.match(component,/handoffReason:reissued\?'reissued':'created'/);
  assert.match(component,/keepRequestOpen=activationOutcome\?\.handoffReason==='reissued'/);
  assert.match(component,/fallbackFocus\?\.isConnected\?fallbackFocus:null/);
  assert.match(component,/buildRegistrationOwnerWhatsAppMessage/);
  assert.doesNotMatch(component,/wa\.me|localStorage|sessionStorage/);
});
