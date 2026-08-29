'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {
  SUPPORT_ATTACHMENTS_ENABLED,
  SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE
} from '../lib/support-attachment-policy';
import styles from './odeir-support-desk.module.css';

const STATUS_OPTIONS=[
  ['new','جديدة'],
  ['triage','قيد الفرز والإسناد'],
  ['in_progress','قيد المعالجة'],
  ['waiting_tenant','بانتظار رد المنشأة'],
  ['waiting_external','بانتظار جهة خارجية'],
  ['resolved','تم الحل'],
  ['closed','مغلقة'],
  ['reopened','معاد فتحها']
];
const LEGACY_STATUS_LABELS={
  open:'مفتوحة',pending:'جديدة',reviewing:'قيد المراجعة',approved:'معتمدة',
  done:'مكتملة',rejected:'مرفوضة'
};
const PRIORITIES={
  urgent:{code:'P1',label:'حرجة',hint:'توقف كامل أو أثر بالغ'},
  high:{code:'P2',label:'عالية',hint:'عملية رئيسية متوقفة'},
  medium:{code:'P3',label:'متوسطة',hint:'خلل جزئي أو يوجد بديل'},
  low:{code:'P4',label:'منخفضة',hint:'استفسار أو مشكلة محدودة'}
};
const IMPACTS={
  blocked:'توقف كامل',multiple_users:'عدة مستخدمين',single_user:'مستخدم واحد',
  minor:'أثر محدود',question:'استفسار',security:'اشتباه أمني'
};
const MODULES=[
  ['login_access','الدخول والوصول'],['dashboard','لوحة القيادة'],
  ['tasks_calendar','تقويم المهام'],['courses','الدبلومات والدورات'],
  ['sales_crm','المبيعات والعملاء'],['admissions','التسجيل والقبول'],
  ['marketing_automation','التسويق والأتمتة'],['accounting','الحسابات والفوترة'],
  ['team_permissions','فريق العمل والصلاحيات'],['reports','التقارير والتحليل'],
  ['website','الموقع الإلكتروني'],['integrations','التكاملات والمزامنة'],
  ['addons_marketplace','الإضافات والمتجر'],['performance','الأداء والسرعة'],
  ['other','قسم آخر']
];
const PLATFORM_QUEUES=[
  ['all','كل التذاكر'],['new','جديدة'],['unassigned','غير مسندة'],['mine','مسندة لي'],
  ['urgent','الحرجة'],['at_risk','قاربت التجاوز'],['breached','متجاوزة'],
  ['waiting_tenant','بانتظار المنشأة']
];
const TERMINAL_STATUSES=new Set(['resolved','closed','done','rejected']);

