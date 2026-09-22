'use client';

import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import AcademyIcon from './academy-icon';
import {
  AUTHORING_LEVELS, AUTHORING_MODES, AUTHORING_UNIT_KINDS,
  authoringErrorMessage, authoringPublishIssues,
} from '../lib/academy-authoring.mjs';
import styles from './academy-authoring.module.css';

const clone = value => structuredClone(value);
const moved = (items, index, delta) => {
  const next = [...items], target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};
const uuid = () => crypto.randomUUID();
const safeDate = value => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('ar-SA', {dateStyle:'medium'}).format(new Date(value)) : '';
const courseTitle = course => course.draftTitle || course.title;
const coursePublished = course => Boolean(course.publishedVersionId);
const hasPublishedChanges = course => Boolean(course.publishedVersionId && course.publishedRevision != null && (course.authoringRevision ?? course.revision) > course.publishedRevision);
const countUnits = document => document.topics.reduce((count, topic) => count + topic.units.length, 0);
const reordered = (items, source, target, identity=item=>item.id) => {
  const from=items.findIndex(item=>identity(item)===source), to=items.findIndex(item=>identity(item)===target);
  if(from<0||to<0||from===to)return items;
  const next=[...items], [item]=next.splice(from,1);next.splice(to,0,item);return next;
};

