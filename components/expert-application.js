'use client';

import {useRef,useState} from 'react';
import {validateExpertApplication} from '../lib/service-hub.mjs';
import s from './service-hub.module.css';

export default function ExpertApplication({available=true}){
  const lock=useRef(false);const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
  async function submit(event){
    event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const data=Object.fromEntries(new FormData(event.currentTarget));const payload=validateExpertApplication({...data,consent:data.consent==='on'});
      const response=await fetch('/api/experts/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,website:data.website||''})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'تعذر إرسال الطلب.');setDone(true);
    }catch(e){setError(e.message||'تعذر الاتصال. بياناتك ما زالت محفوظة في النموذج.');}finally{lock.current=false;setBusy(false);}
  }
  if(done)return <section className={`${s.application} ${s.stack}`} role="status"><span className={`${s.badge} ${s.verified}`}>تم استلام طلبك</span><h2>شكرًا لانضمامك إلى خبراء أودير</h2><p>سيراجع الفريق خبرتك وبياناتك قبل اعتماد الملف ونشره للمنشآت. احتفظ بوسيلة التواصل التي أدخلتها متاحة للمتابعة.</p><a href="/" className={s.secondary}>العودة إلى الرئيسية</a></section>;
  if(!available)return <section className={`${s.application} ${s.stack}`}><h2>التسجيل غير متاح مؤقتًا</h2><p>نعمل على تجهيز استقبال طلبات الخبراء والمحاضرين. يرجى العودة لاحقًا.</p><a href="/">العودة إلى الرئيسية</a></section>;
  return <section className={s.application}><form className={s.form} onSubmit={submit}>
    <div className={s.full}><h2>عرّفنا بخبرتك</h2><p className={s.muted}>الحقول مطلوبة ما لم يُذكر أنها اختيارية.</p></div>
    <label>الاسم الكامل<input name="name" autoComplete="name" required minLength={2} maxLength={150}/></label>
    <label>المجال المهني<select name="type" required defaultValue="lecturer"><option value="lecturer">محاضر</option><option value="trainer">مدرب</option><option value="consultant">خبير / مستشار</option></select></label>
    <label className={s.full}>المسمى المهني<input name="title" required minLength={2} maxLength={180} placeholder="مثال: محاضر ومستشار في إدارة المشروعات"/></label>
    <label>البريد الإلكتروني<input name="email" type="email" autoComplete="email" required maxLength={254} dir="ltr"/></label>
    <label>رقم الجوال مع مفتاح الدولة<input name="phone" type="tel" autoComplete="tel" required minLength={7} maxLength={40} dir="ltr" placeholder="+966…"/></label>
    <p className={`${s.info} ${s.full}`}>البريد والجوال وروابط الأعمال للمراجعة الداخلية. يظهر للمنشآت الملف المهني الذي تعتمده الإدارة.</p>
    <label>المدينة<input name="city" autoComplete="address-level2" required minLength={2} maxLength={100}/></label><label>سنوات الخبرة<input name="yearsExperience" type="number" min="0" max="80" required/></label>
    <label className={s.full}>التخصصات<input name="expertise" required minLength={2} maxLength={1000} placeholder="إدارة المشاريع، القيادة، التدريب — افصل بفاصلة"/></label>
    <label className={s.full}>لغات التقديم<input name="languages" required minLength={2} maxLength={300} defaultValue="العربية"/></label>
    <label className={s.full}>نبذة عن خبرتك والبرامج التي تقدمها<textarea name="bio" required minLength={30} maxLength={4000} rows={6}/></label>
    <label className={s.full}>رابط السيرة أو ملف الأعمال (اختياري)<input name="portfolioUrl" type="url" pattern="https://.*" maxLength={2000} placeholder="https://" dir="ltr"/></label>
    <label className={s.trap} aria-hidden="true">الموقع<input name="website" tabIndex={-1} autoComplete="off"/></label>
    <label className={`${s.check} ${s.full}`}><input type="checkbox" name="consent" required/><span>أوافق على معالجة بيانات الطلب والتواصل معي لمراجعته وفق <a href="/p/privacy-policy" target="_blank" rel="noreferrer">سياسة الخصوصية</a>، وعلى نشر بياناتي المهنية بعد اعتمادها. أعلم أن تقديم الطلب لا يضمن القبول أو إسناد أعمال.</span></label>
    {error&&<p className={`${s.error} ${s.full}`} role="alert">{error}</p>}<button className={`${s.primary} ${s.full}`} data-block-reason="يجري إرسال طلب الانضمام؛ انتظر رسالة التأكيد." disabled={busy}>{busy?'جارٍ إرسال الطلب…':'إرسال طلب الانضمام'}</button>
  </form></section>;
}
