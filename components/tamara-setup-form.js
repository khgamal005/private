'use client';

import {useEffect,useRef,useState} from 'react';
import styles from './tamara-setup-form.module.css';
import TamaraRuntimeControl from './tamara-runtime-control';

export default function TamaraSetupForm({item,busy,onClose,onSubmit}){
  // New account: the operator confirmed Live. Preserve an already stored
  // bundle's environment; changing the selection never mutates configuration.
  const storedEnvironment=item.environment||'sandbox';
  const configured=new Set(item.configuredSecretKeys||[]);
  const initialEnvironment=configured.size>0?storedEnvironment:'live';
  const [environment,setEnvironment]=useState(initialEnvironment);
  const [probe,setProbe]=useState({loading:false,data:null,error:''});
  const apiInput=useRef(null);
  const requestRef=useRef(null);
  const changed=environment!==storedEnvironment;
  const replaceSecrets=changed||item.requiresFullRotation===true;
  const contractReady=Array.isArray(item.requiredPublicConfigKeys)
    &&item.requiredPublicConfigKeys.length===0;
  const saving=busy==='provider';

  useEffect(()=>()=>requestRef.current?.abort(),[]);

  function invalidateProbe(){
    requestRef.current?.abort();
    requestRef.current=null;
    setProbe({loading:false,data:null,error:''});
  }

  async function checkConnection(){
    if(!apiInput.current?.reportValidity())return;
    const apiToken=apiInput.current.value.trim();
    requestRef.current?.abort();
    const controller=new AbortController();
    requestRef.current=controller;
    setProbe({loading:true,data:null,error:''});
    try{
      const response=await fetch('/api/platform/tamara-preflight',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({environment,apiToken}),
        cache:'no-store',signal:controller.signal
      });
      const result=await response.json();
      if(!response.ok||result?.data?.apiVerified!==true
        ||result.data.environment!==environment){
        throw new Error(result?.error||'تعذر التحقق من اتصال تمارا');
      }
      if(requestRef.current===controller){
        setProbe({loading:false,data:result.data,error:''});
      }
    }catch(error){
      if(!controller.signal.aborted&&requestRef.current===controller){
        setProbe({loading:false,data:null,error:
          error instanceof Error?error.message:'تعذر التحقق من الاتصال'});
      }
    }
  }

  function save(event){
    if(saving||!contractReady||probe.loading||!probe.data?.apiVerified){
      event.preventDefault();
      return;
    }
    onSubmit(event);
  }

  return <form onSubmit={save} className={styles.form} autoComplete="off">
    <div className={styles.intro}>
      <span className={styles.brand}>تمارا</span>
      <div><b>ربط حساب ماركتون بأودير</b>
        <p>مفتاحا حساب تمارا فقط، ثم فحص الاتصال وحفظهما بأمان.</p></div>
    </div>
    <aside className={styles.scope}>
      <b>إعداد مركزي لتحصيل مشتريات أودير</b>
      <span>فحص الاتصال لا ينشئ طلبًا ولا يخصم مبلغًا. إتاحة الدفع تُدار بشكل مستقل لكل منشأة.</span>
    </aside>
    <fieldset disabled={saving}>
      <legend><span>١</span> حساب تمارا</legend>
      <label>بيئة المفاتيح
        <select name="environment" value={environment} onChange={event=>{
          invalidateProbe();setEnvironment(event.target.value);
        }}>
          <option value="live">حقيقية — Live</option>
          <option value="sandbox">تجريبية — Sandbox</option>
        </select>
        <small>Live لحسابك الحقيقي. اختر Sandbox فقط عند استخدام مفاتيح الاختبار.</small>
      </label>
      <label htmlFor="tamara-api-token">API Token — مفتاح الاتصال
        <input ref={apiInput} key={environment} id="tamara-api-token"
          name="secret_apiToken" type="password" dir="ltr"
          autoComplete="new-password" spellCheck={false}
          minLength={20} maxLength={8192} required
          placeholder="الصق API Token كاملًا" onChange={invalidateProbe}/>
        <small>من صفحة Tamara API credentials. لا تستخدم Public key هنا.</small>
      </label>
      <button type="button" className={styles.probeButton}
        disabled={probe.loading} onClick={checkConnection}>
        {probe.loading?'جارٍ فحص الاتصال…':'اختبار الاتصال بدون خصم'}
      </button>
      {probe.error&&<p className={styles.error} role="alert">{probe.error}</p>}
      {probe.data&&<div className={styles.result} role="status">
        <b>تم قبول API Token في بيئة {environment==='live'?'Live':'Sandbox'}</b>
        <p>{probe.data.hasPaymentTypes
          ?'أعادت تمارا وسائل دفع لهذا الحساب بالريال السعودي.'
          :'لم تُرجع تمارا وسائل دفع متاحة لهذا الحساب بالريال السعودي؛ راجع تفعيل الخدمة لدى تمارا.'}</p>
        <small>هذا فحص اتصال فقط. لم تُحفظ المفاتيح ولم تُختبر إشعارات الدفع أو عملية شراء.</small>
      </div>}
    </fieldset>
    <fieldset disabled={saving}>
      <legend><span>٢</span> إعداد تأكيد الدفع</legend>
      <label htmlFor="tamara-notification-key">Notification key — مفتاح تأكيد الإشعارات
        <input key={environment} id="tamara-notification-key"
          name="secret_notificationToken" type="password" dir="ltr"
          autoComplete="new-password" spellCheck={false} maxLength={8192}
          required={replaceSecrets||!configured.has('notificationToken')}
          placeholder={!replaceSecrets&&configured.has('notificationToken')
            ?'محفوظ — اتركه فارغًا للإبقاء عليه':'الصق Notification key كاملًا'}/>
        <small>تجده تحت Other keys في حساب تمارا؛ يظهر في بعض الوثائق باسم Notification Token.</small>
      </label>
    </fieldset>
    {!contractReady&&<p className={styles.error} role="alert">
      إعداد الربط المبسّط غير متاح بعد. يمكنك فحص المفتاح الآن، وسيُتاح الحفظ بعد اكتمال تحديث لوحة المنصة.
    </p>}
    {configured.has('apiToken')&&configured.has('notificationToken')&&<TamaraRuntimeControl/>}
    <div className={styles.summary}>
      <span>طريقة الدفع <b>صفحة تمارا الآمنة</b></span>
      <span>العملة <b>SAR · ريال سعودي</b></span>
    </div>
    <input type="hidden" name="checkout_mode" value="redirect"/>
    <input type="hidden" name="currencies" value="SAR"/>
    <input type="hidden" name="enabled" value="on"/>
    <p className={styles.note}>حفظ الإعداد لا يفعّل التحصيل. استخدم إعداد تشغيل الدفع لإتاحته للمنشأة المطلوبة بعد التحقق.</p>
    <footer>
      <button type="button" onClick={onClose} disabled={saving}>إغلاق</button>
      <button type="submit" className={styles.primary}
        disabled={saving||!contractReady||probe.loading||!probe.data?.apiVerified}>
        {saving?'جارٍ الحفظ…':'حفظ إعدادات تمارا'}
      </button>
    </footer>
  </form>;
}
