import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function source(relativePath){
  const absolutePath=join(root,relativePath);
  assert.ok(existsSync(absolutePath),`Expected ${relativePath} to exist`);
  return readFileSync(absolutePath,'utf8');
}

const reconciler=source('supabase/functions/paymob-reconcile/index.ts');
const normalizer=source('supabase/functions/paymob-reconcile/normalize.ts');
const config=source('supabase/config.toml');
const envExample=source('.env.example');
const runbook=source('supabase/functions/paymob-reconcile/README.md');
const migration=source(
  'supabase/migrations/20260901120000_paymob_intention_checkout_v1.sql'
);
const normalizerRuntime=await import(pathToFileURL(join(
  root,'supabase/functions/paymob-reconcile/normalize.ts'
)).href);

function functionBody(name){
  const start=new RegExp(`(?:async\\s+)?function\\s+${name}\\b`,'i').exec(reconciler);
  assert.ok(start,`Missing ${name}`);
  const tail=reconciler.slice(start.index);
  const next=/\n(?:async\s+)?function\s+\w+\b/.exec(tail.slice(1));
  return next?tail.slice(0,next.index+1):tail;
}

function configBlock(name){
  const match=new RegExp(
    `^\\[functions\\.${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    'im'
  ).exec(config);
  assert.ok(match,`Missing Supabase function config for ${name}`);
  return match[1];
}

function sqlFunction(qualifiedName){
  const escaped=qualifiedName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const start=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escaped}\\s*\\(`,
    'i'
  ).exec(migration);
  assert.ok(start,`Missing SQL function ${qualifiedName}`);
  const tail=migration.slice(start.index);
  const body=/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(tail);
  assert.ok(body,`Unterminated SQL function ${qualifiedName}`);
  return tail.slice(0,body.index+body[0].length);
}

