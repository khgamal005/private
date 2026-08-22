import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('customer history combines actions and measures planned versus actual timing',async()=>{
  const [
    migration,
    component,
    workspace,
    route,
    css,
    verifier,
    courseRunMigration,
    legacyHelpersMigration
  ]=await Promise.all([
    read('supabase/migrations/20260805170000_customer_action_history_v1.sql'),
    read('components/customer-history-drawer.js'),
    read('components/sales-workspace.js'),
    read('app/api/tenant/customer-history/route.js'),
    read('app/globals.css'),
    read('scripts/verify-migrations.mjs'),
    read('supabase/migrations/20260727230548_course_runs_and_schedules_v2.sql'),
    read('supabase/migrations/20260802006000_harden_legacy_market_and_operations_helpers.sql')
  ]);

  assert.match(migration,/v2_tenant_customer_history_snapshot/);
  assert.match(migration,/complete_customer_followup_tasks_after_activity/);
  assert.match(migration,/resolvedByActivityId/);
  assert.match(migration,/historyRepair/);
  assert.match(migration,/timing_status in \('early', 'on_time', 'late'\)/);
  assert.match(migration,/private_app\.has_tenant_permission[\s\S]*'tenant\.crm\.read'/);
  assert.match(migration,/v_contact\.owner_staff_id is distinct from v_staff_id/);
  assert.match(migration,/revoke all on function public\.v2_tenant_customer_history_snapshot/);
  assert.match(migration,/grant execute on function public\.v2_tenant_customer_history_snapshot/);

  assert.match(component,/سجل العميل الكامل/);
  assert.match(component,/في الموعد/);
  assert.match(component,/تم متأخرًا/);
  assert.match(component,/متأخر ولم يُنفّذ/);
  assert.match(component,/الموعد المحدد/);
  assert.match(component,/التنفيذ الفعلي/);
  assert.match(component,/CustomerHistoryDrawer/);

  assert.match(workspace,/CustomerHistoryDrawer/);
  assert.match(workspace,/سجل العميل/);
  assert.match(workspace,/setHistoryContact/);
  assert.match(route,/v4_tenant_customer_history_snapshot/);
  assert.match(route,/UUID_PATTERN/);
  assert.match(route,/Cache-Control/);
  assert.match(css,/\.mt-customer-history-drawer/);
  assert.match(css,/\.mt-customer-timeline-event/);
  assert.match(verifier,/20260805170000_customer_action_history_v1\.sql/);
  assert.match(courseRunMigration,/seed\.registration_closes_at - interval '30 days'/);
  assert.doesNotMatch(courseRunMigration,/now\(\) - interval '1 day',[\s\S]*seed\.registration_closes_at/);

  assert.match(legacyHelpersMigration,/to_regprocedure\('public\.market_account_detail\(uuid\)'\) is not null/);
  assert.match(legacyHelpersMigration,/to_regprocedure\('operations\.try_uuid\(text\)'\) is not null/);
});

