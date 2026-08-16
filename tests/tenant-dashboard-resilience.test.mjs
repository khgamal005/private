import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('tenant shell and overview share one bounded live snapshot',async()=>{
  const [page,layout,api,component]=await Promise.all([
    read('app/tenant/[slug]/page.js'),
    read('app/tenant/[slug]/layout.js'),
    read('lib/api.js'),
    read('components/role-dashboard.js')
  ]);

  assert.match(api,/getTenantDashboardLive=cache/);
  assert.match(api,/v1_tenant_dashboard_live_snapshot/);
  assert.match(page,/getTenantDashboardLive\(slug\)/);
  assert.match(layout,/getTenantDashboardLive\(slug\)/);
  assert.doesNotMatch(page,/getTenantOperations|getTenant\(/);
  assert.doesNotMatch(layout,/getTenantRoleDashboard|getTenant\(/);
  assert.equal((page.match(/getTenantRoleDashboard\(/g)||[]).length,1);
  assert.match(component,/taskSnapshot\(operations\)/);
  assert.match(component,/Number\(summary\.openTasks\)/);
});

test('optional dashboard panels degrade without swallowing navigation',async()=>{
  const [page,layout,resilience]=await Promise.all([
    read('app/tenant/[slug]/page.js'),
    read('app/tenant/[slug]/layout.js'),
    read('lib/server-resilience.js')
  ]);

  assert.match(page,/optionalServerRead/);
  assert.match(layout,/optionalServerRead/);
  assert.match(resilience,/unstable_rethrow\(error\)/);
  assert.match(resilience,/optional-server-read-failed/);
  assert.doesNotMatch(resilience,/error\.message/);
});

test('RPC reads have deadlines, structured failures, and bounded retry',async()=>{
  const auth=await read('lib/server-auth.js');

  assert.match(auth,/getContext=cache/);
  assert.match(auth,/AbortSignal\.timeout/);
  assert.match(auth,/retryTransient===true\?2:1/);
  assert.doesNotMatch(auth,/TRANSIENT_RPC_STATUSES=new Set\(\[[^\]]*500/);
  assert.match(auth,/auth-rpc-network-failure/);
  assert.match(auth,/auth-rpc-invalid-json/);
  assert.match(auth,/auth-rpc-failure/);
  assert.doesNotMatch(auth,/console\.error\([^\n]*token/i);
});

test('session refresh reaches the same SSR request and tenant APIs',async()=>{
  const proxy=await read('proxy.js');

  const requestAccess=proxy.indexOf('req.cookies.set(ACCESS_COOKIE');
  const nextResponse=proxy.indexOf('NextResponse.next({request:req})');
  assert.ok(requestAccess>=0&&requestAccess<nextResponse);
  assert.match(proxy,/response\.cookies\.set\(ACCESS_COOKIE/);
  assert.match(proxy,/\/api\/tenant\/:path\*/);
  assert.match(proxy,/Cache-Control','private, no-store/);
});

test('notification polling cannot trigger a full dashboard refresh storm',async()=>{
  const [center,route]=await Promise.all([
    read('components/notification-center.js'),
    read('app/api/tenant/notifications/route.js')
  ]);

  assert.match(center,/POLL_INTERVAL_MS=30000/);
  assert.match(center,/MAX_BACKOFF_MS=120000/);
  assert.match(center,/document\.visibilityState==='hidden'/);
  assert.match(center,/busyRef\.current/);
  assert.match(center,/error\?\.status===401/);
  assert.doesNotMatch(center,/router\.refresh/);
  assert.match(center,/router\.replace\('\/login\?reason=session'\)/);
  assert.match(route,/AbortSignal\.timeout\(6000\)/);
});

test('live snapshot is tenant-scoped, authorized, and hard-limited',async()=>{
  const migration=await read(
    'supabase/migrations/20260816160000_tenant_dashboard_resilience_v1.sql'
  );

  assert.match(migration,/v1_tenant_dashboard_live_snapshot/);
  assert.match(migration,/private_app\.has_tenant_permission/);
  assert.match(migration,/private_app\.can_view_tenant_team/);
  assert.match(migration,/v_can_read_crm := private_app\.has_tenant_permission/);
  assert.match(migration,/v_can_read_work := private_app\.has_tenant_permission/);
  assert.match(migration,/v_can_read_admissions := private_app\.has_tenant_permission/);
  assert.match(migration,/private_app\.v2_metric_is_active_contact/);
  assert.match(migration,/'pendingAdmissions', v_pending_admissions/);
  assert.match(migration,/task\.tenant_id = v_tenant\.id/);
  assert.match(migration,/activity\.tenant_id = v_tenant\.id/);
  assert.match(migration,/contact\.tenant_id = v_tenant\.id/);
  assert.match(migration,/limit 6/);
  assert.match(migration,/'tasks', v_tasks/);
  assert.doesNotMatch(migration,/jsonb_agg[\s\S]*from sales_core\.contacts contact[\s\S]*'contacts'/);
  assert.match(migration,/security definer/);
  assert.match(migration,/set search_path = ''/);
  assert.match(migration,/revoke all on function[\s\S]*from public, anon/);
  assert.match(migration,/grant execute on function[\s\S]*to authenticated/);
  assert.doesNotMatch(migration,/service_role|supabase_secret/i);
});

test('tenant render failures have resettable Arabic boundaries',async()=>{
  const [parent,segment,state]=await Promise.all([
    read('app/tenant/error.js'),
    read('app/tenant/[slug]/error.js'),
    read('components/tenant-error-state.js')
  ]);

  assert.match(parent,/'use client'/);
  assert.match(segment,/'use client'/);
  assert.match(state,/onClick=\{\(\)=>reset\(\)\}/);
  assert.match(state,/إعادة المحاولة/);
  assert.match(state,/error\?\.digest/);
});
