'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import styles from './odeiry-assistant.module.css';

const MAX_PROMPT_LENGTH=2000;
const MANAGER_SUGGESTIONS=[
  'من المتصدرون في مؤشرات الفريق خلال آخر 30 يومًا؟',
  'ما المؤشرات التي تحتاج انتباهي الآن؟',
  'ساعدني في التفكير في أولوية إدارية لهذا الأسبوع'
];
const MEMORY_KIND_LABELS={
  preference:'تفضيل إداري',goal:'هدف',constraint:'قيد',
  operating_principle:'مبدأ إداري',decision_context:'سياق قرار'
};
const MANAGER_MEMORY_LIMITS={pending:50,approved:100,archived:20};

export default function OdeiryManagerPanel({
  slug,context,active,chatEnabled=true,onBusyChange
}){
  const [tab,setTab]=useState(chatEnabled?'chat':'memory');
  const [messages,setMessages]=useState([]);
  const [prompt,setPrompt]=useState('');
  const [threadId,setThreadId]=useState('');
  const [workspace,setWorkspace]=useState(emptyWorkspace);
  const [workspaceLoaded,setWorkspaceLoaded]=useState(false);
  const [workspaceBusy,setWorkspaceBusy]=useState(false);
  const [threadBusy,setThreadBusy]=useState(false);
  const [chatBusy,setChatBusy]=useState(false);
  const [reviewBusy,setReviewBusy]=useState('');
  const [error,setError]=useState('');
  const [retryAttempt,setRetryAttempt]=useState(null);
  const composerRef=useRef(null);
  const messagesEndRef=useRef(null);
  const reviewAttemptIds=useRef(new Map());
  const workspaceAttempted=useRef(false);
  const busy=workspaceBusy||threadBusy||chatBusy||Boolean(reviewBusy);
  const pendingCount=workspace.pendingCount||workspace.memories.pending.length;

  const loadWorkspace=useCallback(async({quiet=false}={})=>{
    if(!quiet)setWorkspaceBusy(true);
    if(!quiet)setError('');
    try{
      const data=await managerRequest({action:'workspace',slug:cleanText(slug,120)});
      setWorkspace(normalizeWorkspace(data));
      setWorkspaceLoaded(true);
    }catch(requestError){
      if(!quiet)setError(errorMessage(requestError));
    }finally{
      if(!quiet)setWorkspaceBusy(false);
    }
  },[slug]);

  useEffect(()=>{
    onBusyChange?.(busy);
  },[busy,onBusyChange]);

  useEffect(()=>()=>onBusyChange?.(false),[onBusyChange]);

  useEffect(()=>{
    if(active&&!chatEnabled)setTab('memory');
  },[active,chatEnabled]);

  useEffect(()=>{
    if(!active||workspaceLoaded||workspaceBusy||workspaceAttempted.current)return;
    workspaceAttempted.current=true;
    void loadWorkspace();
  },[active,loadWorkspace,workspaceBusy,workspaceLoaded]);

  useEffect(()=>{
    if(!active||tab!=='chat')return;
    messagesEndRef.current?.scrollIntoView({block:'nearest'});
  },[active,chatBusy,messages,tab]);

  const safeContext=useMemo(()=>normalizeContext(context),[context]);

  function startNewConversation(){
    if(busy||!chatEnabled)return;
    setMessages([]);
    setThreadId('');
    setPrompt('');
    setRetryAttempt(null);
    setError('');
    setTab('chat');
    window.setTimeout(()=>composerRef.current?.focus(),0);
  }

  function retryWorkspace(){
    if(busy)return;
    workspaceAttempted.current=true;
    void loadWorkspace();
  }

  async function openThread(selectedThreadId){
    const safeThreadId=safeUuid(selectedThreadId);
    if(!safeThreadId||busy||!chatEnabled)return;
    setThreadBusy(true);
    setError('');
    try{
      const data=await managerRequest({
        action:'thread',slug:cleanText(slug,120),threadId:safeThreadId
      });
      const loaded=normalizeThread(data,safeThreadId);
      setThreadId(loaded.threadId);
      setMessages(loaded.messages);
      setRetryAttempt(null);
      setTab('chat');
    }catch(requestError){
      setError(errorMessage(requestError));
    }finally{
      setThreadBusy(false);
    }
  }

  async function submitPrompt(event){
    event.preventDefault();
    await askManager(prompt);
  }

  async function askManager(value,existingAttempt=null){
    const message=cleanText(existingAttempt?.message??value,MAX_PROMPT_LENGTH);
    if(!message||busy||!chatEnabled)return;
    const attempt=existingAttempt||{
      message,
      requestId:clientRequestId(),
      threadId:threadId||null,
      context:safeContext
    };
    if(!existingAttempt){
      setMessages(current=>[...current,{id:clientRequestId(),role:'user',text:message}]);
    }
    setPrompt('');
    setChatBusy(true);
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
          assistantMode:'manager_v1',
          ...(attempt.threadId?{threadId:attempt.threadId}:{}),
          context:attempt.context
        })
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok||result?.success===false||result?.ok===false){
        throw new ManagerRequestError(response.status,result);
      }
      const payload=normalizeAssistantPayload(result.data??result);
      if(payload.threadId)setThreadId(payload.threadId);
      setMessages(current=>[...current,{
        id:attempt.requestId,
        role:'assistant',
        ...payload
      }]);
      setRetryAttempt(null);
      void loadWorkspace({quiet:true});
    }catch(requestError){
      retryWithNewRequestId=requestError instanceof ManagerRequestError
        &&requestError.retryWithNewRequestId;
      setRetryAttempt(retryWithNewRequestId?{
        ...attempt,
        requestId:clientRequestId(),
        startsNewRun:true
      }:attempt);
      setError(errorMessage(requestError));
    }finally{
      setChatBusy(false);
      window.setTimeout(()=>composerRef.current?.focus(),0);
    }
  }

  async function reviewMemory(memory,decision){
    const memoryId=safeUuid(memory?.id);
    const expectedVersion=positiveInteger(memory?.version,1);
    if(!memoryId||busy||!['approve','reject','archive'].includes(decision)
       ||(decision==='approve'&&!chatEnabled))return;
    const attemptKey=`${decision}:${memoryId}:${expectedVersion}`;
    let requestId=reviewAttemptIds.current.get(attemptKey);
    if(!requestId){
      requestId=clientRequestId();
      reviewAttemptIds.current.set(attemptKey,requestId);
    }
    setReviewBusy(attemptKey);
    setError('');
    try{
      const result=await managerRequest({
        action:'review_memory',
        slug:cleanText(slug,120),
        memoryId,
        decision,
        expectedVersion,
        clientRequestId:requestId
      });
      reviewAttemptIds.current.delete(attemptKey);
      setWorkspace(current=>applyMemoryDecision(
        current,
        memory,
        decision,
        positiveInteger(result?.version,expectedVersion+1)
      ));
      void loadWorkspace({quiet:true});
    }catch(requestError){
      const staleReview=requestError instanceof ManagerRequestError
        &&(requestError.status===409||requestError.code.includes('VERSION'));
      if(staleReview){
        reviewAttemptIds.current.delete(attemptKey);
        await loadWorkspace({quiet:true});
      }
      setError(errorMessage(requestError));
    }finally{
      setReviewBusy('');
    }
  }

  return <div className={styles.surface} hidden={!active}>
    <div className={styles.managerBody}>
      <section className={styles.managerNotice} role="note">
        <span aria-hidden="true">◇</span>
        <div>
          <b>{chatEnabled?'قراءة وتحليل فقط':'التحليل متوقف — الذاكرة تحت سيطرتك'}</b>
          <p>{chatEnabled
            ?'يقرأ أوديري المؤشرات المصرّح بها من المنشأة الحالية فقط، وقد يعرض أسماء موظفيها المرتبطة بالتحليل. لا ينفّذ أي إجراء، ولا يعتمد أي ذاكرة قبل مراجعتك.'
            :'يمكنك رفض المقترحات أو أرشفة الذاكرة المعتمدة حتى أثناء تعطيل أوديري المدير. لا يمكن اعتماد ذاكرة جديدة أو بدء تحليل الآن.'}</p>
        </div>
      </section>

      <div className={styles.managerTabs} role="tablist" aria-label="مساحات أوديري المدير">
        {chatEnabled&&<button type="button" role="tab" id="odeiry-manager-chat-tab" aria-selected={tab==='chat'} aria-controls="odeiry-manager-chat" tabIndex={tab==='chat'?0:-1} onKeyDown={handleTabKeyDown} onClick={()=>setTab('chat')}>المحادثة</button>}
        {chatEnabled&&<button type="button" role="tab" id="odeiry-manager-history-tab" aria-selected={tab==='history'} aria-controls="odeiry-manager-history" tabIndex={tab==='history'?0:-1} onKeyDown={handleTabKeyDown} onClick={()=>setTab('history')}>السجل</button>}
        <button type="button" role="tab" id="odeiry-manager-memory-tab" aria-selected={tab==='memory'} aria-controls="odeiry-manager-memory" tabIndex={tab==='memory'?0:-1} onKeyDown={handleTabKeyDown} onClick={()=>setTab('memory')}>الذاكرة {pendingCount>0&&<span aria-label={`${pendingCount} مقترح بانتظار المراجعة`}>{pendingCount>99?'99+':pendingCount}</span>}</button>
      </div>

      {error&&<div className={styles.error} role="alert">
        <span>{error}</span>
        {!workspaceLoaded&&<button type="button" className={styles.retryButton} disabled={busy} onClick={retryWorkspace}>إعادة تحميل المساحة</button>}
      </div>}

      <section
        id="odeiry-manager-chat"
        role="tabpanel"
        aria-labelledby="odeiry-manager-chat-tab"
        className={styles.managerTabPanel}
        hidden={!chatEnabled||tab!=='chat'}
      >
        <div className={styles.managerConversation} role="log" aria-live="polite" aria-relevant="additions">
          {!messages.length&&<section className={styles.welcome}>
            <div className={styles.managerWelcomeMark} aria-hidden="true">✦</div>
            <div>
              <h3>مساحة تفكير المدير</h3>
              <p id="odeiry-manager-description">أسأل، أحلّل بيانات المنشأة المصرّح بها، وأوضح مؤشرات الموظفين عند الحاجة. لا أعدّل البيانات ولا أنفّذ أوامر.</p>
            </div>
          </section>}
          {!messages.length&&<ManagerSuggestions disabled={busy} onSelect={askManager}/>} 
          {messages.map(message=><ManagerMessage key={message.id} message={message} disabled={busy} onSuggestion={askManager}/>)}
          {chatBusy&&<div className={styles.typing} aria-label="أوديري المدير يجهز التحليل"><span/><span/><span/><b>أوديري يحلّل السؤال…</b></div>}
          {retryAttempt&&!chatBusy&&<button type="button" className={styles.retryButton} onClick={()=>askManager(retryAttempt.message,retryAttempt)}>{retryAttempt.startsNewRun?'بدء محاولة جديدة':'إعادة المحاولة بأمان'}</button>}
          <div ref={messagesEndRef}/>
        </div>
      </section>

      <section
        id="odeiry-manager-history"
        role="tabpanel"
        aria-labelledby="odeiry-manager-history-tab"
        className={styles.managerTabPanel}
        hidden={!chatEnabled||tab!=='history'}
      >
        <div className={styles.managerSectionHeader}>
          <div><b>محادثاتي الإدارية</b><span>خاصة بحسابك داخل هذه المنشأة.</span></div>
          <button type="button" disabled={busy} onClick={startNewConversation}>محادثة جديدة</button>
        </div>
        {workspaceBusy&&!workspaceLoaded?<LoadingState label="جارٍ تحميل السجل…"/>:
          workspace.threads.length?<div className={styles.managerThreadList}>
            {workspace.threads.map(thread=><button
              key={thread.id}
              type="button"
              disabled={busy}
              aria-current={thread.id===threadId?'true':undefined}
              onClick={()=>openThread(thread.id)}
            ><span><b>{thread.title}</b><small>{formatDate(thread.updatedAt)}</small></span><i aria-hidden="true">←</i></button>)}
          </div>:<EmptyState title="لا توجد محادثات محفوظة" text="ابدأ محادثة إدارية جديدة وستظهر هنا."/>}
      </section>

      <section
        id="odeiry-manager-memory"
        role="tabpanel"
        aria-labelledby="odeiry-manager-memory-tab"
        className={styles.managerTabPanel}
        hidden={tab!=='memory'}
      >
        <div className={styles.managerSectionHeader}>
          <div><b>ذاكرتي الخاضعة للمراجعة</b><span>لا يستخدم أوديري إلا المعلومات التي وافقت عليها.</span></div>
        </div>
        {workspaceBusy&&!workspaceLoaded?<LoadingState label="جارٍ تحميل الذاكرة…"/>:<>
          <MemoryGroup
            title="بانتظار مراجعتك"
            emptyText="لا توجد مقترحات جديدة."
            items={workspace.memories.pending}
            busyKey={reviewBusy}
            onAction={reviewMemory}
            pending
            approvalEnabled={chatEnabled}
          />
          <MemoryGroup
            title="ذاكرة معتمدة"
            emptyText="لم تعتمد أي معلومة بعد."
            items={workspace.memories.approved}
            busyKey={reviewBusy}
            onAction={reviewMemory}
          />
        </>}
      </section>
    </div>

    <footer className={styles.footer}>
      {chatEnabled&&tab==='chat'?<>
        <form className={styles.composer} onSubmit={submitPrompt}>
          <label className={styles.srOnly} htmlFor="odeiry-manager-prompt">اكتب سؤالك لأوديري المدير</label>
          <textarea
            ref={composerRef}
            id="odeiry-manager-prompt"
            value={prompt}
            rows={1}
            maxLength={MAX_PROMPT_LENGTH}
            placeholder="اسأل عن الأداء أو شاركني قرارًا تفكر فيه…"
            disabled={busy}
            onChange={event=>setPrompt(event.target.value)}
            onKeyDown={event=>{
              if(event.key==='Enter'&&!event.shiftKey){
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" aria-label="إرسال السؤال لأوديري المدير" disabled={busy||!prompt.trim()}><SendIcon/></button>
        </form>
        <p>لا ترسل بيانات عملاء أو وسائل اتصال أو كلمات مرور. قد يعرض أوديري أسماء الموظفين ومؤشراتهم المصرّح بها من هذه المنشأة فقط.</p>
      </>:<p className={styles.managerFooterNote}>الذاكرة والسجل شخصيان داخل المنشأة الحالية، ولا ينتقلان إلى منشأة أخرى.</p>}
    </footer>
  </div>;
}

function ManagerMessage({message,disabled,onSuggestion}){
  if(message.role==='user')return <article className={`${styles.message} ${styles.userMessage}`}>
    <span className={styles.messageLabel}>أنت</span><p>{message.text}</p>
  </article>;
  return <article className={`${styles.message} ${styles.assistantMessage}`}>
    <span className={styles.messageLabel}><i aria-hidden="true">✦</i> أوديري المدير</span>
    <p>{message.text}</p>
    {message.steps.length>0&&<div className={styles.steps}><b>نقاط التحليل</b><ol>{message.steps.map((step,index)=><li key={`${message.id}-step-${index}`}><span>{index+1}</span><p>{step}</p></li>)}</ol></div>}
    {message.evidence.length>0&&<div className={styles.evidence}><b>مصادر التحليل</b><ul>{message.evidence.map((item,index)=><li key={`${message.id}-evidence-${index}`}>{item}</li>)}</ul></div>}
    {message.suggestions.length>0&&<ManagerSuggestions compact suggestions={message.suggestions} disabled={disabled} onSelect={onSuggestion}/>} 
  </article>;
}

function ManagerSuggestions({suggestions=MANAGER_SUGGESTIONS,disabled,onSelect,compact=false}){
  return <div className={compact?styles.suggestionsCompact:styles.suggestions} aria-label="أسئلة إدارية مقترحة">
    {!compact&&<span>ابدأ بتحليل آمن</span>}
    {suggestions.map((suggestion,index)=><button key={`${suggestion}-${index}`} type="button" disabled={disabled} onClick={()=>onSelect(suggestion)}><span>{suggestion}</span><i aria-hidden="true">←</i></button>)}
  </div>;
}

function MemoryGroup({
  title,emptyText,items,busyKey,onAction,pending=false,approvalEnabled=true
}){
  return <section className={styles.memoryGroup}>
    <h3>{title}</h3>
    {!items.length?<p className={styles.memoryEmpty}>{emptyText}</p>:<div className={styles.memoryList}>
      {items.map(memory=>{
        const approveKey=`approve:${memory.id}:${memory.version}`;
        const rejectKey=`reject:${memory.id}:${memory.version}`;
        const archiveKey=`archive:${memory.id}:${memory.version}`;
        return <article key={memory.id} className={styles.memoryCard}>
          <header><span>{MEMORY_KIND_LABELS[memory.kind]||'معلومة إدارية'}</span><small>إصدار {memory.version}</small></header>
          <p>{memory.content}</p>
          {memory.reason&&<small className={styles.memoryReason}>{memory.reason}</small>}
          <div>
            {pending?<>
              {approvalEnabled&&<button type="button" className={styles.memoryApprove} disabled={Boolean(busyKey)} onClick={()=>onAction(memory,'approve')}>{busyKey===approveKey?'جارٍ الاعتماد…':'اعتماد'}</button>}
              <button type="button" className={styles.memoryReject} disabled={Boolean(busyKey)} onClick={()=>onAction(memory,'reject')}>{busyKey===rejectKey?'جارٍ الرفض…':'رفض'}</button>
            </>:<button type="button" className={styles.memoryReject} disabled={Boolean(busyKey)} onClick={()=>onAction(memory,'archive')}>{busyKey===archiveKey?'جارٍ الأرشفة…':'أرشفة'}</button>}
          </div>
        </article>;
      })}
    </div>}
  </section>;
}

function EmptyState({title,text}){
  return <div className={styles.managerEmpty}><span aria-hidden="true">◇</span><b>{title}</b><p>{text}</p></div>;
}

function LoadingState({label}){
  return <div className={styles.managerLoading} role="status"><span/><span/><span/><b>{label}</b></div>;
}

function SendIcon(){
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m20 4-8.4 16-1.8-6.1L4 11.5 20 4Z"/><path d="m9.8 13.9 4.5-4.3"/></svg>;
}

function handleTabKeyDown(event){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=Array.from(event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')||[]);
  if(!tabs.length)return;
  event.preventDefault();
  const current=tabs.indexOf(event.currentTarget);
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:
    event.key==='ArrowLeft'?(current+1)%tabs.length:(current-1+tabs.length)%tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}

async function managerRequest(payload){
  const response=await fetch('/api/odeiry/manager',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(payload)
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result?.success===false||result?.ok===false){
    throw new ManagerRequestError(response.status,result);
  }
  return result?.data??result;
}

class ManagerRequestError extends Error{
  constructor(status,result){
    super('manager_request_failed');
    this.status=status;
    this.code=cleanText(result?.error?.code??result?.code,80).toUpperCase();
    this.retryWithNewRequestId=result?.retryWithNewRequestId===true;
  }
}

function errorMessage(error){
  if(error instanceof ManagerRequestError){
    if(error.status===401)return 'انتهت جلسة الدخول. حدّث الصفحة ثم حاول مرة أخرى.';
    if(error.status===403)return 'أوديري المدير غير متاح لهذا الحساب داخل المنشأة.';
    if(error.status===409||error.code.includes('VERSION'))return 'تغيّرت هذه المعلومة منذ فتحها. أعد تحميل الذاكرة ثم راجع النسخة الأحدث.';
    if(error.status===429)return 'وصلت للحد المؤقت من الطلبات. انتظر قليلًا ثم حاول مرة أخرى.';
  }
  return 'تعذر الوصول إلى أوديري المدير الآن. لم يتم تنفيذ أي إجراء.';
}

function normalizeWorkspace(value){
  const root=objectValue(firstValue(value));
  const source=objectValue(root.workspace??root.managerWorkspace??root);
  const threads=arrayValue(source.threads??source.history).map(normalizeThreadSummary).filter(Boolean).slice(0,20);
  const memoryRoot=source.memories??source.memory??[];
  const allMemories=Array.isArray(memoryRoot)?memoryRoot:[];
  const grouped=objectValue(memoryRoot);
  const pending=arrayValue(grouped.pending??grouped.proposed??source.pendingMemories)
    .concat(allMemories.filter(item=>cleanText(item?.status,20)==='proposed'));
  const approved=arrayValue(grouped.approved??source.approvedMemories)
    .concat(allMemories.filter(item=>cleanText(item?.status,20)==='approved'));
  const archived=arrayValue(grouped.archived??source.archivedMemories)
    .concat(allMemories.filter(item=>cleanText(item?.status,20)==='archived'));
  const memories={
    pending:uniqueById(pending.map(normalizeMemory).filter(Boolean))
      .slice(0,MANAGER_MEMORY_LIMITS.pending),
    approved:uniqueById(approved.map(normalizeMemory).filter(Boolean))
      .slice(0,MANAGER_MEMORY_LIMITS.approved),
    archived:uniqueById(archived.map(normalizeMemory).filter(Boolean))
      .slice(0,MANAGER_MEMORY_LIMITS.archived)
  };
  return {
    threads,
    memories,
    pendingCount:Math.max(memories.pending.length,nonNegativeInteger(source.pendingCount,0))
  };
}

function normalizeThreadSummary(value){
  const source=objectValue(value);
  const id=safeUuid(source.id??source.threadId??source.thread_id);
  if(!id)return null;
  return {
    id,
    title:cleanText(source.title,160)||'محادثة إدارية',
    updatedAt:cleanText(source.updatedAt??source.updated_at??source.lastMessageAt??source.last_message_at,80)
  };
}

function normalizeThread(value,fallbackThreadId){
  const root=objectValue(firstValue(value));
  const thread=objectValue(root.thread);
  const threadId=safeUuid(thread.id??thread.threadId??root.threadId??root.thread_id)||fallbackThreadId;
  const messages=arrayValue(root.messages??thread.messages).map(normalizeStoredMessage).filter(Boolean).slice(-80);
  return {threadId,messages};
}

function normalizeStoredMessage(value,index){
  const source=objectValue(value);
  const role=cleanText(source.role??source.messageRole??source.message_role,20)==='user'?'user':'assistant';
  const text=cleanText(source.text??source.content??source.answer,6000);
  if(!text)return null;
  return {
    id:safeUuid(source.id??source.messageId??source.message_id)||`stored-${index}-${cleanText(source.createdAt??source.created_at,40)}`,
    role,
    text,
    steps:[],evidence:[],suggestions:[]
  };
}

function normalizeMemory(value){
  const source=objectValue(value);
  const id=safeUuid(source.id??source.memoryId??source.memory_id);
  const content=cleanText(source.content??source.statement,2000);
  if(!id||!content)return null;
  return {
    id,
    kind:cleanText(source.kind??source.category,40).toLowerCase(),
    content,
    reason:cleanText(source.reason??source.evidenceBasis??source.evidence_basis,500),
    version:positiveInteger(source.version,1)
  };
}

function applyMemoryDecision(workspace,memory,decision,version){
  const current=workspace||emptyWorkspace();
  const next={
    ...current,
    memories:{
      pending:current.memories.pending.filter(item=>item.id!==memory.id),
      approved:current.memories.approved.filter(item=>item.id!==memory.id),
      archived:current.memories.archived.filter(item=>item.id!==memory.id)
    }
  };
  const updated={...memory,version};
  if(decision==='approve')next.memories.approved=[updated,...next.memories.approved];
  if(decision==='archive')next.memories.archived=[updated,...next.memories.archived];
  next.pendingCount=next.memories.pending.length;
  return next;
}

function emptyWorkspace(){
  return {threads:[],memories:{pending:[],approved:[],archived:[]},pendingCount:0};
}

function normalizeAssistantPayload(value){
  const source=objectValue(value);
  return {
    text:cleanText(source.answer??source.reply??source.message,6000)||'لم أتمكن من إعداد تحليل واضح. حاول إعادة صياغة السؤال.',
    steps:textArray(source.steps??source.insights,8,500),
    suggestions:textArray(source.suggestions??source.followUps??source.follow_ups,4,180),
    evidence:normalizeEvidence(source.evidence??source.sources),
    threadId:safeUuid(source.threadId??source.thread_id),
    runId:safeUuid(source.runId??source.run_id)
  };
}

function normalizeEvidence(value){
  if(!Array.isArray(value))return [];
  const items=[];
  for(const entry of value){
    const source=objectValue(entry);
    const normalized=cleanText(typeof entry==='string'?entry:source.title??source.label??source.sourceTitle,180);
    if(normalized&&!items.includes(normalized))items.push(normalized);
    if(items.length===4)break;
  }
  return items;
}

function normalizeContext(value){
  const source=objectValue(value);
  return {
    module:cleanText(source.module,80)||'other',
    pathClass:cleanText(source.pathClass,100)||'workspace.other'
  };
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

function formatDate(value){
  const date=new Date(value);
  if(!value||Number.isNaN(date.getTime()))return 'دون تاريخ';
  return new Intl.DateTimeFormat('ar-EG',{dateStyle:'medium',timeStyle:'short'}).format(date);
}

function uniqueById(items){
  const seen=new Set();
  return items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});
}

function firstValue(value){return Array.isArray(value)?value[0]??{}:value;}
function objectValue(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function arrayValue(value){return Array.isArray(value)?value:[];}
function nonNegativeInteger(value,fallback){const number=Number(value);return Number.isInteger(number)&&number>=0?number:fallback;}
function positiveInteger(value,fallback){const number=Number(value);return Number.isInteger(number)&&number>0?number:fallback;}
function cleanText(value,maxLength){return String(value??'').replace(/\u0000/g,'').trim().slice(0,maxLength);}
function safeUuid(value){const normalized=cleanText(value,36).toLowerCase();return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)?normalized:'';}
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
