import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);

async function source(path){
  return readFile(new URL(path,root),'utf8');
}

async function binary(path){
  return readFile(new URL(path,root));
}

test('lead intake is a tenant route protected by its own permission',async()=>{
  const [page,shell]=await Promise.all([
    source('app/tenant/[slug]/lead-queue/page.js'),
    source('components/workspace-shell.js')
  ]);
  assert.match(page,/requireTenantPermission\(slug,'tenant\.leads\.read'\)/);
  assert.match(page,/getTenantLeadIntake/);
  assert.match(shell,/label:'توزيع العملاء'/);
  assert.match(shell,/permission:'tenant\.leads\.read'/);
});

test('spreadsheet intake supports Arabic aliases and quality preview',async()=>{
  const component=await source('components/lead-intake-workspace.js');
  assert.match(component,/import\('xlsx'\)/);
  assert.match(component,/اسمالعميل/);
  assert.match(component,/اسمالطالب/);
  assert.match(component,/رقمالجوال/);
  assert.match(component,/اسمالحمله/);
  assert.match(component,/validationStatus/);
  assert.match(component,/duplicate/);
  assert.match(component,/5000/);
});

test('data officers can download an importer-compatible Excel example',async()=>{
  const [component,templateFile]=await Promise.all([
    source('components/lead-intake-workspace.js'),
    binary('public/templates/marktone-lead-intake-template.xlsx')
  ]);
  const imported=await import('xlsx');
  const XLSX=imported.default||imported;
  const workbook=XLSX.read(templateFile,{type:'buffer'});
  const sheet=workbook.Sheets[workbook.SheetNames[0]];
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:''});
  const displayedRows=XLSX.utils.sheet_to_json(sheet,{
    header:1,
    defval:'',
    raw:false
  });

  assert.match(
    component,
    /href="\/templates\/marktone-lead-intake-template\.xlsx"/
  );
  assert.deepEqual(rows[0],[
    'اسم الطالب',
    'رقم الجوال',
    'رقم الواتساب',
    'البريد الإلكتروني',
    'المنشأة',
    'اسم الدورة',
    'المصدر',
    'اسم الحملة',
    'مجموعة الإعلانات',
    'اسم الإعلان',
    'ملاحظات'
  ]);
  assert.match(rows[1][0],/مثال/);
  assert.match(rows[1][5],/PMP/);
  assert.match(rows[1][9],/مسارك المهني/);
  assert.equal(displayedRows[1][1],'+966501234567');
  assert.equal(workbook.SheetNames[1],'تعليمات');
});

test('distribution requires a future deadline and exposes three strategies',async()=>{
  const [component,migration]=await Promise.all([
    source('components/lead-intake-workspace.js'),
    source('supabase/migrations/20260728124500_lead_intake_distribution_analytics_v2.sql')
  ]);
  assert.match(component,/deadlineAt:new Date\(distribution\.deadlineAt\)\.toISOString\(\)/);
  assert.match(component,/online_only/);
  assert.match(component,/selected/);
  assert.match(migration,/v_deadline_at <= now\(\)/);
  assert.match(migration,/daily_capacity/);
  assert.match(migration,/weight/);
  assert.match(migration,/for update skip locked/);
  assert.match(migration,/lead_assignments_one_active_row_idx/);
});

test('campaign analytics use CRM outcomes and first-response evidence',async()=>{
  const migration=await source(
    'supabase/migrations/20260728124500_lead_intake_distribution_analytics_v2.sql'
  );
  assert.match(migration,/average_first_response_minutes/);
  assert.match(migration,/wrong_number_rows/);
  assert.match(migration,/qualification_rate/);
  assert.match(migration,/conversion_rate/);
  assert.match(migration,/lead_status = 'paid'/);
  assert.match(migration,/activities_capture_lead_first_action/);
});


test('lead distribution tabs share separated filters and complete XLSX exports',async()=>{
  const [component,route,css,migration]=await Promise.all([
    source('components/lead-intake-workspace.js'),
    source('app/api/tenant/report-export/route.js'),
    source('app/rebuild.css'),
    source('supabase/migrations/20260810213000_lead_intake_filters_export_v1.sql')
  ]);

  assert.match(component,/ReportExcelButton/);
  assert.match(component,/mt-lead-report-filters/);
  assert.match(component,/من تاريخ/);
  assert.match(component,/إلى تاريخ/);
  assert.match(component,/جودة الصف/);
  assert.match(component,/>المصدر</);
  assert.match(component,/الحملة التسويقية/);
  assert.match(component,/wrong_number/);
  assert.match(component,/unqualified/);
  assert.match(component,/no_answer/);
  assert.match(component,/report:'lead-intake'/);
  assert.match(component,/section:tab/);
  assert.match(component,/<th>المصدر<\/th>[\s\S]*<th>الحملة<\/th>/);
  assert.doesNotMatch(component,/<th>المصدر والحملة<\/th>/);
  assert.doesNotMatch(component,/<th>المصدر \/ الحملة<\/th>/);

  for(const tab of ['queue','batches','assignments','analytics','team']){
    assert.match(route,new RegExp(tab+":\\['"+tab+"'\\]"));
  }
  assert.match(route,/v3_tenant_lead_intake_export_v1/);
  assert.match(route,/isLeadIntake/);
  assert.match(css,/\.mt-lead-report-filter-grid/);
  assert.match(migration,/p_quality text/);
  assert.match(migration,/p_source text/);
  assert.match(migration,/p_campaign text/);
  assert.match(migration,/p_batch_id uuid/);
  assert.match(migration,/p_validation text/);
  assert.match(migration,/p_query text/);
  assert.match(migration,/assignment\.assigned_at/);
  assert.match(migration,/assignment\.first_action_at/);
  assert.match(migration,/'رقم الجوال'/);
  assert.match(migration,/'زمن الاستجابة بالدقائق'/);
  assert.match(migration,/tenant\.leads\.analytics/);
  assert.match(migration,/tenant\.leads\.distribute/);
});
