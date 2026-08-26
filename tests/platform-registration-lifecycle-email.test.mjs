import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION=
  'supabase/migrations/20260826210040_registration_lifecycle_email_outbox_v1.sql';

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

test('lifecycle mail expands the private outbox without storing PII or capabilities',async()=>{
  const migration=await read(MIGRATION);

  for(const contract of [
    "'confirmation','review_receipt','owner_invitation'",
    'add column if not exists invitation_id uuid',
    'add column if not exists source_version integer',
    'registration_email_delivery_invitation_scope_check',
    'platform_registration_email_source_version_idx',
    'platform_registration_email_invitation_idx'
  ])assert.ok(migration.includes(contract),`missing outbox contract: ${contract}`);

  assert.doesNotMatch(migration,/recipient_email|message_body|raw_token|invitation_url/i);
  assert.doesNotMatch(migration,/reef|ريف/i);
});

test('existing requests atomically enqueue one idempotent review receipt',async()=>{
  const migration=await read(MIGRATION);
  const enqueue=section(
    migration,
    'create or replace function private_app.registration_review_receipt_enqueue',
    'revoke all on function private_app.registration_review_receipt_enqueue'
  );
  const trigger=section(
    migration,
    'create or replace function private_app.registration_lifecycle_email_on_insert',
    'revoke all on function private_app.registration_lifecycle_email_on_insert'
  );

  for(const contract of [
    "v_request.institution_state<>'existing'",
    "v_request.activation_mode<>'manual_review'",
    "v_request.status not in ('pending_review','under_review','approved')",
    "'review_receipt'",
    "'registration-review-receipt-ar-v1'",
    'on conflict (request_id,message_kind,source_version)'
  ])assert.ok(enqueue.includes(contract),`missing review receipt contract: ${contract}`);
  assert.match(trigger,/new\.institution_state='existing'/);
  assert.match(trigger,/perform private_app\.registration_review_receipt_enqueue/);
  assert.match(migration,/after insert on platform\.registration_requests/);
  assert.doesNotMatch(enqueue,/provision_tenant_core|insert into core\.tenants|update core\.tenants/);
});

test('owner invitation email is tied to the exact converted request and pending invitation',async()=>{
  const migration=await read(MIGRATION);
  const enqueue=section(
    migration,
    'create or replace function private_app.registration_owner_invitation_email_enqueue',
    'revoke all on function private_app.registration_owner_invitation_email_enqueue'
  );
  const trigger=section(
    migration,
    'create or replace function private_app.registration_owner_email_on_update',
    'revoke all on function private_app.registration_owner_email_on_update'
  );

  for(const contract of [
    "v_request.status<>'converted'",
    'v_request.provisioned_tenant_id is null',
    "v_request.metadata->>'ownerProvisioningStatus'<>'invited'",
    "v_request.metadata->>'ownerInvitationId' is distinct from",
    'invitation.tenant_id=v_request.provisioned_tenant_id',
    "invitation.role_key='tenant_owner'",
    "invitation.status='pending'",
    "'registration-owner-invitation-ar-v1'"
  ])assert.ok(enqueue.includes(contract),`missing owner invite contract: ${contract}`);
  assert.match(trigger,/old\.metadata->>'ownerInvitationReissuedAt' is distinct from/);
  assert.match(trigger,/perform private_app\.registration_owner_invitation_email_enqueue/);
  assert.match(migration,/after update of status,provisioned_tenant_id,metadata/);
});

test('claim and bind preserve request-first locks and rotate only the exact invitation',async()=>{
  const migration=await read(MIGRATION);
  const claim=section(
    migration,
    'create or replace function public.v2_registration_email_delivery_claim',
    'create or replace function public.v2_registration_email_delivery_bind'
  );
  const bind=section(
    migration,
    'create or replace function public.v2_registration_email_delivery_bind',
    'create or replace function public.v2_registration_email_delivery_finish'
  );

  assertOrdered(claim,[
    'where request.id=v_request_id\n  for update',
    'where invitation.id=v_invitation_id\n    for update',
    'where delivery.id=p_delivery_id and delivery.request_id=v_request.id\n  for update'
  ]);
  assert.match(claim,/return public\.v1_registration_email_delivery_claim/);
  assert.match(claim,/v_request\.metadata->>'ownerInvitationId'=v_invitation\.id::text/);
  assert.match(bind,/return public\.v1_registration_email_delivery_bind/);
  assert.match(bind,/update access_control\.tenant_invitations invitation[\s\S]+set token_hash=p_token_hash/);
  assert.match(bind,/where invitation\.id=v_invitation\.id[\s\S]+invitation\.status='pending'/);
  assert.doesNotMatch(bind,/insert into core\.tenants|update core\.tenants|provision_tenant_core/);
});

