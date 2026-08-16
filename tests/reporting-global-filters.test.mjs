import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

async function importReporting(){
  const source=await read('lib/reporting.js');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('report date presets resolve on the server and survive report navigation',async()=>{
  const {REPORT_DATE_PRESETS,reportQuery,resolveReportRange}=await importReporting();
  assert.deepEqual(
    REPORT_DATE_PRESETS.map(item=>item.key),
    ['today','yesterday','last7','last30','this_month','previous_month']
  );

  assert.deepEqual(
    resolveReportRange({period:'today'},{today:'2026-08-13'}),
    {from:'2026-08-13',to:'2026-08-13',period:'today',staffId:null,page:1,limit:50}
  );
  assert.deepEqual(
    resolveReportRange({},{today:'2026-08-13'}),
    {from:'2026-07-15',to:'2026-08-13',period:'last30',staffId:null,page:1,limit:50}
  );
  assert.deepEqual(
    resolveReportRange({period:'last7'},{today:'2026-08-13'}),
    {from:'2026-08-07',to:'2026-08-13',period:'last7',staffId:null,page:1,limit:50}
  );
  assert.deepEqual(
    resolveReportRange({period:'previous_month'},{today:'2026-03-05'}),
    {from:'2026-02-01',to:'2026-02-28',period:'previous_month',staffId:null,page:1,limit:50}
  );
  assert.equal(
    resolveReportRange({from:'2026-07-01',to:'2026-07-15'},{today:'2026-08-13'}).period,
    'custom'
  );

  const query=reportQuery({
    from:'2026-08-07',
    to:'2026-08-13',
    period:'last7',
    staffId:'f5066ef2-3f3b-470a-a92f-7253b01eeae7'
  });
  const params=new URLSearchParams(query);
  assert.equal(params.get('period'),'last7');
  assert.equal(params.get('staffId'),'f5066ef2-3f3b-470a-a92f-7253b01eeae7');
});

test('dashboard dates default to month-to-date and reject unsafe ranges',async()=>{
  const {resolveDashboardRange}=await importReporting();
  assert.deepEqual(
    resolveDashboardRange({},{today:'2026-08-13'}),
    {
      from:'2026-08-01',
      to:'2026-08-13',
      period:'this_month',
      staffId:null,
      page:1,
      limit:50,
      today:'2026-08-13'
    }
  );
  assert.deepEqual(
    resolveDashboardRange(
      {period:'previous_month'},
      {today:'2026-03-05'}
    ),
    {
      from:'2026-02-01',
      to:'2026-02-28',
      period:'previous_month',
      staffId:null,
      page:1,
      limit:50,
      today:'2026-03-05'
    }
  );
  assert.deepEqual(
    resolveDashboardRange(
      {from:'2024-01-01',to:'2027-01-01'},
      {today:'2026-08-13'}
    ),
    {
      from:'2025-08-13',
      to:'2026-08-13',
      period:'custom',
      staffId:null,
      page:1,
      limit:50,
      today:'2026-08-13'
    }
  );
  assert.equal(
    resolveDashboardRange(
      {period:'unknown'},
      {today:'2026-08-13'}
    ).period,
    'this_month'
  );
  assert.deepEqual(
    resolveDashboardRange(
      {from:'2026-08-20',to:'2026-08-10'},
      {today:'2026-08-13'}
    ),
    {
      from:'2026-07-12',
      to:'2026-08-10',
      period:'custom',
      staffId:null,
      page:1,
      limit:50,
      today:'2026-08-13'
    }
  );
});

test('the overview employee filter is explicit and feeds the global report snapshot',async()=>{
  const [center,styles,api,migration]=await Promise.all([
    read('components/reporting-center.js'),
    read('components/reporting-center.module.css'),
    read('lib/api.js'),
    read('supabase/migrations/20260811190000_assignment_metric_reconciliation_v1.sql')
  ]);

  assert.match(center,/REPORT_DATE_PRESETS\.map/);
  assert.match(center,/name="period"/);
  assert.match(center,/name="staffId"/);
  assert.match(center,/اسم الموظف/);
  assert.match(center,/كل الموظفين/);
  assert.match(center,/جميع المؤشرات والرسوم البيانية والجداول حسب الموظف/);
  assert.match(styles,/\.activePreset/);
  assert.match(styles,/\.filterHint/);
  assert.match(api,/v4_tenant_reports_snapshot/);
  assert.match(api,/p_staff_id:staffId\|\|null/);
  assert.match(
    migration,
    /v2_tenant_reports_snapshot_v3\(\s*p_slug,\s*p_from,\s*p_to,\s*p_staff_id,/s
  );
});
