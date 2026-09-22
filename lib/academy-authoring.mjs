import {validTrainingId,trainingProblem,trainingErrorMessage} from './training-request.mjs';

export const AUTHORING_ACTIONS=new Set(['create_course','save_course','publish_course','save_path','publish_path']);
export const AUTHORING_LEVELS=Object.freeze({all:'كل المستويات',beginner:'مبتدئ',intermediate:'متوسط',advanced:'متقدم'});
export const AUTHORING_MODES=Object.freeze({self_paced:'تعلم ذاتي',live:'تدريب مباشر',blended:'تعلم مدمج'});
export const AUTHORING_UNIT_KINDS=Object.freeze({text:'درس نصي',video:'فيديو',link:'رابط',quiz:'اختبار',assignment:'واجب'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>{throw trainingProblem('invalid_request');};
const string=(value,max,{required=false}={})=>{
  if(value===undefined&&!required)return '';
  if(typeof value!=='string'||value.length>max||(required&&value.trim().length<2))fail();
  return value;
};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail();return value;};
const number=(value,min,max)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail();return value;};
const boolean=value=>{if(typeof value!=='boolean')fail();return value;};
const choice=(value,values)=>{if(!values.includes(value))fail();return value;};
const id=value=>{if(!validTrainingId(value))fail();return value;};
const localId=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value))fail();return value;};
export function authoringSafeUrl(value){
  if(typeof value!=='string'||value.length>2048||/[\\\s]/.test(value))return false;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&Boolean(url.hostname);}catch{return false;}
}
function url(value){const result=string(value,2048);if(result&&!authoringSafeUrl(result))throw trainingProblem('academy_authoring_https_required');return result;}
export function createAuthoringDocument(title=''){
  return {title,description:'',category:'تدريب عام',level:'all',language:'ar',thumbnailUrl:'',introVideoUrl:'',learningMode:'self_paced',
    policy:{minAttendancePercent:0,minAssessmentPercent:70,requireCompletedRun:false,certificateEnabled:false,termsVersion:'',supportEmail:''},topics:[],
    aiBrief:{goal:'',audience:'',language:'ar',topicCount:5,notes:''}};
}
function brief(value){
  if(value===undefined||value===null)return undefined;
  if(!object(value))fail();
  return {goal:string(value.goal,2000),audience:string(value.audience,1000),language:choice(value.language??'ar',['ar','en']),topicCount:integer(value.topicCount??5,1,30),notes:string(value.notes,6000)};
}
function question(value){
  if(!object(value)||!Array.isArray(value.options)||value.options.length<2||value.options.length>8)fail();
  return {id:localId(value.id),prompt:string(value.prompt,2000),options:value.options.map(item=>string(item,2000)),correctOptionIndex:integer(value.correctOptionIndex,0,value.options.length-1)};
}
function unit(value){
  if(!object(value))fail();
  const result={id:localId(value.id),title:string(value.title,300),kind:choice(value.kind,Object.keys(AUTHORING_UNIT_KINDS)),
    required:boolean(value.required??true),minimumSeconds:integer(value.minimumSeconds??0,0,86400),body:string(value.body,50000),url:url(value.url??''),
    maxAttempts:integer(value.maxAttempts??3,1,20),passPercent:number(value.passPercent??70,0,100)};
  if(!Array.isArray(value.questions??[])||(value.questions?.length??0)>50)fail();
  result.questions=(value.questions??[]).map(question);
  if(new Set(result.questions.map(item=>item.id)).size!==result.questions.length)fail();
  const aiBrief=brief(value.aiBrief);if(aiBrief)result.aiBrief=aiBrief;
  return result;
}
export function authoringDocument(value){
  if(!object(value)||!object(value.policy)||!Array.isArray(value.topics)||value.topics.length>30)fail();
  const policy=value.policy;
  const result={title:string(value.title,300,{required:true}),description:string(value.description,20000),category:string(value.category,120,{required:true}),
    level:choice(value.level,Object.keys(AUTHORING_LEVELS)),language:choice(value.language,['ar','en']),thumbnailUrl:url(value.thumbnailUrl??''),introVideoUrl:url(value.introVideoUrl??''),
    learningMode:choice(value.learningMode,Object.keys(AUTHORING_MODES)),policy:{minAttendancePercent:number(policy.minAttendancePercent,0,100),minAssessmentPercent:number(policy.minAssessmentPercent,0,100),
      requireCompletedRun:boolean(policy.requireCompletedRun),certificateEnabled:boolean(policy.certificateEnabled),termsVersion:string(policy.termsVersion,200),supportEmail:string(policy.supportEmail,254)},
    topics:value.topics.map(topic=>{if(!object(topic)||!Array.isArray(topic.units)||topic.units.length>100)fail();return {id:localId(topic.id),title:string(topic.title,300),summary:string(topic.summary,2000),units:topic.units.map(unit)};})};
  const units=result.topics.flatMap(topic=>topic.units);
  if(units.length>100||new Set(result.topics.map(topic=>topic.id)).size!==result.topics.length||new Set(units.map(item=>item.id)).size!==units.length)fail();
  const aiBrief=brief(value.aiBrief);if(aiBrief)result.aiBrief=aiBrief;
  return result;
}
export function authoringSnapshotOptions(input={}){
  if(!object(input))fail();
  return {courseId:input.courseId==null?null:id(input.courseId),pathId:input.pathId==null?null:id(input.pathId),offset:integer(input.offset??0,0,100000),pathOffset:integer(input.pathOffset??0,0,100000),query:string(input.query??'',100)};
}
export function authoringPayload(action,input){
  if(!object(input))fail();
  if(action==='create_course')return {title:string(input.title,300,{required:true}),category:string(input.category??'تدريب عام',120,{required:true})};
  if(!AUTHORING_ACTIONS.has(action))fail();
  const result={expectedRevision:integer(input.expectedRevision,0,2147483646)};
  if(action.endsWith('_course'))result.courseId=id(input.courseId);
  else if(action==='publish_path'||input.pathId!=null)result.pathId=id(input.pathId);
  if(action==='save_course')result.document=authoringDocument(input.document);
  if(action==='save_path'){
    const doc=input.document;
    if(!object(doc)||!Array.isArray(doc.courseIds)||doc.courseIds.length>100)fail();
    result.document={title:string(doc.title,300,{required:true}),description:string(doc.description,20000),courseIds:doc.courseIds.map(id)};
    if(new Set(result.document.courseIds).size!==result.document.courseIds.length)fail();
  }
  if(action.startsWith('publish_'))result.humanReviewed=input.humanReviewed===true;
  return result;
}

