import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';

const source=readFileSync(new URL('../ops/registration-directory/marktone-free-trial/index.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source.replace(/^import .*;\n/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const org='10000000-0000-4000-8000-000000000001';
const other='20000000-0000-4000-8000-000000000002';

test('public directory lookup matches names and preserves scope, masks and identifier semantics',async t=>{
  const db=new PGlite();
  await db.exec('create table accounts (id text, organization_id text, legal_name text, english_name text, archived_at text, merged_into_account_id text, commercial_registration text, national_registration text, external_ref text, email text, phone text, mobile text)');
  const fixtures=[
    ['one',org,'معهد القدرات للتدريب','Abilities Training Institute',null,null,'1234567890','7123456789','654321','private@example.test','0501234567',null],
    ['two',org,'مركز أَثَر القُدُرات للتدريب',null,null,null,null,null,null,null,null,null],
    ['three',org,'أكاديمية النُّخبة 2030',null,null,null,null,null,null,null,null,null],
    ['other',other,'معهد القدرات للتدريب',null,null,null,'1234567890',null,null,null,null,null],
    ['archived',org,'معهد القدرات للتدريب',null,'2026-01-01',null,'1234567890',null,null,null,null,null],
    ['merged',org,'معهد القدرات للتدريب',null,null,'one','1234567890',null,null,null,null,null],
  ];
  for(const row of fixtures) await db.query('insert into accounts values ('+row.map((_,i)=>'$'+(i+1)).join(',')+')',row);
  const requests=[];
  const ctx=createContext({Deno:{env:{get:name=>name==='SUPABASE_URL'?'https://fixture.supabase.co':name==='MARKTONE_CRM_ORGANIZATION_ID'?org:'test-secret'},serve(){}},URL,AbortSignal,console,
    fetch:async(url,options)=>{
      const u=new URL(url);requests.push({url:u,options});
      assert.equal(u.pathname,'/rest/v1/accounts');
      assert.equal(u.searchParams.get('organization_id'),'eq.'+org);
      assert.equal(u.searchParams.get('archived_at'),'is.null');
      assert.equal(u.searchParams.get('merged_into_account_id'),'is.null');
      assert.equal(u.searchParams.get('limit'),'12');
      assert.ok(options.signal,'read requests have a deadline');
      const where=['organization_id=$1','archived_at is null','merged_into_account_id is null'];const args=[org];
      const and=u.searchParams.get('and');
      if(and){
        const filters=[...and.matchAll(/(legal_name|english_name)\.imatch\."([^"]+)"/g)];
        assert.ok(filters.length);
        assert.equal('('+filters.map(x=>x[0]).join(',')+')',and,'no unparsed PostgREST operators');
        for(const [,column,pattern] of filters){args.push(pattern);where.push(column+' ~* $'+args.length);}
      }else{
        for(const column of ['commercial_registration','national_registration','external_ref']){
          const value=u.searchParams.get(column);if(value){assert.ok(value.startsWith('eq.'));args.push(value.slice(3));where.push(column+'=$'+args.length);}
        }
      }
      const rows=(await db.query('select * from accounts where '+where.join(' and ')+' order by legal_name,id limit 12',args)).rows;
      return {ok:true,json:async()=>rows};
    }});
  runInContext(compiled,ctx);
  const search=q=>{ctx.input=q;return runInContext('searchInstitutions(input)',ctx);};
  const ids=rows=>Array.from(rows,x=>x.id).sort();
  await t.test('reported phrase, swapped words and training adjective',async()=>{
    for(const q of ['القدرات التدريبية','التدريبية القدرات','القدرات للتدريب','القُدُرات التدريبيه']) assert.deepEqual(ids(await search(q)),['one','two']);
  });
  await t.test('Arabic hamza and diacritics match stored variants',async()=>{
    for(const q of ['اثر القدرات','أثر القدرات','القدرات أثر'])assert.deepEqual(ids(await search(q)),['two']);
  });
  await t.test('mixed name/digits stay a name query, including Arabic numerals',async()=>{
    for(const q of ['اكاديمية النخبة 2030','أكاديمية النخبة ٢٠٣٠'])assert.deepEqual(ids(await search(q)),['three']);
  });
  await t.test('English words match in either order',async()=>assert.deepEqual(ids(await search('training abilities')),['one']));
  await t.test('Arabic and Persian digits use exact registration matching',async()=>{
    for(const q of ['1234567890','١٢٣٤٥٦٧٨٩٠','۱۲۳۴۵۶۷۸۹۰','١٢٣٤٥ ٦٧٨٩٠']){
      const rows=await search(q);assert.deepEqual(ids(rows),['one']);assert.equal(rows[0].exactRegistrationMatch,true);
    }
    assert.deepEqual(ids(await search('12345')),[]);
  });
  await t.test('external reference remains supported without asserting official identity',async()=>{
    const rows=await search('654321');assert.deepEqual(ids(rows),['one']);assert.equal(rows[0].exactRegistrationMatch,false);
  });
  await t.test('public output stays masked and excludes other organizations and inactive accounts',async()=>{
    const rows=await search('القدرات');assert.deepEqual(ids(rows),['one','two']);
    const row=rows.find(x=>x.id==='one');assert.equal(row.officialEmail,'pr***@example.test');
    assert.equal(row.officialPhone,'05 •• ••• 67');
    for(const field of ['email','mobile','phone','commercial_registration','national_registration','organization_id']) assert.equal(field in row,false);
  });
  await t.test('empty or regex-only text is rejected without database requests',async()=>{
    for(const q of ['','ab','12','%_*(),.*','[.*]']){
      const before=requests.length;await assert.rejects(search(q),e=>e.code==='query_too_short');assert.equal(requests.length,before);
    }
  });
  await t.test('filter syntax cannot broaden scope',async()=>assert.deepEqual(ids(await search('القدرات),organization_id.neq.fake')),[]));
  await t.test('unrelated names return no results',async()=>assert.deepEqual(ids(await search('غيرموجودةاطلاقا')),[]));
  await t.test('service errors are failures, not successful empty results',async()=>{
    const original=ctx.fetch;ctx.fetch=async()=>({ok:false,status:503,text:async()=>'unavailable'});
    await assert.rejects(search('القدرات'),/rest_read_failed/);ctx.fetch=original;
  });
  await t.test('malformed database payload is not a successful empty search',async()=>{
    const original=ctx.fetch;ctx.fetch=async()=>({ok:true,json:async()=>({unexpected:true})});
    await assert.rejects(search('القدرات'),/rest_read_invalid/);ctx.fetch=original;
  });
  await db.close();
});
