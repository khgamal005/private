'use client';

import Link from 'next/link';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  buildRegistrationOwnerWhatsAppMessage,
  normalizeRegistrationInvitationUrl
} from '../lib/registration-owner-message.mjs';
import styles from './platform-registration-requests.module.css';

const STATUS={
  unknown:{label:'حالة تحتاج فحصًا',short:'غير معروفة'},
  awaiting_email:{label:'بانتظار تأكيد البريد',short:'تأكيد البريد'},
  pending_review:{label:'بانتظار المراجعة',short:'جديد'},
  under_review:{label:'قيد المراجعة',short:'قيد المراجعة'},
  approved:{label:'معتمد · بانتظار التفعيل',short:'بانتظار التفعيل'},
  rejected:{label:'مرفوض',short:'مرفوض'},
  converted:{label:'مفعّلة وموثوقة',short:'مفعّلة'},
  trust_pending:{label:'مفعّلة · بانتظار الموثوقية',short:'موثوقية معلّقة'},
  trust_review:{label:'الموثوقية قيد المراجعة',short:'مراجعة الموثوقية'},
  trust_restricted:{label:'مقيّدة بعد المراجعة',short:'مقيّدة'}
};

const ACTION_STATUS={
  start_review:'under_review',
  approve:'approved',
  approve_and_activate:'converted',
  reject:'rejected',
  reopen:'under_review',
  provision:'converted',
  trust_start:'trust_review',
  trust_approve:'converted',
  trust_restrict:'trust_restricted',
  move_to_manual_review:'pending_review'
};

const ACTION_MESSAGES={
  start_review:'تم إسناد الطلب لك وبدء المراجعة.',
  approve:'تم قبول الطلب فقط. لم تُنشأ مساحة منشأة بعد.',
  approve_and_activate:'تم اعتماد الطلب وإنشاء مساحة مستقلة وتفعيلها في معاملة واحدة.',
  reject:'تم رفض الطلب وحفظ سبب القرار دون حذف السجل.',
  reopen:'أُعيد الطلب إلى المراجعة مع حفظ سبب إعادة الفتح.',
  provision:'تم إنشاء مساحة المنشأة من الطلب المعتمد.',
  trust_start:'بدأت مراجعة موثوقية المنشأة، والمساحة تواصل العمل بصورة طبيعية.',
  trust_approve:'اكتملت مراجعة الموثوقية وأصبحت المنشأة موثوقة.',
  trust_restrict:'قُيّدت هذه المساحة الجديدة فقط، مع حفظ سبب القرار.',
  move_to_manual_review:'تم إلغاء مسار البريد لهذا الطلب وتحويله بأمان إلى المراجعة اليدوية.'
};

const REJECTION_REASONS=[
  ['incomplete_data','بيانات غير مكتملة'],
  ['unable_to_verify','تعذر التحقق من البيانات'],
  ['duplicate','طلب مكرر أو منشأة قائمة'],
  ['not_eligible','لا يطابق شروط التسجيل'],
  ['other','سبب آخر']
];

function valueOf(source,keys,fallback=''){
  for(const key of keys){
    const value=source?.[key];
    if(value!==undefined&&value!==null&&value!=='')return value;
  }
  return fallback;
}

function text(value,fallback='—'){
  const normalized=String(value??'').trim();
  return normalized||fallback;
}

function number(value){
  const normalized=Number(value);
  return Number.isFinite(normalized)&&normalized>=0?normalized:0;
}

function normalizeStatus(value){
  const normalized=String(value||'pending_review').trim().toLowerCase();
  if(['pending','pending_review'].includes(normalized))return 'pending_review';
  if(['reviewing','in_review','under_review'].includes(normalized))return 'under_review';
  return STATUS[normalized]?normalized:'unknown';
}

function formatDate(value,{time=true}={}){
  if(!value)return '—';
  const parsed=new Date(value);
  if(Number.isNaN(parsed.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',
    ...(time?{timeStyle:'short'}:{}),
    timeZone:'Asia/Riyadh'
  }).format(parsed);
}

function institutionState(value){
  return ['existing','linked','account'].includes(String(value||'').toLowerCase())
    ?'حساب منشأة قائم'
    :'منشأة جديدة';
}

function requestIdentifier(item){
  return item.commercialRegistration||item.nationalRegistration
    ||item.tvtcLicense||item.tvtcLicenseNumber||'غير مضاف';
}

function detailStatus(detail,fallback){
  return normalizeStatus(valueOf(detail,['status','requestStatus','request_status'],fallback));
}

function detailTenantSlug(detail,fallback=''){
  return text(valueOf(detail,[
    'tenantSlug','tenant_slug','provisionedTenantSlug','provisioned_tenant_slug'
  ],fallback),'');
}

function detailTimeline(detail){
  const value=valueOf(detail,['history','events','auditTrail','audit_trail'],[]);
  return Array.isArray(value)?value:[];
}

function validActivationPayload(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const request=value.request;
  const provisioning=value.provisioning;
  if(!request||!provisioning||typeof request!=='object'
     ||typeof provisioning!=='object'||Array.isArray(provisioning))return false;
  const requestStatus=String(valueOf(request,[
    'status','requestStatus','request_status'
  ],'')).toLowerCase();
  const requestTenant=String(valueOf(request,[
    'provisionedTenantId','provisioned_tenant_id'
  ],'')).toLowerCase();
  const tenantId=String(valueOf(provisioning,['id','tenantId','tenant_id'],'')).toLowerCase();
  const slug=String(valueOf(provisioning,['slug','tenantSlug','tenant_slug'],'')).toLowerCase();
  return requestStatus==='converted'
    &&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestTenant)
    &&requestTenant===tenantId
    &&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    &&String(provisioning.status).toLowerCase()==='active'
    &&String(provisioning.resolution).toLowerCase()==='create_new';
}

function eventLabel(event){
  const action=String(valueOf(event,['action','event','status'],'')).toLowerCase();
  return ({
    submitted:'تم استلام الطلب',
    pending:'تم استلام الطلب',
    pending_review:'تم استلام الطلب',
    start_review:'بدأت المراجعة',
    in_review:'قيد المراجعة',
    under_review:'قيد المراجعة',
    reviewing:'قيد المراجعة',
    approve:'تم قبول الطلب',
    approved:'تم قبول الطلب',
    approve_and_activate:'تم اعتماد الطلب وتفعيل المنشأة',
    reject:'تم رفض الطلب',
    rejected:'تم رفض الطلب',
    reopen:'أُعيد فتح الطلب',
    provision:'تم إنشاء مساحة المنشأة',
    provisioned:'تم إنشاء مساحة المنشأة',
    email_confirmation_sent:'أُرسلت رسالة تأكيد البريد',
    email_confirmed:'تم تأكيد البريد',
    email_fallback_manual:'تم تحويل الطلب إلى المراجعة اليدوية',
    auto_provision:'تفعّلت المساحة تلقائيًا',
    trust_start:'بدأت مراجعة الموثوقية',
    trust_approve:'تم اعتماد موثوقية المنشأة',
    trust_restrict:'تم تقييد المساحة بعد المراجعة'
  })[action]||text(valueOf(event,['label','title'],'تحديث على الطلب'));
}

function summaryKey(status){
  if(status==='pending_review')return 'pendingReview';
  if(status==='under_review')return 'underReview';
  if(status==='awaiting_email')return 'awaitingEmail';
  if(status==='trust_pending'||status==='trust_review')return 'trustPending';
  if(status==='trust_restricted')return 'trustRestricted';
  if(status==='converted')return 'trusted';
  return status;
}

function activationLabel(mode){
  return mode==='email_verified_trial'
    ?'تفعيل بعد تأكيد البريد'
    :'مراجعة وتفعيل يدوي';
}

