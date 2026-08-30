'use client';

import Link from 'next/link';
import {useEffect,useMemo,useRef,useState} from 'react';
import styles from './odeiry-assistant.module.css';

const MAX_PROMPT_LENGTH=2000;
const SAFE_MODULES=new Set([
  'login_access','dashboard','tasks_calendar','courses','sales_crm','admissions',
  'marketing_automation','accounting','team_permissions','reports','website',
  'integrations','addons_marketplace','performance','support','other'
]);
const SAFE_PATH_CLASSES=new Set([
  'workspace.support','workspace.dashboard','workspace.tasks_calendar',
  'workspace.courses','workspace.sales_crm','workspace.admissions',
  'workspace.marketing_automation','workspace.accounting',
  'workspace.team_permissions','workspace.reports','workspace.website',
  'workspace.integrations','workspace.addons_marketplace',
  'workspace.performance','workspace.other'
]);
const PATH_MODULES={
  'workspace.support':'support','workspace.dashboard':'dashboard',
  'workspace.tasks_calendar':'tasks_calendar','workspace.courses':'courses',
  'workspace.sales_crm':'sales_crm','workspace.admissions':'admissions',
  'workspace.marketing_automation':'marketing_automation',
  'workspace.accounting':'accounting','workspace.team_permissions':'team_permissions',
  'workspace.reports':'reports','workspace.website':'website',
  'workspace.integrations':'integrations','workspace.addons_marketplace':'addons_marketplace',
  'workspace.performance':'performance','workspace.other':'other'
};
const TICKET_MODULES=new Set([
  'login_access','dashboard','tasks_calendar','courses','sales_crm','admissions',
  'marketing_automation','accounting','team_permissions','reports','website',
  'integrations','addons_marketplace','performance','other'
]);
const PRIORITIES=new Set(['urgent','high','medium','low']);
const IMPACTS=new Set(['blocked','multiple_users','single_user','minor','question','security']);
const PRIORITY_LABELS={urgent:'حرجة',high:'عالية',medium:'متوسطة',low:'منخفضة'};
const IMPACT_LABELS={
  blocked:'توقف كامل',multiple_users:'عدة مستخدمين',single_user:'مستخدم واحد',
  minor:'أثر محدود',question:'استفسار',security:'اشتباه أمني'
};
const MODULE_LABELS={
  login_access:'الدخول والوصول',dashboard:'لوحة القيادة',tasks_calendar:'تقويم المهام',
  courses:'الدبلومات والدورات',sales_crm:'المبيعات والعملاء',
  admissions:'التسجيل والقبول',marketing_automation:'التسويق والأتمتة',
  accounting:'الحسابات والفوترة',team_permissions:'فريق العمل والصلاحيات',
  reports:'التقارير والتحليل',website:'الموقع الإلكتروني',
  integrations:'التكاملات والمزامنة',addons_marketplace:'الإضافات والمتجر',
  performance:'الأداء والسرعة',other:'قسم آخر'
};
const MODULE_SUGGESTIONS={
  tasks_calendar:['كيف أنشئ مهمة وأحدد موعدها؟','لماذا تظهر المهمة متأخرة؟'],
  courses:['كيف أضيف دورة جديدة؟','كيف أنظم المحاضرات داخل الدورة؟'],
  sales_crm:['كيف أضيف عميلًا وأتابعه؟','كيف أوزّع العملاء على فريق المبيعات؟'],
  admissions:['ما خطوات تسجيل وقبول متدرب؟','كيف أتابع طلبات القبول المعلّقة؟'],
  marketing_automation:['كيف أبدأ حملة تسويقية؟','كيف تعمل الأتمتة داخل أودير؟'],
  accounting:['كيف أنشئ عرض سعر أو فاتورة؟','كيف أسجل دفعة للعميل؟'],
  team_permissions:['كيف أضيف موظفًا وأحدد صلاحياته؟','لماذا لا يرى الموظف أحد الأقسام؟'],
  reports:['كيف أقرأ تقارير الأداء؟','كيف أراجع أداء موظف محدد؟'],
  website:['كيف أعدّل صفحة في موقعي؟','كيف أنشر محتوى جديدًا؟'],
  integrations:['كيف أتحقق من حالة المزامنة؟','ما البيانات المطلوبة لربط إضافة؟'],
  addons_marketplace:['كيف أفعّل إضافة لمنشأتي؟','أين أجد الإضافات المثبتة؟'],
  support:['ساعدني في تشخيص مشكلة قبل فتح تذكرة','كيف أتابع تذكرة دعم قائمة؟']
};
const DEFAULT_SUGGESTIONS=[
  'اشرح لي كيف أبدأ العمل في هذا القسم',
  'ساعدني في حل مشكلة داخل أودير',
  'أعطني خطوات تنفيذ مهمة شائعة'
];
const FOCUSABLE_SELECTOR=[
  'a[href]','button:not([disabled])','textarea:not([disabled])',
  'input:not([disabled])','select:not([disabled])','[tabindex]:not([tabindex="-1"])'
].join(',');

