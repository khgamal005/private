import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  ASSIGNMENT_METRIC_CONTRACT_VERSION,
  assignmentDateMatches,
  leadIntakeDateBasis,
  zonedDateKey
} from '../lib/assignment-metric-contract.mjs';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260811190000_assignment_metric_reconciliation_v1.sql';

test('assignment date filtering ignores later first responses',()=>{
  const filters={from:'2026-08-09',to:'2026-08-09'};
  const assignedOnNinth={
    assignedAt:'2026-08-09T08:00:00.000Z',
    firstActionAt:'2026-08-10T08:00:00.000Z'
  };
  const respondedOnNinth={
    assignedAt:'2026-08-08T08:00:00.000Z',
    firstActionAt:'2026-08-09T08:00:00.000Z'
  };

  assert.equal(
    assignmentDateMatches(assignedOnNinth,filters,'Asia/Riyadh'),
    true
  );
  assert.equal(
    assignmentDateMatches(respondedOnNinth,filters,'Asia/Riyadh'),
    false
  );
  assert.equal(leadIntakeDateBasis('assignments').field,'assigned_at');
  assert.equal(leadIntakeDateBasis('team').field,'assigned_at');
});

test('calendar boundaries are evaluated in tenant time, not browser time',()=>{
  assert.equal(
    zonedDateKey('2026-08-08T21:30:00.000Z','Asia/Riyadh'),
    '2026-08-09'
  );
  assert.equal(ASSIGNMENT_METRIC_CONTRACT_VERSION,'assignment-events-v1');
});

test('customer, operation, and valid-outcome totals stay distinct',()=>{
  const events=Array.from({length:73},(_,index)=>({
    assignmentId:`assignment-${index}`,
    contactId:`contact-${index}`,
    outcome:index<20?'wrong_number':index<22?'unqualified':'follow_up'
  }));
  events.push({
    assignmentId:'assignment-reassigned',
    contactId:'contact-72',
    outcome:'follow_up'
  });

  assert.equal(events.length,74);
  assert.equal(new Set(events.map(event=>event.contactId)).size,73);
  assert.equal(new Set(events
    .filter(event=>!['wrong_number','unqualified','duplicate']
      .includes(event.outcome))
    .map(event=>event.contactId)).size,51);
});

test('database contract uses assigned_at exclusive range and reconciled RPCs',async()=>{
  const sql=await read(migrationPath);
  const eventsFunction=sql.match(
    /create or replace function private_app\.v3_assignment_events[\s\S]*?\n\$\$;/
  )?.[0]||'';

  assert.match(eventsFunction,/assignment\.assigned_at >= p_from_at/);
  assert.match(eventsFunction,/assignment\.assigned_at < p_to_at/);
  assert.doesNotMatch(
    eventsFunction,
    /first_action_at\s+(?:>=|<|between)/i
  );
  assert.match(sql,/count\(distinct event\.contact_id\)/);
  assert.match(sql,/assignmentOperations/);
  assert.match(sql,/validAssignedLeads/);
  assert.match(sql,/assignment-events-v1/);
  assert.match(sql,/public\.v4_tenant_reports_snapshot/);
  assert.match(sql,/public\.v3_tenant_lead_intake_export_v1/);
  assert.match(sql,/private_app\.has_tenant_permission/);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/from public, anon/);
  assert.match(sql,/to authenticated/);
});

test('screen, reports, and XLSX route consume the reconciled contract',async()=>{
  const [component,route,api,yeastar,reporting]=await Promise.all([
    read('components/lead-intake-workspace.js'),
    read('app/api/tenant/report-export/route.js'),
    read('lib/api.js'),
    read('app/tenant/[slug]/yeastar/page.js'),
    read('components/reporting-center.js')
  ]);

  assert.match(component,/matchesAssignment\(assignment,filters,timeZone\)/);
  assert.doesNotMatch(
    component,
    /\[assignment\.assignedAt,assignment\.firstActionAt\]/
  );
  assert.match(component,/أساس الفترة في هذا التبويب/);
  assert.match(route,/v3_tenant_lead_intake_export_v1/);
  assert.match(route,/v5_tenant_reports_snapshot/);
  assert.match(route,/metricContract/);
  assert.match(api,/v5_tenant_reports_snapshot/);
  assert.match(yeastar,/v5_tenant_reports_snapshot/);
  assert.match(reporting,/عمليات الإسناد/);
  assert.match(reporting,/الصالحون بعد المعالجة/);
});
