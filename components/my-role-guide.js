'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useEffect,useMemo,useRef,useState} from 'react';
import {
  ROLE_GUIDE_VERSION,
  buildPageTour,
  buildWorkspaceTour,
  getPageGuide,
  getRoleGuide,
  hrefForGuide
} from '../lib/role-guide-content';
import styles from './my-role-guide.module.css';

const TABS=[
  {key:'role',label:'دوري'},
  {key:'today',label:'مهام اليوم'},
  {key:'page',label:'هذه الصفحة'},
  {key:'workflows',label:'خطوات العمل'}
];

const EMPTY_PROGRESS={
  status:'not_started',
  currentStep:0,
  checklist:{},
  autoOpen:true,
  completedAt:null,
  lastOpenedAt:null
};

export default function MyRoleGuide({
  slug,
  userName,
  roleKey='member',
  roleLabel='',
  permissions=[],
  platformAccess=false
}){
  const pathname=usePathname();
  const roleGuide=useMemo(
    ()=>getRoleGuide(roleKey,permissions,platformAccess),
    [roleKey,permissions,platformAccess]
  );
  const pageGuide=useMemo(
    ()=>getPageGuide(pathname,slug),
    [pathname,slug]
  );
  const canSearch=platformAccess||permissions.includes('tenant.crm.read');
  const workspaceTour=useMemo(
    ()=>buildWorkspaceTour({roleGuide,pageGuide,canSearch}),
    [roleGuide,pageGuide,canSearch]
  );
  const [snapshot,setSnapshot]=useState(null);
  const [loading,setLoading]=useState(true);
  const [panelOpen,setPanelOpen]=useState(false);
  const [welcomeOpen,setWelcomeOpen]=useState(false);
  const [tab,setTab]=useState('role');
  const [tour,setTour]=useState(null);
  const [tourIndex,setTourIndex]=useState(0);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const autoOpenTimer=useRef(null);

  const progress=snapshot?.progress||EMPTY_PROGRESS;
  const checklist=progress.checklist||{};
  const checklistItems=roleGuide.checklist||[];
  const completedItems=checklistItems.filter(item=>checklist[item.id]).length;
  const remainingItems=Math.max(0,checklistItems.length-completedItems);
  const progressPercent=checklistItems.length
    ?Math.round((completedItems/checklistItems.length)*100)
    :100;

  useEffect(()=>{
    let active=true;
    async function load(){
      setLoading(true);
      try{
        const response=await fetch(
          `/api/role-guide?tenantSlug=${encodeURIComponent(slug)}`
          +`&version=${encodeURIComponent(ROLE_GUIDE_VERSION)}`,
          {cache:'no-store'}
        );
        const result=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(result.error||'تعذر تحميل الدليل');
        if(!active)return;
        const next=result.data||result;
        setSnapshot(next);
        const nextProgress=next?.progress||EMPTY_PROGRESS;
        const shouldAutoOpen=nextProgress.autoOpen!==false
          &&!['completed','dismissed'].includes(nextProgress.status);
        if(shouldAutoOpen){
          autoOpenTimer.current=window.setTimeout(()=>{
            if(active)setWelcomeOpen(true);
          },700);
        }
      }catch{
        if(active)setSnapshot({progress:EMPTY_PROGRESS});
      }finally{
        if(active)setLoading(false);
      }
    }
    load();
    return ()=>{
      active=false;
      if(autoOpenTimer.current)window.clearTimeout(autoOpenTimer.current);
    };
  },[slug]);

  useEffect(()=>{
    if(!panelOpen&&!welcomeOpen&&!tour)return undefined;
    const previous=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const closeOnEscape=event=>{
      if(event.key!=='Escape'||busy)return;
      if(tour)setTour(null);
      else if(welcomeOpen)setWelcomeOpen(false);
      else setPanelOpen(false);
    };
    window.addEventListener('keydown',closeOnEscape);
    return ()=>{
      document.body.style.overflow=previous;
      window.removeEventListener('keydown',closeOnEscape);
    };
  },[panelOpen,welcomeOpen,tour,busy]);

  async function action(actionName,payload={}){
    const response=await fetch('/api/role-guide',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        tenantSlug:slug,
        action:actionName,
        payload,
        version:ROLE_GUIDE_VERSION
      })
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||'تعذر حفظ تقدم الدليل');
    const next=result.data||result;
    setSnapshot(next);
    return next;
  }

  async function openPanel(nextTab='role'){
    setTab(nextTab);
    setWelcomeOpen(false);
    setPanelOpen(true);
    setNotice('');
    action('open').catch(()=>null);
  }

  async function startTour(mode='workspace'){
    const steps=mode==='page'?buildPageTour(pageGuide):workspaceTour;
    setBusy('start');
    setNotice('');
    try{
      await action('start',{currentStep:0,mode});
    }catch{
      // The guide remains usable if progress persistence is temporarily unavailable.
    }finally{
      setBusy('');
      setWelcomeOpen(false);
      setPanelOpen(false);
      setTour({mode,steps});
      setTourIndex(0);
    }
  }

  async function moveTour(direction){
    if(!tour)return;
    const next=tourIndex+direction;
    if(next<0)return;
    if(next>=tour.steps.length){
      setBusy('complete');
      try{
        await action('complete',{currentStep:tour.steps.length});
      }catch{
        // Completion can be retried from the persistent launcher.
      }finally{
        setBusy('');
        setTour(null);
        setTab('today');
        setPanelOpen(true);
        setNotice('اكتملت الجولة. استخدم قائمة اليوم لتثبيت طريقة العمل.');
      }
      return;
    }
    setTourIndex(next);
    action('progress',{currentStep:next,mode:tour.mode}).catch(()=>null);
  }

  async function skipWelcome(){
    setWelcomeOpen(false);
    action('skip').catch(()=>null);
  }

  async function dismissAutomatic(){
    setBusy('dismiss');
    try{
      await action('dismiss');
      setWelcomeOpen(false);
      setNotice('لن يظهر الدليل تلقائيًا، وسيظل زر «وظيفتي» متاحًا دائمًا.');
    }catch(error){
      setNotice(error.message);
    }finally{
      setBusy('');
    }
  }

  async function resetGuide(){
    setBusy('reset');
    try{
      await action('reset');
      setNotice('تمت إعادة الدليل إلى البداية.');
      setPanelOpen(false);
      setWelcomeOpen(true);
    }catch(error){
      setNotice(error.message);
    }finally{
      setBusy('');
    }
  }

  async function toggleChecklist(itemId,checked){
    const previous=checklist;
    setSnapshot(current=>({
      ...(current||{}),
      progress:{
        ...(current?.progress||EMPTY_PROGRESS),
        checklist:{...previous,[itemId]:checked}
      }
    }));
    try{
      await action('checklist',{itemId,checked});
    }catch(error){
      setSnapshot(current=>({
        ...(current||{}),
        progress:{...(current?.progress||EMPTY_PROGRESS),checklist:previous}
      }));
      setNotice(error.message);
    }
  }

  const activeTourStep=tour?.steps?.[tourIndex]||null;

  return <>
    <button
      type="button"
      className={`${styles.launcher} mt-role-guide-launcher ${
        progress.status==='completed'?styles.launcherComplete:styles.launcherActive
      }`}
      onClick={()=>openPanel('role')}
      aria-label="فتح دليل وظيفتي"
      aria-expanded={panelOpen}
    >
      <span className={styles.launcherIcon}><GuideIcon/></span>
      <span className={styles.launcherCopy}>
        <b>وظيفتي</b>
        <small>{loading?'جارٍ التجهيز…':'دليلك الذكي'}</small>
      </span>
      {!loading&&remainingItems>0&&<em>{remainingItems.toLocaleString('ar-SA')}</em>}
    </button>

    {welcomeOpen&&<WelcomeDialog
      userName={userName}
      roleLabel={roleLabel||roleGuide.badge}
      guide={roleGuide}
      busy={busy}
      onStart={()=>startTour('workspace')}
      onSkip={skipWelcome}
      onOpen={()=>openPanel('role')}
      onDismiss={dismissAutomatic}
    />}

    {panelOpen&&<aside
      className={styles.panelLayer}
      role="dialog"
      aria-modal="true"
      aria-labelledby="my-role-guide-title"
    >
      <button
        className={styles.backdrop}
        type="button"
        aria-label="إغلاق دليل وظيفتي"
        onClick={()=>!busy&&setPanelOpen(false)}
      />
      <section className={styles.panel}>
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <span className={styles.brandIcon}><GuideIcon/></span>
            <div>
              <small>MARKTONE ROLE GUIDE</small>
              <h2 id="my-role-guide-title">وظيفتي</h2>
              <p>{roleLabel||roleGuide.badge}</p>
            </div>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={()=>!busy&&setPanelOpen(false)}
            aria-label="إغلاق"
          >×</button>
        </header>

        <div className={styles.progressCard}>
          <div
            className={styles.progressRing}
            style={{'--guide-progress':`${progressPercent*3.6}deg`}}
          >
            <span>{progressPercent.toLocaleString('ar-SA')}٪</span>
          </div>
          <div>
            <small>تقدم مهام اليوم</small>
            <b>{completedItems.toLocaleString('ar-SA')} من {checklistItems.length.toLocaleString('ar-SA')}</b>
            <p>{roleGuide.outcome}</p>
          </div>
        </div>

        <nav className={styles.tabs} aria-label="أقسام دليل وظيفتي">
          {TABS.map(item=><button
            key={item.key}
            type="button"
            className={tab===item.key?styles.activeTab:''}
            onClick={()=>setTab(item.key)}
          >{item.label}</button>)}
        </nav>

        <div className={styles.panelBody}>
          {notice&&<div className={styles.notice} role="status">{notice}</div>}

          {tab==='role'&&<RoleOverview
            guide={roleGuide}
            status={progress.status}
            onStart={()=>startTour('workspace')}
            onReset={resetGuide}
            busy={busy}
          />}

          {tab==='today'&&<DailyChecklist
            slug={slug}
            items={checklistItems}
            checklist={checklist}
            completed={completedItems}
            onToggle={toggleChecklist}
          />}

          {tab==='page'&&<PageGuide
            guide={pageGuide}
            onStart={()=>startTour('page')}
            busy={busy}
          />}

          {tab==='workflows'&&<WorkflowList
            slug={slug}
            workflows={roleGuide.workflows||[]}
          />}
        </div>

        <footer className={styles.panelFooter}>
          <button type="button" onClick={()=>setPanelOpen(false)}>إغلاق</button>
          <small>يتم حفظ تقدمك تلقائيًا داخل حسابك.</small>
        </footer>
      </section>
    </aside>}

    {tour&&activeTourStep&&<TourOverlay
      step={activeTourStep}
      index={tourIndex}
      total={tour.steps.length}
      busy={busy}
      onPrevious={()=>moveTour(-1)}
      onNext={()=>moveTour(1)}
      onSkip={()=>{
        setTour(null);
        action('skip',{currentStep:tourIndex,mode:tour.mode}).catch(()=>null);
      }}
    />}
  </>;
}

