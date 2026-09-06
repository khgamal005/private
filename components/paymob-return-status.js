'use client';

import Link from 'next/link';
import {useEffect,useState} from 'react';
import {closePaymobCheckoutWindow} from '../lib/paymob-checkout-window';
import styles from './marketplace-store.module.css';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AUTOMATIC_CHECKS=24;

export default function PaymobReturnStatus({slug,attemptId}){
  const [snapshot,setSnapshot]=useState(null);
  const [phase,setPhase]=useState(UUID.test(attemptId)?'checking':'invalid');
  const [message,setMessage]=useState('');
  const [retryCycle,setRetryCycle]=useState(0);

  useEffect(()=>{
    if(!UUID.test(attemptId))return undefined;
    let active=true;
    let timer=null;
    let checks=0;
    const controller=new AbortController();
    const finish=nextPhase=>{
      closePaymobCheckoutWindow();
      setPhase(nextPhase);
    };

    async function check(){
      checks+=1;
      const requestGuard=boundedFetchSignal(controller.signal,10000);
      try{
        const response=await fetch('/api/payments/paymob/status',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({slug,attemptId}),
          cache:'no-store',
          credentials:'same-origin',
          signal:requestGuard.signal
        });
        const result=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(result.error||'تعذر التحقق من حالة الدفع');
        if(!active)return;
        setSnapshot(result);
        setMessage('');

        if(result.paymentStatus==='paid'){
          finish('paid');
          return;
        }
        if(result.resultCode==='issuer_declined_retry_available'){
          closePaymobCheckoutWindow();
          setPhase('declined');
          return;
        }
        if(result.attemptStatus==='quarantined'){
          closePaymobCheckoutWindow();
          setPhase('review');
          return;
        }
        if(result.terminal===true){
          finish('failed');
          return;
        }
        if(checks>=MAX_AUTOMATIC_CHECKS){
          setPhase('paused');
          return;
        }
        setPhase(result.attemptStatus==='unknown'?'unknown':'pending');
        timer=setTimeout(check,refreshDelay(result.refreshAfterMs));
      }catch(error){
        if(!active||controller.signal.aborted)return;
        setMessage(requestGuard.didTimeout()
          ?'تأخر رد التحقق من الدفع؛ سنحاول مرة أخرى بأمان.'
          :error instanceof Error?error.message:'تعذر التحقق من حالة الدفع');
        if(checks>=MAX_AUTOMATIC_CHECKS){
          setPhase('paused');
          return;
        }
        setPhase('pending');
        timer=setTimeout(check,3000);
      }finally{
        requestGuard.cleanup();
      }
    }

    setPhase('checking');
    setMessage('');
    check();
    return ()=>{
      active=false;
      controller.abort();
      if(timer)clearTimeout(timer);
    };
  },[attemptId,retryCycle,slug]);

  const content=paymentResultContent(phase,snapshot,message);
  const addonsHref='/tenant/'+encodeURIComponent(slug)+'/addons-store';
  const servicesHref='/tenant/'+encodeURIComponent(slug)+'/services-store';
  const orderHref=snapshot?.orderKind==='service'?servicesHref:addonsHref;

  return <main className={styles.paymentResult} dir="rtl">
    <section className={[styles.paymentResultCard,styles['result_'+content.tone]].join(' ')} aria-live="polite">
      <div className={styles.resultIcon} aria-hidden="true">{content.icon}</div>
      <small>ODEIR × PAYMOB</small>
      <h1>{content.title}</h1>
      <p>{content.description}</p>
      {snapshot?.orderNumber&&<div className={styles.resultOrder}><span>رقم الطلب</span><b dir="ltr">{snapshot.orderNumber}</b></div>}
      {message&&phase!=='paid'&&<div className={styles.resultMessage}>{message}</div>}
      {['checking','pending','unknown'].includes(phase)&&<div className={styles.resultProgress}><i/><span>صفحة Paymob مفتوحة في نافذة مستقلة، وأودير يتابع النتيجة الموثقة هنا تلقائيًا.</span></div>}
      <div className={styles.resultGuard}>صفحة العودة لا تعتمد الدفع ولا تفعّل إضافة أو خدمة. يعتمد أودير فقط الحالة الموثقة من الخادم.</div>
      <footer>
        {phase==='paused'&&<button type="button" onClick={()=>setRetryCycle(value=>value+1)}>تحقق مرة أخرى</button>}
        {phase==='declined'
          ?<Link href={orderHref}>{snapshot?.retryAllowed?'المحاولة ببطاقة أخرى':'العودة إلى الطلب'}</Link>
          :snapshot?.orderKind==='addon'?<Link href={addonsHref}>العودة إلى طلبات الإضافات</Link>
          :snapshot?.orderKind==='service'?<Link href={servicesHref}>العودة إلى طلبات الخدمات</Link>
            :<><Link href={addonsHref}>طلبات الإضافات</Link><Link href={servicesHref}>طلبات الخدمات</Link></>}
      </footer>
    </section>
  </main>;
}