function isExistingInstitution(value){
  return ['existing','linked','account'].includes(String(value||'').trim().toLowerCase());
}

function trustLabel(status){
  return ({
    pending_review:'بانتظار مراجعة الموثوقية',
    under_review:'الموثوقية قيد المراجعة',
    trusted:'موثوقة',
    restricted:'مقيّدة'
  })[String(status||'pending_review')]||'بانتظار مراجعة الموثوقية';
}

function emailDeliveryLabel(delivery){
  const transport=String(valueOf(delivery,['state','status'],'')).toLowerCase();
  const inbox=String(valueOf(delivery,['deliveryState','delivery_state'],'')).toLowerCase();
  return ({
    delivered:'وصلت إلى خادم بريد المستلم',
    bounced:'ارتدت من خادم المستلم',
    complained:'أبلغ المستلم أنها مزعجة',
    suppressed:'منعها مزود البريد',
    delayed:'التسليم متأخر لدى مزود البريد',
    failed:'أبلغ مزود البريد بفشل التسليم',
    sent:'أرسلها مزود البريد'
  })[inbox]||({
    queued:'في طابور الإرسال',
    leased:'جارٍ الإرسال',
    retryable:'ستُعاد المحاولة تلقائيًا',
    accepted:'قبلها مزود البريد',
    terminal_failed:'فشل نهائي يحتاج تدخلًا',
    cancelled:'أُلغيت المحاولة'
  })[transport]||'لم يبدأ إرسال آلي';
}

function trapFocus(event,container){
  if(event.key!=='Tab'||!container)return;
  const focusable=[...container.querySelectorAll(
    'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'
  )].filter(element=>!element.hasAttribute('hidden')&&element.getAttribute('aria-hidden')!=='true');
  if(!focusable.length){
    event.preventDefault();
    container.focus();
    return;
  }
  const first=focusable[0];
  const last=focusable[focusable.length-1];
  if(!container.contains(document.activeElement)){
    event.preventDefault();
    first.focus();
    return;
  }
  if(event.shiftKey&&document.activeElement===first){
    event.preventDefault();
    last.focus();
  }else if(!event.shiftKey&&document.activeElement===last){
    event.preventDefault();
    first.focus();
  }
}

function provisionDefaults(detail,selected){
  const institutionName=text(valueOf(detail,[
    'institutionName','institution_name','organizationName','organization_name'
  ],selected.institutionName),'');
  return {
    displayName:institutionName,
    legalName:text(valueOf(detail,['legalName','legal_name'],institutionName),''),
    slug:text(valueOf(detail,['requestedSlug','requested_slug','slug']),'').toLowerCase(),
    countryCode:text(valueOf(detail,['countryCode','country_code'],'SA'),'SA'),
    timezone:text(valueOf(detail,['timezone'],'Asia/Riyadh'),'Asia/Riyadh'),
    planKey:text(valueOf(detail,['planKey','plan_key'],'free'),'free'),
    ownerName:text(valueOf(detail,[
      'contactName','contact_name','applicantName','applicant_name'
    ],selected.contactName),''),
    ownerEmail:text(valueOf(detail,['contactEmail','contact_email','email']),'').toLowerCase(),
    hostname:text(valueOf(detail,['hostname','domain']),'').toLowerCase()
  };
}

