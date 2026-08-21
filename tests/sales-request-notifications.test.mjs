import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260812210000_sales_request_notifications_v1.sql';

test('accepted and rejected sales requests create agent-scoped system notifications',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/create table work_core\.notifications/);
  assert.match(
    migration,
    /recipient_staff_id uuid not null[\s\S]+references people\.staff_profiles/
  );
  assert.match(
    migration,
    /new\.status not in \('accepted', 'rejected'\)/
  );
  assert.match(
    migration,
    /coalesce\(contact\.owner_staff_id, opportunity\.owner_staff_id\)/
  );
  assert.match(migration,/'sales_request_accepted'/);
  assert.match(migration,/'sales_request_rejected'/);
  assert.match(migration,/v_title := 'تم قبول طلب البيع:/);
  assert.match(migration,/v_title := 'تم رفض طلب البيع:/);
  assert.match(
    migration,
    /v_message := 'سبب الرفض: ' \|\| v_reason[\s\S]+مهمة متابعة تلقائية/
  );
  assert.match(
    migration,
    /unique \(tenant_id, notification_key, recipient_staff_id\)/
  );
});

test('rejection always carries a reason and reuses one calendar lifecycle task',async()=>{
  const migration=await read(migrationPath);

  assert.match(
    migration,
    /v_reason := nullif\(trim\(new\.payment_rejection_reason\), ''\)/
  );
  assert.match(migration,/raise exception 'rejection_reason_required'/);
  assert.match(
    migration,
    /select task\.id[\s\S]+from work_core\.tasks task[\s\S]+for update/
  );
  assert.match(
    migration,
    /if v_task_id is not null then[\s\S]+update work_core\.tasks task/
  );
  assert.match(
    migration,
    /else[\s\S]+insert into work_core\.tasks[\s\S]+admission-rejection-/
  );
  assert.match(migration,/on conflict \(tenant_id, task_key\) do update/);
  assert.match(migration,/assigned_staff_id = v_owner_staff_id/);
  assert.match(migration,/due_at = now\(\) \+ interval '1 day'/);
  assert.match(migration,/'source', 'sales_followup'/);
  assert.match(migration,/'rejectionReason', v_reason/);
  assert.match(migration,/'autoCreated', true/);
});

test('notification RPC prevents cross-agent and cross-tenant reads or acknowledgements',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/alter table work_core\.notifications enable row level security/);
  assert.match(
    migration,
    /recipient_staff_id = private_app\.current_staff_id\(tenant_id\)/
  );
  assert.match(
    migration,
    /v_staff_id := private_app\.current_staff_id\(v_tenant_id\)/
  );
  assert.match(
    migration,
    /notification\.tenant_id = v_tenant_id[\s\S]+notification\.recipient_staff_id = v_staff_id/
  );
  assert.match(migration,/p_action not in \('list', 'mark_read', 'mark_all_read'\)/);
  assert.match(
    migration,
    /grant execute on function public\.v1_tenant_notification_center[\s\S]+to authenticated/
  );
  assert.match(migration,/security definer/);
  assert.match(migration,/if auth\.uid\(\) is null then raise exception 'forbidden'/);
  assert.match(
    migration,
    /revoke all on table work_core\.notifications[\s\S]+from public, anon, authenticated/
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(all|select|insert|update|delete)[\s\S]+work_core\.notifications[\s\S]+authenticated/i
  );
});

test('the notification center polls with backoff without refreshing the dashboard',async()=>{
  const [center,shell,route,css]=await Promise.all([
    read('components/notification-center.js'),
    read('components/workspace-shell.js'),
    read('app/api/tenant/notifications/route.js'),
    read('app/tenant-shell-polish.css')
  ]);

  assert.match(center,/const POLL_INTERVAL_MS=30000/);
  assert.match(center,/MAX_BACKOFF_MS=120000/);
  assert.match(center,/window\.setTimeout\(runAndSchedule,delay\)/);
  assert.match(center,/document\.visibilityState==='hidden'/);
  assert.doesNotMatch(center,/router\.refresh\(\)/);
  assert.match(center,/replaceDocument\('\/login\?reason=session'\)/);
  assert.match(center,/mt-notification-toast/);
  assert.match(center,/window\.Notification\.permission==='granted'/);
  assert.match(center,/mark_read/);
  assert.match(center,/mark_all_read/);
  assert.match(shell,/notificationItems\(notificationSummary,slug\)/);
  assert.match(shell,/<NotificationCenter/);
  assert.match(route,/v1_tenant_notification_center/);
  assert.match(route,/const WRITE_ACTIONS=new Set\(\['mark_read','mark_all_read'\]\)/);
  assert.match(route,/ACCESS_COOKIE/);
  assert.match(route,/AbortSignal\.timeout\(6000\)/);
  assert.match(css,/\.mt-notification-toast/);
  assert.match(css,/\.mt-notification-list>a\.is-unread/);
});
