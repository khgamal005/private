import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('dashboard RPC scopes employee and team data on the server',async()=>{
  const [sql,roleFix]=await Promise.all([
    read('supabase/migrations/20260730170651_role_based_employee_dashboards_v2.sql'),
    read('supabase/migrations/20260730172630_fix_role_dashboard_membership_resolution.sql')
  ]);
  assert.match(sql,/v2_tenant_role_dashboard_snapshot/);
  assert.match(sql,/private_app\.has_tenant_permission/);
  assert.match(sql,/private_app\.current_staff_id/);
  assert.match(sql,/private_app\.can_view_tenant_team/);
  assert.match(sql,/v_view_team\s+or contact\.owner_staff_id = v_staff_id/);
  assert.match(sql,/record\.involved_extensions && v_extensions/);
  assert.match(sql,/security definer/);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/revoke all on function[\s\S]*from public, anon/);
  assert.match(sql,/grant execute on function[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/service_role|SUPABASE_SECRET/i);
  assert.match(roleFix,/v2_tenant_role_dashboard_snapshot_v2/);
  assert.match(roleFix,/access_control\.membership_roles/);
  assert.match(roleFix,/private_app\.tenant_role_rank/);
  assert.match(roleFix,/role\.scope = 'tenant'/);
});

test('Yeastar mappings validate the configured extension and tenant staff',async()=>{
  const [sql,settings,route,reports]=await Promise.all([
    read('supabase/migrations/20260730170651_role_based_employee_dashboards_v2.sql'),
    read('components/yeastar-settings.js'),
    read('app/api/yeastar/[action]/route.js'),
    read('components/yeastar-reports.js')
  ]);
  assert.match(sql,/yeastar_extension_mapping_not_configured/);
  assert.match(sql,/staff\.tenant_id = v_tenant_id/);
  assert.match(sql,/staff\.employment_status = 'active'/);
  assert.match(sql,/extensionAssignments/);
  assert.match(settings,/extensionAssignment:/);
  assert.match(settings,/staffOptions/);
  assert.doesNotMatch(settings,/105 لشهد/);
  assert.doesNotMatch(reports,/row\.extension==='105'/);
  assert.match(reports,/function errorMessage\(value,fallback\)/);
  assert.match(reports,/response\.json\(\)\.catch\(\(\)=>\(\{\}\)\)/);
  assert.doesNotMatch(reports,/new Error\(payload\.error\|\|/);
  assert.match(route,/v3_tenant_yeastar_save_with_assignments/);
  assert.match(route,/Promise\.all/);
});

test('Yeastar v1 sync uses its documented range and ignores connection tests',async()=>{
  const [edge,migration,settings]=await Promise.all([
    read('supabase/functions/yeastar-sync/index.ts'),
    read('supabase/migrations/20260730185254_fix_yeastar_v1_sync_window_context.sql'),
    read('components/yeastar-settings.js')
  ]);
  assert.match(edge,/const apiVersion='v1\.0'[\s\S]*start_time:[\s\S]*end_time:/);
  assert.match(edge,/start_time:String\(Math\.floor\(from\.getTime\(\)\/1000\)\)/);
  assert.match(edge,/end_time:String\(Math\.floor\(to\.getTime\(\)\/1000\)\)/);
  assert.match(edge,/source\.new_id/);
  assert.match(edge,/source\.record_file/);
  assert.match(edge,/startedAt>=from\.getTime\(\)/);
  assert.match(edge,/startedAt<=to\.getTime\(\)/);
  assert.match(migration,/run\.trigger_type in \('manual', 'scheduled'\)/);
  assert.match(migration,/max\(coalesce\(run\.requested_to, run\.finished_at\)\)/);
  assert.match(migration,/yeastar_invalid_sync_window/);
  assert.match(migration,/grant execute on function[\s\S]*to service_role/);
  assert.match(settings,/async function fetchSettings\(slug\)/);
  assert.match(settings,/const refreshed=await fetchSettings\(slug\)/);
});

test('each operational role receives a dedicated dashboard presentation',async()=>{
  const component=await read('components/role-dashboard.js');
  for(const role of [
    'tenant_owner',
    'tenant_admin',
    'executive_manager',
    'sales_manager',
    'sales_supervisor',
    'sales_user',
    'customer_service',
    'data_officer',
    'data_analyst',
    'training_manager'
  ]){
    assert.match(component,new RegExp(`${role}:`));
  }
  assert.match(component,/لوحة أداء مسؤول المبيعات/);
  assert.match(component,/تحليل المكالمات/);
  assert.match(component,/أداء الموظفين/);
  assert.match(component,/مصادر العملاء والتحويل/);
  assert.match(component,/نطاقي الشخصي فقط/);
  assert.match(component,/خريطة أداء الفترة/);
  assert.match(component,/أهم ما يحتاج إجراء الآن/);
  assert.match(component,/نبض الإعلانات خلال الفترة/);
  assert.match(component,/تسجيلات جديدة خلال الفترة/);
});

test('owner gets the executive command center without the personal achievement board',async()=>{
  const [page,component,styles]=await Promise.all([
    read('app/tenant/[slug]/page.js'),
    read('components/role-dashboard.js'),
    read('components/role-dashboard.module.css')
  ]);

  assert.match(page,/getTenantMarketingHub/);
  assert.match(page,/resolveDashboardRange/);
  assert.match(page,/from:range\.from/);
  assert.match(page,/to:range\.to/);
  assert.match(page,/unstable_rethrow\(error\)/);
  assert.match(page,/getOptionalMarketing\(slug,range\)/);
  assert.match(page,/showAchievement=!EXECUTIVE_ROLES\.has\(resolvedRole\)/);
  assert.match(page,/shouldLoadAchievement=!EXECUTIVE_ROLES\.has\(membershipRole\)/);
  assert.match(page,/showAchievement&&<AchievementBoard/);
  assert.match(page,/marketing=\{marketing\}/);
  assert.match(component,/function SystemPillars/);
  assert.match(component,/function ExecutiveActionCenter/);
  assert.match(component,/function MarketingPulse/);
  assert.match(component,/canReadMarketing/);
  assert.match(component,/لم نعرض أرقامًا صفرية بديلة/);
  assert.match(styles,/\.pillarGrid/);
  assert.match(styles,/\.actionCenter/);
  assert.match(styles,/\.marketingMetrics/);
});

test('executive dashboard uses one tenant-local selected range and qualified flow',async()=>{
  const [component,styles,api,marketingApi,page,migration]=await Promise.all([
    read('components/role-dashboard.js'),
    read('components/role-dashboard.module.css'),
    read('lib/api.js'),
    read('lib/marketing-api.js'),
    read('app/tenant/[slug]/page.js'),
    read('supabase/migrations/20260816132000_dashboard_date_range_v1.sql')
  ]);

  assert.match(component,/أداء الفترة المحددة/);
  assert.match(component,/الإنفاق الإعلاني الفعلي خلال الفترة/);
  assert.match(component,/عملاء تأهلوا خلال الفترة/);
  assert.match(component,/إنجاز المهام المستحقة خلال الفترة/);
  assert.match(component,/مضاعف المبيعات إلى الإنفاق/);
  assert.doesNotMatch(component,/قيمة المسار/);
  assert.doesNotMatch(component,/آخر 30 يومًا/);
  assert.doesNotMatch(component,/اتجاه آخر 7 أيام داخل الشهر/);
  assert.doesNotMatch(component,/title:'الإيراد المتوقع'/);
  assert.match(styles,/grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(styles,/\.pillar\{[\s\S]*grid-column:span 2/);
  assert.match(styles,/\.metricSection/);
  assert.match(styles,/\.dateFilter/);
  assert.match(styles,/\.activePreset/);
  assert.match(api,/v2_tenant_role_dashboard_snapshot_v7/);
  assert.match(api,/p_from:from/);
  assert.match(api,/p_to:to/);
  assert.match(marketingApi,/rangeMode:monthToDate\?'month_to_date':'date_range'/);
  assert.match(page,/resolveDashboardRange/);
  assert.match(page,/getTenantRoleDashboard\(slug,range\.from,range\.to\)/);
  assert.match(migration,/v2_tenant_role_dashboard_snapshot_v7/);
  assert.match(migration,/v4_tenant_reports_snapshot/);
  assert.match(migration,/now\(\) at time zone v_timezone/);
  assert.match(migration,/'mode', case/);
  assert.match(migration,/v_from_at := v_from_date::timestamp at time zone v_timezone/);
  assert.match(migration,/v_to_at := \(v_to_date \+ 1\)::timestamp at time zone v_timezone/);
  assert.match(migration,/with first_qualified as/);
  assert.match(migration,/'qualifiedEnteredThisMonth'/);
  assert.match(migration,/with assignment_cohort as/);
  assert.match(migration,/min\(assignment\.assigned_at\) as first_assigned_at/);
  assert.match(migration,/handoff\.paid_at >= assignment\.first_assigned_at/);
  assert.match(migration,/paidFromDistributedThisMonth/);
  assert.match(migration,/handoff\.paid_at < v_to_at/);
  assert.match(migration,/taskCompletionRateThisMonth/);
  assert.match(migration,/woocommerce_range_not_cached/);
  assert.match(migration,/'rangeAvailable', false/);
  assert.match(migration,/security definer/);
  assert.match(migration,/set search_path = ''/);
  assert.match(migration,/revoke all on function[\s\S]*from public, anon/);
  assert.match(migration,/grant execute on function[\s\S]*to authenticated/);
  assert.doesNotMatch(migration,/service_role|supabase_secret/i);
});

test('tenant overview never substitutes stale metrics when the canonical RPC fails',async()=>{
  const [page,api,shell,layout]=await Promise.all([
    read('app/tenant/[slug]/page.js'),
    read('lib/api.js'),
    read('components/workspace-shell.js'),
    read('app/tenant/[slug]/layout.js')
  ]);
  assert.match(
    page,
    /getTenantRoleDashboard\(slug,range\.from,range\.to\)\.catch\(\(\)=>null\)/
  );
  assert.match(page,/unavailable:true/);
  assert.doesNotMatch(page,/task\.status!=='completed'/);
  assert.match(page,/Promise\.all/);
  assert.match(page,/RoleDashboard/);
  assert.match(api,/v2_tenant_role_dashboard_snapshot_v7/);
  assert.doesNotMatch(
    api,
    /v2_tenant_role_dashboard_snapshot_v7'[\s\S]*v2_tenant_role_dashboard_snapshot_v6/
  );
  assert.match(shell,/لوحة القيادة/);
  assert.match(layout,/training_manager:'مدير التدريب'/);
});
