import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  formatCustomerPhone,
  normalizeCustomerPhoneIdentity,
  toCustomerDialNumber,
  toWhatsAppNumber
} from '../lib/customer-phone.mjs';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260808165235_normalize_customer_phone_display.sql';

test('Saudi mobile variants display and dial as a local 05 number',()=>{
  for(const value of [
    '+966 51 234 5678',
    '00966512345678',
    '966512345678',
    '9660512345678',
    '0512345678',
    '512345678',
    '٠٥١٢٣٤٥٦٧٨'
  ]){
    assert.equal(formatCustomerPhone(value),'0512345678');
    assert.equal(toCustomerDialNumber(value),'0512345678');
    assert.equal(normalizeCustomerPhoneIdentity(value),'966512345678');
  }
});

test('non-Saudi international numbers retain their country code',()=>{
  assert.equal(formatCustomerPhone('+20 10 1234 5678'),'+20 10 1234 5678');
  assert.equal(toCustomerDialNumber('+20 10 1234 5678'),'+201012345678');
  assert.equal(formatCustomerPhone('963912345678'),'963912345678');
  assert.equal(toCustomerDialNumber('963912345678'),'963912345678');
});

test('WhatsApp keeps the international identity while Linkus gets local Saudi dialing',()=>{
  assert.equal(toCustomerDialNumber('+966512345678'),'0512345678');
  assert.equal(toWhatsAppNumber('0512345678'),'966512345678');
  assert.equal(toWhatsAppNumber('+201012345678'),'201012345678');
});

test('sales and calendar links use the dedicated phone formats',async()=>{
  const [sales,calendar]=await Promise.all([
    read('components/sales-workspace.js'),
    read('components/task-calendar-page.js')
  ]);

  assert.match(sales,/tel:\$\{toCustomerDialNumber\(contact\.phone\)\}/);
  assert.match(sales,/formatCustomerPhone\(contact\.phone\)/);
  assert.match(sales,/wa\.me\/\$\{toWhatsAppNumber/);
  assert.doesNotMatch(sales,/function digits\(/);
  assert.match(
    calendar,
    /tel:\$\{toCustomerDialNumber\(selected\.contactPhone\)\}/
  );
  assert.match(calendar,/formatCustomerPhone\(selected\.contactPhone\)/);
});

test('database migration keeps canonical identities separate from display values',async()=>{
  const migration=await read(migrationPath);

  assert.match(migration,/format_customer_phone/);
  assert.match(migration,/return '0' \|\| pg_catalog\.right\(v_identity, 9\)/);
  assert.match(migration,/normalize_lead_phone\(new\.phone\)/);
  assert.match(migration,/normalize_lead_phone\(new\.whatsapp\)/);
  assert.match(migration,/lead_import_rows_prepare_phone_fields/);
  assert.match(migration,/disable trigger sales_contacts_set_updated_at/);
  assert.match(migration,/customer_phone_backfill_changed_protected_data/);
  assert.match(migration,/international_customer_phone_preservation_failed/);
});
