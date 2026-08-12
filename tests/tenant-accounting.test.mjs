import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260812131000_tenant_accounting_zatca_addon_v1.sql';

test('accounting loader merges the independent core and ZATCA snapshots',async()=>{
  const api=await read('lib/api.js');
  assert.match(api,/export async function getTenantAccounting\(slug\)/);
  assert.match(api,/authRpc\('v1_tenant_accounting_snapshot',\{p_slug:slug\}\)/);
  assert.match(api,/authRpc\('v1_tenant_zatca_snapshot',\{p_slug:slug\}\)/);
  assert.match(api,/return \{\.\.\.accounting,zatca\}/);
});

test('accounting API authenticates, forwards only known actions, and never caches',async()=>{
  const route=await read('app/api/accounting/[action]/route.js');
  assert.match(route,/import \{accessToken\} from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/server-auth'/);
  assert.match(route,/const \{action\}=await params/);
  assert.match(route,/action!=='snapshot'/);
  assert.match(route,/v1_tenant_accounting_snapshot/);
  assert.match(route,/v1_tenant_zatca_snapshot/);
  assert.match(route,/v1_tenant_accounting_action/);
  assert.match(route,/v1_tenant_zatca_action/);
  assert.match(route,/'Cache-Control':'no-store'/);
  assert.match(route,/cache:'no-store'/);
  assert.doesNotMatch(route,/service[_-]?role/i);

  for(const action of [
    'create_customer_account','update_customer_account','create_document',
    'update_document','issue_document','cancel_document','record_payment',
    'allocate_payment','issue_receipt','create_schedule',
    'record_collection_action','request_refund','approve_refund',
    'reject_refund','complete_refund'
  ])assert.match(route,new RegExp(`'${action}'`));
  assert.match(route,/'save-zatca-config':'save_config'/);
  assert.match(route,/if\(!coreAction&&!zatcaAction\)return json\(\{error:'غير موجود'\},404\)/);
});

test('ZATCA is a contact-sales add-on and grants no tenant entitlement',async()=>{
  const sql=await read(migrationPath);
  assert.match(sql,/'addon\.accounting\.zatca'/);
  assert.match(sql,/'zatca',feature\.id/);
  assert.match(sql,/'contact_sales',0,'SAR','year'/);
  assert.match(sql,/'beta',77,'accounting'/);
  assert.match(sql,/'preserve_on_disable'/);
  assert.match(sql,/'tenant\.accounting\.zatca'/);
  assert.match(sql,/catalog\.addon_price_versions/);
  assert.doesNotMatch(sql,/insert\s+into\s+catalog\.tenant_addon_subscriptions/i);
  assert.doesNotMatch(sql,/reef[-_ ]skills/i);
});

test('ZATCA persistence is tenant scoped metadata with no provider material',async()=>{
  const sql=await read(migrationPath);
  assert.match(sql,/create schema if not exists accounting_zatca/);
  assert.match(sql,/create table accounting_zatca\.tenant_configurations/);
  assert.match(sql,/create table accounting_zatca\.submission_metadata/);
  assert.match(sql,/unique \(tenant_id,idempotency_key\)/);
  assert.match(sql,/enable row level security/g);
  assert.match(sql,/force row level security/g);
  assert.match(sql,/revoke all on table accounting_zatca\.tenant_configurations/);
  assert.match(sql,/revoke all on table accounting_zatca\.submission_metadata/);
  assert.doesNotMatch(sql,/vault\./i);
  assert.doesNotMatch(sql,/\b(secret|access_token|private_key|certificate|csid)\b/i);
  assert.doesNotMatch(sql,/\b(request_body|response_body|invoice_xml|signed_xml)\b/i);
});

test('ZATCA reads follow accounting access while writes require permission and entitlement',async()=>{
  const sql=await read(migrationPath);
  const snapshot=sql.slice(
    sql.indexOf('create or replace function public.v1_tenant_zatca_snapshot'),
    sql.indexOf('create or replace function public.v1_tenant_zatca_action')
  );
  const action=sql.slice(
    sql.indexOf('create or replace function public.v1_tenant_zatca_action')
  );
  assert.match(snapshot,/'tenant\.accounting\.read'/);
  assert.doesNotMatch(snapshot,/raise exception 'addon_required'/);
  assert.match(action,/'tenant\.zatca\.manage'/);
  assert.match(action,/tenant_addon_enabled\([\s\S]*?'addon\.accounting\.zatca'/);
  assert.match(action,/raise exception 'addon_required'/);
  assert.match(action,/p_action<>'save_config'/);
  assert.match(sql,/security definer/g);
  assert.match(sql,/set search_path=''/g);
  assert.match(sql,/grant execute on function public\.v1_tenant_zatca_snapshot\(text\)/);
  assert.match(sql,/grant execute on function public\.v1_tenant_zatca_action\(text,text,jsonb\)/);
});