export default function PlatformRegistrationRequests({
  initialData,initialQuery='',initialFilter='all'
}){
  const router=useRouter();
  const [data,setData]=useState(initialData||{summary:{},items:[],total:0,offset:0,limit:25});
  const [query,setQuery]=useState(initialQuery);
  const [filter,setFilter]=useState(initialFilter);
  const [selected,setSelected]=useState(null);
  const [detail,setDetail]=useState(null);
  const [detailLoading,setDetailLoading]=useState(false);
  const [detailError,setDetailError]=useState('');
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [confirm,setConfirm]=useState(null);
  const [decisionNote,setDecisionNote]=useState('');
  const [reasonCategory,setReasonCategory]=useState('');
  const [reason,setReason]=useState('');
  const [acknowledged,setAcknowledged]=useState(false);
  const [confirmedNoExistingTenant,setConfirmedNoExistingTenant]=useState(false);
  const [activationOutcome,setActivationOutcome]=useState(null);
  const [provisionDraft,setProvisionDraft]=useState({
    displayName:'',legalName:'',slug:'',countryCode:'SA',timezone:'Asia/Riyadh',
    planKey:'free',ownerName:'',ownerEmail:'',hostname:''
  });
  const [navigating,setNavigating]=useState(false);
  const drawerRef=useRef(null);
  const confirmRef=useRef(null);
  const handoffRef=useRef(null);
  const detailAbortRef=useRef(null);
  const interactionRef=useRef({busy:'',confirm:null,activationOutcome:null});
  const confirmType=confirm?.type||'';
  const blockingOverlay=Boolean(confirm||activationOutcome);

  useEffect(()=>{
    interactionRef.current={busy,confirm,activationOutcome};
  },[busy,confirm,activationOutcome]);

  useEffect(()=>{
    setData(initialData||{summary:{},items:[],total:0,offset:0,limit:25});
    setNavigating(false);
  },[initialData]);

  useEffect(()=>{
    if(!selected?.id)return undefined;
    const previousFocus=document.activeElement;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const frame=window.requestAnimationFrame(()=>drawerRef.current?.focus());

    function onKeyDown(event){
      const state=interactionRef.current;
      if(event.key==='Escape'){
        event.preventDefault();
        if(state.activationOutcome)return;
        if(state.confirm&&!state.busy){
          setConfirm(null);
          return;
        }
        if(!state.busy){
          detailAbortRef.current?.abort();
          setSelected(null);
          setDetail(null);
        }
        return;
      }
      if(!state.confirm&&!state.activationOutcome)trapFocus(event,drawerRef.current);
    }

    document.addEventListener('keydown',onKeyDown);
    return()=>{
      window.cancelAnimationFrame(frame);
      document.body.style.overflow=previousOverflow;
      document.removeEventListener('keydown',onKeyDown);
      if(previousFocus instanceof HTMLElement)previousFocus.focus();
    };
  },[selected?.id]);

  useEffect(()=>{
    if(!confirmType)return undefined;
    const previousFocus=document.activeElement;
    const fallbackFocus=drawerRef.current;
    const frame=window.requestAnimationFrame(()=>confirmRef.current?.focus());
    function onKeyDown(event){
      if(event.key==='Escape'&&!interactionRef.current.busy){
        event.preventDefault();
        setConfirm(null);
        return;
      }
      trapFocus(event,confirmRef.current);
    }
    document.addEventListener('keydown',onKeyDown);
    return()=>{
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown',onKeyDown);
      window.requestAnimationFrame(()=>{
        const restoreTarget=previousFocus instanceof HTMLElement&&previousFocus.isConnected
          ?previousFocus
          :fallbackFocus?.isConnected?fallbackFocus:null;
        restoreTarget?.focus();
      });
    };
  },[confirmType]);

  useEffect(()=>()=>detailAbortRef.current?.abort(),[]);

  useEffect(()=>{
    if(!activationOutcome)return undefined;
    const previousFocus=document.activeElement;
    const frame=window.requestAnimationFrame(()=>handoffRef.current?.focus());
    function onKeyDown(event){
      if(event.key==='Escape')event.preventDefault();
      trapFocus(event,handoffRef.current);
    }
    document.addEventListener('keydown',onKeyDown);
    return()=>{
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown',onKeyDown);
      if(previousFocus instanceof HTMLElement&&previousFocus.isConnected){
        previousFocus.focus();
      }
    };
  },[activationOutcome]);

  const items=useMemo(()=>Array.isArray(data.items)?data.items:[],[data.items]);
  const visibleItems=items;

  const summary=data.summary||{};
  const total=number(data.total);
  const offset=number(data.offset);
  const limit=Math.max(1,number(data.limit)||25);
  const from=total?offset+1:0;
  const to=Math.min(total,offset+items.length);
  const hasPrevious=offset>0;
  const hasNext=offset+limit<total;
  const currentStatus=selected?detailStatus(detail,selected.status):'pending_review';
  const tenantSlug=selected?detailTenantSlug(detail,selected.tenantSlug):'';
  const existingRequest=selected?isExistingInstitution(valueOf(
    detail,
    ['institutionState','institution_state'],
    selected.institutionState
  )):false;
  const selectedEmailDelivery=valueOf(detail,['emailDelivery','email_delivery'],{});
  const selectedEmailDeliveryState=String(valueOf(
    selectedEmailDelivery,['state','status'],'unknown'
  )).trim().toLowerCase();

  function updateLocalRequest(id,changes){
    setData(current=>{
      const currentItems=Array.isArray(current.items)?current.items:[];
      const previous=currentItems.find(item=>item.id===id);
      const nextItems=currentItems.map(item=>item.id===id?{...item,...changes}:item);
      const nextSummary={...(current.summary||{})};
      if(previous?.status&&changes.status&&previous.status!==changes.status){
        const previousKey=summaryKey(previous.status);
        const nextKey=summaryKey(changes.status);
        if(previousKey!==nextKey){
          nextSummary[previousKey]=Math.max(0,number(nextSummary[previousKey])-1);
          nextSummary[nextKey]=number(nextSummary[nextKey])+1;
        }
      }
      return {...current,summary:nextSummary,items:nextItems};
    });
    setSelected(current=>current?.id===id?{...current,...changes}:current);
  }

  async function loadDetail(item){
    detailAbortRef.current?.abort();
    const controller=new AbortController();
    detailAbortRef.current=controller;
    setSelected(item);
    setActivationOutcome(null);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    setError('');
    try{
      const response=await fetch(
        `/api/platform/registration-requests?id=${encodeURIComponent(item.id)}`,
        {cache:'no-store',signal:controller.signal}
      );
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||'تعذر تحميل تفاصيل الطلب');
      const next=payload.data?.request||payload.data?.item||payload.data||payload.request||payload;
      setDetail(next&&typeof next==='object'?next:{});
    }catch(reasonValue){
      if(reasonValue?.name!=='AbortError'){
        setDetailError(reasonValue instanceof Error?reasonValue.message:'تعذر تحميل تفاصيل الطلب');
      }
    }finally{
      if(detailAbortRef.current===controller)setDetailLoading(false);
    }
  }

  function closeDrawer(){
    if(busy)return;
    detailAbortRef.current?.abort();
    setSelected(null);
    setDetail(null);
    setDetailError('');
    setConfirm(null);
  }

  function closeActivationHandoff(){
    detailAbortRef.current?.abort();
    setActivationOutcome(null);
    setSelected(null);
    setDetail(null);
    setDetailError('');
    setConfirm(null);
  }

  function openConfirmation(type){
    setDecisionNote('');
    setReasonCategory('');
    setReason('');
    setAcknowledged(false);
    setConfirmedNoExistingTenant(false);
    if(type==='provision'||type==='approve_and_activate'){
      setProvisionDraft(provisionDefaults(detail||{},selected));
    }
    setError('');
    setConfirm({type});
  }

  async function runAction(action,{notes=null,payload={}}={}){
    if(!selected?.id||busy)return false;
    const requestId=selected.id;
    const expectedVersion=number(valueOf(
      detail,
      ['version','rowVersion','row_version'],
      selected.version
    ));
    setBusy(action);
    setError('');
    setNotice('');
    if(action==='approve_and_activate')setActivationOutcome(null);
    try{
      const response=await fetch('/api/platform/registration-requests',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          action,
          requestId,
          expectedVersion,
          notes,
          payload,
          ...(action==='reject'&&payload.category?{category:payload.category}:{})
        })
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ الإجراء');
      const resultData=result.data||result;
      if(action==='approve_and_activate'&&!validActivationPayload(resultData)){
        throw new Error('تعذر التحقق من نتيجة التفعيل؛ أعد المحاولة بأمان.');
      }
      const serverRequest=resultData.request||resultData.item||{};
      const nextStatus=normalizeStatus(valueOf(
        serverRequest,
        ['queueStatus','queue_status'],
        ACTION_STATUS[action]||currentStatus
      ));
      const createdTenant=resultData.provisioning||resultData.tenant||resultData.provisionedTenant||{};
      const nextTenantSlug=text(valueOf(
        createdTenant,
        ['slug','tenantSlug','tenant_slug'],
        valueOf(resultData,['tenantSlug','tenant_slug'],tenantSlug)
      ),'');
      const invitationUrl=action==='approve_and_activate'
        ?normalizeRegistrationInvitationUrl(
          valueOf(resultData?.provisioning,['invitationUrl','invitation_url']),
          window.location.origin
        )
        :'';
      const createdOwner=createdTenant?.owner&&typeof createdTenant.owner==='object'
        ?createdTenant.owner
        :{};
      const nextVersion=number(valueOf(
        serverRequest,
        ['version','rowVersion','row_version'],
        valueOf(resultData,['version','rowVersion','row_version'],expectedVersion+1)
      ));
      const changes={
        status:nextStatus,
        version:nextVersion,
        ...(valueOf(serverRequest,['trustStatus','trust_status'])?{
          trustStatus:valueOf(serverRequest,['trustStatus','trust_status'])
        }:{}),
        ...(nextTenantSlug?{tenantSlug:nextTenantSlug}:{})
      };
      updateLocalRequest(requestId,changes);
      setDetail(current=>({
        ...(current||{}),
        ...(serverRequest&&typeof serverRequest==='object'?serverRequest:{}),
        status:nextStatus,
        version:nextVersion,
        ...(valueOf(serverRequest,['trustStatus','trust_status'])?{
          trustStatus:valueOf(serverRequest,['trustStatus','trust_status'])
        }:{}),
        ...(nextTenantSlug?{tenantSlug:nextTenantSlug}:{})
      }));
      setConfirm(null);
      if(action==='approve_and_activate'){
        const ownerStatus=String(valueOf(createdOwner,['status'],'')).trim().toLowerCase();
        const handoffMode=invitationUrl
          ?'invited'
          :ownerStatus==='linked'||ownerStatus==='active'||ownerStatus==='accepted'
            ?'linked'
            :'unavailable';
        const loginUrl=new URL('/login',window.location.origin);
        if(nextTenantSlug){
          loginUrl.searchParams.set('next',`/tenant/${nextTenantSlug}`);
        }
        setActivationOutcome({
          requestId,
          tenantSlug:nextTenantSlug,
          institutionName:text(valueOf(createdTenant,[
            'name','displayName','display_name'
          ],provisionDraft.displayName||selected.institutionName),''),
          ownerName:text(valueOf(createdOwner,[
            'name','fullName','full_name'
          ],provisionDraft.ownerName),''),
          ownerEmail:text(valueOf(
            createdOwner,['email'],provisionDraft.ownerEmail
          ),''),
          ownerStatus,
          handoffMode,
          invitationUrl,
          loginUrl:loginUrl.toString()
        });
      }
      setNotice(ACTION_MESSAGES[action]||'تم تنفيذ الإجراء بنجاح.');
      router.refresh();
      return true;
    }catch(reasonValue){
      setError(reasonValue instanceof Error?reasonValue.message:'تعذر تنفيذ الإجراء');
      return false;
    }finally{
      setBusy('');
    }
  }

  function submitConfirmation(event){
    event.preventDefault();
    if(confirm?.type==='approve'){
      runAction('approve',{notes:decisionNote.trim()||null,payload:{}});
      return;
    }
    if(confirm?.type==='approve_and_activate'){
      const payload={
        ...provisionDraft,
        resolution:'create_new',
        confirmedNoExistingTenant,
        identityVerified:acknowledged
      };
      runAction('approve_and_activate',{
        notes:decisionNote.trim()||null,
        payload
      });
      return;
    }
    if(confirm?.type==='reject'){
      runAction('reject',{
        notes:reason.trim(),
        payload:{category:reasonCategory}
      });
      return;
    }
    if(confirm?.type==='reopen'){
      runAction('reopen',{notes:reason.trim(),payload:{}});
      return;
    }
    if(confirm?.type==='provision'){
      runAction('provision',{notes:null,payload:provisionDraft});
      return;
    }
    if(confirm?.type==='trust_approve'){
      runAction('trust_approve',{notes:decisionNote.trim()||null,payload:{}});
      return;
    }
    if(confirm?.type==='trust_restrict'){
      runAction('trust_restrict',{notes:reason.trim(),payload:{}});
      return;
    }
    if(confirm?.type==='move_to_manual_review'){
      runAction('move_to_manual_review',{notes:reason.trim(),payload:{}});
    }
  }

  function navigationUrl(nextOffset,nextFilter=filter,nextQuery=query){
    const params=new URLSearchParams();
    const normalizedQuery=nextQuery.trim().slice(0,80);
    if(nextOffset>0)params.set('offset',String(nextOffset));
    if(nextFilter&&nextFilter!=='all')params.set('status',nextFilter);
    if(normalizedQuery)params.set('query',normalizedQuery);
    const suffix=params.toString()?`?${params}`:'';
    return `/control/registration-requests${suffix}`;
  }

  function navigate(nextOffset){
    if(navigating)return;
    setNavigating(true);
    router.push(navigationUrl(nextOffset));
  }

  function applyFilter(nextFilter){
    if(navigating)return;
    setFilter(nextFilter);
    setNavigating(true);
    router.push(navigationUrl(0,nextFilter,query));
  }

  function applySearch(event){
    event.preventDefault();
    if(navigating)return;
    setNavigating(true);
    router.push(navigationUrl(0,filter,query));
  }

  return <section className={styles.page} dir="rtl">
    <header className={styles.pageHeader}>
      <div>
        <small>ODEIR REGISTRATION DESK</small>
        <h2>طلبات تسجيل المنشآت</h2>
        <p>تابع التسجيل اليدوي والتفعيل بعد البريد ومراجعة الموثوقية من مسار واحد واضح.</p>
      </div>
      <div className={styles.headerActions}>
        <span className={styles.pendingBadge}><i/>{number(summary.pendingReview)+number(summary.underReview)+number(summary.trustPending)} تحتاج إجراء</span>
        <button type="button" className={styles.refreshButton} onClick={()=>router.refresh()} disabled={navigating}>تحديث البيانات</button>
      </div>
    </header>

    <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
      {notice&&<div className={styles.notice} role="status">{notice}</div>}
      {error&&!confirm&&<div className={styles.error} role="alert">{error}</div>}
    </div>

    <section className={styles.stats} aria-label="ملخص حالات طلبات التسجيل">
      <StatusCard label="كل الطلبات" value={number(summary.total)||total} active={filter==='all'} onClick={()=>applyFilter('all')} tone="all"/>
      <StatusCard label="بانتظار البريد" value={number(summary.awaitingEmail)} active={filter==='awaiting_email'} onClick={()=>applyFilter('awaiting_email')} tone="awaiting_email"/>
      <StatusCard label="مراجعة التسجيل" value={number(summary.pendingReview)+number(summary.underReview)} active={filter==='manual_attention'} onClick={()=>applyFilter('manual_attention')} tone="under_review"/>
      <StatusCard label="مراجعة الموثوقية" value={number(summary.trustPending)} active={filter==='trust_attention'} onClick={()=>applyFilter('trust_attention')} tone="trust_attention"/>
      <StatusCard label="مفعّلة وموثوقة" value={number(summary.trusted)} active={filter==='converted'} onClick={()=>applyFilter('converted')} tone="converted"/>
      <StatusCard label="مرفوضة أو مقيّدة" value={number(summary.rejected)+number(summary.trustRestricted)} active={filter==='restricted'} onClick={()=>applyFilter('restricted')} tone="restricted"/>
    </section>

    <section className={styles.queue} aria-labelledby="registration-queue-title">
      <header className={styles.queueHeader}>
        <div><h3 id="registration-queue-title">صندوق الطلبات</h3><p>{total} طلبًا مطابقًا · عرض {from}–{to}</p></div>
        <form className={styles.search} onSubmit={applySearch}>
          <span className={styles.visuallyHidden}>البحث في طلبات التسجيل</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <input value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث برقم الطلب أو المنشأة أو السجل…"/>
          <button type="submit" className={styles.visuallyHidden}>بحث</button>
        </form>
      </header>

      <div className={styles.filters} role="group" aria-label="تصفية الطلبات حسب الحالة">
        {[
          ['all','الكل',number(summary.total)||total],
          ['awaiting_email','بانتظار البريد',number(summary.awaitingEmail)],
          ['pending_review','جديدة',number(summary.pendingReview)],
          ['under_review','قيد المراجعة',number(summary.underReview)],
          ['approved','بانتظار التفعيل',number(summary.approved)],
          ['trust_attention','مراجعة الموثوقية',number(summary.trustPending)],
          ['rejected','مرفوضة',number(summary.rejected)],
          ['converted','مفعّلة وموثوقة',number(summary.trusted)],
          ['trust_restricted','مقيّدة',number(summary.trustRestricted)]
        ].map(([key,label,count])=><button
          key={key}
          type="button"
          className={filter===key?styles.activeFilter:''}
          aria-pressed={filter===key}
          onClick={()=>applyFilter(key)}
        >{label}<span>{count}</span></button>)}
      </div>

      <div className={styles.listHeader} aria-hidden="true">
        <span>الطلب</span><span>المنشأة</span><span>هوية المنشأة</span><span>الحالة</span><span>المراجع</span><span>الإجراء</span>
      </div>
      <div className={styles.requestList}>
        {visibleItems.map(item=><article className={styles.requestCard} key={item.id}>
          <div className={styles.requestReference} data-label="الطلب">
            <b>{item.reference}</b>
            <small>{formatDate(item.createdAt)}</small>
          </div>
          <div className={styles.institution} data-label="المنشأة">
            <b>{item.institutionName}</b>
            <small>{institutionState(item.institutionState)}{item.contactName?` · ${item.contactName}`:''}</small>
          </div>
          <div className={styles.identity} data-label="هوية المنشأة">
            <b dir="ltr">{requestIdentifier(item)}</b>
            <small>{item.commercialRegistration?'سجل تجاري':item.nationalRegistration?'رقم وطني':item.tvtcLicense||item.tvtcLicenseNumber?'ترخيص تدريب':'بحاجة للتحقق'}</small>
          </div>
          <div data-label="الحالة"><StatusBadge status={item.status}/></div>
          <div className={styles.reviewer} data-label="المراجع">
            <b>{item.reviewerName||'لم يُسند بعد'}</b>
            <small>{item.status==='awaiting_email'?'ينتظر إجراء مقدم الطلب':item.dueAt?`المراجعة قبل ${formatDate(item.dueAt)}`:'مسار قرار موثّق'}</small>
          </div>
          <button type="button" className={styles.reviewButton} onClick={()=>loadDetail(item)} aria-label={`مراجعة الطلب ${item.reference}`}>مراجعة الطلب</button>
        </article>)}
        {!visibleItems.length&&<div className={styles.emptyState}>
          <span>✓</span>
          <b>{query?'لا توجد نتائج مطابقة':'لا توجد طلبات في هذه الحالة'}</b>
          <p>{query?'جرّب رقم الطلب أو اسم المنشأة أو رقم السجل.':'كل الطلبات الموجودة هنا تمت متابعتها.'}</p>
        </div>}
      </div>

      <footer className={styles.pagination} aria-label="التنقل بين صفحات طلبات التسجيل">
        <span>عرض {from}–{to} من {total}</span>
        <div>
          <button type="button" disabled={!hasPrevious||navigating} onClick={()=>navigate(Math.max(0,offset-limit))}>السابق</button>
          <b>الصفحة {Math.floor(offset/limit)+1}</b>
          <button type="button" disabled={!hasNext||navigating} onClick={()=>navigate(offset+limit)}>التالي</button>
        </div>
      </footer>
    </section>

    {selected&&<div className={styles.drawerLayer}>
      <button className={styles.drawerBackdrop} type="button" tabIndex={-1} aria-hidden={blockingOverlay?'true':undefined} disabled={blockingOverlay} aria-label="إغلاق تفاصيل الطلب" onClick={closeDrawer}/>
      <section
        className={styles.drawer}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="registration-request-title"
        aria-describedby="registration-request-description"
        aria-hidden={blockingOverlay?'true':undefined}
        inert={blockingOverlay}
        tabIndex={-1}
      >
        <header className={styles.drawerHeader}>
          <div>
            <small>طلب رقم {selected.reference}</small>
            <h2 id="registration-request-title">{selected.institutionName}</h2>
            <p id="registration-request-description">استُلم في {formatDate(selected.createdAt)}</p>
          </div>
          <div className={styles.drawerHeaderActions}><StatusBadge status={currentStatus}/><button type="button" disabled={Boolean(busy)} onClick={closeDrawer} aria-label="إغلاق">×</button></div>
        </header>

        <div className={styles.drawerBody} aria-busy={detailLoading||Boolean(busy)}>
          {detailLoading&&<DetailSkeleton/>}
          {!detailLoading&&detailError&&<div className={styles.detailError} role="alert"><b>تعذر تحميل التفاصيل</b><p>{detailError}</p><button type="button" onClick={()=>loadDetail(selected)}>إعادة المحاولة</button></div>}
          {!detailLoading&&!detailError&&detail&&<RequestDetails detail={detail} selected={selected}/>} 
        </div>

        {!detailLoading&&!detailError&&detail&&<footer className={styles.drawerFooter}>
          <div><small>القرار لا يحذف الطلب ولا يعدّل بيانات منشأة قائمة.</small>{error&&<span role="alert">{error}</span>}</div>
          <div className={styles.drawerActions}>
            {currentStatus==='pending_review'&&<button type="button" className={styles.primaryAction} disabled={Boolean(busy)} onClick={()=>runAction('start_review')}>{busy==='start_review'?'جارٍ الإسناد…':'بدء المراجعة'}</button>}
            {currentStatus==='awaiting_email'&&<>
              <span className={styles.waitingAction}>{selectedEmailDeliveryState==='terminal_failed'?'فشل إرسال التأكيد نهائيًا؛ يمكن إنقاذ الطلب يدويًا.':'بانتظار تأكيد مقدم الطلب من بريده'}</span>
              {selectedEmailDeliveryState==='terminal_failed'&&<button type="button" className={styles.secondaryAction} disabled={Boolean(busy)} onClick={()=>openConfirmation('move_to_manual_review')}>تحويل للمراجعة اليدوية</button>}
            </>}
            {currentStatus==='under_review'&&<>
              <button type="button" className={styles.rejectAction} disabled={Boolean(busy)} onClick={()=>openConfirmation('reject')}>رفض الطلب</button>
              <button type="button" className={styles.primaryAction} disabled={Boolean(busy)} onClick={()=>openConfirmation('approve_and_activate')}>اعتماد وتفعيل</button>
            </>}
            {currentStatus==='approved'&&!tenantSlug&&<button type="button" className={styles.primaryAction} disabled={Boolean(busy)} onClick={()=>openConfirmation('approve_and_activate')}>إكمال التفعيل</button>}
            {currentStatus==='approved'&&tenantSlug&&<Link className={styles.tenantLink} href={`/tenant/${encodeURIComponent(tenantSlug)}`}>فتح مساحة المنشأة</Link>}
            {currentStatus==='rejected'&&<button type="button" className={styles.secondaryAction} disabled={Boolean(busy)} onClick={()=>openConfirmation('reopen')}>إعادة فتح للمراجعة</button>}
            {currentStatus==='converted'&&tenantSlug&&<Link className={styles.tenantLink} href={`/tenant/${encodeURIComponent(tenantSlug)}`}>فتح مساحة المنشأة</Link>}
            {currentStatus==='trust_pending'&&<button type="button" className={styles.primaryAction} disabled={Boolean(busy)} onClick={()=>runAction('trust_start')}>{busy==='trust_start'?'جارٍ البدء…':'بدء مراجعة الموثوقية'}</button>}
            {currentStatus==='trust_review'&&<>
              <button type="button" className={styles.rejectAction} disabled={Boolean(busy)} onClick={()=>openConfirmation('trust_restrict')}>تقييد المساحة</button>
              <button type="button" className={styles.primaryAction} disabled={Boolean(busy)} onClick={()=>openConfirmation('trust_approve')}>اعتماد الموثوقية</button>
            </>}
            {currentStatus==='trust_restricted'&&<span className={styles.waitingAction}>المساحة مقيّدة، وسبب القرار محفوظ في السجل</span>}
          </div>
        </footer>}
      </section>
    </div>}

    {selected&&confirm&&<ConfirmationDialog
      ref={confirmRef}
      type={confirm.type}
      selected={selected}
      busy={busy}
      error={error}
      decisionNote={decisionNote}
      setDecisionNote={setDecisionNote}
      reasonCategory={reasonCategory}
      setReasonCategory={setReasonCategory}
      reason={reason}
      setReason={setReason}
      acknowledged={acknowledged}
      setAcknowledged={setAcknowledged}
      provisionDraft={provisionDraft}
      setProvisionDraft={setProvisionDraft}
      existingRequest={existingRequest}
      confirmedNoExistingTenant={confirmedNoExistingTenant}
      setConfirmedNoExistingTenant={setConfirmedNoExistingTenant}
      onClose={()=>!busy&&setConfirm(null)}
      onSubmit={submitConfirmation}
    />}

    {activationOutcome&&<ActivationHandoffDialog
      ref={handoffRef}
      outcome={activationOutcome}
      onClose={closeActivationHandoff}
    />}
  </section>;
}

