import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('reporting RPC enforces bounded periods and employee scope',async()=>{
  const sql=await read('supabase/migrations/20260730204215_tenant_reporting_center_v1.sql');
  assert.match(sql,/v2_tenant_reports_snapshot_v1/);
  assert.match(sql,/v_to_date - v_from_date > 365/);
  assert.match(sql,/private_app\.can_view_tenant_team/);
  assert.match(sql,/p_staff_id is distinct from v_current_staff_id/);
  assert.match(sql,/raise exception 'forbidden'/);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/revoke all on function[\s\S]*from public, anon/);
  assert.match(sql,/grant execute on function[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/service_role|SUPABASE_SECRET/i);
});

test('reports use real CRM, task, telephony and campaign sources',async()=>{
  const sql=await read('supabase/migrations/20260730204215_tenant_reporting_center_v1.sql');
  for(const source of [
    'sales_core.lead_assignments',
    'sales_core.contacts',
    'sales_core.opportunities',
    'sales_core.activities',
    'work_core.tasks',
    'telephony.call_records',
    'academy.registration_handoffs'
  ]){
    assert.match(sql,new RegExp(source.replace('.','\\.')));
  }
  assert.match(sql,/dataCompletenessRate/);
  assert.match(sql,/firstResponseSlaRate/);
  assert.match(sql,/realizedRevenueMinor/);
  assert.match(sql,/extensionAssignments/);
  assert.doesNotMatch(sql,/Math\.random|بيانات تجريبية|mock/i);
});

test('tenant navigation exposes one expandable reporting center',async()=>{
  const [shell,polish]=await Promise.all([
    read('components/workspace-shell.js'),
    read('app/tenant-shell-polish.css')
  ]);
  assert.match(shell,/label:'التقارير والتحليل'/);
  assert.match(shell,/label:'لوحة التقارير'/);
  assert.match(shell,/label:'تقارير المكالمات'/);
  assert.match(shell,/أداء الموظفين/);
  assert.match(shell,/label:'تقارير المبيعات'/);
  assert.match(shell,/label:hasAddon\('social_connect'\)\?'تحليل الإعلانات والمبيعات':'تقارير الحملات'/);
  assert.match(shell,/mt-navigation-children/);
  assert.match(polish,/\.mt-navigation-group/);
  assert.match(polish,/\.mt-navigation-children/);
});

test('report pages share date filters and employee drill-down',async()=>{
  const [
    component,
    styles,
    api,
    range,
    employeePage
  ]=await Promise.all([
    read('components/reporting-center.js'),
    read('components/reporting-center.module.css'),
    read('lib/api.js'),
    read('lib/reporting.js'),
    read('app/tenant/[slug]/reports/employees/[staffId]/page.js')
  ]);
  assert.match(component,/name="from"/);
  assert.match(component,/name="to"/);
  assert.match(component,/EmployeeTable/);
  assert.match(component,/DetailTables/);
  assert.match(component,/TrendChart/);
  assert.match(component,/CampaignTable/);
  assert.match(component,/تكلفة الإعلان وROAS/);
  assert.match(styles,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles,/\.metric\.blue\{/);
  assert.match(styles,/\.legend \.blue,.bars \.blue\{/);
  assert.doesNotMatch(styles,/(^|\n)\.blue\{background:/m);
  assert.match(styles,/\.metric small\{color:#526a7f/);
  assert.match(styles,/grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(styles,/@media\(max-width:620px\)/);
  assert.match(api,/v5_tenant_reports_snapshot/);
  assert.match(range,/inclusiveDays\(from,to\)>366/);
  assert.match(employeePage,/if\(!isUuid\(staffId\)\)notFound\(\)/);
  assert.match(employeePage,/report:'employee'/);
});