export default function OdeirSupportDesk({mode='tenant',slug=null,data={}}){
  const router=useRouter();
  const pathname=usePathname();
  const snapshot=useMemo(()=>normalizeSnapshot(data,mode),[data,mode]);
  const {viewer,summary,tickets,selected,filters,pagination,agents,tenants,queues}=snapshot;
  const [query,setQuery]=useState(filters.query||'');
  const [modalOpen,setModalOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [composerMode,setComposerMode]=useState('public');
  const [replyFiles,setReplyFiles]=useState([]);
  const [newFiles,setNewFiles]=useState([]);
  const [managerDraft,setManagerDraft]=useState(()=>managerValues(selected));
  const [readWatermarks,setReadWatermarks]=useState(()=>new Set());
  const markedRead=useRef(new Set());
  const attachmentRequestIds=useRef(new WeakMap());

  useEffect(()=>{
    setBusy(false);
  },[data]);

  useEffect(()=>{
    setQuery(filters.query||'');
  },[filters.query]);

  useEffect(()=>{
    setManagerDraft(managerValues(selected));
    setMessage('');
    setReplyFiles([]);
    setComposerMode('public');
  },[selected]);

  useEffect(()=>{
    if(!selected?.id||!selected.unreadCount)return;
    const readKey=`${selected.id}:${selected.version}:${selected.unreadCount}`;
    if(markedRead.current.has(readKey))return;
    markedRead.current.add(readKey);
    void callSupportAction({
      mode,slug,action:'mark_read',payload:mutationPayload(selected,{
        readThrough:selected.readWatermark||selected.lastMessageAt||selected.updatedAt||undefined
      })
    }).then(()=>setReadWatermarks(current=>{
      if(current.has(readKey))return current;
      const next=new Set(current);
      next.add(readKey);
      return next;
    })).catch(()=>markedRead.current.delete(readKey));
  },[mode,selected,slug]);

  function navigate(patch,{replace=false}={}){
    const params=new URLSearchParams(window.location.search);
    for(const [key,value] of Object.entries(patch)){
      if(value===null||value===undefined||value===''||value==='all'&&key!=='scope')params.delete(key);
      else params.set(key,String(value));
    }
    const href=params.toString()?`${pathname}?${params}`:pathname;
    setBusy(true);
    (replace?router.replace:router.push)(href);
  }

  function openTicket(ticketId){
    if(!ticketId||ticketId===selected?.id)return;
    navigate({ticket:ticketId});
  }

  function applyQueue(queue){
    navigate({queue,cursorUpdatedAt:null,cursorId:null,ticket:null,status:null,priority:null,assigneeId:null});
  }

  function applyScope(scope){
    navigate({scope,cursorUpdatedAt:null,cursorId:null,ticket:null});
  }

  function applyFilter(key,value){
    navigate({[key]:value,cursorUpdatedAt:null,cursorId:null,ticket:null});
  }

  function applySearch(event){
    event.preventDefault();
    navigate({query:query.trim().slice(0,100),cursorUpdatedAt:null,cursorId:null,ticket:null});
  }

  async function createTicket(event){
    event.preventDefault();
    if(busy)return;
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    setBusy(true);setError('');setNotice('');
    try{
      const diagnostics=browserDiagnostics();
      const result=await callSupportAction({
        mode:'tenant',slug,action:'create_ticket',payload:{
          title:text(values.title).slice(0,180),
          description:text(values.description).slice(0,8000),
          priority:normalizePriority(values.priority),
          moduleKey:normalizeModuleKey(values.moduleKey),
          impact:normalizeImpact(values.impact),
          reproductionSteps:text(values.reproductionSteps).slice(0,6000)||null,
          expectedResult:text(values.expectedResult).slice(0,4000)||null,
          actualResult:text(values.actualResult).slice(0,4000)||null,
          diagnostics,
          clientRequestId:clientRequestId()
        }
      });
      const ticketId=resultId(result,['ticketId','ticket_id','id']);
      const messageId=resultId(result,['messageId','message_id']);
      if(!ticketId)throw new Error('تم إنشاء الطلب لكن تعذر تأكيد رقم التذكرة. حدّث الصفحة قبل إعادة المحاولة.');
      const uploadFailures=SUPPORT_ATTACHMENTS_ENABLED
        ?await uploadFiles(newFiles,{ticketId,messageId,visibility:'public'})
        :0;
      setModalOpen(false);setNewFiles([]);
      setNotice(uploadFailures
        ?`تم فتح التذكرة، وتعذر رفع ${uploadFailures} من المرفقات.`
        :'تم فتح التذكرة وإرسالها إلى فريق دعم ماركتون.');
      const params=new URLSearchParams(window.location.search);
      params.set('ticket',ticketId);
      params.set('scope','mine');
      params.delete('cursorUpdatedAt');
      params.delete('cursorId');
      router.push(`${pathname}?${params}`);
      router.refresh();
    }catch(actionError){
      setError(actionError.message||'تعذر فتح التذكرة.');
    }finally{setBusy(false)}
  }

  async function sendMessage(event){
    event.preventDefault();
    if(!selected?.id||busy||!canReplyToSelected)return;
    const hasReplyFiles=SUPPORT_ATTACHMENTS_ENABLED&&replyFiles.length>0;
    const content=message.trim()||(hasReplyFiles?'أرفق ملفًا للمراجعة.':'');
    if(!content){setError('اكتب الرسالة أو أضف مرفقًا.');return;}
    setBusy(true);setError('');setNotice('');
    try{
      const action=mode==='platform'&&composerMode==='internal'
        ?'add_internal_note'
        :'add_message';
      const result=await callSupportAction({
        mode,slug,action,payload:mutationPayload(selected,{
          content:content.slice(0,12000)
        })
      });
      const messageId=resultId(result,['messageId','message_id','id']);
      const uploadFailures=SUPPORT_ATTACHMENTS_ENABLED
        ?await uploadFiles(replyFiles,{
          ticketId:selected.id,
          messageId,
          visibility:composerMode==='internal'?'internal':'public'
        })
        :0;
      setMessage('');setReplyFiles([]);
      setNotice(uploadFailures
        ?`تم إرسال الرسالة، وتعذر رفع ${uploadFailures} من المرفقات.`
        :composerMode==='internal'?'تم حفظ الملاحظة الداخلية لفريق ماركتون.':'تم إرسال الرد.');
      router.refresh();
    }catch(actionError){setError(actionError.message||'تعذر إرسال الرد.');}
    finally{setBusy(false)}
  }

  async function transitionTenant(action){
    const canTransition=action==='close_ticket'
      ?selected?.canClose
      :action==='reopen_ticket'&&selected?.canReopen;
    if(!selected?.id||busy||mode!=='tenant'||!canTransition)return;
    let reason=null;
    if(action==='reopen_ticket'){
      reason=window.prompt('اكتب باختصار سبب إعادة فتح التذكرة:','المشكلة ما زالت قائمة.')?.trim()||'';
      if(reason.length<3){
        if(reason)setError('سبب إعادة فتح التذكرة يجب ألا يقل عن 3 أحرف.');
        return;
      }
    }
    setBusy(true);setError('');setNotice('');
    try{
      await callSupportAction({mode:'tenant',slug,action,payload:mutationPayload(selected,reason?{reason}:{})});
      setNotice(action==='close_ticket'?'تم تأكيد الحل وإغلاق التذكرة.':'أُعيد فتح التذكرة وإشعار فريق ماركتون.');
      router.refresh();
    }catch(actionError){setError(actionError.message||'تعذر تحديث التذكرة.');}
    finally{setBusy(false)}
  }

  async function savePlatformTicket(){
    if(!selected?.id||busy||!viewer.canReply)return;
    const statusChanged=managerDraft.status!==selected.status;
    const resolutionChanged=managerDraft.resolutionSummary!==selected.resolutionSummary;
    const assignmentChanged=viewer.canManage
      &&String(managerDraft.assigneeId||'')!==String(selected.assigneeId||'');
    if(managerDraft.status==='resolved'
       &&(statusChanged||resolutionChanged)
       &&managerDraft.resolutionSummary.trim().length<3){
      setError('اكتب ملخصًا واضحًا للحل لا يقل عن 3 أحرف قبل نقل التذكرة إلى «تم الحل».');
      return;
    }
    if(TERMINAL_STATUSES.has(selected.status)
       &&statusChanged
       &&managerDraft.status!=='reopened'){
      setError('أعد فتح التذكرة أولًا قبل نقلها إلى حالة أخرى.');
      return;
    }
    const updatePayload={expectedVersion:selected.version};
    if(statusChanged)updatePayload.status=managerDraft.status;
    if(resolutionChanged){
      updatePayload.resolutionSummary=managerDraft.resolutionSummary.trim()||null;
    }
    if(viewer.canManage){
      if(assignmentChanged){
        updatePayload.assigneeSubjectId=managerDraft.assigneeId||null;
      }
      if(managerDraft.priority!==selected.priority){
        updatePayload.priority=managerDraft.priority;
      }
      if(managerDraft.moduleKey!==selected.moduleKey){
        updatePayload.moduleKey=managerDraft.moduleKey;
      }
      if(managerDraft.impact!==selected.impact){
        updatePayload.impact=managerDraft.impact;
      }
    }
    if(Object.keys(updatePayload).length===1){
      setError('لا توجد تغييرات جديدة لحفظها.');
      return;
    }
    setBusy(true);setError('');setNotice('');
    try{
      await callSupportAction({
        mode:'platform',action:'update_ticket',payload:mutationPayload(selected,updatePayload)
      });
      setNotice('تم تحديث التذكرة وتسجيل الإجراء.');
      router.refresh();
    }catch(actionError){setError(actionError.message||'تعذر تحديث التذكرة.');}
    finally{setBusy(false)}
  }

  async function uploadFiles(files,{ticketId,messageId}){
    if(!SUPPORT_ATTACHMENTS_ENABLED)return 0;
    if(!files.length)return 0;
    if(!messageId)return files.length;
    let failures=0;
    for(const file of files){
      try{
        const contextKey=`${ticketId}:${messageId}`;
        let requestIds=attachmentRequestIds.current.get(file);
        if(!requestIds){
          requestIds=new Map();
          attachmentRequestIds.current.set(file,requestIds);
        }
        let requestId=requestIds.get(contextKey);
        if(!requestId){
          requestId=clientRequestId();
          requestIds.set(contextKey,requestId);
        }
        await uploadSupportAttachment(file,{
          ticketId,messageId,clientRequestId:requestId
        });
      }catch{failures+=1;}
    }
    return failures;
  }

  const canReplyToSelected=Boolean(selected&&(mode==='platform'?viewer.canReply:selected.canReply));
  const canCompose=canReplyToSelected&&!TERMINAL_STATUSES.has(selected.status);
  const hasCurrentCursor=Boolean(filters.cursorUpdatedAt&&filters.cursorId);

  return <section className={styles.root} dir="rtl">
    <header className={styles.pageHeader}>
      <div className={styles.headerCopy}>
        <small className={styles.eyebrow}>ODEIR SUPPORT DESK</small>
        <h2>{mode==='tenant'?'الدعم الفني لأودير':'مركز دعم المنشآت'}</h2>
        <p>{mode==='tenant'
          ?'أبلغ فريق ماركتون عن مشكلة في برنامج أودير، وتابع الرد والحل من مسار موثّق.'
          :'استقبال وفرز وإسناد ومعالجة تذاكر منشآت أودير مع متابعة زمن الاستجابة.'}</p>
      </div>
      <div className={styles.headerActions}>
        <button type="button" className={styles.secondaryButton} onClick={()=>router.refresh()} disabled={busy}>تحديث</button>
        {mode==='tenant'&&viewer.canCreate&&<button type="button" className={styles.primaryButton} onClick={()=>{setError('');setModalOpen(true);}}>+ فتح تذكرة</button>}
      </div>
    </header>

    <div aria-live="polite" aria-atomic="true">
      {notice&&<div className={styles.alert} role="status">{notice}</div>}
      {error&&<div className={cx(styles.alert,styles.alertError)} role="alert">{error}</div>}
    </div>

    <Kpis mode={mode} summary={summary}/>

    {mode==='tenant'&&viewer.canViewAll&&!viewer.platformPreview&&<div className={styles.queueTabs} aria-label="نطاق التذاكر">
      <button type="button" className={cx(styles.queueButton,filters.scope==='mine'&&styles.active)} onClick={()=>applyScope('mine')} disabled={busy}>تذاكري</button>
      <button type="button" className={cx(styles.queueButton,filters.scope==='all'&&styles.active)} onClick={()=>applyScope('all')} disabled={busy}>تذاكر المنشأة</button>
    </div>}

    {mode==='platform'&&<div className={styles.queueTabs} aria-label="طوابير الدعم">
      {PLATFORM_QUEUES.map(([key,label])=><button type="button" key={key} className={cx(styles.queueButton,filters.queue===key&&styles.active)} onClick={()=>applyQueue(key)} disabled={busy}>
        {label}<span className={styles.count}>{queueCount(queues,key,summary)}</span>
      </button>)}
    </div>}

    <div className={styles.layout}>
      <aside className={styles.sidebar} aria-label="قائمة التذاكر">
        {mode==='platform'&&<PlatformFilters
          filters={filters}
          query={query}
          setQuery={setQuery}
          applySearch={applySearch}
          applyFilter={applyFilter}
          agents={agents}
          tenants={tenants}
          busy={busy}
        />}
        <div className={styles.ticketList}>
          {tickets.map(ticket=><TicketCard
            key={ticket.id}
            ticket={ticket}
            selected={ticket.id===selected?.id}
            readLocally={readWatermarks.has(ticketReadKey(ticket))}
            mode={mode}
            onOpen={()=>openTicket(ticket.id)}
          />)}
          {!tickets.length&&<div className={styles.empty}><b>لا توجد تذاكر مطابقة</b><p>{mode==='tenant'?'يمكنك فتح تذكرة جديدة عند مواجهة مشكلة في أودير.':'غيّر الطابور أو الفلاتر لعرض تذاكر أخرى.'}</p></div>}
        </div>
        {(pagination.hasMore||hasCurrentCursor)&&<div className={styles.pagination}>
          <button type="button" disabled={busy||!hasCurrentCursor} onClick={()=>navigate({cursorUpdatedAt:null,cursorId:null,ticket:null})}>الصفحة الأولى</button>
          <span>عرض {number(tickets.length)} تذكرة</span>
          <button type="button" disabled={busy||!pagination.hasMore||!pagination.nextCursor?.updatedAt||!pagination.nextCursor?.id} onClick={()=>navigate({cursorUpdatedAt:pagination.nextCursor.updatedAt,cursorId:pagination.nextCursor.id,ticket:null})}>التالي</button>
        </div>}
      </aside>

      <main className={styles.detail}>
        {selected?<>
          <TicketDetailHeader ticket={selected} mode={mode}/>
          <SlaPanel ticket={selected}/>
          <ResolutionSummary ticket={selected} mode={mode}/>
          <Requester ticket={selected}/>
          <DiagnosticsPanel ticket={selected} mode={mode}/>
          {mode==='platform'&&viewer.canReply&&<PlatformManager
            ticket={selected}
            agents={agents}
            canManage={viewer.canManage}
            draft={managerDraft}
            setDraft={setManagerDraft}
            save={savePlatformTicket}
            busy={busy}
          />}
          <Conversation ticket={selected} mode={mode}/>
          {canCompose&&<Composer
            mode={mode}
            canInternalNote={viewer.canInternalNote}
            composerMode={composerMode}
            setComposerMode={setComposerMode}
            message={message}
            setMessage={setMessage}
            files={replyFiles}
            setFiles={setReplyFiles}
            submit={sendMessage}
            busy={busy}
          />}
          {mode==='tenant'&&selected.status==='resolved'&&(selected.canClose||selected.canReopen)&&<div className={styles.detailActions}>
            {selected.canClose&&<button type="button" className={styles.primaryButton} disabled={busy} onClick={()=>transitionTenant('close_ticket')}>تأكيد الحل وإغلاق التذكرة</button>}
            {selected.canReopen&&<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>transitionTenant('reopen_ticket')}>المشكلة ما زالت قائمة</button>}
          </div>}
          {mode==='tenant'&&['closed','done','rejected'].includes(selected.status)&&selected.canReopen&&<div className={styles.detailActions}>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>transitionTenant('reopen_ticket')}>إعادة فتح التذكرة</button>
          </div>}
        </>:<div className={styles.empty}>
          <span>◫</span><b>اختر تذكرة لعرض تفاصيلها</b>
          <p>ستظهر المحادثة والمرفقات وحالة المعالجة وسجل التحديثات هنا.</p>
        </div>}
      </main>
    </div>

    {modalOpen&&<CreateTicketModal
      busy={busy}
      error={error}
      files={newFiles}
      setFiles={setNewFiles}
      close={()=>{if(!busy){setModalOpen(false);setError('');setNewFiles([]);}}}
      submit={createTicket}
    />}
  </section>;
}

