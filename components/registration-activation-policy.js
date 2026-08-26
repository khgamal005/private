'use client';

import {useState} from 'react';
import styles from './registration-activation-policy.module.css';

export default function RegistrationActivationPolicy({initialPolicy}){
  const [policy,setPolicy]=useState(initialPolicy);
  const [mode,setMode]=useState(initialPolicy.activationMode||'manual_review');
  const [ttl,setTtl]=useState(initialPolicy.emailConfirmationTtlMinutes||60);
  const [planKey,setPlanKey]=useState(initialPolicy.trialPlanKey||'free');
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [canaryRecipient,setCanaryRecipient]=useState('');
  const [canaryBusy,setCanaryBusy]=useState(false);
  const [killSwitchAcknowledged,setKillSwitchAcknowledged]=useState(false);

  function edit(callback){
    setNotice('');
    setError('');
    callback();
  }

  async function save(event){
    event.preventDefault();
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/platform/registration-policy',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          activationMode:mode,
          emailConfirmationTtlMinutes:Number(ttl),
          trialPlanKey:planKey
        })
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'تعذر حفظ الإعداد');
      setPolicy(result.data);
      setNotice('تم حفظ سياسة تفعيل طلبات التسجيل الجديدة.');
    }catch(reason){
      setError(reason instanceof Error?reason.message:'تعذر حفظ الإعداد');
    }finally{setBusy(false);}
  }

  async function sendCanary(){
    setCanaryBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/platform/registration-email-canary',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({recipient:canaryRecipient})
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'تعذر إرسال الاختبار');
      setNotice('قبل Resend رسالة الاختبار. ننتظر الآن إثبات التسليم الموقّع…');
      for(let attempt=0;attempt<20;attempt++){
        await new Promise(resolve=>setTimeout(resolve,3_000));
        const statusResponse=await fetch(
          '/api/platform/registration-email-canary',
          {cache:'no-store'}
        );
        const status=await statusResponse.json().catch(()=>({}));
        if(!statusResponse.ok)continue;
        setPolicy(current=>({...current,...status.data}));
        if(status.data?.emailCanaryReady===true){
          setNotice('تم إثبات تسليم رسالة الاختبار. أصبح مسار البريد جاهزًا للتفعيل.');
          return;
        }
        if(['failed','bounced','suppressed','complained'].includes(
          status.data?.emailCanaryState
        )){
          throw new Error('فشل تسليم رسالة الاختبار. راجع حالة الرسالة في Resend ثم أعد المحاولة.');
        }
      }
      setNotice('تم قبول الاختبار وما زلنا ننتظر إشعار التسليم. يمكنك تحديث الصفحة بعد قليل.');
    }catch(reason){
      setError(reason instanceof Error?reason.message:'تعذر إرسال الاختبار');
    }finally{setCanaryBusy(false);}
  }

  const changed=mode!==policy.activationMode
    ||Number(ttl)!==Number(policy.emailConfirmationTtlMinutes)
    ||planKey!==policy.trialPlanKey;
  const emailBlockReason=policy.emailSendReady===true
    ?policy.emailTelemetryReady!==true
      ?'إرسال البريد جاهز، لكن Webhook الموقّع غير جاهز لإثبات التسليم والارتداد.'
      :'الإرسال وWebhook جاهزان، ويلزم نجاح اختبار تسليم إنتاجي معزول قبل فتح التفعيل.'
    :'مسار إرسال بريد التسجيل غير جاهز؛ تحقق من المرسل، إثبات النطاق، مفتاح التوقيع، وعامل الطابور.';
  const emailBlockNextStep=policy.emailSendReady===true
    ?policy.emailTelemetryReady!==true
      ?'اربط Webhook الخاص بالتسجيل، ثم حدّث الشاشة.'
      :'أرسل اختبار الإنتاج من البطاقة أدناه وانتظر ظهور إثبات التسليم.'
    :'أكمل فحص صحة مسار البريد، ثم حدّث الشاشة وأعد فحص الجاهزية.';
  const automaticFieldBlockReason=mode!=='email_verified_trial'
    ?'اختر «تفعيل بعد تأكيد البريد» أولًا لتعديل هذا الإعداد.'
    :'';
  const saveNeedsAcknowledgement=policy.activationMode==='email_verified_trial'
    &&mode==='manual_review'
    &&!killSwitchAcknowledged;
  const saveBlockReason=busy
    ?'يجري حفظ إعداد آخر الآن.'
    :!changed
      ?'لم تُجرِ أي تغيير على سياسة التفعيل.'
      :saveNeedsAcknowledgement
        ?'أكد إيقاف التفعيل التلقائي قبل حفظ التحويل إلى المراجعة اليدوية.'
        :'';

  return <section className={styles.card} dir="rtl">
    <header>
      <div><small>REGISTRATION ACTIVATION</small><h3>سياسة تفعيل المنشآت الجديدة</h3><p>حدد ما يحدث بعد إرسال طلب التسجيل. المنشآت القائمة تبقى دائمًا في المراجعة اليدوية للحماية من الاستيلاء.</p></div>
      <span className={policy.emailReady?styles.ready:styles.notReady}><i/>{policy.emailReady?'بريد التأكيد جاهز':'البريد يحتاج إعدادًا'}</span>
    </header>
    <form onSubmit={save} aria-busy={busy}>
      <fieldset disabled={busy}>
      <legend className={styles.visuallyHidden}>إعدادات تفعيل طلبات التسجيل</legend>
      <div className={styles.modes} role="radiogroup" aria-label="وضع تفعيل طلبات التسجيل" aria-describedby="registration-mode-help">
        <label className={mode==='manual_review'?styles.selected:''}><input type="radio" name="activation-mode" value="manual_review" checked={mode==='manual_review'} onChange={()=>edit(()=>{setMode('manual_review');setKillSwitchAcknowledged(false);})}/><span><b>مراجعة قبل التفعيل</b><small>يقبل الفريق الطلب ثم ينشئ مساحة المنشأة بخطوة مستقلة.</small></span></label>
        <label className={mode==='email_verified_trial'?styles.selected:''}><input type="radio" name="activation-mode" value="email_verified_trial" checked={mode==='email_verified_trial'} onChange={()=>edit(()=>{setMode('email_verified_trial');setKillSwitchAcknowledged(false);})} disabled={!policy.emailReady} aria-describedby={!policy.emailReady?'registration-email-help':undefined} data-block-reason={!policy.emailReady?emailBlockReason:undefined} data-block-next-step={!policy.emailReady?emailBlockNextStep:undefined}/><span><b>تفعيل بعد تأكيد البريد</b><small>للمنشآت الجديدة فقط: تعمل مساحة التجربة فور التأكيد الصريح، مع بقاء الموثوقية قيد المراجعة.</small></span></label>
      </div>
      <p id="registration-mode-help" className={styles.modeHelp}>المسار يطبّق على الطلبات الجديدة فقط؛ المنشأة القائمة لا تتفعّل تلقائيًا.</p>
      {!policy.emailReady&&<div id="registration-email-help" className={styles.emailAlert} role="alert">{emailBlockReason} سيظل المسار اليدوي يعمل بأمان حتى اكتمال الإعداد.</div>}
      <section className={styles.canary} aria-labelledby="registration-canary-title">
        <div><b id="registration-canary-title">اختبار تسليم الإنتاج المعزول</b><small>{policy.emailCanaryReady?'تم إثبات التسليم خلال آخر 30 يومًا.':'يرسل رسالة اختبار فقط؛ لا ينشئ طلبًا أو منشأة أو مساحة.'}</small></div>
        {policy.emailSendReady===true&&policy.emailTelemetryReady===true?<div className={styles.canaryAction}><input dir="ltr" type="email" value={canaryRecipient} onChange={event=>setCanaryRecipient(event.target.value.trim())} placeholder="name@example.com" aria-label="بريد مستلم اختبار الإنتاج" disabled={canaryBusy}/><button type="button" onClick={sendCanary} disabled={canaryBusy||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(canaryRecipient)}>{canaryBusy?'جارٍ التحقق…':policy.emailCanaryReady?'إعادة اختبار التسليم':'إرسال اختبار التسليم'}</button></div>:<small>يظهر زر الاختبار تلقائيًا بعد اكتمال المرسل وWebhook.</small>}
      </section>
      <div className={styles.fields}>
        <label><span>صلاحية رابط البريد</span><select value={ttl} onChange={event=>edit(()=>setTtl(Number(event.target.value)))} disabled={mode!=='email_verified_trial'} data-block-reason={automaticFieldBlockReason||undefined} data-block-next-step={automaticFieldBlockReason?'جهّز بريد التأكيد ثم اختر وضع التفعيل البريدي.':undefined}><option value="30">30 دقيقة</option><option value="60">ساعة</option><option value="180">3 ساعات</option><option value="1440">24 ساعة</option></select></label>
        <label><span>باقة المساحة بعد التفعيل</span><input dir="ltr" value={planKey} onChange={event=>edit(()=>setPlanKey(event.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'')))} disabled={mode!=='email_verified_trial'} data-block-reason={automaticFieldBlockReason||undefined} data-block-next-step={automaticFieldBlockReason?'جهّز بريد التأكيد ثم اختر وضع التفعيل البريدي.':undefined} placeholder="free"/></label>
      </div>
      <aside><b>حدود الأمان الثابتة</b><span>لا ربط تلقائي بمنشأة قائمة</span><span>رابط أحادي الاستخدام</span><span>مساحة مستقلة وحالة موثوقية ظاهرة</span><span>يمكن تعليق المساحة عند فشل المراجعة</span></aside>
      {policy.activationMode==='email_verified_trial'&&mode==='manual_review'&&<label className={styles.killSwitch}><input type="checkbox" checked={killSwitchAcknowledged} onChange={event=>setKillSwitchAcknowledged(event.target.checked)}/><span><b>إيقاف التفعيل التلقائي</b><small>الروابط المعلّقة لن تنشئ مساحة بعد التأكيد، وستتحول طلباتها إلى المراجعة اليدوية.</small></span></label>}
      </fieldset>
      {notice&&<div className={styles.notice} role="status">{notice}</div>}
      {error&&<div className={styles.error} role="alert">{error}</div>}
      <footer><small>آخر تحديث: {policy.updatedAt?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(policy.updatedAt)):'لم يُحفظ بعد'}</small><button disabled={busy||!changed||saveNeedsAcknowledgement} data-block-reason={saveBlockReason||undefined} data-block-next-step={saveBlockReason&&!busy?'عدّل الإعداد المطلوب ثم احفظ السياسة.':undefined}>{busy?'جارٍ الحفظ…':'حفظ سياسة التفعيل'}</button></footer>
    </form>
  </section>;
}
