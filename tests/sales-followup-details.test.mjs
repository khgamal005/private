import assert from 'node:assert/strict';
import test from 'node:test';
import {serializeFollowupDetails,attendanceLabel} from '../lib/sales-followup-details.mjs';

const details=()=>({revision:'r1',primaryPhone:'0501111111',whatsapp:'',rows:[
  {courseId:'c1',courseRunId:'r1',attendanceSessionId:'s1'},
  {courseId:'c2',courseRunId:'r2',attendanceSessionId:'s2'}
],phones:[{value:'٠٥٥١١١١١١١'}]});
test('independent course attendance serializes without creating contact or followup copies',()=>{
  const value=serializeFollowupDetails(details());
  assert.equal(value.courseInterests.length,2);
  assert.equal(value.courseInterests[1].attendanceSessionId,'s2');
  assert.deepEqual(serializeFollowupDetails({...details(),rows:[{courseId:''}],phones:[{value:''}]}),{courseInterests:[],additionalPhones:[]});
});
test('normalized primary/secondary duplicates, invalid phones and unloaded data are rejected',()=>{
  assert.throws(()=>serializeFollowupDetails(null));
  assert.throws(()=>serializeFollowupDetails({...details(),phones:[{value:'+966501111111'}]}),/مضاف بالفعل/);
  assert.throws(()=>serializeFollowupDetails({...details(),phones:[{value:'123'}]}),/رقمًا صحيحًا/);
  assert.throws(()=>serializeFollowupDetails({...details(),rows:[{courseId:'c1'},{courseId:'c1'}]}),/مضافة بالفعل/);
});
test('attendance presentation uses the tenant timezone across midnight',()=>{
  const label=attendanceLabel('2026-10-02T21:30:00Z','Asia/Riyadh');
  assert.ok(label.includes('03')||label.includes('٣')||label.includes('3'));
  assert.equal(attendanceLabel(null),'الموعد لم يحدد بعد');
});
