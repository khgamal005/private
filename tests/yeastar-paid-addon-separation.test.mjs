import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('Yeastar is a dedicated paid add-on area, not a settings tab',async()=>{
  const [shell,reports,legacy,settingsPage,addonCenter]=await Promise.all([
    read('components/workspace-shell.js'),
    read('components/yeastar-reports.js'),
    read('app/tenant/[slug]/call-reports/page.js'),
    read('app/tenant/[slug]/yeastar/settings/page.js'),
    read('components/addon-center.js')
  ]);

  assert.match(shell,/label:'إضافة Yeastar'/);
  assert.match(shell,/yeastarAccess\?\.enabled&&yeastarAccess\?\.visible/);
  assert.match(shell,/\/yeastar/);
  assert.match(shell,/إعدادات الربط/);
  assert.doesNotMatch(shell,/\/call-reports.+tenant\.crm\.read/);

  assert.match(reports,/\/yeastar\/settings/);
  assert.match(reports,/canManage&&<Link/);
  assert.doesNotMatch(reports,/encodeURIComponent\(slug\)\}\/settings/);

  assert.match(legacy,/redirect\(/);
  assert.match(legacy,/\/yeastar/);
  assert.match(settingsPage,/tenant\.settings\.manage/);
  assert.match(settingsPage,/مستقل تمامًا عن/);
  assert.match(addonCenter,/فتح إضافة Yeastar/);
});

test('every Yeastar entry point is protected by the paid entitlement',async()=>{
  const [migration,api,edge,page,layout,errorCopy]=await Promise.all([
    read('supabase/migrations/20260806220000_separate_yeastar_paid_addon.sql'),
    read('app/api/yeastar/[action]/route.js'),
    read('supabase/functions/yeastar-sync/index.ts'),
    read('app/tenant/[slug]/yeastar/page.js'),
    read('app/tenant/[slug]/layout.js'),
    read('lib/yeastar-errors.js')
  ]);

  assert.match(migration,/tenant_addon_installed\(p_tenant_id, 'yeastar'\)/);
  assert.match(migration,/addon\.integration\.yeastar/);
  assert.match(migration,/v3_tenant_yeastar_access_snapshot/);
  assert.match(migration,/v3_tenant_yeastar_reports_snapshot/);
  assert.match(migration,/v3_tenant_yeastar_settings_snapshot/);
  assert.match(migration,/v3_tenant_yeastar_authorize/);
  assert.match(migration,/yeastar_addon_not_enabled/);
  assert.match(migration,/set search_path = ''/);
  assert.match(migration,/revoke all on function[\s\S]*from public, anon/);
  assert.match(migration,/grant execute on function[\s\S]*to authenticated/);

  assert.match(api,/v3_tenant_yeastar_settings_snapshot/);
  assert.match(api,/v3_tenant_yeastar_staff_options/);
  assert.match(api,/v3_tenant_yeastar_save_with_assignments/);
  assert.match(api,/yeastar_addon_not_enabled/);
  assert.match(edge,/v3_tenant_yeastar_authorize/);
  assert.match(page,/v3_tenant_yeastar_reports_snapshot/);
  assert.match(layout,/getTenantYeastarAccess/);
  assert.match(layout,/enabled:false/);
  assert.match(errorCopy,/IP FORBIDDEN/);
  assert.match(errorCopy,/عنوان خروج ثابت/);
  assert.match(edge,/70087/);
  assert.match(edge,/yeastar_ip_forbidden/);
});
