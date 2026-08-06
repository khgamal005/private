import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

const integrityPath=
  'supabase/migrations/20260806190000_customer_identity_integrity_v1.sql';
const guardsPath=
  'supabase/migrations/20260806190100_customer_identity_entrypoint_guards_v1.sql';
const advisorPath=
  'supabase/migrations/20260806190200_customer_identity_advisor_hardening_v1.sql';

test('customer identity is normalized once and unique across phone slots',async()=>{
  const migration=await read(integrityPath);

  assert.match(migration,/translate\([\s\S]+٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹/);
  assert.match(migration,/lock table[\s\S]+in share row exclusive mode/);
  assert.match(migration,/\^\(9660\?\|996\)5\[0-9\]\{8\}\$/);
  assert.match(migration,/identity_type in \('phone', 'email'\)/);
  assert.match(migration,/historical_alias/);
  assert.match(migration,/\('phone'::text, new\.phone, 'phone'::text/);
  assert.match(migration,/\('phone'::text, new\.whatsapp, 'whatsapp'::text/);
  assert.match(migration,/create unique index contact_identities_tenant_type_value_uidx/);
  assert.match(migration,/tenant_id,[\s\n]+identity_type,[\s\n]+identity_value/);
});

test('database triggers reject invalid identities and synchronize every write',async()=>{
  const migration=await read(integrityPath);

  assert.match(migration,/before insert or update of phone, whatsapp, email/);
  assert.match(migration,/after insert or update of tenant_id, phone, whatsapp, email/);
  assert.match(migration,/set source_slot = 'historical_alias'/);
  assert.match(migration,/raise exception 'invalid_phone'/);
  assert.match(migration,/raise exception 'invalid_whatsapp'/);
  assert.match(migration,/raise exception 'contact_identity_required'/);
  assert.match(migration,/contacts_email_format_check/);
  assert.match(migration,/enable row level security/);
  assert.match(migration,/revoke all on table sales_core\.contact_identities/);
});

test('private identity tables have explicit deny policies and covered keys',async()=>{
  const migration=await read(advisorPath);

  assert.match(migration,/contact_identities_tenant_contact_idx/);
  assert.match(migration,/\(tenant_id, contact_id\)/);
  assert.match(migration,/contact_identities_no_direct_access/);
  assert.match(migration,/contact_merge_archive_no_direct_access/);
  assert.equal((migration.match(/as restrictive/g)||[]).length,2);
  assert.equal((migration.match(/using \(false\)/g)||[]).length,2);
  assert.equal((migration.match(/with check \(false\)/g)||[]).length,2);
});

test('existing duplicates are merged recoverably without orphaning CRM history',async()=>{
  const migration=await read(integrityPath);

  assert.match(migration,/sales_core\.contact_merge_archive/);
  assert.match(migration,/original_record jsonb not null/);
  assert.match(migration,/identity_snapshot jsonb not null/);
  assert.match(migration,/private_app\.merge_contact_pair/);
  for(const reference of [
    'sales_core.activities',
    'sales_core.lead_status_history',
    'sales_core.lead_assignments',
    'sales_core.lead_import_rows',
    'sales_core.opportunities',
    'work_core.tasks',
    'academy.registration_handoffs',
    'academy.students',
    'marketing_hub.touchpoints',
    'marketing_hub.conversion_events'
  ])assert.match(migration,new RegExp(`update ${reference.replace('.','\\.')}`));
  assert.match(migration,/lead_assignments_one_active_contact_idx/);
  assert.match(migration,/where status = 'active'/);
});

test('all customer creation entry points share one atomic duplicate guard',async()=>{
  const guards=await read(guardsPath);
  const locks=guards.match(/pg_advisory_xact_lock/g)||[];

  assert.ok(locks.length>=3,'manual, sales, and intake writes must all lock');
  assert.match(guards,/v2_tenant_create_contact_unhardened_20260806/);
  assert.match(guards,/v2_tenant_create_sales_lead_unhardened_20260806/);
  assert.match(guards,/v2_tenant_customer_search_unhardened_20260806/);
  assert.match(guards,/v2_tenant_lead_intake_action_unhardened_20260806/);
  assert.match(guards,/private_app\.find_contact_by_identity/);
  assert.match(guards,/v_effective_phone/);
  assert.match(guards,/v_effective_email/);
  assert.match(guards,/رقم جوال أو واتساب أو بريد إلكتروني مطلوب/);
  assert.match(guards,/لم يتم إنشاء سجل مكرر/);
  assert.match(guards,/pending_import/);
  assert.match(guards,/أعيد فحصه لحظة التوزيع/);
  assert.match(guards,/'duplicatesSkipped'/);

  const distributionRecheck=guards.indexOf(
    "duplicate_kind = 'existing_contact'"
  );
  const distributionInsert=guards.lastIndexOf(
    'v_result := public.v2_tenant_lead_intake_action_unhardened_20260806'
  );
  assert.ok(distributionRecheck>0);
  assert.ok(distributionInsert>distributionRecheck);
});

test('distribution UI reports prevented duplicates instead of false success',async()=>{
  const component=await read('components/lead-intake-workspace.js');

  assert.match(component,/result\.duplicatesSkipped/);
  assert.match(component,/منع إنشاء سجل مكرر/);
  assert.match(component,/مسؤول المبيعات الحالي/);
});
