import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const migration=readFileSync(
  'supabase/migrations/20260826181000_registration_email_admin_cancel_v1.sql',
  'utf8'
);
const route=readFileSync('app/api/platform/registration-requests/route.js','utf8');
const ui=readFileSync('components/platform-registration-requests.js','utf8');

test('admin email cancellation is permissioned, versioned, and pre-provision only',()=>{
  assert.match(migration,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(migration,/p_expected_version<>v_request\.version/);
  assert.match(migration,/activation_mode<>'email_verified_trial'/);
  assert.match(migration,/status<>'pending_review'/);
  assert.match(migration,/email_confirmed_at is not null/);
  assert.match(migration,/provisioned_tenant_id is not null/);
});

test('admin cancellation invalidates capabilities and preserves an audit trail',()=>{
  assert.match(migration,/registration_email_cancel_siblings\(v_request\.id\)/);
  assert.match(migration,/delivery\.state='accepted'/);
  assert.match(migration,/set status='rejected'/);
  assert.match(migration,/email_confirmation_token_hash=null/);
  assert.match(migration,/email_confirmation_expires_at=null/);
  assert.match(migration,/'emailConfirmationInvalidated',true/);
  assert.match(migration,/write_audit\(/);
  assert.match(migration,/to authenticated/);
  assert.doesNotMatch(migration,/insert into core\.(tenants|organizations)/i);
  assert.doesNotMatch(migration,/update core\.(tenants|organizations)/i);
});

test('route and UI expose the dedicated cancellation action',()=>{
  assert.match(route,/'cancel_email_registration'/);
  assert.match(route,/'v1_platform_registration_email_cancel'/);
  assert.match(route,/p_category:payload\.category/);
  assert.match(route,/registration_email_cancel_not_allowed:1/);
  assert.match(ui,/runAction\('cancel_email_registration'/);
  assert.match(ui,/رفض وإبطال الرابط/);
  assert.match(ui,/إذا سبق تأكيد البريد فلن ينفذ الإجراء/);
  assert.match(ui,/لم تُنشأ مساحة بعد/);
  assert.match(ui,/automaticWorkspaceReady/);
});