function Field({label, hint, children, full=false}) {
  return <label className={`${styles.field} ${full ? styles.full : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Button({children, kind='secondary', ...props}) {
  return <button type="button" className={styles[kind]} {...props}>{children}</button>;
}
function Sparkles() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4M18 4h4"/></svg>;
}
function Status({published, changed=false}) {
  return <span className={`${styles.badge} ${published ? styles.published : styles.draft}`}>{published ? changed ? 'منشور · تعديلات في المسودة' : 'منشور' : 'مسودة'}</span>;
}
function DragHandle({label,onDragStart,onDragEnd}) {
  return <button type="button" className={styles.dragHandle} draggable aria-label={label} title={label} onDragStart={onDragStart} onDragEnd={onDragEnd}><svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">{[4,10,16].flatMap(y=>[5,11].map(x=><circle key={`${x}-${y}`} cx={x} cy={y} r="1.4"/>))}</svg></button>;
}
function Dialog({title, description, onClose, busy, error, children}) {
  const ref = useRef(null), latest = useRef({onClose,busy});
  useEffect(() => {latest.current={onClose,busy};}, [onClose,busy]);
  useEffect(() => {
    const previous = document.activeElement, modal = ref.current;
    modal?.querySelector('input,textarea,select,button')?.focus();
    function keydown(event) {
      if (event.key === 'Escape' && !latest.current.busy) latest.current.onClose();
      if (event.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    }
    modal?.addEventListener('keydown', keydown);
    return () => {modal?.removeEventListener('keydown', keydown); previous?.focus?.();};
  }, []);
  return <div className={styles.overlay}><section ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
    <div className={styles.dialogHead}><div><h2>{title}</h2>{description && <p>{description}</p>}</div><Button kind="iconButton" onClick={onClose} disabled={busy} aria-label="إغلاق النافذة"><AcademyIcon name="close" size={18}/></Button></div>{error&&<p className={styles.error} role="alert">{error}</p>}{children}
  </section></div>;
}

export default function AcademyAuthoringWorkspace({slug, initialData, initialView='courses'}) {
  const router = useRouter();
  const [fetched, setFetched] = useState(null), data = fetched?.base === initialData ? fetched.data : initialData;
  const [view, setView] = useState(initialView), [query, setQuery] = useState(''), [status, setStatus] = useState('all');
  const [editor, setEditor] = useState(null), [step, setStep] = useState('basics'), [openUnit, setOpenUnit] = useState(null);
  const [modal, setModal] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [extraCourses, setExtraCourses] = useState([]), [pickerOffset, setPickerOffset] = useState(0), [pickerMore, setPickerMore] = useState(true);
  const active = useRef(false), requests = useRef(new Map()), createdCourse = useRef(null);
  const dirty = Boolean(editor && JSON.stringify(editor.document) !== JSON.stringify(editor.saved));
  const available = data?.available === true;

  useEffect(() => {
    if (!dirty) return;
    const warn = event => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function request(action, payload, mutation=false) {
    const signature = JSON.stringify([action,payload]);
    let commandId = requests.current.get(signature);
    if (mutation && !commandId) {commandId = uuid(); requests.current.set(signature, commandId);}
    const response = await fetch(`/api/academy-authoring/${action}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tenantSlug:slug, ...(mutation ? {commandId} : {}), payload})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.code ? authoringErrorMessage(result.code) : typeof result.error === 'string' && /^[\u0600-\u06ff]/.test(result.error) ? result.error : authoringErrorMessage('request_failed'));
    const value = result.data ?? result;
    if (value.tenant?.slug && value.tenant.slug !== slug) throw new Error('تعذر التحقق من بيانات المنشأة. أعد تحميل الصفحة.');
    if (mutation) requests.current.delete(signature);
    return value;
  }
  async function run(operation) {
    if (active.current) return null;
    active.current = true; setBusy(true); setError(''); setNotice('');
    try {return await operation();}
    catch (failure) {setError(failure instanceof Error && /^[\u0600-\u06ff]/.test(failure.message) ? failure.message : 'تعذر الاتصال. لم نفقد تعديلاتك؛ حاول مرة أخرى.'); return null;}
    finally {active.current = false; setBusy(false);}
  }
  function applySnapshot(next) {setFetched({base:initialData, data:next});}
  function editRecord(kind, record) {
    if (!record?.document) throw new Error('تعذر تحميل تفاصيل المسودة. حاول فتحها مرة أخرى.');
    setEditor({kind, record, document:clone(record.document), saved:clone(record.document)});
    setStep('basics'); setOpenUnit(null);
  }
  async function focus(kind, id, nextStep='basics') {
    return run(async () => {
      const next = await request('snapshot', {[kind === 'course' ? 'courseId' : 'pathId']:id});
      applySnapshot(next); editRecord(kind, next[kind]); setStep(nextStep);
      if (kind === 'path') {setExtraCourses(next.path?.courses || []); setPickerOffset(0); setPickerMore(true);}
      return next[kind];
    });
  }
  function changeDocument(document) {setEditor(current => ({...current, document}));}
  function patchDocument(patch) {setEditor(current => ({...current, document:{...current.document, ...patch}}));}
  async function saveDocument(document=editor?.document) {
    if (!editor || !document) return null;
    if (document.title.trim().length < 2) {setError(editor.kind === 'course' ? 'أدخل عنوانًا واضحًا للدورة قبل حفظ المسودة.' : 'أدخل عنوانًا واضحًا للمسار قبل حفظه.');return null;}
    return run(async () => {
      const kind = editor.kind, key = kind === 'course' ? 'courseId' : 'pathId';
      const result = await request(`save_${kind}`, {[key]:editor.record[key] || null, expectedRevision:editor.record.revision || 0, document}, true);
      const id = result[key] || editor.record[key];
      // Keep the confirmed revision even if the follow-up read loses connection.
      setEditor(current => ({...current, document:clone(document), saved:clone(document), record:{...current.record, [key]:id, revision:result.revision ?? current.record.revision}}));
      const next = await request('snapshot', {[key]:id});
      applySnapshot(next);
      const record = next[kind];
      if (record?.document) setEditor({kind,record,document:clone(record.document),saved:clone(record.document)});
      setNotice('حُفظت المسودة. يمكنك العودة إليها في أي وقت.');
      return result;
    });
  }
  async function publish() {
    if (!editor || dirty) return;
    const result = await run(async () => {
      const kind = editor.kind, key = kind === 'course' ? 'courseId' : 'pathId';
      await request(`publish_${kind}`, {[key]:editor.record[key], expectedRevision:editor.record.revision, humanReviewed:true}, true);
      const next = await request('snapshot', {[key]:editor.record[key]});
      applySnapshot(next); editRecord(kind, next[kind]); setStep('review');
      setNotice(kind === 'course' ? 'نُشر محتوى الدورة بنجاح. تظل تسجيلات المتدربين الحالية مرتبطة بنسختها المعتمدة.' : 'نُشر المسار بنجاح. يظل الوصول إلى كل دورة حسب تسجيل المتدرب فيها.');
      router.refresh(); return true;
    });
    if (result) setModal(null);
  }
  async function loadList(offset=0, nextQuery=query) {
    return run(async () => {
      const next = await request('snapshot', {query:nextQuery, ...(view === 'paths' ? {pathOffset:offset} : {offset})});
      applySnapshot(next); return next;
    });
  }
  function leaveEditor() {
    if (dirty) {setModal({kind:'discard'}); return;}
    setEditor(null); setNotice(''); setError(''); void loadList(0, ''); setQuery('');
  }
  async function createCourse(title, useAi) {
    if(title.trim().length<2){setError('اكتب عنوانًا من حرفين على الأقل.');return;}
    const created = await run(async () => {
      const result = createdCourse.current?.title===title ? createdCourse.current.result : await request('create_course', {title,category:'تدريب عام'}, true);
      createdCourse.current={title,result};
      const next = await request('snapshot', {courseId:result.courseId});
      applySnapshot(next); editRecord('course', next.course);
      createdCourse.current=null;
      setNotice('أُنشئت مسودة الدورة. ابدأ بالأساسيات ثم أضف المنهاج.'); return true;
    });
    if (created) setModal(useAi ? {kind:'ai',unitId:null} : null);
  }
  function newPath() {
    const document = {title:'',description:'',courseIds:[]};
    setEditor({kind:'path',record:{pathId:null,revision:0},document,saved:clone(document)});
    setExtraCourses([]); setPickerOffset(0); setPickerMore(true); setError(''); setNotice('');
  }
  async function moreCourses() {
    return run(async () => {
      const next = await request('snapshot', {offset:pickerOffset,query:''});
      setExtraCourses(current => [...new Map([...current,...(next.courses || [])].map(course => [course.id,course])).values()]);
      setPickerOffset(pickerOffset + 50); setPickerMore(Boolean(next.hasMore?.courses));
      return true;
    });
  }
  const courses = [...new Map([...(data?.courses || []),...extraCourses].map(course => [course.id,course])).values()];
  const list = (view === 'paths' ? data?.paths : data?.courses) || [];
  const filtered = list.filter(item => status === 'all' || (view === 'paths' ? Boolean(item.publishedRevision) : coursePublished(item)) === (status === 'published'));
  const issues = editor?.kind === 'course' ? authoringPublishIssues(editor.document) : [];

  if (!available) return <div className={styles.workspace} dir="rtl"><section className={styles.panel}><h1>إنشاء الدورات والمسارات</h1><p className={styles.muted}>يجري تجهيز أدوات التأليف لمنشأتك. المحتوى الحالي والتسجيلات محفوظة.</p></section></div>;

  return <div className={styles.workspace} dir="rtl" aria-busy={busy}>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!editor ? <>
      <header className={styles.heading}><div><span className={styles.eyebrow}>من الفكرة إلى تجربة تعلّم</span><h1>{view === 'paths' ? 'المسارات التدريبية' : 'الدورات والمناهج'}</h1><p>{view === 'paths' ? 'اجمع الدورات في رحلة واضحة، ورتّب الخطوات التي توصي بها للمتدرب.' : 'أنشئ دورتك خطوة بخطوة، ورتّب محتواها، وراجعها قبل النشر.'}</p></div><div className={styles.actions}>{view === 'courses' && <Button kind="aiButton" disabled={busy} onClick={() => setModal({kind:'create',ai:true})}><Sparkles/>إنشاء بالذكاء الاصطناعي</Button>}<Button kind="primary" disabled={busy} onClick={() => view === 'paths' ? newPath() : setModal({kind:'create'})}>+ {view === 'paths' ? 'مسار جديد' : 'دورة جديدة'}</Button></div></header>
      <nav className={styles.tabs} aria-label="أدوات إنشاء التدريب">{[['courses','الدورات'],['paths','المسارات']].map(([key,label]) => <button type="button" key={key} aria-current={view === key ? 'page' : undefined} disabled={busy} onClick={() => {setView(key);setStatus('all');setQuery('');void run(async()=>applySnapshot(await request('snapshot',{query:'',offset:0,pathOffset:0})));}}>{label}</button>)}</nav>
      <form className={styles.toolbar} onSubmit={event => {event.preventDefault();void loadList(0);}}><label className={styles.search}><span className={styles.srOnly}>البحث بالعنوان</span><input type="search" placeholder={view === 'paths' ? 'ابحث عن مسار...' : 'ابحث عن دورة...'} value={query} maxLength={100} onChange={event => setQuery(event.target.value)}/></label><Button disabled={busy} onClick={() => loadList(0)}>بحث</Button><select aria-label="تصفية حالة النشر" value={status} onChange={event => setStatus(event.target.value)}><option value="all">كل الحالات</option><option value="published">منشور</option><option value="draft">مسودة</option></select></form>
      {filtered.length ? <div className={styles.cards}>{filtered.map(item => <article className={styles.courseCard} key={item.id || item.pathId}>
        <div className={styles.row}><span className={styles.courseMark}><AcademyIcon name={view === 'paths' ? 'tasks' : 'courses'} size={23}/></span><Status published={view === 'paths' ? Boolean(item.publishedRevision) : coursePublished(item)} changed={view === 'paths' ? item.publishedRevision && item.revision !== item.publishedRevision : hasPublishedChanges(item)}/></div>
        <h2>{view === 'paths' ? item.title : courseTitle(item)}</h2>
        <div className={styles.meta}><span>{view === 'paths' ? `${item.courseCount || 0} دورات` : 'دورة تدريبية'}</span>{item.updatedAt && <span>تحديث {safeDate(item.updatedAt)}</span>}</div>
        <div className={styles.courseFoot}><Button kind="primary" disabled={busy} onClick={() => focus(view === 'paths' ? 'path' : 'course',item.id || item.pathId)}>{view === 'paths' ? 'ترتيب المسار' : 'تعديل الدورة'}</Button><Button disabled={busy} onClick={() => focus(view === 'paths' ? 'path' : 'course',item.id || item.pathId,'review')}>مراجعة ونشر</Button></div>
      </article>)}</div> : <section className={styles.empty}><AcademyIcon name={view === 'paths' ? 'tasks' : 'courses'} size={38}/><h2>{query || status !== 'all' ? 'لا توجد نتائج مطابقة' : view === 'paths' ? 'كل رحلة تبدأ بخطوة' : 'ابدأ بأول دورة'}</h2><p>{query || status !== 'all' ? 'جرّب عنوانًا آخر أو اعرض كل حالات النشر.' : view === 'paths' ? 'اختر الدورات الموجودة ورتّبها في مسار تدريبي واحد.' : 'ابدأ بعنوان فقط. يمكنك إكمال التفاصيل والمحتوى تدريجيًا وحفظها كمسودة.'}</p>{!query && status === 'all' && <Button kind="primary" disabled={busy} onClick={() => view === 'paths' ? newPath() : setModal({kind:'create'})}>{view === 'paths' ? 'إنشاء أول مسار' : 'إنشاء أول دورة'}</Button>}</section>}
      {((view === 'paths' ? data.pathOffset : data.offset) > 0 || data.hasMore?.[view]) && <nav className={styles.pagination} aria-label="صفحات النتائج"><Button disabled={busy || !(view === 'paths' ? data.pathOffset : data.offset)} onClick={() => loadList(Math.max(0,(view === 'paths' ? data.pathOffset : data.offset) - 50))}>السابق</Button><Button disabled={busy || !data.hasMore?.[view]} onClick={() => loadList((view === 'paths' ? data.pathOffset || 0 : data.offset || 0) + 50)}>التالي</Button></nav>}
    </> : <>
      <header className={styles.editorHeader}><div><Button kind="quiet" onClick={leaveEditor} disabled={busy}>← العودة إلى {editor.kind === 'course' ? 'الدورات' : 'المسارات'}</Button><h1>{editor.document.title || (editor.kind === 'course' ? 'دورة جديدة' : 'مسار جديد')}</h1><span className={styles.saveState} role="status">{busy ? 'جارٍ تنفيذ العملية...' : dirty ? 'تعديلات لم تُحفظ بعد' : editor.record.revision ? 'كل التعديلات محفوظة' : 'مسودة جديدة'}</span></div><div className={styles.actions}><Status published={editor.kind === 'course' ? Boolean(editor.record.publishedVersionId) : Boolean(editor.record.publishedRevision)} changed={dirty || (editor.kind === 'path' ? editor.record.publishedRevision !== editor.record.revision : hasPublishedChanges(editor.record))}/>{editor.kind === 'course' && <Button disabled={busy} onClick={() => setModal({kind:'preview'})}><AcademyIcon name="eye" size={17}/>معاينة</Button>}<Button disabled={busy} onClick={() => saveDocument()}>حفظ المسودة</Button></div></header>
      {editor.record.externallyUpdated && <p className={styles.hint} role="status">يوجد إصدار أحدث نُشر من محرر آخر. راجع النسخة الحالية قبل حفظ تغييراتك أو نشرها.</p>}
      {editor.kind === 'course' ? <>
        <nav className={styles.steps} aria-label="خطوات إنشاء الدورة">{[['basics','الأساسيات','عرّف المتدرب بالدورة'],['curriculum','المنهاج','رتّب الأقسام والمحتوى'],['review','المراجعة والنشر','تأكد من جاهزية الدورة']].map(([key,title,hint],index) => <button type="button" key={key} disabled={busy} aria-current={step === key ? 'step' : undefined} onClick={() => setStep(key)}><b>{index + 1}</b><span><strong>{title}</strong><small>{hint}</small></span></button>)}</nav>
        <fieldset className={styles.editorFieldset} disabled={busy}><div className={styles.editorGrid}><div className={styles.stack}>
          {step === 'basics' && <CourseBasics document={editor.document} patch={patchDocument}/>}
          {step === 'curriculum' && <Curriculum document={editor.document} change={changeDocument} openUnit={openUnit} setOpenUnit={setOpenUnit} onAi={unitId => setModal({kind:'ai',unitId})} onRemove={(topicId,unitId) => setModal({kind:'remove',topicId,unitId})}/>}
          {step === 'review' && <CourseReview document={editor.document} issues={issues} patch={patchDocument} goTo={issue => {setStep(issue.step);setOpenUnit(issue.unitId || null);}}/>}
        </div><aside className={styles.guide}><h3>{step === 'basics' ? 'دورة واضحة من البداية' : step === 'curriculum' ? 'محتوى سهل المتابعة' : 'خطوة أخيرة قبل النشر'}</h3><p>{step === 'basics' ? 'عنوان محدد ووصف بسيط يساعدان المتدرب على فهم ما سيتعلمه.' : step === 'curriculum' ? 'قسّم المنهاج إلى أقسام قصيرة. أضف درسًا أو نشاطًا لكل خطوة، ثم رتّبها كما سيراها المتدرب.' : 'راجع المحتوى وسياسة الاجتياز. نشر التعديلات ينشئ نسخة جديدة للتسجيلات المقبلة.'}</p><ol><li>ابدأ بما يحتاجه المتدرب.</li><li>اجعل لكل درس هدفًا واحدًا.</li><li>احفظ مسودتك أثناء العمل.</li></ol><Button kind="aiButton" onClick={() => setModal({kind:'ai',unitId:null})}><Sparkles/>{editor.document.aiBrief?.goal ? 'طلب الإنشاء بالذكاء الاصطناعي' : 'مساعدة الذكاء الاصطناعي'}</Button>{editor.document.aiBrief?.goal && <span className={styles.inlineBrief}>يوجد وصف محفوظ لطلب الإنشاء</span>}</aside></div></fieldset>
        <footer className={styles.editorFooter}><Button disabled={busy || step === 'basics'} onClick={() => setStep(step === 'review' ? 'curriculum' : 'basics')}>السابق</Button><div className={styles.actions}><Button disabled={busy} onClick={() => saveDocument()}>حفظ المسودة</Button>{step !== 'review' ? <Button kind="primary" disabled={busy} onClick={() => setStep(step === 'basics' ? 'curriculum' : 'review')}>التالي: {step === 'basics' ? 'المنهاج' : 'المراجعة'}</Button> : <Button kind="primary" disabled={busy} onClick={() => {if(dirty){setError('احفظ تعديلاتك أولًا، ثم راجع النسخة المحفوظة وانشرها.');return;}if(issues.length){setError('أكمل البنود الموضحة في قائمة الجاهزية قبل النشر.');return;}setModal({kind:'publish'});}}>نشر الدورة</Button>}</div></footer>
      </> : <PathEditor document={editor.document} change={changeDocument} courses={courses} busy={busy} more={pickerMore} onMore={moreCourses} onSave={() => saveDocument()} onPublish={() => {if(dirty || !editor.record.pathId){setError('احفظ المسار أولًا، ثم راجع ترتيبه وانشره.');return;}if(!editor.document.title.trim() || !editor.document.courseIds.length){setError('أضف عنوانًا ودورة واحدة على الأقل قبل النشر.');return;}setModal({kind:'publish'});}}/>
      }
    </>}
    {modal?.kind === 'create' && <CreateDialog ai={modal.ai} busy={busy} error={error} close={() => setModal(null)} create={createCourse}/>}
    {modal?.kind === 'ai' && editor?.kind === 'course' && <AiDialog busy={busy} error={error} close={() => setModal(null)} unitId={modal.unitId} document={editor.document} save={async brief => {
      const document = clone(editor.document);
      if (modal.unitId) {for (const topic of document.topics) {const unit = topic.units.find(unit => unit.id === modal.unitId);if (unit) unit.aiBrief = brief;}}
      else document.aiBrief = brief;
      changeDocument(document);
      const result = await saveDocument(document);
      if (result) {setModal(null);setNotice('حُفظ وصف طلب الإنشاء ضمن المسودة. سيكون متاحًا عند إعداد خدمة الذكاء الاصطناعي.');}
    }}/>} 
    {modal?.kind === 'preview' && editor?.kind === 'course' && <Preview document={editor.document} close={() => setModal(null)}/>}
    {modal?.kind === 'publish' && editor && <PublishDialog kind={editor.kind} title={editor.document.title} busy={busy} error={error} close={() => setModal(null)} publish={publish}/>}
    {modal?.kind === 'discard' && <Dialog error={error} title="توجد تعديلات غير محفوظة" description="احفظ المسودة للاحتفاظ بما كتبته قبل العودة." busy={busy} onClose={() => setModal(null)}><div className={styles.actions}><Button disabled={busy} onClick={() => setModal(null)}>متابعة التحرير</Button><Button kind="danger" disabled={busy} onClick={() => {setModal(null);setEditor(null);void loadList(0,'');setQuery('');}}>تجاهل التعديلات والعودة</Button><Button kind="primary" disabled={busy} onClick={async () => {if(await saveDocument()){setModal(null);setEditor(null);}}}>حفظ والعودة</Button></div></Dialog>}
    {modal?.kind === 'remove' && editor && <Dialog title={modal.unitId ? 'حذف المحتوى من المسودة؟' : 'حذف القسم من المسودة؟'} description={modal.unitId ? 'سيُحذف هذا العنصر من المسودة الحالية عند حفظها.' : 'سيُحذف القسم وكل المحتوى الموجود بداخله من المسودة عند حفظها.'} busy={busy} onClose={() => setModal(null)}><div className={styles.actions}><Button onClick={() => setModal(null)}>إلغاء</Button><Button kind="danger" onClick={() => {const document=clone(editor.document);document.topics = modal.unitId ? document.topics.map(topic => topic.id === modal.topicId ? {...topic,units:topic.units.filter(unit=>unit.id !== modal.unitId)} : topic) : document.topics.filter(topic => topic.id !== modal.topicId);changeDocument(document);setModal(null);}}>حذف من المسودة</Button></div></Dialog>}
  </div>;
}

