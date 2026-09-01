import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const migrationPath=join(
  root,
  'supabase/migrations/20260901120000_paymob_intention_checkout_v1.sql'
);
const serviceMarketplaceMigrationPath=join(
  root,
  'supabase/migrations/20260826235130_service_marketplace_professional_v1.sql'
);

assert.ok(existsSync(migrationPath),'Expected the Paymob governance migration');
assert.ok(
  existsSync(serviceMarketplaceMigrationPath),
  'Expected the canonical service marketplace migration'
);
const migration=readFileSync(migrationPath,'utf8');
const serviceMarketplaceMigration=readFileSync(serviceMarketplaceMigrationPath,'utf8');

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
  const table=new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${escapeRegExp(qualifiedName)}\\s*\\(([\\s\\S]*?)^\\);`,
    'im'
  ).exec(migration);
  assert.ok(table,`Missing SQL table ${qualifiedName}`);
  return table[0];
}

function section(text,startMarker,endMarker){
  const start=text.indexOf(startMarker);
  assert.notEqual(start,-1,`Missing ${startMarker}`);
  const end=text.indexOf(endMarker,start+startMarker.length);
  assert.notEqual(end,-1,`Missing ${endMarker}`);
  return text.slice(start,end);
}

function outsideSqlFunctions(text){
  return text.replace(
    /create\s+(?:or\s+replace\s+)?function\b[\s\S]*?\bas\s+(\$[A-Za-z0-9_]*\$)[\s\S]*?\1\s*;/gi,
    ''
  );
}

function assertOrderLockBeforeUpdateRows(sql,name){
  const orderLock=/pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*'paymob:order:'/i.exec(sql);
  assert.ok(orderLock,`${name} must acquire the shared Paymob order lock`);
  const rowLock=/\bfor\s+update\b/i.exec(sql);
  assert.ok(rowLock,`${name} must lock its mutable ledger rows`);
  assert.ok(
    orderLock.index<rowLock.index,
    `${name} must acquire the shared order lock before any FOR UPDATE row lock`
  );
}

test('payment ledger migration is additive, atomic, tenant-isolated and RPC-only',()=>{
  const tables=[
    'paymob_credential_versions',
    'paymob_readiness_evidence_history',
    'paymob_operational_evidence_requests',
    'payment_attempts',
    'payment_attempt_items',
    'webhook_deliveries',
    'entitlement_sources',
    'refunds',
    'reconciliations',
    'payment_outbox',
    'payment_tenant_rollouts'
  ];

  assert.equal((migration.match(/^begin\s*;/gim)||[]).length,1);
  assert.equal((migration.match(/^commit\s*;/gim)||[]).length,1);
  assert.doesNotMatch(
    outsideSqlFunctions(migration),
    /\bdrop\s+(?:table|schema)\b|\btruncate(?:\s+table)?\b|\bdelete\s+from\s+(?:marketplace|core|catalog)\./i
  );

  for(const table of tables){
    sqlTable(`marketplace.${table}`);
    assert.match(
      migration,
      new RegExp(`alter\\s+table\\s+marketplace\\.${table}\\s+enable\\s+row\\s+level\\s+security`,'i')
    );
    assert.match(
      migration,
      new RegExp(`alter\\s+table\\s+marketplace\\.${table}\\s+force\\s+row\\s+level\\s+security`,'i')
    );
    assert.match(
      migration,
      new RegExp(`revoke\\s+all\\s+on\\s+table\\s+marketplace\\.${table}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role`,'i')
    );
  }
});

test('migration normalizes the legacy Paymob currency set before the SAR-only guard',()=>{
  const resetStart=migration.indexOf(
    'update marketplace.payment_provider_configs\nset required_secret_keys'
  );
  const guardStart=migration.indexOf(
    'create or replace function private_app.v3_payment_provider_config_guard()'
  );
  assert.ok(resetStart!==-1&&guardStart>resetStart,'Expected the Paymob reset before the replacement guard');
  const reset=migration.slice(resetStart,guardStart);
  assert.match(
    reset,
    /supported_currencies\s*=\s*array\['SAR'\]::text\[\]/i,
    'Production carries the legacy SAR/EGP seed and must be normalized before secret-ref triggers use the strict guard'
  );
});

test('checkout preparation snapshots exact commercial truth and single-flights an order',()=>{
  const prepare=sqlFunction('public.v1_tenant_paymob_prepare_checkout');
  const attempts=sqlTable('marketplace.payment_attempts');
  const items=sqlTable('marketplace.payment_attempt_items');
  const settlementSnapshot=section(
    prepare,
    'select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(',
    'select coalesce(jsonb_agg(line.provider_item order by line.sort_order)'
  );
  const intentionItems=section(
    prepare,
    'select coalesce(jsonb_agg(line.provider_item order by line.sort_order)',
    'v_items_hash := encode'
  );

  assert.match(prepare,/private_app\.has_tenant_permission\([\s\S]*?'tenant\.settings\.manage'/i);
  assert.match(prepare,/pg_advisory_xact_lock\s*\(/i);
  assert.match(prepare,/paymob_idempotency_conflict/i);
  assert.match(prepare,/paymob_billing_contact_changed/i);
  assert.match(prepare,/v_attempt\.id\s*:=\s*gen_random_uuid\s*\(\s*\)/i);
  assert.match(prepare,/v_attempt\.id::text\s*,\s*'prepared'/i);
  assert.match(prepare,/credential_version_id[\s\S]*?v_credential_version\.id/i);
  assert.match(prepare,/subtotal_minor[\s\S]*?tax_minor[\s\S]*?tax_rate_bps[\s\S]*?amount_minor[\s\S]*?currency/i);
  assert.match(prepare,/insert\s+into\s+marketplace\.payment_attempt_items/i);
  for(const snapshotField of [
    'item_type','order_item_id','service_package_id','activation_mode_snapshot'
  ])assert.match(prepare,new RegExp(`\\b${snapshotField}\\b`,'i'));
  assert.match(settlementSnapshot,/'lineTotalMinor'\s*,\s*item\.line_total_minor/i);
  assert.match(settlementSnapshot,/'unitAmountMinor'\s*,\s*item\.unit_amount_minor/i);
  assert.match(intentionItems,/'amount'\s*,\s*\(entry\.value\s*->>\s*'lineTotalMinor'\)::bigint/i);
  assert.match(intentionItems,/sum\s*\(\s*\(entry\s*->>\s*'amount'\)::bigint\s*\)/i);
  assert.doesNotMatch(intentionItems,/amount'\)::bigint\s*\*\s*\(entry\s*->>\s*'quantity'/i);
  assert.doesNotMatch(intentionItems,/unitAmountMinor/i);
  assert.match(intentionItems,/<>\s*v_order\.total_minor/i);
  assert.match(prepare,/paymob_service_fixed_package_required/i);

  assert.match(attempts,/check\s*\(special_reference\s*=\s*id::text\)/i);
  assert.match(attempts,/billing_contact_sha256/i);
  assert.match(attempts,/items_snapshot_sha256/i);
  assert.doesNotMatch(attempts,/first_?name|last_?name|email|phone|billing_data/i);
  assert.match(items,/unique\s*\(attempt_id\s*,\s*order_item_id\)/i);
  assert.match(items,/line_total_minor\s*=\s*unit_amount_minor\s*\*\s*quantity/i);
  assert.match(
    migration,
    /create\s+unique\s+index\s+payment_attempts_active_order_idx[\s\S]*?on\s+marketplace\.payment_attempts\s*\(provider_key\s*,\s*environment\s*,\s*order_id\)/i
  );
  for(const id of ['provider_intention_id','provider_order_id','provider_transaction_id']){
    assert.match(
      migration,
      new RegExp(`create\\s+unique\\s+index[\\s\\S]{0,120}?marketplace\\.payment_attempts\\s*\\([^)]*${id}`,'i')
    );
  }
});

test('all payment mutations share one order-first lock hierarchy',()=>{
  const mutators=[
    ['prepare checkout','public.v1_tenant_paymob_prepare_checkout'],
    ['claim intention runtime','public.v1_service_paymob_runtime_config'],
    ['record intention','public.v1_service_paymob_record_intention'],
    ['apply paid settlement','private_app.paymob_apply_paid_attempt_v1'],
    ['ingest verified callback','public.v1_service_paymob_ingest_verified_transaction'],
    ['apply authoritative refund','private_app.paymob_apply_verified_full_refund_v1'],
    ['apply reconciliation','public.v1_service_paymob_reconciliation_apply']
  ];
  for(const [label,qualifiedName] of mutators){
    assertOrderLockBeforeUpdateRows(sqlFunction(qualifiedName),label);
  }

  const record=sqlFunction('public.v1_service_paymob_record_intention');
  const attemptLock=record.search(/\bfor\s+update\b/i);
  const createdBranch=record.indexOf("if p_outcome = 'created' then");
  assert.ok(attemptLock!==-1&&createdBranch>attemptLock);
  const postLockGuard=record.slice(attemptLock,createdBranch);
  assert.match(
    postLockGuard,
    /private_app\.paymob_order_review_hold_v1\(\s*v_attempt\.order_id\s*\)/i
  );
  assert.match(postLockGuard,/last_error_code\s*=\s*'order_payment_review_hold'/i);
  assert.match(postLockGuard,/reconciliation_type\s*,\s*status[\s\S]*?'intention_unknown'\s*,\s*'review_required'/i);
  assert.match(postLockGuard,/'resumeAllowed'\s*,\s*false/i);
});

test('runtime rechecks the exact current checkout gate before issuing an outbound claim',()=>{
  const runtime=sqlFunction('public.v1_service_paymob_runtime_config');
  const createStart=runtime.indexOf('if p_attempt_id is null then');
  const finalGate=runtime.indexOf('-- Final pre-provider-call gate.',createStart);
  const firstDecryptedRead=runtime.indexOf('from vault.decrypted_secrets',createStart);
  const vendorRead=runtime.indexOf('select secret_value.decrypted_secret',finalGate);
  const claimWrite=runtime.indexOf('v_claim_token := gen_random_uuid()',vendorRead);
  const allowedReturn=runtime.indexOf("'createAllowed', true",claimWrite);
  assert.ok(createStart!==-1&&finalGate>createStart,'Missing create-intention runtime branch');
  assert.ok(firstDecryptedRead>finalGate,'A closed runtime gate must not touch decrypted Vault values');
  assert.ok(vendorRead>firstDecryptedRead&&claimWrite>vendorRead&&allowedReturn>claimWrite,'The full gate and bounded secret reads must precede claim/createAllowed=true');
  const createPath=runtime.slice(createStart,allowedReturn);
  const gate=runtime.slice(finalGate,vendorRead);

  assert.match(gate,/v_provider\.environment\s*<>\s*v_attempt\.environment/i);
  assert.match(gate,/v_provider\.credentials_environment\s*<>\s*v_attempt\.environment/i);
  assert.match(gate,/v_provider\.rollout_mode\s*<>\s*v_attempt\.environment/i);
  assert.match(gate,/v_attempt\.environment\s*=\s*'sandbox'\s+and\s+v_provider\.status\s*=\s*'configured'/i);
  assert.match(gate,/v_attempt\.environment\s*=\s*'live'\s+and\s+v_provider\.status\s*=\s*'active'/i);
  assert.match(gate,/v_provider\.last_verified_at\s+is\s+null/i);
  assert.match(gate,/v_provider\.checkout_mode\s*<>\s*'redirect'/i);
  assert.match(gate,/v_provider\.supported_currencies\s*<>\s*array\[\s*'SAR'\s*\]::text\[\]/i);
  assert.match(gate,/v_provider\.public_config\s*->>\s*'region'\s*<>\s*'ksa'/i);
  assert.match(gate,/private_app\.v3_payment_provider_bundle_complete\s*\(/i);
  assert.match(gate,/cardinality\s*\(\s*private_app\.paymob_missing_checks\([\s\S]*?v_attempt\.environment[\s\S]*?\)\s*<>\s*0/i);
  assert.match(gate,/v_tenant\.slug\s*=\s*'reef-skills'[\s\S]*?v_tenant\.tenant_key\s*=\s*'tenant-reef-skills'/i);
  assert.match(gate,/v_rollout\.id\s+is\s+null\s+or\s+v_rollout\.status\s*<>\s*'enabled'/i);
  assert.match(gate,/v_version\.status\s*<>\s*'active'[\s\S]*?v_version\.revoked_at\s+is\s+not\s+null/i);
  assert.match(gate,/v_version\.environment\s*<>\s*v_attempt\.environment/i);
  assert.match(gate,/v_version\.integration_id[\s\S]*?v_provider\.public_config\s*->>\s*'integrationId'/i);
  assert.match(gate,/v_version\.owner_id[\s\S]*?v_provider\.public_config\s*->>\s*'merchantAccountId'/i);
  assert.match(gate,/v_bound_secret_ref_count\s*<>\s*4/i);
  assert.match(gate,/not\s+private_app\.paymob_tenant_checkout_eligible_v1\(\s*v_attempt\.tenant_id\s*,\s*v_attempt\.environment\s*\)/i);
  assert.match(gate,/raise\s+exception\s+'paymob_runtime_configuration_unavailable'/i);
  for(const [key,pointer] of [
    ['hmacSecret','hmac_vault_secret_id'],['apiKey','api_key_vault_secret_id'],
    ['secretKey','secret_key_vault_secret_id'],['publicKey','public_key_vault_secret_id']
  ]){
    assert.match(createPath,new RegExp(`secret_ref\\.secret_key\\s*=\\s*'${key}'[\\s\\S]*?v_version\\.${pointer}`,'i'));
  }
  assert.doesNotMatch(createPath,/v_version\.status\s*=\s*'retiring'|v_version\.status\s*=\s*'expired'/i);
  assert.doesNotMatch(gate,/status\s*=\s*'creating_intention'|'createAllowed'\s*,\s*true/i);
});

test('resume rechecks the same active checkout gate before reading or returning checkout secrets',()=>{
  const resume=sqlFunction('public.v1_service_paymob_resume_checkout');
  const gateStart=resume.indexOf('if v_provider.provider_key is null');
  const firstDecryptedRead=resume.indexOf('from vault.decrypted_secrets');
  const clientSecretRead=resume.indexOf('select decrypted_secret into v_client_secret');
  const publicKeyRead=resume.indexOf('select decrypted.decrypted_secret into v_public_key');
  const allowedReturn=resume.indexOf("'resumeAllowed', true",publicKeyRead);
  assert.ok(gateStart!==-1&&firstDecryptedRead>gateStart,'A global disable must return before any decrypted Vault read');
  assert.ok(clientSecretRead>firstDecryptedRead&&publicKeyRead>clientSecretRead&&allowedReturn>publicKeyRead);
  const preSecret=resume.slice(0,clientSecretRead);
  const gate=resume.slice(gateStart,clientSecretRead);

  assert.match(gate,/v_provider\.environment\s*<>\s*v_attempt\.environment/i);
  assert.match(gate,/v_provider\.credentials_environment\s*<>\s*v_attempt\.environment/i);
  assert.match(gate,/v_provider\.rollout_mode\s*<>\s*v_attempt\.environment/i);
  assert.match(gate,/v_provider\.last_verified_at\s+is\s+null/i);
  assert.match(gate,/v_provider\.checkout_mode\s*<>\s*'redirect'/i);
  assert.match(gate,/v_provider\.supported_currencies\s*<>\s*array\[\s*'SAR'\s*\]::text\[\]/i);
  assert.match(gate,/private_app\.v3_payment_provider_bundle_complete\s*\(/i);
  assert.match(gate,/private_app\.paymob_missing_checks\s*\(/i);
  assert.match(gate,/v_tenant\.slug\s*=\s*'reef-skills'[\s\S]*?v_tenant\.tenant_key\s*=\s*'tenant-reef-skills'/i);
  assert.match(gate,/v_rollout\.status\s*<>\s*'enabled'/i);
  assert.match(gate,/v_version\.status\s*<>\s*'active'[\s\S]*?v_version\.revoked_at\s+is\s+not\s+null/i);
  assert.match(gate,/v_version\.integration_id[\s\S]*?'integrationId'[\s\S]*?v_version\.owner_id[\s\S]*?'merchantAccountId'/i);
  assert.match(gate,/v_bound_secret_ref_count\s*<>\s*4/i);
  assert.match(gate,/not\s+private_app\.paymob_tenant_checkout_eligible_v1\s*\(/i);
  assert.match(gate,/'resumeAllowed'\s*,\s*false[\s\S]*?'lastErrorCode'\s*,\s*'paymob_checkout_gate_closed'/i);
  for(const [key,pointer] of [
    ['hmacSecret','hmac_vault_secret_id'],['apiKey','api_key_vault_secret_id'],
    ['secretKey','secret_key_vault_secret_id'],['publicKey','public_key_vault_secret_id']
  ]){
    assert.match(preSecret,new RegExp(`secret_ref\\.secret_key\\s*=\\s*'${key}'[\\s\\S]*?v_version\\.${pointer}`,'i'));
  }
  assert.doesNotMatch(preSecret,/v_version\.status\s*=\s*'retiring'|v_version\.status\s*=\s*'expired'/i);
  assert.doesNotMatch(gate,/'clientSecret'\s*,|'publicKey'\s*,|'resumeAllowed'\s*,\s*true/i);
});

test('record intention rechecks every kill switch after the outbound claim before storing a resume secret',()=>{
  const record=sqlFunction('public.v1_service_paymob_record_intention');
  const created=section(
    record,
    "if p_outcome = 'created' then",
    "elsif p_outcome = 'failed' then"
  );
  const orderLock=record.search(/pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*'paymob:order:'/i);
  const attemptLock=record.search(/select\s+attempt\.\*\s+into\s+v_attempt[\s\S]{0,300}?for\s+update/i);
  const claimGuard=record.indexOf("v_attempt.status <> 'creating_intention'");
  const providerRecheck=record.indexOf('select provider.* into v_provider',claimGuard);
  const vaultWrite=record.indexOf('select vault.create_secret(',providerRecheck);
  assert.ok(orderLock!==-1&&attemptLock>orderLock,'Record must take the canonical order lock before its attempt row');
  assert.ok(claimGuard>attemptLock&&providerRecheck>claimGuard,'Kill switches must be rechecked only for the locked, valid outbound claim');
  assert.ok(vaultWrite>providerRecheck,'Every post-claim gate must run before the client secret reaches Vault');

  assert.match(created,/select\s+provider\.\*\s+into\s+v_provider[\s\S]*?from\s+marketplace\.payment_provider_configs[\s\S]*?for\s+share/i);
  assert.match(
    created,
    /select\s+version\.\*\s+into\s+v_version[\s\S]*?version\.id\s*=\s*v_attempt\.credential_version_id[\s\S]*?version\.provider_key\s*=\s*'paymob'[\s\S]*?for\s+share/i,
    'The post-call result must remain pinned to the exact claimed credential version'
  );
  assert.match(created,/select\s+tenant\.\*\s+into\s+v_tenant[\s\S]*?tenant\.id\s*=\s*v_attempt\.tenant_id[\s\S]*?for\s+share/i);
  assert.match(
    created,
    /select\s+rollout\.\*\s+into\s+v_rollout[\s\S]*?rollout\.tenant_id\s*=\s*v_attempt\.tenant_id[\s\S]*?rollout\.environment\s*=\s*v_attempt\.environment[\s\S]*?for\s+share/i
  );
  assert.match(created,/v_tenant\.slug\s*=\s*'reef-skills'[\s\S]*?v_tenant\.tenant_key\s*=\s*'tenant-reef-skills'/i);
  assert.match(created,/v_provider\.environment\s*<>\s*v_attempt\.environment[\s\S]*?v_provider\.credentials_environment\s*<>\s*v_attempt\.environment/i);
  assert.match(created,/v_provider\.rollout_mode\s*<>\s*v_attempt\.environment/i);
  assert.match(created,/v_provider\.last_verified_at\s+is\s+null/i);
  assert.match(created,/v_provider\.checkout_mode\s*<>\s*'redirect'/i);
  assert.match(created,/v_provider\.supported_currencies\s*<>\s*array\[\s*'SAR'\s*\]::text\[\]/i);
  assert.match(created,/v_provider\.public_config\s*->>\s*'region'\s*<>\s*'ksa'/i);
  assert.match(created,/private_app\.v3_payment_provider_bundle_complete\s*\(/i);
  assert.match(created,/v_version\.status\s*<>\s*'active'[\s\S]*?v_version\.revoked_at\s+is\s+not\s+null/i);
  assert.match(created,/v_version\.integration_id[\s\S]*?v_provider\.public_config\s*->>\s*'integrationId'/i);
  assert.match(created,/v_version\.owner_id[\s\S]*?v_provider\.public_config\s*->>\s*'merchantAccountId'/i);
  for(const secretKey of ['hmacSecret','apiKey','secretKey','publicKey']){
    assert.match(created,new RegExp(`secret_ref\\.secret_key\\s*=\\s*'${secretKey}'`,'i'));
  }
  assert.match(created,/v_bound_secret_count\s*<>\s*4/i);
  assert.match(created,/cardinality\s*\(\s*private_app\.paymob_missing_checks\([\s\S]*?v_attempt\.environment[\s\S]*?\)\s*<>\s*0/i);
  assert.match(created,/v_rollout\.id\s+is\s+null\s+or\s+v_rollout\.status\s*<>\s*'enabled'/i);
  assert.match(created,/not\s+private_app\.paymob_tenant_checkout_eligible_v1\(\s*v_attempt\.tenant_id\s*,\s*v_attempt\.environment\s*\)/i);
  for(const gateCode of [
    'reef_skills_gate_closed_after_claim','provider_gate_closed_after_claim',
    'credential_gate_closed_after_claim','readiness_gate_closed_after_claim',
    'tenant_rollout_closed_after_claim','checkout_gate_closed_after_claim'
  ])assert.match(created,new RegExp(`'${gateCode}'`));

  const closed=section(
    created,
    'if v_gate_error_code is not null then',
    'select vault.create_secret('
  );
  assert.match(closed,/update\s+marketplace\.payment_attempts\s+set\s+status\s*=\s*'unknown'/i);
  assert.match(closed,/checkout_secret_id\s*=\s*null[\s\S]*?checkout_secret_expires_at\s*=\s*null/i);
  assert.match(closed,/claim_token\s*=\s*null[\s\S]*?claim_expires_at\s*=\s*null/i);
  assert.match(closed,/insert\s+into\s+marketplace\.reconciliations[\s\S]*?'intention_unknown'\s*,\s*'queued'/i);
  assert.match(closed,/where\s+marketplace\.reconciliations\.status\s+in\s*\(\s*'queued'\s*,\s*'unknown'\s*,\s*'failed'\s*\)/i);
  assert.match(closed,/paymob_outbox_enqueue\([\s\S]*?'reconciliation_review'[\s\S]*?'inquiryMode'\s*,\s*'merchant_order_id'[\s\S]*?'merchantOrderId'\s*,\s*v_attempt\.id::text/i);
  assert.match(closed,/'clientSecretStoredInVault'\s*,\s*false[\s\S]*?'resumeAllowed'\s*,\s*false/i);
  assert.match(closed,/'attemptStatus'\s*,\s*'unknown'[\s\S]*?'resumeAllowed'\s*,\s*false/i);
  assert.doesNotMatch(closed,/vault\.create_secret|checkout_secret_id\s*=\s*v_secret_id|'attemptStatus'\s*,\s*'intention_created'|'resumeAllowed'\s*,\s*true|'checkoutUrl'\s*,|'clientSecret'\s*,/i);
});

test('paid and refund paths share deterministic tenant-addon entitlement locks',()=>{
  const paths=[
    ['paid',sqlFunction('private_app.paymob_apply_paid_attempt_v1')],
    ['refund',sqlFunction('private_app.paymob_apply_verified_full_refund_v1')]
  ];
  const keyPattern=/'paymob:entitlement:'\s*\|\|\s*v_attempt\.tenant_id::text\s*\|\|\s*':'\s*\|\|\s*v_entitlement_lock_product_id::text/i;

  for(const [label,sql] of paths){
    const orderLock=sql.search(/'paymob:order:'\s*\|\|/i);
    const entitlementLock=sql.search(keyPattern);
    const sensitiveRowLock=sql.search(
      /from\s+(?:catalog\.tenant_addon_subscriptions|marketplace\.entitlement_sources)\b[\s\S]{0,500}?for\s+update/i
    );
    assert.ok(orderLock!==-1,`${label} path is missing the shared order lock`);
    assert.ok(entitlementLock>orderLock,`${label} must acquire order before entitlement locks`);
    assert.ok(
      sensitiveRowLock>entitlementLock,
      `${label} must acquire every entitlement advisory before source/subscription FOR UPDATE`
    );
    assert.match(
      sql,
      /for\s+v_entitlement_lock_product_id\s+in\s+select\s+distinct\s+snapshot\.addon_product_id[\s\S]{0,500}?order\s+by\s+snapshot\.addon_product_id[\s\S]{0,120}?loop/i
    );
    assert.match(sql,keyPattern);
  }
});

test('addon snapshots use exact catalog modes and settlement uses child-row CAS without parent-lock inversion',()=>{
  const items=sqlTable('marketplace.payment_attempt_items');
  const prepare=sqlFunction('public.v1_tenant_paymob_prepare_checkout');
  const settle=sqlFunction('private_app.paymob_apply_paid_attempt_v1');
  const refund=sqlFunction('private_app.paymob_apply_verified_full_refund_v1');

  assert.match(items,/activation_mode_snapshot\s+in\s*\(\s*'entitlement'\s*,\s*'module'\s*\)/i);
  assert.doesNotMatch(items,/activation_mode_snapshot\s+in\s*\([^)]*'feature'/i);
  assert.match(
    prepare,
    /'activationMode'\s*,\s*addon\.activation_mode[\s\S]*?left\s+join\s+catalog\.addon_products\s+addon\s+on\s+addon\.id\s*=\s*item\.addon_product_id/i,
    'The immutable activation mode must come from the locked catalog product'
  );
  assert.doesNotMatch(
    migration,
    /tenant_addon_subscriptions_entitlement_write_lock_v1|tenant_addon_entitlement_write_lock_v1/i,
    'A generic child-row trigger would invert parent/advisory lock order'
  );

  for(const [label,sql] of [['paid',settle],['refund',refund]]){
    assert.doesNotMatch(sql,/for\s+update\s+of\s+(?:product|module)/i,`${label} must not create parent/child lock-order inversion`);
  }

  assert.match(settle,/select\s+subscription\.\*\s+into\s+v_previous_subscription[\s\S]*?for\s+update/i);
  assert.match(settle,/select\s+tenant_module\.\*\s+into\s+v_previous_module[\s\S]*?for\s+update/i);

  assert.match(
    settle,
    /insert\s+into\s+catalog\.tenant_addon_subscriptions\s+as\s+current_subscription[\s\S]*?on\s+conflict\s*\(\s*tenant_id\s*,\s*product_id\s*\)[\s\S]*?do\s+update[\s\S]*?where\s+v_previous_subscription\.id\s+is\s+not\s+null[\s\S]*?current_subscription\.id\s*=\s*v_previous_subscription\.id[\s\S]*?to_jsonb\(current_subscription\)\s+is\s+not\s+distinct\s+from\s+to_jsonb\(v_previous_subscription\)[\s\S]*?returning\s+\*\s+into\s+v_subscription/i,
    'Absent-prior conflicts must not overwrite, and present-prior writes require an exact snapshot CAS'
  );
  assert.match(
    settle,
    /if\s+v_subscription\.id\s+is\s+null\s+then[\s\S]*?set\s+state\s*=\s*'review_required'[\s\S]*?v_fulfillment_review_required\s*:=\s*true[\s\S]*?'payment_quarantined:subscription_cas:'[\s\S]*?continue/i
  );
  assert.match(
    settle,
    /if\s+v_previous_module\.module_id\s+is\s+null\s+then[\s\S]*?insert\s+into\s+core\.tenant_modules[\s\S]*?on\s+conflict\s*\(\s*tenant_id\s*,\s*module_id\s*\)\s+do\s+nothing[\s\S]*?returning\s+\*\s+into\s+v_granted_module/i,
    'A concurrently-created module must turn an absent-prior grant into review, not overwrite it'
  );
  assert.match(
    settle,
    /else\s+update\s+core\.tenant_modules\s+as\s+current_module[\s\S]*?to_jsonb\(current_module\)\s+is\s+not\s+distinct\s+from\s+to_jsonb\(v_previous_module\)[\s\S]*?returning\s+\*\s+into\s+v_granted_module/i,
    'A present-prior module grant must use a full-row snapshot CAS'
  );
  assert.match(
    settle,
    /if\s+v_granted_module\.module_id\s+is\s+null\s+then[\s\S]*?set\s+state\s*=\s*'review_required'[\s\S]*?v_fulfillment_review_required\s*:=\s*true[\s\S]*?'payment_quarantined:module_cas:'[\s\S]*?continue/i
  );
  assert.match(refund,/select\s+subscription\.\*\s+into\s+v_subscription[\s\S]*?for\s+update/i);
  assert.match(refund,/select\s+tenant_module\.\*\s+into\s+v_current_module[\s\S]*?for\s+update/i);
  assert.match(refund,/v_subscription\.status\s+is\s+distinct\s+from\s+v_source\.granted_status/i);
  assert.match(refund,/v_current_module\.configuration\s+is\s+distinct\s+from\s+v_source\.granted_module_configuration/i);
});

test('verified POST ingest binds credential, account, attempt, order, owner and money',()=>{
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  for(const binding of [
    'p_environment','p_credential_version_id','p_provider_transaction_id',
    'p_provider_order_id','p_special_reference','p_integration_id','p_owner',
    'p_amount_minor','p_currency'
  ])assert.match(ingest,new RegExp(`\\b${binding}\\b`,'i'),`Missing ${binding}`);

  assert.match(ingest,/not\s+coalesce\(p_hmac_verified\s*,\s*false\)[\s\S]*?paymob_hmac_invalid/i);
  assert.match(ingest,/version\.id\s*=\s*p_credential_version_id[\s\S]*?version\.environment\s*=\s*p_environment/i);
  assert.match(ingest,/version\.status\s*=\s*'active'[\s\S]*?version\.status\s*=\s*'retiring'[\s\S]*?valid_until\s*>\s*now\(\)/i);
  assert.match(ingest,/attempt\.provider_order_id\s*=\s*v_provider_order_id/i);
  assert.match(ingest,/btrim\(p_special_reference\)\s*=\s*v_attempt\.id::text/i);
  assert.doesNotMatch(ingest,/attempt\.id\s*=\s*(?:p_special_reference|p_attempt_id)/i);
  for(const quarantineCode of [
    'special_reference_mismatch','attempt_credential_binding_missing',
    'integration_binding_mismatch','owner_binding_mismatch',
    'order_binding_mismatch','amount_currency_mismatch'
  ])assert.match(ingest,new RegExp(`'${quarantineCode}'`));

  const unbound=section(
    ingest,
    'if v_attempt.id is null then',
    'select version.* into v_attempt_version'
  );
  assert.match(unbound,/insert\s+into\s+marketplace\.webhook_deliveries/i);
  assert.match(unbound,/\)\s*values\s*\(\s*null\s*,\s*null\s*,\s*null\s*,/i);
  assert.match(unbound,/private_app\.paymob_outbox_enqueue\(\s*null\s*,\s*null\s*,\s*null/i);
  assert.match(unbound,/'outcome'\s*,\s*'quarantined'/i);
  assert.match(unbound,/'rawStored'\s*,\s*false/i);
});

test('only an exact final standalone charge can settle payment',()=>{
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const finalPaid=/v_is_final_paid\s*:=([\s\S]*?);/i.exec(ingest);
  assert.ok(finalPaid,'Missing final-paid predicate');
  const predicate=finalPaid[1];

  assert.match(predicate,/coalesce\(p_success\s*,\s*false\)/i);
  for(const falseFlag of [
    'p_pending','p_error_occured','p_is_auth','p_is_capture',
    'p_has_parent_transaction','p_is_voided','p_is_refunded'
  ])assert.match(
    predicate,
    new RegExp(`and\\s+not\\s+coalesce\\(${falseFlag}\\s*,\\s*false\\)`,'i'),
    `${falseFlag} must be false for final paid`
  );
  assert.match(predicate,/and\s+coalesce\(p_is_standalone_payment\s*,\s*false\)/i);
  assert.match(ingest,/p_is_refunded[\s\S]*?v_outcome\s*:=\s*'refund_review'[\s\S]*?v_is_final_paid\s*:=/i);
  assert.match(ingest,/v_is_final_paid[\s\S]*?v_outcome\s*:=\s*'paid'/i);
  assert.equal(
    (ingest.match(/private_app\.paymob_apply_paid_attempt_v1\s*\(/g)||[]).length,
    1,
    'Verified ingest has one settlement boundary'
  );
});

test('settlement evidence is a verified callback or authenticated provider inquiry, never redirect state',()=>{
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const reconcile=sqlFunction('public.v1_service_paymob_reconciliation_apply');
  const status=sqlFunction('public.v1_tenant_paymob_checkout_status');

  assert.match(ingest,/not\s+coalesce\(p_hmac_verified\s*,\s*false\)[\s\S]*?paymob_hmac_invalid/i);
  assert.match(ingest,/paymob_apply_paid_attempt_v1\(\s*v_attempt\.id\s*,\s*v_transaction_id[\s\S]*?'webhook'/i);
  assert.match(reconcile,/auth\.jwt\(\)\s*->>\s*'role'[\s\S]*?'service_role'/i);
  assert.match(reconcile,/v_final_paid[\s\S]*?paymob_apply_paid_attempt_v1\(\s*v_attempt\.id\s*,\s*v_transaction_id\s*,\s*p_response_sha256\s*,\s*'inquiry'/i);
  assert.match(reconcile,/v_job\.status\s*<>\s*'running'[\s\S]*?v_job\.lease_token\s+is\s+distinct\s+from\s+p_lease_token/i);
  assert.doesNotMatch(status,/update\s+marketplace\.(?:orders|payment_attempts)|paymob_apply_paid_attempt_v1/i);
});

test('delivery, settlement, entitlement and outbox writes are replay-safe',()=>{
  const deliveries=sqlTable('marketplace.webhook_deliveries');
  const attempts=sqlTable('marketplace.payment_attempts');
  const entitlements=sqlTable('marketplace.entitlement_sources');
  const outbox=sqlTable('marketplace.payment_outbox');
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const settle=sqlFunction('private_app.paymob_apply_paid_attempt_v1');

  assert.match(deliveries,/credential_version_id\s+uuid\s+not\s+null/i);
  assert.match(deliveries,/unique\s*\(\s*provider_key\s*,\s*environment\s*,\s*provider_transaction_id\s*,\s*signed_state_sha256\s*,\s*special_reference_valid\s*\)/i);
  assert.match(ingest,/v_existing_delivery\.id\s+is\s+not\s+null/i);
  assert.match(ingest,/paymob_receipt_reused/i);
  assert.match(ingest,/'duplicate'\s*,\s*true/i);
  assert.match(ingest,/second_paid_transaction_review_required/i);
  assert.match(settle,/if\s+v_attempt\.status\s*=\s*'paid'/i);
  assert.match(settle,/paymob_transaction_reused/i);
  assert.match(settle,/'duplicate'\s*,\s*true/i);
  assert.match(settle,/on\s+conflict\s*\(provider_key\s*,\s*provider_event_id\)\s+do\s+nothing/i);
  assert.match(attempts,/unique\s*\(provider_key\s*,\s*environment\s*,\s*tenant_id\s*,\s*idempotency_key\)/i);
  assert.match(entitlements,/unique\s*\(order_item_id\)/i);
  assert.match(outbox,/unique\s*\(dedupe_key\)/i);
});

test('a failed transaction can be followed by a distinct paid transaction on one Intention',()=>{
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const failed=section(
    ingest,
    "elsif v_outcome = 'failed' then",
    'else\n    v_result := private_app.paymob_apply_paid_attempt_v1'
  );

  assert.match(failed,/when\s+expires_at\s*>\s*now\(\)\s+then\s*'pending'/i);
  assert.match(failed,/payment_attempt_failed_retry_available/i);
  assert.doesNotMatch(failed,/provider_transaction_id\s*=\s*v_transaction_id/i);
  assert.match(ingest,/provider_transaction_id\s*=\s*v_transaction_id[\s\S]*?signed_state_sha256/i);
  assert.match(ingest,/second_paid_transaction_review_required/i);
  assert.match(ingest,/paymob_apply_paid_attempt_v1\(\s*v_attempt\.id\s*,\s*v_transaction_id/i);
});

test('late paid or full-refund evidence for an old attempt cannot displace a newer active sibling',()=>{
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const reconcile=sqlFunction('public.v1_service_paymob_reconciliation_apply');
  const resume=sqlFunction('public.v1_service_paymob_resume_checkout');
  const attempts=sqlTable('marketplace.payment_attempts');

  assert.match(
    attempts,
    /status\s+in\s*\([\s\S]*?'prepared'[\s\S]*?'creating_intention'[\s\S]*?'intention_created'[\s\S]*?'pending'[\s\S]*?'unknown'[\s\S]*?'quarantined'[\s\S]*?\)/i
  );
  assert.match(
    ingest,
    /v_attempt\.status\s*=\s*'failed'\s+and\s+v_outcome\s*<>\s*'failed'[\s\S]*?v_quarantine_code\s*:=\s*'terminal_state_conflict'/i
  );
  assert.match(
    ingest,
    /if\s+v_outcome\s*=\s*'quarantined'[\s\S]*?set\s+status\s*=\s*case[\s\S]*?when\s+status\s+in\s*\(\s*'paid'\s*,\s*'refunded'\s*,\s*'failed'\s*,\s*'cancelled'\s*\)\s+then\s+status/i,
    'A late webhook must leave the old failed attempt outside the active-order unique index'
  );
  assert.match(
    ingest,
    /if\s+v_outcome\s*=\s*'quarantined'[\s\S]*?insert\s+into\s+marketplace\.reconciliations[\s\S]*?'review_required'/i
  );

  const errorCase=section(
    reconcile,
    'v_error_code := case',
    'if v_error_code is not null then'
  );
  assert.match(errorCase,/v_final_paid\s+or\s+p_cumulative_refunded_minor\s*=\s*v_attempt\.amount_minor/i);
  assert.match(errorCase,/from\s+marketplace\.payment_attempts\s+active_sibling/i);
  assert.match(errorCase,/active_sibling\.order_id\s*=\s*v_attempt\.order_id/i);
  assert.match(errorCase,/active_sibling\.id\s*<>\s*v_attempt\.id/i);
  assert.match(errorCase,/active_sibling\.status\s+in\s*\([\s\S]*?'quarantined'[\s\S]*?\)/i);
  assert.match(errorCase,/then\s*'active_sibling_payment_conflict'/i);

  const reviewBranch=section(
    reconcile,
    'if v_error_code is not null then',
    'update marketplace.payment_attempts\n  set provider_order_id'
  );
  assert.match(reviewBranch,/set\s+status\s*=\s*'quarantined'[\s\S]*?and\s+not\s+exists\s*\([\s\S]*?active_sibling/i);
  assert.match(reviewBranch,/update\s+marketplace\.reconciliations\s+set\s+status\s*=\s*'review_required'/i);
  assert.match(reviewBranch,/'outcome'\s*,\s*'review_required'/i);
  assert.doesNotMatch(reviewBranch,/paymob_apply_paid_attempt_v1|paymob_apply_verified_full_refund_v1/i);

  const hold=resume.indexOf('private_app.paymob_order_review_hold_v1(v_attempt.order_id)');
  const secretRead=resume.indexOf('vault.decrypted_secrets');
  assert.ok(hold!==-1&&secretRead>hold,'Resume must check the order review hold before decrypting a checkout secret');
  assert.match(resume.slice(hold,secretRead),/'resumeAllowed'\s*,\s*false/i);
});

test('abandoned pre-provider attempts expire safely while ambiguous provider calls reconcile',()=>{
  const prepare=sqlFunction('public.v1_tenant_paymob_prepare_checkout');
  const record=sqlFunction('public.v1_service_paymob_record_intention');
  const attempts=sqlTable('marketplace.payment_attempts');

  assert.match(prepare,/attempt\.status\s*=\s*'prepared'[\s\S]*?attempt\.expires_at\s*<=\s*v_now/i);
  assert.match(prepare,/attempt\.claim_token\s+is\s+null/i);
  assert.match(prepare,/attempt\.provider_intention_id\s+is\s+null[\s\S]*?provider_order_id\s+is\s+null[\s\S]*?provider_transaction_id\s+is\s+null/i);
  assert.match(prepare,/status\s*=\s*'failed'[\s\S]*?checkout_expired_before_provider_call/i);
  assert.match(record,/p_outcome\s+not\s+in\s*\(\s*'created'\s*,\s*'failed'\s*,\s*'unknown'\s*\)/i);
  assert.match(record,/insert\s+into\s+marketplace\.reconciliations/i);
  assert.match(record,/'intention_unknown'/i);
  assert.match(migration,/payment_attempts_active_order_idx[\s\S]*?where\s+status\s+in\s*\(\s*'prepared'[\s\S]*?'quarantined'\s*\)/i);
});

test('bounded reconciliation maintenance resolves abandoned provider-null attempts under the canonical order lock',()=>{
  const claim=sqlFunction('public.v1_service_paymob_reconciliation_claim');
  const lifecycle=section(
    claim,
    'for v_lifecycle_candidate in',
    '-- Do not acquire a second order lock in a lifecycle-maintenance transaction.'
  );
  const candidateQuery=section(lifecycle,'for v_lifecycle_candidate in','loop');

  assert.match(candidateQuery,/attempt\.provider_key\s*=\s*'paymob'/i);
  assert.match(
    candidateQuery,
    /attempt\.status\s*=\s*'prepared'[\s\S]*?attempt\.expires_at\s*<=\s*now\(\)[\s\S]*?attempt\.claim_token\s+is\s+null/i
  );
  assert.match(
    candidateQuery,
    /attempt\.status\s*=\s*'creating_intention'[\s\S]*?attempt\.claim_expires_at\s*<=\s*now\(\)[\s\S]*?or\s+attempt\.expires_at\s*<=\s*now\(\)/i
  );
  assert.ok(
    (candidateQuery.match(/attempt\.provider_(?:intention|order|transaction)_id\s+is\s+null/gi)||[]).length>=6,
    'Both provider-null lifecycle branches must bind all provider identifiers'
  );
  assert.ok(
    (candidateQuery.match(/attempt\.checkout_secret_id\s+is\s+null/gi)||[]).length>=2,
    'Provider-null maintenance must not race a resumable checkout secret'
  );
  assert.match(
    candidateQuery,
    /order\s+by\s+attempt\.order_id\s*,\s*attempt\.expires_at\s*,\s*attempt\.id[\s\S]*?limit\s+1/i,
    'Lifecycle maintenance must use a deterministic bounded candidate batch'
  );

  const orderLock=lifecycle.search(
    /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*'paymob:order:'\s*\|\|\s*v_lifecycle_candidate\.order_id::text/i
  );
  const reselect=lifecycle.indexOf('select attempt.* into v_expired_attempt');
  const rowLock=lifecycle.indexOf('for update;',reselect);
  assert.ok(orderLock!==-1,'Lifecycle maintenance must acquire the canonical order lock');
  assert.ok(reselect>orderLock&&rowLock>reselect,'The candidate must be revalidated FOR UPDATE only after the order lock');
  assert.doesNotMatch(
    lifecycle.slice(0,orderLock),
    /\b(?:update|delete\s+from|insert\s+into)\b/i,
    'Candidate discovery must not mutate before the canonical order lock'
  );

  const prepared=section(
    lifecycle,
    "if v_expired_attempt.status = 'prepared' then",
    "if v_expired_attempt.status = 'creating_intention' then"
  );
  assert.match(prepared,/update\s+marketplace\.payment_attempts\s+set\s+status\s*=\s*'failed'/i);
  assert.match(prepared,/last_error_code\s*=\s*'checkout_expired_before_provider_call'/i);
  assert.match(prepared,/terminal_at\s*=\s*now\(\)/i);
  assert.match(prepared,/claim_token\s*=\s*null[\s\S]*?claim_expires_at\s*=\s*null/i);
  assert.match(prepared,/paymob_outbox_enqueue\([\s\S]*?'payment_failed'[\s\S]*?'providerCallStarted'\s*,\s*false/i);

  const creatingStart=lifecycle.indexOf("if v_expired_attempt.status = 'creating_intention' then");
  const creatingEnd=lifecycle.indexOf('\n    end if;',creatingStart);
  assert.ok(creatingStart!==-1&&creatingEnd>creatingStart,'Missing abandoned create-claim branch');
  const creating=lifecycle.slice(creatingStart,creatingEnd);
  assert.match(creating,/update\s+marketplace\.payment_attempts\s+set\s+status\s*=\s*'unknown'/i);
  assert.match(creating,/last_error_code\s*=\s*'intention_claim_expired'/i);
  assert.match(creating,/claim_token\s*=\s*null[\s\S]*?claim_expires_at\s*=\s*null/i);
  assert.match(
    creating,
    /insert\s+into\s+marketplace\.reconciliations[\s\S]*?'intention_unknown'\s*,\s*'queued'\s*,\s*null[\s\S]*?'order_reference_inquiry_required'/i
  );
  assert.match(creating,/where\s+marketplace\.reconciliations\.status\s+in\s*\(\s*'queued'\s*,\s*'unknown'\s*,\s*'failed'\s*\)/i);
  assert.match(
    creating,
    /paymob_outbox_enqueue\([\s\S]*?'reconciliation_review'[\s\S]*?'inquiryMode'\s*,\s*'merchant_order_id'[\s\S]*?'merchantOrderId'\s*,\s*v_expired_attempt\.id::text/i
  );
  assert.doesNotMatch(creating,/payment_retry|retryAllowed|providerCallStarted/i);
});

test('service settlement stops at paid while addon grants are source-ledgered exactly once',()=>{
  const settle=sqlFunction('private_app.paymob_apply_paid_attempt_v1');
  const entitlements=sqlTable('marketplace.entitlement_sources');
  const addonStart=settle.indexOf("if v_order.order_kind = 'addon' and not v_suppress_fulfillment then");
  const addonEnd=settle.indexOf('update marketplace.payment_attempts',addonStart);
  assert.notEqual(addonStart,-1,'Missing addon-only settlement branch');
  assert.notEqual(addonEnd,-1,'Missing end of addon fulfillment branch');
  const beforeAddon=settle.slice(0,addonStart);
  const addonBranch=settle.slice(addonStart,addonEnd);

  assert.match(beforeAddon,/status\s*=\s*case\s+when\s+order_kind\s*=\s*'addon'\s+then\s*'completed'\s+else\s*'paid'\s+end/i);
  assert.match(beforeAddon,/when\s+order_kind\s*=\s*'addon'\s+then\s*'pending'\s+else\s*'not_applicable'/i);
  assert.match(settle,/Service payment stops here/i);
  assert.match(addonBranch,/snapshot\.item_type\s*=\s*'addon'/i);
  assert.match(addonBranch,/insert\s+into\s+marketplace\.entitlement_sources/i);
  assert.match(addonBranch,/on\s+conflict\s*\(order_item_id\)\s+do\s+nothing/i);
  assert.match(addonBranch,/insert\s+into\s+catalog\.tenant_addon_subscriptions/i);
  assert.match(addonBranch,/insert\s+into\s+catalog\.tenant_addon_subscription_events/i);
  assert.match(entitlements,/previous_status[\s\S]*?previous_period_start[\s\S]*?previous_period_end/i);
  assert.doesNotMatch(settle,/service_assignments|service_deliveries|assigned_provider_id/i);
});

test('manual paid and cancel transitions cannot bypass verified Paymob resolution',()=>{
  const guard=sqlFunction('private_app.paymob_order_payment_guard_v1');
  assert.match(guard,/current_setting\s*\(\s*'odeir\.paymob_verified_order_id'/i);
  assert.match(guard,/paymob_verified_receipt_required/i);
  assert.match(guard,/new\.status\s*=\s*'cancelled'/i);
  assert.match(guard,/marketplace\.payment_attempts/i);
  assert.match(guard,/prepared[\s\S]*?creating_intention[\s\S]*?intention_created[\s\S]*?pending[\s\S]*?unknown[\s\S]*?quarantined[\s\S]*?paid/i);
  assert.match(guard,/paymob_order_cancel_requires_payment_resolution/i);
  assert.match(
    migration,
    /create\s+trigger\s+marketplace_orders_paymob_payment_guard_v1[\s\S]*?before\s+insert\s+or\s+update\s+on\s+marketplace\.orders/i
  );
});

test('refund callbacks are review-only; only exact authoritative inquiry reverses sources',()=>{
  const ingest=sqlFunction('public.v1_service_paymob_ingest_verified_transaction');
  const callbackRefund=section(
    ingest,
    "elsif v_outcome = 'refund_review' then",
    "elsif v_outcome = 'pending' then"
  );
  const applyRefund=sqlFunction('private_app.paymob_apply_verified_full_refund_v1');
  const reconcile=sqlFunction('public.v1_service_paymob_reconciliation_apply');
  const refunds=sqlTable('marketplace.refunds');

  assert.match(ingest,/p_is_refunded[\s\S]*?v_outcome\s*:=\s*'refund_review'/i);
  assert.match(callbackRefund,/status\s*,[\s\S]*?'review_required'/i);
  assert.match(callbackRefund,/'refund_inquiry'[\s\S]*?'queued'/i);
  assert.match(callbackRefund,/'refund_amount_requires_inquiry'/i);
  assert.match(callbackRefund,/'callbackAmountIsOriginalCharge'\s*,\s*true/i);
  assert.doesNotMatch(callbackRefund,/paymob_apply_verified_full_refund_v1|verified_refunded_minor|observed_cumulative_refunded_minor/i);

  assert.match(applyRefund,/reconciliation_type\s*=\s*'refund_inquiry'/i);
  assert.match(applyRefund,/reconciliation\.status\s*=\s*'matched'/i);
  assert.match(applyRefund,/reconciliation\.evidence_sha256\s*=\s*p_evidence_sha256/i);
  assert.match(applyRefund,/observed_cumulative_refunded_minor\s*=\s*v_refund\.amount_minor/i);
  assert.match(applyRefund,/verified_refunded_minor\s+is\s+distinct\s+from\s+v_refund\.amount_minor/i);
  assert.match(applyRefund,/verified_currency\s+is\s+distinct\s+from\s+v_refund\.currency/i);
  assert.match(applyRefund,/v_refund\.amount_minor\s+is\s+distinct\s+from\s+v_attempt\.amount_minor/i);
  assert.match(applyRefund,/if\s+v_attempt\.order_kind_snapshot\s*=\s*'addon'\s+then/i);
  assert.match(applyRefund,/source\.attempt_id\s*=\s*v_attempt\.id[\s\S]*?source\.order_id\s*=\s*v_attempt\.order_id/i);
  assert.match(applyRefund,/entitlement_sources\s+newer[\s\S]*?newer\.state\s+in\s*\(\s*'active'\s*,\s*'review_required'\s*\)/i);
  assert.match(applyRefund,/state\s*=\s*'review_required'/i);
  assert.match(applyRefund,/where\s+id\s*=\s*v_source\.id/i);
  assert.doesNotMatch(applyRefund,/delete\s+from/i);
  assert.match(
    applyRefund,
    /if\s+coalesce\(v_source\.previous_module_present\s*,\s*false\)\s+then[\s\S]*?else[\s\S]*?update\s+core\.tenant_modules\s+set\s+enabled\s*=\s*false\s*,\s*configuration\s*=\s*'\{\}'::jsonb\s*,\s*enabled_at\s*=\s*null[\s\S]*?where\s+tenant_id\s*=\s*v_source\.tenant_id[\s\S]*?and\s+module_id\s*=\s*v_module_id/i
  );

  assert.match(reconcile,/p_cumulative_refunded_minor\s*=\s*v_attempt\.amount_minor\s+then[\s\S]*?paymob_apply_verified_full_refund_v1/i);
  assert.match(reconcile,/partial_refund_review_required/i);
  assert.match(refunds,/requested_by_subject_id[\s\S]*?approved_by_subject_id/i);
  assert.match(refunds,/approved_by_subject_id\s*<>\s*requested_by_subject_id/i);
  assert.match(refunds,/dispatch_claim_token[\s\S]*?dispatch_claim_expires_at/i);
  assert.doesNotMatch(
    migration,
    /create\s+or\s+replace\s+function\s+(?:public|private_app)\.[\w]*paymob[\w]*(?:initiate_refund|refund_initiat)/i,
    'Provider refund initiation is intentionally outside v1'
  );
});

test('refund inquiry fails closed on mutable binding drift and closes every superseded open sibling',()=>{
  const reconcile=sqlFunction('public.v1_service_paymob_reconciliation_apply');
  const applyRefund=sqlFunction('private_app.paymob_apply_verified_full_refund_v1');
  const applyCall=reconcile.indexOf('private_app.paymob_apply_verified_full_refund_v1(');
  assert.notEqual(applyCall,-1,'Missing authoritative refund apply boundary');
  const beforeApply=reconcile.slice(0,applyCall);

  for(const binding of [
    /v_refund\.tenant_id\s+is\s+distinct\s+from\s+v_attempt\.tenant_id/i,
    /v_refund\.order_id\s+is\s+distinct\s+from\s+v_attempt\.order_id/i,
    /v_refund\.environment\s+is\s+distinct\s+from\s+v_attempt\.environment/i,
    /v_refund\.provider_transaction_id\s+is\s+distinct\s+from\s+v_transaction_id/i,
    /v_refund\.amount_minor\s+is\s+distinct\s+from\s+v_attempt\.amount_minor/i,
    /v_refund\.currency\s+is\s+distinct\s+from\s+v_attempt\.currency/i
  ])assert.match(beforeApply,binding);
  assert.match(beforeApply,/refund_[a-z0-9_]*binding_[a-z0-9_]*(?:drift|mismatch)/i);
  assert.match(beforeApply,/update\s+marketplace\.refunds\s+set\s+status\s*=\s*'review_required'/i);
  assert.match(beforeApply,/update\s+marketplace\.reconciliations\s+set\s+status\s*=\s*'review_required'/i);
  assert.match(beforeApply,/private_app\.paymob_outbox_enqueue\([\s\S]*?'refund_review'/i);
  assert.match(beforeApply,/'outcome'\s*,\s*'review_required'/i);

  const closeSiblings=/update\s+marketplace\.refunds\s+sibling_refund\s+set[\s\S]*?status\s*=\s*'rejected'[\s\S]*?resolution_code\s*=\s*'[^']*supersed[^']*'[\s\S]*?resolved_at\s*=\s*now\(\)[\s\S]*?where[\s\S]*?sibling_refund\.attempt_id\s*=\s*v_attempt\.id[\s\S]*?sibling_refund\.id\s*<>\s*v_refund\.id[\s\S]*?sibling_refund\.status\s+in\s*\([\s\S]*?'requested'[\s\S]*?'review_required'[\s\S]*?'processing'[\s\S]*?'unknown'[\s\S]*?'succeeded'[\s\S]*?\)/i;
  assert.match(applyRefund,closeSiblings);
});

test('full refund reverses an applied subscription after module CAS loss without touching an ungranted module',()=>{
  const settle=sqlFunction('private_app.paymob_apply_paid_attempt_v1');
  const applyRefund=sqlFunction('private_app.paymob_apply_verified_full_refund_v1');
  const appliedAt=settle.indexOf('applied_at = clock_timestamp()');
  const moduleFailureStart=settle.indexOf('if v_granted_module.module_id is null then');
  const moduleFailureEnd=settle.indexOf('update marketplace.entitlement_sources\n        set granted_module_enabled',moduleFailureStart);
  assert.ok(appliedAt!==-1&&moduleFailureStart>appliedAt&&moduleFailureEnd>moduleFailureStart);
  const moduleFailure=settle.slice(moduleFailureStart,moduleFailureEnd);
  assert.match(moduleFailure,/set\s+state\s*=\s*'review_required'/i);
  assert.match(moduleFailure,/'payment_quarantined:module_cas:'/i);
  assert.doesNotMatch(moduleFailure,/applied_at\s*=\s*null|subscription_id\s*=\s*null/i);

  assert.match(
    applyRefund,
    /source\.state\s+in\s*\(\s*'active'\s*,\s*'review_required'\s*\)/i,
    'Authoritative refund must revisit the module-CAS review source whose subscription was applied'
  );
  assert.match(
    applyRefund,
    /v_module_grant_applied\s*:=\s*coalesce\([\s\S]*?activation_mode_snapshot\s*=\s*'module'[\s\S]*?v_source\.module_id\s+is\s+not\s+null[\s\S]*?v_source\.granted_module_enabled\s+is\s+not\s+null[\s\S]*?v_source\.granted_module_configuration\s+is\s+not\s+null[\s\S]*?v_source\.granted_module_enabled_at\s+is\s+not\s+null/i
  );
  const unapplied=section(
    applyRefund,
    'if v_source.applied_at is null then',
    '-- A module CAS may lose after the subscription grant was applied.'
  );
  assert.match(unapplied,/set\s+state\s*=\s*'review_required'[\s\S]*?reversal_refund_id\s*=\s*v_refund\.id[\s\S]*?continue/i);
  assert.doesNotMatch(unapplied,/update\s+catalog\.tenant_addon_subscriptions|(?:insert|update|delete)\s+(?:into\s+)?core\.tenant_modules/i);

  const moduleLost=section(
    applyRefund,
    "if v_snapshot.activation_mode_snapshot = 'module'\n         and not v_module_grant_applied then",
    'if v_subscription.id is null'
  );
  assert.match(moduleLost,/v_review_required\s*:=\s*true/i);
  assert.doesNotMatch(moduleLost,/\bcontinue\b|core\.tenant_modules/i);
  assert.match(applyRefund,/update\s+catalog\.tenant_addon_subscriptions[\s\S]*?update\s+marketplace\.entitlement_sources\s+set\s+state\s*=\s*'reversed'/i);
  assert.match(
    applyRefund,
    /if\s+v_snapshot\.activation_mode_snapshot\s*=\s*'module'\s+and\s+v_module_grant_applied\s+then[\s\S]*?(?:update|insert\s+into)\s+core\.tenant_modules/i,
    'Module restore/recompute must be unreachable when the paid module grant never won its CAS'
  );
  assert.match(applyRefund,/set\s+status\s*=\s*case\s+when\s+v_review_required\s+then\s*'applied_with_review'/i);
  assert.match(applyRefund,/'reviewRequired'\s*,\s*v_review_required/i);
});

test('refund precedence follows committed entitlement application order, not transaction start time',()=>{
  const settle=sqlFunction('private_app.paymob_apply_paid_attempt_v1');
  const applyRefund=sqlFunction('private_app.paymob_apply_verified_full_refund_v1');
  const entitlements=sqlTable('marketplace.entitlement_sources');

  assert.match(entitlements,/\bapplied_at\s+timestamptz\b/i);
  assert.match(
    settle,
    /update\s+marketplace\.entitlement_sources[\s\S]*?applied_at\s*=\s*clock_timestamp\(\)/i
  );
  assert.match(applyRefund,/newer\.applied_at\s+is\s+not\s+null/i);
  assert.match(applyRefund,/v_source\.applied_at\s+is\s+not\s+null/i);
  assert.match(
    applyRefund,
    /\(\s*newer\.applied_at\s*,\s*newer\.id\s*\)\s*>\s*\(\s*v_source\.applied_at\s*,\s*v_source\.id\s*\)/i
  );
  assert.doesNotMatch(
    applyRefund,
    /newer\.created_at\s*>\s*v_source\.created_at/i,
    'A later-applied concurrent entitlement must win even if its transaction began first'
  );
});

test('activation and tenant rollout require evidence plus independent maker/checker approval',()=>{
  const required=sqlFunction('private_app.paymob_required_checks');
  const evidence=sqlFunction('private_app.paymob_readiness_evidence_write');
  const activation=sqlFunction('public.v1_platform_paymob_activation_gate');
  const tenantRollout=sqlFunction('public.v1_platform_paymob_tenant_rollout_action');

  for(const sandboxCheck of ['credentials','intention_create','webhook_hmac']){
    assert.match(required,new RegExp(`'${sandboxCheck}'`));
  }
  for(const liveCheck of [
    'paid_transaction','duplicate_delivery','failed_transaction',
    'transaction_inquiry','credential_rotation_callback','refund_inquiry',
    'refund_initiation','live_credentials'
  ])assert.match(required,new RegExp(`'${liveCheck}'`));
  assert.match(evidence,/rollout_mode\s*=\s*case\s+when\s+not\s+coalesce\(p_passed\s*,\s*false\)/i);
  assert.match(evidence,/then\s*'observe_only'/i);
  assert.match(evidence,/activated_by_subject_id\s*=\s*case[\s\S]*?then\s+null/i);

  assert.match(activation,/REQUEST PAYMOB/i);
  assert.match(activation,/APPROVE PAYMOB/i);
  assert.match(activation,/activation_requested_by_subject_id\s*=\s*v_actor/i);
  assert.match(activation,/activation_requested_by_subject_id\s*=\s*v_actor[\s\S]*?paymob_activation_checker_required/i);
  assert.match(activation,/activation_requested_at\s*<\s*now\(\)\s*-\s*interval\s*'24 hours'/i);
  assert.match(activation,/private_app\.paymob_missing_checks/i);
  assert.match(activation,/v_provider\.environment\s*<>\s*p_target_mode/i);
  assert.match(activation,/v_provider\.credentials_environment\s*<>\s*p_target_mode/i);
  assert.match(activation,/checkout_mode\s*<>\s*'redirect'/i);
  assert.match(activation,/supported_currencies\s*<>\s*array\['SAR'\]/i);
  assert.match(activation,/status\s*=\s*case\s+when\s+p_target_mode\s*=\s*'live'\s+then\s*'active'/i);
  assert.match(activation,/'active'\s*,\s*v_provider\.status\s*=\s*'active'\s+and\s+v_provider\.rollout_mode\s*=\s*'live'/i);

  assert.match(tenantRollout,/REQUEST PAYMOB TENANT/i);
  assert.match(tenantRollout,/APPROVE PAYMOB TENANT/i);
  assert.match(tenantRollout,/requested_by_subject_id\s*=\s*v_actor[\s\S]*?paymob_rollout_checker_required/i);
  assert.match(tenantRollout,/requested_at\s*<\s*now\(\)\s*-\s*interval\s*'24 hours'/i);
  assert.match(tenantRollout,/paymob_global_rollout_not_ready/i);
  assert.match(tenantRollout,/paymob_reef_skills_rollout_prohibited/i);

  const prepare=sqlFunction('public.v1_tenant_paymob_prepare_checkout');
  assert.match(prepare,/marketplace\.payment_tenant_rollouts[\s\S]*?rollout\.status\s*=\s*'enabled'/i);
  assert.match(prepare,/paymob_tenant_not_enabled/i);
});

test('canonical addon and service storefronts expose Paymob only behind the exact tenant gate',()=>{
  const eligible=sqlFunction('private_app.paymob_tenant_checkout_eligible_v1');
  const addonSnapshot=sqlFunction('public.v2_tenant_marketplace_snapshot');
  const addonAction=sqlFunction('public.v2_tenant_marketplace_action');
  const serviceAction=sqlFunction('public.v2_tenant_service_marketplace_action');

  assert.match(eligible,/tenant\.slug\s*(?:<>|is\s+distinct\s+from)\s*'reef-skills'/i);
  assert.match(eligible,/tenant\.tenant_key\s*(?:<>|is\s+distinct\s+from)\s*'tenant-reef-skills'/i);
  assert.match(eligible,/provider\.environment\s*=\s*p_environment/i);
  assert.match(eligible,/provider\.credentials_environment\s*=\s*p_environment/i);
  assert.match(eligible,/provider\.rollout_mode\s*=\s*p_environment/i);
  assert.match(eligible,/p_environment\s*=\s*'sandbox'[\s\S]*?provider\.status\s*=\s*'configured'/i);
  assert.match(eligible,/p_environment\s*=\s*'live'[\s\S]*?provider\.status\s*=\s*'active'/i);
  assert.match(eligible,/provider\.checkout_mode\s*=\s*'redirect'/i);
  assert.match(eligible,/provider\.supported_currencies\s*=\s*array\['SAR'\]::text\[\]/i);
  assert.match(eligible,/provider\.public_config\s*->>\s*'region'\s*=\s*'ksa'/i);
  assert.match(eligible,/version\.status\s*=\s*'active'/i);
  assert.match(eligible,/version\.integration_id\s*=\s*provider\.public_config\s*->>\s*'integrationId'/i);
  assert.match(eligible,/version\.owner_id\s*=\s*provider\.public_config\s*->>\s*'merchantAccountId'/i);
  assert.match(eligible,/rollout\.status\s*=\s*'enabled'/i);
  assert.match(eligible,/cardinality\s*\(\s*private_app\.paymob_missing_checks\([\s\S]*?\)\s*\)\s*=\s*0/i);

  assert.match(addonSnapshot,/entry\.value\s*->>\s*'key'\s*<>\s*'paymob'/i);
  assert.match(addonSnapshot,/'key'\s*,\s*'paymob'/i);
  assert.match(addonSnapshot,/private_app\.paymob_tenant_checkout_eligible_v1\(\s*v_tenant\.id\s*,\s*provider\.environment/i);

  assert.match(addonAction,/p_action\s*=\s*'create_order'[\s\S]*?paymentProvider'[\s\S]*?=\s*'paymob'/i);
  assert.match(addonAction,/not\s+private_app\.paymob_tenant_checkout_eligible_v1\(/i);
  assert.match(addonAction,/paymob_tenant_rollout_required/i);
  assert.match(serviceAction,/p_action\s*=\s*'create_service_order'[\s\S]*?paymentProvider'[\s\S]*?=\s*'paymob'/i);
  assert.match(serviceAction,/not\s+private_app\.paymob_tenant_checkout_eligible_v1\(/i);
  assert.match(serviceAction,/paymob_tenant_rollout_required/i);
  assert.match(addonAction,/return\s+public\.v2_tenant_service_marketplace_action\(/i);
  assert.match(serviceMarketplaceMigration,/create\s+or\s+replace\s+function\s+public\.v2_tenant_service_marketplace_snapshot[\s\S]*?v_base\s*:=\s*public\.v2_tenant_marketplace_snapshot\(p_slug\)/i);
});

test('readiness rejects stale, unsigned or credential-unbound evidence and reports live fail-closed',()=>{
  const evidencePassed=sqlFunction('private_app.paymob_evidence_passed');
  const evidenceWrite=sqlFunction('private_app.paymob_readiness_evidence_write');
  const snapshot=sqlFunction('public.v1_platform_paymob_readiness_snapshot');

  assert.match(evidencePassed,/marketplace\.paymob_readiness_evidence_history\s+evidence/i);
  assert.match(evidencePassed,/evidence\.passed/i);
  assert.match(evidencePassed,/evidence\.evidence_sha256\s*~\s*'\^\[a-f0-9\]\{64\}\$'/i);
  assert.match(evidencePassed,/version\.status\s*=\s*'active'/i);
  assert.match(evidencePassed,/evidence\.credential_version_id\s*=\s*v_active_id/i);
  assert.match(evidencePassed,/evidence\.checked_at\s*>=\s*version\.valid_from/i);
  assert.match(evidencePassed,/evidence\.checked_at\s*>=\s*now\(\)\s*-\s*case\s+when\s+p_check_key\s*=\s*'live_credentials'\s+then\s+interval\s*'24 hours'\s+else\s+interval\s*'30 days'\s+end/i);
  assert.match(evidencePassed,/evidence\.checked_at\s*>=\s*now\(\)\s*-\s*interval\s*'30 days'/i);
  assert.match(evidencePassed,/candidate\.status\s*<>\s*'revoked'/i);
  assert.match(evidencePassed,/provider\.sandbox_canary_version_id/i);
  assert.match(evidencePassed,/candidate\.id\s*=\s*v_sandbox_canary_version_id/i);
  assert.match(evidencePassed,/evidence\.credential_version_id\s*=\s*v_cohort_id/i);
  assert.match(evidenceWrite,/paymob_readiness_evidence_digest_required/i);
  assert.match(evidenceWrite,/paymob_readiness_evidence_source_required/i);
  assert.match(evidenceWrite,/paymob_readiness_evidence_source_invalid/i);
  assert.match(evidenceWrite,/version\.status\s*<>\s*'revoked'/i);
  assert.match(evidenceWrite,/insert\s+into\s+marketplace\.paymob_readiness_evidence_history/i);
  assert.match(evidenceWrite,/'credentialVersionId'\s*,\s*v_version_id/i);

  assert.match(snapshot,/'liveReady'\s*,\s*v_configured[\s\S]*?environment\s*=\s*'live'[\s\S]*?cardinality\(v_live_missing\)\s*=\s*0/i);
  assert.match(snapshot,/'liveGateBlocked'\s*,\s*not\s*\(/i);
  assert.match(snapshot,/'active'\s*,\s*v_provider\.status\s*=\s*'active'\s+and\s+v_provider\.rollout_mode\s*=\s*'live'/i);
  assert.match(snapshot,/'refundVerified'[\s\S]*?'refund_inquiry'[\s\S]*?'refund_initiation'/i);
  assert.match(snapshot,/'credentialRotationVerified'[\s\S]*?'credential_rotation_callback'/i);
  assert.match(snapshot,/'queryLogRedactionVerified'[\s\S]*?'edge_query_redaction_waf'/i);
  assert.match(snapshot,/'pendingActivationMode'\s*,\s*v_provider\.activation_requested_mode/i);
  assert.match(snapshot,/'tenantRollouts'[\s\S]*?marketplace\.payment_tenant_rollouts/i);
  assert.match(snapshot,/tenant\.slug\s*(?:<>|is\s+distinct\s+from)\s*'reef-skills'[\s\S]*?tenant\.tenant_key\s*(?:<>|is\s+distinct\s+from)\s*'tenant-reef-skills'/i);
  assert.match(snapshot,/'operationalEvidenceRequests'[\s\S]*?marketplace\.paymob_operational_evidence_requests/i);
});

test('per-attempt checkout client secrets expire and are deleted by a bounded service job',()=>{
  const record=sqlFunction('public.v1_service_paymob_record_intention');
  const settle=sqlFunction('private_app.paymob_apply_paid_attempt_v1');
  const cleanup=sqlFunction('public.v1_service_paymob_cleanup_checkout_secrets');

  assert.match(record,/vault\.create_secret\([\s\S]*?paymob_checkout_client_/i);
  assert.match(record,/p_provider_expires_at\s*<=\s*now\(\)\s*\+\s*interval\s*'30 seconds'/i);
  assert.match(record,/p_provider_expires_at\s*>\s*v_attempt\.expires_at\s*-\s*interval\s*'30 seconds'/i);
  assert.match(record,/provider_expires_at\s*=\s*p_provider_expires_at/i);
  assert.match(record,/checkout_secret_expires_at\s*=\s*p_provider_expires_at/i);
  assert.match(settle,/checkout_secret_expires_at\s*=\s*case[\s\S]*?least\(/i);
  assert.match(cleanup,/auth\.jwt\(\)\s*->>\s*'role'[\s\S]*?'service_role'/i);
  assert.match(cleanup,/p_limit\s+not\s+between\s+1\s+and\s+100/i);
  assert.match(cleanup,/checkout_secret_expires_at\s*<=\s*now\(\)[\s\S]*?status\s+in\s*\(\s*'paid'\s*,\s*'failed'\s*,\s*'refunded'\s*,\s*'cancelled'\s*\)/i);
  assert.match(cleanup,/for\s+update\s+skip\s+locked/i);
  assert.match(cleanup,/marketplace\.payment_provider_secret_refs[\s\S]*?marketplace\.paymob_credential_versions/i);
  assert.match(cleanup,/paymob_cleanup_provider_secret_rejected/i);
  assert.match(cleanup,/set\s+checkout_secret_id\s*=\s*null\s*,\s*checkout_secret_expires_at\s*=\s*null/i);
  assert.match(cleanup,/delete\s+from\s+vault\.secrets/i);
  assert.match(cleanup,/'secretReturned'\s*,\s*false/i);
});

test('tenant checkout status is billing-admin scoped and exposes only coarse customer state',()=>{
  const status=sqlFunction('public.v1_tenant_paymob_checkout_status');

  assert.match(
    status,
    /private_app\.has_tenant_permission\(\s*v_tenant\.id\s*,\s*'tenant\.settings\.manage'\s*\)/i
  );
  assert.doesNotMatch(status,/tenant\.workspace\.read/i);
  for(const privateField of [
    'providerTransactionId','reconciliationStatus','lastErrorCode','expiresAt'
  ]){
    assert.doesNotMatch(status,new RegExp(`'${privateField}'\\s*,`,'i'));
  }
  assert.doesNotMatch(status,/v_attempt\.provider_transaction_id|v_attempt\.last_error_code|marketplace\.reconciliations/i);
  for(const safeField of [
    'attemptId','orderId','orderNumber','orderKind','attemptStatus',
    'orderStatus','paymentStatus','terminal','refreshAfterMs'
  ])assert.match(status,new RegExp(`'${safeField}'\\s*,`,'i'));
});

test('billing-contact digests use a separate internal per-version Vault key outside the four vendor credentials',()=>{
  const versions=sqlTable('marketplace.paymob_credential_versions');
  const digest=sqlFunction('private_app.paymob_billing_contact_digest_v1');
  const finalize=sqlFunction('private_app.paymob_finalize_credential_version_v1');
  const runtime=sqlFunction('public.v1_service_paymob_runtime_config');
  const admin=sqlFunction('public.v3_platform_payment_provider_admin_snapshot');

  assert.match(versions,/billing_digest_vault_secret_id\s+uuid\s+not\s+null/i);
  assert.match(digest,/decrypted\.id\s*=\s*version\.billing_digest_vault_secret_id/i);
  assert.doesNotMatch(digest,/version\.hmac_vault_secret_id|hmacSecret/i);
  assert.match(
    finalize,
    /v_billing_digest_id\s*:=\s*vault\.create_secret\(\s*encode\(extensions\.gen_random_bytes\(32\)\s*,\s*'hex'\)[\s\S]*?'paymob_billing_digest_'/i
  );
  assert.match(finalize,/billing_digest_vault_secret_id[\s\S]*?v_billing_digest_id/i);
  assert.match(finalize,/'secretReturned'\s*,\s*false/i);
  assert.doesNotMatch(finalize,/payment_provider_secret_refs[\s\S]{0,500}?billing_digest/i);
  assert.doesNotMatch(runtime,/billing_digest_vault_secret_id|'billingDigest'/i);
  assert.doesNotMatch(admin,/billing_digest_vault_secret_id|'billingDigest'/i);
  assert.match(
    migration,
    /array\[\s*'secretKey'\s*,\s*'publicKey'\s*,\s*'hmacSecret'\s*,\s*'apiKey'\s*\]::text\[\]/i
  );
  assert.doesNotMatch(migration,/required_secret_keys\s*=\s*array\[[^\]]*billing/i);
});

test('payment persistence stores hashes and bindings, never raw body or card data',()=>{
  const persisted=[
    sqlTable('marketplace.payment_attempts'),
    sqlTable('marketplace.paymob_readiness_evidence_history'),
    sqlTable('marketplace.paymob_operational_evidence_requests'),
    sqlTable('marketplace.payment_attempt_items'),
    sqlTable('marketplace.webhook_deliveries'),
    sqlTable('marketplace.entitlement_sources'),
    sqlTable('marketplace.refunds'),
    sqlTable('marketplace.reconciliations'),
    sqlTable('marketplace.payment_outbox')
  ].join('\n');

  assert.match(persisted,/billing_contact_sha256/i);
  assert.match(persisted,/payload_sha256/i);
  assert.match(persisted,/signed_state_sha256/i);
  assert.doesNotMatch(
    persisted,
    /\braw_(?:body|payload)\b|\bpan\b|\bcvv\b|card_?number|billing_data|first_?name|last_?name|phone_?number|\bemail\b/i
  );
});