function WelcomeDialog({
  userName,
  roleLabel,
  guide,
  busy,
  onStart,
  onSkip,
  onOpen,
  onDismiss
}){
  return <div className={styles.welcomeLayer} role="dialog" aria-modal="true">
    <div className={styles.welcomeBackdrop}/>
    <section className={styles.welcomeCard}>
      <div className={styles.welcomeVisual}>
        <span className={styles.welcomeOrbit}/>
        <span className={styles.welcomeIcon}><GuideIcon/></span>
        <small>دليل تفاعلي حسب دورك</small>
      </div>
      <div className={styles.welcomeContent}>
        <span className={styles.roleBadge}>{roleLabel}</span>
        <h2>مرحبًا {firstName(userName)} 👋</h2>
        <h3>{guide.headline}</h3>
        <p>{guide.summary}</p>
        <div className={styles.welcomePoints}>
          <span><i>1</i>نتعرف على شاشاتك</span>
          <span><i>2</i>نشرح خطوات عملك</span>
          <span><i>3</i>نرتب مهام يومك</span>
        </div>
        <div className={styles.welcomeActions}>
          <button type="button" className={styles.primary} onClick={onStart} disabled={Boolean(busy)}>
            {busy==='start'?'جارٍ بدء الجولة…':'ابدأ الجولة التفاعلية'}
          </button>
          <button type="button" className={styles.secondary} onClick={onOpen}>افتح الدليل</button>
          <button type="button" className={styles.textButton} onClick={onSkip}>تخطي الآن</button>
        </div>
        <button
          type="button"
          className={styles.dismissButton}
          onClick={onDismiss}
          disabled={busy==='dismiss'}
        >{busy==='dismiss'?'جارٍ الحفظ…':'لا تظهر الجولة تلقائيًا مرة أخرى'}</button>
      </div>
    </section>
  </div>;
}

