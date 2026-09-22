import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {mergePlatformTenantsSnapshot} from '../lib/platform-tenants-snapshot.mjs';

// Inject only the import bindings; execute the actual server loader unchanged.
const source=await readFile(new URL('../lib/platform-tenants-api.js',import.meta.url),'utf8');
const body=source.replace(/^import .*;\n/gm,'').replace('export async function','async function');
const loader=(authRpc,optionalServerRead)=>new Function('authRpc','optionalServerRead','mergePlatformTenantsSnapshot',`${body}\nreturn getPlatformTenants;`)(authRpc,optionalServerRead,mergePlatformTenantsSnapshot);
const optional=async (_label,read,fallback)=>{try{return await read();}catch(error){if(error.digest?.startsWith('NEXT_REDIRECT'))throw error;return fallback;}};

test('tenants loader calls only its narrow core RPC and optional manager snapshot',async()=>{
  const calls=[];
  const run=loader(async (name,body,options)=>{
    calls.push({name,body,options});
    return name==='v1_platform_tenants_snapshot'?{tenants:[{id:'one'}],plans:[]}:{tenants:[],globalEnabled:true,canManage:false};
  },optional);
  await run();
  assert.deepEqual(calls.map(c=>c.name),['v1_platform_tenants_snapshot','v1_platform_odeiry_manager_snapshot']);
  assert.ok(calls.every(c=>c.options.timeoutMs>0&&!c.options.retryTransient));
});

test('manager timeout preserves real tenants and disables unavailable manager controls',async()=>{
  const run=loader(async name=>{
    if(name==='v1_platform_odeiry_manager_snapshot')throw new Error('timeout');
    return {tenants:[{id:'one',employees:7}],pendingInvitations:4};
  },optional);
  const result=await run();
  assert.equal(result.tenants[0].employees,7);
  assert.equal(result.pendingInvitations,4);
  assert.equal(result.odeiryManager.available,false);
  assert.equal(result.tenants[0].odeiryManager.enabled,null);
});

test('core failure is surfaced instead of inventing an empty tenant list',async()=>{
  const run=loader(async name=>{
    if(name==='v1_platform_tenants_snapshot')throw new Error('database unavailable');
    return {tenants:[]};
  },optional);
  await assert.rejects(run(),/database unavailable/);
});

test('authentication redirects are preserved through the optional read',async()=>{
  const redirect=Object.assign(new Error('login required'),{digest:'NEXT_REDIRECT;replace;/login;307;'});
  const run=loader(async name=>{
    if(name==='v1_platform_odeiry_manager_snapshot')throw redirect;
    return {tenants:[]};
  },optional);
  await assert.rejects(run(),error=>error===redirect);
});