export default function OdeiryAssistant({slug,context=null,accessMode='tenant_member'}){
  const safeContext=useMemo(()=>normalizeContext(context),[context]);
  const platformOperator=accessMode==='platform_operator';
  const starterSuggestions=useMemo(
    ()=>MODULE_SUGGESTIONS[safeContext.module]||DEFAULT_SUGGESTIONS,
    [safeContext.module]
  );
  const [open,setOpen]=useState(false);
  const [messages,setMessages]=useState([]);
  const [prompt,setPrompt]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [retryAttempt,setRetryAttempt]=useState(null);
  const [availability,setAvailability]=useState('ready');
  const [threadId,setThreadId]=useState('');
  const [pendingTicket,setPendingTicket]=useState(null);
  const [ticketBusy,setTicketBusy]=useState(false);
  const [ticketError,setTicketError]=useState('');
  const [ticketOutcomes,setTicketOutcomes]=useState({});
  const launcherRef=useRef(null);
  const panelRef=useRef(null);
  const closeRef=useRef(null);
  const composerRef=useRef(null);
  const messagesEndRef=useRef(null);
  const confirmationRef=useRef(null);
  const confirmationCancelRef=useRef(null);
  const ticketAttemptIds=useRef(new Map());
  const ticketLinkAttemptIds=useRef(new Map());
  const interactionLockedRef=useRef(false);
  const pendingTicketRef=useRef(null);

  const interactionLocked=busy||ticketBusy;
  const composerDisabled=interactionLocked||availability!=='ready';
  interactionLockedRef.current=interactionLocked;
  pendingTicketRef.current=pendingTicket;

  useEffect(()=>{
    if(!open)return undefined;
    const previousFocus=document.activeElement;
    const focusTimer=window.setTimeout(()=>closeRef.current?.focus(),0);
    function handleKeyDown(event){
      if(event.key==='Escape'){
        event.preventDefault();
        if(interactionLockedRef.current)return;
        if(pendingTicketRef.current){
          setPendingTicket(null);
          setTicketError('');
          window.setTimeout(()=>{
            if(composerRef.current&&!composerRef.current.disabled)composerRef.current.focus();
            else closeRef.current?.focus();
          },0);
        }else setOpen(false);
        return;
      }
      if(event.key!=='Tab')return;
      const root=pendingTicketRef.current?confirmationRef.current:panelRef.current;
      const focusable=focusableElements(root);
      if(!focusable.length){
        event.preventDefault();
        root?.focus();
        return;
      }
      const first=focusable[0];
      const last=focusable[focusable.length-1];
      if(event.shiftKey&&document.activeElement===first){
        event.preventDefault();
        last.focus();
      }else if(!event.shiftKey&&document.activeElement===last){
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown',handleKeyDown);
    return ()=>{
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown',handleKeyDown);
      window.setTimeout(()=>{
        const launcher=document.getElementById('odeiry-launcher');
        if(launcher instanceof HTMLElement)launcher.focus();
        else if(previousFocus instanceof HTMLElement&&previousFocus.isConnected){
          previousFocus.focus();
        }
      },0);
    };
  },[open]);

  useEffect(()=>{
    if(!pendingTicket)return;
    const timer=window.setTimeout(()=>confirmationCancelRef.current?.focus(),0);
    return ()=>window.clearTimeout(timer);
  },[pendingTicket]);

  useEffect(()=>{
    if(!open)return;
    messagesEndRef.current?.scrollIntoView({block:'nearest'});
  },[busy,messages,open,ticketOutcomes]);

  function closePanel(){
    if(interactionLocked)return;
    setPendingTicket(null);
    setTicketError('');
    setOpen(false);
  }

  async function submitPrompt(event){
    event.preventDefault();
    await askOdeiry(prompt);
  }

  async function askOdeiry(value,existingAttempt=null){
    const message=cleanText(existingAttempt?.message??value,MAX_PROMPT_LENGTH);
    if(!message||composerDisabled)return;
    const attemptSource=existingAttempt||{
      message,
      requestId:clientRequestId(),
      threadId:threadId||null,
      context:safeContext
    };
    const attempt={...attemptSource,startsNewRun:false};
    if(!existingAttempt){
      const userMessage={id:clientRequestId(),role:'user',text:message};
      setMessages(current=>[...current,userMessage]);
    }
    setPrompt('');
    setBusy(true);
    setError('');
    setRetryAttempt(null);
    let retryWithNewRequestId=false;
    try{
      const response=await fetch('/api/odeiry/chat',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          slug:cleanText(slug,120),
          message,
          clientRequestId:attempt.requestId,
          ...(attempt.threadId?{threadId:attempt.threadId}:{}),
          context:attempt.context
        })
      });
      const result=await response.json().catch(()=>({}));
      const failure=assistantFailure(response,result);
      if(failure){
        retryWithNewRequestId=failure.retryWithNewRequestId;
        if(failure.state!=='error')setAvailability(failure.state);
        throw new Error(failure.message);
      }
      const payload=normalizeAssistantPayload(result.data??result,attempt.context);
      if(payload.threadId)setThreadId(payload.threadId);
      setMessages(current=>[...current,{
        id:attempt.requestId,
        role:'assistant',
        ...payload
      }]);
      setRetryAttempt(null);
    }catch(requestError){
      setRetryAttempt(retryWithNewRequestId?{
        ...attempt,
        requestId:clientRequestId(),
        startsNewRun:true
      }:attempt);
      const message=requestError instanceof Error&&requestError.message
        ?requestError.message
        :'تعذر الوصول إلى أوديري الآن. حاول مرة أخرى بعد قليل.';
      setError(retryWithNewRequestId
        ?`${message} انتهت المحاولة السابقة؛ يمكنك بدء محاولة جديدة.`
        :message);
    }finally{
      setBusy(false);
      window.setTimeout(()=>composerRef.current?.focus(),0);
    }
  }

  function reviewTicketDraft(sourceMessageId,draft,runId){
    if(platformOperator||ticketOutcomes[sourceMessageId]||interactionLocked)return;
    let requestId=ticketAttemptIds.current.get(sourceMessageId);
    if(!requestId){
      requestId=clientRequestId();
      ticketAttemptIds.current.set(sourceMessageId,requestId);
    }
    const safeRunId=safeUuid(runId);
    let linkClientRequestId=safeRunId
      ?ticketLinkAttemptIds.current.get(sourceMessageId)
      :null;
    if(safeRunId&&!linkClientRequestId){
      linkClientRequestId=clientRequestId();
      ticketLinkAttemptIds.current.set(sourceMessageId,linkClientRequestId);
    }
    setTicketError('');
    setPendingTicket({
      sourceMessageId,
      draft,
      runId:safeRunId,
      clientRequestId:requestId,
      linkClientRequestId
    });
  }

  function cancelTicketReview(){
    setPendingTicket(null);
    setTicketError('');
    window.setTimeout(()=>{
      if(composerRef.current&&!composerRef.current.disabled)composerRef.current.focus();
      else closeRef.current?.focus();
    },0);
  }

  async function confirmTicketCreation(){
    if(platformOperator||!pendingTicket||ticketBusy)return;
    setTicketBusy(true);
    setTicketError('');
    const {
      draft,sourceMessageId,runId,linkClientRequestId,
      clientRequestId:attemptId
    }=pendingTicket;
    try{
      const response=await fetch('/api/support/tenant/create_ticket',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          slug:cleanText(slug,120),
          payload:{
            title:draft.title,
            description:draft.description,
            moduleKey:draft.moduleKey,
            impact:draft.impact,
            priority:draft.priority,
            reproductionSteps:draft.reproductionSteps||null,
            expectedResult:draft.expectedResult||null,
            actualResult:draft.actualResult||null,
            clientRequestId:attemptId
          }
        })
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok){
        throw new Error(supportFailureMessage(result,response.status));
      }
      const ticketId=extractTicketId(result.data??result);
      setTicketOutcomes(current=>({...current,[sourceMessageId]:{ticketId}}));
      ticketAttemptIds.current.delete(sourceMessageId);
      setPendingTicket(null);
      setTicketError('');
      if(runId&&safeUuid(ticketId)&&linkClientRequestId){
        void linkTicketProvenance({
          slug,
          runId,
          ticketId,
          clientRequestId:linkClientRequestId
        }).then(linked=>{
          if(linked)ticketLinkAttemptIds.current.delete(sourceMessageId);
        });
      }
    }catch(ticketRequestError){
      setTicketError(ticketRequestError instanceof Error&&ticketRequestError.message
        ?ticketRequestError.message
        :'تعذر إنشاء التذكرة. لم نغيّر معرّف المحاولة، ويمكنك إعادة المحاولة بأمان.');
    }finally{
      setTicketBusy(false);
    }
  }

  return <div className={styles.root} dir="rtl">
    {!open&&<button
      id="odeiry-launcher"
      ref={launcherRef}
      type="button"
      className={styles.launcher}
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label="فتح أوديري، مساعد أودير الذكي"
      onClick={()=>setOpen(true)}
    >
      <OdeiryMark/>
      <span><b>أوديري</b><small>اسألني عن أودير</small></span>
      <i aria-hidden="true">⌃</i>
    </button>}

    {open&&<>
      <button
        type="button"
        className={styles.backdrop}
        aria-label="إغلاق أوديري"
        disabled={interactionLocked}
        onClick={closePanel}
      />
      <section
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="odeiry-title"
        aria-describedby="odeiry-description"
        aria-busy={interactionLocked}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.mark}><OdeiryMark/></span>
            <div>
              <span className={styles.status}><i/> {platformOperator
                ?'وضع إدارة المنصة'
                :'مساعد أودير الذكي'}</span>
              <h2 id="odeiry-title">أوديري</h2>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.closeButton}
            aria-label="إغلاق أوديري"
            disabled={interactionLocked}
            onClick={closePanel}
          >×</button>
        </header>

        <div className={styles.conversation} role="log" aria-live="polite" aria-relevant="additions">
          <section className={styles.welcome}>
            <div className={styles.welcomeIcon}><OdeiryMark/></div>
            <div>
              <h3>أهلًا، أنا أوديري</h3>
              <p id="odeiry-description">{platformOperator
                ?'هذه معاينة آمنة داخل المنشأة المفعّلة. يمكنك اختبار الإرشاد، ولن ينشئ هذا الوضع تذكرة باسم المنشأة.'
                :'أساعدك في فهم خطوات العمل وحل المشكلات المبدئية داخل أودير، وإذا احتاج الأمر أصيغ لك تذكرة دعم جاهزة للمراجعة.'}</p>
            </div>
          </section>

          {!messages.length&&availability==='ready'&&<SuggestionList
            suggestions={starterSuggestions}
            disabled={composerDisabled}
            onSelect={askOdeiry}
          />}

          {messages.map(message=><ChatMessage
            key={message.id}
            message={message}
            slug={slug}
            ticketOutcome={ticketOutcomes[message.id]}
            disabled={interactionLocked}
            platformOperator={platformOperator}
            onSuggestion={askOdeiry}
            onReviewTicket={(draft,runId)=>reviewTicketDraft(message.id,draft,runId)}
          />)}

          {busy&&<div className={styles.typing} aria-label="أوديري يجهز الإجابة">
            <span/><span/><span/><b>أوديري يراجع سؤالك…</b>
          </div>}

          {availability!=='ready'&&<UnavailableState kind={availability} slug={slug}/>} 
          {error&&<div className={styles.error} role="alert">
            <span>{error}</span>
            {retryAttempt&&availability==='ready'&&<button
              type="button"
              className={styles.retryButton}
              disabled={interactionLocked}
              onClick={()=>askOdeiry(retryAttempt.message,retryAttempt)}
            >{retryAttempt.startsNewRun?'بدء محاولة جديدة':'إعادة المحاولة بأمان'}</button>}
          </div>}
          <div ref={messagesEndRef}/>
        </div>

        <footer className={styles.footer}>
          <form className={styles.composer} onSubmit={submitPrompt}>
            <label className={styles.srOnly} htmlFor="odeiry-prompt">اكتب سؤالك لأوديري</label>
            <textarea
              ref={composerRef}
              id="odeiry-prompt"
              value={prompt}
              rows={1}
              maxLength={MAX_PROMPT_LENGTH}
              placeholder={availability==='ready'?'اكتب سؤالك عن أودير…':'المساعد غير متاح حاليًا'}
              disabled={composerDisabled}
              onChange={event=>setPrompt(event.target.value)}
              onKeyDown={event=>{
                if(event.key==='Enter'&&!event.shiftKey){
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" aria-label="إرسال السؤال" disabled={composerDisabled||!prompt.trim()}>
              <SendIcon/>
            </button>
          </form>
          <p>قدّم أقل قدر ضروري من البيانات، ولا ترسل كلمات مرور أو معلومات حساسة.</p>
        </footer>

        {pendingTicket&&<div className={styles.confirmationOverlay}>
          <section
            ref={confirmationRef}
            className={styles.confirmation}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="odeiry-ticket-confirm-title"
            aria-describedby="odeiry-ticket-confirm-description"
            tabIndex={-1}
          >
            <span className={styles.confirmationIcon}><TicketIcon/></span>
            <h3 id="odeiry-ticket-confirm-title">تأكيد إنشاء تذكرة الدعم</h3>
            <p id="odeiry-ticket-confirm-description">لن تُرسل التذكرة إلا بعد تأكيدك. راجع الملخص ثم اختر «نعم، أنشئ التذكرة».</p>
            <div className={styles.confirmationSummary}>
              <b>{pendingTicket.draft.title}</b>
              <span>{MODULE_LABELS[pendingTicket.draft.moduleKey]||'قسم آخر'} · {PRIORITY_LABELS[pendingTicket.draft.priority]}</span>
            </div>
            {ticketError&&<div className={styles.error} role="alert">{ticketError}</div>}
            <div className={styles.confirmationActions}>
              <button
                ref={confirmationCancelRef}
                type="button"
                className={styles.secondaryButton}
                disabled={ticketBusy}
                onClick={cancelTicketReview}
              >العودة للمراجعة</button>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={ticketBusy}
                onClick={confirmTicketCreation}
              >{ticketBusy?'جارٍ إنشاء التذكرة…':'نعم، أنشئ التذكرة'}</button>
            </div>
          </section>
        </div>}
      </section>
    </>}
  </div>;
}

function ChatMessage({message,slug,ticketOutcome,disabled,platformOperator,onSuggestion,onReviewTicket}){
  if(message.role==='user')return <article className={`${styles.message} ${styles.userMessage}`}>
    <span className={styles.messageLabel}>أنت</span>
    <p>{message.text}</p>
  </article>;
  return <article className={`${styles.message} ${styles.assistantMessage}`}>
    <span className={styles.messageLabel}><i><OdeiryMark/></i> أوديري</span>
    <p>{message.text}</p>
    {message.steps.length>0&&<div className={styles.steps}>
      <b>خطوات العمل</b>
      <ol>{message.steps.map((step,index)=><li key={`${message.id}-step-${index}`}><span>{index+1}</span><p>{step}</p></li>)}</ol>
    </div>}
    {message.evidence.length>0&&<div className={styles.evidence}>
      <b>المراجع داخل أودير</b>
      <ul>{message.evidence.map((item,index)=><li key={`${message.id}-evidence-${index}`}>{item}</li>)}</ul>
    </div>}
    {message.ticketDraft&&<TicketDraftCard
      draft={message.ticketDraft}
      slug={slug}
      outcome={ticketOutcome}
      disabled={disabled}
      platformOperator={platformOperator}
      onReview={()=>onReviewTicket(message.ticketDraft,message.runId)}
    />}
    {message.suggestions.length>0&&<SuggestionList
      compact
      suggestions={message.suggestions}
      disabled={disabled}
      onSelect={onSuggestion}
    />}
  </article>;
}

function TicketDraftCard({draft,slug,outcome,disabled,platformOperator,onReview}){
  const supportHref=outcome?.ticketId
    ?`/tenant/${encodeURIComponent(slug)}/support?scope=mine&ticket=${encodeURIComponent(outcome.ticketId)}`
    :`/tenant/${encodeURIComponent(slug)}/support`;
  return <section className={styles.ticketDraft} aria-label="مسودة تذكرة دعم">
    <header><span><TicketIcon/></span><div><small>مسودة مقترحة — لم تُرسل</small><b>{draft.title}</b></div></header>
    <p>{draft.description}</p>
    <dl>
      <div><dt>القسم</dt><dd>{MODULE_LABELS[draft.moduleKey]||'قسم آخر'}</dd></div>
      <div><dt>الأولوية</dt><dd>{PRIORITY_LABELS[draft.priority]}</dd></div>
      <div><dt>الأثر</dt><dd>{IMPACT_LABELS[draft.impact]}</dd></div>
    </dl>
    {outcome?<div className={styles.ticketCreated} role="status">
      <span>تم إنشاء التذكرة بنجاح.</span>
      <Link href={supportHref}>فتح الدعم الفني</Link>
    </div>:platformOperator?<div className={styles.platformTicketNotice} role="status">
      <span>وضع إدارة المنصة لا ينشئ تذكرة باسم المنشأة.</span>
      <Link href={supportHref}>فتح الدعم الفني</Link>
    </div>:<button type="button" disabled={disabled} onClick={onReview}>مراجعة ثم إنشاء التذكرة</button>}
  </section>;
}

function SuggestionList({suggestions,disabled,onSelect,compact=false}){
  return <div className={compact?styles.suggestionsCompact:styles.suggestions} aria-label="أسئلة مقترحة">
    {!compact&&<span>جرّب سؤالًا سريعًا</span>}
    {suggestions.map((suggestion,index)=><button
      key={`${suggestion}-${index}`}
      type="button"
      disabled={disabled}
      onClick={()=>onSelect(suggestion)}
    ><span>{suggestion}</span><i aria-hidden="true">←</i></button>)}
  </div>;
}

function UnavailableState({kind,slug}){
  const quota=kind==='quota';
  return <section className={styles.unavailable} role="status">
    <span aria-hidden="true">{quota?'◔':'◇'}</span>
    <div>
      <b>{quota?'اكتملت وحدات أوديري المتاحة':'أوديري قيد التجهيز'}</b>
      <p>{quota
        ?'لن تُخصم أي وحدات إضافية. تواصل مع مدير المنشأة عند الحاجة إلى إعادة الشحن.'
        :'سيصبح المساعد متاحًا بعد استكمال إعداد خدمة الذكاء الاصطناعي. يمكنك استخدام الدعم الفني كالمعتاد.'}</p>
      <Link href={`/tenant/${encodeURIComponent(slug)}/support`}>فتح الدعم الفني</Link>
    </div>
  </section>;
}

function OdeiryMark(){
  return <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 3.25c.7 5.7 4.15 9.18 9.9 9.88-5.75.72-9.2 4.2-9.9 9.9-.72-5.7-4.17-9.18-9.9-9.9 5.73-.7 9.18-4.18 9.9-9.88Z"/>
    <path d="M25.3 21.2c.26 2.07 1.5 3.33 3.58 3.6-2.08.25-3.32 1.5-3.58 3.57-.27-2.07-1.52-3.32-3.6-3.58 2.08-.26 3.33-1.52 3.6-3.6Z"/>
  </svg>;
}

function SendIcon(){
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="m20 4-8.4 16-1.8-6.1L4 11.5 20 4Z"/>
    <path d="m9.8 13.9 4.5-4.3"/>
  </svg>;
}

function TicketIcon(){
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h6M8 16h4"/>
  </svg>;
}

function normalizeContext(value){
  const source=value&&typeof value==='object'?value:{};
  const pathClass=SAFE_PATH_CLASSES.has(source.pathClass)?source.pathClass:'workspace.other';
  const inferredModule=PATH_MODULES[pathClass]||'other';
  const moduleKey=SAFE_MODULES.has(source.module)&&source.module===inferredModule
    ?source.module
    :inferredModule;
  return {module:moduleKey,pathClass};
}

function normalizeAssistantPayload(value,context){
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const text=cleanText(source.answer??source.reply??source.message,6000)
    ||'لم أتمكن من إعداد إجابة واضحة. يمكنك إعادة صياغة السؤال أو طلب مسودة تذكرة دعم.';
  return {
    text,
    steps:textArray(source.steps,8,500),
    suggestions:textArray(source.suggestions??source.followUps??source.follow_ups,4,180),
    evidence:normalizeEvidence(source.evidence??source.sources),
    confidence:normalizeConfidence(source.confidence),
    needsHuman:Boolean(source.needsHuman??source.needs_human),
    ticketDraft:normalizeTicketDraft(source.ticketDraft??source.ticket_draft,context),
    threadId:safeUuid(source.threadId??source.thread_id),
    runId:safeUuid(source.runId??source.run_id)
  };
}

function normalizeTicketDraft(value,context){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const diagnostics=value.diagnostics&&typeof value.diagnostics==='object'
    &&!Array.isArray(value.diagnostics)?value.diagnostics:{};
  const title=cleanText(value.title??value.subject,180);
  const description=cleanText(value.description??value.body,8000);
  if(title.length<4||description.length<10)return null;
  const fallbackModule=TICKET_MODULES.has(context.module)?context.module:'other';
  const requestedModule=cleanText(value.moduleKey??value.module_key,80).toLowerCase();
  const priority=cleanText(value.priority,20).toLowerCase();
  const impact=cleanText(value.impact,30).toLowerCase();
  return {
    title,description,
    moduleKey:TICKET_MODULES.has(requestedModule)?requestedModule:fallbackModule,
    priority:PRIORITIES.has(priority)?priority:'medium',
    impact:IMPACTS.has(impact)?impact:'question',
    reproductionSteps:cleanText(
      value.reproductionSteps??value.reproduction_steps
        ??diagnostics.reproductionSteps??diagnostics.reproduction_steps,
      6000
    ),
    expectedResult:cleanText(
      value.expectedResult??value.expected_result
        ??diagnostics.expectedResult??diagnostics.expected_result,
      4000
    ),
    actualResult:cleanText(
      value.actualResult??value.actual_result
        ??diagnostics.actualResult??diagnostics.actual_result,
      4000
    )
  };
}

function normalizeEvidence(value){
  if(!Array.isArray(value))return [];
  const items=[];
  for(const entry of value){
    const label=typeof entry==='string'
      ?entry
      :entry&&typeof entry==='object'
        ?entry.title??entry.label??entry.articleTitle??entry.article_title
        :'';
    const normalized=cleanText(label,180);
    if(normalized&&!items.includes(normalized))items.push(normalized);
    if(items.length===4)break;
  }
  return items;
}

function normalizeConfidence(value){
  if(typeof value==='number'&&Number.isFinite(value)){
    if(value>=0.75)return 'high';
    if(value>=0.45)return 'medium';
    return 'low';
  }
  const normalized=cleanText(value,20).toLowerCase();
  return ['high','medium','low'].includes(normalized)?normalized:'medium';
}

async function linkTicketProvenance({slug,runId,ticketId,clientRequestId}){
  try{
    const response=await fetch('/api/odeiry/link-ticket',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        slug:cleanText(slug,120),
        runId,
        ticketId,
        clientRequestId
      })
    });
    return response.ok;
  }catch{
    return false;
  }
}

