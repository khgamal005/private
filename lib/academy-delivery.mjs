import {trainingProblem,validTrainingId} from './training-request.mjs';

export function courseDeliveryPayload(action,value) {
  const fail=()=>{throw trainingProblem('invalid_request');};
  if(!value||typeof value!=='object'||Array.isArray(value))fail();
  if(action==='publish_offer') {
    if(!validTrainingId(value.offerId)||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1||typeof value.published!=='boolean')fail();
    return {offerId:value.offerId,expectedVersion:value.expectedVersion,published:value.published};
  }
  if(!validTrainingId(value.courseId))fail();
  if(action==='snapshot')return {courseId:value.courseId};
  if(action==='create_run') {
    if(typeof value.title!=='string'||value.title.trim().length<2||value.title.length>200||!['online','onsite','hybrid'].includes(value.deliveryMode)||!Number.isSafeInteger(value.capacity)||value.capacity<1||value.capacity>10000)fail();
    for(const key of ['startsAt','endsAt'])if(typeof value[key]!=='string'||value[key].length>40||!/(Z|[+-][0-9]{2}:[0-9]{2})$/.test(value[key])||!Number.isFinite(Date.parse(value[key])))fail();
    if(Date.parse(value.endsAt)<=Date.parse(value.startsAt))fail();
    return {courseId:value.courseId,title:value.title.trim(),deliveryMode:value.deliveryMode,capacity:value.capacity,startsAt:value.startsAt,endsAt:value.endsAt};
  }
  if(action==='assign_instructor') {
    if(!validTrainingId(value.runId)||!validTrainingId(value.subjectId)||typeof value.active!=='boolean')fail();
    return {courseId:value.courseId,runId:value.runId,subjectId:value.subjectId,active:value.active};
  }
  if(action!=='save_offer'||!['cohort','self_paced'].includes(value.learningMode)||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<0||!Number.isSafeInteger(value.netMinor)||value.netMinor<0||value.netMinor>100000000)fail();
  if(value.runId!=null&&!validTrainingId(value.runId))fail();
  if(value.learningMode==='cohort'&&!value.runId)fail();
  if(!Array.isArray(value.installmentTerms)||value.installmentTerms.length>12)fail();
  const installmentTerms=value.installmentTerms.map(item=>{
    if(!item||!Number.isSafeInteger(item.amountMinor)||item.amountMinor<1||item.amountMinor>100000000||!Number.isSafeInteger(item.dueDays)||item.dueDays<0||item.dueDays>730)fail();
    return {amountMinor:item.amountMinor,dueDays:item.dueDays};
  });
  return {courseId:value.courseId,runId:value.runId??null,learningMode:value.learningMode,expectedVersion:value.expectedVersion,netMinor:value.netMinor,installmentTerms};
}

export function groupCourseOffers(offers=[]) {
  const courses=new Map();
  for(const offer of offers) {
    const key=offer.courseId||offer.id;
    if(!courses.has(key))courses.set(key,{id:key,title:offer.title,description:offer.description,offers:[]});
    courses.get(key).offers.push(offer);
  }
  return [...courses.values()];
}

export function installmentIssues(terms,totalMinor) {
  if(!terms.length)return [];
  if(terms.length<2||terms.length>12)return ['أضف قسطين على الأقل وبحد أقصى 12 قسطًا.'];
  if(terms[0].dueDays!==0||terms.some((item,i)=>!Number.isSafeInteger(item.amountMinor)||item.amountMinor<=0||!Number.isSafeInteger(item.dueDays)||item.dueDays>730||item.dueDays<0||(i>0&&item.dueDays<=terms[i-1].dueDays)))return ['القسط الأول عند التسجيل، وبعده مواعيد متزايدة ومبالغ أكبر من صفر.'];
  return terms.reduce((sum,item)=>sum+item.amountMinor,0)===totalMinor?[]:['مجموع الأقساط يجب أن يساوي إجمالي الدورة شامل الضريبة.'];
}
