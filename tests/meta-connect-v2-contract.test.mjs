import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const migrationUrl=new URL(
  'supabase/migrations/20260825190000_meta_connect_v2_oauth_control_plane.sql',
  root
);
const edgeUrl=new URL('supabase/functions/meta-oauth-v2/index.ts',root);

test('migration is additive, tenant-gated, and fail-closed',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  for(const pattern of [
    /create schema if not exists meta_connect_v2/,
    /addon\.integrations\.social_connect/,
    /'social_connect'/,
    /'draft',95,'integrations','خاص — تجريبي'/,
    /create table meta_connect_v2\.rollout_targets/,
    /create table meta_connect_v2\.kill_switches/,
    /create table meta_connect_v2\.oauth_transactions/,
    /create table meta_connect_v2\.credential_refs/,
    /force row level security/,
    /revoke all on schema meta_connect_v2 from public,anon,authenticated/,
    /legacy_meta_connection_present/,
    /private_app\.tenant_addon_enabled/,
    /private_app\.has_tenant_permission/,
    /to service_role/,
    /from public,anon,authenticated/
  ])assert.match(sql,pattern);

  assert.doesNotMatch(sql,/reef-skills/i);
  assert.doesNotMatch(
    sql,
    /(?:insert\s+into|update|delete\s+from)\s+marketing_hub\.connections/i
  );
  assert.doesNotMatch(sql,/insert\s+into\s+catalog\.tenant_addon_subscriptions/i);
  assert.match(sql,/\('oauth',false\)/);
  assert.match(sql,/\('deauthorization',false\)/);
  assert.match(sql,/\('data_deletion',false\)/);
});

test('database persists only Vault references and hashed callback material',async()=>{
  const sql=await readFile(migrationUrl,'utf8');
  assert.match(sql,/vault_secret_id uuid not null unique/);
  assert.match(sql,/vault\.create_secret/);
  assert.match(sql,/delete from vault\.secrets/);
  assert.match(sql,/payload_sha256 text not null/);
  assert.match(sql,/external_user_sha256 text not null/);
  assert.match(sql,/confirmation_sha256 text not null unique/);
  assert.doesNotMatch(sql,/\baccess_token\s+text\b/i);
  assert.doesNotMatch(sql,/signed_request\s+text/i);
});

test('edge function protects every protocol boundary',async()=>{
  const source=await readFile(edgeUrl,'utf8');
  for(const pattern of [
    /v1_tenant_meta_connect_v2_begin_oauth/,
    /v1_tenant_meta_connect_v2_claim_oauth/,
    /v1_service_meta_connect_v2_finalize_oauth/,
    /verifySignedRequest/,
    /sha256Hex\(state\)/,
    /config_id/,
    /debug_token/,
    /required_scopes_missing/,
    /META_CONNECT_V2_RETURN_ORIGIN/,
    /AbortSignal\.timeout/,
    /cache-control':'no-store/,
    /payload_too_large/
  ])assert.match(source,pattern);

  assert.doesNotMatch(source,/console\.(?:log|warn|error)\([^\n]*(?:accessToken|appSecret|signedRequest|state)/);
  assert.doesNotMatch(source,/return\s+json\([^\n]*accessToken/);
});

test('public compliance pages and callback configuration are present',async()=>{
  const [privacy,terms,deletion,config,layout]=await Promise.all([
    readFile(new URL('app/privacy/page.js',root),'utf8'),
    readFile(new URL('app/terms/page.js',root),'utf8'),
    readFile(new URL('app/data-deletion/page.js',root),'utf8'),
    readFile(new URL('supabase/config.toml',root),'utf8'),
    readFile(new URL('app/layout.js',root),'utf8')
  ]);
  assert.match(privacy,/permanentRedirect\('\/p\/privacy-policy'\)/);
  assert.match(terms,/permanentRedirect\('\/p\/terms-of-use'\)/);
  assert.match(deletion,/حذف بيانات الربط/);
  assert.match(deletion,/User Data Deletion Instructions/);
  assert.match(config,/\[functions\.meta-oauth-v2\][\s\S]*verify_jwt = false/);
  assert.match(layout,/import '\.\/legal-pages\.css'/);
});

test('private add-on UI uses its own server gateway and never calls legacy save',async()=>{
  const [page,component,route,layout]=await Promise.all([
    readFile(new URL('app/tenant/[slug]/addons/social-connect/page.js',root),'utf8'),
    readFile(new URL('components/social-connect-v2.js',root),'utf8'),
    readFile(new URL('app/api/tenant/social-connect/[action]/route.js',root),'utf8'),
    readFile(new URL('app/layout.js',root),'utf8')
  ]);
  assert.match(page,/requireTenantPermission\(slug,'tenant\.meta_connect\.read'\)/);
  assert.match(page,/v1_tenant_meta_connect_v2_snapshot/);
  assert.match(component,/legacyProtected/);
  assert.match(route,/\/functions\/v1\/meta-oauth-v2\/\$\{action\}/);
  assert.match(route,/authorization:`Bearer \$\{accessToken\}`/);
  assert.doesNotMatch(`${page}\n${component}\n${route}`,/v3_tenant_marketing_hub_action/);
  assert.doesNotMatch(route,/SERVICE_ROLE|service_role/i);
  assert.match(layout,/import '\.\/social-connect-v2\.css'/);
});
