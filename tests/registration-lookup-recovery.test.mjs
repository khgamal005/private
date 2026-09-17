import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {lookupInstitution} from '../lib/registration-lookup.mjs';
const endpoint='https://directory.example.test';
const ok={ok:true,status:200,json:async()=>({ok:true,results:[]})};
test('read-only lookup omits aged registration session and retries one network failure',async()=>{
 let calls=0;
 const result=await lookupInstitution(endpoint,{action:'search',query:'القدرات الادارية',startedAt:1},{fetchImpl:async(_,options)=>{
   assert.equal(JSON.parse(options.body).startedAt,undefined);assert.ok(options.signal);
   if(++calls===1)throw new TypeError('network');return ok;
 }});
 assert.equal(calls,2);assert.equal(result.ok,true);
});
test('server failure retries once; rate limits and validation failures do not',async()=>{
 for(const status of [503,429,400]){let calls=0;await assert.rejects(lookupInstitution(endpoint,{action:'search',query:'a'},{fetchImpl:async()=>{calls++;return {ok:false,status,json:async()=>({error:status===429?'rate_limited':'service_unavailable'})};}}));assert.equal(calls,status===503?2:1);}
});
test('timeouts and connection failures produce specific recoverable errors',async()=>{
 for(const [name,expected] of [['TimeoutError','lookup_timeout'],['TypeError','lookup_connection_failed']]){
 let calls=0;await assert.rejects(lookupInstitution(endpoint,{action:'details',accountId:'fixture'},{fetchImpl:async()=>{calls++;throw Object.assign(new Error('failure'),{name});}}),new RegExp(expected));assert.equal(calls,2);
 }
});
test('submission cannot enter the retry path',async()=>{
 await assert.rejects(lookupInstitution(endpoint,{action:'submit'},{fetchImpl:()=>assert.fail('must not send')}),/invalid_action/);
});
test('registration alerts do not inherit full-screen global error class',()=>{
 const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
 assert.doesNotMatch(read('components/free-trial-landing.js'),/className="alert error"/);
 assert.match(read('components/free-trial-landing.js'),/className="alert trial-error"/);
 for(const path of ['app/free-trial/free-trial.css','components/odeir-registration-modal.module.css'])assert.ok(read(path).includes('.alert.trial-error'));
});
