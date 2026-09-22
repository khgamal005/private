export const academySlug=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const roles=new Set(['manager','website_editor','instructor']);
const email=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const problem=code=>Object.assign(new Error(code),{code,status:400});

export function academyAdminPayload(action,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw problem('invalid_request');
  if(action==='configure'){
    const components=input.components;
    if(typeof input.enabled!=='boolean'||!['standalone','connected'].includes(input.mode)
      ||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0
      ||!components||!['lms','website','store'].every(key=>typeof components[key]==='boolean')
      ||typeof input.reason!=='string'||input.reason.trim().length<5||input.reason.length>500
      ||(input.accessUntil!==null&&(typeof input.accessUntil!=='string'||!Number.isFinite(Date.parse(input.accessUntil)))))throw problem('invalid_request');
    return {enabled:input.enabled,mode:input.mode,expectedVersion:input.expectedVersion,
      components:{lms:components.lms,website:components.website,store:components.store},
      accessUntil:input.accessUntil,reason:input.reason.trim()};
  }
  if(action==='set_member'||action==='issue_invitation'){
    if(!email(input.email)||!roles.has(input.role))throw problem('invalid_request');
    const payload={email:input.email.trim().toLowerCase(),role:input.role};
    if(action==='set_member'){
      if(!['active','suspended'].includes(input.status))throw problem('invalid_request');
      return {...payload,status:input.status};
    }
    if(typeof input.expiresAt!=='string'||!Number.isFinite(Date.parse(input.expiresAt)))throw problem('invalid_invitation');
    return {...payload,expiresAt:input.expiresAt};
  }
  throw problem('invalid_request');
}

export function academyAdminError(code){
  if(/version|conflict/.test(code))return 'تغيّرت إعدادات المنصة. أعد تحميل التفاصيل قبل الحفظ.';
  if(/pilot|rollout|not_available/.test(code))return 'التفعيل التجريبي متاح لمركز ماركتون حاليًا.';
  if(/entitle|subscription|addon/.test(code))return 'راجع اشتراك مكونات المنصة أو حدد نهاية للتجربة.';
  if(/trial|access_until|expiry|expires/.test(code))return 'حدد نهاية تجربة خلال 30 يومًا، أو استخدم اشتراكًا قائمًا.';
  if(/subject|email|user_not_found/.test(code))return 'استخدم حسابًا نشطًا ببريد مؤكد، أو أنشئ له دعوة تفعيل.';
  if(/permission|forbidden|unauthorized/.test(code))return 'تحتاج صلاحية إدارة المنشآت لتنفيذ هذا الإجراء.';
  if(/network/.test(code))return 'تعذر تأكيد نتيجة الطلب. أعد المحاولة بنفس البيانات.';
  if(/PGRST202|function.*does not exist/.test(code))return 'إعدادات المنصة التدريبية غير متاحة في هذا الإصدار بعد.';
  return 'تعذر تنفيذ الطلب. راجع البيانات وأعد المحاولة.';
}
