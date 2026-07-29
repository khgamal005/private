import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('tenant staff password reset remains server-only and permission-scoped',async()=>{
  const route=await read('../app/api/tenant/reset-staff-password/route.js');
  const adminConfig=await read('../lib/admin-config.js');
  const publicConfig=await read('../lib/config.js');
  const migration=await read('../supabase/migrations/20260729170000_add_tenant_staff_password_reset.sql');

  assert.match(adminConfig,/server-only/);
  assert.match(adminConfig,/SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(adminConfig,/NEXT_PUBLIC_SUPABASE_SECRET/);
  assert.doesNotMatch(publicConfig,/SUPABASE_SECRET|SERVICE_ROLE/);
  assert.match(route,/\/auth\/v1\/admin\/users\//);
  assert.match(route,/SUPABASE_SECRET_KEY/);
  assert.match(route,/v2_tenant_prepare_staff_password_reset/);
  assert.match(route,/v2_tenant_complete_staff_password_reset/);
  assert.match(route,/randomInt/);
  assert.match(route,/shownOnce:true/);
  assert.doesNotMatch(route,/console\.(?:log|error)/);
  assert.match(migration,/tenant\.users\.reset_password/);
  assert.match(migration,/to service_role/);
  assert.match(migration,/auth\.jwt\(\) ->> 'role'/);
  assert.doesNotMatch(migration,/password\s+text|temporary_password/i);
});

test('the team UI exposes one-time temporary passwords only for eligible accounts',async()=>{
  const page=await read('../app/tenant/[slug]/team/page.js');
  const team=await read('../components/team-directory.js');
  const styles=await read('../app/rebuild.css');

  assert.match(page,/tenant\.users\.reset_password/);
  assert.match(page,/viewerMembershipId/);
  assert.match(team,/إعادة تعيين كلمة المرور/);
  assert.match(team,/إنشاء كلمة مرور مؤقتة/);
  assert.match(team,/temporaryPassword/);
  assert.match(team,/navigator\.clipboard\.writeText/);
  assert.match(team,/staffMember\.accountStatus!=='active'/);
  assert.match(team,/viewerRank>roleRank/);
  assert.match(team,/aria-modal="true"/);
  assert.match(styles,/\.mt-password-reset-modal>\.mt-form/);
  assert.match(styles,/overflow-x:hidden/);
  assert.match(styles,/\.mt-password-reset-modal \.mt-confirm-reset input\[type="checkbox"\]/);
  assert.match(styles,/width:18px!important/);
});

test('forced password change blocks tenant and platform access until completion',async()=>{
  const auth=await read('../lib/server-auth.js');
  const migration=await read('../supabase/migrations/20260729170000_add_tenant_staff_password_reset.sql');
  const changeRoute=await read('../app/api/auth/change-password/route.js');

  assert.match(auth,/subject\?\.mustChangePassword\)redirect\('\/change-password'\)/);
  assert.match(migration,/set must_change_password = true/);
  assert.match(migration,/not s\.must_change_password/);
  assert.match(changeRoute,/v2_mark_password_changed/);
});
