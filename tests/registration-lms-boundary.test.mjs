import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('registration owns batches, learner operations and certificates independently of LMS',async()=>{
  const [admissions,api,actions,certificate,lmsPage]=await Promise.all([
    read('components/admissions-workspace.js'),
    read('lib/api.js'),
    read('app/api/tenant/[action]/route.js'),
    read('app/tenant/[slug]/certificates/[certificateId]/page.js'),
    read('app/tenant/[slug]/lms/page.js')
  ]);

  assert.match(admissions,/CourseRunsWorkspace/);
  assert.match(admissions,/LearnerOperationsWorkspace/);
  assert.match(admissions,/>الدفعات والجداول<\/button>/);
  assert.match(admissions,/>تشغيل المتدربين<\/button>/);

  const admissionsLoader=api.match(
    /export async function getTenantAdmissions\(slug\)\{([\s\S]*?)\n\}\n/
  )?.[1]||'';
  for(const rpc of [
    'v2_tenant_admissions_snapshot',
    'v2_tenant_course_runs_snapshot',
    'v2_tenant_training_operations_snapshot',
    'v2_tenant_training_automation_snapshot'
  ])assert.match(admissionsLoader,new RegExp(rpc));

  const addOnMap=actions.match(
    /const ACTION_ADDONS=Object\.freeze\(\{([\s\S]*?)\n\}\);/
  )?.[1]||'';
  assert.doesNotMatch(
    addOnMap,
    /save-course-run|update-training-operation|training-automation/
  );
  assert.doesNotMatch(
    actions,
    /action==='update-admission'[\s\S]{0,180}\['lms'\]/
  );

  assert.match(
    certificate,
    /requireTenantPermission\(slug,'tenant\.training\.read'\)/
  );
  assert.match(certificate,/\/admissions/);
  assert.doesNotMatch(certificate,/requireTenantAddon/);
  assert.match(lmsPage,/requireTenantAddon\(slug,'lms'/);
});

test('entitlement normalization accepts unlimited numeric plan values safely',async()=>{
  const directory=new URL('supabase/migrations/',root);
  const migrationName=(await readdir(directory)).find(
    name=>name.endsWith('_normalize_addon_entitlement_boolean_values.sql')
  );
  assert.ok(migrationName,'Normalization migration must exist');
  const migration=await read(`supabase/migrations/${migrationName}`);

  assert.match(migration,/private_app\.entitlement_value_enabled/);
  assert.match(migration,/jsonb_typeof\(p_value\) = 'number'/);
  assert.match(migration,/numeric <> 0/);
  assert.match(migration,/'-1'::jsonb/);
  assert.doesNotMatch(
    migration,
    /plan_feature\.value #>> '\{\}'\)::boolean/
  );
  assert.doesNotMatch(
    migration,
    /override\.value #>> '\{\}'\)::boolean/
  );
});
