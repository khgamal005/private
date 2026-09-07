import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {planEditorPayload} from '../lib/core-plan-editor.mjs';
const sql=await readFile(new URL('../supabase/migrations/20260907121051_tenant_manual_controls_v1.sql',import.meta.url),'utf8');
test('confirmed tenant assignment locks catalog before tenant rows and before quote-version validation',()=>{
 const lock=sql.indexOf("'odeir:core-catalog:'");
 assert(lock>0&&lock<sql.indexOf("'odeir:tenant-delete:'"));
 assert(lock<sql.indexOf('before_state:=public.v1_platform_tenant_controls_snapshot'));
});
test('plan editor rejects coercible array identifiers and version tokens',()=>{
 const body={planId:'10000000-0000-4000-8000-000000000001',payload:{expectedVersion:'a'.repeat(64),confirmed:true,published:true,nameAr:'باقة',description:'وصف تجريبي',reason:'مراجعة',monthlyAmountMinor:7900,annualAmountMinor:79000,staffLimit:5,displayOrder:10}};
 assert(planEditorPayload(body));
 assert.equal(planEditorPayload({...body,planId:[body.planId]}),null);
 assert.equal(planEditorPayload({...body,payload:{...body.payload,expectedVersion:[body.payload.expectedVersion]}}),null);
});
