import assert from 'node:assert/strict';
import test from 'node:test';
import {ga4ReportFailureCode,isGA4ReportError,ga4ReportErrorMessage} from '../supabase/functions/_shared/ga4-report-errors.mjs';
import {publicError} from '../supabase/functions/google-ads-connect/handler.mjs';
import {googleErrorMessage} from '../lib/google-ads/ui.mjs';

test('report diagnostics preserve stage and a finite schema field, never provider text',()=>{
 const payload={error:{status:'INVALID_ARGUMENT',message:'Please remove currencyCode to make the request compatible. The dimensions & metrics are incompatible. PRIVATE site@example.test token=secret'}};
 const code=ga4ReportFailureCode(400,payload,'transactions');
 assert.equal(code,'ga4_transactions_incompatible_currencycode');
 assert.equal(publicError({code}),code);assert.match(code,/^[a-z0-9_]{1,100}$/);
 const message=googleErrorMessage(code);assert.match(message,/معاملات الشراء/);assert.doesNotMatch(message,/PRIVATE|site@|secret|currencyCode|صلاحية الحساب/);
 assert.match(googleErrorMessage('ga4_traffic_invalid'),/الزيارات والتفاعل/);
});
test('malformed, excessive and unstructured provider diagnostics cannot enter the public code',()=>{
 for(const payload of [null,{},'PRIVATE',{error:{message:'currencyCode incompatible PRIVATE'}},{error:{status:'PRIVATE',message:'currencyCode incompatible'}},{error:{status:'INVALID_ARGUMENT',message:'x'.repeat(4097)}}]){
  assert.equal(ga4ReportFailureCode(400,payload,'traffic'),'ga4_traffic_invalid');
 }
 for(const code of ['ga4_traffic_invalid_PRIVATE','ga4_transactions_incompatible_access_token','ga4_transactions_invalid___proto__','__proto__',null,{}]){
  assert.equal(isGA4ReportError(code),false);assert.equal(ga4ReportErrorMessage(code),null);assert.equal(publicError(code),'request_rejected');
 }
});
test('status-specific report failures give actionable copy without suggesting a permission change',()=>{
 for(const [status,reason] of [[400,'invalid'],[404,'not_found'],[500,'unavailable'],[502,'unavailable'],[409,'rejected']]){
  for(const kind of ['transactions','traffic']){
   const code=ga4ReportFailureCode(status,{error:{message:'PRIVATE response'}},kind);
   assert.equal(code,`ga4_${kind}_${reason}`);assert.equal(isGA4ReportError(code),true);
   assert.doesNotMatch(googleErrorMessage(code),/PRIVATE|صلاحية الحساب/);
  }
 }
 assert.equal(ga4ReportFailureCode(400,{},'PRIVATE'),'ga4_request_failed');
 assert.doesNotMatch(googleErrorMessage('ga4_request_failed'),/راجع صلاحية الحساب/);
});
