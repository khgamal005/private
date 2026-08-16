import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('dashboard filter is server-driven, accessible, and responsive',async()=>{
  const [page,component,picker,styles]=await Promise.all([
    read('app/tenant/[slug]/page.js'),
    read('components/role-dashboard.js'),
    read('components/dashboard-date-range-picker.js'),
    read('components/role-dashboard.module.css')
  ]);

  assert.match(page,/TenantOverview\(\{params,searchParams\}\)/);
  assert.match(page,/await Promise\.all\(\[params,searchParams\]\)/);
  assert.match(page,/resolveDashboardRange\(query,/);
  assert.match(page,/live\?\.tenant\?\.timezone\|\|'Asia\/Riyadh'/);
  assert.match(page,/getTenantRoleDashboard\(slug,range\.from,range\.to\)/);
  assert.match(page,/getOptionalMarketing\(slug,range\)/);
  assert.match(page,/range=\{range\}/);

  assert.match(component,/function DashboardDateFilter/);
  assert.match(component,/method="get"/);
  assert.match(component,/aria-label="تصفية لوحة القيادة حسب التاريخ"/);
  assert.match(component,/REPORT_DATE_PRESETS\.map/);
  assert.match(component,/name="period"/);
  assert.match(component,/DashboardDateRangePicker/);
  assert.match(component,/aria-pressed=/);
  assert.match(component,/المهام الأقرب والتنبيهات والحالات المعلّقة تبقى لحظية/);
  assert.match(
    component,
    /const canFilterDate=EXECUTIVE_ROLES\.has\(role\)[\s\S]*permissions\?\.crm!==false/
  );
  assert.equal((component.match(/<DashboardDateFilter/g)||[]).length,2);
  assert.match(component,/maxDate=\{maxDate\}/);
  assert.match(component,/period=this_month/);
  assert.match(component,/date>=from[\s\S]*date<=to/);
  assert.match(component,/trendBuckets\(daily\.filter/);
  assert.match(component,/function trendBuckets\(rows=\[\],maxBuckets=14\)/);
  assert.match(component,/rangeFrom===wooFrom[\s\S]*rangeTo===wooTo/);
  assert.match(component,/woo\.rangeAvailable===false/);
  assert.match(component,/function rangeHref/);
  assert.match(
    component,
    /rangeHref\(\s*`\/tenant\/\$\{slug\}\/call-reports`/
  );
  assert.match(component,/executive\.revenueCurrency\|\|'SAR'/);
  assert.match(component,/executive\.revenueMinorDigits\?\?2/);
  assert.match(component,/Number\(day\.activities\)>0\?Math\.max/);
  assert.match(component,/عملاء مسندون خلال الفترة/);

  assert.match(picker,/'use client'/);
  assert.match(picker,/type="date"[\s\S]*name="from"/);
  assert.match(picker,/type="date"[\s\S]*name="to"/);
  assert.match(picker,/max=\{maxDate\}/);
  assert.match(picker,/min=\{from\}/);
  assert.match(picker,/showPicker/);
  assert.match(picker,/onKeyDown=\{preventManualEntry\}/);
  assert.match(picker,/onPaste=\{event=>event\.preventDefault\(\)\}/);
  assert.match(picker,/onDrop=\{event=>event\.preventDefault\(\)\}/);
  assert.match(picker,/if\(next&&to&&next>to\)setTo\(next\)/);
  assert.match(picker,/if\(next&&from&&next<from\)setFrom\(next\)/);
  assert.match(picker,/ar-EG-u-ca-gregory/);
  assert.match(picker,/اختيار من التقويم/);

  assert.match(styles,/\.dateFilter\{/);
  assert.match(styles,/\.datePresets \.activePreset/);
  assert.match(styles,/\.calendarControl\{/);
  assert.match(styles,/\.calendarControl input\{[\s\S]*opacity:0/);
  assert.match(styles,/@media \(max-width:560px\)[\s\S]*\.datePresets/);
  assert.match(styles,/@media \(max-width:390px\)[\s\S]*\.dateInputs/);
});

test('one selected range reaches dashboard and marketing RPCs',async()=>{
  const [api,marketing]=await Promise.all([
    read('lib/api.js'),
    read('lib/marketing-api.js')
  ]);

  assert.match(api,/getTenantRoleDashboard\(\s*slug,\s*from=null,\s*to=null/);
  assert.match(api,/v2_tenant_role_dashboard_snapshot_v7/);
  assert.match(api,/p_from:from/);
  assert.match(api,/p_to:to/);
  assert.match(marketing,/v2_tenant_marketing_hub_snapshot/);
  assert.match(marketing,/p_from:from/);
  assert.match(marketing,/p_to:to/);
  assert.match(marketing,/rangeMode:monthToDate\?'month_to_date':'date_range'/);
});

test('dashboard RPC validates a tenant-local inclusive range securely',async()=>{
  const [sql,verify]=await Promise.all([
    read('supabase/migrations/20260816132000_dashboard_date_range_v1.sql'),
    read('scripts/verify-migrations.mjs')
  ]);

  assert.match(
    sql,
    /v2_tenant_role_dashboard_snapshot_v7\(\s*p_slug text,\s*p_from date default null,\s*p_to date default null\s*\)/s
  );
  assert.match(sql,/private_app\.has_tenant_permission/);
  assert.match(sql,/v_snapshot #>> '\{permissions,crm\}'/);
  assert.match(
    sql,
    /if not v_can_crm then\s*return v_snapshot;\s*end if;[\s\S]*v_report :=/s
  );
  assert.match(sql,/now\(\) at time zone v_timezone/);
  assert.match(sql,/v_from_at := v_from_date::timestamp at time zone v_timezone/);
  assert.match(sql,/v_to_at := \(v_to_date \+ 1\)::timestamp at time zone v_timezone/);
  assert.match(sql,/v_to_date > v_today/);
  assert.match(sql,/v_to_date - v_from_date > 365/);
  assert.match(
    sql,
    /v_report := public\.v4_tenant_reports_snapshot\(\s*p_slug,\s*v_from_date,\s*v_to_date,/s
  );
  assert.match(sql,/assignment\.assigned_at >= v_from_at/);
  assert.match(sql,/assignment\.assigned_at < v_to_at/);
  assert.match(sql,/history\.changed_at/);
  assert.match(sql,/latest_status[\s\S]*history\.changed_at < v_to_at/);
  assert.match(sql,/v2_metric_is_countable_contact/);
  assert.match(sql,/task\.status <> 'cancelled'/);
  assert.match(sql,/handoff\.paid_at >= v_from_at/);
  assert.match(sql,/enrollment\.enrolled_at >= v_from_at/);
  assert.match(sql,/session\.starts_at >= v_from_at/);
  assert.match(sql,/attendance\.marked_at >= v_from_at/);
  assert.match(sql,/certificate\.issued_at >= v_from_at/);
  assert.match(sql,/item\.value ->> 'key' in \('NO ANSWER', 'ABANDONED', 'BUSY'\)/);
  assert.doesNotMatch(
    sql,
    /lead_assignments_tenant_contact_assigned_dashboard_idx|registration_handoffs_tenant_paid_dashboard_idx/
  );
  assert.match(sql,/woocommerce_range_not_cached/);
  assert.match(sql,/'rangeAvailable', false/);
  assert.match(
    sql,
    /v_woo := \(v_woo - 'totals'\)[\s\S]*'available', false[\s\S]*'rangeAvailable', false[\s\S]*'totals', '\{\}'::jsonb/
  );
  assert.doesNotMatch(sql,/'crmMonthAvailable', true|'monthAvailable', true/);
  assert.match(sql,/security definer/);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/revoke all on function[\s\S]*from public, anon/);
  assert.match(sql,/grant execute on function[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/service_role|supabase_secret/i);
  assert.match(verify,/20260816132000_dashboard_date_range_v1\.sql/);
  assert.match(verify,/v2_tenant_role_dashboard_snapshot_v7/);
});