test('notification failures never mutate request or tenant state',async()=>{
  const migration=await read(MIGRATION);
  const finish=section(
    migration,
    'create or replace function public.v2_registration_email_delivery_finish',
    'create or replace function public.v2_registration_email_delivery_fail_safe'
  );
  const failSafe=section(
    migration,
    'create or replace function public.v2_registration_email_delivery_fail_safe',
    'create or replace function public.v1_platform_registration_email_delivery_status'
  );

  assert.match(finish,/review_receipt_sent/);
  assert.match(finish,/owner_invitation_email_sent/);
  assert.match(finish,/state='retryable'/);
  assert.match(finish,/state='terminal_failed'/);
  assert.match(failSafe,/'requestChanged',false/);
  assert.doesNotMatch(failSafe,/update platform\.registration_requests|provision_tenant_core|core\.tenants/);
  assert.doesNotMatch(finish,/update platform\.registration_requests|provision_tenant_core|core\.tenants/);
});

test('lifecycle worker renders a receipt without a link and an owner email with a one-time link',async()=>{
  const edge=await read('supabase/functions/odeir-registration-intake/index.ts');
  const renderer=section(edge,'function lifecycleEmailMessage','function confirmationMessage');

  for(const contract of [
    'v1_registration_review_receipt_ensure',
    'v2_registration_email_delivery_claim',
    'v2_registration_email_delivery_bind',
    'v2_registration_email_delivery_finish',
    'v2_registration_email_delivery_fail_safe',
    'registration-review-receipt-ar-v1',
    'registration-owner-invitation-ar-v1',
    'deriveLifecycleEmailToken'
  ])assert.ok(edge.includes(contract),`missing Edge contract: ${contract}`);

  const receipt=section(renderer,"if(messageKind==='review_receipt')","const invitationUrl=");
  assert.match(receipt,/لم تُنشأ مساحة جديدة بعد/);
  assert.match(receipt,/لا تحتوي هذه الرسالة على رابط تفعيل/);
  assert.doesNotMatch(receipt,/accept-invite|searchParams\.set\('token'/);
  const owner=renderer.slice(renderer.indexOf('const invitationUrl='));
  assert.match(owner,/new URL\('\/accept-invite',PUBLIC_APP_URL\)/);
  assert.match(owner,/invitationUrl\.searchParams\.set\('token',token\)/);
  assert.match(owner,/registration_owner_invitation/);
});

test('admin and public UI expose delivery state but never an invitation capability',async()=>{
  const [route,component,landing]=await Promise.all([
    read('app/api/platform/registration-requests/route.js'),
    read('components/platform-registration-requests.js'),
    read('components/free-trial-landing.js')
  ]);

  assert.match(route,/delete safeOwner\.invitationToken/);
  assert.match(route,/emailDeliveries:delivery\.data\?\.emailDeliveries/);
  assert.match(route,/safeOwner\.invitationEmail=ownerInvitation/);
  assert.doesNotMatch(route,/new URL\('\/accept-invite'/);
  assert.match(component,/دعوة المالك في طريقها بالبريد/);
  assert.match(component,/دعوة المالك بالبريد/);
  assert.doesNotMatch(component,/outcome\.invitationUrl|navigator\.clipboard/);
  assert.match(landing,/reviewReceiptQueued/);
  assert.match(landing,/إشعار استلام بلا رابط تفعيل/);
  assert.match(landing,/دعوة المالك الآمنة تلقائيًا/);
});

test('all new lifecycle RPCs are deny-by-default and service-only',async()=>{
  const migration=await read(MIGRATION);
  const compact=migration.replace(/\s+/g,'');
  for(const signature of [
    'public.v1_registration_review_receipt_ensure(uuid)',
    'public.v2_registration_email_delivery_claim(uuid)',
    'public.v2_registration_email_delivery_bind(uuid,uuid,text,text)',
    'public.v2_registration_email_delivery_finish(uuid,uuid,text,text,integer,text,integer)',
    'public.v2_registration_email_delivery_fail_safe(uuid)'
  ]){
    assert.ok(
      compact.includes(`revokeallonfunction${signature}frompublic,anon,authenticated,service_role;`),
      `missing revoke for ${signature}`
    );
    assert.ok(
      compact.includes(`grantexecuteonfunction${signature}toservice_role;`),
      `missing service grant for ${signature}`
    );
  }
});
