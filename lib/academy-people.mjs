import {validTrainingId,validTrainingToken,trainingProblem} from './training-request.mjs';
const fail=()=>{throw trainingProblem('invalid_request');};
const clean=(value,max)=>{if(typeof value!=='string'||value.length>max)fail();return value.trim();};
export function academyPeoplePayload(action,value) {
 if(!value||typeof value!=='object'||Array.isArray(value))fail();
 if(action==='snapshot') {
  if(!['students','instructors'].includes(value.kind)||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>100000)fail();
  return {kind:value.kind,offset:value.offset,query:clean(value.query??'',100)};
 }
 if(action==='invite_student') {
  if(!validTrainingId(value.studentId)||!validTrainingToken(value.invitationToken))fail();
  return {studentId:value.studentId,email:clean(value.email,254).toLowerCase(),invitationToken:value.invitationToken};
 }
 if(!['add_student','invite_instructor'].includes(action))fail();
 const result={name:clean(value.name,200),email:clean(value.email,254).toLowerCase(),phone:clean(value.phone??'',30)};
 if(result.name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)||(action==='add_student'&&!result.phone))fail();
 if(action==='invite_instructor') {
  if(value.staffId!=null&&!validTrainingId(value.staffId))fail();
  if(!validTrainingToken(value.invitationToken))fail();
  result.staffId=value.staffId??null;result.invitationToken=value.invitationToken;
 }
 return result;
}
