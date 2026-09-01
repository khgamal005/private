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

const checkoutRoute=source('app/api/payments/paymob/checkout/route.js');
const statusRoute=source('app/api/payments/paymob/status/route.js');
const returnRoute=source('app/api/payments/paymob/return/route.js');
const adminRoute=source('app/api/platform/payment-provider-secret/route.js');
const marketplaceV2Route=source('app/api/tenant/marketplace-v2/route.js');
const serviceMarketplaceRoute=source('app/api/tenant/service-marketplace/route.js');
const checkoutEdge=source('supabase/functions/paymob-checkout/index.ts');
const returnStatus=source('components/paymob-return-status.js');
const addonStore=source('components/marketplace-addon-store-v2.js');
const serviceStore=source('components/marketplace-store.js');
const platformPayments=source('components/platform-payments.js');
const migration=source(
  'supabase/migrations/20260901134621_paymob_intention_checkout_v1.sql'
);

const ATTEMPT_STATUSES=[
  'prepared',
  'creating_intention',
  'intention_created',
  'pending',
  'paid',
  'failed',
  'unknown',
  'quarantined',
  'refunded',
  'cancelled'
];

function declaredSet(text,name){
  const match=new RegExp(
    `${name}\\s*=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
    'i'
  ).exec(text);
  assert.ok(match,`Missing ${name}`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item=>item[1]);
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

function assertStreamBounded(text,label){
  assert.doesNotMatch(
    text,
    /request\.(?:json|text)\s*\(/i,
    `${label} must not trust Content-Length or allocate an unbounded body`
  );
  assert.match(text,/readTextLimited\s*\(\s*request\s*,/i);
  assert.match(text,/request\.body\.getReader\s*\(\s*\)/i);
  assert.match(text,/value\.byteLength|chunk\.byteLength/i);
  assert.match(text,/reader\.cancel\s*\(/i);
  assert.match(text,/payload_too_large|status\s*:\s*413/i);
}

test('client status enum is exactly the SQL attempt status contract',()=>{
  assert.deepEqual(declaredSet(statusRoute,'ATTEMPT_STATUSES'),ATTEMPT_STATUSES);
  assert.doesNotMatch(statusRoute,/'preparing'|'ready'/i);

  for(const status of ATTEMPT_STATUSES){
    assert.match(
      migration,
      new RegExp(`['"]${status}['"]`),
      `SQL attempt enum must include ${status}`
    );
  }
});

test('public Next payment routes cap streamed and chunked request bodies',()=>{
  assertStreamBounded(checkoutRoute,'Paymob checkout route');
  assertStreamBounded(statusRoute,'Paymob status route');
  assertStreamBounded(adminRoute,'Payment credential route');
});

