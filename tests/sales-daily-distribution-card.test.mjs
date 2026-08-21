import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('daily distribution includes automatic and manual assignment records',async()=>{
  const migration=await read(
    'supabase/migrations/20260821232020_daily_supervisor_distribution_card.sql'
  );

  assert.match(migration,/assignment\.assignment_strategy,/);
  assert.doesNotMatch(migration,/assignment\.assignment_strategy =/);
  assert.match(migration,/assignment\.status = 'active'/);
  assert.match(
    migration,
    /select distinct on \(assignment\.contact_id\)/
  );
  assert.match(migration,/assignment\.assigned_at >= v_day_start/);
  assert.match(migration,/assignment\.assigned_at < v_day_end/);
  assert.match(
    migration,
    /v_view_team\s+or assignment\.assigned_staff_id = v_staff_id/
  );
  assert.match(migration,/'dailyLeadDistribution'/);
  assert.match(migration,/'taskIds', v_daily_distribution_task_ids/);
  assert.match(migration,/'byStaff', v_daily_distribution_by_staff/);
  assert.match(migration,/'items', v_daily_distribution_items/);
  assert.match(migration,/'taskSource', 'lead_assignment'/);
});

test('sales task page filters original daily assignments without followups',async()=>{
  const [page,calendar,api,theme]=await Promise.all([
    read('app/tenant/[slug]/tasks/page.js'),
    read('components/task-calendar-page.js'),
    read('lib/api.js'),
    read('app/marktone-theme.css')
  ]);

  assert.match(
    page,
    /showTodayDistribution=\{SALES_TASK_ROLES\.has\(roleKey\)\}/
  );
  assert.match(calendar,/showTodayDistribution=false/);
  assert.match(calendar,/dailyLeadDistribution\.total/);
  assert.match(
    calendar,
    /\.find\(item=>item\.staffId===assignee\)/
  );
  assert.match(calendar,/\['distributed_today','توزيع اليوم'\]/);
  assert.match(calendar,/if\(filter==='distributed_today'\)return true/);
  assert.match(calendar,/dailyLeadDistribution\.items/);
  assert.match(calendar,/إجمالي توزيع اليوم/);
  assert.match(calendar,/تلقائي \+ يدوي · بدون مهام المتابعة/);
  assert.match(calendar,/task\.distributionStrategy==='selected'/);
  assert.match(
    api,
    /dailyLeadDistribution=reassignment\.dailyLeadDistribution/
  );
  assert.match(api,/items:\(dailyLeadDistribution\.items\|\|\[\]\)\.map\(enrichTask\)/);
  assert.match(theme,/calendar-distribution-card/);
  assert.match(theme,/repeat\(auto-fit,minmax\(190px,1fr\)\)/);
});
