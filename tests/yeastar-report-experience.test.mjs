import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const reports=await readFile(
  new URL('../components/yeastar-reports.js',import.meta.url),
  'utf8'
);
const styles=await readFile(
  new URL('../components/yeastar-reports.module.css',import.meta.url),
  'utf8'
);
const page=await readFile(
  new URL('../app/tenant/[slug]/yeastar/page.js',import.meta.url),
  'utf8'
);

test('Yeastar page reuses canonical employee metrics and staff mapping',()=>{
  assert.match(page,/v4_tenant_reports_snapshot/);
  assert.match(page,/v4_tenant_yeastar_department_snapshot/);
  assert.match(page,/getTenantRoleDashboard/);
  assert.match(page,/p_report:'employees'/);
  assert.match(page,/performance:performance\|\|\{\}/);
  assert.match(page,/dashboard:dashboard\|\|\{\}/);
  assert.match(page,/departments:departments\|\|\[\]/);
});

test('reports adapt between personal, employee, and management scopes',()=>{
  assert.match(reports,/تقرير مكالماتي/);
  assert.match(reports,/تقرير مكالمات \$\{activeEmployee\.name\}/);
  assert.match(reports,/الأداء الإجمالي للإدارات/);
  assert.match(reports,/أداء التحويلات والموظفين/);
  assert.match(reports,/data\.viewer\?\.personalOnly/);
  assert.match(reports,/data\.performance\?\.viewer\?\.scope==='employee'/);
  assert.match(reports,/Array\.isArray\(data\.departments\)/);
});

test('call intelligence keeps core operations and detail records visible',()=>{
  assert.match(reports,/api\/yeastar\/sync/);
  assert.match(reports,/سجل المكالمات التفصيلي/);
  assert.match(reports,/لم يُعد الاتصال/);
  assert.match(reports,/مؤشر فقط دون نسخ الصوت/);
  assert.match(reports,/Pagination/);
});

test('call intelligence shows the exact talk and ring duration card',()=>{
  assert.match(reports,/label="إجمالي التحدث والرنين"/);
  assert.match(reports,/summary\.totalTalkAndRingSeconds/);
  assert.match(reports,/summary\.totalRoutingSeconds/);
  assert.match(styles,/\.kpi_teal\{/);
  assert.match(styles,/grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
});

test('report layout is responsive and print ready',()=>{
  assert.match(styles,/@media\(max-width:680px\)/);
  assert.match(styles,/\.kpiGrid\{display:grid/);
  assert.match(styles,/\.departmentGrid\{display:grid/);
  assert.match(styles,/@media print/);
});
