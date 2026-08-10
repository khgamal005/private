'use client';

import Link from 'next/link';
import {useEffect,useMemo,useRef,useState} from 'react';
import CmsBuilderAssistant from './cms-builder-assistant';
import PageDocumentRenderer from './page-document-renderer';
import PageSourceModal from './page-source-modal';
import {BLOCK_CATALOG,BUILDER_TEMPLATES,ROW_LAYOUTS,SECTION_PRESETS} from '../lib/website-builder';
import {cmsBasePath,cmsPreviewPath,cmsPublicPath} from '../lib/cms';
import {usePageBuilder} from './use-page-builder';
import {PageInspector,SelectionInspector,Status,VersionHistory} from './page-builder-inspector';
import styles from './page-builder.module.css';

const DEVICE_LABELS={desktop:'كمبيوتر',tablet:'تابلت',mobile:'جوال'};
const DEVICE_ICONS={desktop:'▰',tablet:'▯',mobile:'▯'};

export default function PageBuilder({initialData}){
  const builder=usePageBuilder(initialData);
  const {
    page:entity,context,document,selected,selection,setSelection,device,setDevice,zoom,setZoom,
    previewMode,setPreviewMode,showOutlines,setShowOutlines,history,dirty,busy,notice,setNotice,
    versions,showVersions,setShowVersions,templateKey,setTemplateKey,groups,undo,redo,
    addRow,addBlock,insertPreset,insertSaved,duplicateBlock,deleteBlock,moveBlock,duplicateModule,deleteModule,
    handleDragStart,handleModuleDragStart,handleDrop,handleColumnDrop,updateSelected,updateInline,
    updatePageSetting,importDocument,insertImportedTemplate,legacyTemplateCount,upgradeLegacyTemplates,
    previewAssistantPlan,applyAssistantDocument,saveDraft,publish,restore,applyTemplate
  }=builder;
  const [libraryTab,setLibraryTab]=useState('modules');
  const [query,setQuery]=useState('');
  const [inspectorMode,setInspectorMode]=useState('selection');
  const [libraryOpen,setLibraryOpen]=useState(true);
  const [inspectorOpen,setInspectorOpen]=useState(true);
  const [sourceOpen,setSourceOpen]=useState(false);
  const [assistantOpen,setAssistantOpen]=useState(false);
  const [assistantPreview,setAssistantPreview]=useState(null);
  const [savedItems,setSavedItems]=useState([]);
  const [importing,setImporting]=useState(false);
  const [zipDragActive,setZipDragActive]=useState(false);
  const [templates,setTemplates]=useState([]);
  const [templatesState,setTemplatesState]=useState('idle');
  const [catalogReload,setCatalogReload]=useState(0);
  const [templateDeleting,setTemplateDeleting]=useState('');
  const importRef=useRef(null);
  const isArticle=entity.type==='article';
  const backHref=`${cmsBasePath(context)}?section=${isArticle?'articles':'pages'}`;
  const publicPath=cmsPublicPath(context,isArticle?'article':'page',entity);
  const storageKey=`marktone-builder-saved:${context.siteKey||'marktone-main'}:${context.tenantSlug||'platform'}`;
  const renderedDocument=assistantPreview?.document||document;
  const nativeTemplateCanvas=useMemo(()=>hasNativeTemplate(renderedDocument),[renderedDocument]);

  useEffect(()=>{try{const stored=JSON.parse(localStorage.getItem(storageKey)||'[]');setSavedItems(Array.isArray(stored)?stored:[]);}catch{setSavedItems([]);}},[storageKey]);
  useEffect(()=>{if(new URLSearchParams(window.location.search).get('panel')==='templates'){setLibraryTab('templates');setLibraryOpen(true);}},[]);
  useEffect(()=>{function closeSource(event){if(event.key==='Escape')setSourceOpen(false);}window.addEventListener('keydown',closeSource);return()=>window.removeEventListener('keydown',closeSource);},[]);
  useEffect(()=>{
    if(libraryTab!=='templates')return;
    const controller=new AbortController();
    const params=new URLSearchParams({siteKey:context.siteKey||'marktone-main'});
    if(context.tenantSlug)params.set('tenantSlug',context.tenantSlug);
    setTemplatesState('loading');
    fetch(`/api/cms/templates/catalog?${params}`,{signal:controller.signal})
      .then(async response=>{const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'تعذر تحميل القوالب');return result})
      .then(result=>{setTemplates(Array.isArray(result.templates)?result.templates:[]);setTemplatesState('ready')})
      .catch(error=>{if(error.name!=='AbortError')setTemplatesState('error')});
    return()=>controller.abort();
  },[catalogReload,context.siteKey,context.tenantSlug,libraryTab]);

  const filteredGroups=useMemo(()=>{
    const term=query.trim().toLowerCase();
    if(!term)return groups;
    return groups.map(group=>({...group,items:group.items.filter(item=>`${item.label} ${item.description} ${item.type}`.toLowerCase().includes(term))})).filter(group=>group.items.length);
  },[groups,query]);
  const filteredPresets=useMemo(()=>Object.entries(SECTION_PRESETS).filter(([,item])=>!query||`${item.label} ${item.description}`.includes(query)),[query]);
  const filteredSaved=useMemo(()=>savedItems.filter(item=>!query||`${item.name} ${item.type}`.toLowerCase().includes(query.toLowerCase())),[savedItems,query]);
  const filteredTemplates=useMemo(()=>templates.filter(item=>!query||String(item.name||'').toLowerCase().includes(query.toLowerCase())),[query,templates]);

  function selectTarget(target){setSelection(target);setInspectorMode('selection');if(!inspectorOpen)setInspectorOpen(true);}
  function addHtmlModule(){addBlock('html');setLibraryOpen(true);setLibraryTab('modules');setInspectorMode('selection');setInspectorOpen(true);setNotice({type:'success',text:'تمت إضافة عنصر HTML. حدده داخل الصفحة ثم أضف الكود من لوحة الخصائص.'});}
  function saveToLibrary(kind,data){
    const item={id:`saved-${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`,kind,type:data.type,name:`${kind==='block'?'صف':'موديول'} · ${BLOCK_CATALOG[data.type]?.label||'عنصر محفوظ'}`,data,createdAt:new Date().toISOString()};
    const next=[item,...savedItems].slice(0,60);setSavedItems(next);localStorage.setItem(storageKey,JSON.stringify(next));setNotice({type:'success',text:'تم حفظ العنصر في تبويب Saved.'});setLibraryTab('saved');
  }
  function removeSaved(id){const next=savedItems.filter(item=>item.id!==id);setSavedItems(next);localStorage.setItem(storageKey,JSON.stringify(next));}
  function exportDesign(){
    const blob=new Blob([JSON.stringify(document,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=documentRef('a');link.href=url;link.download=`${entity.slug||'page'}-marktone-builder.json`;link.click();URL.revokeObjectURL(url);
  }
  async function importDesign(event){
    const file=event.target.files?.[0];if(!file)return;
    try{await importFile(file)}finally{event.target.value=''}
  }
  async function importFile(file){
    const isZip=/\.zip$/i.test(file.name)||['application/zip','application/x-zip-compressed'].includes(file.type);
    if(!isZip){
      try{
        const parsed=JSON.parse(await file.text());
        if(!window.confirm('سيتم استيراد التصميم داخل المسودة الحالية. متابعة؟'))return;
        importDocument(parsed);
      }catch{setNotice({type:'error',text:'ملف Builder JSON غير صالح.'})}
      return;
    }
    if(!window.confirm('سيتم رفع القالب وفحصه ثم تحويل HTML وCSS إلى أقسام أصلية بعرض الصفحة. سيتم تعطيل JavaScript لحماية جلسة ماركتون، ولن يُنشر القالب تلقائيًا. متابعة؟')){
      return;
    }
    setImporting(true);setNotice(null);
    try{
      const ticketResponse=await fetch('/api/cms/templates/ticket',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          siteKey:context.siteKey||'marktone-main',tenantSlug:context.tenantSlug||null,
          name:file.name,mimeType:file.type||'application/zip',sizeBytes:file.size
        })
      });
      const ticket=await ticketResponse.json().catch(()=>({}));
      if(!ticketResponse.ok)throw new Error(ticket.error||'تعذر تجهيز رفع القالب.');
      const uploadBody=new FormData();
      const uploadFile=['application/zip','application/x-zip-compressed'].includes(file.type)
        ?file:new File([file],file.name,{type:'application/zip'});
      uploadBody.append('cacheControl','3600');
      uploadBody.append('',uploadFile);
      const uploadResponse=await fetch(ticket.uploadUrl,{method:'PUT',headers:{'x-upsert':'false'},body:uploadBody});
      if(!uploadResponse.ok)throw new Error('تعذر رفع ملف ZIP إلى مساحة الفحص.');
      const processResponse=await fetch('/api/cms/templates/process',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({templateId:ticket.templateId})
      });
      const result=await processResponse.json().catch(()=>({}));
      if(!processResponse.ok)throw new Error(result.error||'تعذر فحص القالب.');
      await insertImportedTemplate(result.template);
      setTemplates(current=>[result.template,...current.filter(item=>item.id!==result.template.id)]);
    }catch(error){
      setNotice({type:'error',text:error instanceof Error?error.message:'تعذر استيراد قالب ZIP.'});
    }finally{
      setImporting(false);
    }
  }
  function openZipImport(){setLibraryOpen(true);setLibraryTab('templates');importRef.current?.click();}
  function handleZipDrop(event){
    event.preventDefault();setZipDragActive(false);
    const file=event.dataTransfer?.files?.[0];
    if(file)importFile(file);
  }
  async function deleteTemplate(template){
    if(!template?.id||templateDeleting)return;
    const used=documentUsesTemplate(document,template);
    const warning=used
      ?'هذا القالب مستخدم داخل المسودة الحالية. ستبقى الأقسام الحالية وملفاتها سليمة، لكن القالب لن يظهر بعد ذلك في المكتبة لإضافته مرة أخرى.'
      :'سيتم حذف القالب من مكتبة القوالب. ستبقى ملفاته محفوظة حتى لا تتعطل أي صفحة سبق أن استخدمته.';
    if(!window.confirm(`${warning}\n\nمتابعة؟`))return;
    setTemplateDeleting(String(template.id));
    setNotice(null);
    try{
      const response=await fetch('/api/cms/templates/delete',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({templateId:template.id})
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'تعذر حذف القالب من المكتبة.');
      setTemplates(current=>current.filter(item=>item.id!==template.id));
      setNotice({type:'success',text:used
        ?'تم حذف القالب من المكتبة مع إبقاء الأقسام المستخدمة داخل المسودة سليمة.'
        :'تم حذف القالب من المكتبة بأمان، مع الاحتفاظ بملفاته لحماية الصفحات السابقة.'});
    }catch(error){
      setNotice({type:'error',text:error instanceof Error?error.message:'تعذر حذف القالب من المكتبة.'});
    }finally{
      setTemplateDeleting('');
    }
  }

  function handleAssistantPlan(proposal){
    try{
      const preview=previewAssistantPlan(proposal.operations);
      const warnings=[...(proposal.warnings||[])];
      if(preview.rejected.length)warnings.push(`تم تجاهل ${preview.rejected.length} تعديل غير متوافق مع بنية الصفحة.`);
      setAssistantPreview({proposal:{...proposal,warnings},document:preview.document,base:JSON.stringify(document)});
      setNotice({type:'success',text:'معاينة المساعد ظاهرة الآن على الصفحة. لم يتم تطبيقها أو نشرها بعد.'});
    }catch(error){
      setAssistantPreview(null);
      setNotice({type:'error',text:error instanceof Error?error.message:'تعذر إنشاء المعاينة.'});
      throw error;
    }
  }
  function applyAssistantPreview(){
    if(!assistantPreview)return;
    if(assistantPreview.base!==JSON.stringify(document)){
      setAssistantPreview(null);
      setNotice({type:'error',text:'تغيرت الصفحة بعد إنشاء المعاينة. أرسل الطلب مرة أخرى حتى لا نفقد التعديلات الجديدة.'});
      return;
    }
    applyAssistantDocument(assistantPreview.document,assistantPreview.proposal.summary);
    setAssistantPreview(null);
  }
  function discardAssistantPreview(){setAssistantPreview(null);setNotice({type:'success',text:'تم إلغاء معاينة المساعد دون تغيير الصفحة.'});}
  function closeAssistant(){setAssistantPreview(null);setAssistantOpen(false);}

  return <div className={styles.builder} dir="rtl">
    <header className={styles.topbar}>
      <div className={styles.primaryActions}>
        <Link href={backHref} className={styles.backButton} title="العودة إلى إدارة الموقع">⌄</Link>
        <button type="button" className={styles.saveButton} onClick={saveDraft} disabled={Boolean(busy)}>{busy==='save-draft'?'جارٍ الحفظ…':'حفظ المسودة'}</button>
        <Link href={backHref} className={styles.closeButton} title="إغلاق المصمم">×</Link>
        <div className={styles.pageIdentity}><small>Marktone Builder Pro</small><strong>{entity.title||'تصميم المحتوى'}</strong><span dir="ltr">{publicPath}</span></div>
        <Status value={entity.status}/>{dirty&&<b className={styles.unsaved}>غير محفوظ</b>}
      </div>

      <div className={styles.utilityActions}>
        <button type="button" className={`${styles.aiToggleButton} ${assistantOpen?styles.aiToggleActive:''}`} title="مساعد Marktone CMS" onClick={()=>setAssistantOpen(value=>!value)}>✦ AI</button>
        <button type="button" title="مساعدة">?</button>
        <button type="button" title="إظهار حدود العناصر" className={showOutlines?styles.activeUtility:''} onClick={()=>setShowOutlines(value=>!value)}>⌗</button>
        <button type="button" title="CSS وإعدادات الصفحة" className={inspectorMode==='page'?styles.activeUtility:''} onClick={()=>{setInspectorMode('page');setInspectorOpen(true);}}>CSS</button>
        <button type="button" title="مشاهدة سورس HTML وBuilder JSON" className={sourceOpen?styles.activeUtility:''} onClick={()=>setSourceOpen(true)}>&lt;/&gt;</button>
        <button type="button" title="إضافة كود HTML إلى الصفحة" onClick={addHtmlModule}>HTML＋</button>
        <button type="button" className={styles.zipImportButton} title="استيراد قالب ZIP" disabled={importing} onClick={openZipImport}>{importing?'جارٍ الفحص…':'استيراد ZIP'}</button>
        <input ref={importRef} type="file" accept="application/json,.json,application/zip,application/x-zip-compressed,.zip" hidden onChange={importDesign}/>
        <button type="button" title="تصدير التصميم" onClick={exportDesign}>⇩</button>
        <button type="button" onClick={undo} disabled={!history.past.length} title="تراجع">↶</button>
        <button type="button" onClick={redo} disabled={!history.future.length} title="إعادة">↷</button>
        <button type="button" className={previewMode?styles.activeUtility:''} onClick={()=>setPreviewMode(value=>!value)} title="معاينة حية">◫</button>
      </div>

      <div className={styles.viewActions}>
        <div className={styles.deviceSwitch}>{Object.keys(DEVICE_LABELS).map(key=><button key={key} type="button" className={device===key?styles.activeDevice:''} onClick={()=>setDevice(key)} title={DEVICE_LABELS[key]}><span>{DEVICE_ICONS[key]}</span></button>)}</div>
        <div className={styles.zoomControl}><button type="button" onClick={()=>setZoom(value=>Math.max(60,value-10))}>−</button><span>{zoom}%</span><button type="button" onClick={()=>setZoom(value=>Math.min(120,value+10))}>+</button></div>
        <button type="button" className={styles.versionsButton} onClick={()=>{setShowVersions(value=>!value);setInspectorOpen(true);}}>☷</button>
        <Link className={styles.previewLink} href={cmsPreviewPath(context,entity.type||'page',entity.id)} target="_blank" title="فتح المعاينة في تبويب جديد">▱</Link>
        <button type="button" className={styles.publishButton} onClick={publish} disabled={Boolean(busy)}>{busy==='publish'?'جارٍ النشر…':'نشر'}</button>
        <button type="button" className={styles.addButton} onClick={()=>{setLibraryOpen(true);setLibraryTab('modules');}}>＋</button>
      </div>
    </header>

    {notice&&!assistantPreview&&<div className={`${styles.notice} ${notice.type==='error'?styles.noticeError:styles.noticeSuccess}`}><span>{notice.text}</span><button type="button" onClick={()=>setNotice(null)}>×</button></div>}
    {legacyTemplateCount>0&&!assistantPreview&&<div className={styles.legacyUpgradeBar}><div><b>تم اكتشاف قالب ZIP قديم داخل عمود</b><span>حوّله إلى أقسام أصلية مستقلة حتى يختفي ارتفاع 720 وشريط التمرير والحاوية القديمة.</span></div><button type="button" disabled={Boolean(busy)} onClick={upgradeLegacyTemplates}>{busy==='upgrade-legacy-templates'?'جارٍ الترقية…':'ترقية القالب الآن'}</button></div>}
    {assistantPreview&&<div className={styles.aiPreviewBar}><div><b>✦ معاينة المساعد</b><span>{assistantPreview.proposal.summary}</span></div><div><button type="button" onClick={applyAssistantPreview}>تطبيق</button><button type="button" onClick={discardAssistantPreview}>إلغاء</button></div></div>}

    <div className={`${styles.body} ${!libraryOpen?styles.libraryClosed:''} ${!inspectorOpen?styles.inspectorClosed:''}`}>
      <aside className={styles.library}>
        <div className={styles.libraryTabs}>{[['templates','القوالب'],['saved','المحفوظات'],['blocks','الأقسام'],['modules','العناصر']].map(([key,label])=><button type="button" key={key} className={libraryTab===key?styles.activeTab:''} onClick={()=>setLibraryTab(key)}>{label}{key==='saved'&&savedItems.length>0&&<b>{savedItems.length}</b>}</button>)}</div>
        <div className={styles.searchBox}><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث عن عنصر…"/><span>⌕</span></div>
        <div className={styles.libraryScroll}>
          {libraryTab==='modules'&&<>
            <section className={styles.rowLibrary}><header><b>ROWS</b><small>اسحب توزيع الأعمدة إلى الصفحة</small></header><div>{Object.entries(ROW_LAYOUTS).map(([key,item])=><button type="button" draggable key={key} onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-row-layout',key);}} onClick={()=>addRow(key)} title={item.label}><span style={{gridTemplateColumns:item.template}}>{Array.from({length:item.columns},(_,index)=><i key={index}/>)}</span><small>{item.label}</small></button>)}</div></section>
            <div className={styles.moduleGroups}>{filteredGroups.map(group=><section key={group.category}><h2>{group.category}</h2><div>{group.items.map(item=><button type="button" key={item.type} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-new-block',item.type);}} onClick={()=>addBlock(item.type)} title={item.description}><span>{item.icon}</span><b>{item.label}</b><small>{item.description}</small></button>)}</div></section>)}{!filteredGroups.length&&<EmptyLibrary text="لا توجد عناصر مطابقة."/>}</div>
          </>}
          {libraryTab==='blocks'&&<div className={styles.presetLibrary}>
            <div className={styles.templateBox}><label><span>ابدأ من قالب كامل</span><select value={templateKey} onChange={event=>setTemplateKey(event.target.value)}>{Object.entries(BUILDER_TEMPLATES).map(([key,item])=><option key={key} value={key}>{item.label}</option>)}</select></label><button type="button" onClick={applyTemplate}>تطبيق القالب</button></div>
            {filteredPresets.map(([key,item])=><button type="button" className={styles.presetCard} key={key} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-preset',key);}} onClick={()=>insertPreset(key)}><span>{item.icon}</span><div><b>{item.label}</b><small>{item.description}</small></div><em>＋</em></button>)}
          </div>}
          {libraryTab==='templates'&&<div className={styles.templatesLibrary}>
            <div className={`${styles.templateImportPanel} ${zipDragActive?styles.templateImportDragging:''}`} onDragEnter={event=>{event.preventDefault();setZipDragActive(true);}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget))setZipDragActive(false);}} onDrop={handleZipDrop}><span>ZIP</span><h2>استيراد قالب كامل</h2><p>اسحب ملف ZIP هنا، أو اختره من جهازك. سيحوّل ماركتون index.html وCSS إلى أقسام أصلية بعرض الصفحة، ويعطّل JavaScript غير الآمن.</p><button type="button" disabled={importing} onClick={()=>importRef.current?.click()}>{importing?'جارٍ الرفع والفحص…':'اختيار ملف ZIP'}</button><small>حتى 20MB مضغوط · 64MB بعد الفك · 250 ملفًا · يُضاف إلى المسودة ولا يُنشر تلقائيًا</small></div>
            <section className={styles.templateCatalog}><header><b>مكتبة القوالب</b><small>{templates.length} قالب محفوظ</small></header>
              {templatesState==='loading'&&<p>جارٍ تحميل القوالب…</p>}
              {templatesState==='error'&&<div className={styles.catalogError}><span>تعذر تحميل المكتبة.</span><button type="button" onClick={()=>setCatalogReload(value=>value+1)}>إعادة المحاولة</button></div>}
              {templatesState==='ready'&&filteredTemplates.map(template=><article key={template.id}><div><b>{template.name}</b><small>{template.fileCount} ملف · {Math.max(1,Math.round((template.totalBytes||0)/1024))} KB</small></div><div className={styles.templateCatalogActions}><button type="button" disabled={templateDeleting===template.id} onClick={()=>insertImportedTemplate(template)}>إضافة للمسودة</button><button type="button" className={styles.templateDeleteButton} disabled={Boolean(templateDeleting)} onClick={()=>deleteTemplate(template)}>{templateDeleting===template.id?'جارٍ الحذف…':'حذف'}</button></div></article>)}
              {templatesState==='ready'&&!filteredTemplates.length&&<p>لا توجد قوالب محفوظة مطابقة.</p>}
            </section>
          </div>}
          {libraryTab==='saved'&&<div className={styles.savedLibrary}>{filteredSaved.map(item=><div key={item.id} className={styles.savedCard} draggable title="اسحب البلوك وأفلته في موضعه داخل الصفحة" onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-saved',JSON.stringify({kind:item.kind,data:item.data}));event.dataTransfer.setData(item.kind==='module'?'application/x-marktone-saved-module':'application/x-marktone-saved-block',String(item.id||item.kind));event.dataTransfer.setData('text/plain',String(item.name||'Marktone saved block'));}}><button type="button" onClick={()=>insertSaved(item)}><span>{item.kind==='block'?'▥':'◇'}</span><div><b>{item.name}</b><small>{new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.createdAt))} · اسحب للمكان المطلوب</small></div></button><button type="button" onClick={()=>removeSaved(item.id)} title="حذف من المكتبة">×</button></div>)}{!filteredSaved.length&&<EmptyLibrary text="حدد صفًا أو موديولًا ثم اضغط حفظ في Saved من لوحة الخصائص."/>}</div>}
        </div>
        <button type="button" className={styles.collapseLibrary} onClick={()=>setLibraryOpen(false)}>‹</button>
      </aside>

      {!libraryOpen&&<button type="button" className={styles.openLibrary} onClick={()=>setLibraryOpen(true)}>Modules ＋</button>}

      <main className={styles.stage} data-builder-scroll-container="true" onClick={()=>{setSelection(null);setInspectorMode('page');}}>
        <div className={styles.stageMeta}><span>{DEVICE_LABELS[device]}</span><small>{device==='desktop'?'عرض مرن كامل':device==='tablet'?'820px':'390px'}</small>{previewMode&&<b>معاينة حية</b>}</div>
        <div className={styles.zoomStage} style={{transform:`scale(${zoom/100})`,width:`${10000/zoom}%`}}>
          <div className={`${styles.canvas} ${styles[`canvas_${device}`]}`}>
            {!nativeTemplateCanvas&&<div className={styles.liveHeader}><strong>{initialData?.site?.nameAr||'الموقع'}</strong><nav><span>الرئيسية</span><span>البرامج</span><span>من نحن</span><span>تواصل معنا</span></nav><b>سجل الآن</b>{!previewMode&&<small>هيدر الموقع</small>}</div>}
            <PageDocumentRenderer
              document={renderedDocument} editor={!previewMode&&!assistantPreview} device={device} selection={selection}
              onSelect={selectTarget} onDropAt={handleDrop} onDragStart={handleDragStart}
              onDuplicate={duplicateBlock} onDelete={deleteBlock} onMoveBlock={moveBlock} onColumnDrop={handleColumnDrop}
              onModuleDragStart={handleModuleDragStart} onDuplicateModule={duplicateModule}
              onDeleteModule={deleteModule} onInlineEdit={assistantPreview?undefined:updateInline} showOutlines={showOutlines}
            />
            {!nativeTemplateCanvas&&<div className={styles.liveFooter}><div><strong>{initialData?.site?.nameAr||'الموقع'}</strong><p>تجربة رقمية متكاملة مبنية بواسطة Marktone Builder.</p></div><span>© {new Date().getFullYear()}</span>{!previewMode&&<small>فوتر الموقع</small>}</div>}
          </div>
        </div>
      </main>

      <aside className={styles.inspector}>
        <div className={styles.inspectorHeader}><div><span>{inspectorMode==='page'?'إعدادات الصفحة':selected?selected.kind==='row'?'إعدادات الصف':selected.kind==='column'?'إعدادات العمود':BLOCK_CATALOG[(selected.module||selected.block)?.type]?.label:'الخصائص'}</span><small>{inspectorMode==='page'?'CSS والتنسيق العام':'المحتوى · التصميم · متقدم'}</small></div><button type="button" onClick={()=>setInspectorOpen(false)}>×</button></div>
        {inspectorMode==='page'?<PageInspector document={document} update={updatePageSetting}/>:<SelectionInspector selected={selected} update={updateSelected} context={context} onSaveToLibrary={saveToLibrary}/>} 
        {showVersions&&<VersionHistory versions={versions} busy={busy} onRestore={restore}/>} 
      </aside>
      {!inspectorOpen&&<button type="button" className={styles.openInspector} onClick={()=>setInspectorOpen(true)}>⚙</button>}
    </div>
    {sourceOpen&&<PageSourceModal document={document} page={entity} onClose={()=>setSourceOpen(false)} onAddHtml={addHtmlModule}/>} 
    <CmsBuilderAssistant
      open={assistantOpen} onClose={closeAssistant} document={document} entity={entity} context={context}
      selection={selection} device={device} proposal={assistantPreview?.proposal||null}
      onPlan={handleAssistantPlan} onApply={applyAssistantPreview} onDiscard={discardAssistantPreview}
    />
  </div>;
}

function hasNativeTemplate(value){
  return (Array.isArray(value?.blocks)?value.blocks:[]).some(block=>
    block?.type==='widget'&&['native-template-section','imported-template'].includes(block.props?.widgetKey)&&block.props?.templateOwnsPageShell!==false
  );
}
function documentUsesTemplate(value,template){
  const id=String(template?.id||'');
  const entryUrl=String(template?.entryUrl||'');
  const nativeUrl=String(template?.nativeUrl||'');
  const matches=block=>{
    const props=block?.props||{};
    if(id&&String(props.templateId||'')===id)return true;
    if(entryUrl&&String(props.entryUrl||'')===entryUrl)return true;
    if(nativeUrl&&String(props.nativeUrl||'')===nativeUrl)return true;
    if(block?.type==='columns'&&props.row===true){
      return (Array.isArray(props.items)?props.items:[]).some(column=>(Array.isArray(column?.modules)?column.modules:[]).some(matches));
    }
    return false;
  };
  return (Array.isArray(value?.blocks)?value.blocks:[]).some(matches);
}

function EmptyLibrary({text}){return <div className={styles.emptyLibrary}><span>◇</span><p>{text}</p></div>}
function documentRef(tag){return window.document.createElement(tag)}