function RoleOverview({guide,status,onStart,onReset,busy}){
  return <div className={styles.sectionStack}>
    <section className={styles.heroSection}>
      <span>{guide.badge}</span>
      <h3>{guide.headline}</h3>
      <p>{guide.summary}</p>
      <button type="button" className={styles.primary} onClick={onStart} disabled={busy==='start'}>
        {status==='completed'?'إعادة الجولة التفاعلية':'ابدأ الجولة التفاعلية'}
      </button>
    </section>
    <section>
      <div className={styles.sectionTitle}>
        <div><small>مسؤولياتك الأساسية</small><h3>ما الذي يجب أن تضمنه؟</h3></div>
      </div>
      <div className={styles.responsibilityGrid}>
        {(guide.responsibilities||[]).map((item,index)=><article key={item}>
          <span>{(index+1).toLocaleString('ar-SA')}</span>
          <p>{item}</p>
        </article>)}
      </div>
    </section>
    <div className={styles.goldenCard}>
      <span>النتيجة المطلوبة</span>
      <b>{guide.outcome}</b>
    </div>
    <button type="button" className={styles.resetButton} onClick={onReset} disabled={busy==='reset'}>
      {busy==='reset'?'جارٍ إعادة الضبط…':'إعادة الدليل من البداية'}
    </button>
  </div>;
}

