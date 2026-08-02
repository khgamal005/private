import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('sales team assignments persist through a tenant-scoped RPC and live inside employee data',async()=>{
  const [sql,directory,route,page]=await Promise.all([
    read('supabase/migrations/20260802234000_sales_teams_and_achievement_board_v1.sql'),
    read('components/team-directory.js'),
    read('app/api/tenant/sales-teams/route.js'),
    read('app/tenant/[slug]/team/page.js')
  ]);
  assert.match(sql,/supervisor_staff_id/);
  assert.match(sql,/v2_tenant_assign_sales_team_member/);
  assert.match(sql,/tenant\.people\.manage/);
  assert.match(directory,/name="supervisor_staff_id"/);
  assert.match(directory,/assignSalesSupervisor/);
  assert.match(directory,/المشرف المباشر/);
  assert.match(route,/v2_tenant_assign_sales_team_member/);
  assert.doesNotMatch(page,/SalesTeamAssignments/);
  assert.match(page,/salesTeams=\{salesTeams\}/);
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
