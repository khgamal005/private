import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function source(relativePath){
  const absolutePath=join(root,relativePath);
  assert.ok(existsSync(absolutePath),`Expected ${relativePath} to exist`);
  return readFileSync(absolutePath,'utf8');
}

const migration=source(
  'supabase/migrations/20260901134621_paymob_intention_checkout_v1.sql'
);
const webhook=source('supabase/functions/paymob-webhook/index.ts');
const reconciler=source('supabase/functions/paymob-reconcile/index.ts');
const finalRuntime=source(
  'supabase/migrations/20260906123000_paymob_final_runtime_v1.sql'
);

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function sqlFunction(qualifiedName){
  const start=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(qualifiedName)}\\s*\\(`,
    'i'
  ).exec(migration);
  assert.ok(start,`Missing SQL function ${qualifiedName}`);
  const tail=migration.slice(start.index);
  const body=/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(tail);
  assert.ok(body,`Unterminated SQL function ${qualifiedName}`);
  return tail.slice(0,body.index+body[0].length);
}

function sqlTable(qualifiedName){
  const match=new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${escapeRegExp(qualifiedName)}\\s*\\(([\\s\\S]*?)^\\);`,
    'im'
  ).exec(migration);
  assert.ok(match,`Missing SQL table ${qualifiedName}`);
  return match[0];
}

test('credential versions contain only Vault references and immutable merchant bindings',()=>{
  const versions=sqlTable('marketplace.paymob_credential_versions');
  for(const vaultRef of [
    'hmac_vault_secret_id','api_key_vault_secret_id',
    'secret_key_vault_secret_id','public_key_vault_secret_id',
    'billing_digest_vault_secret_id'
  ])assert.match(versions,new RegExp(`\\b${vaultRef}\\s+uuid\\s+not\\s+null`,'i'));
  assert.match(versions,/integration_id\s+text\s+not\s+null/i);
  assert.match(versions,/owner_id\s+text\s+not\s+null/i);
  assert.match(versions,/status\s+in\s*\(\s*'active'\s*,\s*'retiring'\s*,\s*'expired'\s*,\s*'revoked'\s*\)/i);
  assert.match(versions,/revoked_by_subject_id[\s\S]*?revocation_reason_code[\s\S]*?revoked_at/i);
  assert.doesNotMatch(versions,/hmac_secret\s+text|api_key\s+text|secret_key\s+text|public_key\s+text/i);
  assert.match(migration,/create\s+unique\s+index\s+paymob_hmac_one_active_version_idx_v1[\s\S]*?where\s+status\s*=\s*'active'/i);
  assert.match(migration,/create\s+unique\s+index\s+paymob_hmac_one_retiring_version_idx_v1[\s\S]*?where\s+status\s*=\s*'retiring'/i);
});

