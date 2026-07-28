import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);

async function source(path){
  return readFile(new URL(path,root),'utf8');
}

test('lead intake is a tenant route protected by its own permission',async()=>{
  const [page,shell]=await Promise.all([
    source('app/tenant/[slug]/lead-queue/page.js'),
    source('components/workspace-shell.js')
  ]);
  assert.match(page,/requireTenantPermission\(slug,'tenant\.leads\.read'\)/);
  assert.match(page,/getTenantLeadIntake/);
  assert.match(shell,/استقبال وتوزيع العملاء/);
  assert.match(shell,/permission:'tenant\.leads\.read'/);
});

test('spreadsheet intake supports Arabic aliases and quality preview',async()=>{
  const component=await source('components/lead-intake-workspace.js');
  assert.match(component,/import\('xlsx'\)/);
  assert.match(component,/اسمالعميل/);
  assert.match(component,/رقمالجوال/);
  assert.match(component,/اسمالحمله/);
  assert.match(component,/validationStatus/);
  assert.match(component,/duplicate/);
  assert.match(component,/5000/);
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