function DailyChecklist({slug,items,checklist,completed,onToggle}){
  return <div className={styles.sectionStack}>
    <section className={styles.checklistIntro}>
      <div>
        <small>قائمة تتجدد يوميًا</small>
        <h3>أغلق يومك دون نقاط معلقة</h3>
        <p>ضع علامة بعد التنفيذ الفعلي. تحفظ القائمة على حسابك وتبدأ من جديد في يوم العمل التالي.</p>
      </div>
      <strong>{completed.toLocaleString('ar-SA')}/{items.length.toLocaleString('ar-SA')}</strong>
    </section>
    <div className={styles.checklist}>
      {items.map(item=>{
        const checked=Boolean(checklist[item.id]);
        return <label key={item.id} className={checked?styles.checkedItem:''}>
          <input
            type="checkbox"
            checked={checked}
            onChange={event=>onToggle(item.id,event.target.checked)}
          />
          <span className={styles.checkmark}>✓</span>
          <span className={styles.checkCopy}>
            <b>{item.title}</b>
            <small>{item.description}</small>
            {item.href&&<Link href={hrefForGuide(slug,item.href)}>فتح الشاشة ←</Link>}
          </span>
        </label>;
      })}
    </div>
  </div>;
}

function PageGuide({guide,onStart,busy}){
  return <div className={styles.sectionStack}>
    <section className={styles.pageHero}>
      <small>{guide.eyebrow}</small>
      <h3>{guide.title}</h3>
      <p>{guide.description}</p>
      <button type="button" className={styles.primary} onClick={onStart} disabled={busy==='start'}>
        اشرح لي هذه الصفحة
      </button>
    </section>
    <section>
      <div className={styles.sectionTitle}>
        <div><small>المسار الصحيح</small><h3>كيف تستخدم هذه الشاشة؟</h3></div>
      </div>
      <ol className={styles.stepsList}>
        {(guide.steps||[]).map(item=><li key={item}><span>✓</span><p>{item}</p></li>)}
      </ol>
    </section>
    <div className={styles.goldenCard}>
      <span>القاعدة الذهبية</span>
      <b>{guide.goldenRule}</b>
    </div>
  </div>;
}

function WorkflowList({slug,workflows}){
  if(!workflows.length)return <div className={styles.emptyState}>
    <span><GuideIcon/></span>
    <h3>لا توجد إجراءات إضافية لهذا الدور</h3>
    <p>استخدم تبويب «هذه الصفحة» للحصول على شرح مباشر للشاشة الحالية.</p>
  </div>;
  return <div className={styles.sectionStack}>
    <section className={styles.workflowIntro}>
      <small>إجراءات خطوة بخطوة</small>
      <h3>اختر المهمة التي تريد تنفيذها</h3>
      <p>كل مسار يوضح نقطة البداية، ترتيب الخطوات، والنتيجة التي يجب التحقق منها.</p>
    </section>
    <div className={styles.workflows}>
      {workflows.map((workflow,index)=><details key={workflow.id}>
        <summary>
          <span>{(index+1).toLocaleString('ar-SA')}</span>
          <div><b>{workflow.title}</b><small>{workflow.description}</small></div>
          <i>⌄</i>
        </summary>
        <div className={styles.workflowBody}>
          <ol>{workflow.steps.map(step=><li key={step}>{step}</li>)}</ol>
          {workflow.tip&&<p className={styles.workflowTip}><b>نصيحة ماركتون:</b> {workflow.tip}</p>}
          {workflow.href&&<Link href={hrefForGuide(slug,workflow.href)}>ابدأ التنفيذ في الشاشة ←</Link>}
        </div>
      </details>)}
    </div>
  </div>;
}

