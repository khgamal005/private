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
  assert.match(polish,/\.mt-navigation>a>b\{[\s\S]*?font-size:12px!important/);
  assert.match(polish,/\.mt-navigation-parent>b\{[\s\S]*?font-size:12px!important/);
  assert.match(polish,/\.mt-navigation-children a b\{font-size:10px!important/);
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
    'الدبلومات والدورات',
    'منصة التدريب التفاعلي',
    'المبيعات والعملاء',
    'التسجيل والقبول',
    'التسويق والأتمتة',
    'الحسابات والفوترة',
    'إضافات مُدار',
    'متجر الخدمات',
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
  assert.doesNotMatch(shell,/البرامج والدورات/);
  assert.match(shell,/label:'الدبلومات والدورات',href:`\$\{base\}\/courses`/);
  assert.match(shell,/label:'منصة التدريب التفاعلي',href:`\$\{base\}\/lms`/);
  assert.match(shell,/hasAddon\('lms'\)/);
  assert.match(shell,/label:'إضافات مُدار',children:\[/);
  assert.match(shell,/label:'الإضافات المثبتة'/);
  assert.match(shell,/label:'إضافة جديدة'/);
  assert.match(shell,/key:'servicesStore',label:'متجر الخدمات',href:/);
  assert.match(shell,/label:'توزيع العملاء'/);
  assert.doesNotMatch(shell,/label:'الأهداف والحوافز'/);
  assert.match(shell,/label:'الحسابات والفوترة',children:\[/);
  assert.match(shell,/label:'حسابات العملاء والمستحقات'/);
  assert.match(shell,/label:'عروض الأسعار'/);
  assert.match(shell,/label:'المدفوعات والإيصالات'/);
  assert.match(shell,/label:'الحوافز والعمولات'/);
  assert.match(shell,/hasAddon\('zatca'\)/);
  assert.match(shell,/label:'مركز الحملات والتسويق'/);
  assert.match(shell,/href:`\$\{base\}\/marketing`/);
  assert.match(shell,/permission:'tenant\.marketing\.read'/);
  assert.match(shell,/label:'الأتمتة'/);
  assert.match(shell,/const \[openGroups,setOpenGroups\]/);
  assert.match(shell,/aria-disabled=\{child\.disabled\|\|undefined\}/);
  assert.match(settingsPage,/initialTab=\{query\?\.tab\}/);
  assert.match(settings,/initialTab='users'/);
  assert.match(settings,/ADDON_TABS/);
  assert.doesNotMatch(settings,/AddonCenter/);
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
  assert.match(dashboard,/صحة أداء الفترة/);
  assert.match(dashboard,/إنجاز المهام المستحقة/);
  assert.match(dashboard,/تحويل العملاء للدفع/);
  assert.match(dashboard,/\|\|EXECUTIVE_ROLES\.has\(role\)/);
  assert.match(dashboard,/styles\.metricFeatured/);
  assert.match(styles,/grid-template-columns:repeat\(12,minmax\(0,1fr\)\)/);
  assert.match(styles,/\.metricFeatured/);
  assert.match(styles,/\.healthGrid/);
});
