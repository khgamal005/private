import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const [migration,route,api,shell,plans,subscriptions,services,payments,addons]=await Promise.all([
  read('supabase/migrations/20260812100000_modaar_saas_commerce_control_v1.sql'),
  read('app/api/platform/[action]/route.js'),read('lib/api.js'),read('components/workspace-shell.js'),
  read('components/platform-plans.js'),read('components/platform-subscriptions.js'),
  read('components/platform-services.js'),read('components/platform-payments.js'),
  read('components/platform-addon-console.js')
]);

test('commerce control migration is additive and tenant safe',()=>{
  assert.match(migration,/Additive only: no tenant, Reef, subscription, order, customer or employee data is removed/);
  assert.doesNotMatch(migration,/\b(?:drop\s+(?:table|schema)|delete\s+from|truncate(?:\s+table)?)\b/i);
  assert.equal((migration.match(/\bbegin\s*;/gi)||[]).length,1);
  assert.equal((migration.match(/\bcommit\s*;/gi)||[]).length,1);
  assert.match(migration,/create table if not exists catalog\.plan_limit_definitions/);
  assert.match(migration,/create table if not exists catalog\.plan_limits/);
  assert.match(migration,/create table if not exists catalog\.addon_categories/);
});

test('free and paid plans have enforceable resource criteria',()=>{
  for(const key of ['max_employees','max_students','max_courses','max_leads','max_branches','storage_gb'])assert.match(migration,new RegExp(`'${key}'`));
  assert.match(migration,/private_app\.enforce_tenant_plan_limit/);
  assert.match(migration,/memberships_plan_limit_v4/);
  assert.match(migration,/students_plan_limit_v4/);
  assert.match(migration,/courses_plan_limit_v4/);
  assert.match(migration,/contacts_plan_limit_v4/);
  assert.match(migration,/if v_used>=v_limit_value then\s+raise exception 'plan_limit_reached'/);
  assert.match(migration,/does not|no tenant/i);
});

test('commerce RPCs are permission checked and exposed only through authenticated execution',()=>{
  assert.match(migration,/create or replace function public\.v4_platform_commerce_snapshot\(\)/);
  assert.match(migration,/create or replace function public\.v4_platform_commerce_action\(/);
  assert.match(migration,/private_app\.has_platform_permission\('platform\.billing\.manage'\)/);
  assert.match(migration,/revoke all on function public\.v4_platform_commerce_snapshot\(\) from public,anon,authenticated/);
  assert.match(migration,/revoke all on function private_app\.enforce_tenant_plan_limit\(uuid,text\) from public,anon,authenticated/);
  assert.match(migration,/grant execute on function public\.v4_platform_commerce_action\(text,jsonb\) to authenticated/);
  assert.match(route,/'commerce':'v4_platform_commerce_action'/);
  assert.match(api,/export async function getPlatformCommerce/);
});

test('platform navigation separates catalogs, subscriptions and collection',()=>{
  for(const path of ['/control/plans','/control/addons','/control/services','/control/subscriptions','/control/payments','/control/payment-providers'])assert.match(shell,new RegExp(path.replaceAll('/','\\/')));
  assert.match(shell,/label:'المنتجات والمتاجر'/);
  assert.match(shell,/label:'الاشتراكات والتحصيل'/);
});

test('each SaaS control surface is operational rather than a static card',()=>{
  assert.match(plans,/save_plan_limits/);
  assert.match(plans,/حدود الباقة/);
  assert.match(subscriptions,/set_subscription/);
  assert.match(services,/save_service_category/);
  assert.match(services,/save_service_product/);
  assert.match(payments,/confirm_payment/);
  assert.match(addons,/payment-provider-secret/);
  assert.match(addons,/save_addon_category/);
  assert.match(addons,/assign_addon_category/);
});