function ActivationHandoffDialog({ref,outcome,onClose}){
  const [copyState,setCopyState]=useState('');
  const message=useMemo(()=>buildRegistrationOwnerWhatsAppMessage({
    mode:outcome.handoffMode,
    institutionName:outcome.institutionName,
    ownerName:outcome.ownerName,
    ownerEmail:outcome.ownerEmail,
    activationUrl:outcome.invitationUrl,
    loginUrl:outcome.loginUrl
  }),[outcome]);

  async function copyValue(value,success){
    if(!value)return;
    try{
      await navigator.clipboard.writeText(value);
      setCopyState(success);
    }catch{
      setCopyState('تعذر النسخ التلقائي؛ حدّد النص من المربع وانسخه يدويًا.');
    }
  }

  const invited=outcome.handoffMode==='invited'&&Boolean(outcome.invitationUrl);
  const linked=outcome.handoffMode==='linked';
  return <div className={`${styles.confirmLayer} ${styles.handoffLayer}`}>
    <div className={styles.confirmBackdrop} aria-hidden="true"/>
    <section
      className={styles.handoffDialog}
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="registration-handoff-title"
      aria-describedby="registration-handoff-description"
      tabIndex={-1}
    >
      <header className={styles.handoffHeader}>
        <span aria-hidden="true">✓</span>
        <div>
          <small>تم إنشاء المنشأة بنجاح</small>
          <h2 id="registration-handoff-title">رسالة واتساب جاهزة للمالك</h2>
          <p id="registration-handoff-description">
            {invited
              ?'انسخ الرسالة وأرسلها إلى صاحب المنشأة عبر محادثة خاصة.'
              :linked
                ?'حساب المالك مرتبط بالفعل؛ الرسالة تحتوي رابط تسجيل الدخول الصحيح.'
                :'المنشأة نشطة، لكن لم يصل رابط دعوة صالح في نتيجة التفعيل.'}
          </p>
        </div>
      </header>

      <dl className={styles.handoffSummary}>
        <div><dt>المنشأة</dt><dd>{outcome.institutionName||'المنشأة الجديدة'}</dd></div>
        <div><dt>المالك</dt><dd>{outcome.ownerName||'صاحب المنشأة'}</dd></div>
        <div><dt>البريد</dt><dd dir="ltr">{outcome.ownerEmail||'—'}</dd></div>
        <div><dt>الحالة</dt><dd>{invited?'بانتظار تفعيل المالك':linked?'حساب المالك مرتبط':'تحتاج إصدار دعوة جديدة'}</dd></div>
      </dl>

      {message?<label className={styles.whatsappMessage}>
        <span>نص الرسالة</span>
        <textarea
          readOnly
          dir="rtl"
          value={message}
          rows="11"
          onFocus={event=>event.currentTarget.select()}
          aria-label="رسالة واتساب الجاهزة لصاحب المنشأة"
        />
      </label>:<div className={styles.handoffWarning} role="alert">
        <b>لا ترسل رسالة ناقصة للعميل</b>
        <p>أصدر دعوة مالك جديدة من إعدادات المنشأة، ثم انسخ الرابط الجديد فقط.</p>
      </div>}

      <div className={styles.handoffSecurity} role="note">
        <b>تنبيه أمني</b>
        <span>{invited
          ?'رابط التفعيل خاص بالمالك ويُستخدم مرة واحدة. لا ترسله إلى مجموعة أو رقم غير مؤكد.'
          :'لن تتضمن الرسالة أي كلمة مرور أو رمز تحقق.'}</span>
      </div>

      {copyState&&<div className={styles.copyState} role="status" aria-live="polite">{copyState}</div>}

      <footer className={styles.handoffActions}>
        {message&&<button
          type="button"
          className={styles.primaryConfirm}
          onClick={()=>copyValue(message,'تم نسخ رسالة واتساب كاملة.')}
        >نسخ رسالة واتساب</button>}
        {invited&&<button
          type="button"
          className={styles.cancelButton}
          onClick={()=>copyValue(outcome.invitationUrl,'تم نسخ رابط التفعيل فقط.')}
        >نسخ رابط التفعيل فقط</button>}
        {outcome.tenantSlug&&<Link
          className={styles.secondaryAction}
          href={`/tenant/${encodeURIComponent(outcome.tenantSlug)}`}
          target="_blank"
          rel="noopener noreferrer"
          prefetch={false}
        >فتح المنشأة في نافذة جديدة</Link>}
        <button type="button" className={styles.cancelButton} onClick={onClose}>
          تم، العودة لطلبات التسجيل
        </button>
      </footer>
    </section>
  </div>;
}

