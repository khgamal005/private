'use client';

import Link from 'next/link';
import PageDocumentRenderer from './page-document-renderer';
import {BLOCK_CATALOG,BUILDER_TEMPLATES} from '../lib/website-builder';
import {usePageBuilder} from './use-page-builder';
import {
  BlockInspector,
  PageInspector,
  Status,
  VersionHistory
} from './page-builder-inspector';
import styles from './page-builder.module.css';

const DEVICE_LABELS={desktop:'كمبيوتر',tablet:'تابلت',mobile:'جوال'};

export default function PageBuilder({initialData}){
  const builder=usePageBuilder(initialData);
  const {
    page,document,selected,selectedId,setSelectedId,
    device,setDevice,history,dirty,busy,notice,setNotice,
    versions,showVersions,setShowVersions,templateKey,setTemplateKey,
    groups,undo,redo,addBlock,duplicateBlock,deleteBlock,
    handleDragStart,handleDrop,updateSelected,updatePageSetting,
    saveDraft,publish,restore,applyTemplate
  }=builder;

  return <div className={styles.builder} dir="rtl">
    <header className={styles.topbar}>
      <div className={styles.pageIdentity}>
        <Link href="/control/website/builder">← الصفحات</Link>
        <div>
          <small>Marktone Visual Builder</small>
          <h1>{page.title||'تصميم الصفحة'}</h1>
          <span dir="ltr">/p/{page.slug}</span>
        </div>
        <Status value={page.status}/>
        {dirty&&<b className={styles.unsaved}>تعديلات غير محفوظة</b>}
      </div>
      <div className={styles.topControls}>
        <div className={styles.deviceSwitch}>
          {Object.keys(DEVICE_LABELS).map(key=><button
            key={key}
            type="button"
            className={device===key?styles.active:''}
            onClick={()=>setDevice(key)}
          >{DEVICE_LABELS[key]}</button>)}
        </div>
        <button type="button" onClick={undo} disabled={!history.past.length} title="تراجع">↶</button>
        <button type="button" onClick={redo} disabled={!history.future.length} title="إعادة">↷</button>
        <button type="button" onClick={()=>setShowVersions(value=>!value)}>الإصدارات</button>
        <Link className={styles.previewLink} href={`/website-preview/${page.id}`} target="_blank">معاينة ↗</Link>
        <button type="button" className={styles.saveButton} onClick={saveDraft} disabled={Boolean(busy)}>
          {busy==='save-draft'?'جارٍ الحفظ…':'حفظ المسودة'}
        </button>
        <button type="button" className={styles.publishButton} onClick={publish} disabled={Boolean(busy)}>
          {busy==='publish'?'جارٍ النشر…':'نشر'}
        </button>
      </div>
    </header>

    {notice&&<div className={`${styles.notice} ${notice.type==='error'?styles.noticeError:styles.noticeSuccess}`}>
      {notice.text}<button type="button" onClick={()=>setNotice(null)}>×</button>
    </div>}

    <div className={styles.body}>
      <aside className={styles.library}>
        <div className={styles.sideHeader}>
          <span>مكتبة العناصر</span><small>اسحب أو اضغط للإضافة</small>
        </div>
        <div className={styles.templateBox}>
          <label><span>ابدأ من قالب</span><select value={templateKey} onChange={event=>setTemplateKey(event.target.value)}>
            {Object.entries(BUILDER_TEMPLATES).map(([key,item])=><option key={key} value={key}>{item.label}</option>)}
          </select></label>
          <button type="button" onClick={applyTemplate}>تطبيق القالب</button>
        </div>
        <div className={styles.libraryGroups}>
          {groups.map(group=><section key={group.category}>
            <h2>{group.category}</h2>
            <div>{group.items.map(item=><button
              type="button"
              key={item.type}
              draggable
              onDragStart={event=>{
                event.dataTransfer.effectAllowed='copy';
                event.dataTransfer.setData(
                  'application/x-marktone-new-block',
                  item.type
                );
              }}
              onClick={()=>addBlock(item.type)}
              title={item.description}
            ><span>{item.icon}</span><b>{item.label}</b><small>{item.description}</small></button>)}</div>
          </section>)}
        </div>
      </aside>

      <main className={styles.stage} onClick={()=>setSelectedId('')}>
        <div className={styles.stageMeta}>
          <span>{DEVICE_LABELS[device]}</span>
          <small>{device==='desktop'?'عرض مرن كامل':device==='tablet'?'820px':'390px'}</small>
        </div>
        <div className={`${styles.canvas} ${styles[`canvas_${device}`]}`}>
          <div className={styles.lockedHeader}>
            <strong>Marktone</strong>
            <nav><span>الرئيسية</span><span>الخدمات</span><span>تواصل معنا</span></nav>
            <b>دخول العملاء</b><small>هيدر عالمي محمي</small>
          </div>
          <PageDocumentRenderer
            document={document}
            editor
            device={device}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDropAt={handleDrop}
            onDragStart={handleDragStart}
            onDuplicate={duplicateBlock}
            onDelete={deleteBlock}
          />
          <div className={styles.lockedFooter}>
            <strong>Marktone</strong><span>فوتر عالمي محمي</span>
          </div>
        </div>
      </main>

      <aside className={styles.inspector}>
        <div className={styles.sideHeader}>
          <span>{selected?BLOCK_CATALOG[selected.type]?.label:'إعدادات الصفحة'}</span>
          <small>{selected?'خصائص العنصر المحدد':'اختر عنصرًا لتعديله'}</small>
        </div>
        {selected
          ?<BlockInspector block={selected} update={updateSelected}/>
          :<PageInspector document={document} update={updatePageSetting}/>} 
        {showVersions&&<VersionHistory
          versions={versions}
          busy={busy}
          onRestore={restore}
        />} 
      </aside>
    </div>
  </div>;
}
