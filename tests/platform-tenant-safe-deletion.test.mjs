import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260825220000_safe_tenant_purge_v1.sql';

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

test('permanent deletion is a platform-owner-only permission',async()=>{
  const migration=await read(MIGRATION);
  assert.match(migration,/'platform\.tenants\.delete'/);
  assert.match(migration,/role\.role_key='platform_owner'/);
  assert.doesNotMatch(migration,/platform_tenants_manager','platform\.tenants\.delete/);
  for(const rpc of [
    'public.v1_platform_tenant_deletion_preview',
    'public.v1_platform_tenant_delete'
  ]){
    const body=section(migration,`create or replace function ${rpc}`,'$$;');
    assert.match(body,/security definer\s+set search_path=''/);
    assert.match(body,/has_platform_permission\('platform\.tenants\.delete'\)/);
    assert.match(body,/auth\.uid\(\) is null/);
  }
});

test('Reef is protected by a database FK and immutable triple identity',async()=>{
  const migration=await read(MIGRATION);
  const protection=section(
    migration,'create table platform.tenant_deletion_protections',
    'create table platform.tenant_deletion_receipts'
  );
  assert.match(protection,/references core\.tenants\(id\) on delete restrict/);
  assert.match(protection,/tenant\.tenant_key='tenant-reef-skills'/);
  assert.match(protection,/tenant\.slug='reef-skills'/);
  assert.match(protection,/organization\.organization_key='org-reef-skills'/);
  assert.match(migration,/revoke all on table platform\.tenant_deletion_protections\s+from public,anon,authenticated,service_role/);
});