/** Readiness hints only. Database functions independently enforce publication. */
export function authoringPublishIssues(document){
  const issues=[];
  const add=(message,step,extra={})=>issues.push({message,step,...extra});
  if(!document?.title||document.title.trim().length<2)add('أدخل عنوانًا واضحًا للدورة.','basics');
  const topics=document?.topics??[],units=topics.flatMap(topic=>topic.units??[]);
  if(!units.length)add('أضف درسًا أو نشاطًا واحدًا على الأقل.','curriculum');
  if(!units.some(item=>item.required&&['quiz','assignment'].includes(item.kind)))add('أضف اختبارًا أو واجبًا مطلوبًا لتقييم إتمام الدورة.','curriculum');
  for(const topic of topics){
    if((topic.title??'').trim().length<2)add('أكمل اسم القسم.','curriculum',{topicId:topic.id});
    if(!topic.units?.length)add(`أضف نشاطًا إلى قسم «${topic.title||'قسم جديد'}».`,'curriculum',{topicId:topic.id});
    for(const item of topic.units??[]){
      const target={topicId:topic.id,unitId:item.id},name=item.title||'النشاط الجديد';
      if((item.title??'').trim().length<2)add('أكمل عنوان النشاط.','curriculum',target);
      if(['text','assignment'].includes(item.kind)&&(item.body??'').trim().length<2)add(`أكمل محتوى «${name}».`,'curriculum',target);
      if(['video','link'].includes(item.kind)&&!authoringSafeUrl(item.url))add(`أضف رابطًا آمنًا إلى «${name}».`,'curriculum',target);
      if(item.kind==='quiz'&&(!item.questions?.length||item.questions.some(q=>(q.prompt??'').trim().length<2||q.options?.some(option=>!option.trim())||!Number.isInteger(q.correctOptionIndex)||q.correctOptionIndex<0||q.correctOptionIndex>=q.options.length)))add(`أكمل أسئلة وإجابات «${name}».`,'curriculum',target);
    }
  }
  if((document?.policy?.termsVersion??'').trim().length<2)add('حدد مرجع شروط الدورة.','review');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(document?.policy?.supportEmail??''))add('أدخل بريد الدعم الذي يرجع إليه المتدرب.','review');
  return issues;
}
const MESSAGES={
  academy_authoring_not_available:'لم يُفعّل محرر الدورات والمسارات لهذه المنشأة بعد.',
  academy_authoring_conflict:'تغيّرت المسودة منذ فتحها. أعد فتح النسخة المحفوظة قبل متابعة التعديل.',
  academy_authoring_revision_conflict:'تغيّرت المسودة منذ فتحها. أعد فتح النسخة المحفوظة قبل متابعة التعديل.',
  academy_authoring_https_required:'استخدم رابطًا يبدأ بـ https:// دون بيانات دخول داخل الرابط.',
  academy_authoring_review_required:'راجع النسخة المحفوظة وأكد المراجعة قبل النشر.',
  academy_authoring_topics_required:'أضف قسمًا واحدًا على الأقل إلى المنهاج.',
  academy_authoring_empty_topic:'أضف نشاطًا لكل قسم قبل النشر.',
  academy_authoring_topic_empty:'أضف نشاطًا لكل قسم قبل النشر.',
  academy_authoring_topic_invalid:'أكمل عنوان القسم وراجع الأنشطة الموجودة فيه.',
  academy_authoring_path_course_not_found:'إحدى الدورات المختارة لم تعد متاحة في هذه المنشأة. راجع محتويات المسار.',
  academy_authoring_url_invalid:'استخدم رابطًا يبدأ بـ https:// دون بيانات دخول داخل الرابط.',
  academy_authoring_external_change:'صدرت نسخة من محرر آخر. راجع المسودة واحفظها قبل نشر إصدار جديد.',
  academy_authoring_path_courses_required:'أضف دورة واحدة على الأقل إلى المسار.',
  academy_authoring_path_course_unpublished:'انشر محتوى الدورات الموجودة في المسار أولًا.',
  academy_authoring_course_not_found:'الدورة غير متاحة لهذه المنشأة.',
  academy_authoring_path_not_found:'المسار غير متاح لهذه المنشأة.',
  academy_authoring_ai_unconfigured:'جهّز وصف المطلوب واحفظه. يتاح التوليد بعد ربط إعدادات الذكاء الاصطناعي.',
  training_assessment_required:'أضف اختبارًا أو واجبًا مطلوبًا قبل نشر الدورة.',
  training_policy_review_required:'استكمل شروط الدورة وبريد الدعم قبل النشر.',
  training_unit_content_required:'أكمل نص الدرس أو تعليمات الواجب قبل النشر.',
  training_unit_url_required:'أضف رابط الفيديو أو المصدر قبل النشر.',
  training_quiz_questions_required:'أضف أسئلة الاختبار قبل النشر.',
  academy_command_conflict:'تغيّرت بيانات العملية السابقة. أعد فتح المسودة وراجعها.',
};
export const authoringErrorMessage=code=>MESSAGES[code]||trainingErrorMessage(code||'request_failed');
