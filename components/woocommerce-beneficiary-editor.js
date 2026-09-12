'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {beneficiaryPayload,beneficiaryValidation,initialBeneficiaryLines,requestWooBeneficiaries} from '../lib/woocommerce-beneficiaries.mjs';
import styles from './woocommerce-beneficiaries.module.css';

function PersonPicker({person,index,context,slug,taskId,disabled,onChange}){
  const [query,setQuery]=useState(''),[results,setResults]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(person.mode!=='existing'||person.contactId||query.trim().length<2){setResults([]);setLoading(false);return;}
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      setLoading(true);setError('');
      try{const data=await requestWooBeneficiaries('search',{p_tenant_slug:slug,p_task_id:taskId,p_query:query.trim()},controller.signal);
        if(!controller.signal.aborted)setResults(data);}
      catch(err){if(!controller.signal.aborted)setError(err.message);}
      finally{if(!controller.signal.aborted)setLoading(false);}
    },300);
    return()=>{clearTimeout(timer);controller.abort();};
  },[query,person.mode,person.contactId,slug,taskId]);
  return <fieldset className={styles.person} disabled={disabled}>
    <legend>المستفيد {index+1}</legend>
    <div className={styles.modes}>
      <button type="button" aria-pressed={person.contactId===context.contactId} onClick={()=>{
        setQuery('');onChange({mode:'existing',contactId:context.contactId,name:context.contactName,phone:''});
      }}>صاحب الطلب</button>
      <button type="button" aria-pressed={person.mode==='existing'&&person.contactId!==context.contactId} onClick={()=>{
        setQuery('');onChange({mode:'existing',contactId:'',name:'',phone:''});
      }}>عميل موجود</button>
      <button type="button" aria-pressed={person.mode==='new'} onClick={()=>onChange({mode:'new',contactId:'',name:'',phone:''})}>مستفيد جديد</button>
    </div>
    {person.mode==='new'?<div className={styles.fields}>
      <label>اسم المستفيد {index+1}<input value={person.name} maxLength={150} autoComplete="off"
        onChange={event=>onChange({...person,name:event.target.value})} placeholder="الاسم الكامل"/></label>
      <label>جوال المستفيد {index+1}<input value={person.phone} maxLength={24} inputMode="tel" dir="ltr" autoComplete="off"
        onChange={event=>onChange({...person,phone:event.target.value})} placeholder="05xxxxxxxx"/></label>
    </div>:person.contactId?<div className={styles.selected}>
      <div><b>{person.name}</b>{person.phone&&<small dir="ltr">{person.phone}</small>}</div>
      <button type="button" onClick={()=>{setQuery('');onChange({mode:'existing',contactId:'',name:'',phone:''});}}>تغيير</button>
    </div>:<div>
      <label>البحث عن المستفيد {index+1}<input type="search" value={query} maxLength={100} autoComplete="off"
        onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالاسم أو الجوال"/></label>
      {loading&&<small role="status">جارٍ البحث…</small>}
      {error&&<p className={styles.error} role="alert">{error}</p>}
      {results.length>0&&<ul className={styles.results} aria-label={`نتائج المستفيد ${index+1}`}>
        {results.map(contact=><li key={contact.id}><button type="button" onClick={()=>{
          onChange({mode:'existing',contactId:contact.id,name:contact.name,phone:contact.phone||''});setQuery('');
        }}><b>{contact.name}</b><small dir="ltr">{contact.phone}</small></button></li>)}
      </ul>}
      {!loading&&!error&&query.trim().length>=2&&!results.length&&<small>اختر نتيجة البحث، أو استخدم «مستفيد جديد» إن لم يكن مسجلًا.</small>}
    </div>}
  </fieldset>;
}

export default function WooCommerceBeneficiaryEditor({context,slug,taskId,disabled,onBusyChange,onDirtyChange,onSaved}){
  const [lines,setLines]=useState(()=>initialBeneficiaryLines(context));
  const [open,setOpen]=useState(()=>context.items?.some(item=>Number(item.quantity)>1));
  const [dirty,setDirty]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const command=useRef(null);
  useEffect(()=>{setLines(initialBeneficiaryLines(context));setDirty(false);setError('');command.current=null;onDirtyChange(false);},[context,onDirtyChange]);
  const validation=useMemo(()=>beneficiaryValidation(lines),[lines]);
  const total=lines.reduce((sum,line)=>sum+line.beneficiaries.length,0);
  const filled=lines.reduce((sum,line)=>sum+line.beneficiaries.filter(person=>person.mode==='new'?person.name.trim()&&person.phone.trim():person.contactId).length,0);
  function edit(lineIndex,personIndex,person){
    setLines(current=>current.map((line,i)=>i!==lineIndex?line:{...line,beneficiaries:line.beneficiaries.map((p,j)=>j===personIndex?person:p)}));
    setDirty(true);onDirtyChange(true);command.current=null;setError('');
  }
  async function save(){
    if(validation){setError(validation);return;}
    const body={p_tenant_slug:slug,p_task_id:taskId,p_expected_revision:context.revision,p_lines:beneficiaryPayload(lines)};
    const signature=JSON.stringify(body);
    if(command.current?.signature!==signature)command.current={signature,id:crypto.randomUUID()};
    setSaving(true);onBusyChange(true);setError('');
    try{await requestWooBeneficiaries('save',{...body,p_command_id:command.current.id});await onSaved();}
    catch(err){setError(err.message);}
    finally{setSaving(false);onBusyChange(false);}
  }
  return <section className={styles.section} aria-label="تحديد المستفيدين">
    <header className={styles.heading}>
      <div><h3>المستفيدون من المقاعد</h3><small>صاحب الدفع ليس بالضرورة المتدرب.</small></div>
      <button type="button" className={styles.toggle} aria-expanded={Boolean(open)} disabled={disabled||saving} onClick={()=>setOpen(current=>!current)}>
        {open?'طيّ التفاصيل':context.beneficiariesValid?'مراجعة المستفيدين':'تحديد المستفيدين'}
      </button>
    </header>
    {open&&<>
      {lines.map((line,lineIndex)=><div className={styles.line} key={line.lineId}>
        <div className={styles.lineHeading}><b>{line.title}</b><span>{line.quantity} مقعد</span></div>
        <div className={styles.people}>{line.beneficiaries.map((person,personIndex)=><PersonPicker
          key={`${line.lineId}:${personIndex}`} person={person} index={personIndex} context={context}
          slug={slug} taskId={taskId} disabled={disabled||saving} onChange={value=>edit(lineIndex,personIndex,value)}/>)}</div>
      </div>)}
      <div className={styles.saveRow}>
        <div><b>{filled} / {total} مستفيد</b><small>{context.beneficiariesValid&&!dirty?'المستفيدون محفوظون.':dirty?'احفظ المستفيدين قبل اعتماد الربط أو الإرسال.':'حدد شخصًا لكل مقعد. لا يتكرر مبلغ الدفع.'}</small></div>
        <button type="button" className={styles.primary} disabled={disabled||saving||Boolean(validation)||(!dirty&&context.beneficiariesValid)} onClick={save}>
          {saving?'جارٍ حفظ المستفيدين…':'حفظ المستفيدين'}
        </button>
      </div>
      {validation&&filled===total&&<p className={styles.hint}>{validation}</p>}
    </>}
    {error&&<p className={styles.error} role="alert">{error}</p>}
  </section>;
}
