import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('sales team assignments persist through a tenant-scoped RPC',async()=>{
  const [sql,component,route]=await Promise.all([
    read('supabase/migrations/20260802234000_sales_teams_and_achievement_board_v1.sql'),
    read('components/sales-team-assignments.js'),
    read('app/api/tenant/sales-teams/route.js')
  ]);
  assert.match(sql,/supervisor_staff_id/);
  assert.match(sql,/v2_tenant_assign_sales_team_member/);
  assert.match(sql,/tenant\.people\.manage/);
  assert.match(component,/المشرف المباشر/);
  assert.match(route,/v2_tenant_assign_sales_team_member/);
});

test('achievement board is database-driven and ranks within the direct team',async()=>{
  const [sql,board,page]=await Promise.all([
    read('supabase/migrations/20260802234000_sales_teams_and_achievement_board_v1.sql'),
    read('components/achievement-board.js'),
    read('app/tenant/[slug]/page.js')
  ]);
  assert.match(sql,/dense_rank\(\)/);
  assert.match(sql,/peer\.supervisor_staff_id = v_supervisor_id/);
  assert.match(sql,/incentives_core\.events/);
  assert.match(board,/ترتيبك في المبيعات/);
  assert.match(page,/getTenantEmployeeAchievement/);
});
