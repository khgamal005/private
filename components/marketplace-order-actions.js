'use client';

import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {PaymentMethodPicker} from './payment-method-picker';
import styles from './marketplace-store.module.css';

export function usePendingOrderRefresh(orders){
  const router=useRouter();
  const pending=orders.some(order=>order.status==='pending_payment'&&order.paymentProvider==='tamara');
  useEffect(()=>{
    if(!pending)return;
    let checks=0;
    const refresh=()=>{if(document.visibilityState==='visible')router.refresh();};
    const timer=setInterval(()=>{if(++checks>8){clearInterval(timer);return;}refresh();},15000);
    window.addEventListener('focus',refresh);
    document.addEventListener('visibilitychange',refresh);
    return ()=>{clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[pending,router]);
}

export default function MarketplaceOrderActions({slug,order,methods,canManage,allowReplace=true}){
  const router=useRouter();
  const [mode,setMode]=useState('');
  const [provider,setProvider]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const lock=useRef(false);
  const eligible=order.status==='pending_payment'||(order.status==='cancelled'&&order.paymentProvider==='tamara');
  if(!canManage||!eligible)return null;
  const choices=methods.filter(method=>allowReplace&&['paymob','tamara','bank_transfer'].includes(method.key)
    &&(order.status==='cancelled'||method.key!==order.paymentProvider));
  async function submit(){
    if(lock.current||(mode==='replace'&&!provider))return;
    lock.current=true;
    setBusy(true);setMessage('');
    try{
      const response=await fetch('/api/tenant/'+(order.kind==='service'?'service-marketplace':'marketplace-v2'),{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({p_slug:slug,p_action:mode==='cancel'?'cancel_unpaid_order':'replace_payment',
          p_payload:{orderId:order.id,...(mode==='replace'?{paymentProvider:provider}:{})}})
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
      setMessage(mode==='cancel'?'تم إلغاء طلب الشراء.':`تم تجهيز الطلب ${result.data?.orderNumber||''}. استكمل دفعه من سجل الطلبات.`);
      setMode('');router.refresh();
    }catch(error){setMessage(error.message||'تعذر تنفيذ العملية');router.refresh();}
    finally{lock.current=false;setBusy(false);}
  }
  return <div className={styles.orderRecovery}>
    <div>
      {choices.length>0&&<button type="button" className={styles.payButton} disabled={busy} onClick={()=>{setMode('replace');setProvider(choices[0].key);setMessage('');}}>{order.status==='cancelled'?'إعادة الشراء':'تغيير وسيلة الدفع'}</button>}
      {order.status==='pending_payment'&&<button type="button" className={styles.cancel} disabled={busy} onClick={()=>{setMode('cancel');setMessage('');}}>إلغاء الطلب</button>}
      <button type="button" className={styles.payButton} disabled={busy} onClick={()=>router.refresh()}>تحديث الحالة</button>
    </div>
    {mode&&<div>
      <p>{mode==='cancel'?'هل تريد إلغاء طلب الشراء؟ سنتحقق أولًا من عدم وجود دفعة أو محاولة دفع مفتوحة.':'اختر وسيلة الدفع. يمكن التغيير بعد انتهاء المحاولة السابقة دون دفع، مع الاحتفاظ بسجل الطلب.'}</p>
      {mode==='replace'&&<PaymentMethodPicker methods={choices} value={provider} onChange={setProvider}/>}
      <button type="button" className={styles.payButton} disabled={busy} onClick={submit}>{busy?'جارٍ التحقق…':mode==='cancel'?'تأكيد الإلغاء':'اعتماد وسيلة الدفع'}</button>
      <button type="button" className={styles.payButton} disabled={busy} onClick={()=>setMode('')}>رجوع</button>
    </div>}
    {message&&<p role="status">{message}</p>}
  </div>;
}