function assistantFailure(response,result){
  const error=result?.error&&typeof result.error==='object'?result.error:{};
  const code=cleanText(error.code??result?.code,80).toUpperCase();
  const declaredFailure=result?.success===false||result?.ok===false;
  const retryWithNewRequestId=result?.retryWithNewRequestId===true;
  const failure=(state,message)=>({state,message,retryWithNewRequestId});
  if(response.ok&&!declaredFailure)return null;
  if((result?.unavailable===true&&!code)||[
    'ODEIRY_DISABLED','ODEIRY_UNAVAILABLE','AI_DISABLED','AI_NOT_CONFIGURED'
  ].includes(code))return failure(
    'unavailable',
    'أوديري غير متاح حاليًا. يمكنك استخدام الدعم الفني كالمعتاد.'
  );
  if(code.includes('QUOTA')||code.includes('CREDIT')||code.includes('UNIT')){
    return failure('quota','اكتملت وحدات أوديري المتاحة لهذه المنشأة.');
  }
  if(response.status===401)return failure(
    'error',
    'انتهت جلسة الدخول. حدّث الصفحة ثم حاول مرة أخرى.'
  );
  if(response.status===403)return failure(
    'error',
    'ليست لديك صلاحية استخدام أوديري في هذه المنشأة.'
  );
  if(response.status===429)return failure(
    'error',
    'وصلت للحد المؤقت من الطلبات. انتظر قليلًا ثم حاول مرة أخرى.'
  );
  return failure('error','تعذر الوصول إلى أوديري الآن. حاول مرة أخرى بعد قليل.');
}

