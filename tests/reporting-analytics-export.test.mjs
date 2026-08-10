import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('tenant report analytics tools are explicit permission-controlled capabilities',async()=>{
  const [migration,scopeMigration,helper]=await Promise.all([
    read('supabase/migrations/20260810190000_tenant_reporting_analytics_tools_v1.sql'),
    read('supabase/migrations/20260810190500_tenant_reporting_analytics_team_scope_v1.sql'),
    read('lib/report-analytics.js')
  ]);
  assert.match(migration,/tenant\.reports\.analytics/);
  for(const role of ['tenant_owner','tenant_admin','executive_manager','data_analyst']){
    assert.match(migration,new RegExp(`'${role}'`));
  }
  assert.match(migration,/v2_tenant_report_filter_options/);
  assert.match(migration,/not v_can_analytics/);
  assert.match(migration,/p_extension is not null[\s\S]*raise exception 'forbidden'/);
  assert.match(scopeMigration,/v2_tenant_reports_snapshot_v1/);
  assert.match(scopeMigration,/private_app\.has_tenant_permission/);
  assert.match(scopeMigration,/tenant\.reports\.analytics/);
  assert.match(scopeMigration,/scope_shape_changed/);
  assert.match(helper,/sanitizeAnalyticsRange/);
  assert.match(helper,/canUseAnalytics/);
});

test('every tenant reporting surface exposes unified filters only to analytics users',async()=>{
  const [center,overview,employees,sales,campaigns,yeastar]=await Promise.all([
    read('components/reporting-center.js'),
    read('app/tenant/[slug]/reports/page.js'),
    read('app/tenant/[slug]/reports/employees/page.js'),
    read('app/tenant/[slug]/reports/sales/page.js'),
    read('app/tenant/[slug]/reports/campaigns/page.js'),
    read('components/yeastar-reports.js')
  ]);
  assert.match(center,/name="from"/);
  assert.match(center,/name="to"/);
  assert.match(center,/name="staffId"/);
  assert.match(center,/analytics\?\.canUseAnalytics/);
  assert.match(center,/تصدير التقرير XLSX/);
  assert.match(center,/تصدير المؤشرات XLSX/);
  for(const page of [overview,employees,sales,campaigns]){
    assert.match(page,/getTenantReportAnalytics/);
    assert.match(page,/sanitizeAnalyticsRange/);
  }
  assert.match(yeastar,/canFilterExtension/);
  assert.match(yeastar,/تصدير CDR كامل XLSX/);
  assert.match(yeastar,/تصدير مؤشرات المكالمات XLSX/);
});

test('XLSX export is server-authorized and exhausts paged filtered records',async()=>{
  const route=await read('app/api/tenant/report-export/route.js');
  assert.match(route,/import \* as XLSX from 'xlsx'/);
  assert.match(route,/v2_tenant_report_filter_options/);
  assert.match(route,/if\(!access\?\.canUseAnalytics\)/);
  assert.match(route,/status:403/);
  assert.match(route,/allowedStaff/);
  assert.match(route,/allowedExtensions/);
  assert.match(route,/while\(offset<total\)/);
  assert.match(route,/p_limit:500/);
  assert.match(route,/DETAIL_COLLECTIONS/);
  assert.match(route,/while\(needsMore&&offset<DETAIL_EXPORT_LIMIT\)/);
  assert.match(route,/report_export_limit_exceeded/);
  assert.match(route,/XLSX\.write/);
  assert.match(route,/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
});
