'use client';

import Link from 'next/link';
import {useEffect,useMemo,useRef,useState} from 'react';
import PageDocumentRenderer from './page-document-renderer';
import {BLOCK_CATALOG,BUILDER_TEMPLATES,ROW_LAYOUTS,SECTION_PRESETS} from '../lib/website-builder';
import {cmsBasePath,cmsPreviewPath} from '../lib/cms';
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
    addRow,addBlock,insertPreset,insertSaved,duplicateBlock,deleteBlock,duplicateModule,deleteModule,
    handleDragStart,handleModuleDragStart,handleDrop,handleColumnDrop,updateSelected,updateInline,
    updatePageSetting,importDocument,saveDraft,publish,restore,applyTemplate
  }=builder;
  const [libraryTab,setLibraryTab]=useState('modules');
  const [query,setQuery]=useState('');
  const [inspectorMode,setInspectorMode]=useState('selection');
  const [libraryOpen,setLibraryOpen]=useState(true);
  const [inspectorOpen,setInspectorOpen]=useState(true);
  const [savedItems,setSavedItems]=useState([]);
  const importRef=useRef(null);
  const isArticle=entity.type==='article';
  const backHref=`${cmsBasePath(context)}?section=${isArticle?'articles':'pages'}`;
  const publicPath=isArticle?`/articles/${entity.slug}`:entity.isHome?'/':`/p/${entity.slug}`;
  const storageKey=`marktone-builder-saved:${context.siteKey||'marktone-main'}:${context.tenantSlug||'platform'}`;

  useEffect(()=>{try{const stored=JSON.parse(localStorage.getItem(storageKey)||'[]');setSavedItems(Array.isArray(stored)?stored:[]);}catch{setSavedItems([]);}},[storageKey]);

  const filteredGroups=useMemo(()=>{
    const term=query.trim().toLowerCase();
    if(!term)return groups;
    return groups.map(group=>({...group,items:group.items.filter(item=>`${item.label} ${item.description} ${item.type}`.toLowerCase().includes(term))})).filter(group=>group.items.length);
  },[groups,query]);
  const filteredPresets=useMemo(()=>Object.entries(SECTION_PRESETS).filter(([,item])=>!query||`${item.label} ${item.description}`.includes(query)),[query]);
  const filteredSaved=useMemo(()=>savedItems.filter(item=>!query||`${item.name} ${item.type}`.toLowerCase().includes(query.toLowerCase())),[savedItems,query]);

  function selectTarget(target){setSelection(target);setInspectorMode('selection');if(!inspectorOpen)setInspectorOpen(true);}
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
    try{const parsed=JSON.parse(await file.text());if(!window.confirm('سيتم استيراد التصميم داخل المسودة الحالية. متابعة؟'))return;importDocument(parsed);}catch{setNotice({type:'error',text:'ملف التصميم غير صالح.'});}finally{event.target.value='';}
  }

  return <div className={styles.builder} dir="rtl">
    <header className={styles.topbar}>
      <div className={styles.primaryActions}>
        <Link href={backHref} className={styles.backButton} title="العودة إلى إدارة الموقع">⌄</Link>
        <button type="button" className={styles.saveButton} onClick={saveDraft} disabled={Boolean(busy)}>{busy==='save-draft'?'جارٍ الحفظ…':'SAVE'}</button>
        <Link href={backHref} className={styles.closeButton} title="إغلاق المصمم">×</Link>
        <div className={styles.pageIdentity}><small>Marktone Builder Pro</small><strong>{entity.title||'تصميم المحتوى'}</strong><span dir="ltr">{publicPath}</span></div>
        <Status value={entity.status}/>{dirty&&<b className={styles.unsaved}>غير محفوظ</b>}
      </div>

      <div className={styles.utilityActions}>
        <button type="button" title="مساعدة">?</button>
        <button type="button" title="إظهار حدود العناصر" className={showOutlines?styles.activeUtility:''} onClick={()=>setShowOutlines(value=>!value)}>⌗</button>
        <button type="button" title="CSS وإعدادات الصفحة" className={inspectorMode==='page'?styles.activeUtility:''} onClick={()=>{setInspectorMode('page');setInspectorOpen(true);}}>CSS</button>
        <button type="button" title="استيراد التصميم" onClick={()=>importRef.current?.click()}>⇧</button>
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={importDesign}/>
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

    {notice&&<div className={`${styles.notice} ${notice.type==='error'?styles.noticeError:styles.noticeSuccess}`}><span>{notice.text}</span><button type="button" onClick={()=>setNotice(null)}>×</button></div>}

    <div className={`${styles.body} ${!libraryOpen?styles.libraryClosed:''} ${!inspectorOpen?styles.inspectorClosed:''}`}>
      <aside className={styles.library}>
        <div className={styles.libraryTabs}>{[['saved','Saved'],['blocks','Blocks'],['modules','Modules']].map(([key,label])=><button type="button" key={key} className={libraryTab===key?styles.activeTab:''} onClick={()=>setLibraryTab(key)}>{label}{key==='saved'&&savedItems.length>0&&<b>{savedItems.length}</b>}</button>)}</div>
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
          {libraryTab==='saved'&&<div className={styles.savedLibrary}>{filteredSaved.map(item=><div key={item.id} className={styles.savedCard} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-saved',JSON.stringify({kind:item.kind,data:item.data}));}}><button type="button" onClick={()=>insertSaved(item)}><span>{item.kind==='block'?'▥':'◇'}</span><div><b>{item.name}</b><small>{new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.createdAt))}</small></div></button><button type="button" onClick={()=>removeSaved(item.id)} title="حذف من المكتبة">×</button></div>)}{!filteredSaved.length&&<EmptyLibrary text="حدد صفًا أو موديولًا ثم اضغط حفظ في Saved من لوحة الخصائص."/>}</div>}
        </div>
        <button type="button" className={styles.collapseLibrary} onClick={()=>setLibraryOpen(false)}>‹</button>
      </aside>

      {!libraryOpen&&<button type="button" className={styles.openLibrary} onClick={()=>setLibraryOpen(true)}>Modules ＋</button>}

      <main className={styles.stage} onClick={()=>{setSelection(null);setInspectorMode('page');}}>
        <div className={styles.stageMeta}><span>{DEVICE_LABELS[device]}</span><small>{device==='desktop'?'عرض مرن كامل':device==='tablet'?'820px':'390px'}</small>{previewMode&&<b>معاينة حية</b>}</div>
        <div className={styles.zoomStage} style={{transform:`scale(${zoom/100})`,width:`${10000/zoom}%`}}>
          <div className={`${styles.canvas} ${styles[`canvas_${device}`]}`}>
            <div className={styles.liveHeader}><strong>{initialData?.site?.nameAr||'الموقع'}</strong><nav><span>الرئيسية</span><span>البرامج</span><span>من نحن</span><span>تواصل معنا</span></nav><b>سجل الآن</b>{!previewMode&&<small>هيدر الموقع</small>}</div>
            <PageDocumentRenderer
              document={document} editor={!previewMode} device={device} selection={selection}
              onSelect={selectTarget} onDropAt={handleDrop} onDragStart={handleDragStart}
              onDuplicate={duplicateBlock} onDelete={deleteBlock} onColumnDrop={handleColumnDrop}
              onModuleDragStart={handleModuleDragStart} onDuplicateModule={duplicateModule}
              onDeleteModule={deleteModule} onInlineEdit={updateInline} showOutlines={showOutlines}
            />
            <div className={styles.liveFooter}><div><strong>{initialData?.site?.nameAr||'الموقع'}</strong><p>تجربة رقمية متكاملة مبنية بواسطة Marktone Builder.</p></div><span>© {new Date().getFullYear()}</span>{!previewMode&&<small>فوتر الموقع</small>}</div>
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
  </div>;
}

function EmptyLibrary({text}){return <div className={styles.emptyLibrary}><span>◇</span><p>{text}</p></div>}
function documentRef(tag){return window.document.createElement(tag)}
