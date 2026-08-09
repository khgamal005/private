'use client';

import {createContext,useCallback,useContext,useEffect,useId,useRef,useState} from 'react';
import styles from './template-import-mode-provider.module.css';

const TemplateImportModeContext=createContext(null);

export function TemplateImportModeProvider({children}){
  const [request,setRequest]=useState(null);
  const resolverRef=useRef(null);
  const titleId=useId();
  const descriptionId=useId();

  const chooseMode=useCallback(details=>new Promise(resolve=>{
    resolverRef.current?.(null);
    resolverRef.current=resolve;
    setRequest(normalizeDetails(details));
  }),[]);

  const finish=useCallback(mode=>{
    const resolve=resolverRef.current;
    resolverRef.current=null;
    setRequest(null);
    resolve?.(mode);
  },[]);

  useEffect(()=>()=>{
    resolverRef.current?.(null);
    resolverRef.current=null;
  },[]);

  useEffect(()=>{
    if(!request)return undefined;
    const previous=document.activeElement;
    const keydown=event=>{
      if(event.key==='Escape')finish(null);
    };
    window.addEventListener('keydown',keydown);
    return()=>{
      window.removeEventListener('keydown',keydown);
      previous?.focus?.();
    };
  },[finish,request]);

  return <TemplateImportModeContext.Provider value={chooseMode}>
    {children}
    {request&&<div className={styles.layer} role="presentation">
      <button type="button" className={styles.backdrop} aria-label="إلغاء إدراج القالب" onClick={()=>finish(null)}/>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} dir="rtl">
        <header className={styles.header}>
          <div className={styles.identity}>
            <span>ZIP</span>
            <div>
              <small>Marktone Native Template Engine</small>
              <h2 id={titleId}>كيف تريد إدراج القالب؟</h2>
            </div>
          </div>
          <button type="button" className={styles.close} onClick={()=>finish(null)} aria-label="إغلاق">×</button>
        </header>

        <div className={styles.summary} id={descriptionId}>
          <strong>{request.title}</strong>
          <span>{request.pendingAnalysis?'سيتم تحليل أقسام القالب بعد اختيار طريقة الإدراج':`${request.sectionCount} قسمًا أصليًا · ${request.fileCount} ملفًا`}</span>
          <p>سيُعرض HTML وCSS بعرض الصفحة داخل Shadow DOM، من دون iframe أو عمود وسيط.</p>
          {request.scriptCount>0&&<em>سيتم تعطيل {request.scriptCount} ملف JavaScript لحماية جلسة ماركتون.</em>}
        </div>

        <div className={styles.choices}>
          <button type="button" className={styles.appendChoice} onClick={()=>finish('append')} autoFocus>
            <span className={styles.choiceIcon}>＋</span>
            <div>
              <b>إضافة إلى التصميم الحالي</b>
              <p>يُضاف القالب بعد القسم المحدد مع الاحتفاظ بكل أقسام المسودة الحالية.</p>
              <small>مناسب لإضافة صفحة أو مجموعة بلوكات جديدة.</small>
            </div>
            <i>إضافة</i>
          </button>

          <button type="button" className={styles.replaceChoice} onClick={()=>finish('replace')}>
            <span className={styles.choiceIcon}>↻</span>
            <div>
              <b>استبدال التصميم بالكامل</b>
              <p>تُستبدل أقسام المسودة الحالية بأقسام القالب، مع بقاء التراجع وسجل الإصدارات متاحين.</p>
              <small>لن يتم النشر تلقائيًا.</small>
            </div>
            <i>استبدال</i>
          </button>
        </div>

        <footer className={styles.footer}>
          <span>يمكنك التراجع عن العملية قبل الحفظ أو النشر.</span>
          <button type="button" onClick={()=>finish(null)}>إلغاء</button>
        </footer>
      </section>
    </div>}
  </TemplateImportModeContext.Provider>;
}

export function useTemplateImportMode(){
  const choose=useContext(TemplateImportModeContext);
  return choose||fallbackChoice;
}

function normalizeDetails(value={}){
  return {
    title:String(value.title||'قالب ZIP مستورد').slice(0,140),
    sectionCount:clamp(value.sectionCount,1,60,1),
    fileCount:clamp(value.fileCount,0,250,0),
    scriptCount:clamp(value.scriptCount,0,250,0),
    pendingAnalysis:Boolean(value.pendingAnalysis)
  };
}

async function fallbackChoice(details){
  if(typeof window==='undefined')return null;
  const title=String(details?.title||'القالب');
  if(window.confirm(`إضافة ${title} إلى التصميم الحالي؟`))return 'append';
  return window.confirm('هل تريد استبدال التصميم الحالي بالكامل بهذا القالب؟')?'replace':null;
}

function clamp(value,min,max,fallback){
  const number=Number(value);
  return Number.isFinite(number)?Math.min(Math.max(Math.round(number),min),max):fallback;
}
