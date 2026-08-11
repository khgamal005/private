import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('tenant menu separates core training, licensed LMS, add-ons and services',async()=>{
  const shell=await read('components/workspace-shell.js');
  const addonsStart=shell.indexOf("label:'إضافات مُدار'");
  const servicesStart=shell.indexOf("label:'متجر الخدمات'",addonsStart);
  assert.notEqual(addonsStart,-1);
  assert.notEqual(servicesStart,-1);
  const addonsGroup=shell.slice(addonsStart,servicesStart);

  assert.match(shell,/label:'الدبلومات والدورات',href:`\$\{base\}\/courses`/);
  assert.match(shell,/label:'منصة التدريب التفاعلي',href:`\$\{base\}\/lms`/);
  assert.match(shell,/visible:policy\.showInteractiveTraining&&hasAddon\('lms'\)/);
  assert.match(addonsGroup,/label:'الإضافات المثبتة'/);
  assert.match(addonsGroup,/label:'إضافة جديدة'/);
  assert.doesNotMatch(addonsGroup,/متجر الخدمات/);
  assert.match(shell,/key:'servicesStore',label:'متجر الخدمات',href:/);
});

test('add-on navigation and protected pages use the same database entitlement',async()=>{
  const [layout,api,auth,lms,marketing,website,integrations,actions]=await Promise.all([
    read('app/tenant/[slug]/layout.js'),
    read('lib/api.js'),
    read('lib/server-auth.js'),
    read('app/tenant/[slug]/lms/page.js'),
    read('app/tenant/[slug]/marketing/page.js'),
    read('app/tenant/[slug]/website/page.js'),
    read('app/tenant/[slug]/integrations/page.js'),
    read('app/api/tenant/[action]/route.js')
  ]);

  assert.match(api,/v3_tenant_addon_navigation_snapshot/);
  assert.match(layout,/addonAccess=\{addonAccess\}/);
  assert.match(auth,/export async function requireTenantAddon/);
  assert.match(auth,/enabledProductKeys/);
  assert.match(lms,/requireTenantAddon\(slug,'lms'/);
  assert.match(marketing,/requireTenantAddon\(slug,'marketing_attribution'/);
  assert.match(website,/requireTenantAddon\(slug,'cms_pro'/);
  assert.match(integrations,/\['woocommerce','salla','zid','shopify','custom_store'\]/);
  assert.match(actions,/'save-course-run':\['lms'\]/);
  assert.match(actions,/addon_access_check_failed/);
});

test('settings fetch and render only installed add-on capabilities',async()=>{
  const [api,settings,hub,center]=await Promise.all([
    read('lib/api.js'),
    read('components/tenant-settings.js'),
    read('components/integration-hub.js'),
    read('components/addon-center.js')
  ]);

  assert.match(api,/enabled\.has\('automation'\)/);
  assert.match(api,/enabled\.has\('delivery_analytics'\)/);
  assert.doesNotMatch(settings,/AddonCenter/);
  assert.match(settings,/ADDON_TABS/);
  assert.match(settings,/enabledProductKeys=\{enabledProductKeys\}/);
  assert.match(hub,/enabledChannels\.has\(key\)/);
  assert.match(center,/الإضافات المثبتة/);
  assert.doesNotMatch(center,/\['available','المتاحة'\]/);
});

test('LMS migration is additive, preserves Reef, and leaves founder add-ons empty',async()=>{
  const [migration,founder]=await Promise.all([
    read('supabase/migrations/20260812110000_lms_addon_navigation_gates.sql'),
    read('supabase/migrations/20260811210000_modaar_founder_core.sql')
  ]);
  const executable=migration
    .replace(/\/\*[\s\S]*?\*\//g,' ')
    .replace(/--[^\r\n]*/g,' ')
    .replace(/on\s+delete\s+(?:restrict|cascade|set\s+null)/gi,' ');

  assert.doesNotMatch(executable,/\b(?:delete\s+from|truncate|drop\s+(?:table|schema))\b/i);
  assert.match(migration,/'addon\.training\.lms'/);
  assert.match(migration,/public\.v3_tenant_addon_navigation_snapshot/);
  assert.match(migration,/tenant-reef-skills/);
  assert.match(migration,/period_is_authoritative/);
  assert.match(migration,/lifecycle_protected_until/);
  assert.doesNotMatch(migration,/tenant-modaar-training-center/);
  assert.match(founder,/modaar_founder_center_must_start_without_addons/);
  assert.doesNotMatch(founder,/platform_owner_subject_not_found/);
});
