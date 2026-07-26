import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const migrationsUrl=new URL('../supabase/migrations/',import.meta.url);
const sqlFiles=(await readdir(migrationsUrl))
  .filter(file=>file.endsWith('.sql'))
  .sort();
const foundation='20260726210000_clean_platform_foundation_v2.sql';
const policies='20260726211500_add_v2_read_isolation_policies.sql';
const provisioning='20260726211556_tenant_provisioning_cycle_v2.sql';
const invitationIndexes='20260726211801_index_tenant_invitation_subjects.sql';

assert.deepEqual(
  sqlFiles,
  [foundation,policies,provisioning,invitationIndexes],
  'the v2 branch must contain only the clean foundation and reviewed forward migrations'
);

const sql=await readFile(new URL(foundation,migrationsUrl),'utf8');
const policySql=await readFile(new URL(policies,migrationsUrl),'utf8');
const provisioningSql=await readFile(new URL(provisioning,migrationsUrl),'utf8');
const invitationIndexSql=await readFile(new URL(invitationIndexes,migrationsUrl),'utf8');
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
assert.match(provisioningSql,/create table access_control\.tenant_invitations/);
assert.match(provisioningSql,/v2_platform_provision_tenant/);
assert.match(provisioningSql,/v2_tenant_invite_user/);
assert.match(provisioningSql,/v2_accept_tenant_invitation/);
assert.match(provisioningSql,/tenant_invitations_isolated_read/);
assert.doesNotMatch(provisioningSql,/service_role|SUPABASE_SECRET/i);
assert.match(invitationIndexSql,/tenant_invitations_invited_by_subject_idx/);
assert.match(invitationIndexSql,/tenant_invitations_accepted_by_subject_idx/);

console.log('Verified the clean v2 database baseline and provisioning cycle.');