function CreateDialog({ai, busy, error, close, create}) {
  const [title,setTitle] = useState('');
  return <Dialog title={ai ? 'دورة بمساعدة الذكاء الاصطناعي' : 'إنشاء دورة جديدة'} description="ابدأ بالعنوان، ويمكنك تعديله وإكمال التفاصيل لاحقًا." busy={busy} error={error} onClose={close}><form onSubmit={event => {event.preventDefault();void create(title.trim(),ai);}}>
    {ai && <div className={styles.aiStatus}><Sparkles/><div><strong>خدمة الذكاء الاصطناعي لم تُعدّ بعد</strong><p>يمكنك الآن إنشاء المسودة وحفظ وصف ما تريد توليده، لاستكماله بعد إعداد الخدمة.</p></div></div>}
    <Field label="عنوان الدورة"><input name="title" required minLength={2} maxLength={200} value={title} disabled={busy} placeholder="مثال: أساسيات إدارة المشاريع" onChange={event => setTitle(event.target.value)}/></Field><div className={styles.actions}><Button disabled={busy} onClick={close}>إلغاء</Button><button type="submit" className={styles.primary} disabled={busy}>{ai ? 'إنشاء المسودة وتجهيز الطلب' : 'إنشاء المسودة'}</button></div>
  </form></Dialog>;
}

