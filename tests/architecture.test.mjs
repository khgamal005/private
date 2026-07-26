import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

async function walk(directory){
  const entries=await readdir(directory,{withFileTypes:true});
  return (await Promise.all(entries.map(async entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?walk(path):[path];
  }))).flat();
}

test('the product exposes only control and tenant workspaces',async()=>{
  const appPath=fileURLToPath(new URL('../app',import.meta.url));
  const files=await walk(appPath);
  assert.equal(files.some(file=>file.includes('/app/internal/')),false);

  const shell=await readFile(new URL('../components/workspace-shell.js',import.meta.url),'utf8');
  assert.doesNotMatch(shell,/\/internal|CRM ماركتون الداخلي/);
});

test('the legacy build patch chain is not part of package scripts',async()=>{
  const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const scripts=Object.values(packageJson.scripts||{}).join(' ');
  assert.doesNotMatch(scripts,/bootstrap|patch/i);
  assert.equal(packageJson.scripts.build,'next build');
});

test('control and tenant route roots remain present',async()=>{
  for(const path of ['../app/control/page.js','../app/tenant/[slug]/page.js']){
    const contents=await readFile(new URL(path,import.meta.url),'utf8');
    assert.ok(contents.length>0,`${path} should not be empty`);
  }
});

test('the application uses only the clean v2 database entrypoints',async()=>{
  const api=await readFile(new URL('../lib/api.js',import.meta.url),'utf8');
  const auth=await readFile(new URL('../lib/server-auth.js',import.meta.url),'utf8');
  const login=await readFile(new URL('../app/api/auth/login/route.js',import.meta.url),'utf8');
  assert.match(api,/v2_platform_control_snapshot/);
  assert.match(api,/v2_tenant_workspace_snapshot/);
  assert.match(auth,/v2_current_user_context/);
  assert.match(login,/v2_current_user_context/);
  assert.doesNotMatch(`${api}\n${auth}\n${login}`,/authRpc\('(?:platform_control_snapshot|tenant_workspace_snapshot|current_user_context)'/);
});
