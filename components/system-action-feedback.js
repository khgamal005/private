'use client';

import {useEffect,useRef,useState} from 'react';

const FEEDBACK_EVENT='marktone:action-feedback';
const AUTO_HIDE_MS=7000;

function cleanText(value){
  return String(value||'').replace(/\s+/g,' ').trim();
}

function unique(values){
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function splitReasons(value){
  if(!value)return [];
  if(Array.isArray(value))return unique(value);
  return unique(String(value).split(/\|\||\n|؛/g));
}

function fieldLabel(control){
  const direct=cleanText(
    control.getAttribute('aria-label')
    ||control.dataset?.fieldLabel
  );
  if(direct)return direct;

  const label=control.closest('label');
  if(label){
    const clone=label.cloneNode(true);
    clone.querySelectorAll('input,select,textarea,button,small').forEach(node=>node.remove());
    const value=cleanText(clone.textContent);
    if(value)return value;
  }

  return cleanText(
    control.getAttribute('placeholder')
    ||control.getAttribute('name')
    ||'حقل مطلوب'
  );
}

function isEmpty(control){
  if(control.type==='checkbox'||control.type==='radio')return !control.checked;
  return !cleanText(control.value);
}

function inferMissingFields(scope,actionLabel){
  if(!scope)return [];
  const reasons=[];
  const completionAction=/إنشاء|إتمام|تسجيل|اعتماد|تأكيد|إرسال|حفظ|نشر|تفعيل/.test(actionLabel);

  scope.querySelectorAll('input,select,textarea').forEach(control=>{
    if(control.disabled||control.type==='hidden')return;
    const required=control.required||control.getAttribute('aria-required')==='true';
    const placeholderOption=control.tagName==='SELECT'
      &&completionAction
      &&isEmpty(control)
      &&/اختر|حدد|لم تحدد|غير محدد/.test(cleanText(control.options?.[0]?.textContent));
    const invalid=control.getAttribute('aria-invalid')==='true'
      ||(typeof control.checkValidity==='function'&&!control.checkValidity());

    if((required&&isEmpty(control))||placeholderOption){
      reasons.push(`استكمل حقل «${fieldLabel(control)}»`);
    }else if(invalid){
      reasons.push(`راجع قيمة حقل «${fieldLabel(control)}»`);
    }
  });

  return reasons;
}

function inferChecklist(scope){
  if(!scope)return [];
  const reasons=[];
  scope.querySelectorAll('[data-requirement-status], .mt-document-checklist article').forEach(item=>{
    const text=cleanText(item.textContent);
    const status=cleanText(item.dataset?.requirementStatus||text);
    const explicitlyOptional=item.dataset?.required==='false'||/اختياري|غير مطلوب/.test(status);
    const required=item.dataset?.required==='true'||(!explicitlyOptional&&/مطلوب/.test(status));
    const complete=/معتمد|مكتمل|تم التنفيذ|غير مطلوب|approved|completed|done|not_required/i.test(status);
    if(!required||complete)return;
    const name=cleanText(item.querySelector('b,strong,h4,h5')?.textContent)||'متطلب مطلوب';
    reasons.push(`اعتمد أو استكمل «${name}»`);
  });
  return reasons;
}

function feedbackScope(element){
  return element.closest('[data-action-scope],form,[role="dialog"],.mt-modal,.mt-panel,main');
}

function inferBlockedReasons(element){
  const declared=splitReasons(
    element.dataset?.blockReason
    ||element.dataset?.disabledReason
    ||element.getAttribute('aria-description')
  );
  if(declared.length)return declared;

  const scope=feedbackScope(element);
  if(scope?.getAttribute('aria-busy')==='true'||element.dataset?.busy==='true'){
    return ['جاري تنفيذ عملية أخرى الآن؛ انتظر حتى تنتهي ثم أعد المحاولة.'];
  }

  if(element.dataset?.requiredPermission){
    return [`ليس لديك صلاحية «${element.dataset.requiredPermission}» لتنفيذ هذا الإجراء.`];
  }

  const actionLabel=cleanText(element.textContent||element.getAttribute('aria-label'));
  const formReasons=inferMissingFields(scope,actionLabel);
  const checklistReasons=inferChecklist(scope);
  const inferred=unique([...formReasons,...checklistReasons]);
  if(inferred.length)return inferred;

  return ['هذا الإجراء غير متاح حاليًا، لكن هذه الشاشة لم تربط سبب التعطيل التفصيلي بعد.'];
}

function nextStepForStatus(status){
  if(status===401)return 'سجّل الدخول من جديد ثم أعد تنفيذ العملية.';
  if(status===403)return 'تواصل مع مدير المنشأة لمنح الصلاحية المطلوبة.';
  if(status===409)return 'حدّث الصفحة وراجع حالة السجل قبل إعادة المحاولة.';
  if(status>=500)return 'أعد المحاولة بعد لحظات. إذا تكرر الخطأ، أرسل تفاصيل العملية للدعم.';
  return '';
}

export default function SystemActionFeedback(){
  const [feedback,setFeedback]=useState(null);
  const timerRef=useRef(null);
  const lastRef=useRef({key:'',at:0});

  useEffect(()=>{
    function show(detail){
      const reasons=splitReasons(detail?.reasons||detail?.reason||detail?.message);
      const normalized={
        title:cleanText(detail?.title)||'تعذر تنفيذ الإجراء',
        reasons:reasons.length?reasons:['تعذر تنفيذ العملية لسبب غير محدد.'],
        nextStep:cleanText(detail?.nextStep),
        tone:detail?.tone||'warning'
      };
      const key=`${normalized.title}|${normalized.reasons.join('|')}|${normalized.nextStep}`;
      const now=Date.now();
      if(lastRef.current.key===key&&now-lastRef.current.at<1200)return;
      lastRef.current={key,at:now};
      setFeedback(normalized);
      clearTimeout(timerRef.current);
      timerRef.current=setTimeout(()=>setFeedback(null),AUTO_HIDE_MS);
    }

    function onCustom(event){
      show(event.detail||{});
    }

    function onBlockedPointer(event){
      const target=event.target instanceof Element
        ?event.target.closest('button,input,select,textarea,[role="button"]')
        :null;
      if(!target)return;
      const blocked=target.disabled||target.getAttribute('aria-disabled')==='true';
      if(!blocked)return;
      event.preventDefault();
      event.stopPropagation();
      const reasons=inferBlockedReasons(target);
      show({
        title:cleanText(target.dataset?.blockTitle)||'لماذا الإجراء متوقف؟',
        reasons,
        nextStep:cleanText(target.dataset?.blockNextStep)||'استكمل المتطلبات الموضحة ثم أعد المحاولة.',
        tone:'warning'
      });
    }

    function annotateDisabledControls(){
      document.querySelectorAll('button:disabled,input:disabled,select:disabled,textarea:disabled,[aria-disabled="true"]').forEach(element=>{
        const generated=element.dataset.feedbackTitleGenerated==='true';
        if(element.getAttribute('title')&&!generated)return;
        const reasons=inferBlockedReasons(element);
        element.setAttribute('title',reasons.join(' — '));
        element.dataset.feedbackTitleGenerated='true';
        if(reasons.some(reason=>reason.includes('لم تربط سبب التعطيل'))){
          element.dataset.feedbackAudit='missing-reason';
        }else{
          delete element.dataset.feedbackAudit;
        }
      });
    }

    function scheduleAnnotation(){
      requestAnimationFrame(annotateDisabledControls);
    }

    const observer=new MutationObserver(scheduleAnnotation);
    observer.observe(document.documentElement,{
      subtree:true,
      childList:true,
      attributes:true,
      attributeFilter:['disabled','aria-disabled','data-block-reason','aria-busy']
    });
    annotateDisabledControls();

    const originalFetch=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      try{
        const response=await originalFetch(...args);
        const requestUrl=typeof args[0]==='string'
          ?args[0]
          :args[0]?.url||'';
        if(!response.ok&&requestUrl.includes('/api/')){
          let payload={};
          try{
            payload=await response.clone().json();
          }catch{
            payload={};
          }
          show({
            title:'تعذر تنفيذ العملية',
            reasons:[payload?.error||`أعاد النظام خطأ برمز ${response.status}.`],
            nextStep:payload?.nextStep||nextStepForStatus(response.status),
            tone:'error'
          });
        }
        return response;
      }catch(error){
        show({
          title:'تعذر الاتصال بالنظام',
          reasons:['تعذر الوصول إلى الخادم أو انقطع الاتصال أثناء تنفيذ العملية.'],
          nextStep:'تحقق من اتصال الإنترنت ثم أعد المحاولة.',
          tone:'error'
        });
        throw error;
      }
    };

    window.addEventListener(FEEDBACK_EVENT,onCustom);
    document.addEventListener('pointerdown',onBlockedPointer,true);
    document.addEventListener('input',scheduleAnnotation,true);
    document.addEventListener('change',scheduleAnnotation,true);

    return ()=>{
      clearTimeout(timerRef.current);
      observer.disconnect();
      window.fetch=originalFetch;
      window.removeEventListener(FEEDBACK_EVENT,onCustom);
      document.removeEventListener('pointerdown',onBlockedPointer,true);
      document.removeEventListener('input',scheduleAnnotation,true);
      document.removeEventListener('change',scheduleAnnotation,true);
    };
  },[]);

  if(!feedback)return null;

  return <aside className={`mt-system-feedback ${feedback.tone}`} role="alert" aria-live="assertive">
    <button className="mt-system-feedback-close" onClick={()=>setFeedback(null)} aria-label="إغلاق">×</button>
    <div className="mt-system-feedback-icon">!</div>
    <div className="mt-system-feedback-content">
      <strong>{feedback.title}</strong>
      <ul>{feedback.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
      {feedback.nextStep&&<p><b>الخطوة التالية:</b> {feedback.nextStep}</p>}
    </div>
  </aside>;
}