function Kpis({mode,summary}){
  const cards=mode==='tenant'?
    [
      ['مفتوحة',summary.open,'قيد المتابعة الآن',''],
      ['بانتظار ردك',summary.waitingTenant,'تحتاج إجراء من المنشأة','warning'],
      ['تم حلها',summary.resolved,'حلول موثّقة','success'],
      ['إجمالي تذاكرك',summary.total,'كل الحالات','']
    ]:
    [
      ['جديدة وغير مسندة',summary.unassigned,'تحتاج فرزًا وإسنادًا','warning'],
      ['مسندة لي',summary.mine,'ضمن طابورك الحالي',''],
      ['حرجة P1',summary.urgent,'أعلى أولوية','danger'],
      ['متجاوزة للهدف',summary.overdue,'تحتاج تصعيدًا','danger']
    ];
  return <section className={styles.kpis} aria-label="ملخص الدعم">
    {cards.map(([label,value,hint,tone])=><article key={label} className={cx(styles.kpi,tone==='danger'&&styles.kpiToneDanger,tone==='warning'&&styles.kpiToneWarning,tone==='success'&&styles.kpiToneSuccess)}>
      <span className={styles.kpiLabel}>{label}</span><b className={styles.kpiValue}>{number(value)}</b><small className={styles.kpiHint}>{hint}</small>
    </article>)}
  </section>;
}