test('normal Paymob rotation creates fresh Vault rows and never overwrites the old secret',()=>{
  const writer=sqlFunction('private_app.v3_payment_provider_store_secret_v2');
  const start=writer.indexOf("if p_provider_key = 'paymob' then");
  const end=writer.indexOf("v_vault_name := 'marketplace_' ||",start);
  assert.notEqual(start,-1,'Missing Paymob-specific Vault writer');
  assert.notEqual(end,-1,'Missing non-Paymob writer boundary');
  const paymobBranch=writer.slice(start,end);

  assert.match(paymobBranch,/v_vault_id\s*:=\s*gen_random_uuid\(\)/i);
  assert.match(paymobBranch,/v_vault_name[\s\S]*?v_vault_id::text/i);
  assert.match(paymobBranch,/vault\.create_secret\s*\(/i);
  assert.doesNotMatch(paymobBranch,/vault\.update_secret\s*\(/i);
  assert.match(paymobBranch,/set\s+vault_secret_id\s*=\s*v_vault_id/i);
});

test('normal rotation keeps one retiring HMAC for seven-day callback overlap',()=>{
  const finalize=sqlFunction('private_app.paymob_finalize_credential_version_v1');

  assert.match(finalize,/status\s*=\s*'expired'[\s\S]*?status\s*=\s*'retiring'[\s\S]*?valid_until\s*<=\s*now\(\)/i);
  assert.match(finalize,/status\s*=\s*'retiring'[\s\S]*?valid_until\s*>\s*now\(\)/i);
  assert.match(finalize,/paymob_credential_rotation_overlap_in_progress/i);
  assert.match(finalize,/set\s+status\s*=\s*'retiring'[\s\S]*?retiring_at\s*=\s*now\(\)[\s\S]*?valid_until\s*=\s*now\(\)\s*\+\s*interval\s*'7 days'/i);
  assert.match(finalize,/insert\s+into\s+marketplace\.paymob_credential_versions[\s\S]*?'active'/i);
  assert.match(finalize,/marketplace\.paymob\.credential_version_created/i);
  assert.match(finalize,/'overlapDays'\s*,\s*7/i);
  assert.match(finalize,/'secretReturned'\s*,\s*false/i);
});

test('webhook candidates are bounded, account-bound and exclude expired or revoked versions',()=>{
  const runtime=sqlFunction('public.v1_service_paymob_runtime_config');

  assert.match(runtime,/p_purpose\s*=\s*'verify_webhook'/i);
  assert.match(runtime,/candidate\.status\s*=\s*'active'/i);
  assert.match(runtime,/candidate\.status\s*=\s*'retiring'[\s\S]*?candidate\.valid_until\s*>\s*now\(\)/i);
  assert.doesNotMatch(runtime,/candidate\.status\s+in\s*\([^)]*'expired'|candidate\.status\s*=\s*'revoked'/i);
  assert.match(runtime,/jsonb_array_length\(v_candidates\)\s+not\s+between\s+1\s+and\s+2/i);
  for(const field of [
    'credentialVersionId','environment','integrationId','owner','hmacSecret'
  ])assert.match(runtime,new RegExp(`'${field}'`));

  assert.match(webhook,/MAX_HMAC_CANDIDATES\s*=\s*2/i);
  assert.match(webhook,/Promise\.all\s*\([\s\S]*?hmacCandidates\.map/i);
  assert.match(webhook,/candidate\.integrationId\s*===\s*transaction\.integrationId/i);
  assert.match(webhook,/candidate\.owner\s*===\s*transaction\.owner/i);
  assert.match(webhook,/matches\.length\s*!==\s*1/i);
  assert.match(webhook,/p_environment\s*:\s*matchedCandidate\.environment/i);
});

test('new checkout and resume require the active pinned version while delayed callbacks accept retiring',()=>{
  const attempts=sqlTable('marketplace.payment_attempts');
  const runtime=sqlFunction('public.v1_service_paymob_runtime_config');
  const resume=sqlFunction('public.v1_service_paymob_resume_checkout');
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const createPath=runtime.slice(runtime.indexOf('if p_attempt_id is null then'));

  assert.match(attempts,/credential_version_id\s+uuid\s+not\s+null[\s\S]*?references\s+marketplace\.paymob_credential_versions/i);
  assert.match(createPath,/version\.id\s*=\s*v_attempt\.credential_version_id/i);
  assert.match(createPath,/v_version\.status\s*<>\s*'active'/i);
  assert.doesNotMatch(createPath,/v_version\.status\s*=\s*'retiring'|v_version\.status\s*=\s*'expired'/i);
  assert.match(resume,/version\.id\s*=\s*v_attempt\.credential_version_id/i);
  assert.match(resume,/v_version\.status\s*<>\s*'active'/i);
  assert.doesNotMatch(resume,/v_version\.status\s*=\s*'retiring'|v_version\.status\s*=\s*'expired'/i);
  assert.match(ingest,/version\.id\s*=\s*p_credential_version_id/i);
  assert.match(ingest,/version\.status\s*=\s*'active'[\s\S]*?version\.status\s*=\s*'retiring'[\s\S]*?valid_until\s*>\s*now\(\)/i);
  assert.match(ingest,/v_integration_id\s*<>\s*v_attempt_version\.integration_id/i);
  assert.match(ingest,/v_owner\s*<>\s*v_attempt_version\.owner_id/i);
});

test('one signed delivery remains replay-idempotent across credential rotation',()=>{
  const deliveries=sqlTable('marketplace.webhook_deliveries');
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const duplicateStart=ingest.indexOf('select delivery.* into v_existing_delivery');
  const duplicateEnd=ingest.indexOf('if v_existing_delivery.id is not null',duplicateStart);
  assert.notEqual(duplicateStart,-1,'Missing delivery replay lookup');
  assert.notEqual(duplicateEnd,-1,'Missing delivery replay branch');
  const duplicateLookup=ingest.slice(duplicateStart,duplicateEnd);

  assert.match(deliveries,/credential_version_id\s+uuid\s+not\s+null/i);
  assert.match(deliveries,/unique\s*\(\s*provider_key\s*,\s*environment\s*,\s*provider_transaction_id\s*,\s*signed_state_sha256\s*,\s*special_reference_valid\s*\)/i);
  assert.match(duplicateLookup,/provider_transaction_id\s*=\s*v_transaction_id/i);
  assert.match(duplicateLookup,/signed_state_sha256\s*=\s*v_signed_state_sha256/i);
  assert.match(duplicateLookup,/special_reference_valid\s*=\s*v_special_reference_valid/i);
  assert.doesNotMatch(duplicateLookup,/credential_version_id/i);
});

test('reconciliation rotates API auth without losing the attempt credential audit binding',()=>{
  const runtime=sqlFunction('public.v1_service_paymob_reconciliation_runtime');
  const apply=sqlFunction('public.v1_service_paymob_reconciliation_apply');
  const jobs=sqlTable('marketplace.reconciliations');

  assert.match(runtime,/v_attempt_version\s+marketplace\.paymob_credential_versions%rowtype/i);
  assert.match(runtime,/v_inquiry_version\s+marketplace\.paymob_credential_versions%rowtype/i);
  assert.match(runtime,/version\.id\s*=\s*v_attempt\.credential_version_id/i);
  assert.match(runtime,/version\.environment\s*=\s*v_attempt\.environment/i);
  assert.match(runtime,/version\.environment\s*=\s*v_attempt_version\.environment/i);
  assert.match(runtime,/version\.status\s*=\s*'active'/i);
  assert.match(runtime,/version\.integration_id\s*=\s*v_attempt_version\.integration_id/i);
  assert.match(runtime,/version\.owner_id\s*=\s*v_attempt_version\.owner_id/i);
  assert.match(runtime,/decrypted\.id\s*=\s*v_inquiry_version\.api_key_vault_secret_id/i);
  assert.match(runtime,/'attemptCredentialVersionId'\s*,\s*v_attempt_version\.id/i);
  assert.match(runtime,/'inquiryCredentialVersionId'\s*,\s*v_inquiry_version\.id/i);
  assert.match(jobs,/inquiry_credential_version_id\s+uuid[\s\S]*?references\s+marketplace\.paymob_credential_versions/i);
  assert.match(runtime,/set\s+inquiry_credential_version_id\s*=\s*v_inquiry_version\.id/i);
  assert.match(runtime,/where\s+id\s*=\s*v_job\.id/i);
// Scheduled inquiry now runs in the leased database worker. The optional
// Edge endpoint is deliberately provider-blind and only delegates a caller JWT.
assert.doesNotMatch(
  reconciler,
  /SUPABASE_SERVICE_ROLE_KEY|PAYMOB_RECONCILE_DISPATCHER_SECRET|ksa\.paymob\.com/i
);
assert.match(finalRuntime,/ODEIR_PAYMOB_ORDER_ID_RECOVERY_V1/);
  assert.match(apply,/\bp_inquiry_credential_version_id\s+uuid\b/i);
  assert.match(apply,/version\.id\s*=\s*p_inquiry_credential_version_id/i);
  assert.match(apply,/version\.status\s*=\s*'active'/i);
  assert.match(apply,/v_job\.inquiry_credential_version_id\s+is\s+distinct\s+from\s+p_inquiry_credential_version_id/i);
  assert.match(apply,/inquiry_credential_binding_mismatch/i);
  assert.doesNotMatch(
    runtime,
    /decrypted\.id\s*=\s*v_attempt_version\.api_key_vault_secret_id/i
  );

assert.match(
  finalRuntime,
  /jsonb_build_object\('order_id',v_provider_order_id\)/
);
assert.match(
  finalRuntime,
  /jsonb_build_object\('merchant_order_id',v_attempt_id::text\)/
);
  assert.doesNotMatch(
    reconciler,
    /while\s*\([^)]*inquir|for\s*\([^)]*(?:retry|inquir)/i
  );
});

test('rotation clears readiness and requires a verified delayed callback before live',()=>{
  const invalidate=sqlFunction('private_app.paymob_secret_rotation_invalidate_v1');
  const required=sqlFunction('private_app.paymob_required_checks');
  const evidencePassed=sqlFunction('private_app.paymob_evidence_passed');
  const evidenceWrite=sqlFunction('private_app.paymob_readiness_evidence_write');
  const evidenceRpc=sqlFunction('public.v1_service_paymob_readiness_evidence');

  assert.match(invalidate,/readiness_evidence\s*=\s*'\{\}'::jsonb/i);
  assert.match(invalidate,/rollout_mode\s*=\s*'observe_only'/i);
  assert.match(invalidate,/status\s*=\s*case[\s\S]*?else\s*'draft'/i);
  assert.match(invalidate,/last_verified_at\s*=\s*null/i);
  assert.match(invalidate,/activated_by_subject_id\s*=\s*null/i);
  assert.match(required,/'credential_rotation_callback'/i);
  assert.match(evidencePassed,/version\.status\s*=\s*'active'/i);
  assert.match(evidencePassed,/evidence\.credential_version_id\s*=\s*v_active_id/i);
  assert.match(evidencePassed,/evidence\.checked_at\s*>=\s*version\.valid_from/i);
  assert.match(evidencePassed,/candidate\.status\s*<>\s*'revoked'/i);
  assert.match(evidencePassed,/provider\.sandbox_canary_version_id/i);
  assert.match(evidencePassed,/candidate\.id\s*=\s*v_sandbox_canary_version_id/i);
  assert.match(evidenceWrite,/insert\s+into\s+marketplace\.paymob_readiness_evidence_history/i);
  assert.match(evidenceWrite,/credential_version_id[\s\S]*?v_version_id/i);
  assert.match(evidenceRpc,/auth\.jwt\(\)\s*->>\s*'role'[\s\S]*?'service_role'/i);
});

test('emergency revoke is explicit, audited and immediately disables checkout',()=>{
  const revoke=sqlFunction('public.v1_platform_paymob_emergency_revoke_credential');

  assert.match(revoke,/private_app\.has_platform_permission\(\s*'platform\.billing\.manage'\s*\)/i);
  assert.match(revoke,/EMERGENCY REVOKE PAYMOB/i);
  assert.match(revoke,/set\s+status\s*=\s*'revoked'/i);
  assert.match(revoke,/revoked_by_subject_id\s*=\s*v_actor/i);
  assert.match(revoke,/revocation_reason_code\s*=\s*v_reason/i);
  assert.match(revoke,/rollout_mode\s*=\s*'observe_only'/i);
  assert.match(revoke,/readiness_evidence\s*=\s*'\{\}'::jsonb/i);
  assert.match(revoke,/credential_emergency_revoked/i);
  assert.match(revoke,/reconciliation\.status\s+in\s*\(\s*'queued'\s*,\s*'running'\s*,\s*'unknown'\s*,\s*'failed'\s*\)/i);
  assert.match(revoke,/marketplace\.paymob\.credential_emergency_revoked/i);
  assert.match(revoke,/'vaultSecretDeleted'\s*,\s*false/i);
  assert.match(revoke,/'secretReturned'\s*,\s*false/i);
});
