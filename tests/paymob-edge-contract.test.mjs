import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
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

const FILES={
  shared:'supabase/functions/_shared/paymob.ts',
  checkout:'supabase/functions/paymob-checkout/index.ts',
  webhook:'supabase/functions/paymob-webhook/index.ts',
  config:'supabase/config.toml',
  checkoutRoute:'app/api/payments/paymob/checkout/route.js',
  statusRoute:'app/api/payments/paymob/status/route.js',
  returnStatus:'components/paymob-return-status.js'
};

const paymob=source(FILES.shared);
const checkout=source(FILES.checkout);
const webhook=source(FILES.webhook);
const config=source(FILES.config);
const checkoutRoute=source(FILES.checkoutRoute);
const statusRoute=source(FILES.statusRoute);
const returnStatus=source(FILES.returnStatus);
const edgeSurface=`${paymob}\n${checkout}\n${webhook}`;
const paymobRuntime=await import(pathToFileURL(join(root,FILES.shared)).href);

const EXPECTED_HMAC_FIELDS=[
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success'
];

function quotedValues(text){
  return [...text.matchAll(/['"]([^'"]+)['"]/g)].map(match=>match[1]);
}

function configBlock(name){
  const match=new RegExp(
    `^\\[functions\\.${name}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
    'im'
  ).exec(config);
  assert.ok(match,`Missing Supabase function config for ${name}`);
  return match[1];
}

function sectionBetween(text,startMarker,endMarker){
  const start=text.indexOf(startMarker);
  assert.notEqual(start,-1,`Missing ${startMarker}`);
  const end=text.indexOf(endMarker,start+startMarker.length);
  assert.notEqual(end,-1,`Missing ${endMarker}`);
  return text.slice(start,end);
}

test('Paymob transaction HMAC uses the exact documented 20-field order',()=>{
  const fieldList=/PAYMOB_TRANSACTION_HMAC_FIELDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/i.exec(paymob);
  assert.ok(fieldList,'Missing immutable Paymob transaction HMAC field list');
  assert.deepEqual(quotedValues(fieldList[1]),EXPECTED_HMAC_FIELDS);

  assert.match(paymob,/export\s+function\s+paymobTransactionHmacInput\b/i);
  assert.match(paymob,/PAYMOB_TRANSACTION_HMAC_FIELDS\.map\s*\(/i);
  assert.match(paymob,/field\.split\(\s*['"]\.['"]\s*\)/i);
  assert.match(paymob,/\.join\(\s*['"]{2}\s*\)/i);
  assert.match(paymob,/SHA-512/i);
});

test('official Paymob transaction sample produces the exact HMAC input and verifies cryptographically',async()=>{
  const transaction={
    amount_cents:100000,
    created_at:'2024-06-13T11:33:44.592345',
    currency:'EGP',
    error_occured:false,
    has_parent_transaction:false,
    id:192036465,
    integration_id:4097558,
    is_3d_secure:true,
    is_auth:false,
    is_capture:false,
    is_refunded:false,
    is_standalone_payment:true,
    is_voided:false,
    order:{id:217503754},
    owner:302852,
    pending:false,
    source_data:{pan:2346,sub_type:'MasterCard',type:'card'},
    success:true
  };
  const expectedInput='1000002024-06-13T11:33:44.592345EGPfalsefalse1920364654097558truefalsefalsefalsetruefalse217503754302852false2346MasterCardcardtrue';
  assert.equal(paymobRuntime.paymobTransactionHmacInput(transaction),expectedInput);

  const secret='fixture-only-paymob-hmac-secret';
  const expectedHmac=createHmac('sha512',secret).update(expectedInput).digest('hex');
  assert.equal(await paymobRuntime.hmacSha512Hex(secret,expectedInput),expectedHmac);
  assert.equal(
    await paymobRuntime.verifyPaymobTransactionHmac(transaction,expectedHmac,secret),
    true
  );
  assert.equal(
    await paymobRuntime.verifyPaymobTransactionHmac(
      {...transaction,amount_cents:100001},
      expectedHmac,
      secret
    ),
    false
  );
});

test('HMAC comparison is constant-time and never accepts a plain equality check',()=>{
  const verifier=/export\s+async\s+function\s+verifyPaymobTransactionHmac\b([\s\S]*?)(?=\nexport\s|$)/i.exec(paymob);
  assert.ok(verifier,'Missing Paymob HMAC verifier');
  assert.match(verifier[1],/(?:timingSafe|constantTime|crypto\.subtle\.verify)/i);
  assert.doesNotMatch(
    verifier[1],
    /(?:expected|calculated|computed)\w*\s*={2,3}\s*(?:received|provided|actual|signature|hmac)/i
  );
});

test('customer status route and return surface omit provider and reconciliation diagnostics',()=>{
  const response=sectionBetween(
    statusRoute,
    'return json({\n      attemptId:',
    '\n    });\n  }catch'
  );
  for(const privateField of [
    'providerTransactionId','reconciliationStatus','lastErrorCode','expiresAt'
  ]){
    assert.doesNotMatch(response,new RegExp(`\\b${privateField}\\b`,'i'));
    assert.doesNotMatch(returnStatus,new RegExp(`\\b${privateField}\\b`,'i'));
  }
  for(const safeField of [
    'attemptId','orderId','orderNumber','orderKind','attemptStatus',
    'orderStatus','paymentStatus','terminal','refreshAfterMs'
  ])assert.match(response,new RegExp(`\\b${safeField}\\s*(?::|,|$)`,'im'));
});

test('checkout activates only governed KSA QuickLink while Intention stays rollback-only and fail-closed',()=>{
  assert.match(paymob,/https:\/\/ksa\.paymob\.com\/v1\/intention\/?/i);
  assert.match(paymob,/https:\/\/ksa\.checkout\.paymob\.com\/?/i);
  assert.match(paymob,/https:\/\/ksa\.paymob\.com\/api\/auth\/tokens/i);
  assert.match(paymob,/https:\/\/ksa\.paymob\.com\/api\/ecommerce\/payment-links/i);
  assert.match(checkout,/PAYMOB_INTENTION_URL/);
  assert.match(checkout,/PAYMOB_CHECKOUT_URL/);
  assert.match(checkout,/PAYMOB_AUTH_URL/);
  assert.match(checkout,/PAYMOB_QUICKLINK_URL/);
  assert.match(checkout,/Authorization[\s\S]{0,120}?Token/i);
  assert.match(checkout,/authorization:\s*`Bearer \$\{authToken\}`/i);
  assert.match(checkout,/payment_methods/i);
  assert.match(checkout,/special_reference/i);
  assert.match(checkout,/reference_id/i);
  assert.match(checkout,/notification_url/i);
  assert.match(checkout,/redirection_url/i);

  assert.match(
    checkout,
    /LEGACY_INTENTION_PROVIDER_MUTATION_ENABLED\s*=\s*false/
  );
  const quicklinkBranch=checkout.indexOf(
    'if (runtime.checkoutFlow === "quicklink")'
  );
  const legacyGuard=checkout.indexOf(
    'if (!LEGACY_INTENTION_PROVIDER_MUTATION_ENABLED)'
  );
  const legacyRequest=checkout.indexOf(
    'const intentionRequest = {',
    legacyGuard
  );
  const legacyMutation=checkout.indexOf(
    'PAYMOB_INTENTION_URL,',
    legacyRequest
  );
  assert.ok(quicklinkBranch!==-1&&legacyGuard>quicklinkBranch);
  assert.ok(legacyRequest>legacyGuard);
  assert.ok(legacyMutation>legacyRequest);
  const guardedLegacySurface=checkout.slice(legacyGuard,legacyRequest);
  assert.match(guardedLegacySurface,/recordIntentionBestEffort/);
  assert.match(guardedLegacySurface,/"failed"/);
  assert.match(guardedLegacySurface,/"unsupported_checkout_flow"/);
  assert.match(guardedLegacySurface,/return jsonResponse\(503/);
  assert.doesNotMatch(
    guardedLegacySurface,
    /fetchTextWithTimeout|providerMutationStarted\s*=\s*true/
  );

  assert.doesNotMatch(
    edgeSurface,
    /\/ecommerce\/orders|\/acceptance\/payment_keys|acceptance\/iframes|iframe_id/i,
    'Legacy order/payment-key/iframe integration must not return'
  );
});

test('checkout binds the returned payment method before exposing Unified Checkout',()=>{
  assert.match(checkout,/Array\.isArray\(intention\.payment_methods\)/i);
  assert.match(checkout,/intention\.payment_methods\.length\s*!==\s*1/i);
  assert.match(
    checkout,
    /returnedIntegrationId\s*!==\s*String\(runtime\.integrationId\)/i
  );
  assert.match(checkout,/returnedMethodCurrency\s*!==\s*"SAR"/i);
  assert.match(
    checkout,
    /returnedMethod\.live\s*!==\s*\(runtime\.environment\s*===\s*"live"\)/i
  );
  assert.match(checkout,/returnedMethodType\s*!==\s*"online"/i);
  assert.match(
    checkout,
    /provider_binding_mismatch[\s\S]*?recordIntentionBestEffort[\s\S]*?"unknown"/i
  );
});

test('Paymob items and VAT come only from the immutable SQL-prepared snapshot',()=>{
  const browserInput=sectionBetween(
    checkout,
    'function normalizeCheckoutRequest',
    'function normalizePreparedCheckout'
  );
  const preparedItems=sectionBetween(
    checkout,
    'function normalizePreparedItems',
    'function normalizeRuntimeConfig'
  );

  assert.doesNotMatch(browserInput,/payload\.(?:items|amount|currency|payment_methods)/i);
  const requestKeys=/CHECKOUT_REQUEST_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/i.exec(checkout);
  const contactKeys=/BILLING_CONTACT_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/i.exec(checkout);
  assert.ok(requestKeys&&contactKeys,'Missing exact browser checkout allowlists');
  assert.deepEqual(
    quotedValues(requestKeys[1]),
    ['slug','orderId','idempotencyKey','paymentOption','billingContact']
  );
  assert.deepEqual(
    quotedValues(contactKeys[1]),
    ['firstName','lastName','email','phoneNumber']
  );
  assert.match(browserInput,/Object\.keys\(payload\)\.some[\s\S]*?!CHECKOUT_REQUEST_KEYS\.has/i);
  assert.match(browserInput,/Object\.keys\(payload\.billingContact\)\.some[\s\S]*?!BILLING_CONTACT_KEYS\.has/i);
  assert.match(checkout,/items\s*:\s*prepared\.items/i);
  assert.match(checkout,/items\s*:\s*normalizePreparedItems\(payload\.items\s*,\s*amountMinor\)/i);
  assert.match(checkout,/MAX_INTENTION_ITEMS\s*=\s*50/);
  assert.match(checkout,/MAX_ITEM_QUANTITY\s*=\s*1_?000/);
  assert.match(preparedItems,/allowedKeys\s*=\s*new Set\(\["name", "amount", "description", "quantity"\]\)/i);
  assert.match(preparedItems,/total\s*\+=\s*amount/);
  assert.doesNotMatch(
    preparedItems,
    /amount\s*\*\s*quantity|quantity\s*\*\s*amount/,
    'Paymob amount is already the complete line total, including when quantity > 1'
  );
  assert.match(preparedItems,/Number\.isSafeInteger\(total\)/);
  assert.match(preparedItems,/total\s*!==\s*expectedAmountMinor/);
  assert.match(preparedItems,/item_name[\s\S]*?160[\s\S]*?item_description[\s\S]*?160/i);
});

test('provider expiry is derived once from the immutable attempt deadline and persisted end-to-end',()=>{
  const expiryFlow=sectionBetween(
    checkout,
    'const providerRequestStartedAt = Date.now();',
    'const intentionRequest = {'
  );
  const expiryHelper=sectionBetween(
    checkout,
    'function providerExpirationSeconds',
    'function providerRequestId'
  );
  const record=sectionBetween(
    checkout,
    'async function recordIntention(',
    'async function resumeCheckout('
  );
  const resume=sectionBetween(
    checkout,
    'async function resumeCheckout(',
    'async function recordIntentionBestEffort('
  );

  assert.equal((expiryFlow.match(/Date\.now\(\)/g)||[]).length,1);
  assert.match(expiryFlow,/providerExpirationSeconds\(\s*prepared\.expiresAt\s*,\s*providerRequestStartedAt\s*,?\s*\)/i);
  assert.match(expiryFlow,/providerRequestStartedAt\s*\+\s*providerExpiration\s*\*\s*1_000/i);
  assert.doesNotMatch(checkout,/expiration\s*:\s*3_?600\b/i);
  assert.match(checkout,/expiration\s*:\s*providerExpiration/i);
  assert.match(checkout,/PROVIDER_EXPIRATION_SAFETY_MS\s*=\s*2\s*\*\s*60\s*\*\s*1_000/i);
  assert.match(checkout,/MIN_PROVIDER_EXPIRATION_SECONDS\s*=\s*60/i);
  assert.match(expiryHelper,/Date\.parse\(expiresAt\)\s*-\s*nowMs\s*-\s*PROVIDER_EXPIRATION_SAFETY_MS/i);
  assert.match(expiryHelper,/expiration\s*<\s*MIN_PROVIDER_EXPIRATION_SECONDS/i);

  assert.match(record,/providerExpiresAt\?:\s*string/i);
  assert.match(record,/p_provider_expires_at\s*:\s*details\.providerExpiresAt\s*\?\?\s*null/i);
  assert.match(checkout,/await\s+recordIntention\([\s\S]{0,400}?providerExpiresAt\s*,/i);
  assert.ok(
    (checkout.match(/expiresAt\s*:\s*providerExpiresAt/g)||[]).length>=2,
    'Created and resumed responses must expose the provider-bounded expiry'
  );

  const resumeKeys=/RESUME_RUNTIME_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/i.exec(checkout);
  assert.ok(resumeKeys,'Missing resume response allowlist');
  assert.ok(quotedValues(resumeKeys[1]).includes('providerExpiresAt'));
  assert.match(resume,/Date\.parse\(providerExpiresAt\)\s*<=\s*Date\.now\(\)/i);
  assert.match(resume,/Date\.parse\(providerExpiresAt\)\s*>\s*Date\.parse\(expiresAt\)\s*-\s*30_000/i);
});

test('checkout consumes the SQL record result and emits a URL only for the exact ready contract',()=>{
  const normalizer=sectionBetween(
    checkout,
    'function normalizeRecordedIntention',
    'async function postRpc'
  );
  const recordKeys=/RECORD_INTENTION_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/i.exec(checkout);
  assert.ok(recordKeys,'Missing strict record-intention result allowlist');
  assert.deepEqual(quotedValues(recordKeys[1]),[
    'schemaVersion','attemptId','attemptStatus','orderId','environment',
    'expiresAt','providerExpiresAt','resumeAllowed','lastErrorCode'
  ]);

  assert.match(checkout,/recordedIntention\s*=\s*await\s+recordIntention\(/i);
  assert.match(checkout,/normalizeRecordedIntention\(\s*recordedIntention\s*,\s*prepared\s*,\s*providerExpiresAt/i);
  assert.match(normalizer,/payload\.schemaVersion\s*!==\s*1/i);
  assert.match(normalizer,/Object\.keys\(payload\)\.some\([\s\S]{0,100}?!RECORD_INTENTION_KEYS\.has/i);
  assert.match(normalizer,/attemptId\s*!==\s*prepared\.attemptId/i);
  assert.match(normalizer,/orderId\s*!==\s*prepared\.orderId/i);
  assert.match(normalizer,/attemptStatus\s*===\s*['"]intention_created['"]\s*&&\s*payload\.resumeAllowed\s*===\s*true/i);
  assert.match(normalizer,/environment\s*!==\s*prepared\.environment/i);
  assert.match(normalizer,/Date\.parse\(expiresAt\)\s*!==\s*Date\.parse\(prepared\.expiresAt\)/i);
  assert.match(normalizer,/Date\.parse\(providerExpiresAt\)\s*!==\s*Date\.parse\(expectedProviderExpiresAt\)/i);
  assert.match(normalizer,/payload\.lastErrorCode\s*!==\s*undefined\s*&&\s*payload\.lastErrorCode\s*!==\s*null/i);
  assert.match(normalizer,/attemptStatus\s*!==\s*['"]unknown['"]\s*\|\|\s*payload\.resumeAllowed\s*!==\s*false/i);
  assert.match(normalizer,/checkoutReady\s*:\s*false/i);

  const recordedAt=checkout.indexOf('recordedIntention = await recordIntention(');
  const readyGate=checkout.indexOf('if (!recordOutcome.checkoutReady)',recordedAt);
  const createdResponse=checkout.indexOf('return jsonResponse(201',readyGate);
  const checkoutUrl=checkout.indexOf('checkoutUrl: buildCheckoutUrl(',createdResponse);
  assert.ok(recordedAt!==-1&&readyGate>recordedAt&&createdResponse>readyGate);
  assert.ok(checkoutUrl>createdResponse,'Checkout URL must be built only after SQL readiness');
  assert.match(
    checkout.slice(readyGate,createdResponse),
    /return\s+ambiguousResponse\(prepared\s*,\s*recordOutcome\.reason\)/i
  );
});

test('QuickLink API key is confined to the service checkout and never reaches the browser route',()=>{
  assert.match(checkout,/apiKeyConfigured\s*!==\s*true/i);
  assert.match(checkout,/checkoutFlow\s*===\s*['"]quicklink['"][\s\S]{0,500}?requiredText\(payload\.apiKey/i);
  assert.match(checkout,/body:\s*JSON\.stringify\(\{\s*api_key:\s*runtime\.apiKey\s*\}\)/i);
  assert.doesNotMatch(checkoutRoute,/\.(?:apiKey)\b|\bapi_key\b/i);
  assert.doesNotMatch(checkout,/console\.(?:log|debug|info|warn|error)\s*\(/i);
});

test('ambiguous provider mutations remain unknown and are never blindly retried',()=>{
  assert.match(checkout,/!\[408,\s*409,\s*425,\s*429\]\.includes\(providerResponse\.status\)/i);
  assert.match(checkout,/if\s*\(outcome\s*===\s*['"]unknown['"]\)\s*return ambiguousResponse/i);
  assert.match(checkout,/if\s*\(!recorded\)[\s\S]{0,160}?intention_persistence_unknown/i);
  assert.match(checkout,/retryAllowed\s*:\s*false/i);
  assert.match(checkout,/providerMutationStarted\s*\?\s*['"]unknown['"]\s*:\s*['"]failed['"]/i);
  assert.equal(
    (checkout.match(/fetchTextWithTimeout\(\s*PAYMOB_INTENTION_URL/g)||[]).length,
    1,
    'One checkout claim may issue at most one provider mutation'
  );
  assert.equal(
    (checkout.match(/fetchTextWithTimeout\(\s*PAYMOB_QUICKLINK_URL/g)||[]).length,
    1,
    'One checkout claim may issue at most one QuickLink mutation'
  );
  assert.doesNotMatch(checkout,/while\s*\(|for\s*\([^)]*(?:retry|attempt)/i);
});

test('signed transaction POST is the callback truth; redirect cannot settle',()=>{
  assert.match(webhook,/request\.method\s*!==\s*['"]POST['"]/i);
  assert.match(webhook,/payload\.type\s*!==\s*['"]TRANSACTION['"]/i);
  assert.match(webhook,/verifyPaymobTransactionHmac\s*\(/);
  assert.match(webhook,/normalizePaymobTransaction\s*\(/);
  assert.match(webhook,/v1_service_paymob_ingest_verified_transaction/i);

  assert.doesNotMatch(
    checkout,
    /v1_service_paymob_ingest_verified_transaction/i,
    'Checkout/redirect preparation must never activate an order'
  );
  assert.doesNotMatch(checkout,/tenant_addon_subscriptions|status\s*:\s*['"]paid['"]/i);
});

test('webhook environment comes from server config, never an unsigned query value',()=>{
  assert.doesNotMatch(checkout,/searchParams\.set\(\s*['"]environment['"]/i);
  assert.doesNotMatch(webhook,/searchParams\.(?:get|getAll)\(\s*['"]environment['"]/i);
  assert.match(
    webhook,
    /v1_service_paymob_runtime_config[\s\S]{0,120}?p_purpose\s*:\s*['"]verify_webhook['"]/i
  );
  assert.match(webhook,/p_environment\s*:\s*matchedCandidate\.environment/i);
});

test('HMAC rotation accepts exactly one bounded account-bound credential version',()=>{
  assert.match(webhook,/MAX_HMAC_CANDIDATES\s*=\s*2/);
  assert.match(webhook,/normalizePaymobTransaction[\s\S]*?getWebhookRuntime/i);
  assert.match(webhook,/Promise\.all\s*\([\s\S]*?hmacCandidates\.map/i);
  assert.match(webhook,/candidate\.integrationId\s*===\s*transaction\.integrationId/i);
  assert.match(webhook,/candidate\.applePayIntegrationId\s*===\s*transaction\.integrationId/i);
  assert.match(webhook,/candidate\.historicalIntegrationIds\.includes\(transaction\.integrationId\)/i);
  assert.match(webhook,/candidate\.owner\s*===\s*transaction\.owner/i);
  assert.match(webhook,/matches\.length\s*!==\s*1/);
  assert.match(webhook,/p_credential_version_id\s*:\s*matchedCandidate\.credentialVersionId/i);
  assert.match(webhook,/hmacCandidates\.length\s*>\s*MAX_HMAC_CANDIDATES/i);
  assert.match(webhook,/new Set\(hmacCandidates\.map/i);
  assert.match(webhook,/['"]providerKey['"]/i);
  assert.match(webhook,/result\.providerKey\s*!==\s*['"]paymob['"]/i);
  assert.match(checkout,/credentialVersionId/i);
});

test('webhook normalization and persistence bind every provider identity and money field',()=>{
  for(const binding of [
    'p_amount_minor',
    'p_currency',
    'p_integration_id',
    'p_provider_order_id',
    'p_owner',
    'p_provider_transaction_id',
    'p_special_reference'
  ]){
    assert.match(
      webhook,
      new RegExp(binding.replace('.','\\.'),'i'),
      `Webhook must bind ${binding}`
    );
  }

  assert.match(webhook,/verifyPaymobTransactionHmac[\s\S]*?normalizePaymobTransaction/i);
  assert.match(webhook,/normalizePaymobTransaction[\s\S]*?ingestVerifiedTransaction\s*\(/i);
  assert.match(webhook,/p_special_reference\s*:\s*transaction\.specialReference/i);
  assert.doesNotMatch(
    webhook,
    /UUID\.test\(\s*transaction\.specialReference\s*\)|!transaction\.specialReference[\s\S]{0,160}?return\s+jsonResponse/i,
    'A valid-HMAC unbound callback must reach the durable SQL quarantine ledger'
  );
});

test('edge handlers do not log or persist sensitive callback material',()=>{
  assert.doesNotMatch(edgeSurface,/console\.(?:log|debug|info|warn|error)\s*\(/i);
  assert.doesNotMatch(webhook,/JSON\.stringify\s*\(\s*(?:rawBody|payload|transaction)\b/i);
  assert.doesNotMatch(webhook,/(?:raw_body|raw_payload|card_number|pan_value|cvv)\s*:/i);
  assert.match(webhook,/readTextLimited\s*\(/);
  assert.match(webhook,/p_payload_sha256\s*:/i);
});

test('a signed is_refunded flag cannot masquerade as authoritative refund amount',()=>{
  assert.match(webhook,/p_is_refunded\s*:\s*transaction\.isRefunded/i);
  assert.doesNotMatch(webhook,/refunded_amount|refund_amount/i);
  assert.doesNotMatch(
    webhook,
    /v1_platform_paymob_refund_action|entitlement_sources|tenant_addon_subscriptions/i,
    'Callback handling may queue refund inquiry/review, but cannot reverse an entitlement'
  );
});

test('Supabase gateway authenticates checkout but leaves Paymob webhook public for native HMAC verification',()=>{
  assert.match(configBlock('paymob-checkout'),/verify_jwt\s*=\s*true/i);
  assert.match(configBlock('paymob-webhook'),/verify_jwt\s*=\s*false/i);
  const legacy=configBlock('marketplace-payment-webhook');
  assert.match(legacy,/verify_jwt\s*=\s*false/i);
  assert.match(legacy,/legacy[\s\S]*?never[\s\S]*?native Paymob/i);
});
