import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const content=await readFile(new URL('lib/role-guide-content.js',root),'utf8');
const component=await readFile(new URL('components/my-role-guide.js',root),'utf8');
const css=await readFile(new URL('components/my-role-guide.module.css',root),'utf8');
const api=await readFile(new URL('app/api/role-guide/route.js',root),'utf8');
const migration=await readFile(
  new URL('supabase/migrations/20260802232000_role_guide_v1.sql',root),
  'utf8'
);

test('role guide covers every operational tenant role',()=>{
  for(const role of [
    'tenant_owner','tenant_admin','executive_manager','sales_manager',
    'sales_supervisor','sales_user','customer_service','data_officer',
    'data_analyst','training_manager','platform_owner','member'
  ])assert.match(content,new RegExp(`${role}:`));
});

test('role guide includes page-aware and role-aware guidance',()=>{
  for(const page of [
    'overview','news','tasks','courses','sales','lead-queue','incentives',
    'admissions','team','reports','call-reports','settings','integrations'
  ])assert.match(content,new RegExp(`['"]?${page.replace('-','\\-')}['"]?:`));
  assert.match(content,/buildWorkspaceTour/);
  assert.match(content,/buildPageTour/);
  assert.match(content,/hrefForGuide/);
});

test('client guide provides automatic welcome, skip, checklist and spotlight tour',()=>{
  for(const pattern of [
    /mt-role-guide-launcher/,
    /WelcomeDialog/,
    /DailyChecklist/,
    /TourOverlay/,
    /تخطي الآن/,
    /لا تظهر الجولة تلقائيًا مرة أخرى/,
    /يتم حفظ تقدمك تلقائيًا داخل حسابك/
  ])assert.match(component,pattern);
  assert.match(css,/position:fixed/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/@media\(max-width:760px\)/);
});

test('guide persistence is tenant isolated and not directly exposed',()=>{
  for(const pattern of [
    /people\.role_guide_progress/,
    /private_app\.can_access_tenant/,
    /subject\.auth_user_id = auth\.uid\(\)/,
    /enable row level security/,
    /revoke all on table people\.role_guide_progress/,
    /v2_tenant_role_guide_snapshot/,
    /v2_tenant_role_guide_action/
  ])assert.match(migration,pattern);
  assert.doesNotMatch(migration,/grant\s+all[\s\S]+to\s+anon/i);
});

test('API uses the signed-in access cookie and public RPC boundary',()=>{
  assert.match(api,/ACCESS_COOKIE/);
  assert.match(api,/v2_tenant_role_guide_snapshot/);
  assert.match(api,/v2_tenant_role_guide_action/);
  assert.match(api,/Authorization:`Bearer \$\{token\}`/);
  assert.doesNotMatch(api,/SERVICE_ROLE|service_role/i);
});