function StatusCard({label,value,active,onClick,tone}){
  return <button type="button" className={`${styles.statCard} ${styles[tone]||''} ${active?styles.activeStat:''}`} aria-pressed={active} onClick={onClick}>
    <span>{label}</span><b>{value}</b><small>اضغط للتصفية</small>
  </button>;
}

function StatusBadge({status}){
  const key=normalizeStatus(status);
  return <span className={`${styles.status} ${styles[key]}`}><i aria-hidden="true"/>{STATUS[key].label}</span>;
}

function DetailItem({label,value,ltr=false,wide=false}){
  return <div className={`${styles.detailItem} ${wide?styles.wideDetail:''}`}><span>{label}</span><b dir={ltr?'ltr':undefined}>{text(value)}</b></div>;
}

function RequestDetails({detail,selected}){
  const state=valueOf(detail,['institutionState','institution_state'],selected.institutionState);
  const institutionName=valueOf(detail,['institutionName','institution_name','organizationName','organization_name'],selected.institutionName);
  const commercialRegistration=valueOf(detail,['commercialRegistration','commercial_registration','crNumber','cr_number'],selected.commercialRegistration);
  const nationalRegistration=valueOf(detail,['nationalRegistration','national_registration','nationalNumber','national_number'],selected.nationalRegistration);
  const tvtcLicense=valueOf(detail,['tvtcLicense','tvtc_license','tvtcLicenseNumber','tvtc_license_number','trainingLicense','training_license'],selected.tvtcLicense||selected.tvtcLicenseNumber);
  const contactName=valueOf(detail,['contactName','contact_name','applicantName','applicant_name'],selected.contactName);
  const contactTitle=valueOf(detail,['contactTitle','contact_title','contactJobTitle','contact_job_title','jobTitle','job_title'],selected.contactTitle);
  const contactEmail=valueOf(detail,['contactEmail','contact_email','email']);
  const contactPhone=valueOf(detail,['contactPhone','contact_phone','phone','mobile']);
  const reviewer=valueOf(detail,['reviewerName','reviewer_name','assignedReviewerName','assigned_reviewer_name'],selected.reviewerName);
  const decisionNote=valueOf(detail,['decisionNote','decision_note','reviewNote','review_note','reviewNotes','review_notes']);
  const rejectionReason=valueOf(detail,['rejectionReason','rejection_reason']);
  const consentAt=valueOf(detail,['consentAt','consent_at','privacyConsentAt','privacy_consent_at','acceptedAt','accepted_at','acknowledgedAt','acknowledged_at']);
  const timeline=detailTimeline(detail);
  const activationMode=valueOf(detail,['activationMode','activation_mode'],selected.activationMode||'manual_review');
  const currentTrust=valueOf(detail,['trustStatus','trust_status'],selected.trustStatus||'pending_review');
  const emailConfirmedAt=valueOf(detail,['emailConfirmedAt','email_confirmed_at'],selected.emailConfirmedAt);
  const emailDelivery=valueOf(detail,['emailDelivery','email_delivery'],{});
  const hasEmailDelivery=emailDelivery&&typeof emailDelivery==='object'
    &&!Array.isArray(emailDelivery)&&Object.keys(emailDelivery).length>0;
  const autoActivated=activationMode==='email_verified_trial';

  return <div className={styles.details}>
    {String(state).toLowerCase()==='existing'&&<aside className={styles.existingNotice}><span>✓</span><div><b>الطلب يشير إلى منشأة في السجل الخارجي</b><p>سيُتحقق من التطابق خادميًا ثم تُنشأ مساحة مستقلة فقط؛ هذا المسار لا يربط أو يعدّل أي مساحة أودير قائمة.</p></div></aside>}
    {autoActivated&&<aside className={styles.autoNotice}><span>◎</span><div><b>المساحة تعمل أثناء مراجعة الموثوقية</b><p>تأكيد البريد فعّل مساحة جديدة مستقلة وفق الباقة المحددة. المراجعة لا تعطل وظائفها إلا إذا صدر قرار تقييد موثّق.</p></div></aside>}

    <section className={styles.detailSection}>
      <header><span>01</span><div><h3>بيانات المنشأة</h3><p>الهوية النظامية التي قُدم بها الطلب</p></div></header>
      <div className={styles.detailGrid}>
        <DetailItem label="اسم المنشأة" value={institutionName} wide/>
        <DetailItem label="نوع الطلب" value={institutionState(state)}/>
        <DetailItem label="السجل التجاري" value={commercialRegistration} ltr/>
        <DetailItem label="الرقم الوطني" value={nationalRegistration} ltr/>
        <DetailItem label="ترخيص التدريب" value={tvtcLicense} ltr/>
      </div>
    </section>

    <section className={styles.detailSection}>
      <header><span>02</span><div><h3>مقدم الطلب</h3><p>لا تظهر بيانات الاتصال في صندوق الطلبات العام</p></div></header>
      <div className={styles.detailGrid}>
        <DetailItem label="الاسم" value={contactName}/>
        <DetailItem label="المسمى الوظيفي" value={contactTitle}/>
        <DetailItem label="البريد الإلكتروني" value={contactEmail} ltr/>
        <DetailItem label="رقم الجوال" value={contactPhone} ltr/>
      </div>
    </section>

    <section className={styles.detailSection}>
      <header><span>03</span><div><h3>التفعيل والموثوقية</h3><p>{autoActivated?'التشغيل فوري، والموثوقية لها مسار قرار مستقل':'قرار بشري موثّق قبل تجهيز أي مساحة'}</p></div></header>
      <div className={styles.detailGrid}>
        <DetailItem label="مسار التفعيل" value={activationLabel(activationMode)}/>
        <DetailItem label="حالة الموثوقية" value={trustLabel(currentTrust)}/>
        {hasEmailDelivery&&<>
          <DetailItem label="تسليم بريد التأكيد" value={emailDeliveryLabel(emailDelivery)}/>
          <DetailItem label="محاولات البريد" value={valueOf(emailDelivery,['attemptCount','attempt_count'],0)} ltr/>
          {valueOf(emailDelivery,['nextAttemptAt','next_attempt_at'])&&<DetailItem label="المحاولة التالية" value={formatDate(valueOf(emailDelivery,['nextAttemptAt','next_attempt_at']))}/>} 
          {valueOf(emailDelivery,['lastErrorCode','last_error_code'])&&<DetailItem label="رمز عطل البريد" value={valueOf(emailDelivery,['lastErrorCode','last_error_code'])} ltr/>}
        </>}
        {emailConfirmedAt&&<DetailItem label="تأكيد البريد" value={formatDate(emailConfirmedAt)}/>} 
        <DetailItem label="مسؤول المراجعة" value={reviewer||'لم يُسند بعد'}/>
        <DetailItem label="وقت الاستلام" value={formatDate(valueOf(detail,['createdAt','created_at','submittedAt','submitted_at'],selected.createdAt))}/>
        <DetailItem label="وقت آخر تحديث" value={formatDate(valueOf(detail,['updatedAt','updated_at'],selected.updatedAt))}/>
        <DetailItem label="تسجيل الموافقة" value={consentAt?formatDate(consentAt):'مسجلة مع الطلب'}/>
        {(decisionNote||rejectionReason)&&<DetailItem label={rejectionReason?'سبب الرفض':'ملاحظة القرار'} value={rejectionReason||decisionNote} wide/>}
      </div>
    </section>

    {timeline.length>0&&<section className={styles.detailSection}>
      <header><span>04</span><div><h3>سجل الطلب</h3><p>تسلسل الإجراءات المحفوظة</p></div></header>
      <ol className={styles.timeline}>{timeline.map((event,index)=><li key={valueOf(event,['id'],`${index}-${eventLabel(event)}`)}>
        <i/>
        <div><b>{eventLabel(event)}</b><small>{text(valueOf(event,['actorName','actor_name','actorEmail','actor_email'],'النظام'))}</small>{valueOf(event,['note','notes','reason','description'])&&<p>{text(valueOf(event,['note','notes','reason','description']))}</p>}</div>
        <time>{formatDate(valueOf(event,['createdAt','created_at','occurredAt','occurred_at']))}</time>
      </li>)}</ol>
    </section>}
  </div>;
}

