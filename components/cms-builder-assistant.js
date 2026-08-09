'use client';

import {useEffect,useRef,useState} from 'react';
import {compactCmsDocument} from '../lib/cms-assistant-operations.mjs';
import styles from './page-builder.module.css';

const SUGGESTIONS=[
  'حسّن تصميم القسم المحدد واجعله أكثر احترافية',
  'راجع نسخة الجوال وعدّل المسافات والأحجام',
  'قوّي العنوان والنص التسويقي مع الحفاظ على المعنى',
  'أضف قسم مزايا واضح بثلاثة أعمدة'
];

export default function CmsBuilderAssistant({
  open,onClose,document,entity,context,selection,device,proposal,onPlan,onApply,onDiscard
}){
  const [prompt,setPrompt]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [messages,setMessages]=useState([]);
  const textareaRef=useRef(null);
  const scrollRef=useRef(null);

  useEffect(()=>{if(open)window.setTimeout(()=>textareaRef.current?.focus(),80)},[open]);
  useEffect(()=>{scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight,behavior:'smooth'})},[messages,proposal,busy]);
  if(!open)return null;

  async function submit(value=prompt){
    const request=String(value||'').trim();
    if(request.length<3||busy)return;
    setBusy(true);setError('');setPrompt('');
    setMessages(current=>[...current,{role:'user',text:request}].slice(-12));
    try{
      const response=await fetch('/api/cms/assistant/plan',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          request,siteKey:context.siteKey||'marktone-main',tenantSlug:context.tenantSlug||null,
          entity:{id:entity.id,type:entity.type,title:entity.title,slug:entity.slug},
          device,selection,document:compactCmsDocument(document)
        })
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'تعذر الوصول إلى المساعد.');
      onPlan(result.proposal);
      setMessages(current=>[...current,{role:'assistant',text:result.proposal.summary}].slice(-12));
    }catch(reason){
      const message=reason instanceof Error?reason.message:'تعذر تجهيز التعديل.';
      setError(message);
      setMessages(current=>[...current,{role:'assistant',text:'لم أغيّر الصفحة. '+message,error:true}].slice(-12));
    }finally{setBusy(false)}
  }

  function onKeyDown(event){
    if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit()}
  }

  return <aside className={styles.aiPanel} aria-label="مساعد Marktone CMS">
    <header className={styles.aiHeader}>
      <div className={styles.aiIdentity}><span>✦</span><div><strong>مساعد Marktone CMS</strong><small>تصميم · محتوى · Responsive</small></div></div>
      <button type="button" onClick={onClose} aria-label="إغلاق المساعد">×</button>
    </header>
    <div className={styles.aiScope}><b>مقيّد بالصفحة المفتوحة</b><span>لن يصل إلى العملاء أو بقية النظام، ولن يطبق شيئًا دون موافقتك.</span></div>
    <div className={styles.aiMessages} ref={scrollRef}>
      {!messages.length&&<div className={styles.aiWelcome}>
        <span>✦</span><h2>قل لي ماذا تريد أن أنفّذ</h2>
        <p>أفهم العنصر المحدد وبنية الصفحة وهوية ماركتون. سأعرض التغيير على الصفحة قبل تطبيقه.</p>
        <div>{SUGGESTIONS.map(item=><button key={item} type="button" onClick={()=>submit(item)}>{item}</button>)}</div>
      </div>}
      {messages.map((message,index)=><div key={`${message.role}-${index}`} className={`${styles.aiMessage} ${message.role==='user'?styles.aiMessageUser:styles.aiMessageAssistant} ${message.error?styles.aiMessageError:''}`}><b>{message.role==='user'?'أنت':'المساعد'}</b><p>{message.text}</p></div>)}
      {busy&&<div className={styles.aiThinking}><span/><span/><span/><b>أجهز معاينة آمنة…</b></div>}
      {proposal&&<section className={styles.aiProposal}>
        <header><span>معاينة جاهزة</span><b>{proposal.summary}</b></header>
        <p>{proposal.rationale}</p>
        <ul>{proposal.changes.map(change=><li key={change}>{change}</li>)}</ul>
        {proposal.warnings?.length>0&&<div className={styles.aiWarnings}>{proposal.warnings.map(item=><span key={item}>تنبيه: {item}</span>)}</div>}
        <div className={styles.aiProposalActions}><button type="button" onClick={onApply}>تطبيق التعديلات</button><button type="button" onClick={onDiscard}>إلغاء المعاينة</button></div>
        <small>بعد التطبيق يمكنك استخدام «تراجع» فورًا، ولن تُنشر الصفحة إلا عند ضغط «نشر».</small>
      </section>}
      {error&&<div className={styles.aiInlineError}>{error}</div>}
    </div>
    <footer className={styles.aiComposer}>
      {selection&&<span className={styles.aiSelection}>الهدف الحالي: {selectionLabel(selection)}</span>}
      <div><textarea ref={textareaRef} value={prompt} onChange={event=>setPrompt(event.target.value)} onKeyDown={onKeyDown} rows={3} maxLength={2400} placeholder="مثال: اجعل هذا القسم أفخم، اختصر النص، وحسّن الجوال…"/><button type="button" disabled={busy||prompt.trim().length<3} onClick={()=>submit()} aria-label="إرسال الطلب">↑</button></div>
      <small>Enter للإرسال · Shift + Enter لسطر جديد</small>
    </footer>
  </aside>;
}

function selectionLabel(selection){
  if(selection.kind==='module')return 'العنصر المحدد';
  if(selection.kind==='column')return 'العمود المحدد';
  if(selection.kind==='row')return 'الصف المحدد';
  return 'البلوك المحدد';
}
