import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('all admissions documents are optional in storage and UI',async()=>{
  const [migration,workspace]=await Promise.all([
    read('supabase/migrations/20260808150000_make_admission_documents_optional.sql'),
    read('components/admissions-workspace.js')
  ]);

  assert.match(migration,/update academy\.registration_documents[\s\S]*set is_required = false/);
  assert.match(migration,/alter column is_required set default false/);
  assert.match(migration,/before insert or update of is_required/);
  assert.match(migration,/new\.is_required := false/);
  assert.match(migration,/check \(is_required = false\)/);

  assert.match(workspace,/p_is_required:false/);
  assert.match(workspace,/كل المستندات اختيارية ويمكن إتمام التسجيل بدونها/);
  assert.match(workspace,/المستندات الاختيارية/);
  assert.match(workspace,/لا تمنع التسجيل/);
  assert.doesNotMatch(workspace,/p_is_required:Boolean\(document\.required\)/);
  assert.doesNotMatch(workspace,/document\.required\?'مطلوب':'اختياري'/);
});