function DetailSkeleton(){
  return <div className={styles.skeleton} role="status" aria-live="polite" aria-label="جارٍ تحميل تفاصيل الطلب"><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/></div>;
}

function confirmationCopy(type){
  if(type==='move_to_manual_review')return {eyebrow:'مسار إنقاذ موثّق',title:'تحويل الطلب إلى المراجعة اليدوية',description:'ستُلغى كل روابط ومحاولات التأكيد لهذا الطلب، ثم ينتقل للمراجعة. لن تُنشأ مساحة من هذه الخطوة.',button:'تحويل للمراجعة'};
  if(type==='approve_and_activate')return {eyebrow:'قرار ذري وآمن',title:'اعتماد الطلب وتفعيل المنشأة',description:'يُنفذ الاعتماد والتفعيل معًا. إذا تعذر أي تحقق فلن تُحفظ حالة قبول ناقصة.',button:'اعتماد وتفعيل'};
  if(type==='approve')return {eyebrow:'قرار المراجعة',title:'قبول طلب التسجيل',description:'سيُسجل القبول فقط. لن تُنشأ مساحة منشأة ولن تتغير بيانات أي منشأة قائمة.',button:'تأكيد قبول الطلب'};
  if(type==='reject')return {eyebrow:'قرار يحتاج سببًا',title:'رفض طلب التسجيل',description:'سيبقى الطلب محفوظًا في السجل ولن تُحذف بياناته.',button:'تأكيد رفض الطلب'};
  if(type==='reopen')return {eyebrow:'إعادة للمراجعة',title:'إعادة فتح الطلب',description:'سيعود الطلب إلى «قيد المراجعة» مع حفظ سبب إعادة الفتح.',button:'إعادة فتح الطلب'};
  if(type==='trust_approve')return {eyebrow:'قرار الموثوقية',title:'اعتماد موثوقية المنشأة',description:'ستبقى المساحة مفعّلة، ويُسجل اكتمال التحقق من موثوقية المنشأة.',button:'اعتماد الموثوقية'};
  if(type==='trust_restrict')return {eyebrow:'قرار حماية موثّق',title:'تقييد المساحة الجديدة',description:'سيُوقف وصول هذه المساحة المرتبطة بالطلب فقط، من دون حذف بياناتها أو المساس بأي منشأة أخرى.',button:'تأكيد تقييد المساحة'};
  return {eyebrow:'خطوة مستقلة وآمنة',title:'إنشاء مساحة المنشأة',description:'هذا هو الإجراء الوحيد الذي ينشئ مساحة. تحقق من هوية المنشأة قبل المتابعة.',button:'إنشاء مساحة المنشأة'};
}

