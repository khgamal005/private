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

const route=source('app/api/platform/payment-provider-secret/route.js');
const controlRoute=source('app/api/platform/paymob-control/route.js');
const edge=source('supabase/functions/payment-provider-admin/index.ts');
const ui=source('components/platform-addon-console.js');
const migration=source(
  'supabase/migrations/20260901134621_paymob_intention_checkout_v1.sql'
);
const quicklinkMigration=source(
  'supabase/migrations/20260903203000_paymob_quicklink_checkout_options_v1.sql'
);
const singleOperatorMigration=source(
  'supabase/migrations/20260904223000_single_authorized_operator_policy_v1.sql'
);

const EXPECTED_PUBLIC_KEYS=[
  'merchantAccountId','integrationPath','integrationId',
  'applePayIntegrationId','region'
];
const EXPECTED_SECRET_KEYS=['apiKey','hmacSecret'];

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function declaredStrings(text,name){
  const match=new RegExp(
    `${escapeRegExp(name)}\\s*=\\s*(?:new\\s+Set\\s*\\()?\\s*\\[([\\s\\S]*?)\\]`,
    'i'
  ).exec(text);
  assert.ok(match,`Missing ${name}`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item=>item[1]);
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

test('all three admin layers enforce the governed Paymob credential contract',()=>{
  for(const adminSource of [route,edge]){
    assert.deepEqual(
      declaredStrings(adminSource,'PAYMOB_PUBLIC_CONFIG_KEYS'),
      EXPECTED_PUBLIC_KEYS
    );
    assert.deepEqual(
      declaredStrings(adminSource,'PAYMOB_SECRET_KEYS'),
      EXPECTED_SECRET_KEYS
    );
    assert.match(adminSource,/configKeys\.every\([^)]*PAYMOB_PUBLIC_CONFIG_KEYS\.has/i);
    assert.match(adminSource,/positiveSafeInteger\(publicConfig\.merchantAccountId/);
    assert.match(adminSource,/positiveSafeInteger\(publicConfig\.integrationId/);
    assert.match(adminSource,/integrationPath\s*===\s*['"]quicklink['"]/i);
    assert.match(adminSource,/applePayIntegrationId===null[\s\S]{0,220}?integrationPath===['"]quicklink['"]/i);
    assert.match(adminSource,/secretEntries\.every[\s\S]{0,100}?PAYMOB_SECRET_KEYS\.has/i);
  }

  assert.deepEqual(declaredStrings(ui,'PAYMOB_PUBLIC_CONFIG_KEYS'),EXPECTED_PUBLIC_KEYS);
  assert.deepEqual(declaredStrings(ui,'PAYMOB_REQUIRED_SECRET_KEYS'),EXPECTED_SECRET_KEYS);
});

test('Paymob KSA checkout is pinned to redirect, SAR and canonical positive IDs',()=>{
  for(const adminSource of [route,edge]){
    assert.match(adminSource,/checkoutMode\s*===\s*['"]redirect['"]/);
    assert.match(adminSource,/supportedCurrencies\.length\s*===\s*1/);
    assert.match(adminSource,/supportedCurrencies\[0\]\s*===\s*['"]SAR['"]/);
    assert.match(adminSource,/publicConfig\.region\s*===\s*['"]ksa['"]/);
    assert.match(adminSource,/\^\[1-9\]\\d\*\$/);
    assert.match(adminSource,/Number\.isSafeInteger\s*\(/);
    assert.match(adminSource,/positiveSafeInteger\(publicConfig\.merchantAccountId/);
    assert.match(adminSource,/positiveSafeInteger\(publicConfig\.integrationId/);
  }

  assert.match(ui,/paymob\?['"]redirect['"]\s*:/);
  assert.match(ui,/paymob\?\[['"]SAR['"]\]\s*:/);
  assert.match(ui,/value=['"]ksa['"]\s+readOnly/i);
  assert.match(ui,/pattern=\{numericPaymobId\?['"]\[1-9\]\[0-9\]\*['"]/);
});

test('apiKey is a required write-only credential, not optional presentation data',()=>{
  assert.match(
    migration,
    /required_secret_keys\s*=\s*array\s*\[\s*'secretKey'\s*,\s*'publicKey'\s*,\s*'hmacSecret'\s*,\s*'apiKey'\s*\]/i
  );
  assert.match(ui,/secretKey\s*:\s*['"]Secret Key \(Unified Checkout والعمليات المحكومة\)['"]/);
  assert.match(ui,/apiKey\s*:\s*['"]API Key \(QuickLink والاستعلام والمطابقة\)['"]/);
  assert.match(ui,/type=['"]password['"][\s\S]{0,100}?autoComplete=['"]new-password['"]/i);
  assert.doesNotMatch(ui,/secretValue\s*=\s*item\.|defaultValue=\{[^}]*secret/i);

  const response=/return\s+json\(200,\{([\s\S]*?)\}\s*\);/i.exec(edge);
  assert.ok(response,'Missing safe credential-save response');
  assert.match(response[1],/liveReady\s*:\s*false/);
  assert.match(response[1],/secretReturned\s*:\s*false/);
  assert.doesNotMatch(response[1],/\bsecrets?\b|apiKey|secretKey|hmacSecret|publicKey/i);
});

test('optional Apple Pay routing can be added and explicitly cleared',()=>{
  for(const adminSource of [route,edge]){
    assert.match(adminSource,/hasOwnProperty\.call\([\s\S]{0,80}?['"]applePayIntegrationId['"]/i);
    assert.match(adminSource,/applePayIntegrationId\s*===\s*null/i);
    assert.match(adminSource,/key\s*===\s*['"]applePayIntegrationId['"]\s*&&\s*value\s*===\s*null/i);
  }
  assert.match(ui,/publicConfig\[configKey\]\s*=\s*null/i);
  assert.match(quicklinkMigration,/submitted\.config_key\s+in\s*\([\s\S]{0,100}?['"]integrationPath['"][\s\S]{0,100}?['"]applePayIntegrationId['"]/i);
  assert.match(quicklinkMigration,/v_public_config\s*:=\s*v_public_config\s*-\s*['"]applePayIntegrationId['"]/i);
  assert.match(quicklinkMigration,/paymob_checkout_route_metadata_required/i);
});

test('credential Edge ingress also enforces its body limit while streaming',()=>{
  assert.doesNotMatch(edge,/request\.(?:text|json)\s*\(/i);
  assert.match(edge,/readTextLimited\s*\(\s*request\s*,\s*MAX_BODY_BYTES\s*\)/i);
  assert.match(edge,/request\.body\.getReader\s*\(\s*\)/i);
  assert.match(edge,/reader\.cancel\s*\(/i);
  assert.match(edge,/payload_too_large/i);
});

test('credential Edge bounds both authorization and Vault-writer RPC responses',()=>{
  assert.match(edge,/RPC_TIMEOUT_MS\s*=\s*10_?000/);
  assert.match(edge,/MAX_RPC_RESPONSE_BYTES\s*=\s*16\s*\*\s*1024/);
  assert.ok(
    (edge.match(/fetchTextWithTimeout\s*\(/g)||[]).length>=3,
    'Expected helper plus bounded authorization and credential-store calls'
  );
  assert.ok((edge.match(/redirect\s*:\s*['"]error['"]/g)||[]).length>=2);
  assert.doesNotMatch(edge,/\.json\s*\(\s*\)|\.text\s*\(\s*\)/i);
  assert.match(edge,/AbortController/);
  assert.match(edge,/reader\.cancel\s*\(/i);
});

test('SQL activation is evidence-gated and a credential save can never make Paymob live',()=>{
  const guard=sqlFunction('private_app.v3_payment_provider_config_guard');
  const required=sqlFunction('private_app.paymob_required_checks');
  const surface=`${guard}\n${required}`;

  assert.match(surface,/status\s*<>\s*'active'|status\s*=\s*'active'/i);
  assert.match(surface,/rollout_mode\s*<>\s*'live'|rollout_mode\s*=\s*'live'/i);
  assert.match(surface,/environment\s*<>\s*'live'|environment\s*=\s*'live'/i);
  assert.match(surface,/paymob_missing_checks/i);
  for(const evidence of [
    'paid_transaction',
    'duplicate_delivery',
    'failed_transaction',
    'transaction_inquiry',
    'refund_inquiry',
    'refund_initiation',
    'live_credentials'
  ])assert.match(required,new RegExp(`'${evidence}'`));

  assert.match(edge,/liveReady\s*:\s*false/);
  assert.doesNotMatch(edge,/status\s*:\s*['"]active['"]|liveReady\s*:\s*true/i);
});

test('runtime config is purpose-scoped and checkout receives no plaintext apiKey',()=>{
  const runtime=sqlFunction('public.v1_service_paymob_runtime_config');

  assert.match(runtime,/p_purpose/i);
  assert.match(runtime,/'create_intention'/i);
  assert.match(runtime,/'verify_webhook'/i);
  assert.match(runtime,/'apiKeyConfigured'\s*,/i);
  assert.doesNotMatch(runtime,/'apiKey'\s*,/i);
  assert.doesNotMatch(runtime,/v_secrets\s*->>\s*'apiKey'/i);
  assert.match(runtime,/'secretKey'\s*,/i);
  assert.match(runtime,/'publicKey'\s*,/i);
  assert.match(runtime,/'hmacSecret'\s*,/i);
  assert.doesNotMatch(runtime,/'clientSecret'\s*,/i);
});

test('QuickLink API key is released only to the service-role checkout purpose',()=>{
  const start=quicklinkMigration.indexOf(
    'create or replace function public.v1_service_paymob_runtime_config('
  );
  assert.notEqual(start,-1);
  const tail=quicklinkMigration.slice(start);
  const end=tail.indexOf(
    'create or replace function public.v1_service_paymob_resume_checkout('
  );
  assert.notEqual(end,-1);
  const runtime=tail.slice(0,end);

  assert.match(runtime,/coalesce\(auth\.jwt\(\)\s*->>\s*'role',\s*''\)\s*<>\s*'service_role'/i);
  assert.match(runtime,/p_purpose\s+text\s+default\s+'create_intention'/i);
  assert.match(runtime,/v_attempt\.checkout_flow\s*=\s*'quicklink'/i);
  assert.match(runtime,/'apiKey'\s*,\s*v_api_key/i);
  assert.match(runtime,/v_version\.api_key_vault_secret_id/i);
  assert.match(runtime,/p_purpose\s*=\s*'verify_webhook'/i);
  assert.doesNotMatch(runtime,/hmacCandidates[\s\S]{0,500}?'apiKey'/i);
});

test('Paymob control plane is caller-scoped, bounded, typed and sanitized',()=>{
  assert.match(controlRoute,/export\s+async\s+function\s+GET\s*\(\s*request\s*\)/i);
  assert.match(controlRoute,/export\s+async\s+function\s+POST\s*\(\s*request\s*\)/i);
  assert.ok(
    (controlRoute.match(/!sameOrigin\(request\)/g)||[]).length>=2,
    'GET and POST must reject cross-origin requests'
  );
  assert.match(controlRoute,/headers\.get\(\s*['"]origin['"]\s*\)/i);
  assert.match(controlRoute,/headers\.get\(\s*['"]sec-fetch-site['"]\s*\)/i);
  assert.match(controlRoute,/x-forwarded-host[\s\S]*?x-forwarded-proto/i);
  assert.match(controlRoute,/contentType\s*!==\s*['"]application\/json['"]/i);

  assert.match(controlRoute,/MAX_REQUEST_BYTES\s*=\s*8\s*\*\s*1024/i);
  assert.match(controlRoute,/readTextLimited\(\s*request\s*,\s*MAX_REQUEST_BYTES\s*\)/i);
  assert.match(controlRoute,/source\.body\.getReader\s*\(\s*\)/i);
  assert.match(controlRoute,/value\.byteLength/i);
  assert.match(controlRoute,/reader\.cancel\s*\(/i);
  assert.doesNotMatch(controlRoute,/request\.(?:json|text)\s*\(/i);

  assert.match(controlRoute,/cookies\(\)[\s\S]*?ACCESS_COOKIE/i);
  assert.match(controlRoute,/Authorization\s*:[\s\S]{0,40}?Bearer/i);
  assert.doesNotMatch(controlRoute,/service[_-]?role|SUPABASE_SERVICE/i);
  assert.match(controlRoute,/v1_platform_paymob_readiness_snapshot/i);
  assert.match(controlRoute,/v1_platform_paymob_activation_gate/i);
  assert.match(controlRoute,/v1_platform_paymob_tenant_rollout_action/i);

  assert.deepEqual(
    declaredStrings(controlRoute,'GLOBAL_ACTIONS'),
    ['global_activate']
  );
  assert.deepEqual(
    declaredStrings(controlRoute,'TENANT_ACTIONS'),
    ['tenant_enable','tenant_disable']
  );
  assert.match(controlRoute,/hasExactKeys\(value,GLOBAL_ACTION_KEYS\)/i);
  assert.match(controlRoute,/hasExactKeys\(value,TENANT_ACTION_KEYS\)/i);
  assert.deepEqual(
    declaredStrings(controlRoute,'EVIDENCE_ACTIONS'),
    ['evidence_attest']
  );
  assert.match(controlRoute,/hasExactKeys\(value,EVIDENCE_ACTION_KEYS\)/i);
  assert.match(controlRoute,/targetMode\.toUpperCase\(\)/i);
  assert.match(controlRoute,/DISABLE PAYMOB CHECKOUT/i);
  assert.match(controlRoute,/PAYMOB TENANT/i);
  assert.match(controlRoute,/if\(value\.confirmation!==expected\)return null/i);

  assert.match(controlRoute,/RPC_TIMEOUT_MS\s*=\s*10_?000/i);
  assert.match(controlRoute,/MAX_UPSTREAM_BYTES\s*=\s*256\s*\*\s*1024/i);
  assert.match(controlRoute,/redirect\s*:\s*['"]error['"]/i);
  assert.match(controlRoute,/AbortSignal\.timeout\(RPC_TIMEOUT_MS\)/i);
  assert.match(controlRoute,/readTextLimited\(response,maxBytes\)/i);
  assert.doesNotMatch(controlRoute,/\bresponse\.(?:json|text)\s*\(/);
  assert.match(controlRoute,/Cache-Control['"]?\s*:\s*['"][^'"]*no-store/i);

  assert.match(controlRoute,/sanitizeSnapshot\(result\.value\)/i);
  for(const governedField of [
    'pendingActivationMode','tenantRollouts','operationalEvidenceRequests',
    'queryLogRedactionVerified'
  ])assert.match(
    controlRoute,
    new RegExp(`\\b${governedField}\\b`),
    `Control snapshot must preserve sanitized ${governedField}`
  );
  assert.match(controlRoute,/sanitizeGlobalAction\(result\.value\)/i);
  assert.match(controlRoute,/sanitizeTenantAction\(result\.value\)/i);
  assert.match(controlRoute,/safeCode\(value\?\.message\|\|value\?\.error\)/i);
  assert.match(controlRoute,/controlError\(errorCode\)/i);
  assert.doesNotMatch(controlRoute,/console\.|\bdetail\s*:|error\.message/i);
});

test('operator UI exposes one-step authorized actions while retaining hard safety gates',()=>{
  assert.match(ui,/fetch\(\s*['"]\/api\/platform\/paymob-control['"][\s\S]{0,120}?method\s*:\s*['"]GET['"][\s\S]{0,100}?cache\s*:\s*['"]no-store['"]/i);
  assert.match(ui,/fetch\(\s*['"]\/api\/platform\/paymob-control['"][\s\S]{0,120}?method\s*:\s*['"]POST['"]/i);
  assert.match(ui,/typed\s*!==\s*modal\.expected[\s\S]*?return/i);
  assert.match(ui,/body\s*:\s*JSON\.stringify\(\{\.\.\.modal\.request,confirmation:typed\}\)/i);

  assert.match(ui,/action:['"]global_activate['"]/i);
  assert.match(ui,/ACTIVATE PAYMOB\s+\$\{targetMode\.toUpperCase\(\)\}/i);
  assert.match(ui,/disabled=\{[\s\S]*?!snapshot\.liveReady\|\|snapshot\.liveGateBlocked/i);
  assert.match(ui,/action:enabled\?['"]tenant_enable['"]:['"]tenant_disable['"]/i);
  assert.match(ui,/ENABLE PAYMOB TENANT\s+\$\{tenant\.id\}/i);
  assert.match(ui,/action:['"]evidence_attest['"]/i);
  assert.match(ui,/ATTEST PAYMOB EVIDENCE/i);
  assert.match(ui,/SINGLE AUTHORIZED OPERATOR/i);
  assert.match(ui,/منفّذ واحد يملك الصلاحية/i);
  assert.doesNotMatch(ui,/global_approve|tenant_approve|evidence_approve|maker[–-]checker|مراجع مختلف|مشغّل آخر/i);

  assert.match(ui,/tenantSlug===['"]reef-skills['"]/i);
  assert.match(ui,/tenantKey===['"]tenant-reef-skills['"]/i);
  assert.match(ui,/Reef Skills مستبعد خادميًا ومن القائمة/i);
  assert.match(ui,/500 ر\.س/);

  for(const checkKey of [
    'refund_inquiry','reconciler_schedule','outbox_delivery',
    'live_card_integration_callback'
  ])assert.match(
    ui,
    new RegExp('\\b'+checkKey+'\\s*:'),
    'Missing Arabic operator label for '+checkKey
  );
});

test('operational evidence is digest-only, live-bound and completed by one authorized operator',()=>{
  const expectedChecks=[
    'refund_initiation','live_credentials','live_card_integration_callback',
    'edge_query_redaction_waf','reconciler_schedule','outbox_delivery'
  ];
  assert.deepEqual(declaredStrings(controlRoute,'EVIDENCE_CHECKS'),expectedChecks);
  assert.deepEqual(declaredStrings(ui,'PAYMOB_OPERATIONAL_CHECKS'),expectedChecks);
  assert.deepEqual(
    declaredStrings(controlRoute,'EVIDENCE_ACTION_KEYS'),
    ['action','checkKey','artifactSha256','confirmation']
  );
  assert.deepEqual(declaredStrings(controlRoute,'EVIDENCE_ACTIONS'),['evidence_attest']);

  assert.match(controlRoute,/\^\[a-f0-9\]\{64\}\$/i);
  assert.match(controlRoute,/ATTEST PAYMOB EVIDENCE/i);
  assert.match(controlRoute,/p_request_id:null/i);
  assert.match(controlRoute,/v1_platform_paymob_operational_evidence_action/i);
  assert.match(controlRoute,/sanitizeEvidenceAction\(result\.value\)/i);
  assert.doesNotMatch(controlRoute,/global_approve|tenant_approve|evidence_approve|checker_required/i);
  assert.doesNotMatch(controlRoute,/FormData|multipart\/form-data|readAsArrayBuffer|arrayBuffer\s*\(/i);

  assert.match(singleOperatorMigration,/drop\s+constraint\s+if\s+exists\s+paymob_operational_evidence_requests_check/i);
  assert.match(singleOperatorMigration,/create\s+or\s+replace\s+function\s+public\.v1_platform_paymob_operational_evidence_action/i);
  assert.match(singleOperatorMigration,/private_app\.has_platform_permission\(\s*'platform\.billing\.manage'\s*\)/i);
  assert.match(singleOperatorMigration,/version\.status\s*=\s*'active'[\s\S]*?version\.environment\s*=\s*'live'/i);
  assert.match(singleOperatorMigration,/ATTEST PAYMOB EVIDENCE/i);
  assert.match(singleOperatorMigration,/requested_by_subject_id\s*=\s*v_actor[\s\S]*?approved_by_subject_id\s*=\s*v_actor/i);
  assert.match(singleOperatorMigration,/status\s*=\s*'approved'/i);
  assert.match(singleOperatorMigration,/private_app\.paymob_readiness_evidence_write\([\s\S]*?'operational_attestation'/i);
  assert.match(singleOperatorMigration,/'approvalPolicy'\s*,\s*'single_authorized_operator'/i);
  assert.match(singleOperatorMigration,/'secretStored'\s*,\s*false[\s\S]*?'piiStored'\s*,\s*false/i);

  assert.match(ui,/بصمة SHA-256/i);
  assert.match(ui,/maxLength=['"]64['"]/i);
  assert.match(ui,/snapshot\.environment!==['"]live['"]/i);
  assert.match(ui,/onClick=\{openEvidence\}/i);
  assert.match(ui,/تسجيل واعتماد البصمة/i);
  assert.match(ui,/لا يُرفع التقرير أو أي بيانات عميل هنا/i);
  assert.doesNotMatch(ui,/type=['"]file['"]|FormData\([^)]*evidence|upload/i);
});
