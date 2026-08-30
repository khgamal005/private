import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260830224513_notification_hub_v2.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
}

test('notification hub rollout is additive and fail-closed',async()=>{
  const migration=await read(MIGRATION);
  const settings=section(
    migration,
    'create table platform.lifecycle_notification_settings',
    'create table platform.lifecycle_notification_events'
  );
  for(const flag of [
    'capture_enabled','tenant_email_enabled','platform_email_enabled',
    'operational_monitor_enabled'
  ])assert.match(settings,new RegExp(`${flag} boolean not null default false`));
  assert.match(migration,/values \('notification_hub_v2', false, false, false, false, 'ar'\)/);
  assert.doesNotMatch(migration,/update\s+core\.tenants|tenant-reef-skills|reef|ريف/i);
  assert.doesNotMatch(migration,/net\.http_post|http_post\s*\(|api\.resend\.com|extensions\.http/i);
});

test('the event ledger supports tenantless platform alerts and exact permissions',async()=>{
  const migration=await read(MIGRATION);
  const events=section(
    migration,
    'create table platform.lifecycle_notification_events',
    'create table platform.lifecycle_notification_inbox'
  );
  assert.match(events,/tenant_id uuid\s+references core\.tenants\(id\) on delete set null/);
  for(const source of [
    'addon_subscription','marketplace_order','bank_transfer',
    'registration_request','registration_email','lifecycle_sweep',
    'operational_probe'
  ])assert.ok(events.includes(`'${source}'`),`missing source ${source}`);
  for(const permission of [
    'platform.billing.manage','platform.tenants.manage',
    'platform.settings.manage','platform.control.write'
  ])assert.ok(events.includes(`'${permission}'`),`missing ${permission}`);

  const capture=section(
    migration,
    'create or replace function private_app.lifecycle_notification_capture',
    'revoke all on function private_app.lifecycle_notification_capture'
  );
  assert.match(capture,/role_permission\.permission_key = p_platform_permission_key/g);
  assert.match(capture,/p_tenant_id is null and \(p_tenant_notify or p_tenant_email\)/);
  assert.match(capture,/on conflict \(event_key\) do nothing/);
  assert.match(capture,/owner_role\.role_key = 'tenant_owner'/);
});

test('registration, commerce and operations are independently captured',async()=>{
  const migration=await read(MIGRATION);
  for(const eventType of [
    'registration_request_received','registration_email_failed',
    'addon_activation_requested','addon_activation_rejected',
    'addon_trial_started','addon_activated','addon_paused','addon_resumed',
    'addon_renewed','addon_cancelled','addon_expired',
    'purchase_created','purchase_paid','purchase_payment_failed',
    'purchase_refunded','purchase_activation_failed','purchase_cancelled',
    'service_in_progress','service_completed','bank_transfer_submitted',
    'bank_transfer_approved','bank_transfer_rejected',
    'registration_email_worker_stale','lifecycle_email_worker_stale',
    'purchase_activation_stalled','lifecycle_email_failed'
  ])assert.ok(migration.includes(`'${eventType}'`),`missing ${eventType}`);
  assert.match(migration,/after insert on platform\.registration_requests/);
  assert.match(migration,/after update of state, provider_delivery_state\s+on platform\.registration_email_deliveries/);
  assert.match(migration,/after update of state, provider_state\s+on platform\.lifecycle_email_deliveries/);
  assert.match(migration,/new\.source = 'migration'/);
});

test('the durable outbox is locale-aware and contains no stored address or body',async()=>{
  const migration=await read(MIGRATION);
  const outbox=section(
    migration,
    'create table platform.lifecycle_email_deliveries',
    'create table platform.lifecycle_email_delivery_attempts'
  );
  assert.match(outbox,/recipient_subject_id uuid not null/);
  assert.match(outbox,/locale text not null default 'ar'/);
  assert.match(outbox,/template_key ~ '\^odeir-\[a-z0-9-\]\+-v2\$'/);
  assert.match(outbox,/idempotency_key text not null unique/);
  assert.doesNotMatch(
    outbox,
    /recipient_email|email_address|rendered_html|rendered_text|message_body|raw_token/i
  );
  const claim=section(
    migration,
    'create or replace function public.v1_lifecycle_email_delivery_claim',
    'revoke all on function public.v1_lifecycle_email_delivery_claim'
  );
  assert.match(claim,/for update skip locked/);
  assert.match(claim,/lease_expires_at = now\(\) \+ interval '2 minutes'/);
  assert.match(claim,/'locale', v_delivery\.locale/);
  assert.match(claim,/role_permission\.permission_key = v_event\.platform_permission_key/);
  assert.match(claim,/membership\.subject_id = v_event\.requested_by_subject_id/);
  assert.match(claim,/owner_role\.role_key = 'tenant_owner'/);
  assert.match(claim,/lifecycle_recipient_access_revoked/);
  assert.match(migration,/add column notification_locale text not null default 'ar'/);
  assert.match(migration,/before insert on platform\.registration_email_deliveries/);
  assert.match(migration,/select delivery\.notification_locale into v_locale/);
});

test('tables are private and public contracts have explicit least-privilege grants',async()=>{
  const migration=await read(MIGRATION);
  for(const table of [
    'lifecycle_notification_settings','lifecycle_notification_events',
    'lifecycle_notification_inbox','lifecycle_email_deliveries',
    'lifecycle_email_delivery_attempts','lifecycle_email_webhook_events'
  ]){
    assert.match(migration,new RegExp(`alter table platform\\.${table} force row level security`));
    assert.match(migration,new RegExp(`revoke all on table platform\\.${table}`));
  }
  assert.match(migration,/grant execute on function public\.v1_platform_lifecycle_notification_center[\s\S]+to authenticated/);
  assert.match(migration,/grant execute on function public\.v1_platform_lifecycle_notification_settings[\s\S]+to authenticated/);
  for(const worker of [
    'v1_lifecycle_notification_sweep','v1_lifecycle_operational_probe',
    'v1_lifecycle_email_delivery_due_ids','v1_lifecycle_email_delivery_claim',
    'v1_lifecycle_email_delivery_finish','v1_lifecycle_email_delivery_record_event',
    'v3_registration_email_delivery_claim'
  ])assert.match(migration,new RegExp(`grant execute on function public\\.${worker}[\\s\\S]{0,240}to service_role`));
});

test('the independent monitor requires explicit authorization and bounded checks',async()=>{
  const migration=await read(MIGRATION);
  const settings=section(
    migration,
    'create or replace function public.v1_platform_lifecycle_notification_settings',
    'revoke all on function public.v1_platform_lifecycle_notification_settings'
  );
  assert.match(settings,/platform\.settings\.manage/);
  assert.match(settings,/platform\.control\.write/);
  assert.match(settings,/notification_capture_required/);
  assert.match(settings,/pg_catalog\.pg_extension/);
  assert.match(settings,/cron\.schedule/);
  assert.match(settings,/cron\.unschedule/);

  const probe=section(
    migration,
    'create or replace function private_app.lifecycle_operational_probe',
    'revoke all on function private_app.lifecycle_operational_probe'
  );
  assert.match(probe,/operational_monitor_enabled is not true/);
  assert.match(probe,/interval '5 minutes'/g);
  assert.match(probe,/interval '15 minutes'/);
  assert.match(probe,/limit 200/);
  assert.match(probe,/date_trunc\('hour', now\(\)\)/);
});

test('registration and lifecycle workers render Arabic and English safely',async()=>{
  const edge=await read('supabase/functions/odeir-registration-intake/index.ts');
  for(const contract of [
    'drainLifecycleOutbox','processLifecycleEmailDelivery',
    'commerceLifecycleEmailMessage','englishLifecycleCopy',
    'v1_lifecycle_notification_sweep','v1_lifecycle_email_delivery_claim',
    'v1_lifecycle_email_delivery_finish','v1_lifecycle_email_delivery_record_event',
    'v3_registration_email_delivery_claim'
  ])assert.ok(edge.includes(contract),`missing Edge contract ${contract}`);
  for(const englishCopy of [
    'We received your institution request in Odeir',
    'Welcome to Odeir — activate the owner account',
    'Confirm your email and activate your Odeir workspace',
    'Commerce and lifecycle notifications',
    'Never send payment details or passwords'
  ])assert.ok(edge.includes(englishCopy),`missing English copy: ${englishCopy}`);
  assert.match(edge,/أودير \| إشعارات المتجر والإضافات/);
  assert.match(edge,/لا ترسل بيانات دفع أو كلمات مرور/);
  assert.match(edge,/actionUrl\.origin!==appOrigin/);
  assert.match(edge,/verifySvixSignature/);
  assert.match(edge,/lifecycle\.matched===true/);
  assert.doesNotMatch(
    section(edge,'function commerceLifecycleEmailMessage','function lifecycleEmailMessage'),
    /transferReference|senderName|review_note/
  );
});

test('the platform bell and full hub use isolated authenticated routes',async()=>{
  const [center,shell,route,hub,page]=await Promise.all([
    read('components/notification-center.js'),
    read('components/workspace-shell.js'),
    read('app/api/platform/notifications/route.js'),
    read('components/platform-notification-hub.js'),
    read('app/control/notifications/page.js')
  ]);
  assert.match(center,/scope='tenant'/);
  assert.match(center,/platform\?'\/api\/platform\/notifications'/);
  assert.match(center,/if\(!systemInboxEnabled\)return undefined/);
  assert.match(shell,/<NotificationCenter[\s\S]+scope="platform"/);
  assert.match(shell,/OdeiryAssistant/);
  assert.match(shell,/odeiryContext/);
  assert.match(route,/ACCESS_COOKIE/);
  assert.match(route,/AbortSignal\.timeout\(6000\)/);
  assert.match(route,/v1_platform_lifecycle_notification_settings/);
  assert.match(route,/typeof settings\[key\]!=='boolean'/);
  assert.match(hub,/حفظ إعدادات التشغيل/);
  assert.match(hub,/كل القنوات مغلقة افتراضيًا/);
  assert.match(page,/requireAnyPlatformPermission/);
});

test('current registration legal gate and v4 submit path stay intact',async()=>{
  const edge=await read('supabase/functions/odeir-registration-intake/index.ts');
  for(const contract of [
    'LEGAL_POLICY_SET_VERSION','LEGAL_SUMMARY_TEXT_HASH',
    'LEGAL_CONSENT_TEXT_HASH','v4_public_submit_registration_request',
    'legal_policy_version_stale'
  ])assert.ok(edge.includes(contract),`regressed ${contract}`);
});