const ConfirmationDialog=({
  ref,type,selected,busy,error,decisionNote,setDecisionNote,
  reasonCategory,setReasonCategory,reason,setReason,
  acknowledged,setAcknowledged,provisionDraft,setProvisionDraft,
  existingRequest,
  confirmedNoExistingTenant,setConfirmedNoExistingTenant,onClose,onSubmit
})=>{
  const copy=confirmationCopy(type);
  const requiresReason=type==='reject'||type==='reopen'||type==='trust_restrict'
    ||type==='move_to_manual_review';
  const provisionValid=Boolean(
    provisionDraft.displayName.trim()
    &&provisionDraft.legalName.trim()
    &&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provisionDraft.slug.trim())
    &&provisionDraft.countryCode.trim()
    &&provisionDraft.timezone.trim()
    &&provisionDraft.planKey.trim()
    &&provisionDraft.ownerName.trim()
    &&/^\S+@\S+\.\S+$/.test(provisionDraft.ownerEmail.trim())
  );
  const activationValid=Boolean(
    acknowledged&&confirmedNoExistingTenant&&provisionValid
  );
  const valid=type==='reject'
    ?Boolean(reasonCategory&&reason.trim().length>=8)
    :type==='reopen'||type==='trust_restrict'||type==='move_to_manual_review'
      ?reason.trim().length>=8
      :type==='approve_and_activate'
        ?activationValid
      :type==='provision'
        ?acknowledged&&provisionValid
        :acknowledged;
  return <div className={styles.confirmLayer}>
      <button type="button" tabIndex={-1} className={styles.confirmBackdrop} aria-hidden="true" disabled={Boolean(busy)} onClick={onClose}/>
    <form
      className={styles.confirmDialog}
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="registration-confirm-title"
      aria-describedby={`registration-confirm-description${!valid?' registration-confirm-help':''}`}
      aria-busy={Boolean(busy)}
      tabIndex={-1}
      onSubmit={onSubmit}
    >
      <header><div><small>{copy.eyebrow}</small><h2 id="registration-confirm-title">{copy.title}</h2></div><button type="button" disabled={Boolean(busy)} onClick={onClose} aria-label="إغلاق">×</button></header>
      <p id="registration-confirm-description">{copy.description}</p>
      <div className={styles.confirmSummary}><span>الطلب</span><b>{selected.reference}</b><span>المنشأة</span><b>{selected.institutionName}</b><span>رقم الهوية</span><b dir="ltr">{requestIdentifier(selected)}</b></div>

      {(type==='approve'||type==='approve_and_activate')&&<label className={styles.confirmField}><span>ملاحظة داخلية اختيارية</span><textarea value={decisionNote} onChange={event=>setDecisionNote(event.target.value)} maxLength="1000" rows="3" placeholder="أي ملاحظة يحتاجها فريق التجهيز…"/></label>}
      {type==='trust_approve'&&<label className={styles.confirmField}><span>ملاحظة تحقق اختيارية</span><textarea value={decisionNote} onChange={event=>setDecisionNote(event.target.value)} maxLength="1000" rows="3" placeholder="مصادر أو ملخص التحقق…"/></label>}
      {type==='reject'&&<label className={styles.confirmField}><span>تصنيف سبب الرفض</span><select required value={reasonCategory} onChange={event=>setReasonCategory(event.target.value)}><option value="" disabled>اختر السبب</option>{REJECTION_REASONS.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>}
      {requiresReason&&<label className={styles.confirmField}><span>{type==='reject'?'سبب الرفض':type==='trust_restrict'?'سبب تقييد المساحة':type==='move_to_manual_review'?'سبب التحويل للمراجعة اليدوية':'سبب إعادة الفتح'}</span><textarea required minLength="8" maxLength="1200" rows="4" value={reason} onChange={event=>setReason(event.target.value)} placeholder="اكتب سببًا واضحًا يمكن الرجوع إليه…"/></label>}
      {type==='approve_and_activate'&&existingRequest&&<div className={styles.confirmSummary} role="note"><span>عزل إلزامي</span><b>سيُعاد التحقق من السجل الرسمي خادميًا، ثم تُنشأ مساحة مستقلة فقط. ربط مساحة أودير قائمة غير متاح من هذا المسار.</b></div>}
      {type==='approve_and_activate'&&<ProvisionFields value={provisionDraft} onChange={setProvisionDraft}/>} 
      {type==='provision'&&<ProvisionFields value={provisionDraft} onChange={setProvisionDraft}/>} 
      {type==='approve_and_activate'&&<label className={styles.acknowledgement}><input type="checkbox" checked={confirmedNoExistingTenant} onChange={event=>setConfirmedNoExistingTenant(event.target.checked)}/><span>بحثت في منشآت أودير وأؤكد عدم وجود مساحة قائمة لهذه المنشأة؛ لن أربط الطلب بأي مساحة قائمة.</span></label>}
      {!requiresReason&&<label className={styles.acknowledgement}><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/><span>{type==='approve_and_activate'?'راجعت هوية المنشأة وأؤكد صحة قرار إنشاء مساحة مستقلة بعد التحقق الخادمي.' :type==='provision'?'راجعت هوية المنشأة وأؤكد إنشاء مساحة مستقلة لها.':type==='trust_approve'?'راجعت مصادر التحقق وأؤكد اعتماد موثوقية هذه المنشأة.':'راجعت بيانات المنشأة وأؤكد أن هذا القرار لا ينشئ مساحة تلقائيًا.'}</span></label>}
      {error&&<div className={styles.confirmError} role="alert">{error}</div>}
      {!valid&&<small id="registration-confirm-help" className={styles.confirmHelp} role="status" aria-live="polite">استكمل الإقرار أو سبب القرار والحقول المطلوبة قبل المتابعة.</small>}
      <footer><button type="button" className={styles.cancelButton} disabled={Boolean(busy)} onClick={onClose}>إلغاء</button><button type="submit" className={type==='reject'||type==='trust_restrict'?styles.dangerConfirm:styles.primaryConfirm} disabled={Boolean(busy)||!valid} aria-describedby={!valid?'registration-confirm-help':undefined}>{busy?'جارٍ التنفيذ…':copy.button}</button></footer>
    </form>
  </div>;
};