test('preview fails closed for protected records, files, integrations, and schema drift',async()=>{
  const migration=await read(MIGRATION);
  const preview=section(
    migration,'create or replace function private_app.v1_tenant_deletion_preview_document',
    'revoke all on function private_app.v1_tenant_deletion_preview_document'
  );
  for(const contract of [
    'accounting_core.sales_documents','accounting_core.document_events',
    'accounting_core.payments','accounting_zatca.submission_metadata',
    'marketplace.orders','marketplace.bank_transfer_submissions',
    'catalog.tenant_addon_subscription_events','lifecycle_protected_until',
    'communication_hub.provider_connections','commerce_hub.connections',
    'commerce_sync.connections','marketing_hub.connections','storage.objects',
    'defaultIntegrationRows','supabase_edge_function','providerState',
    'unknown_database_dependency','pg_catalog.pg_constraint',
    "constraint_row.confrelid='core.tenants'::regclass"
  ])assert.ok(preview.includes(contract),`missing blocker contract: ${contract}`);
  assert.match(preview,/object\.bucket_id in \(\s*'cms-assets','cms-template-staging','cms-template-assets'/);
  assert.match(preview,/'canDelete',jsonb_array_length\(v_blockers\)=0/);
  assert.match(preview,/'previewDigest',v_digest/);
  assert.match(preview,/constraint_row\.confdeltype::text/);
  assert.match(preview,/v_integrations>0/);
  assert.match(preview,/item\.status='draft'[\s\S]*item\.last_checked_at is null/);
  assert.match(preview,/\(item\.system_type,item\.display_name\) in/);
});

test('execution is locked, digest-bound, typed, idempotent, and transactional',async()=>{
  const migration=await read(MIGRATION);
  const rpc=section(
    migration,'create or replace function public.v1_platform_tenant_delete',
    'revoke all on function public.v1_platform_tenant_delete'
  );
  assertOrdered(rpc,[
    'where receipt.idempotency_key=p_idempotency_key',
    'pg_catalog.pg_advisory_xact_lock',
    'for update',
    'v_preview:=private_app.v1_tenant_deletion_preview_document',
    "raise exception 'tenant_deletion_preview_stale'",
    "raise exception 'tenant_deletion_blocked'",
    "v_preview->>'confirmationPhrase'",
    "set_config('odeir.tenant_purge_id'",
    'delete from core.tenants tenant',
    'insert into platform.tenant_deletion_receipts'
  ]);
  assert.match(rpc,/p_idempotency_key uuid/);
  assert.match(rpc,/odeir:tenant-delete-idempotency:/);
  assert.equal(
    (rpc.match(/where receipt\.idempotency_key=p_idempotency_key/g)||[]).length,
    2,
    'receipt must be re-read after acquiring the idempotency lock'
  );
  assert.match(rpc,/return jsonb_build_object\(\s*'deleted',true,'replayed',true/);
  assert.equal((rpc.match(/'registrationReleased',true/g)||[]).length,4);
  assert.equal((rpc.match(/'authUserDeleted',false/g)||[]).length,4);
  assert.match(migration,/tenant_deletion_receipts_requested_by_subject_idx[\s\S]*where requested_by_subject_id is not null/);
});

test('registration identity is released without deleting shared Auth or legacy tenants',async()=>{
  const migration=await read(MIGRATION);
  const rpc=section(
    migration,'create or replace function public.v1_platform_tenant_delete',
    'revoke all on function public.v1_platform_tenant_delete'
  );
  assertOrdered(rpc,[
    'delete from platform.registration_email_webhook_events',
    'delete from platform.registration_email_delivery_attempts',
    'delete from platform.registration_confirmation_token_aliases',
    'delete from platform.registration_email_deliveries',
    'delete from platform.registration_request_identity_reservations',
    'delete from platform.registration_activation_attestations',
    'delete from platform.registration_external_account_claims',
    'delete from platform.registration_identity_claims',
    'delete from platform.registration_request_events',
    'delete from platform.registration_requests'
  ]);
  assert.doesNotMatch(rpc,/delete from auth\.users|delete from access_control\.subjects/);
  assert.doesNotMatch(rpc,/delete from platform\.tenants/);
  assert.match(rpc,/delete from core\.organizations organization[\s\S]*not exists/);
});

test('API is same-origin, bounded, no-store, and validates both RPC responses',async()=>{
  const route=await read('app/api/platform/tenant-deletion/route.js');
  assert.match(route,/if\(!sameOrigin\(request\)\)/);
  assert.match(route,/MAX_BODY_BYTES=8\*1024/);
  assert.match(route,/AbortSignal\.timeout\(25_000\)/);
  assert.match(route,/v1_platform_tenant_deletion_preview/);
  assert.match(route,/v1_platform_tenant_delete/);
  assert.match(route,/function validPreview/);
  assert.match(route,/function validResult/);
  assert.match(route,/registrationReleased===true/);
  assert.match(route,/authUserDeleted===false/);
  assert.match(route,/private, no-store, no-cache, max-age=0, must-revalidate/);
  assert.doesNotMatch(route,/service_role|sb_secret_/i);
});

test('both management surfaces use the same preview-first deletion dialog',async()=>{
  const dialog=await read('components/tenant-deletion-dialog.js');
  const requests=await read('components/platform-registration-requests.js');
  const tenants=await read('components/platform-tenants.js');
  assert.match(dialog,/\/api\/platform\/tenant-deletion\?tenantId=/);
  assert.match(dialog,/preview\.confirmationPhrase/);
  assert.match(dialog,/window\.crypto\.randomUUID\(\)/);
  assert.match(dialog,/reason\.trim\(\)\.length>=8/);
  assert.match(dialog,/acknowledged/);
  assert.match(dialog,/preview\.blockers\.map/);
  assert.match(dialog,/defaultIntegrationRows:'إعدادات التكامل الافتراضية'/);
  assert.match(requests,/import TenantDeletionDialog/);
  assert.match(tenants,/import TenantDeletionDialog/);
  assert.match(requests,/>حذف المنشأة نهائيًا<\/button>/);
  assert.match(tenants,/>حذف نهائي<\/button>/);
});
