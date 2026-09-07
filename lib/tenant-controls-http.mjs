export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTS=new Set(['odeir.com','www.odeir.com','staging.odeir.com','localhost','127.0.0.1']);
export function sameOrigin(request){
  try{
    const source=new URL(request.headers.get('origin')||'');
    const target=new URL(request.url);
    const forwarded=(request.headers.get('x-forwarded-host')||'').split(',')[0].trim();
    const host=forwarded?new URL(`${target.protocol}//${forwarded}`):target;
    const site=request.headers.get('sec-fetch-site');
    return (!site||site==='same-origin')&&HOSTS.has(source.hostname)&&HOSTS.has(host.hostname)
      &&source.host===host.host&&(source.protocol==='https:'
        ||source.protocol==='http:'&&['localhost','127.0.0.1'].includes(source.hostname));
  }catch{return false;}
}
export async function boundedText(message,maxBytes){
  if(Number(message.headers.get('content-length')||0)>maxBytes)throw new Error('request_too_large');
  if(!message.body)return '';
  const reader=message.body.getReader();const chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;
    total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new Error('request_too_large');}chunks.push(value);
  }}finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  return new TextDecoder().decode(bytes);
}
export function controlPayload(body){
  if(!body||Array.isArray(body)||typeof body!=='object'||typeof body.tenantId!=='string'||!UUID.test(body.tenantId)
    ||!['set_plan','set_status'].includes(body.action)||!body.payload||Array.isArray(body.payload)
    ||typeof body.payload!=='object')return null;
  const p=body.payload;
  if(typeof p.expectedVersion!=='string'||!/^[a-f0-9]{64}$/.test(p.expectedVersion)||typeof p.confirmation!=='string'
    ||p.confirmation.length>120)return null;
  const payload={expectedVersion:p.expectedVersion,confirmation:p.confirmation};
  if(body.action==='set_plan'){
    if(typeof p.planId!=='string'||!UUID.test(p.planId)||!['month','year'].includes(p.billingInterval))return null;
    payload.planId=p.planId;payload.billingInterval=p.billingInterval;
  }else{
    if(!['active','suspended'].includes(p.status))return null;payload.status=p.status;
  }
  return {p_tenant_id:body.tenantId,p_action:body.action,p_payload:payload};
}
export function validControlSnapshot(value,id){
  return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)
    &&typeof value.tenant?.id==='string'&&value.tenant.id.toLowerCase()===id.toLowerCase()
    &&typeof value.tenant.name==='string'&&typeof value.tenant.status==='string'
    &&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.tenant.slug||'')
    &&typeof value.tenant.reefProtected==='boolean'&&Number.isSafeInteger(value.tenant.members)&&value.tenant.members>=0
    &&/^[a-f0-9]{64}$/.test(value.version||'')&&Array.isArray(value.plans)
    &&value.plans.every(p=>p&&typeof p.id==='string'&&UUID.test(p.id)&&typeof p.name==='string'&&typeof p.key==='string'&&typeof p.internalOnly==='boolean')
    &&(value.subscription===null||value.subscription&&typeof value.subscription==='object'
      &&typeof value.subscription.planName==='string'&&typeof value.subscription.planId==='string'
      &&(!value.subscription.periodEnd||Number.isFinite(Date.parse(value.subscription.periodEnd))))
    &&['canSetPlan','canSetStatus','canDelete'].every(k=>typeof value.actions?.[k]==='boolean');
}
const ERRORS={
  authentication_required:[401,'انتهت جلسة الدخول. أعد تسجيل الدخول.'],
  forbidden:[403,'ليس لديك صلاحية تنفيذ هذا الإجراء.'],
  tenant_not_found:[404,'المنشأة غير موجودة أو حُذفت بالفعل.'],
  reef_contract_protected:[409,'ريف محمية؛ لا يمكن تغيير باقتها أو إيقافها أو حذفها من هذه الشاشة.'],
  tenant_controls_version_conflict:[409,'تغيّرت بيانات المنشأة من جلسة أخرى. أعد تحميل التفاصيل وراجعها قبل التأكيد.'],
  tenant_controls_confirmation_required:[400,'أكد الإجراء على المنشأة المحددة أولًا.'],
  tenant_controls_payload_invalid:[400,'بيانات الإجراء غير صالحة.'],
  tenant_controls_action_invalid:[400,'الإجراء غير مدعوم.'],
  commercial_plan_not_available:[400,'الباقة المختارة غير متاحة للإسناد.'],
  invalid_billing_interval:[400,'اختر شهريًا أو سنويًا.'],
  invalid_status:[400,'حالة المنشأة غير صالحة.'],
  request_too_large:[413,'حجم الطلب أكبر من المسموح.']
};
export function publicControlError(code){return ERRORS[code]||[503,'تعذر تأكيد العملية. أعد تحميل التفاصيل قبل المحاولة مرة أخرى.'];}