function ProvisionFields({value,onChange}){
  function set(key,nextValue){
    onChange(current=>({...current,[key]:nextValue}));
  }
  return <fieldset className={styles.provisionGrid}>
    <legend>بيانات مساحة المنشأة الجديدة</legend>
    <label className={styles.confirmField}><span>اسم العرض</span><input required value={value.displayName} onChange={event=>set('displayName',event.target.value)} maxLength="160"/></label>
    <label className={styles.confirmField}><span>الاسم القانوني</span><input required value={value.legalName} onChange={event=>set('legalName',event.target.value)} maxLength="200"/></label>
    <label className={styles.confirmField}><span>الرابط المختصر</span><input required dir="ltr" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value={value.slug} onChange={event=>set('slug',event.target.value.toLowerCase().replace(/[^a-z0-9-]/g,''))} placeholder="example-institute"/></label>
    <label className={styles.confirmField}><span>الدولة</span><select required value={value.countryCode} onChange={event=>set('countryCode',event.target.value)}><option value="SA">السعودية</option><option value="AE">الإمارات</option><option value="EG">مصر</option></select></label>
    <label className={styles.confirmField}><span>المنطقة الزمنية</span><select required value={value.timezone} onChange={event=>set('timezone',event.target.value)}><option value="Asia/Riyadh">الرياض</option><option value="Asia/Dubai">دبي</option><option value="Africa/Cairo">القاهرة</option></select></label>
    <label className={styles.confirmField}><span>مفتاح الباقة</span><input required dir="ltr" value={value.planKey} onChange={event=>set('planKey',event.target.value.trim().toLowerCase())} placeholder="free"/></label>
    <label className={styles.confirmField}><span>اسم مالك المنشأة</span><input required value={value.ownerName} onChange={event=>set('ownerName',event.target.value)} maxLength="160"/></label>
    <label className={styles.confirmField}><span>بريد المالك</span><input required type="email" dir="ltr" value={value.ownerEmail} onChange={event=>set('ownerEmail',event.target.value.trim().toLowerCase())}/></label>
    <label className={`${styles.confirmField} ${styles.provisionWide}`}><span>الدومين أو Subdomain (اختياري)</span><input dir="ltr" value={value.hostname} onChange={event=>set('hostname',event.target.value.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,''))} placeholder="academy.odeir.com"/></label>
  </fieldset>;
}
