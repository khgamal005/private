import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('public homepage is served from CMS v3 builder content',async()=>{
  const page=await read('app/page.js');
  assert.match(page,/getCmsPublicSnapshot/);
  assert.match(page,/BuiltPublicPage/);
  assert.match(page,/isBuilderDocument/);
});

test('modern Marktone homepage stays editable in Builder Pro',async()=>{
  const files=[
    'supabase/migrations/20260804204500_modern_marktone_homepage_base.sql',
    'supabase/migrations/20260804204510_modern_marktone_homepage_blocks_01.sql',
    'supabase/migrations/20260804204520_modern_marktone_homepage_blocks_02.sql',
    'supabase/migrations/20260804204530_modern_marktone_homepage_blocks_03.sql',
    'supabase/migrations/20260804204540_modern_marktone_homepage_blocks_04.sql',
    'supabase/migrations/20260804204550_modern_marktone_homepage_blocks_05.sql',
    'supabase/migrations/20260804204600_modern_marktone_homepage_publish.sql'
  ];
  const source=(await Promise.all(files.map(read))).join('\n');
  for(const pattern of [
    /mt-home-hero-row/,
    /Marktone Command Center/,
    /mt-platform-section/,
    /إدارة علاقات العملاء CRM/,
    /الأسئلة الشائعة/,
    /website_builder_validate_document/,
    /content_document_versions/,
    /jsonb_array_length\(coalesce\(v_document->'blocks'/
  ])assert.match(source,pattern);
});
