import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function source(relativePath){
  const absolutePath=join(root,relativePath);
  assert.ok(existsSync(absolutePath),'Expected '+relativePath+' to exist');
  return readFileSync(absolutePath,'utf8');
}

const migration=source(
  'supabase/migrations/20260902195124_paymob_readiness_evidence_constraint_hotfix_v1.sql'
);
const route=source('app/api/platform/payment-provider-secret/route.js');

function escapeRegExp(value){
  return value.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&');
}

function sqlFunction(qualifiedName){
  const start=new RegExp(
    'create\\s+or\\s+replace\\s+function\\s+'
      +escapeRegExp(qualifiedName)+'\\s*\\(',
    'i'
  ).exec(migration);
  assert.ok(start,'Missing SQL function '+qualifiedName);
  const tail=migration.slice(start.index);
  const body=/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(tail);
  assert.ok(body,'Unterminated SQL function '+qualifiedName);
  return tail.slice(0,body.index+body[0].length);
}

test('hotfix is atomic and preserves the generic sensitive-key scanner',()=>{
  assert.equal((migration.match(/^begin\s*;/gim)||[]).length,1);
  assert.equal((migration.match(/^commit\s*;/gim)||[]).length,1);
  assert.doesNotMatch(
    migration,
    /create\s+or\s+replace\s+function\s+private_app\.jsonb_has_sensitive_key/i
  );
  assert.doesNotMatch(
    migration,
    /\bdrop\s+(?:table|schema)\b|\btruncate(?:\s+table)?\b|\bdelete\s+from\b/i
  );
});

test('Paymob evidence uses a closed schema for checks and metadata',()=>{
  const validator=sqlFunction(
    'private_app.paymob_readiness_evidence_safe_v1'
  );
  assert.match(validator,/\blanguage\s+sql\b/i);
  assert.match(validator,/\bimmutable\b/i);
  assert.match(validator,/set\s+search_path\s*=\s*''/i);

  for(const checkKey of [
    'credentials',
    'intention_create',
    'webhook_hmac',
    'paid_transaction',
    'duplicate_delivery',
    'failed_transaction',
    'transaction_inquiry',
    'credential_rotation_callback',
    'refund_inquiry',
    'refund_initiation',
    'live_credentials',
    'live_card_integration_callback',
    'edge_query_redaction_waf',
    'reconciler_schedule',
    'outbox_delivery'
  ])assert.match(validator,new RegExp("'"+checkKey+"'"));

  for(const field of [
    'passed',
    'environment',
    'checkedAt',
    'credentialVersionId',
    'evidenceSha256',
    'sourceType',
    'sourceId',
    'errorCode'
  ])assert.match(validator,new RegExp("'"+field+"'"));

  assert.match(validator,/jsonb_object_keys\s*\(\s*entry\.evidence\s*\)/i);
  assert.match(validator,/member\.field_name\s+not\s+in/i);
  assert.match(validator,/jsonb_typeof\(entry\.evidence\s*->\s*'passed'\)\s*<>\s*'boolean'/i);
  assert.match(validator,/entry\.evidence\s*->>\s*'environment'\s+not\s+in\s*\(\s*'sandbox'\s*,\s*'live'\s*\)/i);
  assert.match(validator,/\^\[a-f0-9\]\{64\}\$/i);
});

test('constraint scopes the exception to Paymob and validates existing rows',()=>{
  assert.match(
    migration,
    /drop\s+constraint\s+if\s+exists\s+payment_provider_readiness_object_check_v1/i
  );
  assert.match(
    migration,
    /when\s+provider_key\s*=\s*'paymob'[\s\S]*?paymob_readiness_evidence_safe_v1/i
  );
  assert.match(
    migration,
    /else\s+not\s+private_app\.jsonb_has_sensitive_key\(readiness_evidence\)/i
  );
  assert.match(
    migration,
    /validate\s+constraint\s+payment_provider_readiness_object_check_v1/i
  );
  assert.match(
    migration,
    /revoke\s+all\s+on\s+function\s+private_app\.paymob_readiness_evidence_safe_v1\(jsonb\)[\s\S]*?service_role/i
  );
});

test('generic credential-store failure no longer invents an environment cause',()=>{
  const message=/credential_store_rejected\s*:\s*'([^']+)'/.exec(route);
  assert.ok(message,'Missing credential_store_rejected translation');
  assert.match(message[1],/لم يُحفظ أي تغيير/);
  assert.doesNotMatch(message[1],/تغيير البيئة/);
});