function boundedFetchSignal(parentSignal,timeoutMs){
  const controller=new AbortController();
  let timedOut=false;
  const abortFromParent=()=>controller.abort(parentSignal.reason);
  if(parentSignal.aborted)abortFromParent();
  else parentSignal.addEventListener('abort',abortFromParent,{once:true});
  const timeout=setTimeout(()=>{
    timedOut=true;
    controller.abort('payment_status_timeout');
  },timeoutMs);
  return {
    signal:controller.signal,
    didTimeout:()=>timedOut,
    cleanup:()=>{
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort',abortFromParent);
    }
  };
}

function refreshDelay(value){
  const delay=Number(value);
  if(!Number.isFinite(delay))return 3000;
  return Math.min(15000,Math.max(1500,Math.round(delay)));
}

function paymentResultContent(phase,snapshot,message){
  if(phase==='declined')return {
    tone:'failed',icon:'×',title:'رفض البنك عملية الدفع',
    description:snapshot?.retryAllowed
      ?'لم يعتمد أودير أي دفعة ناجحة. أُغلقت نافذة Paymob تلقائيًا. ارجع إلى نفس الطلب واضغط «استكمال الدفع» لتجربة بطاقة أخرى؛ لا تحتاج إلى إنشاء طلب جديد.'
      :'لم يعتمد أودير أي دفعة ناجحة. انتهت صلاحية هذه المحاولة، ويمكنك العودة إلى الطلب وبدء محاولة آمنة جديدة.'
  };
  if(phase==='paid')return {
    tone:'success',icon:'✓',title:'تم تأكيد الدفع بنجاح',
    description:'وصل التأكيد الموثق إلى أودير وأُغلقت نافذة Paymob. ستظهر حالة الطلب والتفعيل أو بدء التنفيذ وفق نوعه داخل المتجر المختص.'
  };
  if(phase==='failed')return {
    tone:'failed',icon:'×',title:'لم يكتمل الدفع',
    description:snapshot?.paymentStatus==='refunded'
      ?'عملية الدفع مستردة، ولا يوجد تفعيل قائم بسبب هذه المحاولة.'
      :'لم يعتمد أودير هذه العملية، ولم تُفعّل الإضافة ولم يبدأ تنفيذ الخدمة. يمكنك العودة إلى المتجر واستكمال الطلب بأمان.'
  };
  if(phase==='review')return {
    tone:'pending',icon:'!',title:'الدفع قيد المراجعة الآمنة',
    description:'وصلت نتيجة تحتاج مطابقة إضافية. لم يعتمد أودير التفعيل أو بدء الخدمة، فلا تعِد الدفع. تابع الطلب من المتجر إلى أن تنتهي المراجعة.'
  };
  if(phase==='unknown')return {
    tone:'pending',icon:'…',title:'نتيجة العملية قيد المراجعة',
    description:'لم تصل نتيجة حاسمة بعد. لن ننشئ محاولة جديدة تلقائيًا، وسنواصل الاستعلام عن نفس العملية حتى تتضح حالتها.'
  };
  if(phase==='paused')return {
    tone:'pending',icon:'↻',title:'التأكيد لم يصل بعد',
    description:'طلبك محفوظ، لكن تأكيد الدفع قد يستغرق وقتًا أطول. تحقق مرة أخرى أو ارجع إلى سجل الطلبات؛ لا تعِد الدفع قبل معرفة الحالة.'
  };
  if(phase==='invalid')return {
    tone:'failed',icon:'!',title:'رابط متابعة الدفع غير مكتمل',
    description:'ارجع إلى سجل طلبات منشأتك واختر «استكمال الدفع» من الطلب المعلّق.'
  };
  return {
    tone:'pending',icon:'…',title:'جارٍ التحقق من الدفع',
    description:message||'أبقِ هذه الصفحة مفتوحة أثناء الدفع. سيغلق أودير نافذة Paymob ويعرض النتيجة هنا بمجرد وصولها من الخادم؛ فالعودة وحدها لا تعني نجاح الدفع.'
  };
}