test('reconciler is server-only with dedicated dispatcher or platform JWT authorization',()=>{
  assert.match(configBlock('paymob-reconcile'),/verify_jwt\s*=\s*false/i);
  assert.match(reconciler,/PAYMOB_RECONCILE_DISPATCHER_SECRET/);
  assert.match(reconciler,/x-odeir-paymob-reconcile-secret/i);
  assert.match(reconciler,/secretEqual\s*\(/);
  assert.match(reconciler,/SHA-256/);
  assert.match(reconciler,/v3_platform_payment_provider_admin_snapshot/);
  assert.match(reconciler,/SUPABASE_ANON_KEY/);
  assert.doesNotMatch(reconciler,/Access-Control-Allow-Origin|\borigin\s*:\s*['"]\*['"]/i);
});

test('claiming is lease-based, bounded and service-role only',()=>{
  assert.match(reconciler,/v1_service_paymob_reconciliation_claim/);
  assert.match(reconciler,/p_worker_id\s*:/);
  assert.match(reconciler,/p_lease_seconds\s*:/);
  assert.match(reconciler,/p_lease_token\s*:/);
  assert.match(reconciler,/const\s+MAX_JOBS\s*=\s*10/);
  assert.match(reconciler,/const\s+LEASE_SECONDS\s*=\s*90/);
  assert.match(reconciler,/reconciliation_queue_unavailable/);
  assert.match(reconciler,/jsonResponse\s*\(\s*503[\s\S]{0,180}?queue_unavailable/i);

  const serviceRpc=functionBody('serviceRpc');
  assert.match(serviceRpc,/SUPABASE|serviceRoleKey/);
  assert.match(serviceRpc,/authorization:\s*`Bearer\s+\$\{serviceRoleKey\}`/i);
});

test('SQL claim rejects NULL leases and never revives terminal or exhausted jobs',()=>{
  const claim=sqlFunction('public.v1_service_paymob_reconciliation_claim');
  assert.match(
    claim,
    /p_lease_seconds\s+is\s+null[\s\S]*?p_lease_seconds\s+not\s+between\s+30\s+and\s+300/i
  );

  const expiryUpsert=/on\s+conflict\s*\(attempt_id\s*,\s*reconciliation_type\)\s+do\s+update([\s\S]*?)\n\s*for\s+v_job\s+in/i.exec(claim);
  assert.ok(expiryUpsert,'Missing bounded expired-checkout reconciliation seed');
  assert.match(
    expiryUpsert[1],
    /where\s+marketplace\.reconciliations\.status\s+in\s*\(\s*'queued'\s*,\s*'unknown'\s*,\s*'failed'\s*\)/i
  );
  assert.doesNotMatch(expiryUpsert[1],/'running'|'review_required'|'matched'|'resolved'|'mismatch'/i);

  assert.match(
    claim,
    /status\s*=\s*'running'[\s\S]*?lease_expires_at\s*<=\s*now\(\)[\s\S]*?attempt_count\s*>=\s*reconciliation\.max_attempts[\s\S]*?status\s*=\s*'review_required'/i
  );
  assert.match(
    claim,
    /attempt_count\s*<\s*reconciliation\.max_attempts[\s\S]*?for\s+update\s+skip\s+locked/i
  );
});

test('checkout client-secret cleanup is bounded, isolated and observable',()=>{
  const cleanup=sqlFunction('public.v1_service_paymob_cleanup_checkout_secrets');
  assert.match(reconciler,/const\s+CHECKOUT_SECRET_CLEANUP_LIMIT\s*=\s*25/);
  assert.match(reconciler,/v1_service_paymob_cleanup_checkout_secrets/);
  assert.match(reconciler,/p_limit:\s*CHECKOUT_SECRET_CLEANUP_LIMIT/);
  assert.match(reconciler,/cleanupUnavailable/);
  assert.match(reconciler,/checkoutSecretsScanned/);
  assert.match(reconciler,/checkoutSecretsDeleted/);
  assert.match(reconciler,/checkoutSecretsFailed/);
  assert.ok(
    reconciler.indexOf('v1_service_paymob_cleanup_checkout_secrets')<
      reconciler.indexOf('for (let index = 0; index < maxJobs'),
    'Cleanup must run once before the reconciliation claim loop'
  );
  assert.equal(
    (reconciler.match(/"v1_service_paymob_cleanup_checkout_secrets"/g)||[]).length,
    1
  );
  assert.match(runbook,/cleanupUnavailable/);
  assert.match(runbook,/fixed limit of 25/i);
  assert.match(runbook,/never attempts a direct Vault fallback/i);
  assert.match(
    cleanup,
    /p_limit\s+is\s+null[\s\S]*?p_limit\s+not\s+between\s+1\s+and\s+100/i
  );
  assert.match(cleanup,/for\s+update\s+skip\s+locked/i);
  assert.match(
    cleanup,
    /set\s+checkout_secret_id\s*=\s*null[\s\S]*?delete\s+from\s+vault\.secrets/i
  );
  assert.doesNotMatch(cleanup,/marketplace\.reconciliations/i);
  assert.ok((reconciler.match(/cleanupUnavailable/g)||[]).length>=3);
  assert.ok((reconciler.match(/checkoutSecretsFailed/g)||[]).length>=2);
});

test('only the two official fixed-host KSA inquiry contracts are implemented',()=>{
  assert.match(reconciler,/https:\/\/ksa\.paymob\.com/);
  assert.match(reconciler,/\/api\/auth\/tokens/);
  assert.match(
    reconciler,
    /\/api\/acceptance\/transactions\/\$\{transactionId\}/
  );
  assert.match(reconciler,/\/api\/ecommerce\/orders\/transaction_inquiry/);
  assert.match(functionBody('inquireByTransactionId'),/method:\s*['"]GET['"]/i);
  assert.match(functionBody('inquireByMerchantOrderId'),/method:\s*['"]POST['"]/i);
  assert.match(
    functionBody('inquireByMerchantOrderId'),
    /JSON\.stringify\s*\(\s*\{\s*merchant_order_id:\s*attemptId\s*\}\s*\)/i
  );
  assert.match(functionBody('generateAuthToken'),/method:\s*['"]POST['"]/i);
  assert.doesNotMatch(
    reconciler,
    /\/api\/acceptance\/transactions\/order|\/transaction_inquiry\?[^'"`\s]*/i
  );
  assert.match(reconciler,/special_reference as merchant_order_id/i);
  assert.match(reconciler,/payload\.inquiryMethod/);
  assert.match(reconciler,/payload\.inquiryPath/);
  assert.match(reconciler,/payload\.providerTransactionId/);
  assert.match(reconciler,/payload\.attemptCredentialVersionId/);
  assert.match(reconciler,/payload\.inquiryCredentialVersionId/);
  assert.match(reconciler,/RECONCILIATION_RUNTIME_KEYS/);
  assert.match(
    reconciler,
    /Object\.keys\(payload\)\.some\(\(key\)\s*=>\s*!RECONCILIATION_RUNTIME_KEYS\.has\(key\)\)/i
  );
  for(const runtimeField of [
    'providerKey',
    'specialReference',
    'integrationId',
    'owner',
    'attemptCredentialVersionId',
    'inquiryCredentialVersionId'
  ])assert.match(
    reconciler,
    new RegExp(`RECONCILIATION_RUNTIME_KEYS[\\s\\S]*?["']${runtimeField}["']`),
    `Runtime allowlist must include ${runtimeField}`
  );
  assert.match(
    reconciler,
    /credentialVersionId\s*!==\s*inquiryCredentialVersionId/i
  );
  const runtimeSql=sqlFunction('public.v1_service_paymob_reconciliation_runtime');
  assert.match(
    runtimeSql,
    /version\.status\s*=\s*'active'[\s\S]*?version\.environment\s*=\s*v_attempt_version\.environment[\s\S]*?version\.integration_id\s*=\s*v_attempt_version\.integration_id[\s\S]*?version\.owner_id\s*=\s*v_attempt_version\.owner_id/i
  );
  assert.match(runtimeSql,/'attemptCredentialVersionId'\s*,\s*v_attempt_version\.id/i);
  assert.match(runtimeSql,/'inquiryCredentialVersionId'\s*,\s*v_inquiry_version\.id/i);
  assert.match(
    runtimeSql,
    /update\s+marketplace\.reconciliations[\s\S]*?set\s+inquiry_credential_version_id\s*=\s*v_inquiry_version\.id/i
  );
  assert.match(reconciler,/expectedMethod\s*=\s*job\.providerTransactionId\s*\?\s*['"]GET['"]\s*:\s*['"]POST['"]/i);
  assert.doesNotMatch(reconciler,/fetchTextWithTimeout\s*\(\s*(?:runtime\.)?inquiryPath/i);
});

test('auth token is cached only within one invocation and upstream calls have no retry loop',()=>{
  assert.match(reconciler,/const\s+tokenCache\s*=\s*new\s+Map<string,\s*string>\s*\(\s*\)/);
  assert.match(reconciler,/sha256Hex\s*\([\s\S]{0,120}?runtime\.apiKey/);
  assert.match(reconciler,/tokenCache\.(?:get|set)\s*\(\s*fingerprint/);
  assert.doesNotMatch(reconciler,/Deno\.Kv|localStorage|globalThis\.[A-Za-z_$][\w$]*\s*=|create\s+table/i);

  const auth=functionBody('generateAuthToken');
  const inquiryById=functionBody('inquireByTransactionId');
  const inquiryByReference=functionBody('inquireByMerchantOrderId');
  assert.equal((auth.match(/fetchTextWithTimeout\s*\(/g)||[]).length,1);
  assert.equal((inquiryById.match(/fetchTextWithTimeout\s*\(/g)||[]).length,1);
  assert.equal((inquiryByReference.match(/fetchTextWithTimeout\s*\(/g)||[]).length,1);
  assert.doesNotMatch(
    `${auth}\n${inquiryById}\n${inquiryByReference}`,
    /for\s*\([^)]*(?:retry|attempt)|while\s*\(/i
  );
  assert.match(reconciler,/v1_service_paymob_reconciliation_reschedule/);
  assert.match(reconciler,/provider_inquiry_timeout/);
  assert.match(reconciler,/provider_inquiry_network_error/);
});

test('authoritative response is normalized and SHA-bound before the database applicator',()=>{
  const applySql=sqlFunction('public.v1_service_paymob_reconciliation_apply');
  const reconciliationSurface=`${reconciler}\n${normalizer}`;
  for(const providerField of [
    'amount_cents',
    'paid_amount_cents',
    'currency',
    'integration_id',
    'owner',
    'error_occured',
    'is_auth',
    'is_capture',
    'is_standalone_payment',
    'has_parent_transaction',
    'is_refunded',
    'is_voided',
    'refunded_amount_cents'
  ])assert.match(reconciliationSurface,new RegExp(providerField,'i'),`Missing ${providerField}`);

  for(const rpcField of [
    'p_provider_transaction_id',
    'p_provider_order_id',
    'p_merchant_order_id',
    'p_inquiry_mode',
    'p_inquiry_credential_version_id',
    'p_integration_id',
    'p_owner',
    'p_amount_minor',
    'p_currency',
    'p_order_paid_amount_minor',
    'p_error_occured',
    'p_is_auth',
    'p_is_capture',
    'p_is_standalone_payment',
    'p_has_parent_transaction',
    'p_is_refunded',
    'p_is_voided',
    'p_cumulative_refunded_minor',
    'p_response_sha256'
  ])assert.match(reconciler,new RegExp(rpcField,'i'),`Missing ${rpcField}`);
  assert.doesNotMatch(reconciler,/\bp_state\s*:/i);
  assert.match(
    reconciler,
    /p_inquiry_credential_version_id:\s*\n?\s*runtime\.inquiryCredentialVersionId/i
  );
  assert.match(
    applySql,
    /p_worker_id\s+text\s*,\s*p_inquiry_credential_version_id\s+uuid\s*,\s*p_inquiry_mode\s+text/i
  );
  assert.match(
    applySql,
    /v_job\.inquiry_credential_version_id\s+is\s+distinct\s+from\s+p_inquiry_credential_version_id[\s\S]*?inquiry_credential_binding_mismatch/i
  );

  assert.match(
    reconciler,
    /sha256Hex\s*\(\s*providerResult\.raw\s*\)[\s\S]*?v1_service_paymob_reconciliation_apply/i
  );
  const disposition=functionBody('applicationDisposition');
  assert.match(disposition,/outcome\s*===\s*["']matched["']/i);
  assert.match(disposition,/outcome\s*===\s*["']pending["'][\s\S]*?["']rescheduled["']/i);
  assert.match(disposition,/outcome\s*===\s*["']review_required["']/i);
  assert.match(disposition,/status\s*===\s*["']queued["'][\s\S]*?status\s*===\s*["']failed["']/i);
  assert.match(
    reconciler,
    /applicationDisposition\s*\(\s*applicationResult\s*\)[\s\S]*?reviewRequired\s*\+=\s*1[\s\S]*?rescheduled\s*\+=\s*1/i
  );
});

test('worker cannot directly mark an order, refund or entitlement',()=>{
  assert.doesNotMatch(
    reconciler,
    /tenant_addon_subscriptions|entitlement_sources|marketplace\.orders|payment_status\s*[:=]|status\s*:\s*['"]paid['"]/i
  );
  assert.doesNotMatch(reconciler,/v1_platform_paymob_refund_action|ingest_verified_transaction/i);
  assert.match(reconciler,/v1_service_paymob_reconciliation_apply/);
});

test('raw provider data and payment PII are never logged or persisted',()=>{
  const reconciliationSurface=`${reconciler}\n${normalizer}`;
  assert.doesNotMatch(reconciliationSurface,/console\.(?:log|debug|info|warn|error)\s*\(/i);
  assert.doesNotMatch(reconciliationSurface,/(?:raw_body|raw_payload|billing_data|source_data|\bpan\b|\bcvv\b)\s*:/i);
  assert.doesNotMatch(
    reconciler,
    /p_(?:raw|payload|response)(?!_sha256)[a-z0-9_]*\s*:/i
  );
  assert.match(reconciler,/p_response_sha256\s*:/i);
});

test('official null refunded amount is zero only for a non-refunded transaction',()=>{
  const officialSuccessfulFixture={
    id:574588,
    pending:false,
    amount_cents:2000,
    success:true,
    is_auth:false,
    is_capture:false,
    is_standalone_payment:true,
    is_voided:false,
    is_refunded:false,
    integration_id:158,
    has_parent_transaction:false,
    order:{
      id:690898,
      merchant_order_id:'5da2aa51-5be9-46c5-aa4e-e0715737e1a4',
      paid_amount_cents:2000
    },
    currency:'SAR',
    error_occured:false,
    refunded_amount_cents:null,
    owner:211
  };
  const normalized=normalizerRuntime.normalizePaymobInquiry(
    officialSuccessfulFixture
  );
  assert.equal(normalized.cumulativeRefundedMinor,0);
  assert.equal(normalized.orderPaidAmountMinor,2000);
  assert.equal(normalized.state,'succeeded');

  assert.throws(
    ()=>normalizerRuntime.normalizePaymobInquiry({
      ...officialSuccessfulFixture,
      is_refunded:true
    }),
    error=>error?.code==='missing_refunded_amount_cents'
  );
});

test('capture children are never normalized as an initial payable success',()=>{
  const captureChild={
    id:574589,
    pending:false,
    amount_cents:2000,
    success:true,
    is_auth:false,
    is_capture:true,
    is_standalone_payment:false,
    is_voided:false,
    is_refunded:false,
    integration_id:158,
    has_parent_transaction:true,
    order:{
      id:690898,
      merchant_order_id:'5da2aa51-5be9-46c5-aa4e-e0715737e1a4',
      paid_amount_cents:2000
    },
    currency:'SAR',
    error_occured:false,
    refunded_amount_cents:0,
    owner:211
  };
  assert.notEqual(
    normalizerRuntime.normalizePaymobInquiry(captureChild).state,
    'succeeded'
  );
});

test('last failed child preserves prior paid aggregate for SQL review',()=>{
  const apply=sqlFunction('public.v1_service_paymob_reconciliation_apply');
  const latestFailed={
    id:574590,
    pending:false,
    amount_cents:2000,
    success:false,
    is_auth:false,
    is_capture:false,
    is_standalone_payment:true,
    is_voided:false,
    is_refunded:false,
    integration_id:158,
    has_parent_transaction:false,
    order:{
      id:690898,
      merchant_order_id:'5da2aa51-5be9-46c5-aa4e-e0715737e1a4',
      paid_amount_cents:2000
    },
    currency:'SAR',
    error_occured:true,
    refunded_amount_cents:0,
    owner:211
  };
  const normalized=normalizerRuntime.normalizePaymobInquiry(latestFailed);
  assert.equal(normalized.state,'failed');
  assert.equal(normalized.orderPaidAmountMinor,2000);
  assert.throws(
    ()=>normalizerRuntime.normalizePaymobInquiry({
      ...latestFailed,
      order:{
        id:latestFailed.order.id,
        merchant_order_id:latestFailed.order.merchant_order_id
      }
    }),
    error=>error?.code==='invalid_order_paid_amount_cents'
  );
  assert.throws(
    ()=>normalizerRuntime.normalizePaymobInquiry({
      ...latestFailed,
      order:{...latestFailed.order,paid_amount_cents:-1}
    }),
    error=>error?.code==='invalid_order_paid_amount_cents'
  );
  assert.match(reconciler,/p_order_paid_amount_minor:\s*inquiry\.orderPaidAmountMinor/);
  assert.match(runbook,/positive aggregate with a non-final latest\s+transaction/i);
  assert.match(runbook,/cannot close the attempt/i);
  assert.match(
    apply,
    /p_currency\s+text\s*,\s*p_order_paid_amount_minor\s+bigint\s*,\s*p_cumulative_refunded_minor\s+bigint/i
  );
  assert.match(
    apply,
    /when\s+v_final_paid[\s\S]*?p_order_paid_amount_minor\s+is\s+distinct\s+from\s+v_attempt\.amount_minor[\s\S]*?order_paid_amount_mismatch/i
  );
  assert.match(
    apply,
    /p_order_paid_amount_minor\s*>\s*0[\s\S]*?not\s+v_final_paid[\s\S]*?not\s+coalesce\(p_is_refunded\s*,\s*false\)[\s\S]*?not\s+coalesce\(p_is_voided\s*,\s*false\)[\s\S]*?order_paid_aggregate_requires_review/i
  );
  assert.ok(
    apply.indexOf("order_paid_aggregate_requires_review")<
      apply.indexOf('update marketplace.payment_attempts'),
    'Paid aggregate conflict must be reviewed before any attempt mutation'
  );
  assert.match(
    apply,
    /order_paid_aggregate_requires_review[\s\S]*?status\s*=\s*'review_required'/i
  );
  assert.match(
    apply,
    /if\s+coalesce\(p_order_paid_amount_minor\s*,\s*0\)\s*>\s*0\s+or\s+v_final_paid[\s\S]*?set\s+status\s*=\s*'quarantined'[\s\S]*?status\s+not\s+in\s*\(\s*'paid'\s*,\s*'refunded'\s*,\s*'cancelled'\s*\)/i
  );
  assert.match(
    apply,
    /set\s+status\s*=\s*'quarantined'[\s\S]*?and\s+not\s+exists\s*\([\s\S]*?from\s+marketplace\.payment_attempts\s+active_sibling[\s\S]*?active_sibling\.order_id\s*=\s*v_attempt\.order_id[\s\S]*?active_sibling\.id\s*<>\s*v_attempt\.id[\s\S]*?active_sibling\.status\s+in\s*\([\s\S]*?'quarantined'[\s\S]*?\)/i,
    'An older failed attempt must remain terminal when a newer active sibling owns the unique checkout guard'
  );
  assert.ok(
    apply.indexOf('and not exists (')<
      apply.indexOf("set status = 'review_required'"),
    'Sibling-safe quarantine must not prevent the reconciliation review write'
  );
  assert.match(
    migration,
    /payment_attempts_active_order_idx[\s\S]*?where\s+status\s+in\s*\([\s\S]*?'quarantined'/i
  );
  assert.match(apply,/observed_order_paid_minor\s*=/i);
});

test('dispatcher secret and one-minute bounded schedule are documented safely',()=>{
  assert.match(envExample,/^PAYMOB_RECONCILE_DISPATCHER_SECRET=\s*$/m);
  assert.doesNotMatch(envExample,/^PAYMOB_RECONCILE_DISPATCHER_SECRET=\S+/m);
  assert.match(runbook,/once per minute/i);
  assert.match(runbook,/x-odeir-paymob-reconcile-secret/i);
  assert.match(runbook,/maxJobs/i);
  assert.match(runbook,/caps each invocation at 10 jobs/i);
  assert.match(runbook,/Do not log the dispatcher header/i);
  assert.match(runbook,/refund\/void initiation is intentionally not exposed/i);
  assert.match(runbook,/hard live-rollout blocker/i);
});

test('lifecycle maintenance consumes a bounded batch slot without stopping the worker',()=>{
  assert.match(
    reconciler,
    /type\s+ClaimResult\s*=\s*ReconciliationJob\s*\|\s*"maintenance"\s*\|\s*null/i
  );
  assert.match(
    reconciler,
    /payload\.claimed\s*===\s*false[\s\S]*?payload\.maintenanceProcessed\s*===\s*true[\s\S]*?return\s+"maintenance"/i
  );
  assert.match(
    reconciler,
    /if\s*\(claim\s*===\s*"maintenance"\)[\s\S]*?maintenanceProcessed\s*\+=\s*1[\s\S]*?continue/i
  );
  assert.match(reconciler,/for\s*\([^)]*index\s*<\s*maxJobs/i);
  assert.match(reconciler,/maintenanceProcessed,/i);
});
