import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('Reef is provisioned as the first active full-plan tenant',async()=>{
  const seed=await read('../supabase/migrations/20260727004000_seed_reef_skills_tenant.sql');
  assert.match(seed,/'tenant-reef-skills'/);
  assert.match(seed,/'reef-skills'/);
  assert.match(seed,/'active'/);
  assert.match(seed,/p\.plan_key = 'full'/);
  assert.match(seed,/'entitlement', 'full'/);
});

test('the initial Reef team contains the requested eleven named profiles',async()=>{
  const seed=await read('../supabase/migrations/20260727004000_seed_reef_skills_tenant.sql');
  for(const name of ['نور','مي','ليلى','روان','عبدالجليل','عمر','رزان','ياسمين','داليا','وعد','ياسر']){
    assert.match(seed,new RegExp(`'${name}'`));
  }
  assert.match(seed,/'sales_supervisor'/);
  assert.match(seed,/'customer_service'/);
  assert.match(seed,/'data_officer'/);
  assert.match(seed,/'data_analyst'/);
});

test('the Reef catalog contains the initial six courses without invented pricing',async()=>{
  const seed=await read('../supabase/migrations/20260727004000_seed_reef_skills_tenant.sql');
  for(const code of ['PMP','AI-SKILLS','POWER-BI','KPI','EXCEL-ADV','APHRI']){
    assert.match(seed,new RegExp(`'${code}'`));
  }
  assert.doesNotMatch(seed,/price_minor,\s*[1-9]/);
  assert.match(seed,/'pricingStatus', 'pending'/);
});

test('team and courses are first-class tenant routes backed by v2 RPCs',async()=>{
  const shell=await read('../components/workspace-shell.js');
  const api=await read('../app/api/tenant/[action]/route.js');
  const data=await read('../lib/api.js');
  assert.match(shell,/\/team/);
  assert.match(shell,/\/courses/);
  assert.match(api,/v2_tenant_create_staff/);
  assert.match(api,/v2_tenant_create_course/);
  assert.match(data,/users:access\.employees/);
  assert.match(data,/employees:workspace\.employees/);
});
