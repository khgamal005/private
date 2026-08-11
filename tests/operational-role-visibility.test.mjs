import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260802233000_operational_role_visibility_and_personal_reports.sql';

test('focused operational roles share one explicit navigation policy',async()=>{
  const [policy,shell,layout]=await Promise.all([
    read('lib/tenant-role-policy.js'),
    read('components/workspace-shell.js'),
    read('app/tenant/[slug]/layout.js')
  ]);

  for(const role of [
    'sales_user',
    'sales_supervisor',
    'data_officer',
    'data_analyst'
  ])assert.match(policy,new RegExp(`'${role}'`));

  assert.match(policy,/showNews:!focused/);
  assert.match(policy,/showInteractiveTraining:!focused/);
  assert.match(policy,/showMarketingAutomation:!focused/);
  assert.match(policy,/showTeam:!focused/);
  assert.match(policy,/DATA_CAMPAIGN_ROLE_SET\.has\(roleKey\)/);
  assert.match(shell,/tenantRolePolicy\(roleKey,\{platformAccess\}\)/);
  assert.match(shell,/visible:policy\.showNews/);
  assert.match(shell,/visible:policy\.showInteractiveTraining/);
  assert.match(shell,/visible:policy\.showMarketingAutomation/);
  assert.match(shell,/visible:policy\.showTeam/);
  assert.match(shell,/visible:policy\.showCampaignReports/);
  assert.match(shell,/policy\.personalReportsOnly\?'أدائي':'أداء الموظفين'/);
  assert.match(shell,/child\.visible!==false/);
  assert.match(layout,/roleKey=\{navigationRoleKey\}/);
});

test('hidden navigation destinations also enforce server route guards',async()=>{
  const [news,team,campaigns]=await Promise.all([
    read('app/tenant/[slug]/news/page.js'),
    read('app/tenant/[slug]/team/page.js'),
    read('app/tenant/[slug]/reports/campaigns/page.js')
  ]);

  assert.match(news,/tenantRolePolicyFromContext/);
  assert.match(news,/\.showNews/);
  assert.match(news,/redirect\(`/);
  assert.match(team,/tenantRolePolicyFromContext/);
  assert.match(team,/\.showTeam/);
  assert.match(team,/redirect\(`/);
  assert.match(campaigns,/tenantRolePolicyFromContext/);
  assert.match(campaigns,/\.showCampaignReports/);
  assert.match(campaigns,/redirect\(`/);
});

test('reports render personal performance and hide unavailable report links',async()=>{
  const [employees,center,api,calls]=await Promise.all([
    read('app/tenant/[slug]/reports/employees/page.js'),
    read('components/reporting-center.js'),
    read('lib/api.js'),
    read('app/tenant/[slug]/yeastar/page.js')
  ]);

  assert.match(employees,/data\?\.viewer\?\.scope==='employee'/);
  assert.match(employees,/\?'employee'/);
  assert.match(center,/availability\[capability\]!==false/);
  assert.match(center,/personalOnly\?'أدائي':'أداء الموظفين'/);
  assert.match(center,/availability\.campaigns!==false/);
  assert.match(api,/v4_tenant_reports_snapshot/);
  assert.match(calls,/v3_tenant_yeastar_reports_snapshot/);
});

test('Supabase boundary forces own staff and mapped call extensions',async()=>{
  const sql=await read(migrationPath);

  assert.match(sql,/v_role_key in \([\s\S]*'sales_user'[\s\S]*'sales_supervisor'[\s\S]*'data_officer'[\s\S]*'data_analyst'/);
  assert.match(sql,/p_staff_id is distinct from v_current_staff_id/);
  assert.match(sql,/case when v_personal_only[\s\S]*then v_current_staff_id/);
  assert.match(sql,/p_report = 'campaigns' and not v_campaign_allowed/);
  assert.match(sql,/v_role_key in \('data_officer', 'data_analyst'\)/);
  assert.match(sql,/record\.involved_extensions && v_staff_extensions/);
  assert.match(sql,/not \(p_extension = any\(v_staff_extensions\)\)/);
  assert.match(sql,/\{availability,team\}[\s\S]*'false'::jsonb/);
  assert.match(sql,/revoke all on function public\.v2_tenant_reports_snapshot_v1[\s\S]*from authenticated/);
  assert.match(sql,/revoke all on function public\.v2_tenant_yeastar_reports_snapshot\([\s\S]*from authenticated/);
  assert.match(sql,/grant execute on function public\.v2_tenant_reports_snapshot_v2[\s\S]*to authenticated, service_role/);
  assert.match(sql,/grant execute on function public\.v2_tenant_yeastar_reports_snapshot_v2[\s\S]*to authenticated, service_role/);
});
