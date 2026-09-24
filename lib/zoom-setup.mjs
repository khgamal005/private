import {ZOOM_SETUP_CHECKS} from '../supabase/functions/_shared/zoom-setup.mjs';
export {ZOOM_SETUP_CHECKS};

// Match the existing legacy-worker boundary; this is presentation, never authorization.
export function zoomLegacyMeetingVisible(meeting,meetings=[],managedEnabled=false){
 if(managedEnabled||!meeting||meeting.joinUrl?.startsWith('/training/'))return false;
 return meetings.some(row=>row.provider==='zoom'&&row.externalMeetingId&&row.createdAt&&Date.parse(row.createdAt)<Date.parse('2026-09-22T00:00:00Z'));
}

export function zoomSetupState(data){
 const setup=data?.setup;
 if(!setup?.available)return {step:1,title:'تعذر التحقق من جاهزية الربط',reason:'اضغط تحديث الجاهزية. إن استمر التعذر، يحتاج مسؤول أودير إلى مراجعة خدمة الربط.',owner:'مسؤول أودير'};
 if(!setup.runtime?.canConnect)return {step:1,title:'بانتظار تجهيز الربط في أودير',reason:'إعدادات الربط العامة أو السماح بتشغيلها لم تكتمل. يمكنك حفظ إعدادات منشأتك أثناء التجهيز.',owner:'مسؤول أودير'};
 if(!setup.entitled)return {step:2,title:'يلزم ترخيص الإضافة',reason:'راجع إضافة Zoom في متجر إضافات المنشأة.',owner:'مسؤول المنشأة'};
 if(setup.initialized&&setup.environment!==setup.runtime.environment)return {step:1,title:'يلزم توحيد بيئة الاتصال',reason:'بيئة إعداد المنشأة لا تطابق خدمة الربط. يحتاج مسؤول أودير إلى مراجعة الإعداد قبل التفعيل.',owner:'مسؤول أودير'};
 if(!setup.initialized)return {step:2,title:'أكمل إعداد المنشأة',reason:'اختر مسؤول المتابعة واحفظ الإعدادات لبدء ربط حسابك.',owner:'مسؤول المنشأة'};
 if(!setup.ownerReady)return {step:2,title:'حدد مسؤول متابعة نشطًا',reason:'اختر مسؤولًا من فريق المنشأة في إعدادات التشغيل.',owner:'مسؤول المنشأة'};
 if(!data.enabled)return {step:2,title:'الإعدادات محفوظة؛ الربط لم يُفعّل',reason:'راجع الإقرار ثم فعّل الربط لهذه المنشأة.',owner:'مسؤول المنشأة'};
 if(!setup.connectedAccounts)return {step:3,title:setup.accounts?'راجع اتصال الحساب':'اربط أول حساب Zoom',reason:setup.accounts?'أعد تفويض الحساب أو استأنف التوزيع لتكمل إعداد الموارد.':'سيفتح Zoom لتفويض حسابك، ثم تعود لتحديد المضيفين.',owner:'مسؤول حساب Zoom'};
 if(!setup.runtime.canSchedule)return {step:4,title:'بانتظار تشغيل المزامنة والجدولة',reason:'الحساب متصل. يحتاج مسؤول أودير إلى جدولة العامل قبل مزامنة المضيفين وإنشاء المحاضرات.',owner:'مسؤول أودير'};
 if(!setup.hosts)return {step:4,title:'زامن مضيفي الحساب',reason:'اضغط مزامنة المضيفين في بطاقة الحساب، ثم حدّث الحالة بعد معالجة الطلب.',owner:'مسؤول المنشأة'};
 if(!setup.eligibleHosts)return {step:4,title:'حدد المضيف والمدرب',reason:'اسمح بالمضيف المؤهل، واربطه بمدرب الدفعة، واحفظ ثم تحقق من تفويض المدرب.',owner:'مسؤول التدريب'};
 return {step:5,title:'انتقل إلى محاضرات الدفعة',reason:'اختر محاضرة موجودة، وافحص التوفر ثم أنشئ اجتماعها. الاتصال وحده لا يثبت نجاح محاضرة حية.',owner:'مسؤول التدريب'};
}

export function zoomConnectBlock(data){
 if(!data?.permissions?.accounts)return 'تحتاج صلاحية إدارة حسابات Zoom في هذه المنشأة.';
 if(!data.setup?.available)return 'حدّث الجاهزية للتحقق من إعدادات الربط أولًا.';
 if(!data.setup.runtime?.canConnect)return 'مسؤول أودير يحتاج إلى استكمال إعدادات الربط العامة وتشغيلها.';
 if(!data.enabled)return 'أكمل إعداد المنشأة وتفعيل الربط أولًا.';
 return '';
}

export function zoomViewOptions({view,query='',offset=0,filters={},from='',to='',sessionId=null}){
 const accountKeys=['connectionId','branchId','instructorId','status'];
 const reportKeys=['courseId','runId','instructorId','hostId','connectionId','quality','kind'];
 const keys=view==='accounts'?accountKeys:view==='reports'?reportKeys:[];
 const result={view,query,offset,...Object.fromEntries(keys.filter(k=>filters[k]).map(k=>[k,filters[k]]))};
 if(['sessions','reports'].includes(view)&&from&&to){result.from=new Date(from).toISOString();result.to=new Date(to).toISOString();}
 if(view==='sessions'&&sessionId)result.sessionId=sessionId;
 return result;
}
