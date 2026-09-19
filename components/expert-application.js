'use client';

import {useRef,useState} from 'react';
import {validateExpertApplication} from '../lib/service-hub.mjs';
import {EXPERTISE_OPTIONS,LANGUAGE_OPTIONS,fileProblem,validateChoices} from '../supabase/functions/_shared/expert-files.mjs';
import s from './service-hub.module.css';

function ChoiceList({name,label,options,defaults=[]}){
  const [selected,setSelected]=useState(defaults),[query,setQuery]=useState('');
  return <div className={s.full}><details className={s.choiceList}><summary>{label}<span>{selected.length?selected.join('، '):'اختر من القائمة'} <span aria-hidden="true">▾</span></span></summary><div className={s.choiceBody}><input type="search" aria-label={`بحث في ${label}`} value={query} onChange={e=>setQuery(e.target.value)} placeholder="ابحث…"/><small>يمكنك اختيار حتى ١٠.</small><div className={s.choiceOptions}>{options.map(option=><label key={option} className={s.check} hidden={!option.includes(query.trim())}><input type="checkbox" name={name} value={option} checked={selected.includes(option)} disabled={!selected.includes(option)&&selected.length>=10} onChange={e=>setSelected(e.target.checked?[...selected,option]:selected.filter(v=>v!==option))}/>{option}</label>)}</div>{!options.some(o=>o.includes(query.trim()))&&<p role="status">لا توجد نتائج. جرّب كلمة أخرى أو اختر «أخرى».</p>}</div></details></div>;
}
function FileField({kind,label,accept,hint,available}){
  const [name,setName]=useState(''),[problem,setProblem]=useState('');
  return <label>{label} (اختياري)<input name={kind} type="file" accept={accept} disabled={!available} onChange={e=>{const file=e.target.files?.[0];const error=file?fileProblem(file,kind):'';setName(file?.name||'');setProblem(error);e.target.setCustomValidity(error);}}/><small>{hint}</small>{name&&<small>{name}</small>}{problem&&<small role="alert" className={s.error}>{problem}</small>}</label>;
}
export default function ExpertApplication({available=true,mediaAvailable=false}){
  const lock=useRef(false),requestKey=useRef(null);const [busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
  async function submit(event){
    event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const form=new FormData(event.currentTarget);const data=Object.fromEntries(form);const payload=validateChoices(validateExpertApplication({...data,expertise:form.getAll('expertise').join('، '),languages:form.getAll('languages').join('، '),consent:data.consent==='on'}));
      const files=['cv','photo'].filter(kind=>form.get(kind)?.size>0);let body,headers;
      if(files.length){body=new FormData();body.set('payload',JSON.stringify(payload));body.set('website',data.website||'');requestKey.current ||= crypto.randomUUID();body.set('requestKey',requestKey.current);for(const kind of files){const file=form.get(kind);const problem=fileProblem(file,kind);if(problem)throw Error(problem);body.set(kind,file);}}
      else{headers={'content-type':'application/json'};body=JSON.stringify({...payload,website:data.website||''});}
      const response=await fetch('/api/experts/apply',{method:'POST',headers,body});
      const result=await response.json();if(!response.ok)throw Error(result.error||'تعذر إرسال الطلب.');setDone(true);
    }catch(e){setError(e.message||'تعذر الاتصال. بياناتك ما زالت محفوظة في النموذج.');}finally{lock.current=false;setBusy(false);}
  }
  if(done)return <section className={`${s.application} ${s.stack}`} role="status"><span className={`${s.badge} ${s.verified}`}>تم استلام طلبك</span><h2>شكرًا لانضمامك إلى خبراء أودير</h2><p>سيراجع الفريق خبرتك وبياناتك قبل اعتماد الملف ونشره للمنشآت. احتفظ بوسيلة التواصل التي أدخلتها متاحة للمتابعة.</p><a href="/" className={s.secondary}>العودة إلى الرئيسية</a></section>;
  if(!available)return <section className={`${s.application} ${s.stack}`}><h2>التسجيل غير متاح مؤقتًا</h2><p>نعمل على تجهيز استقبال طلبات الخبراء والمحاضرين. يرجى العودة لاحقًا.</p><a href="/">العودة إلى الرئيسية</a></section>;
  return <section className={s.application}><form className={s.form} onSubmit={submit} onChange={()=>{requestKey.current=null;}}>
    <div className={s.full}><h2>عرّفنا بخبرتك</h2><p className={s.muted}>الحقول مطلوبة ما لم يُذكر أنها اختيارية.</p></div>
    <label>الاسم الكامل<input name="name" autoComplete="name" required minLength={2} maxLength={150}/></label>
    <label>المجال المهني<select name="type" required defaultValue="lecturer"><option value="lecturer">محاضر</option><option value="trainer">مدرب</option><option value="consultant">خبير / مستشار</option></select></label>
    <label className={s.full}>المسمى المهني<input name="title" required minLength={2} maxLength={180} placeholder="مثال: محاضر ومستشار في إدارة المشروعات"/></label>
    <label>البريد الإلكتروني<input name="email" type="email" autoComplete="email" required maxLength={254} dir="ltr"/></label>
    <label>رقم الجوال مع مفتاح الدولة<input name="phone" type="tel" autoComplete="tel" required minLength={7} maxLength={40} dir="ltr" placeholder="+966…"/></label>
    <p className={`${s.info} ${s.full}`}>البريد والجوال وروابط الأعمال للمراجعة الداخلية. يظهر للمنشآت الملف المهني الذي تعتمده الإدارة.</p>
    <label>المدينة<input name="city" autoComplete="address-level2" required minLength={2} maxLength={100}/></label><label>سنوات الخبرة<input name="yearsExperience" type="number" min="0" max="80" required/></label>
    <ChoiceList name="expertise" label="التخصصات" options={EXPERTISE_OPTIONS}/>
    <ChoiceList name="languages" label="لغات التقديم" options={LANGUAGE_OPTIONS} defaults={['العربية']}/>
    <label className={s.full}>نبذة عن خبرتك والبرامج التي تقدمها<textarea name="bio" required minLength={30} maxLength={4000} rows={6}/></label>
    <FileField kind="cv" label="السيرة الذاتية" accept=".pdf,application/pdf" hint="PDF حتى ٥ ميجابايت. متاحة للإدارة فقط." available={mediaAvailable}/>
    <FileField kind="photo" label="الصورة الشخصية" accept="image/jpeg,image/png,image/webp" hint="JPG أو PNG أو WebP حتى ٢ ميجابايت. تظهر بعد اعتماد ملفك ونشره." available={mediaAvailable}/>
    {!mediaAvailable&&<p className={`${s.info} ${s.full}`}>رفع الملفات غير متاح مؤقتًا. يمكنك إرسال الطلب وإضافة رابط السيرة أو ملف الأعمال.</p>}
    <label className={s.full}>رابط السيرة أو ملف الأعمال (اختياري)<input name="portfolioUrl" type="url" pattern="https://.*" maxLength={2000} placeholder="https://" dir="ltr"/></label>
    <label className={s.trap} aria-hidden="true">الموقع<input name="website" tabIndex={-1} autoComplete="off"/></label>
    <label className={`${s.check} ${s.full}`}><input type="checkbox" name="consent" required/><span>أوافق على معالجة بيانات الطلب والتواصل معي لمراجعته وفق <a href="/p/privacy-policy" target="_blank" rel="noreferrer">سياسة الخصوصية</a>، وعلى نشر بياناتي المهنية وصورتي الشخصية المرفقة بعد اعتماد الملف ونشره. تبقى سيرتي الذاتية للإدارة فقط. أعلم أن تقديم الطلب لا يضمن القبول أو إسناد أعمال.</span></label>
    {error&&<p className={`${s.error} ${s.full}`} role="alert">{error}</p>}<button className={`${s.primary} ${s.full}`} data-block-reason="يجري إرسال طلب الانضمام؛ انتظر رسالة التأكيد." disabled={busy}>{busy?'جارٍ إرسال الطلب…':'إرسال طلب الانضمام'}</button>
  </form></section>;
}
