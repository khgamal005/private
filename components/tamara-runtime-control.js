'use client';
import {useState} from 'react';
import styles from './tamara-setup-form.module.css';
export default function TamaraRuntimeControl(){
 const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[errorCode,setErrorCode]=useState(''),[tenant,setTenant]=useState('');
 async function action(action,extra={}){
  if(busy)return;setBusy(true);setError('');setErrorCode('');
  try{
   const response=await fetch('/api/platform/tamara-runtime',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});
   const result=await response.json();if(!response.ok){setErrorCode(/^tamara_[a-z0-9_]{1,100}$/.test(result.code||'')?result.code:'');throw new Error(result.error);}setData(result);
  }catch(err){setError(err.message||'تعذر تحديث حالة الربط');}finally{setBusy(false);}
 }
 const selected=data?.tenants?.find(t=>t.id===tenant);
 return <fieldset disabled={busy}>
  <legend><span>٣</span> تشغيل الدفع للمنشآت</legend>
  <p className={styles.note}>بعد حفظ المفتاحين، جهّز تأكيد الدفع ثم اختر المنشأة التي تريد إتاحة تمارا لها.</p>
  <button type="button" className={styles.probeButton} onClick={()=>action('snapshot')}>عرض حالة التشغيل</button>
  {data&&!data.webhookVerified&&<button type="button" className={styles.probeButton} onClick={()=>action('prepare')}>تجهيز تأكيد الدفع والمطابقة</button>}
  {data?.webhookVerified&&<>
   <p role="status">تم تجهيز رابط الإشعارات. البيئة: {data.environment==='live'?'Live':'Sandbox'}.</p>
   <label>المنشأة<select value={tenant} onChange={event=>setTenant(event.target.value)}><option value="">اختر المنشأة</option>{data.tenants.map(t=><option key={t.id} value={t.id}>{t.name}{t.enabled?' — متاحة':''}</option>)}</select></label>
   <button type="button" className={styles.probeButton} disabled={!selected} onClick={()=>action('rollout',{tenantId:tenant,versionId:data.versionId,enabled:!selected.enabled})}>{selected?.enabled?'إيقاف تمارا للطلبات الجديدة':'إتاحة تمارا لهذه المنشأة'}</button>
  </>}
  {busy&&<p role="status">جارٍ تحديث الربط…</p>}{error&&<p className={styles.error} role="alert" data-error-code={errorCode}>{error}</p>}
 </fieldset>;
}
