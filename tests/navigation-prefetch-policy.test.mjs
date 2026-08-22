import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('dense repeated links skip speculative prefetch without changing core navigation',async()=>{
  const [
    tenants,
    reports,
    cmsPages,
    customerSearch,
    notifications,
    shell
  ]=await Promise.all([
    read('components/platform-tenants.js'),
    read('components/reporting-center.js'),
    read('components/cms-studio-pages.js'),
    read('components/customer-search.js'),
    read('components/notification-center.js'),
    read('components/workspace-shell.js')
  ]);

  assert.match(
    tenants,
    /shown\.map\(tenant=>[\s\S]*?<Link prefetch=\{false\} className="mt-button soft"/
  );
  assert.match(
    reports,
    /rows\.map\(employee=>[\s\S]*?<Link prefetch=\{false\} className=\{styles\.employeeLink\}/
  );
  assert.match(
    cmsPages,
    /<Link prefetch=\{false\} href=\{cmsBuilderPath\(context,'page',page\.id\)\}/
  );
  assert.match(
    cmsPages,
    /<Link prefetch=\{false\} href=\{cmsPreviewPath\(context,'page',page\.id\)\}/
  );
  assert.match(
    cmsPages,
    /<Link prefetch=\{false\} href=\{pagePath\} target="_blank">/
  );
  assert.match(
    customerSearch,
    /result\.canOpen&&result\.id&&<Link prefetch=\{false\}/
  );
  assert.match(
    notifications,
    /systemItems\.map\(item=><Link\s+prefetch=\{false\}/
  );
  assert.match(
    notifications,
    /operationalItems\.map\(item=><Link\s+prefetch=\{false\}/
  );

  assert.doesNotMatch(
    shell,
    /prefetch=\{false\}/,
    'primary workspace navigation must retain the framework default'
  );
});
