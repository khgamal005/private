import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('CMS builder uses one canonical dynamic route without slug conflicts',async()=>{
  const [route,home]=await Promise.all([
    read('app/control/website/builder/[entityType]/[entityId]/page.js'),
    read('components/website-builder-home.js')
  ]);

  await assert.rejects(
    access(new URL('app/control/website/builder/[pageId]/page.js',root)),
    error=>error?.code==='ENOENT'
  );
  assert.match(route,/const \{entityType,entityId\}=await params/);
  assert.match(route,/\['page','article'\]\.includes\(entityType\)/);
  assert.match(home,/\/control\/website\/builder\/page\/\$\{page\.id\}/);
});
