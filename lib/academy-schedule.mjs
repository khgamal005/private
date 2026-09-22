import {validTrainingId,trainingProblem} from './training-request.mjs';
export const SCHEDULE_ACTIONS=new Set(['save_session','cancel_session','complete_session','start_run','complete_run']);
const version=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
export function schedulePayload(action,input){
 if(!input||typeof input!=='object'||Array.isArray(input)||!validTrainingId(input.runId)||!version(input.expectedRunVersion))throw trainingProblem('invalid_request');
 const payload={runId:input.runId,expectedRunVersion:input.expectedRunVersion};
 if(input.sessionId!==undefined&&input.sessionId!==null){
  if(!validTrainingId(input.sessionId)||!version(input.expectedSessionVersion))throw trainingProblem('invalid_request');
  payload.sessionId=input.sessionId;payload.expectedSessionVersion=input.expectedSessionVersion;
 }
 if(['cancel_session','complete_session'].includes(action)&&!payload.sessionId)throw trainingProblem('invalid_request');
 if(action==='save_session'){
  for(const key of ['title','startsAt','endsAt','deliveryMode','instructorName','meetingUrl','location'])payload[key]=input[key]??'';
  if(typeof payload.meetingUrl!=='string')throw trainingProblem('invalid_request');
  if(payload.meetingUrl){let url;try{url=new URL(payload.meetingUrl);}catch{throw trainingProblem('academy_schedule_https_required');}
   if(url.protocol!=='https:'||url.username||url.password||/[\\\s]/.test(payload.meetingUrl))throw trainingProblem('academy_schedule_https_required');}
 }
 if(action==='cancel_session')payload.reason=input.reason;
 if(['complete_session','start_run','complete_run'].includes(action))payload.reviewed=input.reviewed===true;
 return payload;
}
const messages={
 academy_schedule_conflict:'تغيّر الجدول منذ فتحه. حدّث البيانات وراجع التعديل قبل الحفظ.',
 academy_command_conflict:'تغيرت بيانات الطلب السابق. حدّث الصفحة وأعد المحاولة.',
 academy_schedule_run_locked:'الدفعة مغلقة ولا تقبل تعديل جدولها.',
 academy_schedule_session_locked:'اللقاء مكتمل أو ملغى ولا يقبل التعديل.',
 academy_schedule_review_required:'أكد مراجعة اللقاءات والحضور قبل إتمام الإجراء.',
 academy_schedule_not_started:'لا يمكن بدء الدفعة قبل موعدها أو قبل فتحها للتسجيل.',
 academy_schedule_https_required:'استخدم رابط لقاء يبدأ بـ https:// دون بيانات دخول داخل الرابط.',
 academy_schedule_location_required:'أدخل رابط اللقاء عن بعد، ومكان الحضور عند التقديم الحضوري أو المدمج.',
 academy_schedule_provider_managed:'هذا اللقاء مرتبط بتكامل اجتماعات قائم. عدّل موعده من إدارة التكامل.',
 academy_schedule_reason_required:'اذكر سبب الإلغاء في خمس حروف على الأقل.',
 recorded_session_schedule_locked:'للّقاء سجل حضور؛ لا يمكن تغيير توقيته أو إلغاؤه.',
 session_outside_course_run:'يجب أن تكون مواعيد اللقاء ضمن بداية الدفعة ونهايتها.',
 course_run_sessions_overlap:'الموعد يتداخل مع لقاء آخر في الدفعة.',
 course_run_sessions_required:'أضف لقاءً واحدًا على الأقل لهذه الدفعة.',
 course_run_sessions_not_ended:'لا يمكن الإكمال قبل انتهاء موعد الدفعة ولقاءاتها.',
 course_run_sessions_not_completed:'راجع اللقاءات وأكد إكمالها قبل إغلاق الدفعة.',
 attendance_unrecorded_blocks_closure:'استكمل تسجيل حضور المتدربين المؤهلين أولًا.',
 invalid_course_run_session_dates:'راجع بداية اللقاء ونهايته والمنطقة الزمنية.',
 too_many_course_run_sessions:'وصلت الدفعة إلى الحد الأقصى: 100 لقاء.',
 forbidden:'ليست لديك صلاحية إدارة لقاءات هذه المنشأة.',
 academy_not_available:'منصة التدريب غير متاحة لهذه المنشأة.',
 network_unavailable:'تعذر تأكيد نتيجة العملية. أعد المحاولة بنفس البيانات.'
};
export const scheduleError=code=>messages[code]||'تعذر تنفيذ الإجراء. راجع البيانات وحدّث الجدول.';
