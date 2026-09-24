'use client';
import Link from 'next/link';
import {zoomSetupState,ZOOM_SETUP_CHECKS} from '../lib/zoom-setup.mjs';
import styles from './zoom-workspace.module.css';

export function ZoomSetup({data,slug,busy,action,canManagePlatform=false,onSessions}){
 const setup=data.setup,state=zoomSetupState(data);
 const active=setup?.available&&data.enabled;
 const block=busy?'جارٍ تنفيذ الطلب.':!setup?.available?'حدّث الجاهزية أولًا.':!setup.runtime?.canConnect?'استكمل تجهيز الربط مع مسؤول أودير أولًا.':setup.initialized&&setup.environment!==setup.runtime.environment?'بيئة إعداد المنشأة لا تطابق خدمة الربط.':!setup.ownerReady?'اختر مسؤول متابعة نشطًا.':!setup.canConfigure?'تحتاج صلاحية إدارة إعدادات الربط.':'';
 const needsPlatform=setup?.available&&(!setup.runtime?.canConnect||(!setup.runtime?.canSchedule&&setup.connectedAccounts>0));
 return <section className={styles.setup} aria-label="خطوات إعداد Zoom">
  <ol className={styles.steps}>{['جاهزية الربط','إعداد المنشأة','ربط الحساب','المضيف والمدرب','المحاضرة'].map((label,i)=><li key={label} aria-current={state.step===i+1?'step':undefined}><span>{i+1}</span>{label}</li>)}</ol>
  <div className={styles.toolbar}><div><small>الخطوة الحالية · {state.owner}</small><h2>{state.title}</h2></div><button disabled={busy} data-block-reason="جارٍ تنفيذ الطلب." onClick={()=>action('snapshot',{},'حُدّثت الجاهزية.')}>تحديث الجاهزية</button></div>
  <p>{state.reason}</p>
  {needsPlatform&&<><ul className={styles.checks}>{ZOOM_SETUP_CHECKS.filter(([key])=>!setup.runtime?.checks?.[key]&&(key!=='scheduler'||setup.connectedAccounts>0)).map(([key,label])=><li key={key}>{label}: ينتظر مسؤول أودير</li>)}</ul>{canManagePlatform?<Link href="/control/addons/zoom">فتح تجهيز Zoom في إدارة أودير</Link>:<Link href={`/tenant/${encodeURIComponent(slug)}/support`}>التواصل مع مسؤول أودير</Link>}</>}
  {setup?.available&&!setup.initialized&&data.permissions?.retention&&<form className={styles.card} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);action('initialize',{ownerStaffId:f.get('ownerStaffId'),environment:setup.runtime?.environment||'production'},'حُفظت إعدادات المنشأة. لم يُفعّل الاتصال بعد.');}}>
   <h3>إعداد المنشأة</h3><p>اختر من يتابع تعارضات المحاضرات ونقص الحضور. يبدأ التسجيل السحابي متوقفًا، ويمكن ضبطه لاحقًا.</p>
   <label className={styles.field}><span>مسؤول المتابعة</span><select name="ownerStaffId" required defaultValue=""><option value="">اختر المسؤول</option>{(data.staff||[]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
   {!data.staff?.length&&<p>أضف موظفًا نشطًا من قسم فريق العمل أولًا.</p>}
   <button type="submit" disabled={busy||!data.staff?.length} data-block-reason={busy?'جارٍ الحفظ.':'لا يوجد موظف نشط لاختياره مسؤولًا للمتابعة.'}>حفظ إعداد المنشأة</button>
  </form>}
  {setup?.initialized&&!active&&<form className={styles.card} onSubmit={e=>{e.preventDefault();action('activate',{expectedVersion:setup.revision,confirmed:true},'فُعّل الربط لهذه المنشأة. يمكنك الآن ربط أول حساب Zoom.');}}>
   <h3>تفعيل الربط لهذه المنشأة</h3><p>التفعيل يسمح بطلب تفويض حسابك. لم يُربط أي حساب ولم يُنشأ أي اجتماع بمجرد حفظ الإعدادات.</p>
   <label><input type="checkbox" required/> أوافق على تشغيل الربط لهذه المنشأة.</label>
   <button type="submit" disabled={!!block} data-block-reason={block||undefined}>تفعيل الربط</button>{block&&!busy&&<p>{block}</p>}
  </form>}
  {active&&state.step===5&&setup.runtime?.canSchedule&&<button type="button" onClick={onSessions}>فتح محاضرات الدفعات</button>}
  <details className={styles.help}><summary>كيف ترتبط إضافة Zoom بأقسام أودير؟</summary><ol><li>أضف الدورة والدفعة ومحاضراتها والمدرب من أقسام التدريب الحالية.</li><li>القبول والحسابات يحددان استحقاق المتدرب وفق تسجيله ودفعه.</li><li>اختر المحاضرة في تشغيل المتدربين؛ أودير يوزعها على المضيف المؤهل والمتفرغ.</li><li>يبدأ المدرب ويدخل المتدرب من بوابته. راجع الحضور، ثم انشر التسجيل بعد اعتماده.</li></ol><p>لا تحتاج إلى إنشاء طالب أو دورة مرة أخرى من أجل Zoom. منصة التعلم إضافة مستقلة.</p></details>
 </section>;
}
