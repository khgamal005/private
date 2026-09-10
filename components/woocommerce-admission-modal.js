'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {initialWooSelections,WOO_ADMISSION_ERRORS} from '../lib/woocommerce-admissions.mjs';
import styles from './woocommerce-admission-modal.module.css';

const amount=value=>new Intl.NumberFormat('ar-SA',{style:'currency',currency:'SAR'}).format(Number(value||0)/100);
const when=(value,timeZone)=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short',timeZone:timeZone||'Asia/Riyadh'}).format(new Date(value)):'غير متاح';

export default function WooCommerceAdmissionModal({slug,task,onClose,onSaved,onLegacy}){
  const [context,setContext]=useState(null),[lines,setLines]=useState([]),[reason,setReason]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const command=useRef(null),dialog=useRef(null),callbacks=useRef({onLegacy,onSaved,onClose});
  useEffect(()=>{callbacks.current={onLegacy,onSaved,onClose};},[onLegacy,onSaved,onClose]);
  const request=useCallback(async(action,body,signal)=>{
    const response=await fetch(`/api/tenant/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),signal});
    const payload=await response.json();
    if(!response.ok)throw new Error(WOO_ADMISSION_ERRORS[payload.error]||payload.error||'تعذر تحميل الطلب');
    return payload.data;
  },[]);
  const load=useCallback(async signal=>{
    setLoading(true);setError('');
    try{
      const data=await request('woocommerce-admission-context',{p_tenant_slug:slug,p_task_id:task.id},signal);
      if(signal?.aborted)return;
      if(!data.enabled&&callbacks.current.onLegacy){callbacks.current.onLegacy(task);return;}
      setContext(data);setLines(initialWooSelections(data));setReason(data.reviewReason||'');command.current=null;
    }catch(err){if(!signal?.aborted)setError(err.message);}
    finally{if(!signal?.aborted)setLoading(false);}
  },[request,slug,task]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[load]);
  useEffect(()=>{
    const previous=document.activeElement;dialog.current?.focus();
    return()=>previous?.focus?.();
  },[]);
  const edit=(index,patch)=>{setLines(current=>current.map((line,i)=>i===index?{...line,...patch}:line));command.current=null;setNotice('');};
  const changed=context?.reviewValid&&JSON.stringify(lines)!==JSON.stringify(context.reviewLines);
  const blockers=context?.blockers||[];
  const reviewBlockers=blockers.filter(key=>key!=='woocommerce_owner_transfer_required');
  const incomplete=lines.length===0||lines.some(line=>!line.courseId);
  const needsReview=context?.reviewRequired&&(!context.reviewValid||changed);
  async function save(action){
    setBusy(true);setError('');setNotice('');
    const payload={p_tenant_slug:slug,p_task_id:task.id,p_action:action,p_expected_revision:context.revision,p_lines:lines,
      p_reason:action==='review'?reason:''};
    const signature=JSON.stringify(payload);
    if(command.current?.signature!==signature)command.current={signature,id:crypto.randomUUID()};
    try{
      const result=await request('woocommerce-admission-action',{...payload,p_command_id:command.current.id});
      if(result.completed){callbacks.current.onSaved?.(result);return;}
      setNotice('تم اعتماد الربط والدورات. يستطيع الموظف الآن إتمام المهمة وإرسالها للتسجيل.');
      await load();
    }catch(err){setError(err.message);}
    finally{setBusy(false);}
  }
  function keyboard(event){
    if(event.key==='Escape'&&!busy){event.stopPropagation();onClose();}
    if(event.key!=='Tab')return;
    const nodes=[...dialog.current.querySelectorAll('button:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')];
    if(!nodes.length){event.preventDefault();return;}
    if(event.shiftKey&&(document.activeElement===nodes[0]||document.activeElement===dialog.current)){
      event.preventDefault();nodes.at(-1).focus();
    }else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0].focus();}
  }
  return <div className={styles.layer}>
    <button className={styles.backdrop} onClick={()=>!busy&&onClose()} aria-label="إغلاق الطلب" tabIndex={-1}/>
    <section className={styles.dialog} ref={dialog} tabIndex={-1} role="dialog" aria-modal="true"
      aria-labelledby="woo-admission-title" dir="rtl" onKeyDown={keyboard}>
      <header><div><small>من طلب الشراء إلى التسجيل</small><h2 id="woo-admission-title">WooCommerce {context?`#${context.orderNumber}`:''}</h2></div>
        <button onClick={onClose} disabled={busy} aria-label="إغلاق">×</button></header>
      <div className={styles.body} aria-busy={loading||busy}>
        {loading&&<p role="status">جارٍ تحميل تفاصيل الطلب…</p>}
        {error&&<div className={styles.error} role="alert">{error}<button onClick={()=>load()} disabled={busy||loading}>تحديث البيانات</button></div>}
        {notice&&<p className={styles.success} role="status">{notice}</p>}
        {context&&!loading&&<>
          <div className={styles.summary}>
            <div><small>العميل</small><b>{context.contactName}</b></div>
            <div><small>إجمالي الدفع</small><b>{amount(context.amountMinor)}</b></div>
            <div><small>تاريخ الدفع الفعلي</small><b>{when(context.paidAt,context.timeZone)}</b></div>
          </div>
          {context.receipt?<p className={styles.success}>تم إرسال الطلب للتسجيل بتاريخ {when(context.receipt.submittedAt,context.timeZone)}. لا يلزم إرساله مرة أخرى.</p>:<>
            {blockers.length>0&&<div className={styles.warning} role="status">{blockers.map(key=><p key={key}>{WOO_ADMISSION_ERRORS[key]||key}</p>)}</div>}
            <p className={styles.hint}>اختر الدورة لكل بند. يحدد موظف التسجيل والقبول الدفعة وموعد الحضور بعدها.</p>
            {(context.items||[]).map((item,index)=><article className={styles.item} key={item.lineId}>
              <div className={styles.itemTitle}><b>{item.title}</b><span>{amount(item.amountMinor)}{item.quantity!==1?` · الكمية: ${item.quantity}`:''}</span></div>
              <label>الدورة للبند {index+1}<select value={lines[index]?.courseId||''}
                disabled={busy||(!context.canReview&&context.reviewValid)} onChange={event=>edit(index,{courseId:event.target.value,handoffId:null})}>
                <option value="">اختر الدورة</option>{context.courses.map(course=><option key={course.id} value={course.id}>{course.name}</option>)}
              </select></label>
              {(context.reviewRequired||context.canReview)&&<label>التسجيل المرتبط بالبند {index+1}<select value={lines[index]?.handoffId||''}
                disabled={busy||!context.canReview} onChange={event=>edit(index,{handoffId:event.target.value||null})}>
                <option value="">إنشاء طلب تسجيل جديد</option>
                {context.candidates.map(h=><option key={h.id} value={h.id} disabled={h.linked||h.amountMinor!==item.amountMinor
                  ||(h.status==='completed'&&h.courseId!==lines[index]?.courseId)}>
                  {h.courseName} · {amount(h.amountMinor)} · مرجع {h.reference||'غير مسجل'}{h.amountMinor!==item.amountMinor?' · مبلغ مختلف':''}{h.linked?' · مرتبط بالفعل':''}
                </option>)}
              </select></label>}
            </article>)}
            {(context.items||[]).length>1&&<p className={styles.hint}>المبالغ موزعة على البنود من إجمالي الطلب بعد الخصم، شاملة أي ضرائب ورسوم. لا يتكرر احتساب الإجمالي.</p>}
            {context.reviewRequired&&<section className={styles.review}>
              <h3>مراجعة التسجيلات السابقة</h3>
              <p>{context.reviewValid&&!changed?'الربط والدورات معتمدة.':'راجع البلاغات السابقة قبل إنشاء تسجيل جديد لنفس عملية الدفع.'}</p>
              {context.canReview?<label>نتيجة المراجعة<textarea rows={3} maxLength={1000} value={reason} disabled={busy}
                onChange={event=>{setReason(event.target.value);command.current=null;}} placeholder="سبب الربط أو إنشاء تسجيل جديد، وأي فروق تمت مراجعتها"/></label>
                :needsReview&&<p>المهمة بانتظار مراجعة مدير المبيعات أو التسجيل والقبول.</p>}
            </section>}
          </>}
        </>}
      </div>
      <footer><button onClick={onClose} disabled={busy}>إغلاق</button>
        {context&&!loading&&!context.receipt&&<>
          {context.canReview&&(context.reviewRequired||changed)&&<button className={styles.secondary}
            onClick={()=>save('review')} disabled={busy||incomplete||reviewBlockers.length>0||reason.trim().length<3}>
            {busy?'جارٍ الحفظ…':'اعتماد المراجعة والربط'}</button>}
          <button className={styles.primary} onClick={()=>save('complete')}
            disabled={busy||incomplete||blockers.length>0||needsReview||!context.canComplete}>
            {busy?'جارٍ الحفظ…':'إتمام وإرسال للتسجيل'}</button>
        </>}
      </footer>
    </section>
  </div>;
}