function supportFailureMessage(result,status){
  if(status===401)return 'انتهت جلسة الدخول. حدّث الصفحة ثم حاول مرة أخرى.';
  if(status===403)return 'ليست لديك صلاحية إنشاء تذكرة لهذه المنشأة.';
  if(status===429)return 'تم الوصول إلى الحد المؤقت لطلبات الدعم. حاول بعد قليل.';
  const message=cleanText(result?.error??result?.message,300);
  return message||'تعذر إنشاء التذكرة. لم نغيّر معرّف المحاولة، ويمكنك إعادة المحاولة بأمان.';
}

function extractTicketId(value){
  const first=Array.isArray(value)?value[0]:value;
  const source=first&&typeof first==='object'?first:{};
  const ticket=source.ticket&&typeof source.ticket==='object'?source.ticket:{};
  return safeIdentifier(
    source.ticketId??source.ticket_id??source.id??ticket.ticketId??ticket.ticket_id??ticket.id,
    120
  );
}

function focusableElements(root){
  if(!root)return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(element=>{
    if(element.getAttribute('aria-hidden')==='true')return false;
    return element.getClientRects().length>0;
  });
}

function textArray(value,maxItems,maxLength){
  if(!Array.isArray(value))return [];
  const items=[];
  for(const entry of value){
    const normalized=cleanText(entry,maxLength);
    if(normalized&&!items.includes(normalized))items.push(normalized);
    if(items.length===maxItems)break;
  }
  return items;
}

function cleanText(value,maxLength){
  return String(value??'').replace(/\u0000/g,'').trim().slice(0,maxLength);
}

function safeIdentifier(value,maxLength){
  const normalized=cleanText(value,maxLength);
  return /^[a-zA-Z0-9_-]+$/.test(normalized)?normalized:'';
}

function safeUuid(value){
  const normalized=cleanText(value,36).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ?normalized
    :'';
}

function clientRequestId(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  const bytes=new Uint8Array(16);
  if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(bytes);
  else for(let index=0;index<bytes.length;index+=1)bytes[index]=Math.floor(Math.random()*256);
  bytes[6]=(bytes[6]&0x0f)|0x40;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  const value=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
