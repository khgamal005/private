import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('tenant navigation is one compact list with the supplied wordmark',async()=>{
  const [shell,logo,layout,polish]=await Promise.all([
    read('components/workspace-shell.js'),
    read('components/marktone-logo.js'),
    read('app/layout.js'),
    read('app/tenant-shell-polish.css')
  ]);

  assert.match(shell,/function tenantItems\(/);
  assert.doesNotMatch(shell,/التشغيل اليومي|الإدارة والمحتوى/);
  assert.match(shell,/<MarktoneLogo wordmark compact\/>/);
  assert.match(shell,/mt-notification-menu/);
  assert.match(shell,/mt-account-menu/);
  assert.match(shell,/<LogoutButton\/>/);
  assert.match(logo,/from 'next\/image'/);
  assert.match(logo,/\/marktone-logo-light\.svg/);
  assert.match(layout,/tenant-shell-polish\.css/);
  assert.match(polish,/--mt-shell-width:246px/);
  assert.match(polish,/@media\(max-width:980px\)/);
});

test('tenant navigation follows the approved business order and groups',async()=>{
  const [shell,settingsPage,settings]=await Promise.all([
    read('components/workspace-shell.js'),
    read('app/tenant/[slug]/settings/page.js'),
    read('components/tenant-settings.js')
  ]);
  const labels=[
    'لوحة القيادة',
    'الأخبار والمعارف',
    'تقويم المهام',
    'البرامج والدورات',
    'المبيعات والعملاء',
    'التسجيل والقبول',
    'التسويق والأتمتة',
    'الحسابات والفوترة (قريبًا)',
    'فريق العمل',
    'التقارير والتحليل',
    'الإعدادات والصلاحيات'
  ];
  let previous=-1;
  for(const label of labels){
    const index=shell.indexOf(`label:'${label}'`);
    assert.ok(index>previous,`${label} must keep its approved menu position`);
    previous=index;
  }
  assert.match(shell,/label:'متجر البرامج والدورات'/);
  assert.match(shell,/label:'منصة التدريب التفاعلي \(قريبًا\)'/);
  assert.match(shell,/label:'توزيع العملاء'/);
  assert.match(shell,/label:'الأهداف والحوافز'/);
  assert.match(shell,/label:'الحملات والتسويق \(قريبًا\)'/);
  assert.match(shell,/label:'الأتمتة'/);
  assert.match(shell,/const \[openGroups,setOpenGroups\]/);
  assert.match(shell,/aria-disabled=\{child\.disabled\|\|undefined\}/);
  assert.match(settingsPage,/initialTab=\{query\?\.tab\}/);
  assert.match(settings,/initialTab='users'/);
});

test('toolbar notifications use live role dashboard counts',async()=>{
  const [layout,api,shell]=await Promise.all([
    read('app/tenant/[slug]/layout.js'),
    read('lib/api.js'),
    read('components/workspace-shell.js')
  ]);

  assert.match(layout,/getTenantRoleDashboard\(slug\)\.catch\(\(\)=>null\)/);
  assert.match(layout,/notificationSummary=\{headerSummary\(dashboard\)\}/);
  assert.match(layout,/tasksToday:personal\.tasksToday/);
  assert.match(layout,/pendingAdmissions:executive\.pendingAdmissions/);
  assert.match(api,/cache\(async function getTenantRoleDashboard/);
  assert.match(shell,/notificationItems\(notificationSummary,slug\)/);
  assert.match(shell,/لا توجد مهام أو تنبيهات عاجلة الآن/);
});

test('management dashboard prioritizes commercial KPIs and entity health',async()=>{
  const [dashboard,styles]=await Promise.all([
    read('components/role-dashboard.js'),
    read('components/role-dashboard.module.css')
  ]);

  assert.match(dashboard,/function ExecutiveHealth/);
  assert.match(dashboard,/صحة المنشأة/);
  assert.match(dashboard,/تفعيل حسابات الفريق/);
  assert.match(dashboard,/تحويل العملاء للدفع/);
  assert.match(dashboard,/\|\|EXECUTIVE_ROLES\.has\(role\)/);
  assert.match(dashboard,/styles\.metricFeatured/);
  assert.match(styles,/grid-template-columns:repeat\(12,minmax\(0,1fr\)\)/);
  assert.match(styles,/\.metricFeatured/);
  assert.match(styles,/\.healthGrid/);
});
