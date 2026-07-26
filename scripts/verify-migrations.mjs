import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const migrationsUrl=new URL('../supabase/migrations/',import.meta.url);
const sqlFiles=(await readdir(migrationsUrl))
  .filter(file=>file.endsWith('.sql'))
  .sort();
const foundation='20260726210000_clean_platform_foundation_v2.sql';
const policies='20260726211500_add_v2_read_isolation_policies.sql';

assert.deepEqual(sqlFiles,[foundation,policies],'the v2 branch must contain only the clean foundation');

const sql=await readFile(new URL(foundation,migrationsUrl),'utf8');
const policySql=await readFile(new URL(policies,migrationsUrl),'utf8');
assert.match(sql,/create schema if not exists core;/);
assert.match(sql,/create schema if not exists access_control;/);
assert.match(sql,/create schema if not exists catalog;/);
assert.match(sql,/enable row level security;/);
assert.match(sql,/v2_current_user_context/);
assert.match(sql,/v2_platform_control_snapshot/);
assert.doesNotMatch(sql,/operations\.|engagement\.|market_intelligence\./);
assert.doesNotMatch(sql,/\\ncreate or replace function/);
assert.match(policySql,/organizations_isolated_read/);
assert.match(policySql,/tenants_isolated_read/);
assert.match(policySql,/subjects_isolated_read/);
assert.match(policySql,/subscriptions_isolated_read/);
assert.match(policySql,/audit_events_isolated_read/);

console.log('Verified the clean v2 database baseline.');
