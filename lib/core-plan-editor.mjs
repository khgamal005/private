import {UUID} from './tenant-controls-http.mjs';
export function amountMinor(value){
 const text=String(value??'').trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace('٫','.');
 if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(text))return null;
 const [whole,fraction='']=text.split('.');const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 return result<=100000000?result:null;
}
export function planEditorPayload(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.planId!=='string'||!UUID.test(body.planId)||!body.payload)return null;
 const p=body.payload;
 if(typeof p.expectedVersion!=='string'||!/^[a-f0-9]{64}$/.test(p.expectedVersion)||p.confirmed!==true||typeof p.published!=='boolean')return null;
 if(![p.monthlyAmountMinor,p.annualAmountMinor,p.staffLimit,p.displayOrder].every(Number.isSafeInteger))return null;
 if(p.monthlyAmountMinor<0||p.annualAmountMinor<0||p.monthlyAmountMinor>100000000||p.annualAmountMinor>100000000
 ||p.staffLimit<1||p.staffLimit>10000||p.displayOrder<0||p.displayOrder>10000)return null;
 if(typeof p.nameAr!=='string'||p.nameAr.trim().length<2||p.nameAr.length>100||typeof p.description!=='string'
 ||p.description.trim().length<5||p.description.length>600||typeof p.reason!=='string'||p.reason.trim().length<3||p.reason.length>500)return null;
 return {p_plan_id:body.planId,p_payload:{expectedVersion:p.expectedVersion,confirmed:true,nameAr:p.nameAr.trim(),
 description:p.description.trim(),monthlyAmountMinor:p.monthlyAmountMinor,annualAmountMinor:p.annualAmountMinor,
 staffLimit:p.staffLimit,displayOrder:p.displayOrder,published:p.published,reason:p.reason.trim()}};
}
export function validPlanEditorItem(item,id){return Boolean(item)&&item.id===id&&/^[a-f0-9]{64}$/.test(item.version||'')
 &&typeof item.nameAr==='string'&&typeof item.published==='boolean'&&Number.isSafeInteger(item.monthlyAmountMinor)
 &&Number.isSafeInteger(item.annualAmountMinor)&&Number.isSafeInteger(item.commercialProfile?.limits?.staff)&&Array.isArray(item.history);}
export function planEditorError(code){return ({
 authentication_required:[401,'انتهت الجلسة؛ أعد تسجيل الدخول.'],forbidden:[403,'تحتاج صلاحية إدارة الفوترة لتعديل الباقات.'],
 plan_not_found:[404,'الباقة غير موجودة.'],plan_editor_version_conflict:[409,'تغيّرت الباقة من جلسة أخرى. أغلق المحرر وحدّث الصفحة ثم راجع القيم.'],
 legacy_plan_contract_protected:[409,'النسخة الكاملة محمية حفاظًا على عقد ريف.'],free_plan_must_remain_free:[400,'المجانية تظل بسعر صفر ومتاحة للتسجيل الجديد.'],
 paid_plan_price_required:[400,'الباقة المدفوعة تحتاج سعرًا شهريًا وسنويًا أكبر من صفر.'],
 plan_editor_payload_invalid:[400,'راجع الأسعار وعدد المستخدمين والحقول المطلوبة.'],request_too_large:[413,'حجم الطلب أكبر من المسموح.']
 })[code]||[503,'تعذر تأكيد الحفظ. حدّث الصفحة وراجع الباقة قبل إعادة المحاولة.'];}
