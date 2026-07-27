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
const peopleAcademy='20260727003000_add_people_academy_and_full_plan.sql';
const reefSeed='20260727004000_seed_reef_skills_tenant.sql';
const peopleAcademyIndexes='20260727004500_index_people_academy_references.sql';
const staffActivation='20260727110338_add_staff_profile_activation_and_role_routes.sql';

assert.deepEqual(
  sqlFiles,
  [foundation,policies,provisioning,invitationIndexes,peopleAcademy,reefSeed,peopleAcademyIndexes,staffActivation],
  'the v2 branch must contain only the clean foundation and reviewed forward migrations'
);

const sql=await readFile(new URL(foundation,migrationsUrl),'utf8');
const policySql=await readFile(new URL(policies,migrationsUrl),'utf8');
const provisioningSql=await readFile(new URL(provisioning,migrationsUrl),'utf8');
const invitationIndexSql=await readFile(new URL(invitationIndexes,migrationsUrl),'utf8');
const peopleAcademySql=await readFile(new URL(peopleAcademy,migrationsUrl),'utf8');
const reefSeedSql=await readFile(new URL(reefSeed,migrationsUrl),'utf8');
const peopleAcademyIndexSql=await readFile(new URL(peopleAcademyIndexes,migrationsUrl),'utf8');
const staffActivationSql=await readFile(new URL(staffActivation,migrationsUrl),'utf8');
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
assert.match(peopleAcademySql,/create schema if not exists people/);
assert.match(peopleAcademySql,/create schema if not exists academy/);
assert.match(peopleAcademySql,/v2_tenant_create_staff/);
assert.match(peopleAcademySql,/v2_tenant_create_course/);
assert.match(peopleAcademySql,/v2_tenant_workspace_snapshot/);
assert.match(peopleAcademySql,/staff_profiles_isolated_read/);
assert.match(peopleAcademySql,/courses_isolated_read/);
assert.doesNotMatch(peopleAcademySql,/service_role|SUPABASE_SECRET/i);
assert.match(reefSeedSql,/tenant-reef-skills/);
assert.match(reefSeedSql,/'full'/);
assert.match(reefSeedSql,/REEF-SALES-007/);
assert.match(reefSeedSql,/'PMP'/);
assert.match(reefSeedSql,/'AI-SKILLS'/);
assert.match(peopleAcademyIndexSql,/people_staff_department_reference_idx/);
assert.match(peopleAcademyIndexSql,/academy_course_runs_course_reference_idx/);
assert.match(staffActivationSql,/v2_tenant_update_staff/);
assert.match(staffActivationSql,/v2_tenant_invite_staff/);
assert.match(staffActivationSql,/people_staff_tenant_email_idx/);
assert.match(staffActivationSql,/tenant\.users\.manage/);
assert.doesNotMatch(staffActivationSql,/service_role|SUPABASE_SECRET/i);

console.log('Verified the clean v2 database, provisioning, and Reef tenant migrations.');
