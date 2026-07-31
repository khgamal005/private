import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('knowledge API uses configured Supabase origin and resilient fallback',async()=>{
  const source=await read('app/api/knowledge/[action]/route.js');
  assert.match(source,/SUPABASE_URL[\s\S]*from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/config'/);
  assert.doesNotMatch(source,/SUPABASE_URL\s*=.*\|\|\s*''/);
  assert.match(source,/v2_tenant_knowledge_snapshot/);
  assert.match(source,/warning:'يعمل القسم حاليًا بوضع القراءة الاحتياطي/);
  assert.match(source,/validatePublicUrl/);
  assert.match(source,/preview-link/);
  assert.match(source,/source-toggle/);
  assert.match(source,/raw-action/);
});

test('tenant feed exposes intelligent filters, actions, and graceful states',async()=>{
  const source=await read('components/knowledge-feed.js');
  assert.match(source,/الأهم لمنشأتك/);
  assert.match(source,/المنافسات/);
  assert.match(source,/التشريعات/);
  assert.match(source,/المحفوظات/);
  assert.match(source,/لماذا يهم هذا منشأتك/);
  assert.match(source,/الإجراء المقترح/);
  assert.match(source,/إعادة المحاولة/);
  assert.match(source,/\/api\/knowledge\/bookmark/);
  assert.match(source,/knowledge-feed\.module\.css/);
});

test('platform control room supports manual and automated publishing',async()=>{
  const source=await read('components/knowledge-admin.js');
  assert.match(source,/غرفة التحرير/);
  assert.match(source,/قائمة المراجعة/);
  assert.match(source,/المصادر والأتمتة/);
  assert.match(source,/إنشاء مسودة من رابط/);
  assert.match(source,/فحص جميع المصادر/);
  assert.match(source,/اعتماد ونشر/);
  assert.match(source,/مراجعة بشرية إلزامية/);
  assert.match(source,/knowledge-admin\.module\.css/);
});

test('knowledge migration provides isolated automation data plane',async()=>{
  const source=await read(
    'supabase/migrations/20260801010000_knowledge_intelligence_hub_v1.sql'
  );
  for(const pattern of [
    /knowledge_ingestion_runs/,
    /knowledge_raw_items/,
    /knowledge_bookmarks/,
    /enable row level security/,
    /platform\.is_platform_content_admin/,
    /private_app\.has_tenant_permission/,
    /v2_tenant_knowledge_snapshot/,
    /v2_tenant_knowledge_action/,
    /knowledge_ingestion_secret/,
    /cron\.schedule/,
    /marktone-knowledge-ingestion/
  ])assert.match(source,pattern);
  assert.doesNotMatch(source,/grant\s+all[\s\S]+to\s+anon/i);
});

test('ingestion worker authenticates, deduplicates, and requires HTTPS',async()=>{
  const source=await read('supabase/functions/knowledge-ingest/index.ts');
  assert.match(source,/knowledge_ingestion_validate_secret/);
  assert.match(source,/platformAccess\|\|context\?\.platform_access/);
  assert.match(source,/knowledge_private_url_rejected/);
  assert.match(source,/SHA-256/);
  assert.match(source,/knowledge_raw_items/);
  assert.match(source,/source_fingerprint/);
  assert.match(source,/requires_review/);
  assert.match(source,/duplicate_count/);
});