test('marketplace mutation proxies are same-origin, bounded and redact upstream detail',()=>{
  for(const [label,route] of [
    ['add-on',marketplaceV2Route],
    ['service',serviceMarketplaceRoute]
  ]){
    assert.match(route,/sameOrigin\s*\(\s*request\s*\)/i,`${label}: same origin`);
    assert.match(route,/headers\.get\(\s*['"]origin['"]\s*\)/i,`${label}: origin`);
    assert.match(route,/headers\.get\(\s*['"]sec-fetch-site['"]\s*\)/i,`${label}: fetch metadata`);
    assert.match(route,/x-forwarded-host[\s\S]*?x-forwarded-proto/i,`${label}: forwarded pair`);
    assert.match(route,/status\s*:\s*403|cross_origin/i,`${label}: cross-origin rejection`);
    assert.match(route,/content-type[\s\S]*?application\/json/i,`${label}: JSON only`);
    assert.match(route,/status\s*:\s*415|unsupported_media_type/i,`${label}: media rejection`);
    assert.doesNotMatch(route,/request\.(?:json|text)\s*\(/i,`${label}: bounded request`);
    assert.match(route,/readTextLimited\(\s*request\s*,\s*MAX_REQUEST_BYTES\s*\)/i,`${label}: request cap`);
    assert.match(route,/readTextLimited\(\s*response\s*,\s*MAX_UPSTREAM_BYTES\s*\)/i,`${label}: upstream cap`);
    assert.match(route,/source\.body\.getReader\s*\(\s*\)/i,`${label}: streamed reader`);
    assert.match(route,/value\.byteLength/i,`${label}: byte accounting`);
    assert.match(route,/reader\.cancel\s*\(/i,`${label}: cancel overflow`);
    assert.match(route,/AbortSignal\.timeout\s*\(/i,`${label}: upstream timeout`);
    assert.match(route,/MAX_(?:UPSTREAM|RESPONSE)[_A-Z]*BYTES/i,`${label}: response cap`);
    assert.match(route,/Cache-Control['"]?\s*:\s*['"][^'"]*no-store/i,`${label}: no store`);
    assert.doesNotMatch(route,/\bresponse\.(?:text|json)\s*\(/,`${label}: bounded parse`);
    assert.doesNotMatch(route,/\bdetail\s*:|error\.message|data\?\.detail/i,`${label}: redacted errors`);
  }
  assert.match(addonStore,/fetch\(\s*['"]\/api\/tenant\/marketplace-v2['"]/i);
  assert.match(addonStore,/action\(\s*['"]create_order['"]/i);
  assert.match(addonStore,/paymentProvider/i);
  assert.match(serviceStore,/fetch\(\s*['"]\/api\/tenant\/service-marketplace['"]/i);
  assert.match(serviceStore,/p_action\s*:\s*['"]create_service_order['"]/i);
  assert.match(serviceStore,/paymentProvider/i);
});

test('return-page polling has a per-request timeout and a finite retry budget',()=>{
  assert.match(returnStatus,/MAX_AUTOMATIC_CHECKS\s*=\s*\d+/);
  assert.match(returnStatus,/POLL_REQUEST_TIMEOUT_MS\s*=\s*\d+|10_?000/);
  assert.match(returnStatus,/boundedFetchSignal\s*\(/);
  assert.match(returnStatus,/AbortSignal|AbortController/);
  assert.match(returnStatus,/controller\.abort\s*\(/);
  assert.match(returnStatus,/checks\s*>=\s*MAX_AUTOMATIC_CHECKS/);
});

test('provider return query is scrubbed through a read-only no-referrer redirect',()=>{
  assert.match(returnRoute,/export\s+function\s+GET\s*\(/i);
  assert.doesNotMatch(returnRoute,/export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b/i);
  assert.match(returnRoute,/searchParams\.getAll\(\s*'slug'\s*\)/i);
  assert.match(returnRoute,/searchParams\.getAll\(\s*'attempt'\s*\)/i);
  assert.match(returnRoute,/slugs\.length\s*!==\s*1\s*\|\|\s*attempts\.length\s*!==\s*1/i);
  assert.match(returnRoute,/status\s*:\s*303/i);
  assert.match(returnRoute,/Location\s*:\s*location/i);
  assert.match(returnRoute,/Cache-Control['"]?\s*:\s*['"]private, no-store/i);
  assert.match(returnRoute,/Referrer-Policy['"]?\s*:\s*['"]no-referrer/i);
  assert.match(returnRoute,/X-Content-Type-Options['"]?\s*:\s*['"]nosniff/i);
  assert.match(returnRoute,/Content-Security-Policy/i);
  assert.match(returnRoute,/const\s+location\s*=\s*['"]\/tenant\//i);
  assert.doesNotMatch(returnRoute,/fetch\s*\(|\.rpc\s*\(|supabase|console\.|payment_status|activation/i);
  assert.match(checkoutEdge,/new URL\(\s*["']\/api\/payments\/paymob\/return["']/i);
  assert.match(checkoutEdge,/searchParams\.set\(\s*["']slug["']/i);
  assert.match(checkoutEdge,/searchParams\.set\(\s*["']attempt["']/i);
});

test('a pending Paymob attempt cannot be cancelled through generic marketplace actions',()=>{
  for(const store of [addonStore,serviceStore]){
    assert.match(
      store,
      /order\.paymentProvider\s*!==\s*['"]paymob['"]/i,
      'Store must hide generic cancel after Paymob owns the payment attempt'
    );
  }

  const guard=sqlFunction('private_app.paymob_order_payment_guard_v1');
  assert.match(guard,/new\.status\s*=\s*['"]cancelled['"]|new\.status\s+in\s*\([^)]*['"]cancelled['"]/i);
  assert.match(guard,/marketplace\.payment_attempts/i);
  assert.match(guard,/raise\s+exception\s+['"]paymob[\w_]*cancel[\w_]*['"]/i);
});

test('platform operators cannot manually confirm a pending Paymob order',()=>{
  assert.match(
    platformPayments,
    /item\.paymentProvider\s*===\s*['"]paymob['"]\s*\?\s*<span[^>]*>مطابقة Paymob فقط<\/span>\s*:\s*<button[\s\S]{0,120}?setPaymentOrder\s*\(\s*item\s*\)/i
  );
  assert.match(platformPayments,/p_action\s*:\s*['"]confirm_payment['"]/i);
});
