import {isTrustedSupportRequestOrigin} from './support-request-origin.mjs';

export const TRAINING_PILOT_SLUG='marktone';
export const TRAINING_PILOT_ID='3d185482-b916-49cc-b868-b6dfdb93eba8';
export const TRAINING_ROLES=new Set(['manager','instructor','learner']);
export const LEARNING_ACTIONS=new Set([
  'save_draft','publish_version','assign_version','assign_instructor',
  'issue_invitation','accept_invitation','open_unit','complete_unit',
  'submit_quiz','submit_assignment','grade_assignment','record_attendance',
  'issue_certificate'
]);
export const JOURNEY_ACTIONS=new Set([
  'set_enabled','configure_finance','approve_credit','verify_payment',
  'confirm_admission','create_request','decide_request','reconcile'
]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validTrainingId=value=>typeof value==='string'&&UUID.test(value);
export const validTrainingToken=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export const trainingProblem=(code,status=400)=>Object.assign(new Error(code),{code,status});

export async function readTrainingBody(request,{maxBytes=24576}={}){
  if(!isTrustedSupportRequestOrigin(request))throw trainingProblem('untrusted_origin',403);
  if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw trainingProblem('unsupported_media',415);
  const declared=Number(request.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes)throw trainingProblem('payload_too_large',413);
  const reader=request.body?.getReader();
  if(!reader)throw trainingProblem('invalid_request');
  let size=0;const chunks=[];
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw trainingProblem('payload_too_large',413);}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  try{
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error();
    return body;
  }catch{throw trainingProblem('invalid_request');}
}

export function validateTrainingRequest(body,{mutation=true}={}){
  if(body.tenantSlug!==TRAINING_PILOT_SLUG)throw trainingProblem('training_not_available',404);
  if(mutation&&!validTrainingId(body.commandId))throw trainingProblem('command_id_required');
  if(body.payload!==undefined&&(!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload)))throw trainingProblem('invalid_request');
  return {tenantSlug:body.tenantSlug,commandId:body.commandId,payload:body.payload||{}};
}

const MESSAGES={
  untrusted_origin:'تعذر التحقق من مصدر الطلب. افتح أودير وأعد المحاولة.',
  unsupported_media:'نوع الطلب غير مدعوم.',
  payload_too_large:'المحتوى أطول من المسموح. قسّمه إلى وحدات أصغر.',
  invalid_request:'راجع الحقول المطلوبة وأعد المحاولة.',
  command_id_required:'تعذر تحديد العملية. حدّث الصفحة وأعد المحاولة.',
  training_not_available:'منصة التدريب غير متاحة لهذه المنشأة.',
  training_journey_disabled:'التشغيل المترابط قيد التجهيز لهذه المنشأة.',
  training_journey_not_enabled:'التشغيل المترابط قيد التجهيز لهذه المنشأة.',
  forbidden:'ليست لديك صلاحية لهذا الإجراء.',
  unauthenticated:'سجّل الدخول لاستكمال التدريب.',
  invalid_invitation:'الدعوة غير صالحة أو تم استخدامها. اطلب رابطًا جديدًا من المركز.',
  invitation_expired:'انتهت صلاحية الدعوة. اطلب رابطًا جديدًا من المركز.',
  invitation_email_mismatch:'استخدم البريد الإلكتروني الذي أُرسلت إليه الدعوة.',
  invitation_busy:'جارٍ تفعيل هذه الدعوة. حاول بعد قليل.',
  account_already_exists:'هذا البريد لديه حساب بالفعل. استخدم تسجيل الدخول لقبول الدعوة.',
  weak_password:'كلمة المرور يجب ألا تقل عن 12 حرفًا.',
  invalid_credentials:'راجع البريد وكلمة المرور أو استخدم استعادة كلمة المرور.',
  command_conflict:'تغيرت بيانات الطلب. حدّث الصفحة قبل إنشاء عملية جديدة.',
  training_access_suspended:'دخول التدريب معلق. راجع حالة السداد أو تواصل مع المركز.',
  training_financial_access_suspended:'فتح محتوى جديد معلق. راجع السداد أو تواصل مع المركز؛ تقدمك السابق محفوظ.',
  training_previous_units_required:'أكمل الأنشطة المطلوبة السابقة قبل الانتقال لهذه الخطوة.',
  training_attempts_exhausted:'استُنفدت المحاولات المتاحة. تواصل مع المحاضر للمراجعة.',
  training_unit_review_required:'راجع المحتوى واستكمل مدة النشاط المحددة قبل تأكيد الإكمال.',
  training_latest_submission_required:'وصل تسليم أحدث لهذا الواجب. حدّث الصفحة وراجع النسخة الأخيرة.',
  training_human_review_required:'راجع المحتوى بشريًا وأكد المراجعة قبل النشر.',
  training_policy_review_required:'أكمل شروط البرنامج ومرجع السياسة وبيانات الدعم قبل النشر.',
  training_learning_mode_mismatch:'اختر إصدارًا مخصصًا للتعلم الذاتي لهذا التسجيل.',
  training_activation_in_progress:'يجري تفعيل هذه الدعوة. انتظر قليلًا ثم استخدم تسجيل الدخول.',
  training_instructor_assignment_required:'لم تُسند لحسابك دفعة تدريبية نشطة. تواصل مع مدير التدريب.',
  training_learner_binding_required:'حسابك غير مرتبط بملف متدرب. افتح دعوة المركز لتفعيل الربط.',
  certificate_not_eligible:'لم تكتمل شروط إصدار الشهادة بعد. راجع أسباب الاستحقاق.',
  course_run_full:'اكتملت سعة الدفعة. اختر دفعة أخرى أو أضف المتدرب إلى الانتظار.',
  server_not_configured:'تفعيل حساب التدريب غير متاح الآن. تواصل مع المركز.',
  network_unavailable:'تعذر تأكيد نتيجة العملية. أعد المحاولة بنفس الطلب لتجنب التكرار.'
};
export function trainingErrorMessage(code){
  if(MESSAGES[code])return MESSAGES[code];
  if(/(?:forbidden|permission|unauthorized)/.test(code))return MESSAGES.forbidden;
  if(/(?:disabled|not_enabled)/.test(code))return MESSAGES.training_journey_disabled;
  if(/(?:command.*conflict|idempotency)/.test(code))return MESSAGES.command_conflict;
  if(/(?:financial|payment|overdue|suspended)/.test(code))return 'راجع حالة الدفع وخطة السداد قبل استكمال هذه الخطوة.';
  if(/(?:invitation|token)/.test(code))return MESSAGES.invalid_invitation;
  if(/(?:version|publish|review)/.test(code))return 'راجع إصدار المحتوى وشروطه واعتماده قبل المتابعة.';
  if(/(?:not_found|invalid|mismatch|required|missing)/.test(code))return MESSAGES.invalid_request;
  return 'تعذر إتمام العملية. حدّث البيانات وأعد المحاولة.';
}
