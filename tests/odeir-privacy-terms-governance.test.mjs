import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const privacy=read('supabase/migrations/20260828203000_odeir_privacy_policy_governance_v1.sql');
const terms=read('supabase/migrations/20260828203100_odeir_terms_subscription_governance_v1.sql');
const presentation=read('supabase/migrations/20260828203200_odeir_legal_pages_presentation_v1.sql');
const legalMigrations=[privacy,terms,presentation].join('\n');

test('legal governance migrations scope writes to ODEIR public legal pages',()=>{
  assert.match(legalMigrations,/site_key='marktone-main'/);
  assert.match(privacy,/slug='privacy-policy'/);
  assert.match(terms,/slug='terms-of-use'/);
  assert.match(legalMigrations,/website_builder_validate_document/);
  assert.match(legalMigrations,/content_document_versions/);
  assert.doesNotMatch(legalMigrations,/core\.tenants|access_control\.tenant_members|sales_core\.|work_core\.|academy\.|people\./i);
});

test('privacy policy includes lifecycle, rights, and secure exit choices',()=>{
  assert.match(privacy,/تسليم آمن للبيانات أو حذف نهائي/);
  assert.match(privacy,/العلم والوصول/);
  assert.match(privacy,/الحصول على نسخة/);
  assert.match(privacy,/التصحيح والاستكمال/);
  assert.match(privacy,/الإتلاف أو سحب الموافقة/);
  assert.match(privacy,/النقل عبر الحدود/);
});

test('terms reserve a flexible free plan and a responsible cancellation path',()=>{
  assert.match(terms,/عدد المستخدمين والأدوار/);
  assert.match(terms,/المساحة والملفات/);
  assert.match(terms,/تعديل أو استبدال الخطة/);
  assert.match(terms,/يجوز للمنشأة إلغاء الخدمة في أي وقت/);
  assert.match(terms,/الاستخدام المستقبلي/);
  assert.match(terms,/لا يجوز استبعادها/);
});

test('legal pages receive responsive branded presentation',()=>{
  assert.match(presentation,/odeir-legal-toc/);
  assert.match(presentation,/odeir-policy-hero/);
  assert.match(presentation,/odeir-terms-hero/);
  assert.match(presentation,/@media\(max-width:560px\)/);
});

test('free registration page makes no lifetime or no-expiry promise',()=>{
  const metadata=read('app/free-trial/apply/page.js');
  const wrapper=read('components/lifetime-free-application.js');
  assert.doesNotMatch(metadata,/مدى الحياة|دون مدة انتهاء/);
  assert.doesNotMatch(wrapper,/مدى الحياة|لا توجد مدة انتهاء|بلا مدة انتهاء/);
  assert.match(wrapper,/حدود الخطة المجانية الحالية/);
  assert.match(wrapper,/توسّع حسب احتياج منشأتك/);
});