function CourseBasics({document,patch}) {
  return <section className={styles.panel}><div className={styles.sectionHead}><div><h2>عرّف المتدرب بالدورة</h2><p>اكتب الفكرة ببساطة. التفاصيل الإضافية يمكنك إكمالها لاحقًا.</p></div></div><div className={styles.formGrid}>
    <Field label="عنوان الدورة" full><input value={document.title} maxLength={200} onChange={event => patch({title:event.target.value})} placeholder="عنوان واضح لما سيتعلمه المتدرب"/></Field>
    <Field label="وصف الدورة" full hint="وضّح الهدف، وما سيتعلمه المتدرب، ولمن تناسب هذه الدورة."><textarea rows={6} maxLength={20000} value={document.description || ''} onChange={event => patch({description:event.target.value})} placeholder="بنهاية هذه الدورة، سيكون المتدرب قادرًا على..."/></Field>
    <Field label="أسلوب التعلم"><select value={document.learningMode} onChange={event => patch({learningMode:event.target.value})}>{Object.entries(AUTHORING_MODES).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select></Field>
    <Field label="مستوى الدورة"><select value={document.level} onChange={event => patch({level:event.target.value})}>{Object.entries(AUTHORING_LEVELS).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select></Field>
    <Field label="لغة المحتوى"><select value={document.language} onChange={event => patch({language:event.target.value})}><option value="ar">العربية</option><option value="en">الإنجليزية</option></select></Field>
    <Field label="التصنيف"><input value={document.category||''} maxLength={120} onChange={event=>patch({category:event.target.value})} placeholder="مثال: الإدارة والقيادة"/></Field>
    <Field label="رابط صورة الغلاف" hint="اختياري · رابط HTTPS لصورة متاحة للعرض."><input type="url" dir="ltr" maxLength={2000} placeholder="https://..." value={document.thumbnailUrl || ''} onChange={event => patch({thumbnailUrl:event.target.value})}/></Field>
    <Field label="رابط الفيديو التعريفي" full hint="اختياري · رابط HTTPS للفيديو التعريفي بالدورة."><input type="url" dir="ltr" maxLength={2000} placeholder="https://..." value={document.introVideoUrl || ''} onChange={event => patch({introVideoUrl:event.target.value})}/></Field>
  </div></section>;
}

function Curriculum({document,change,openUnit,setOpenUnit,onAi,onRemove}) {
  const dragged=useRef(null);
  function startDrag(event,value){dragged.current=value;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',value.id);}
  function drop(event,target){
    if(!dragged.current||dragged.current.kind!==target.kind)return;
    event.preventDefault();event.stopPropagation();
    const source=dragged.current;dragged.current=null;
    if(source.kind==='topic'&&target.kind==='topic')change({...document,topics:reordered(document.topics,source.id,target.id)});
    if(source.kind==='unit'&&target.kind==='unit'&&source.topicId===target.topicId){const topic=document.topics.find(topic=>topic.id===target.topicId);patchTopic(topic.id,{units:reordered(topic.units,source.id,target.id)});}
  }
  function patchTopic(id,patch) {change({...document,topics:document.topics.map(topic=>topic.id===id?{...topic,...patch}:topic)});}
  function patchUnit(topicId,id,patch) {const topic=document.topics.find(topic=>topic.id===topicId);patchTopic(topicId,{units:topic.units.map(unit=>unit.id===id?{...unit,...patch}:unit)});}
  function addUnit(topic,kind) {
    const id=uuid(), unit={id,title:'',kind,body:'',url:'',required:true,minimumSeconds:0,...(kind==='quiz'?{questions:[],maxAttempts:3,passPercent:70}:{})};
    patchTopic(topic.id,{units:[...topic.units,unit]});setOpenUnit(id);
  }
  return <section className={styles.stack}><div className={styles.sectionHead}><div><h2>ابنِ منهاج الدورة</h2><p>{document.topics.length} أقسام · {countUnits(document)} عناصر محتوى</p></div><Button disabled={document.topics.length>=30} onClick={()=>change({...document,topics:[...document.topics,{id:uuid(),title:'',summary:'',units:[]}]})}>+ إضافة قسم</Button></div>
    {!document.topics.length && <div className={styles.empty}><AcademyIcon name="courses" size={34}/><h3>ما أول شيء سيتعلمه المتدرب؟</h3><p>أضف قسمًا، ثم ضع بداخله الدروس والأنشطة بالترتيب المناسب.</p><Button kind="primary" onClick={()=>change({...document,topics:[{id:uuid(),title:'',summary:'',units:[]}]})}>+ إضافة أول قسم</Button></div>}
    {document.topics.map((topic,index)=><section className={styles.topic} key={topic.id} aria-label={topic.title || `القسم ${index+1}`} onDragOver={event=>{if(dragged.current?.kind==='topic')event.preventDefault();}} onDrop={event=>drop(event,{kind:'topic',id:topic.id})}>
      <header className={styles.topicHead}><DragHandle label={`اسحب لترتيب القسم ${index+1}`} onDragStart={event=>startDrag(event,{kind:'topic',id:topic.id})} onDragEnd={()=>{dragged.current=null;}}/><span className={styles.topicOrder}>{index+1}</span><Field label={`عنوان القسم ${index+1}`}><input maxLength={200} value={topic.title} onChange={event=>patchTopic(topic.id,{title:event.target.value})} placeholder="مثال: البداية والمفاهيم الأساسية"/></Field><div className={styles.actions}><Button kind="iconButton" aria-label={`نقل القسم ${index+1} لأعلى`} disabled={index===0} onClick={()=>change({...document,topics:moved(document.topics,index,-1)})}>↑</Button><Button kind="iconButton" aria-label={`نقل القسم ${index+1} لأسفل`} disabled={index===document.topics.length-1} onClick={()=>change({...document,topics:moved(document.topics,index,1)})}>↓</Button><Button kind="quiet" onClick={()=>onRemove(topic.id)}>حذف القسم</Button></div></header>
      <div className={styles.topicBody}>{!topic.units.length&&<p className={styles.topicHint}>اختر نوع المحتوى لإضافة أول عنصر في هذا القسم.</p>}
        {topic.units.map((unit,unitIndex)=><article className={styles.unit} key={unit.id} onDragOver={event=>{if(dragged.current?.kind==='unit'&&dragged.current.topicId===topic.id)event.preventDefault();}} onDrop={event=>drop(event,{kind:'unit',id:unit.id,topicId:topic.id})}><header className={styles.unitHead}><DragHandle label={`اسحب لترتيب العنصر ${unitIndex+1} في القسم ${index+1}`} onDragStart={event=>startDrag(event,{kind:'unit',id:unit.id,topicId:topic.id})} onDragEnd={()=>{dragged.current=null;}}/><button type="button" className={styles.unitTitle} aria-expanded={openUnit===unit.id} onClick={()=>setOpenUnit(openUnit===unit.id?null:unit.id)}><AcademyIcon name={unit.kind==='quiz'?'assessments':unit.kind==='assignment'?'requests':'courses'} size={19}/><span><strong>{unit.title || `${AUTHORING_UNIT_KINDS[unit.kind]} جديد`}</strong><small>{AUTHORING_UNIT_KINDS[unit.kind]} · {unit.required?'مطلوب':'اختياري'}</small></span></button><div className={styles.actions}><Button kind="iconButton" disabled={unitIndex===0} aria-label={`نقل العنصر ${unitIndex+1} لأعلى في القسم ${index+1}`} onClick={()=>patchTopic(topic.id,{units:moved(topic.units,unitIndex,-1)})}>↑</Button><Button kind="iconButton" disabled={unitIndex===topic.units.length-1} aria-label={`نقل العنصر ${unitIndex+1} لأسفل في القسم ${index+1}`} onClick={()=>patchTopic(topic.id,{units:moved(topic.units,unitIndex,1)})}>↓</Button><Button kind="quiet" onClick={()=>onRemove(topic.id,unit.id)}>حذف</Button></div></header>
          {openUnit===unit.id&&<UnitEditor unit={unit} patch={patch=>patchUnit(topic.id,unit.id,patch)} onAi={()=>onAi(unit.id)}/>}</article>)}
        <div className={styles.addContent} aria-label={`إضافة محتوى إلى القسم ${index+1}`}>{Object.entries(AUTHORING_UNIT_KINDS).map(([kind,label])=><Button key={kind} disabled={countUnits(document)>=100} onClick={()=>addUnit(topic,kind)}>+ {label}</Button>)}</div>
      </div></section>)}
  </section>;
}

function UnitEditor({unit,patch,onAi}) {
  return <div className={styles.unitBody}><Field label="عنوان المحتوى"><input value={unit.title} maxLength={200} onChange={event=>patch({title:event.target.value})} placeholder="عنوان الدرس أو النشاط"/></Field>
    <div className={styles.row}><span className={styles.muted}>{unit.kind==='quiz'?'اكتب تعليمات الاختبار ثم أضف الأسئلة.':unit.kind==='assignment'?'اكتب المطلوب من المتدرب ومعايير تقييمه.':'اكتب محتوى الدرس أو وصفه.'}</span><Button kind="aiButton" onClick={onAi}><Sparkles/>مساعدة AI</Button></div>
    {unit.aiBrief?.goal&&<span className={styles.inlineBrief}>يوجد وصف محفوظ لطلب إنشاء هذا المحتوى</span>}
    <Field label={unit.kind==='quiz'?'تعليمات الاختبار':unit.kind==='assignment'?'تعليمات الواجب':'المحتوى'}><textarea rows={6} maxLength={50000} value={unit.body||''} onChange={event=>patch({body:event.target.value})}/></Field>
    {['video','link'].includes(unit.kind)&&<Field label={unit.kind==='video'?'رابط الفيديو':'رابط المصدر'} hint="استخدم رابط HTTPS للمصدر. تأكد من أن المتدرب يستطيع فتحه."><input value={unit.url||''} type="url" dir="ltr" maxLength={2000} placeholder="https://..." onChange={event=>patch({url:event.target.value})}/></Field>}
    {unit.kind==='quiz'&&<QuizEditor unit={unit} patch={patch}/>}
    <details><summary>خيارات المحتوى</summary><div className={styles.formGrid}><label className={styles.check}><input type="checkbox" checked={unit.required!==false} onChange={event=>patch({required:event.target.checked})}/>إكمال هذا المحتوى مطلوب لاجتياز الدورة</label><Field label="الحد الأدنى للوقت بالثواني" hint="صفر يعني بدون حد زمني أدنى."><input type="number" min={0} max={86400} value={unit.minimumSeconds||0} onChange={event=>patch({minimumSeconds:Number(event.target.value)})}/></Field></div></details>
  </div>;
}

function QuizEditor({unit,patch}) {
  const questions=unit.questions||[];
  function update(index,value){patch({questions:questions.map((question,i)=>i===index?{...question,...value}:question)});}
  return <div className={styles.stack}><div className={styles.formGrid}><Field label="درجة النجاح %"><input type="number" min={0} max={100} value={unit.passPercent??70} onChange={event=>patch({passPercent:Number(event.target.value)})}/></Field><Field label="المحاولات المسموحة"><input type="number" min={1} max={20} value={unit.maxAttempts||3} onChange={event=>patch({maxAttempts:Number(event.target.value)})}/></Field></div>
    <p className={styles.hint}>اختر الإجابة الصحيحة لكل سؤال. نوع الأسئلة المتاح هنا: اختيار إجابة واحدة.</p>
    {questions.map((question,index)=><section key={question.id} className={styles.question}><div className={styles.row}><h3>السؤال {index+1}</h3><Button kind="quiet" onClick={()=>patch({questions:questions.filter((_,i)=>i!==index)})}>حذف السؤال</Button></div><Field label={`نص السؤال ${index+1}`}><textarea rows={2} maxLength={2000} value={question.prompt} onChange={event=>update(index,{prompt:event.target.value})}/></Field><div className={styles.questionOptions}>{question.options.map((option,optionIndex)=><label className={styles.questionOption} key={optionIndex}><input type="radio" name={`answer-${question.id}`} aria-label={`الإجابة ${optionIndex+1} صحيحة للسؤال ${index+1}`} checked={question.correctOptionIndex===optionIndex} onChange={()=>update(index,{correctOptionIndex:optionIndex})}/><input type="text" aria-label={`الخيار ${optionIndex+1} للسؤال ${index+1}`} value={option} maxLength={1000} onChange={event=>update(index,{options:question.options.map((value,i)=>i===optionIndex?event.target.value:value)})}/></label>)}</div></section>)}
    <Button disabled={questions.length>=50} onClick={()=>patch({questions:[...questions,{id:uuid(),prompt:'',options:['','','',''],correctOptionIndex:0}]})}>+ إضافة سؤال</Button>
  </div>;
}

function CourseReview({document,issues,patch,goTo}) {
  function policy(value){patch({policy:{...document.policy,...value}});}
  return <><section className={styles.panel}><div className={styles.sectionHead}><div><h2>جاهزية الدورة للنشر</h2><p>راجع البنود التالية ثم احفظ مسودتك قبل النشر.</p></div><span className={`${styles.badge} ${issues.length?styles.draft:styles.published}`}>{issues.length?`${issues.length} بنود تحتاج استكمالًا`:'جاهزة للنشر'}</span></div><ul className={styles.reviewList}>{issues.length?issues.map((issue,index)=><li key={index}><span>○</span><div>{issue.message}<br/><Button kind="quiet" onClick={()=>goTo(issue)}>استكمال هذا البند ←</Button></div></li>):<li data-ready="true"><span>✓</span>اكتملت المتطلبات الأساسية. راجع المحتوى وتأكد من صحته.</li>}</ul><div className={styles.reviewOutline}><h3>{document.title||'عنوان الدورة'}</h3><p className={styles.muted}>{document.topics.length} أقسام · {countUnits(document)} عناصر · {AUTHORING_MODES[document.learningMode]}</p>{document.topics.map(topic=><div key={topic.id}><h3>{topic.title||'قسم بلا عنوان'}</h3><ol>{topic.units.map(unit=><li key={unit.id}>{unit.title||'محتوى بلا عنوان'} · {AUTHORING_UNIT_KINDS[unit.kind]}</li>)}</ol></div>)}</div></section>
    <section className={styles.panel}><div className={styles.sectionHead}><div><h2>الاجتياز ودعم المتدرب</h2><p>إعدادات واضحة تحدد كيف يكمل المتدرب الدورة.</p></div></div><div className={styles.formGrid}>
      <Field label="الحد الأدنى لدرجة التقييم %"><input type="number" min={0} max={100} value={document.policy.minAssessmentPercent} onChange={event=>policy({minAssessmentPercent:Number(event.target.value)})}/></Field><Field label="الحد الأدنى للحضور %"><input type="number" min={0} max={100} value={document.policy.minAttendancePercent} onChange={event=>policy({minAttendancePercent:Number(event.target.value)})}/></Field>
      <Field label="بريد دعم المتدربين"><input type="email" dir="ltr" maxLength={254} value={document.policy.supportEmail} onChange={event=>policy({supportEmail:event.target.value})} placeholder="support@example.com"/></Field><Field label="إصدار شروط التعلم" hint="مثال: 1.0، لتمييز الشروط التي يوافق عليها المتدرب."><input maxLength={40} value={document.policy.termsVersion} onChange={event=>policy({termsVersion:event.target.value})} placeholder="1.0"/></Field>
      <label className={styles.check}><input type="checkbox" checked={document.policy.requireCompletedRun} onChange={event=>policy({requireCompletedRun:event.target.checked})}/>يشترط انتهاء الدفعة قبل اجتياز الدورة</label><label className={styles.check}><input type="checkbox" checked={document.policy.certificateEnabled} onChange={event=>policy({certificateEnabled:event.target.checked})}/>إتاحة الشهادة عند استيفاء شروط الاجتياز والسداد</label>
    </div></section></>;
}

function PathEditor({document,change,courses,busy,more,onMore,onSave,onPublish}) {
  const dragged=useRef(null);
  const [selection,setSelection]=useState(''), [search,setSearch]=useState('');
  const titles=new Map(courses.map(course=>[course.id,course])), options=courses.filter(course=>!document.courseIds.includes(course.id)&&courseTitle(course).includes(search));
  return <><fieldset className={styles.editorFieldset} disabled={busy}><section className={styles.panel}><div className={styles.sectionHead}><div><h2>ارسم رحلة المتدرب</h2><p>المسار ترتيب مقترح للدورات. يظل التسجيل والوصول لكل دورة مستقلًا.</p></div></div><div className={styles.formGrid}><Field label="عنوان المسار" full><input maxLength={200} value={document.title} onChange={event=>change({...document,title:event.target.value})} placeholder="مثال: مسار مدير المشاريع"/></Field><Field label="وصف المسار" full><textarea rows={3} maxLength={10000} value={document.description||''} onChange={event=>change({...document,description:event.target.value})} placeholder="ما الهدف من هذا المسار، ولمن يناسب؟"/></Field></div></section><section className={styles.panel}><div className={styles.sectionHead}><div><h2>دورات المسار</h2><p>رتّب الدورات من البداية إلى التقدم.</p></div><span className={styles.badge}>{document.courseIds.length} دورات</span></div><div className={styles.stack}>{document.courseIds.map((id,index)=><div key={id} className={styles.pathRow} onDragOver={event=>{if(dragged.current)event.preventDefault();}} onDrop={event=>{if(!dragged.current)return;event.preventDefault();change({...document,courseIds:reordered(document.courseIds,dragged.current,id,value=>value)});dragged.current=null;}}><DragHandle label={`اسحب لترتيب دورة المسار ${index+1}`} onDragStart={event=>{dragged.current=id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',id);}} onDragEnd={()=>{dragged.current=null;}}/><span className={styles.topicOrder}>{index+1}</span><div><strong>{titles.has(id)?courseTitle(titles.get(id)):`الدورة ${index+1}`}</strong><small>{titles.has(id)?coursePublished(titles.get(id))?'محتواها منشور':'يجب نشر محتواها قبل نشر المسار':'محفوظة ضمن المسار'}</small></div><div className={styles.actions}><Button kind="iconButton" disabled={index===0} aria-label={`نقل دورة المسار ${index+1} لأعلى`} onClick={()=>change({...document,courseIds:moved(document.courseIds,index,-1)})}>↑</Button><Button kind="iconButton" disabled={index===document.courseIds.length-1} aria-label={`نقل دورة المسار ${index+1} لأسفل`} onClick={()=>change({...document,courseIds:moved(document.courseIds,index,1)})}>↓</Button><Button kind="quiet" onClick={()=>change({...document,courseIds:document.courseIds.filter(courseId=>courseId!==id)})}>إزالة من المسار</Button></div></div>)}{!document.courseIds.length&&<p className={styles.topicHint}>اختر أول دورة في رحلة المتدرب.</p>}<Field label="البحث في الدورات المتاحة"><input type="search" value={search} maxLength={120} onChange={event=>setSearch(event.target.value)} placeholder="اكتب عنوان الدورة"/></Field><div className={styles.picker}><Field label="إضافة دورة موجودة"><select value={selection} onChange={event=>setSelection(event.target.value)}><option value="">اختر دورة</option>{options.map(course=><option key={course.id} value={course.id}>{courseTitle(course)}{coursePublished(course)?'':' — مسودة'}</option>)}</select></Field><Button disabled={!selection||document.courseIds.length>=100} onClick={()=>{if(!document.courseIds.includes(selection))change({...document,courseIds:[...document.courseIds,selection]});setSelection('');}}>+ إضافة للمسار</Button></div>{more&&<Button onClick={onMore}>تحميل مزيد من الدورات</Button>}</div></section></fieldset><footer className={styles.editorFooter}><p className={styles.muted}>راجع الترتيب قبل النشر.</p><div className={styles.actions}><Button disabled={busy} onClick={onSave}>حفظ المسار</Button><Button kind="primary" disabled={busy} onClick={onPublish}>نشر المسار</Button></div></footer></>;
}

function AiDialog({unitId,document,busy,error,close,save}) {
  const unit=unitId?document.topics.flatMap(topic=>topic.units).find(unit=>unit.id===unitId):null;
  const [brief,setBrief]=useState(clone(unit?.aiBrief||(!unitId&&document.aiBrief)||{goal:'',audience:'',language:document.language||'ar',topicCount:5,notes:''}));
  function patch(value){setBrief(current=>({...current,...value}));}
  return <Dialog title={unitId?'إنشاء محتوى بمساعدة AI':'إنشاء الدورة بمساعدة AI'} description={unit?.title||document.title} busy={busy} error={error} onClose={close}><form onSubmit={event=>{event.preventDefault();void save(brief);}}><div className={styles.aiStatus}><Sparkles/><div><strong>خدمة الذكاء الاصطناعي لم تُعدّ بعد</strong><p>احفظ وصف المطلوب الآن. لن يبدأ التوليد ولن تُرسل بياناتك إلى أي مزوّد من هذه الشاشة.</p></div></div><Field label="ماذا تريد أن يتعلم المتدرب؟"><textarea required minLength={5} maxLength={2000} rows={3} value={brief.goal||''} disabled={busy} onChange={event=>patch({goal:event.target.value})} placeholder="صف الهدف والموضوعات التي تريد تغطيتها..."/></Field><Field label="لمن تقدم هذا المحتوى؟"><input maxLength={1000} value={brief.audience||''} disabled={busy} onChange={event=>patch({audience:event.target.value})} placeholder="مثال: موظفون يبدأون في إدارة المشاريع"/></Field><div className={styles.formGrid}><Field label="لغة المحتوى"><select value={brief.language||'ar'} disabled={busy} onChange={event=>patch({language:event.target.value})}><option value="ar">العربية</option><option value="en">الإنجليزية</option></select></Field>{!unitId&&<Field label="عدد الأقسام المقترح"><input type="number" min={1} max={30} value={brief.topicCount||5} disabled={busy} onChange={event=>patch({topicCount:Number(event.target.value)})}/></Field>}</div><Field label="تعليمات أو ملاحظات إضافية"><textarea rows={3} maxLength={4000} value={brief.notes||''} disabled={busy} onChange={event=>patch({notes:event.target.value})} placeholder="أسلوب الشرح، أمثلة مطلوبة، أو موضوعات يجب تجنبها"/></Field><div className={styles.actions}><Button disabled={busy} onClick={close}>إلغاء</Button><button type="submit" disabled={busy} className={styles.primary}>حفظ الطلب ضمن المسودة</button></div></form></Dialog>;
}

function Preview({document,close}) {
  const [selected,setSelected]=useState(document.topics.flatMap(topic=>topic.units)[0]?.id||null);
  const unit=document.topics.flatMap(topic=>topic.units).find(unit=>unit.id===selected);
  return <Dialog title="معاينة المحتوى" description="معاينة للمسودة الحالية كما رتّبتها. لم تُنشر بعد." onClose={close}><div className={styles.stack}><h2>{document.title||'عنوان الدورة'}</h2><p className={styles.previewText}>{document.description}</p>{document.topics.map(topic=><section key={topic.id}><h3>{topic.title||'قسم جديد'}</h3><div className={styles.addContent}>{topic.units.map(item=><Button key={item.id} kind={selected===item.id?'primary':'secondary'} onClick={()=>setSelected(item.id)}>{item.title||AUTHORING_UNIT_KINDS[item.kind]}</Button>)}</div></section>)}{unit&&<article className={styles.panel}><span className={styles.badge}>{AUTHORING_UNIT_KINDS[unit.kind]}</span><h3>{unit.title}</h3><p className={styles.previewText}>{unit.body}</p>{unit.url&&<p className={styles.muted}>رابط المصدر: <bdi>{unit.url}</bdi></p>}{unit.kind==='quiz'&&(unit.questions||[]).map(question=><div key={question.id} className={styles.question}><h3>{question.prompt}</h3>{question.options.map((option,index)=><label key={index} className={styles.check}><input type="radio" name={`preview-${question.id}`}/>{option}</label>)}</div>)}</article>}{!unit&&<p className={styles.hint}>أضف محتوى إلى المنهاج ليظهر في المعاينة.</p>}</div></Dialog>;
}

function PublishDialog({kind,title,busy,error,close,publish}) {
  const [reviewed,setReviewed]=useState(false);
  return <Dialog title={kind==='course'?'نشر الدورة':'نشر المسار'} description={title} busy={busy} error={error} onClose={close}><p className={styles.publishCopy}>{kind==='course'?'ستنشر النسخة المحفوظة من المحتوى. التسجيلات الحالية تحتفظ بنسختها المعتمدة، وتبقى إتاحة الدورة للبيع مستقلة في متجر الدورات.':'سيظهر المسار بترتيب الدورات المحفوظ. لا يمنح نشره وصولًا إلى دورة دون تسجيل معتمد فيها.'}</p><label className={styles.check}><input type="checkbox" checked={reviewed} disabled={busy} onChange={event=>setReviewed(event.target.checked)}/>راجعت المحتوى والترتيب وأوافق على نشر هذه النسخة.</label><div className={styles.actions}><Button disabled={busy} onClick={close}>العودة للمراجعة</Button><Button kind="primary" disabled={busy||!reviewed} onClick={publish}>تأكيد النشر</Button></div></Dialog>;
}