function TourOverlay({step,index,total,busy,onPrevious,onNext,onSkip}){
  const [rect,setRect]=useState(null);

  useEffect(()=>{
    let frame;
    let target;
    function update(){
      target=document.querySelector(step.selector);
      if(target){
        const next=target.getBoundingClientRect();
        if(next.width>0&&next.height>0){
          setRect({
            top:next.top,
            left:next.left,
            right:next.right,
            bottom:next.bottom,
            width:next.width,
            height:next.height
          });
          return;
        }
      }
      setRect(null);
    }
    target=document.querySelector(step.selector);
    target?.scrollIntoView?.({behavior:'smooth',block:'center',inline:'nearest'});
    frame=window.requestAnimationFrame(update);
    const delayed=window.setTimeout(update,350);
    window.addEventListener('resize',update);
    window.addEventListener('scroll',update,true);
    return ()=>{
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayed);
      window.removeEventListener('resize',update);
      window.removeEventListener('scroll',update,true);
    };
  },[step]);

  const tooltipPosition=positionTooltip(rect);
  return <div className={styles.tourLayer} role="dialog" aria-modal="true" aria-live="polite">
    {rect?<>
      <div className={styles.scrim} style={{top:0,left:0,right:0,height:Math.max(0,rect.top-10)}}/>
      <div className={styles.scrim} style={{top:Math.max(0,rect.top-10),left:0,width:Math.max(0,rect.left-10),height:rect.height+20}}/>
      <div className={styles.scrim} style={{top:Math.max(0,rect.top-10),left:rect.right+10,right:0,height:rect.height+20}}/>
      <div className={styles.scrim} style={{top:rect.bottom+10,left:0,right:0,bottom:0}}/>
      <div className={styles.spotlight} style={{top:rect.top-7,left:rect.left-7,width:rect.width+14,height:rect.height+14}}/>
    </>:<div className={`${styles.scrim} ${styles.fullScrim}`}/>} 
    <section className={styles.tourCard} style={tooltipPosition}>
      <header>
        <span>{(index+1).toLocaleString('ar-SA')} / {total.toLocaleString('ar-SA')}</span>
        <button type="button" onClick={onSkip}>تخطي</button>
      </header>
      <div className={styles.tourProgress}><i style={{width:`${((index+1)/total)*100}%`}}/></div>
      <h2>{step.title}</h2>
      <p>{step.body}</p>
      <footer>
        <button type="button" className={styles.secondary} onClick={onPrevious} disabled={index===0||Boolean(busy)}>السابق</button>
        <button type="button" className={styles.primary} onClick={onNext} disabled={Boolean(busy)}>
          {index===total-1?'إنهاء الجولة':'التالي'}
        </button>
      </footer>
    </section>
  </div>;
}

function positionTooltip(rect){
  if(typeof window==='undefined')return {};
  const width=Math.min(380,window.innerWidth-32);
  if(!rect){
    return {
      top:Math.max(16,(window.innerHeight-270)/2),
      left:Math.max(16,(window.innerWidth-width)/2),
      width
    };
  }
  const left=Math.max(16,Math.min(rect.left,window.innerWidth-width-16));
  const below=rect.bottom+18;
  const top=below+260<window.innerHeight
    ?below
    :Math.max(16,rect.top-280);
  return {top,left,width};
}

function firstName(name){
  return String(name||'بك').trim().split(/\s+/)[0]||'بك';
}

function GuideIcon(){
  return <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M7 5.5h7.2c1.1 0 1.8.5 1.8 1.5v19c0-1.6-1.2-2.5-3-2.5H7V5.5Z"/>
    <path d="M25 5.5h-7.2c-1.1 0-1.8.5-1.8 1.5v19c0-1.6 1.2-2.5 3-2.5h6V5.5Z"/>
    <path d="m10 12 1.6 1.6L14.8 10"/>
    <path d="M19 11h3M19 15h3M10 18h4"/>
  </svg>;
}
