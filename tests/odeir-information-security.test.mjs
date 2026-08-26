import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {getOdeirInformationSecurityContent} from '../lib/odeir-information-security-content.js';
import {getOdeirLegalContent} from '../lib/odeir-preview-content.js';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const migrationPath=
  'supabase/migrations/20260826174500_odeir_information_security_policy_v2.sql';

function migrationDocument(source){
  const match=source.match(/\$document\$\n([\s\S]*?)\n  \$document\$::jsonb/);
  assert.ok(match,'information-security builder document must be present');
  return JSON.parse(match[1]);
}

test('ODEIR information-security publication is isolated and preserves a divergent draft',async()=>{
  const migration=await read(migrationPath);
  assert.match(migration,/^begin;/);
  assert.match(migration,/commit;\s*$/);
  assert.match(migration,
    /site\.site_key='marktone-main'[\s\S]*site\.site_scope='platform'[\s\S]*site\.tenant_id is null/
  );
  assert.match(migration,
    /page\.slug='information-security'[\s\S]*page\.page_kind='legal'/
  );
  assert.match(migration,/private_app\.website_builder_validate_document/);
  assert.match(migration,
    /v_preserve_draft:=v_existing_draft is not null[\s\S]*v_existing_draft is distinct from v_previous_published/
  );
  assert.match(migration,/limit 1\s+for update of document;/);
  assert.match(migration,
    /perform 1\s+from website\.pages page[\s\S]*page\.slug='information-security'[\s\S]*for update;[\s\S]*if not found/
  );
  assert.match(migration,
    /draft_document=case when v_preserve_draft then draft_document else v_document end/
  );
  assert.match(migration,/published_document=v_document/);
  assert.match(migration,
    /private_app\.cms_record_version\([\s\S]*v_document_id,v_document,'published'/
  );
  assert.doesNotMatch(migration,/max\(version_number\)/);
  assert.doesNotMatch(migration,/delete\s+from|core\.tenants|reef_skills|شركة ريف/i);
});

test('published and static-preview information-security documents stay identical',async()=>{
  const migration=await read(migrationPath);
  const published=migrationDocument(migration);
  const preview=getOdeirInformationSecurityContent('/p').content;
  assert.deepEqual(preview,published);
  assert.equal(published.blocks.length,14);
  assert.deepEqual(
    published.blocks.map(block=>block.id),
    [
      'odeir-security-hero','odeir-security-toc','odeir-security-scope',
      'odeir-security-principles','odeir-security-controls','odeir-security-data',
      'odeir-security-incidents','odeir-security-responsibility-heading',
      'odeir-security-responsibility','odeir-security-frameworks',
      'odeir-security-framework-note','odeir-security-faq',
      'odeir-security-related','odeir-security-legal-note'
    ]
  );
});

test('ODEIR preview routes the policy through the shared document and rewrites related links',()=>{
  const direct=getOdeirInformationSecurityContent('/odeir-preview');
  const wired=getOdeirLegalContent('information-security');
  assert.deepEqual(wired,direct);
  const related=wired.content.blocks.find(block=>block.id==='odeir-security-related');
  assert.deepEqual(
    related.props.items.map(item=>item.href),
    ['/odeir-preview/privacy-policy','/odeir-preview/data-rights']
  );
  assert.equal(getOdeirLegalContent('not-a-policy'),null);
});

test('information-security copy is comprehensive, qualified, and evidence-bounded',async()=>{
  const migration=await read(migrationPath);
  const document=migrationDocument(migration);
  const text=JSON.stringify(document);
  const controls=document.blocks.find(block=>block.id==='odeir-security-controls');
  const frameworks=document.blocks.find(block=>block.id==='odeir-security-frameworks');
  const responsibility=document.blocks.find(
    block=>block.id==='odeir-security-responsibility'
  );
  assert.equal(controls.props.items.length,8);
  assert.equal(frameworks.props.items.length,9);
  assert.equal(responsibility.type,'table');
  for(const phrase of [
    'السرية','السلامة','التوافر','المساءلة','عزل منطقي للمنشآت',
    'صلاحيات مبنية على الدور','حماية أسرار التكاملات','ضبط نقاط الإدخال العامة',
    'جهة تحكم','جهة معالجة','دون تأخر غير مبرر','72 ساعة',
    'لا يمكن لأي خدمة تقنية إلغاء المخاطر بصورة مطلقة',
    'لا تعني وحدها حصول أودير على شهادة أو اعتماد'
  ]) assert.match(text,new RegExp(phrase));
  for(const reference of [
    'نظام حماية البيانات الشخصية','اللائحة التنفيذية للنظام',
    'لائحة النقل خارج المملكة','NCNICC–1:2025','DCC–1:2022','CCC–2:2024',
    'ISO/IEC 27001:2022','ISO/IEC 27002:2022','NIST CSF 2.0'
  ]) assert.match(text,new RegExp(reference));
  assert.doesNotMatch(text,
    /مضمون(?:ة)?\s*(?:100|١٠٠)\s*(?:%|٪)?|امتثال(?:نا)?\s+(?:كامل|تام)|متوافق(?:ون)?\s+بالكامل|معتمد(?:ة|ون)?\s+من\s+سدايا|حاصل(?:ة|ون)?\s+على\s+شهادة\s+ISO|حصلت\s+أودير\s+على\s+اعتماد|(?:البيانات|جميع البيانات|كل البيانات)\s+لا\s+تغادر\s+المملكة|(?:إقامة|استضافة)\s+(?:جميع|كل)\s+البيانات\s+(?:داخل|في)\s+المملكة|مراقبة\s+(?:على مدار الساعة|24\s*(?:×|x|\/)\s*7)|SOC 2|PCI DSS/i
  );
  assert.doesNotMatch(text,
    /نسخ احتياطية|RPO|RTO|MFA|WAF|CSP|تشفير جميع البيانات|مركز عمليات أمنية/i
  );
});

test('information-security references are official and the design is responsive',async()=>{
  const migration=await read(migrationPath);
  const document=migrationDocument(migration);
  const frameworks=document.blocks.find(block=>block.id==='odeir-security-frameworks');
  const css=document.settings.customCss;
  const allowedHosts=new Set(['dgp.sdaia.gov.sa','nca.gov.sa','www.iso.org','www.nist.gov']);
  for(const item of frameworks.props.items){
    const url=new URL(item.href);
    assert.equal(url.protocol,'https:');
    assert.ok(allowedHosts.has(url.hostname),`unexpected reference host: ${url.hostname}`);
  }
  assert.ok(css.length<30000);
  assert.match(css,/#06182e/);
  assert.match(css,/#08b8b1/);
  assert.match(css,/#f0c534/);
  assert.match(css,/\.odeir-security-toc\{position:sticky/);
  assert.match(css,/scroll-snap-type:x mandatory/);
  assert.match(css,/@media\(max-width:620px\)/);
  assert.match(css,/\.odeir-security-responsibility table\{font-size:11px\}/);
  assert.doesNotMatch(css,/@import|<\/style/i);
});
