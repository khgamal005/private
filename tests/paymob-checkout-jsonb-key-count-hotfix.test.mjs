import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const migration=readFileSync(new URL(
  '../supabase/migrations/20260903123703_paymob_checkout_jsonb_key_count_hotfix_v1.sql',
  import.meta.url
),'utf8');

test('Paymob checkout replaces the unsupported JSONB object length call',()=>{
  assert.match(migration,/v1_tenant_paymob_prepare_checkout\(text,uuid,text,jsonb\)/i);
  assert.match(migration,/pg_get_functiondef\(v_signature\)/i);
  assert.match(migration,/jsonb_object_length\(coalesce\(p_billing_contact/i);
  assert.match(migration,/select\s+pg_catalog\.count\(\*\)[\s\S]*?pg_catalog\.jsonb_object_keys/i);
  assert.match(migration,/v_occurrences\s*<>\s*1/i);
  assert.match(migration,/execute\s+v_definition/i);
  assert.match(migration,/patch_verification_failed/i);
});

test('hotfix preserves the empty-search-path function instead of adding a shim',()=>{
  assert.doesNotMatch(migration,/create\s+(?:or\s+replace\s+)?function\s+pg_catalog\.jsonb_object_length/i);
  assert.doesNotMatch(migration,/alter\s+function[\s\S]*?set\s+search_path/i);
});
