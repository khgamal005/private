import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const corePath='supabase/migrations/20260812130000_tenant_accounting_core_v1.sql';
const indexPath='supabase/migrations/20260812132000_tenant_accounting_fk_indexes_v1.sql';

test('accounting is an always-on tenant workspace with independent ZATCA navigation',async()=>{
  const [shell,page,section,component,proxy]=await Promise.all([
    read('components/workspace-shell.js'),
    read('app/tenant/[slug]/accounting/page.js'),
    read('app/tenant/[slug]/accounting/[section]/page.js'),
    read('components/accounting-workspace.js'),
    read('proxy.js')
  ]);
  assert.match(shell,/label:'الحسابات والفوترة',children:\[/);
  assert.doesNotMatch(shell,/الحسابات والفوترة \(قريبًا\)/);
  assert.match(shell,/حسابات العملاء والمستحقات/);
  assert.match(shell,/الحوافز والعمولات/);
  assert.match(shell,/visible:hasAddon\('zatca'\)/);
  assert.match(page,/requireTenantPermission\(slug,'tenant.accounting.read'\)/);
  assert.match(section,/requireTenantAddon\(slug,'zatca'/);
  assert.match(component,/الأساسي دائمًا/);
  assert.match(component,/لا يُعد متوافقًا مع زاتكا/);
  assert.match(proxy,/\/api\/accounting/);
});

test('core migration is additive, tenant isolated and uses minor units',async()=>{
  const sql=await read(corePath);
  const executable=sql
    .replace(/\/\*[\s\S]*?\*\//g,' ')
    .replace(/--[^\r\n]*/g,' ')
    .replace(/on\s+delete\s+(?:restrict|cascade|set\s+null)/gi,' ');
  assert.doesNotMatch(executable,/\b(?:drop\s+(?:table|schema)|truncate|delete\s+from\s+(?:core|sales_core|academy|incentives_core)\.)\b/i);
  assert.match(sql,/create schema if not exists accounting_core/);
  assert.match(sql,/amount_minor bigint/g);
  assert.match(sql,/foreign key\(tenant_id,customer_account_id\)/);
  assert.match(sql,/foreign key\(tenant_id,document_id\)/);
  assert.match(sql,/unique\(tenant_id,id\)/g);
  assert.match(sql,/enable row level security/g);
  assert.match(sql,/force row level security/g);
  assert.match(sql,/revoke all on all tables in schema accounting_core/);
  assert.match(sql,/private_app.has_accounting_permission/);
  assert.match(sql,/platform.tenant_accounting.support/);
  assert.doesNotMatch(sql,/grant\s+(?:select|insert|update|delete|all)[\s\S]*?service_role/i);
});

test('documents are immutable after issue and corrections are first-class notes',async()=>{
  const sql=await read(corePath);
  assert.match(sql,/document_type in \('quote','invoice','credit_note','debit_note'\)/);
  assert.match(sql,/issued_document_immutable/);
  assert.match(sql,/accounting_document_immutable/);
  assert.match(sql,/accounting_line_immutable/);
  assert.match(sql,/document_events_append_only/);
  assert.match(sql,/document_sequences/);
  assert.match(sql,/accounting_next_number/);
  assert.doesNotMatch(sql,/document_number\s*=\s*count\s*\(/i);
});

test('collections support partial allocation, schedules, receipts and governed refunds',async()=>{
  const sql=await read(corePath);
  for(const table of [
    'payment_schedules','payments','payment_allocations','receipts',
    'collection_actions','refunds','commands'
  ])assert.match(sql,new RegExp(`create table accounting_core\\.${table}`));
  assert.match(sql,/payment_allocation_exceeds_available/);
  assert.match(sql,/payment_allocation_exceeds_invoice/);
  assert.match(sql,/refund_exceeds_payment/);
  assert.match(sql,/command_id_reused_with_different_payload/);
  assert.match(sql,/payment_status='verified'/);
  assert.match(sql,/payment_verified_at is not null/);
  assert.doesNotMatch(sql,/payment_status='verified'[\s\S]{0,300}paid_at/);
});

test('incentives remain one operational source and are converted explicitly to minor units',async()=>{
  const sql=await read(corePath);
  assert.match(sql,/'source','incentives_core.events'/);
  assert.match(sql,/round\(sum\(incentive_amount\)[\s\S]*?\*100\)/);
  assert.match(sql,/'sourceAmountUnit','major'/);
  assert.doesNotMatch(sql,/create table accounting_core\.incentive_events/);
});

test('accounting foreign keys are indexed without duplicating the existing contact index',async()=>{
  const [core,sql]=await Promise.all([read(corePath),read(indexPath)]);
  const executable=sql.replace(/--[^\r\n]*/g,' ');
  assert.doesNotMatch(core,/create\s+unique\s+index[\s\S]*?sales_contacts_tenant_id_id_accounting_idx/i);
  assert.match(sql,/drop index if exists sales_core\.sales_contacts_tenant_id_id_accounting_idx/);
  assert.equal((sql.match(/create index if not exists/g)||[]).length,29);
  for(const pattern of [
    /accounting_documents_contact_fk_idx[\s\S]*?\(tenant_id,contact_id\)/,
    /accounting_documents_parent_fk_idx[\s\S]*?\(tenant_id,parent_document_id\)/,
    /accounting_allocations_invoice_fk_idx[\s\S]*?\(tenant_id,invoice_id\)/,
    /accounting_refunds_payment_fk_idx[\s\S]*?\(tenant_id,payment_id\)/,
    /zatca_config_updated_by_idx[\s\S]*?\(updated_by_subject_id\)/
  ])assert.match(sql,pattern);
  assert.doesNotMatch(executable,/\b(?:insert\s+into|update|delete\s+from|truncate|drop\s+(?:table|schema))\b/i);
});
