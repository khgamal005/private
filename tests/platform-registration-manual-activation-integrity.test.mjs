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

test('external registry claims are private, unique, and reference only current core tenants',async()=>{
  const migration=await read(MIGRATION);
  assert.match(migration,/create table(?: if not exists)? platform\.registration_external_account_claims/);
  assert.match(migration,/primary key \(source_system,external_account_id\)/);
  assert.match(migration,/tenant_id uuid not null[\s\S]*?references core\.tenants\(id\) on delete restrict/);
  assert.match(migration,/originating_request_id uuid not null[\s\S]*?references platform\.registration_requests\(id\) on delete restrict/);
  assert.match(migration,/evidence_hash text not null[\s\S]*?\^\[a-f0-9\]\{64\}\$/);
  assert.match(migration,/alter table platform\.registration_external_account_claims enable row level security/);
  assert.match(migration,/revoke all on table platform\.registration_external_account_claims[\s\S]*?from public,anon,authenticated/);
  assert.doesNotMatch(
    migration,
    /(?:from|join|update|into|delete\s+from)\s+platform\.tenants\b|link_market_account_to_tenant/i
  );
});

test('approve-and-activate is one atomic, permissioned, versioned and replay-safe transition',async()=>{
  const migration=await read(MIGRATION);
  const fn=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    '$$;'
  );
  assert.match(fn,/security definer\s+set search_path=''/);
  assert.match(fn,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(fn,/current_subject_id\(\)/);
  assert.match(fn,/from platform\.registration_requests request[\s\S]*?for update/);
  assert.match(fn,/status='converted'[\s\S]*?provisioned_tenant_id is not null[\s\S]*?replayed/i);
  assert.ok(
    fn.indexOf("v_request.status='converted'")<fn.indexOf('if p_expected_version'),
    'idempotent replay must be handled before optimistic-lock rejection'
  );
  assert.match(fn,/p_expected_version[^\n]*<>v_request\.version/);
  assert.match(fn,/v_request\.activation_mode<>'manual_review'/);
  assert.match(fn,/v_request\.status not in \('under_review','approved'\)/);
  assert.match(fn,/pg_(?:catalog\.)?advisory_xact_lock\([\s\S]*?hashtextextended/);
  assert.match(fn,/status='converted'/);
  assert.match(fn,/provisioned_tenant_id=v_tenant_id/);
  assert.match(fn,/action[\s\S]*?'approve_and_activate'/);
  const compact=migration.replace(/\s+/g,'');
  assert.ok(compact.includes('revokeallonfunctionpublic.v1_platform_registration_approve_and_activate(uuid,integer,text,jsonb)frompublic,anon,authenticated;'));
  assert.ok(compact.includes('grantexecuteonfunctionpublic.v1_platform_registration_approve_and_activate(uuid,integer,text,jsonb)toauthenticated;'));
});

test('create-new activation changes only the tenant created for this request',async()=>{
  const migration=await read(MIGRATION);
  const fn=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    '$$;'
  );
  const create=section(
    fn,
    "if v_resolution='create_new' then",
    'if v_external_account_id is not null then'
  );
  assert.match(fn,/confirmedNoExistingTenant/);
  assert.match(create,/private_app\.provision_tenant_core\(/);
  assert.match(create,/'verified_email'/);
  assert.match(create,/'registrationRequestId',v_request\.id/);
  assert.match(create,/'registrationActivationMode','manual_review'/);
  assert.match(create,/update core\.tenants tenant[\s\S]*?set status='active'/);
  assert.match(create,/tenant\.id=v_tenant_id/);
  assert.match(create,/tenant\.settings->>'registrationRequestId'=v_request\.id::text/);
  assert.match(create,/get diagnostics v_tenant_updated=row_count/);
  assert.match(create,/if v_tenant_updated<>1 then/);
  assert.doesNotMatch(create,/delete from core\.tenants/);
});

test('link-existing activation proves ownership without mutating an established tenant',async()=>{
  const migration=await read(MIGRATION);
  const fn=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    '$$;'
  );
  const link=section(
    fn,
    "if v_resolution='link_existing' then",
    '-- Official identifiers cannot create a second workspace.'
  );
  assert.match(link,/targetTenantSlug/);
  assert.match(link,/from core\.tenants tenant[\s\S]*?tenant\.status='active'[\s\S]*?for update/);
  assert.doesNotMatch(link,/update core\.tenants|insert into core\.tenants|delete from core\.tenants/);
  assert.doesNotMatch(link,/catalog\.subscriptions|core\.tenant_modules|tenant_memberships/);
  assert.match(fn,/insert into platform\.registration_external_account_claims/);
  assert.match(fn,/registration_external_account_already_claimed/);
});

test('manual trust cannot say trusted before a tenant exists, and converted always has a tenant',async()=>{
  const migration=await read(MIGRATION);
  const trigger=section(
    migration,
    'create or replace function private_app.registration_manual_trust_sync',
    '$$;'
  );
  assert.match(trigger,/new\.status='approved'[\s\S]*?registration_atomic_activation_required/);
  assert.match(trigger,/when 'approved' then 'pending_review'/);
  assert.match(trigger,/when 'converted' then[\s\S]*?'trusted'/);
  assert.match(migration,/status<>'converted' or provisioned_tenant_id is not null/);
  assert.match(migration,/set trust_status='pending_review'[\s\S]*?activation_mode='manual_review'[\s\S]*?status='approved'[\s\S]*?provisioned_tenant_id is null/);
});

test('server action verifies the official directory and never trusts browser-supplied evidence',async()=>{
  const [route,ui]=await Promise.all([
    read('app/api/platform/registration-requests/route.js'),
    read('components/platform-registration-requests.js')
  ]);
  assert.match(route,/['"]approve_and_activate['"]/);
  assert.match(route,/v1_platform_registration_approve_and_activate/);
  assert.match(route,/createHash\(['"]sha256['"]\)/);
  assert.match(route,/marktone-free-trial/);
  assert.match(route,/action:\s*['"]details['"]/);
  assert.match(route,/externalAccountId|accountId/);
  assert.match(route,/identityVerified:\s*true/);
  assert.match(route,/evidenceHash/);
  assert.doesNotMatch(route,/body\.payload\.(?:evidenceHash|identityVerified)/);
  assert.match(ui,/create_new/);
  assert.match(ui,/link_existing/);
  assert.match(ui,/targetTenantSlug/);
  assert.match(ui,/confirmedNoExistingTenant/);
  assert.match(ui,/approve_and_activate/);
  assert.match(ui,/معتمد[^\n]{0,80}بانتظار التفعيل/);
});

test('new activation code remains tenant-neutral',async()=>{
  const sources=await Promise.all([
    read(MIGRATION),
    read('app/api/platform/registration-requests/route.js'),
    read('components/platform-registration-requests.js')
  ]);
  const combined=sources.join('\n');
  assert.doesNotMatch(combined,/reef|ريف/i);
  assert.doesNotMatch(combined,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});
