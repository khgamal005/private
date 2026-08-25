import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath='supabase/migrations/20260822105500_tenant_runtime_load_hotfix_v1.sql';

test('task calendar and sales use lean scoped snapshots',async()=>{
  const [tasksPage,salesPage,api]=await Promise.all([
    read('app/tenant/[slug]/tasks/page.js'),
    read('app/tenant/[slug]/sales/page.js'),
    read('lib/api.js')
  ]);

  assert.match(tasksPage,/getTenantTaskCalendar\(slug,\{/);
  assert.doesNotMatch(tasksPage,/getTenantOperations/);
  assert.match(salesPage,/getTenantSalesWorkspace\(slug/);
  assert.match(salesPage,/optionalServerRead\(/);
  assert.doesNotMatch(salesPage,/getTenantOperations/);

  const calendarStart=api.indexOf(
    'export async function getTenantTaskCalendar'
  );
  const calendarEnd=api.indexOf(
    '\nconst SALES_TASK_ROLE_KEYS',
    calendarStart
  );
  const calendarRead=api.slice(calendarStart,calendarEnd);
  assert.match(calendarRead,/v1_tenant_task_calendar_snapshot/);
  assert.match(calendarRead,/p_task_scope:taskScope/);
  assert.match(calendarRead,/p_include_sales:includeSales/);
  assert.match(calendarRead,/retryTransient:true/);
  assert.match(calendarRead,/timeoutMs:8000/);
  assert.doesNotMatch(
    calendarRead,
    /v4_tenant_operations_snapshot|v4_tenant_sales_pipeline_snapshot|v1_tenant_lead_reassignment_snapshot/
  );

  const salesStart=api.indexOf(
    'export async function getTenantSalesWorkspace'
  );
  const salesEnd=api.indexOf(
    '\nconst SALES_TASK_ROLE_KEYS',
    salesStart
  );
  const salesRead=api.slice(salesStart,salesEnd);
  assert.match(salesRead,/v1_tenant_sales_workspace_snapshot/);
  assert.doesNotMatch(salesRead,/retryTransient:true/);
  assert.match(salesRead,/timeoutMs:4500/);
  assert.doesNotMatch(
    salesRead,
    /v4_tenant_operations_snapshot|v4_tenant_sales_pipeline_snapshot|v1_tenant_lead_reassignment_snapshot/
  );
});

test('runtime hotfix removes the timezone catalog scan and preserves tenant scoping',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/task_day_is_overdue_v1/);
  assert.match(migration,/core\.tenants tenant/);
  assert.match(migration,/tenant\.timezone/);
  assert.doesNotMatch(migration,/pg_timezone_names/);

  assert.match(migration,/v2_tenant_dashboard_live_snapshot/);
  assert.match(migration,/v1_tenant_task_calendar_snapshot/);
  assert.match(migration,/private_app\.has_tenant_permission/);
  assert.match(migration,/private_app\.can_view_tenant_team/);
  assert.match(migration,/task\.tenant_id = v_tenant\.id/);
  assert.match(migration,/contact\.tenant_id = v_tenant\.id/);
  assert.match(migration,/security definer/i);
  assert.match(migration,/set search_path TO ''/i);
  assert.match(migration,/revoke all on function[\s\S]*from public,anon/);
  assert.match(migration,/grant execute on function[\s\S]*to authenticated,service_role/);

  const calendarFunction=migration.match(
    /CREATE OR REPLACE FUNCTION public\.v1_tenant_task_calendar_snapshot[\s\S]*?\n\$function\$;/
  )?.[0]||'';
  assert.doesNotMatch(
    calendarFunction,
    /v4_tenant_operations_snapshot|v4_tenant_sales_pipeline_snapshot|v1_tenant_lead_reassignment_snapshot/
  );
});