function PlatformFilters({filters,query,setQuery,applySearch,applyFilter,agents,tenants,busy}){
  return <form className={styles.filters} onSubmit={applySearch}>
    <div className={styles.filterRow}>
      <input className={styles.search} value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالرقم أو العنوان أو مقدّم التذكرة" aria-label="بحث التذاكر"/>
      <button type="submit" className={styles.iconButton} disabled={busy}>بحث</button>
    </div>
    <div className={styles.filterRow}>
      <label className={styles.field}><span>الحالة</span><select className={styles.select} value={filters.status||''} onChange={event=>applyFilter('status',event.target.value)} disabled={busy}>
        <option value="">كل الحالات</option>{STATUS_OPTIONS.map(([value,label])=><option value={value} key={value}>{label}</option>)}
        <option value="reviewing">قيد المراجعة (قديم)</option><option value="done">مكتملة (قديم)</option>
      </select></label>
      <label className={styles.field}><span>الأولوية</span><select className={styles.select} value={filters.priority||''} onChange={event=>applyFilter('priority',event.target.value)} disabled={busy}>
        <option value="">كل الأولويات</option>{Object.entries(PRIORITIES).map(([value,item])=><option value={value} key={value}>{item.code} · {item.label}</option>)}
      </select></label>
    </div>
    <div className={styles.filterRow}>
      <label className={styles.field}><span>المنشأة</span><select className={styles.select} value={filters.tenantId||''} onChange={event=>applyFilter('tenantId',event.target.value)} disabled={busy}>
        <option value="">كل المنشآت</option>{tenants.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>
      <label className={styles.field}><span>المكلّف</span><select className={styles.select} value={filters.assigneeId||''} onChange={event=>applyFilter('assigneeId',event.target.value)} disabled={busy}>
        <option value="">كل فريق الدعم</option>{agents.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>
    </div>
  </form>;
}

function TicketCard({ticket,selected,readLocally,mode,onOpen}){
  const priority=PRIORITIES[ticket.priority]||PRIORITIES.medium;
  const unreadCount=readLocally?0:ticket.unreadCount;
  return <button type="button" className={cx(styles.ticketCard,selected&&styles.ticketCardSelected)} onClick={onOpen} aria-current={selected?'true':undefined}>
    <div className={styles.ticketCardTop}>
      <span className={styles.ticketId}>{ticket.reference}</span>
      <span className={cx(styles.priority,priorityClass(ticket.priority))}>{priority.code} · {priority.label}</span>
    </div>
    <b className={styles.ticketTitle}>{ticket.title}</b>
    <div className={styles.ticketMeta}>
      {mode==='platform'&&<span>{ticket.tenantName}</span>}
      <span>{moduleLabel(ticket.moduleKey)}</span>
      <span className={styles.status}>{statusLabel(ticket.status)}</span>
    </div>
    <div className={styles.ticketFooter}>
      <span>{dateTime(ticket.updatedAt||ticket.createdAt)}</span>
      <span>{ticket.assigneeName||'غير مسندة'}</span>
      {unreadCount>0&&<b className={styles.badge}>{unreadCount>99?'99+':unreadCount}</b>}
    </div>
  </button>;
}

function TicketDetailHeader({ticket,mode}){
  const priority=PRIORITIES[ticket.priority]||PRIORITIES.medium;
  return <header className={styles.detailHeader}>
    <div className={styles.detailTitle}>
      <div><span className={styles.ticketId}>{ticket.reference}</span><span className={styles.status}>{statusLabel(ticket.status)}</span></div>
      <h3>{ticket.title}</h3>
      <p>{ticket.description||'لم يضف مقدّم التذكرة وصفًا تفصيليًا.'}</p>
    </div>
    <div className={styles.detailMeta}>
      <span className={cx(styles.priority,priorityClass(ticket.priority))}>{priority.code} · {priority.label}</span>
      {mode==='platform'&&<b>{ticket.tenantName}</b>}
      <small>آخر تحديث {dateTime(ticket.updatedAt||ticket.createdAt)}</small>
    </div>
    <div className={styles.detailGrid}>
      <DetailStat label="القسم المتأثر" value={moduleLabel(ticket.moduleKey)}/>
      <DetailStat label="مدى التأثير" value={IMPACTS[ticket.impact]||ticket.impact||'غير محدد'}/>
      <DetailStat label="المكلّف من ماركتون" value={ticket.assigneeName||'بانتظار الإسناد'}/>
      <DetailStat label="تاريخ الفتح" value={dateTime(ticket.createdAt)}/>
      {ticket.sourceUrl&&<DetailStat label="رابط الشاشة" value={shortUrl(ticket.sourceUrl)} wide/>}
    </div>
  </header>;
}

function DetailStat({label,value,wide=false}){
  return <div className={cx(styles.detailStat,wide&&styles.wide)}><span>{label}</span><b title={value}>{value||'—'}</b></div>;
}

function SlaPanel({ticket}){
  if(!ticket.sla?.dueAt&&!ticket.sla?.label)return null;
  const tone=ticket.sla.breached?'danger':ticket.sla.percent>=75?'warning':'';
  return <section className={styles.slaBar} aria-label="مؤشر زمن الاستجابة">
    <div><span>{ticket.sla.label||'هدف المعالجة'}</span><b>{ticket.sla.breached?'متجاوز':ticket.sla.remainingLabel||dateTime(ticket.sla.dueAt)}</b></div>
    <div className={styles.slaTrack}><i className={cx(styles.slaFill,tone==='danger'&&styles.slaDanger,tone==='warning'&&styles.slaWarning)} style={{width:`${Math.max(3,Math.min(100,ticket.sla.percent||0))}%`}}/></div>
    <small>{ticket.sla.dueAt?`الموعد المستهدف: ${dateTime(ticket.sla.dueAt)}`:'يُحتسب وفق باقة وساعات دعم المنشأة.'}</small>
  </section>;
}

function ResolutionSummary({ticket,mode}){
  if(!ticket.resolutionSummary
     ||(mode==='tenant'&&!['resolved','closed','done'].includes(ticket.status)))return null;
  return <section className={styles.resolutionSummary} aria-label="ملخص الحل من فريق ماركتون">
    <div><small>الحل المقترح أو المنفّذ</small><h3>ملخص الحل من فريق ماركتون</h3></div>
    <p>{ticket.resolutionSummary}</p>
  </section>;
}

function Requester({ticket}){
  return <section className={styles.requester}>
    <span className={styles.requesterAvatar}>{initial(ticket.requesterName)}</span>
    <div><small>مقدّم التذكرة</small><b>{ticket.requesterName||'مستخدم المنشأة'}</b><p>{[ticket.requesterJobTitle,ticket.requesterDepartment,ticket.requesterRoleName].filter(Boolean).join(' · ')||ticket.requesterEmail||'بيانات الوظيفة غير متاحة'}</p></div>
  </section>;
}

function DiagnosticsPanel({ticket,mode}){
  const diagnostics=ticket.diagnostics||{};
  const narratives=[
    ['خطوات إعادة المشكلة',diagnostics.reproductionSteps],
    ['النتيجة المتوقعة',diagnostics.expectedResult],
    ['النتيجة الفعلية',diagnostics.actualResult]
  ].filter(([,value])=>value);
  const context=[
    ['رابط الشاشة',diagnostics.sourceUrl],
    ['إصدار أودير',diagnostics.browserContext?.appVersion],
    ['المسار داخل النظام',diagnostics.browserContext?.route],
    ['المتصفح',diagnostics.browserContext?.browser],
    ['نظام التشغيل',diagnostics.browserContext?.operatingSystem],
    ['اللغة',diagnostics.browserContext?.locale],
    ['المنطقة الزمنية',diagnostics.browserContext?.timezone]
  ].filter(([,value])=>value);
  if(!narratives.length&&!context.length)return null;
  return <section className={styles.diagnostics} aria-label="بيانات التشخيص">
    <header className={styles.diagnosticsHeader}>
      <div><small>معلومات آمنة مرفقة بالبلاغ</small><h3>بيانات التشخيص</h3></div>
      <p>{mode==='platform'?'استخدمها فريق ماركتون لتحديد سبب المشكلة وتسريع الحل.':'تساعد هذه البيانات فريق ماركتون على إعادة المشكلة والتحقق من الحل.'}</p>
    </header>
    {!!narratives.length&&<div className={styles.diagnosticNarratives}>
      {narratives.map(([label,value])=><article className={styles.diagnosticNarrative} key={label}>
        <span>{label}</span><p>{value}</p>
      </article>)}
    </div>}
    {!!context.length&&<dl className={styles.diagnosticGrid}>
      {context.map(([label,value])=><div className={styles.diagnosticItem} key={label}>
        <dt>{label}</dt><dd dir="auto" title={value}>{value}</dd>
      </div>)}
    </dl>}
  </section>;
}

function PlatformManager({ticket,agents,canManage,draft,setDraft,save,busy}){
  const statusOptions=TERMINAL_STATUSES.has(ticket.status)
    ?STATUS_OPTIONS.filter(([value])=>value===ticket.status
      ||(value==='reopened'&&ticket.status!=='rejected'))
    :STATUS_OPTIONS.filter(([value])=>!['closed','reopened'].includes(value));
  return <section className={styles.filters} aria-label="إدارة التذكرة">
    <div className={styles.filterRow}>
      <label className={styles.field}><span>الحالة</span><select className={styles.select} value={draft.status} onChange={event=>setDraft(current=>({...current,status:event.target.value}))}>
        {statusOptions.map(([value,label])=><option value={value} key={value}>{label}</option>)}
        {!statusOptions.some(([value])=>value===draft.status)&&<option value={draft.status}>{statusLabel(draft.status)}</option>}
      </select></label>
      {canManage&&<label className={styles.field}><span>الأولوية المؤكدة</span><select className={styles.select} value={draft.priority} onChange={event=>setDraft(current=>({...current,priority:event.target.value}))}>
        {Object.entries(PRIORITIES).map(([value,item])=><option value={value} key={value}>{item.code} · {item.label}</option>)}
      </select></label>}
      {canManage&&<label className={styles.field}><span>المكلّف بالمعالجة</span><select className={styles.select} value={draft.assigneeId} onChange={event=>setDraft(current=>({...current,assigneeId:event.target.value}))}>
        <option value="">غير مسندة</option>{agents.map(agent=><option value={agent.id} key={agent.id}>{agent.name}</option>)}
      </select></label>}
    </div>
    {canManage&&<div className={styles.filterRow}>
      <label className={styles.field}><span>القسم</span><select className={styles.select} value={draft.moduleKey} onChange={event=>setDraft(current=>({...current,moduleKey:event.target.value}))}>
        {MODULES.map(([value,label])=><option value={value} key={value}>{label}</option>)}
        {!MODULES.some(([value])=>value===draft.moduleKey)&&<option value={draft.moduleKey}>{draft.moduleKey}</option>}
      </select></label>
      <label className={styles.field}><span>مدى التأثير</span><select className={styles.select} value={draft.impact} onChange={event=>setDraft(current=>({...current,impact:event.target.value}))}>
        {Object.entries(IMPACTS).map(([value,label])=><option value={value} key={value}>{label}</option>)}
      </select></label>
    </div>}
    <label className={cx(styles.field,styles.wide)}><span>ملخص الحل{draft.status==='resolved'?' (مطلوب)':''}</span><textarea className={styles.textarea} rows="2" maxLength="4000" required={draft.status==='resolved'} value={draft.resolutionSummary} onChange={event=>setDraft(current=>({...current,resolutionSummary:event.target.value}))} placeholder="اكتب ملخصًا واضحًا يظهر للمنشأة عند حل التذكرة."/></label>
    <div className={styles.detailActions}><button type="button" className={styles.primaryButton} onClick={save} disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ التحديث والإسناد'}</button></div>
  </section>;
}

function Conversation({ticket,mode}){
  const timeline=ticket.timeline.filter(item=>mode==='platform'||!item.internal);
  return <section className={styles.conversation} aria-label="محادثة التذكرة">
    <header><div><small>سجل التذكرة</small><h3>المحادثة والتحديثات</h3></div><span>{timeline.length} تحديث</span></header>
    <div>
      {timeline.map(item=><article className={cx(styles.event,item.internal&&styles.eventInternal,item.system&&styles.eventSystem)} key={item.id}>
        <span className={styles.eventAvatar}>{item.system?'•':initial(item.authorName)}</span>
        <div className={styles.eventBody}>
          <div className={styles.eventHead}><div><b>{item.authorName}</b><small>{item.authorRole||item.authorTypeLabel}</small></div><time>{dateTime(item.createdAt)}</time></div>
          {item.internal&&<em>ملاحظة داخلية · لا تظهر للمنشأة</em>}
          <p className={styles.eventText}>{item.content}</p>
          {!!item.attachments.length&&<div className={styles.attachmentList}>{item.attachments.map(attachment=><Attachment key={attachment.id} item={attachment}/>)}</div>}
        </div>
      </article>)}
      {!timeline.length&&<div className={styles.empty}><b>لا توجد رسائل بعد</b><p>سيظهر رد فريق ماركتون وسجل تحديث الحالة هنا.</p></div>}
    </div>
  </section>;
}

function Attachment({item}){
  if(!SUPPORT_ATTACHMENTS_ENABLED){
    return <span className={cx(styles.attachment,styles.attachmentDisabled)} aria-disabled="true" title={SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE}>
      <span>—</span><div><b>{item.fileName}</b><small>التنزيل غير متاح مؤقتًا</small></div>
    </span>;
  }
  return <a className={styles.attachment} href={`/api/support/attachments/${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer">
    <span>↧</span><div><b>{item.fileName}</b><small>{[item.mimeType,fileSize(item.sizeBytes)].filter(Boolean).join(' · ')}</small></div>
  </a>;
}

function Composer({mode,canInternalNote,composerMode,setComposerMode,message,setMessage,files,setFiles,submit,busy}){
  return <form className={styles.composer} onSubmit={submit}>
    {mode==='platform'&&canInternalNote&&<div className={styles.composerTabs}>
      <button type="button" className={cx(styles.composerTab,composerMode==='public'&&styles.active)} onClick={()=>setComposerMode('public')}>رد للمنشأة</button>
      <button type="button" className={cx(styles.composerTab,composerMode==='internal'&&styles.active)} onClick={()=>setComposerMode('internal')}>ملاحظة داخلية</button>
    </div>}
    {composerMode==='internal'&&<div className={styles.alert}>هذه الملاحظة خاصة بفريق ماركتون ولن تظهر لمستخدمي المنشأة.</div>}
    <textarea className={styles.textarea} rows="4" value={message} onChange={event=>setMessage(event.target.value)} placeholder={composerMode==='internal'?'اكتب ملاحظة للفريق أو تفاصيل التشخيص…':'اكتب ردك أو المعلومات المطلوبة…'} maxLength="12000"/>
    {SUPPORT_ATTACHMENTS_ENABLED&&!!files.length&&<div className={styles.attachmentList}>{files.map(file=><span className={styles.attachment} key={`${file.name}-${file.size}`}><span>＋</span><div><b>{file.name}</b><small>{fileSize(file.size)}</small></div></span>)}</div>}
    <div className={styles.composerActions}>
      {SUPPORT_ATTACHMENTS_ENABLED
        ?<label className={styles.secondaryButton}>إضافة مرفق<input className={styles.hiddenInput} type="file" multiple accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain" onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label>
        :<small className={styles.attachmentUnavailable} role="note">{SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE}</small>}
      <button type="submit" className={styles.primaryButton} disabled={busy}>{busy?'جارٍ الإرسال…':composerMode==='internal'?'حفظ الملاحظة':'إرسال الرد'}</button>
    </div>
  </form>;
}

function CreateTicketModal({busy,error,files,setFiles,close,submit}){
  const dialogRef=useRef(null);
  const closeRef=useRef(close);

  useEffect(()=>{
    closeRef.current=close;
  },[close]);

  useEffect(()=>{
    const previousFocus=document.activeElement;
    const dialog=dialogRef.current;
    const focusableSelector='button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusables=()=>Array.from(dialog?.querySelectorAll(focusableSelector)||[])
      .filter(element=>element.getAttribute('aria-hidden')!=='true');
    const firstField=dialog?.querySelector('[name="title"]')||focusables()[0];
    firstField?.focus();

    function handleKeyDown(event){
      if(event.key==='Escape'){
        event.preventDefault();
        closeRef.current();
        return;
      }
      if(event.key!=='Tab')return;
      const items=focusables();
      if(!items.length){
        event.preventDefault();
        return;
      }
      const first=items[0];
      const last=items[items.length-1];
      if(!dialog?.contains(document.activeElement)){
        event.preventDefault();
        (event.shiftKey?last:first).focus();
      }else if(event.shiftKey&&document.activeElement===first){
        event.preventDefault();
        last.focus();
      }else if(!event.shiftKey&&document.activeElement===last){
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown',handleKeyDown);
    return ()=>{
      document.removeEventListener('keydown',handleKeyDown);
      if(previousFocus instanceof HTMLElement&&previousFocus.isConnected){
        previousFocus.focus();
      }
    };
  },[]);

  return <div className={styles.modalLayer}>
    <button type="button" className={styles.backdrop} onClick={close} tabIndex="-1" aria-label="إغلاق نافذة فتح التذكرة"/>
    <form ref={dialogRef} className={styles.modal} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="support-create-title">
      <header className={styles.modalHeader}><div><small>طلب دعم موثّق</small><h3 id="support-create-title">فتح تذكرة جديدة</h3><p>كلما كانت التفاصيل أوضح، وصل فريق ماركتون للحل أسرع.</p></div><button type="button" onClick={close} disabled={busy} aria-label="إغلاق نافذة فتح التذكرة">×</button></header>
      <div className={styles.modalBody}>
        {error&&<div className={cx(styles.alert,styles.alertError)} role="alert">{error}</div>}
        <div className={styles.formGrid}>
          <label className={styles.field}><span>القسم المتأثر</span><select name="moduleKey" className={styles.select} defaultValue="dashboard" required>{MODULES.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
          <label className={styles.field}><span>مدى التأثير</span><select name="impact" className={styles.select} defaultValue="single_user" required>{Object.entries(IMPACTS).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
          <label className={styles.field}><span>الأولوية المطلوبة</span><select name="priority" className={styles.select} defaultValue="medium" required>{Object.entries(PRIORITIES).map(([value,item])=><option value={value} key={value}>{item.code} · {item.label} — {item.hint}</option>)}</select></label>
          <label className={cx(styles.field,styles.wide)}><span>عنوان واضح للمشكلة</span><input name="title" required minLength="5" maxLength="180" placeholder="مثال: لا يمكن حفظ موعد المتابعة من شاشة المبيعات"/></label>
          <label className={cx(styles.field,styles.wide)}><span>وصف المشكلة وأثرها على العمل</span><textarea name="description" className={styles.textarea} rows="4" required minLength="10" maxLength="8000" placeholder="ماذا حدث؟ ومن المتأثر؟ وهل يوجد حل بديل مؤقت؟"/></label>
          <label className={cx(styles.field,styles.wide)}><span>خطوات تكرار المشكلة</span><textarea name="reproductionSteps" className={styles.textarea} rows="3" maxLength="6000" placeholder="1. افتح…  2. اختر…  3. اضغط…"/></label>
          <label className={styles.field}><span>النتيجة المتوقعة</span><textarea name="expectedResult" className={styles.textarea} rows="3" maxLength="4000" placeholder="ما الذي كان يفترض أن يحدث؟"/></label>
          <label className={styles.field}><span>النتيجة الفعلية</span><textarea name="actualResult" className={styles.textarea} rows="3" maxLength="4000" placeholder="ما الذي ظهر بدلًا من ذلك؟"/></label>
          {SUPPORT_ATTACHMENTS_ENABLED
            ?<label className={cx(styles.field,styles.wide)}><span>صور أو ملفات مساعدة</span><input type="file" multiple accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.txt,image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain" onChange={event=>setFiles(Array.from(event.target.files||[]))}/><small>سيُسجل رابط الشاشة وبيانات المتصفح تلقائيًا دون كلمات مرور أو أسرار.</small></label>
            :<p className={cx(styles.attachmentUnavailable,styles.wide)} role="note">{SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE}</p>}
          {SUPPORT_ATTACHMENTS_ENABLED&&!!files.length&&<div className={cx(styles.attachmentList,styles.wide)}>{files.map(file=><span className={styles.attachment} key={`${file.name}-${file.size}`}><span>＋</span><div><b>{file.name}</b><small>{fileSize(file.size)}</small></div></span>)}</div>}
        </div>
      </div>
      <footer className={styles.modalFooter}><button type="button" className={styles.secondaryButton} onClick={close} disabled={busy}>إلغاء</button><button type="submit" className={styles.primaryButton} disabled={busy}>{busy?'جارٍ فتح التذكرة…':'إرسال التذكرة لماركتون'}</button></footer>
    </form>
  </div>;
}

function normalizeSnapshot(data,mode){
  const source=data&&typeof data==='object'?data:{};
  const generatedAt=dateIso(pick(source,['generatedAt','generated_at']))||'1970-01-01T00:00:00.000Z';
  const rawTickets=firstArray(source,['tickets','items','rows','results']);
  const filterSource=object(source.filters);
  const requestedTicketId=text(pick(filterSource,['ticketId','ticket_id'],''));
  const detailRaw=object(source.selectedTicket)||object(source.ticket)||object(source.detail)
    ||rawTickets.find(item=>text(pick(item,['id','ticketId','ticket_id']))===requestedTicketId)
    ||null;
  const tickets=rawTickets.map(item=>normalizeTicket(item,mode,generatedAt));
  let selected=detailRaw?normalizeTicket(detailRaw,mode,generatedAt):null;
  if(selected){
    const listItem=tickets.find(item=>item.id===selected.id);
    if(listItem)selected={...listItem,...selected};
  }
  const viewerSource=object(source.viewer);
  const permissions=firstArray(viewerSource,['permissions','permissionKeys','permission_keys']).map(String);
  const platformPreview=boolean(pick(viewerSource,['platformPreview','platform_preview']),false);
  const viewer={
    platformPreview,
    canViewAll:boolean(pick(viewerSource,['canViewAll','can_view_all','canReadAll','can_read_all','viewAll','view_all']),false),
    canCreate:boolean(pick(viewerSource,['canCreate','can_create']),mode==='tenant'&&!platformPreview),
    canReply:boolean(pick(viewerSource,['canReply','can_reply','canWrite','can_write','canManage','can_manage']),mode==='tenant'&&!platformPreview),
    canManage:boolean(pick(viewerSource,['canManage','can_manage','canUpdate','can_update']),permissions.includes('platform.support.manage')),
    canInternalNote:boolean(pick(viewerSource,['canInternalNote','can_internal_note','canManage','can_manage']),permissions.includes('platform.support.manage'))
  };
  const summarySource=object(source.summary);
  const computed={
    total:tickets.length,
    open:tickets.filter(item=>!['resolved','closed','done','rejected'].includes(item.status)).length,
    waitingTenant:tickets.filter(item=>item.status==='waiting_tenant').length,
    resolved:tickets.filter(item=>['resolved','closed','done'].includes(item.status)).length,
    unassigned:tickets.filter(item=>!item.assigneeId&&!['resolved','closed','done','rejected'].includes(item.status)).length,
    mine:tickets.filter(item=>item.isAssignedToViewer).length,
    urgent:tickets.filter(item=>item.priority==='urgent').length,
    overdue:tickets.filter(item=>item.sla?.breached).length,
    new:tickets.filter(item=>item.status==='new').length,
    dueSoon:tickets.filter(item=>!item.sla?.breached&&item.sla?.percent>=75).length
  };
  const summary={};
  for(const [key,fallback] of Object.entries(computed))summary[key]=nonNegative(pick(summarySource,summaryKeys(key),fallback),fallback);
  const pageSource=object(source.pagination)||object(source.page);
  const limit=Math.max(1,nonNegative(pick(pageSource,['limit','size','pageSize','page_size'],pick(filterSource,['limit'],mode==='platform'?50:25)),mode==='platform'?50:25));
  const total=nonNegative(pick(pageSource,['total','totalCount','total_count'],pick(source,['total'],summary.total)),summary.total);
  const nextCursorSource=object(pick(pageSource,['nextCursor','next_cursor'],{}));
  const pagination={
    limit,total,
    hasMore:boolean(pick(pageSource,['hasMore','has_more']),false),
    nextCursor:nextCursorSource?{
      updatedAt:dateIso(pick(nextCursorSource,['updatedAt','updated_at'])),
      id:text(pick(nextCursorSource,['id','ticketId','ticket_id']))
    }:null
  };
  const optionTickets=selected?[...tickets,selected]:tickets;
  const agents=mergeOptions(
    normalizeOptions(firstArray(source,['agents','supportAgents','support_agents','assignees'])),
    optionTickets.filter(item=>item.assigneeId).map(item=>({id:item.assigneeId,name:item.assigneeName||'موظف دعم ماركتون'}))
  );
  const tenants=mergeOptions(
    normalizeOptions(firstArray(source,['tenants','tenantOptions','tenant_options'])),
    optionTickets.filter(item=>item.tenantId).map(item=>({id:item.tenantId,name:item.tenantName||'المنشأة'}))
  );
  return {
    viewer,summary,tickets,selected,
    filters:{
      scope:pick(filterSource,['scope'],'mine')==='all'?'all':'mine',
      queue:text(pick(filterSource,['queue'],'all'))||'all',
      query:text(pick(filterSource,['query','search'],'')),
      tenantId:text(pick(filterSource,['tenantId','tenant_id'],'')),
      status:text(pick(filterSource,['status'],'')),
      priority:text(pick(filterSource,['priority'],'')),
      assigneeId:text(pick(filterSource,['assigneeId','assignee_id','assigneeSubjectId','assignee_subject_id'],'')),
      cursorUpdatedAt:dateIso(pick(filterSource,['cursorUpdatedAt','cursor_updated_at'])),
      cursorId:text(pick(filterSource,['cursorId','cursor_id'],''))
    },
    pagination,
    agents,
    tenants,
    queues:normalizeQueues(source.queues,summary)
  };
}

function normalizeTicket(raw,mode,generatedAt){
  const item=object(raw)||{};
  const status=normalizeStatus(pick(item,['status','ticketStatus','ticket_status'],'new'));
  const priority=normalizePriority(pick(item,['priority','severity'],'medium'));
  const messages=firstArray(item,['messages','conversation','replies']).map(normalizeMessage)
    .filter(message=>mode==='platform'||!message.internal);
  const events=firstArray(item,['events','timeline','audit'])
    .map(normalizeEvent)
    .filter(event=>!['message.created','note.created'].includes(event.action));
  const timeline=[...messages,...events].sort((left,right)=>dateValue(left.createdAt)-dateValue(right.createdAt));
  const diagnostics=normalizeDiagnostics(item);
  const requester=object(pick(item,['requester','presenter','requestedBy','requested_by'],{}));
  const assignee=object(pick(item,['assignee','assignedTo','assigned_to'],{}));
  const requesterDepartment=object(pick(requester,['department'],{}));
  const requesterRole=object(pick(requester,['role'],{}));
  const tenant=object(pick(item,['tenant','organization'],{}));
  return {
    id:text(pick(item,['id','ticketId','ticket_id'])),
    reference:text(pick(item,['reference','referenceCode','reference_code','ticketNumber','ticket_number','code']))||shortId(pick(item,['id','ticketId','ticket_id'])),
    title:text(pick(item,['title','subject'],'تذكرة دون عنوان')),
    description:text(pick(item,['description','body','details'])),
    status,
    priority,
    impact:normalizeImpact(pick(item,['impact','impactLevel','impact_level'],'partial')),
    moduleKey:normalizeModuleKey(pick(item,['moduleKey','module_key','module','category'],'other')),
    tenantId:text(pick(item,['tenantId','tenant_id'],pick(tenant,['id','tenantId','tenant_id']))),
    tenantName:text(pick(item,['tenantName','tenant_name','organizationName','organization_name'],pick(tenant,['name','tenantName','tenant_name'],'المنشأة'))),
    requesterName:text(pick(item,['requesterName','requester_name','requestedByName','requested_by_name','presenterName','presenter_name'],pick(requester,['name','fullName','full_name'],'مستخدم المنشأة'))),
    requesterEmail:text(pick(item,['requesterEmail','requester_email','requestedByEmail','requested_by_email'],pick(requester,['email']))),
    requesterJobTitle:text(pick(item,['requesterJobTitle','requester_job_title','jobTitle','job_title'],pick(requester,['jobTitle','job_title']))),
    requesterDepartment:text(pick(item,['requesterDepartment','requester_department','departmentName','department_name'],pick(requester,['departmentName','department_name'],pick(requesterDepartment,['name','nameAr','name_ar'])))),
    requesterRoleName:text(pick(item,['requesterRoleName','requester_role_name','roleName','role_name'],pick(requester,['roleName','role_name','roleLabel','role_label','roleKey','role_key'],pick(requesterRole,['name','nameAr','name_ar','label','key'])))),
    assigneeId:text(pick(item,['assigneeSubjectId','assignee_subject_id','assigneeId','assignee_id','assignedToId','assigned_to_id'],pick(assignee,['subjectId','subject_id','id']))),
    assigneeName:text(pick(item,['assigneeName','assignee_name','assignedToName','assigned_to_name'],pick(assignee,['name','fullName','full_name']))),
    createdAt:dateIso(pick(item,['createdAt','created_at','openedAt','opened_at'])),
    updatedAt:dateIso(pick(item,['updatedAt','updated_at','lastActivityAt','last_activity_at'])),
    lastMessageAt:dateIso(pick(item,['lastMessageAt','last_message_at'])),
    readWatermark:dateIso(pick(item,['readWatermark','read_watermark'])),
    sourceUrl:diagnostics.sourceUrl,
    resolutionSummary:text(pick(item,['resolutionSummary','resolution_summary','decisionNote','decision_note'])),
    unreadCount:nonNegative(pick(item,['unreadCount','unread_count'],0),0),
    isAssignedToViewer:boolean(pick(item,['isAssignedToViewer','is_assigned_to_viewer']),false),
    canReply:boolean(pick(item,['canReply','can_reply']),false),
    canClose:boolean(pick(item,['canClose','can_close']),false),
    canReopen:boolean(pick(item,['canReopen','can_reopen']),false),
    version:Math.max(1,nonNegative(pick(item,['version','rowVersion','row_version'],1),1)),
    timeline,
    diagnostics,
    sla:normalizeSla(item,generatedAt)
  };
}

function normalizeDiagnostics(raw){
  const item=object(raw)||{};
  const source=object(pick(item,['diagnostics'],{}))||{};
  const browserSource=object(pick(
    source,
    ['browserContext','browser_context'],
    pick(item,['browserContext','browser_context'],{})
  ))||{};
  const sourceUrl=safeDiagnosticUrl(pick(
    source,
    ['sourceUrl','source_url'],
    pick(item,['sourceUrl','source_url'])
  ));
  return {
    reproductionSteps:diagnosticText(pick(source,['reproductionSteps','reproduction_steps'],pick(item,['reproductionSteps','reproduction_steps'])),8000),
    expectedResult:diagnosticText(pick(source,['expectedResult','expected_result'],pick(item,['expectedResult','expected_result'])),5000),
    actualResult:diagnosticText(pick(source,['actualResult','actual_result'],pick(item,['actualResult','actual_result'])),5000),
    sourceUrl,
    browserContext:{
      appVersion:diagnosticText(pick(browserSource,['appVersion','app_version']),120),
      route:safeDiagnosticRoute(pick(browserSource,['route','path','pathname']),sourceUrl),
      browser:diagnosticText(pick(browserSource,['browser','userAgent','user_agent']),120),
      operatingSystem:diagnosticText(pick(browserSource,['operatingSystem','operating_system','os','platform']),120),
      locale:diagnosticText(pick(browserSource,['locale','language']),40),
      timezone:diagnosticText(pick(browserSource,['timezone','timeZone','time_zone']),80)
    }
  };
}

function normalizeMessage(raw){
  const item=object(raw)||{};
  const author=object(pick(item,['author','sender'],{}));
  const authorType=text(pick(item,['authorScope','author_scope','authorType','author_type','senderType','sender_type']));
  const authorRole=[
    text(pick(author,['jobTitle','job_title'])),
    text(pick(author,['roleName','role_name','roleLabel','role_label','roleKey','role_key']))
  ].filter(Boolean).join(' · ');
  const internal=boolean(pick(item,['isInternal','is_internal']),false)
    ||text(pick(item,['visibility','messageType','message_type'])).toLowerCase()==='internal';
  return {
    id:text(pick(item,['id','messageId','message_id']))||clientRequestId(),
    content:text(pick(item,['content','body','message','text'],'رسالة دون محتوى')),
    authorName:text(pick(item,['authorName','author_name','senderName','sender_name'],pick(author,['name','fullName','full_name'],'مستخدم أودير'))),
    authorRole:text(pick(item,['authorRole','author_role','roleLabel','role_label'],authorRole)),
    authorTypeLabel:authorType==='platform'?'فريق ماركتون':authorType==='tenant'?'المنشأة':'',
    createdAt:dateIso(pick(item,['createdAt','created_at','sentAt','sent_at'])),
    internal,
    system:false,
    attachments:firstArray(item,['attachments','files']).map(normalizeAttachment).filter(value=>value.id)
  };
}

function normalizeEvent(raw){
  const item=object(raw)||{};
  const action=text(pick(item,['action','eventType','event_type','type']));
  return {
    id:text(pick(item,['id','eventId','event_id']))||clientRequestId(),
    action,
    content:text(pick(item,['description','content','label','message']))||eventLabel(action,item),
    authorName:text(pick(item,['actorName','actor_name','authorName','author_name'],'النظام')),
    authorRole:text(pick(item,['actorRole','actor_role'])),
    authorTypeLabel:'تحديث نظامي',
    createdAt:dateIso(pick(item,['createdAt','created_at','occurredAt','occurred_at'])),
    internal:boolean(pick(item,['isInternal','is_internal']),false),
    system:true,
    attachments:[]
  };
}

function normalizeAttachment(raw){
  const item=object(raw)||{};
  return {
    id:text(pick(item,['id','attachmentId','attachment_id'])),
    fileName:text(pick(item,['fileName','file_name','name'],'مرفق')),
    mimeType:text(pick(item,['mimeType','mime_type','contentType','content_type'])),
    sizeBytes:nonNegative(pick(item,['sizeBytes','size_bytes','size'],0),0)
  };
}

function normalizeSla(item,generatedAt){
  const sla=object(pick(item,['sla','slaState','sla_state'],{}));
  const responseDueAt=dateIso(pick(sla,['responseDueAt','response_due_at','firstResponseDueAt','first_response_due_at'],pick(item,['responseDueAt','response_due_at','firstResponseDueAt','first_response_due_at'])));
  const resolutionDueAt=dateIso(pick(sla,['resolutionDueAt','resolution_due_at'],pick(item,['resolutionDueAt','resolution_due_at'])));
  const firstResponseAt=dateIso(pick(sla,['firstResponseAt','first_response_at','respondedAt','responded_at'],pick(item,['firstResponseAt','first_response_at'])));
  const responseBreached=boolean(pick(sla,['responseBreached','response_breached','firstResponseBreached','first_response_breached'],pick(item,['responseBreached','response_breached'])),false);
  const resolutionBreached=boolean(pick(sla,['resolutionBreached','resolution_breached'],pick(item,['resolutionBreached','resolution_breached'])),false);
  const useResponse=Boolean(responseDueAt&&!firstResponseAt);
  const dueAt=dateIso(pick(sla,['dueAt','due_at','nextDueAt','next_due_at'],useResponse?responseDueAt:resolutionDueAt))
    ||(useResponse?responseDueAt:resolutionDueAt||responseDueAt);
  const breached=useResponse?responseBreached:resolutionBreached||responseBreached;
  const percentSource=pick(sla,useResponse
    ?['responsePercent','response_percent','percent','percentUsed','percent_used','consumedPercent','consumed_percent']
    :['resolutionPercent','resolution_percent','percent','percentUsed','percent_used','consumedPercent','consumed_percent'],null);
  const remainingSource=pick(sla,useResponse
    ?['responseRemainingMinutes','response_remaining_minutes','remainingMinutes','remaining_minutes']
    :['resolutionRemainingMinutes','resolution_remaining_minutes','remainingMinutes','remaining_minutes'],null);
  const startAt=dateIso(useResponse
    ?pick(item,['createdAt','created_at','openedAt','opened_at'])
    :pick(sla,['reopenedAt','reopened_at'],pick(item,['createdAt','created_at','openedAt','opened_at'])));
  const dueMs=dateValue(dueAt);
  const startMs=dateValue(startAt);
  const nowMs=dateValue(generatedAt);
  const derivedPercent=dueMs>startMs
    ?((nowMs-startMs)/(dueMs-startMs))*100
    :0;
  const percent=Math.max(0,Math.min(100,
    percentSource===null?(breached?100:derivedPercent):Number(percentSource)||0
  ));
  const remainingMinutes=remainingSource===null&&dueMs
    ?(dueMs-nowMs)/60000
    :Number(remainingSource);
  return {
    dueAt,breached,percent,
    responseDueAt,resolutionDueAt,responseBreached,resolutionBreached,
    label:text(pick(sla,['label','targetLabel','target_label'],dueAt?(useResponse?'هدف الرد الأولي':'هدف الحل'):'')),
    remainingLabel:Number.isFinite(remainingMinutes)?durationLabel(remainingMinutes):''
  };
}

async function callSupportAction({mode,slug,action,payload}){
  const endpoint=mode==='tenant'
    ?`/api/support/tenant/${encodeURIComponent(action)}`
    :`/api/support/platform/${encodeURIComponent(action)}`;
  const response=await fetch(endpoint,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(mode==='tenant'?{slug,payload}:{payload})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||result.message||'تعذر تنفيذ العملية.');
  return result.data??result;
}

class AttachmentUploadError extends Error{
  constructor(message,{code='',retryable=false}={}){
    super(message);
    this.code=code;
    this.retryable=retryable;
  }
}

async function uploadSupportAttachment(file,payload){
  let lastError=null;
  for(let attempt=0;attempt<2;attempt+=1){
    try{
      const registered=await supportAttachmentJson('/api/support/attachments',{
        ticketId:payload.ticketId,
        messageId:payload.messageId,
        fileName:file.name,
        mimeType:file.type,
        sizeBytes:file.size,
        clientRequestId:payload.clientRequestId
      });
      if(!registered.attachmentId){
        throw new AttachmentUploadError('تعذر تأكيد تسجيل المرفق.');
      }
      if(registered.state==='ready')return registered.attachmentId;
      if(registered.state==='uploaded'){
        await finalizeSupportAttachment(registered.attachmentId,file.size);
        return registered.attachmentId;
      }
      if(registered.state!=='pending'||!registered.uploadRequired||!registered.uploadUrl){
        throw new AttachmentUploadError('تعذر تجهيز المرفق للرفع.');
      }

      let uploadError=null;
      try{
        const uploaded=await fetch(registered.uploadUrl,{
          method:'PUT',
          headers:{'Content-Type':file.type,'x-upsert':'false'},
          body:file
        });
        if(!uploaded.ok){
          uploadError=new AttachmentUploadError('تعذر رفع المرفق إلى التخزين.',{
            retryable:uploaded.status===409||uploaded.status>=500
          });
        }
      }catch{
        uploadError=new AttachmentUploadError('انقطع الاتصال أثناء رفع المرفق.',{
          retryable:true
        });
      }
      if(uploadError){
        const recovered=await finalizeSupportAttachment(
          registered.attachmentId,file.size,{allowMissing:true}
        );
        if(recovered)return registered.attachmentId;
        throw uploadError;
      }
      await finalizeSupportAttachment(registered.attachmentId,file.size);
      return registered.attachmentId;
    }catch(error){
      lastError=error;
      if(attempt===0&&error instanceof AttachmentUploadError&&error.retryable){
        continue;
      }
      throw error;
    }
  }
  throw lastError||new AttachmentUploadError('تعذر رفع المرفق.');
}

async function finalizeSupportAttachment(attachmentId,sizeBytes,{allowMissing=false}={}){
  try{
    const result=await supportAttachmentJson('/api/support/attachments/finalize',{
      attachmentId,sizeBytes
    });
    const attachment=result.attachment&&typeof result.attachment==='object'
      ?result.attachment
      :result;
    if(attachment.state!=='ready'){
      throw new AttachmentUploadError('تعذر تأكيد اكتمال المرفق.',{retryable:true});
    }
    return true;
  }catch(error){
    if(allowMissing&&error instanceof AttachmentUploadError
       &&error.code==='support_attachment_not_uploaded')return false;
    throw error;
  }
}

async function supportAttachmentJson(endpoint,body){
  let response;
  try{
    response=await fetch(endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
  }catch{
    throw new AttachmentUploadError('تعذر الاتصال بخدمة المرفقات.',{retryable:true});
  }
  const result=await response.json().catch(()=>({}));
  if(response.ok)return result;
  const code=typeof result.code==='string'?result.code:'';
  throw new AttachmentUploadError(
    result.error||'تعذر تنفيذ عملية المرفق.',
    {
      code,
      retryable:response.status>=500
        ||code==='support_upstream_timeout'
        ||code==='support_upstream_unavailable'
        ||code==='support_attachment_not_uploaded'
    }
  );
}

function mutationPayload(ticket,extra){
  return {
    ticketId:ticket.id,
    expectedVersion:extra.expectedVersion??ticket.version,
    ...extra,
    clientRequestId:clientRequestId()
  };
}

function managerValues(ticket){
  return {
    status:ticket?.status||'new',
    priority:ticket?.priority||'medium',
    assigneeId:ticket?.assigneeId||'',
    moduleKey:ticket?.moduleKey||'other',
    impact:ticket?.impact||'single_user',
    resolutionSummary:ticket?.resolutionSummary||''
  };
}

function browserDiagnostics(){
  const sourceUrl=document.referrer&&sameOrigin(document.referrer)
    ?document.referrer
    :window.location.href;
  return {
    sourceUrl,
    browserContext:{
      userAgent:navigator.userAgent,
      language:navigator.language,
      platform:navigator.userAgentData?.platform||navigator.platform||null,
      viewport:`${window.innerWidth}x${window.innerHeight}`,
      screen:`${window.screen?.width||0}x${window.screen?.height||0}@${window.devicePixelRatio||1}`,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||null,
      online:navigator.onLine
    }
  };
}

function sameOrigin(value){
  try{return new URL(value).origin===window.location.origin;}catch{return false;}
}

function eventLabel(action,item){
  const fromStatus=text(pick(item,['fromStatus','from_status']));
  const toStatus=text(pick(item,['toStatus','to_status','status']));
  const status=toStatus?statusLabel(toStatus):'الحالة الجديدة';
  const ticketUpdated=toStatus&&toStatus!==fromStatus
    ?`تم تحديث حالة التذكرة إلى «${status}».`
    :'تم تحديث بيانات التذكرة.';
  return ({
    created:'تم فتح التذكرة وإرسالها إلى فريق ماركتون.',
    'ticket.created':'تم فتح التذكرة وإرسالها إلى فريق ماركتون.',
    assigned:'تم إسناد التذكرة إلى موظف دعم.',
    'ticket.assigned':'تم تحديث إسناد التذكرة داخل فريق ماركتون.',
    status_changed:`تم تحديث حالة التذكرة إلى «${status}».`,
    priority_changed:'تم تحديث أولوية التذكرة.',
    resolved:'أضاف فريق ماركتون حلًا للتذكرة.',
    closed:'تم إغلاق التذكرة.',
    'ticket.closed':'تم إغلاق التذكرة بعد تأكيد الحل.',
    reopened:'أُعيد فتح التذكرة.',
    'ticket.reopened':'أُعيد فتح التذكرة.',
    'ticket.updated':ticketUpdated
  })[action]||'تم تحديث التذكرة.';
}

function normalizeOptions(values){
  return values.map(item=>({
    id:text(pick(item,['id','value','tenantId','tenant_id','subjectId','subject_id'])),
    name:text(pick(item,['name','label','fullName','full_name','tenantName','tenant_name'],'دون اسم'))
  })).filter(item=>item.id);
}

function mergeOptions(...groups){
  const merged=new Map();
  for(const group of groups){
    for(const item of group||[]){
      if(item?.id&&!merged.has(item.id))merged.set(item.id,item);
    }
  }
  return Array.from(merged.values());
}

function normalizeQueues(raw,summary){
  if(Array.isArray(raw))return Object.fromEntries(raw.map(item=>[
    text(pick(item,['key','queue'])),nonNegative(pick(item,['count','total'],0),0)
  ]));
  if(raw&&typeof raw==='object')return Object.fromEntries(Object.entries(raw).map(([key,value])=>[
    key,nonNegative(typeof value==='object'?pick(value,['count','total'],0):value,0)
  ]));
  return {all:summary.total,new:summary.new,unassigned:summary.unassigned,mine:summary.mine,urgent:summary.urgent,at_risk:summary.dueSoon,breached:summary.overdue,waiting_tenant:summary.waitingTenant};
}

function queueCount(queues,key,summary){
  return nonNegative(queues[key],key==='all'?summary.total:0);
}

function summaryKeys(key){
  return ({
    total:['total','totalTickets','total_tickets'],open:['open','openTickets','open_tickets'],
    waitingTenant:['waitingTenant','waiting_tenant'],resolved:['resolved','resolvedTickets','resolved_tickets'],
    unassigned:['unassigned','unassignedTickets','unassigned_tickets'],mine:['mine','assignedToMe','assigned_to_me'],
    urgent:['urgent','urgentTickets','urgent_tickets'],overdue:['overdue','breached','slaBreached','sla_breached'],
    new:['new','newTickets','new_tickets'],dueSoon:['dueSoon','due_soon']
  })[key]||[key];
}

function normalizeStatus(value){
  const status=text(value).toLowerCase();
  return ({pending:'new',open:'new',reviewing:'reviewing',approved:'approved',done:'done',rejected:'rejected'})[status]
    ||(STATUS_OPTIONS.some(([key])=>key===status)?status:status||'new');
}

function normalizePriority(value){
  const priority=text(value).toLowerCase();
  return ({p1:'urgent',critical:'urgent',p2:'high',p3:'medium',normal:'medium',p4:'low'})[priority]
    ||(PRIORITIES[priority]?priority:'medium');
}

function normalizeImpact(value){
  const impact=text(value).toLowerCase();
  const normalized=({blocking:'blocked',major:'multiple_users',partial:'single_user'})[impact]||impact;
  return IMPACTS[normalized]?normalized:'single_user';
}

function normalizeModuleKey(value){
  const moduleKey=text(value).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g,'_').replace(/^_+|_+$/g,'');
  return /^[a-z][a-z0-9_.-]{1,79}$/.test(moduleKey)?moduleKey:'other';
}

function statusLabel(value){
  const status=normalizeStatus(value);
  return STATUS_OPTIONS.find(([key])=>key===status)?.[1]||LEGACY_STATUS_LABELS[status]||status||'غير محددة';
}

function moduleLabel(value){
  return MODULES.find(([key])=>key===value)?.[1]||value||'قسم آخر';
}

function priorityClass(priority){
  return ({urgent:styles.priorityUrgent,high:styles.priorityHigh,medium:styles.priorityMedium,low:styles.priorityLow})[priority]||styles.priorityMedium;
}

function resultId(result,keys){
  const sources=[object(result),object(result?.ticket),object(result?.message)].filter(Boolean);
  for(const source of sources){
    const value=text(pick(source,keys,''));
    if(value)return value;
  }
  return '';
}

function firstArray(source,keys){
  for(const key of keys)if(Array.isArray(source?.[key]))return source[key];
  return [];
}

function pick(source,keys,fallback=null){
  if(!source||typeof source!=='object')return fallback;
  for(const key of keys){
    const value=source[key];
    if(value!==undefined&&value!==null)return value;
  }
  return fallback;
}

function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}
function text(value,fallback=''){const result=String(value??'').trim();return result||fallback;}
function boolean(value,fallback=false){
  if(typeof value==='boolean')return value;
  if(value===1||value==='1'||value==='true')return true;
  if(value===0||value==='0'||value==='false')return false;
  return fallback;
}
function nonNegative(value,fallback=0){const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=0?parsed:fallback;}
function number(value){return new Intl.NumberFormat('ar-SA').format(nonNegative(value,0));}
function dateIso(value){if(!value)return null;const parsed=new Date(value);return Number.isNaN(parsed.getTime())?null:parsed.toISOString();}
function dateValue(value){if(!value)return 0;const parsed=new Date(value).getTime();return Number.isFinite(parsed)?parsed:0;}
function dateTime(value){
  if(!value)return '—';
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA',{timeZone:'Asia/Riyadh',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(parsed);
}
function durationLabel(minutes){
  const value=Math.round(Number(minutes)||0);
  if(value<0)return 'متجاوز';
  if(value<60)return `${value} دقيقة متبقية`;
  if(value<1440)return `${Math.ceil(value/60)} ساعة متبقية`;
  return `${Math.ceil(value/1440)} يوم متبقٍ`;
}
function fileSize(bytes){
  const value=Number(bytes)||0;
  if(!value)return '';
  if(value<1024)return `${value} B`;
  if(value<1024*1024)return `${(value/1024).toFixed(1)} KB`;
  return `${(value/1024/1024).toFixed(1)} MB`;
}
function shortId(value){const id=text(value);return id?`#${id.slice(0,8).toUpperCase()}`:'—';}
function ticketReadKey(ticket){return `${ticket.id}:${ticket.version}:${ticket.unreadCount}`;}
function shortUrl(value){try{const url=new URL(value);return `${url.hostname}${url.pathname}`.slice(0,90);}catch{return text(value).slice(0,90);}}
function diagnosticText(value,maxLength){return text(value).slice(0,maxLength);}
function safeDiagnosticUrl(value){
  const normalized=diagnosticText(value,1500);
  if(!normalized)return '';
  try{
    const parsed=new URL(normalized);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)return '';
    return `${parsed.origin}${parsed.pathname}`.slice(0,1500);
  }catch{return '';}
}
function safeDiagnosticRoute(value,sourceUrl){
  for(const candidate of [value,sourceUrl]){
    const normalized=diagnosticText(candidate,1500);
    if(!normalized)continue;
    try{
      const parsed=new URL(normalized,'https://support.invalid');
      return parsed.pathname.slice(0,500)||'/';
    }catch{continue;}
  }
  return '';
}
function initial(value){return Array.from(text(value,'م'))[0]||'م';}
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
function cx(...values){return values.filter(Boolean).join(' ');}