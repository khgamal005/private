import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath='supabase/migrations/20260825144111_tenant_sales_workspace_resilience_v1.sql';

test('sales workspace migration is bounded, scoped, and cursor paginated',async()=>{
  const migration=await read(migrationPath);
  const normalized=migration.toLowerCase();

  assert.match(migration,/v1_tenant_sales_workspace_snapshot/);
  assert.match(migration,/tenant\.crm\.read/);
  assert.match(migration,/security definer/i);
  assert.match(migration,/set search_path = ''/i);
  assert.match(migration,/set statement_timeout = '4s'/i);
  assert.match(migration,/least\(greatest\(coalesce\(p_limit, 80\), 1\), 100\)/);
  assert.match(migration,/v_query_digit_count < 3/);
  assert.match(migration,/v_query_letter_count < 2/);
  assert.match(migration,/raise exception 'invalid_query'/);
  assert.match(migration,/limit v_limit \+ 1[\s\S]*?\) page/);
  assert.match(migration,/order by activity\.occurred_at desc, activity\.id desc\s+limit 150\s+\) item/);
  assert.match(migration,/order by handoff\.created_at desc, handoff\.id desc\s+limit 100\s+\) item/);
  assert.match(migration,/'focusedContact', v_focused_contact/);
  assert.match(migration,/'paymentSubmitted'/);
  assert.match(migration,/'activeAssignmentId'/);
  assert.match(migration,/'activeAssignmentStaffId'/);
  assert.match(migration,/contact\.tenant_id = v_tenant\.id/);
  assert.match(migration,/owner\.tenant_id = v_tenant\.id/);
  assert.match(migration,/course\.tenant_id = v_tenant\.id/);
  assert.match(migration,/assignment\.tenant_id = v_tenant\.id/);
  assert.match(migration,/page\.next_action_at nulls last[\s\S]*page\.created_at desc[\s\S]*page\.id desc/);
  assert.match(migration,/revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration,/grant execute on function[\s\S]*to authenticated, service_role/);
  assert.doesNotMatch(
    normalized,
    /v[234]_tenant_(operations|sales_pipeline)_snapshot|v1_tenant_lead_reassignment_snapshot/
  );
});

test('sales page fails soft only after enforcing CRM permission',async()=>{
  const page=await read('app/tenant/[slug]/sales/page.js');
  const permission=page.indexOf(
    "requireTenantPermission(slug,'tenant.crm.read')"
  );
  const optionalRead=page.indexOf('optionalServerRead(');

  assert.ok(permission>=0);
  assert.ok(optionalRead>permission);
  assert.match(page,/getTenantSalesWorkspace/);
  assert.match(page,/unavailable:true/);
  assert.match(page,/UUID_PATTERN\.test\(requestedContact\)/);
  assert.doesNotMatch(page,/getTenantOperations/);
});

test('interactive sales route validates input and returns private JSON errors',async()=>{
  const route=await read('app/api/tenant/sales-workspace/route.js');

  assert.match(route,/FILTERS=new Set/);
  assert.match(route,/limit>100/);
  assert.match(route,/UUID_PATTERN\.test\(focusContactId\)/);
  assert.match(route,/invalid_cursor/);
  assert.match(route,/\.\\d\{1,6\}/);
  assert.match(route,/AbortSignal\.timeout\(4500\)/);
  assert.match(route,/sales_read_invalid_response/);
  assert.match(route,/SEARCH_DIGITS/);
  assert.match(route,/queryDigits<3/);
  assert.match(route,/queryLetters<2/);
  assert.match(route,/validSnapshotPayload\(payload,limit\)/);
  assert.match(route,/auxiliaryKeys\.every\(validRecordArray\)/);
  assert.match(route,/pagination\.returned===payload\.contacts\.length/);
  assert.match(route,/summaryKeys\.every/);
  assert.match(route,/pipelineKeys\.every/);
  assert.match(route,/day>days\[month-1\]/);
  assert.match(route,/year<1/);
  assert.match(route,/Cache-Control':'private, no-store, max-age=0/);
  assert.match(route,/v2_tenant_sales_workspace_snapshot/);
  assert.match(route,/status===401/);
  assert.doesNotMatch(route,/detail\s*:/);
  assert.doesNotMatch(route,/validInstant[\s\S]{0,300}toISOString/);
  assert.doesNotMatch(route,/v4_tenant_operations_snapshot|v4_tenant_sales_pipeline_snapshot/);
});

test('sales client uses server facets, cancellation, and bounded pages',async()=>{
  const client=await read('components/sales-workspace.js');

  assert.match(client,/const PAGE_SIZE=80/);
  assert.match(client,/new AbortController\(\)/);
  assert.match(client,/requestSequence/);
  assert.match(client,/searchableQuery/);
  assert.match(client,/\/api\/tenant\/sales-workspace/);
  assert.match(client,/pagination\.pipelineCounts/);
  assert.match(client,/summary\.paymentSubmitted/);
  assert.match(client,/focusedContact/);
  assert.match(client,/العميل المطلوب من رابط البحث/);
  assert.doesNotMatch(client,/params\.set\('contact'/);
  assert.match(client,/loadNextPage/);
  assert.match(client,/loadPreviousPage/);
  assert.match(client,/data\.unavailable/);
  assert.match(client,/reloadAfterMutation/);
  assert.match(client,/completedAuxiliaryRefresh/);
  assert.match(client,/lastFailedRequest/);
  assert.match(client,/criteria:requestCriteria/);
  assert.match(client,/failed\?\.criteriaKey===activeCriteriaKey/);
  assert.match(client,/setQuery\(''\)/);
  assert.match(client,/lastCriteria\.current=null/);
  assert.match(client,/shortContactQuery/);
  assert.match(client,/أحدث 150 متابعة/);
  assert.doesNotMatch(client,/isPastBusinessDay/);
  assert.doesNotMatch(client,/<a className="mt-button primary" href=\{\`\/tenant/);
});
