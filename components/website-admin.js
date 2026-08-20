'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useMemo,useState} from 'react';
import styles from './website-admin.module.css';

const TABS=[
  {key:'overview',label:'نظرة عامة'},
  {key:'menu',label:'القائمة العلوية'},
  {key:'sections',label:'أقسام الرئيسية'},
  {key:'pages',label:'الصفحات'},
  {key:'articles',label:'المقالات'},
  {key:'messages',label:'رسائل الموقع'}
];
const STATUS_LABELS={draft:'مسودة',published:'منشور',archived:'مؤرشف',maintenance:'صيانة',new:'جديدة',in_progress:'قيد المتابعة',resolved:'تمت المعالجة',spam:'مزعجة'};

export default function WebsiteAdmin({initialData}){
  const router=useRouter();
  const [tab,setTab]=useState('overview');
  const [editor,setEditor]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState(null);
  const data=initialData||{};
  const site=data.site||{};
  const stats=data.stats||{};

  async function mutate(action,payload,{close=true,message='تم حفظ التعديلات'}={}){
    setBusy(action);
    setNotice(null);
    try{
      const response=await fetch(`/api/platform/website/${action}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result?.error||'تعذر حفظ التعديلات');
      if(close)setEditor(null);
      setNotice({type:'success',text:message});
      router.refresh();
      return true;
    }catch(error){
      setNotice({type:'error',text:error.message});
      return false;
    }finally{setBusy('');}
  }

  async function archive(type,item){
    if(!window.confirm(`هل تريد أرشفة ${type==='section'?'هذا القسم':type==='page'?'هذه الصفحة':type==='article'?'هذا المقال':'هذا العنصر'}؟`))return;
    const action={menu:'delete-menu-item',section:'delete-section',page:'delete-page',article:'delete-article'}[type];
    await mutate(action,{id:item.id},{message:'تمت الأرشفة'});
  }

  return <div className={styles.workspace} dir="rtl">
    <header className={styles.hero}>
      <div>
        <span className={styles.kicker}>إدارة حضور أودير الرقمي</span>
        <h1>إدارة الموقع</h1>
        <p>تحكم في الهيدر والقائمة ومحتوى الصفحة الرئيسية والصفحات والمقالات من نفس لوحة المنصة.</p>
      </div>
      <div className={styles.heroActions}>
        <Link href="/" target="_blank" className={styles.previewButton}>معاينة الموقع ↗</Link>
        <button type="button" onClick={()=>router.refresh()} className={styles.refreshButton}>تحديث البيانات</button>
      </div>
    </header>

    {notice&&<div className={`${styles.notice} ${notice.type==='error'?styles.errorNotice:styles.successNotice}`}>{notice.text}<button type="button" onClick={()=>setNotice(null)}>×</button></div>}

    <section className={styles.stats}>
      <Stat label="أقسام منشورة" value={stats.publishedSections??0}/>
      <Stat label="صفحات منشورة" value={stats.publishedPages??0}/>
      <Stat label="مقالات منشورة" value={stats.publishedArticles??0}/>
      <Stat label="رسائل جديدة" value={stats.newSubmissions??0} accent={Number(stats.newSubmissions)>0}/>
    </section>

    <nav className={styles.tabs} aria-label="أقسام إدارة الموقع">
      {TABS.map(item=><button type="button" key={item.key} className={tab===item.key?styles.activeTab:''} onClick={()=>setTab(item.key)}>{item.label}</button>)}
    </nav>

    {tab==='overview'&&<Overview site={site} revisions={data.revisions||[]} busy={busy} onSave={(payload)=>mutate('save-site',payload,{close:false})}/>} 
    {tab==='menu'&&<MenuPanel rows={data.menu||[]} onCreate={()=>setEditor({type:'menu',value:newMenu()})} onEdit={value=>setEditor({type:'menu',value})} onArchive={value=>archive('menu',value)}/>} 
    {tab==='sections'&&<SectionsPanel rows={data.sections||[]} onCreate={()=>setEditor({type:'section',value:newSection()})} onEdit={value=>setEditor({type:'section',value})} onArchive={value=>archive('section',value)}/>} 
    {tab==='pages'&&<PagesPanel rows={data.pages||[]} onCreate={()=>setEditor({type:'page',value:newPage()})} onEdit={value=>setEditor({type:'page',value})} onArchive={value=>archive('page',value)}/>} 
    {tab==='articles'&&<ArticlesPanel rows={data.articles||[]} onCreate={()=>setEditor({type:'article',value:newArticle()})} onEdit={value=>setEditor({type:'article',value})} onArchive={value=>archive('article',value)}/>} 
    {tab==='messages'&&<MessagesPanel rows={data.submissions||[]} busy={busy} onStatus={(id,status)=>mutate('set-submission-status',{id,status},{close:false,message:'تم تحديث حالة الرسالة'})}/>} 

    {editor&&<EditorModal editor={editor} busy={busy} onClose={()=>setEditor(null)} onSubmit={(action,payload)=>mutate(action,payload)}/>} 
  </div>;
}

function Overview({site,revisions,busy,onSave}){
  const settings=site.settings||{};
  const theme=site.theme||{};
  function submit(event){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    onSave({
      nameAr:value(form,'nameAr'),nameEn:value(form,'nameEn'),status:value(form,'status'),
      settings:{
        siteTitle:value(form,'siteTitle'),description:value(form,'description'),
        customerLoginLabel:value(form,'customerLoginLabel'),customerLoginUrl:value(form,'customerLoginUrl'),
        contactCtaLabel:value(form,'contactCtaLabel'),contactCtaUrl:value(form,'contactCtaUrl'),
        contactEmail:value(form,'contactEmail'),contactPhone:value(form,'contactPhone'),
        country:value(form,'country'),footerText:value(form,'footerText')
      },
      theme:{navy:value(form,'navy'),navySoft:value(form,'navySoft'),gold:value(form,'gold'),paper:value(form,'paper'),white:value(form,'white')}
    });
  }
  return <div className={styles.twoColumns}>
    <form className={styles.panel} onSubmit={submit}>
      <PanelHeader title="الإعدادات العامة" description="العناوين، زر دخول العملاء، بيانات التواصل، وألوان الهوية."/>
      <div className={styles.formGrid}>
        <Field label="اسم الموقع بالعربية" name="nameAr" defaultValue={site.name_ar}/>
        <Field label="الاسم بالإنجليزية" name="nameEn" defaultValue={site.name_en}/>
        <Field label="حالة الموقع" name="status" type="select" defaultValue={site.status} options={siteStatuses}/>
        <Field label="عنوان المتصفح وSEO" name="siteTitle" defaultValue={settings.siteTitle}/>
        <Field label="وصف الموقع" name="description" defaultValue={settings.description} type="textarea" wide/>
        <Field label="نص زر دخول العملاء" name="customerLoginLabel" defaultValue={settings.customerLoginLabel}/>
        <Field label="رابط دخول العملاء" name="customerLoginUrl" defaultValue={settings.customerLoginUrl} dir="ltr"/>
        <Field label="نص زر التواصل" name="contactCtaLabel" defaultValue={settings.contactCtaLabel}/>
        <Field label="رابط زر التواصل" name="contactCtaUrl" defaultValue={settings.contactCtaUrl} dir="ltr"/>
        <Field label="بريد التواصل" name="contactEmail" defaultValue={settings.contactEmail} dir="ltr"/>
        <Field label="جوال التواصل" name="contactPhone" defaultValue={settings.contactPhone} dir="ltr"/>
        <Field label="الدولة" name="country" defaultValue={settings.country}/>
        <Field label="نص الفوتر" name="footerText" defaultValue={settings.footerText} type="textarea" wide/>
      </div>
      <h3 className={styles.subheading}>ألوان الواجهة</h3>
      <div className={styles.colorGrid}>
        <ColorField label="الكحلي" name="navy" defaultValue={theme.navy||'#06182e'}/>
        <ColorField label="الكحلي الفاتح" name="navySoft" defaultValue={theme.navySoft||'#0b2949'}/>
        <ColorField label="الذهبي" name="gold" defaultValue={theme.gold||'#e6b34e'}/>
        <ColorField label="الخلفية الكريمية" name="paper" defaultValue={theme.paper||'#f7f2e8'}/>
        <ColorField label="الأبيض" name="white" defaultValue={theme.white||'#ffffff'}/>
      </div>
      <div className={styles.formActions}><button className={styles.primaryAction} disabled={busy==='save-site'}>{busy==='save-site'?'جارٍ الحفظ…':'حفظ إعدادات الموقع'}</button></div>
    </form>
    <aside className={styles.panel}>
      <PanelHeader title="آخر التعديلات" description="نسخ محفوظة تلقائيًا قبل تعديل أو أرشفة أي محتوى."/>
      <div className={styles.timeline}>
        {revisions.slice(0,12).map(row=><div key={row.id}><span>{entityLabel(row.entity_type)}</span><strong>الإصدار {row.revision_number}</strong><time>{formatDateTime(row.created_at)}</time></div>)}
        {!revisions.length&&<Empty text="ستظهر هنا محفوظات التعديل بعد أول تحديث."/>}
      </div>
      <div className={styles.safetyNote}><strong>نشر آمن</strong><p>المحتوى العام لا يظهر للزوار إلا عندما تكون حالته «منشور». الحذف يتحول إلى أرشفة مع الاحتفاظ بسجل سابق.</p></div>
    </aside>
  </div>;
}

function MenuPanel({rows,onCreate,onEdit,onArchive}){
  return <section className={styles.panel}>
    <PanelHeader title="القائمة العلوية" description="أضف عناصر الهيدر ورتبها وحدد الرابط وحالة الظهور." actionLabel="إضافة عنصر" onAction={onCreate}/>
    <div className={styles.tableWrap}><table><thead><tr><th>العنصر</th><th>الرابط</th><th>النوع</th><th>الترتيب</th><th>الحالة</th><th/></tr></thead><tbody>
      {rows.map(row=><tr key={row.id}><td><strong>{row.label}</strong>{!row.is_visible&&<small>مخفي</small>}</td><td dir="ltr">{row.href}</td><td>{kindLabel(row.item_kind)}</td><td>{row.sort_order}</td><td><Status value={row.status}/></td><td><RowActions onEdit={()=>onEdit(row)} onArchive={()=>onArchive(row)}/></td></tr>)}
    </tbody></table>{!rows.length&&<Empty text="لا توجد عناصر في القائمة."/>}</div>
  </section>;
}

function SectionsPanel({rows,onCreate,onEdit,onArchive}){
  return <section className={styles.panel}>
    <PanelHeader title="أقسام الصفحة الرئيسية" description="كل قسم مستقل ويمكن ترتيبه أو إخفاؤه أو نشره كمسودة." actionLabel="إضافة قسم" onAction={onCreate}/>
    <div className={styles.cardList}>{rows.map(row=><article className={styles.contentRow} key={row.id}>
      <div className={styles.orderBadge}>{row.sort_order}</div><div className={styles.contentRowMain}><span>{sectionTypeLabel(row.section_type)} · #{row.section_key}</span><h3>{row.title}</h3><p>{row.summary||row.body||'بدون وصف'}</p></div>
      <div className={styles.rowMeta}><Status value={row.status}/>{!row.is_visible&&<span className={styles.mutedChip}>مخفي</span>}</div><RowActions onEdit={()=>onEdit(row)} onArchive={()=>onArchive(row)}/>
    </article>)}{!rows.length&&<Empty text="لا توجد أقسام بعد."/>}</div>
  </section>;
}

function PagesPanel({rows,onCreate,onEdit,onArchive}){
  return <section className={styles.panel}>
    <PanelHeader title="الصفحات" description="أنشئ صفحات مستقلة مثل من نحن والخدمات وسياسة الخصوصية." actionLabel="صفحة جديدة" onAction={onCreate}/>
    <div className={styles.cardList}>{rows.map(row=><article className={styles.contentRow} key={row.id}>
      <div className={styles.pageIcon}>P</div><div className={styles.contentRowMain}><span dir="ltr">/p/{row.slug}</span><h3>{row.title}</h3><p>{row.excerpt||'بدون وصف مختصر'}</p></div>
      <div className={styles.rowMeta}><Status value={row.status}/>{row.show_in_menu&&<span className={styles.mutedChip}>في القائمة</span>}</div>
      <div className={styles.inlineActions}>{row.status==='published'&&<Link href={`/p/${row.slug}`} target="_blank">معاينة</Link>}<RowActions onEdit={()=>onEdit(row)} onArchive={()=>onArchive(row)}/></div>
    </article>)}{!rows.length&&<Empty text="لم تتم إضافة صفحات بعد."/>}</div>
  </section>;
}

function ArticlesPanel({rows,onCreate,onEdit,onArchive}){
  return <section className={styles.panel}>
    <PanelHeader title="المقالات" description="اكتب المقالات واحفظها كمسودة ثم انشرها عند الجاهزية." actionLabel="مقال جديد" onAction={onCreate}/>
    <div className={styles.cardList}>{rows.map(row=><article className={styles.contentRow} key={row.id}>
      <div className={styles.pageIcon}>A</div><div className={styles.contentRowMain}><span>{row.category||'غير مصنف'} · <b dir="ltr">/articles/{row.slug}</b></span><h3>{row.title}</h3><p>{row.excerpt||'بدون وصف مختصر'}</p></div>
      <div className={styles.rowMeta}><Status value={row.status}/>{row.featured&&<span className={styles.featuredChip}>مميز</span>}</div>
      <div className={styles.inlineActions}>{row.status==='published'&&<Link href={`/articles/${row.slug}`} target="_blank">معاينة</Link>}<RowActions onEdit={()=>onEdit(row)} onArchive={()=>onArchive(row)}/></div>
    </article>)}{!rows.length&&<Empty text="لم تتم إضافة مقالات بعد."/>}</div>
  </section>;
}

function MessagesPanel({rows,busy,onStatus}){
  const visible=rows.filter(row=>row.status!=='archived');
  return <section className={styles.panel}>
    <PanelHeader title="رسائل الموقع" description="طلبات التواصل الواردة من نموذج الموقع العام."/>
    <div className={styles.messageList}>{visible.map(row=><article key={row.id} className={`${styles.messageCard} ${row.status==='new'?styles.newMessage:''}`}>
      <div className={styles.messageHeader}><div><strong>{row.name}</strong><span>{row.organization||'بدون اسم منشأة'} · {row.reference_key}</span></div><Status value={row.status}/></div>
      <p>{row.message}</p>
      <div className={styles.messageContacts}>{row.phone&&<a href={`tel:${row.phone}`} dir="ltr">{row.phone}</a>}{row.email&&<a href={`mailto:${row.email}`} dir="ltr">{row.email}</a>}<time>{formatDateTime(row.created_at)}</time></div>
      <div className={styles.messageActions}><label>تحديث الحالة<select value={row.status} disabled={busy==='set-submission-status'} onChange={event=>onStatus(row.id,event.target.value)}>{messageStatuses.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
    </article>)}{!visible.length&&<Empty text="لا توجد رسائل واردة حتى الآن."/>}</div>
  </section>;
}

function EditorModal({editor,busy,onClose,onSubmit}){
  const {type,value:row}=editor;
  const title={menu:row.id?'تعديل عنصر القائمة':'إضافة عنصر للقائمة',section:row.id?'تعديل القسم':'إضافة قسم',page:row.id?'تعديل الصفحة':'إضافة صفحة',article:row.id?'تعديل المقال':'إضافة مقال'}[type];
  function submit(event){
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    if(type==='menu')onSubmit('save-menu-item',menuPayload(form,row));
    if(type==='section')onSubmit('save-section',sectionPayload(form,row));
    if(type==='page')onSubmit('save-page',pagePayload(form,row));
    if(type==='article')onSubmit('save-article',articlePayload(form,row));
  }
  const action=`save-${type==='menu'?'menu-item':type}`;
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
      <header><div><span>محرر المحتوى</span><h2>{title}</h2></div><button type="button" onClick={onClose} aria-label="إغلاق">×</button></header>
      <form onSubmit={submit}>
        <div className={styles.modalBody}>
          {type==='menu'&&<MenuFields row={row}/>} 
          {type==='section'&&<SectionFields row={row}/>} 
          {type==='page'&&<PageFields row={row}/>} 
          {type==='article'&&<ArticleFields row={row}/>} 
        </div>
        <footer><button type="button" className={styles.cancelAction} onClick={onClose}>إلغاء</button><button className={styles.primaryAction} disabled={busy===action}>{busy===action?'جارٍ الحفظ…':'حفظ التعديلات'}</button></footer>
      </form>
    </section>
  </div>;
}

function MenuFields({row}){return <div className={styles.formGrid}>
  <Field label="اسم العنصر" name="label" defaultValue={row.label} required/>
  <Field label="الرابط" name="href" defaultValue={row.href} required dir="ltr" hint="مثال: #solutions أو /p/about أو رابط خارجي"/>
  <Field label="النوع" name="kind" type="select" defaultValue={row.item_kind||'anchor'} options={menuKinds}/>
  <Field label="الترتيب" name="sortOrder" type="number" defaultValue={row.sort_order??100}/>
  <Field label="الحالة" name="status" type="select" defaultValue={row.status||'published'} options={contentStatuses}/>
  <Checks><Check name="isVisible" defaultChecked={row.is_visible!==false} label="ظاهر في القائمة"/><Check name="openInNewTab" defaultChecked={row.open_in_new_tab} label="فتح في نافذة جديدة"/></Checks>
</div>}

function SectionFields({row}){return <div className={styles.formGrid}>
  <Field label="مفتاح القسم" name="sectionKey" defaultValue={row.section_key} required dir="ltr" hint="إنجليزي دون مسافات، ويستخدم كرابط #"/>
  <Field label="نوع التصميم" name="sectionType" type="select" defaultValue={row.section_type||'cards'} options={sectionTypes}/>
  <Field label="العنوان الصغير" name="eyebrow" defaultValue={row.eyebrow}/>
  <Field label="العنوان الرئيسي" name="title" defaultValue={row.title} required/>
  <Field label="الملخص" name="summary" defaultValue={row.summary} type="textarea" wide/>
  <Field label="النص الإضافي" name="body" defaultValue={row.body} type="textarea" wide/>
  <Field label="نص الزر الأول" name="primaryLabel" defaultValue={row.primary_cta?.label}/>
  <Field label="رابط الزر الأول" name="primaryHref" defaultValue={row.primary_cta?.href} dir="ltr"/>
  <Field label="نص الزر الثاني" name="secondaryLabel" defaultValue={row.secondary_cta?.label}/>
  <Field label="رابط الزر الثاني" name="secondaryHref" defaultValue={row.secondary_cta?.href} dir="ltr"/>
  <Field label="العناصر الداخلية" name="itemsText" defaultValue={itemsToText(row.items)} type="textarea" wide rows={8} hint="كل سطر: العنوان | الوصف"/>
  <Field label="نمط الخلفية" name="styleVariant" type="select" defaultValue={row.style_variant||'light'} options={sectionVariants}/>
  <Field label="الترتيب" name="sortOrder" type="number" defaultValue={row.sort_order??100}/>
  <Field label="الحالة" name="status" type="select" defaultValue={row.status||'draft'} options={contentStatuses}/>
  <Checks><Check name="isVisible" defaultChecked={row.is_visible!==false} label="إظهار القسم"/></Checks>
</div>}

function PageFields({row}){return <div className={styles.formGrid}>
  <Field label="عنوان الصفحة" name="title" defaultValue={row.title} required/>
  <Field label="الرابط المختصر" name="slug" defaultValue={row.slug} required dir="ltr" hint="مثال: about-marktone"/>
  <Field label="اسمها في القائمة" name="menuLabel" defaultValue={row.menu_label}/>
  <Field label="الترتيب في القائمة" name="menuOrder" type="number" defaultValue={row.menu_order??100}/>
  <Field label="الوصف المختصر" name="excerpt" defaultValue={row.excerpt} type="textarea" wide/>
  <Field label="محتوى الصفحة" name="body" defaultValue={row.body} type="textarea" wide rows={15} hint="افصل بين الفقرات بسطر فارغ، واستخدم - في بداية السطر للقوائم."/>
  <Field label="رابط صورة الغلاف" name="coverUrl" defaultValue={row.cover_url} dir="ltr" wide/>
  <Field label="عنوان SEO" name="seoTitle" defaultValue={row.seo_title}/>
  <Field label="وصف SEO" name="seoDescription" defaultValue={row.seo_description} type="textarea"/>
  <Field label="الحالة" name="status" type="select" defaultValue={row.status||'draft'} options={contentStatuses}/>
  <Checks><Check name="showInMenu" defaultChecked={row.show_in_menu} label="إظهار الصفحة في القائمة العلوية"/></Checks>
</div>}

function ArticleFields({row}){return <div className={styles.formGrid}>
  <Field label="عنوان المقال" name="title" defaultValue={row.title} required/>
  <Field label="الرابط المختصر" name="slug" defaultValue={row.slug} required dir="ltr" hint="مثال: sales-growth-guide"/>
  <Field label="التصنيف" name="category" defaultValue={row.category}/>
  <Field label="اسم الكاتب" name="authorName" defaultValue={row.author_name||'فريق أودير'}/>
  <Field label="الوصف المختصر" name="excerpt" defaultValue={row.excerpt} type="textarea" wide/>
  <Field label="محتوى المقال" name="body" defaultValue={row.body} type="textarea" wide rows={16} hint="افصل بين الفقرات بسطر فارغ، واستخدم - في بداية السطر للقوائم."/>
  <Field label="رابط صورة الغلاف" name="coverUrl" defaultValue={row.cover_url} dir="ltr" wide/>
  <Field label="عنوان SEO" name="seoTitle" defaultValue={row.seo_title}/>
  <Field label="وصف SEO" name="seoDescription" defaultValue={row.seo_description} type="textarea"/>
  <Field label="الحالة" name="status" type="select" defaultValue={row.status||'draft'} options={contentStatuses}/>
  <Checks><Check name="featured" defaultChecked={row.featured} label="مقال مميز"/></Checks>
</div>}

function Field({label,name,defaultValue='',type='text',options=[],wide=false,required=false,hint='',rows=4,dir}){
  const className=wide?styles.wideField:'';
  return <label className={className}><span>{label}{required&&' *'}</span>
    {type==='textarea'?<textarea name={name} defaultValue={defaultValue||''} required={required} rows={rows} dir={dir}/>
      :type==='select'?<select name={name} defaultValue={defaultValue||''}>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>
      :<input name={name} type={type} defaultValue={defaultValue??''} required={required} dir={dir}/>} 
    {hint&&<small>{hint}</small>}
  </label>;
}
function ColorField({label,name,defaultValue}){return <label className={styles.colorField}><span>{label}</span><div><input name={name} type="color" defaultValue={defaultValue}/><input name={`${name}Text`} value={defaultValue} readOnly dir="ltr" tabIndex={-1}/></div></label>}
function Checks({children}){return <div className={styles.checks}>{children}</div>}
function Check({name,label,defaultChecked}){return <label><input type="checkbox" name={name} defaultChecked={Boolean(defaultChecked)}/><span>{label}</span></label>}
function PanelHeader({title,description,actionLabel,onAction}){return <header className={styles.panelHeader}><div><h2>{title}</h2><p>{description}</p></div>{actionLabel&&<button type="button" onClick={onAction}>{actionLabel} +</button>}</header>}
function Stat({label,value,accent=false}){return <article className={accent?styles.accentStat:''}><strong>{value}</strong><span>{label}</span></article>}
function Status({value}){return <span className={`${styles.status} ${styles[`status_${value}`]||''}`}>{STATUS_LABELS[value]||value}</span>}
function RowActions({onEdit,onArchive}){return <div className={styles.rowActions}><button type="button" onClick={onEdit}>تعديل</button><button type="button" onClick={onArchive}>أرشفة</button></div>}
function Empty({text}){return <div className={styles.empty}>{text}</div>}

function menuPayload(form,row){return {id:row.id||undefined,label:value(form,'label'),href:value(form,'href'),kind:value(form,'kind'),sortOrder:numberValue(form,'sortOrder',100),status:value(form,'status'),isVisible:checked(form,'isVisible'),openInNewTab:checked(form,'openInNewTab')}}
function sectionPayload(form,row){return {id:row.id||undefined,sectionKey:value(form,'sectionKey').toLowerCase(),sectionType:value(form,'sectionType'),eyebrow:value(form,'eyebrow'),title:value(form,'title'),summary:value(form,'summary'),body:value(form,'body'),primaryCta:{label:value(form,'primaryLabel'),href:value(form,'primaryHref')},secondaryCta:{label:value(form,'secondaryLabel'),href:value(form,'secondaryHref')},items:textToItems(value(form,'itemsText')),media:row.media||{},styleVariant:value(form,'styleVariant'),sortOrder:numberValue(form,'sortOrder',100),status:value(form,'status'),isVisible:checked(form,'isVisible')}}
function pagePayload(form,row){return {id:row.id||undefined,title:value(form,'title'),slug:value(form,'slug').toLowerCase(),menuLabel:value(form,'menuLabel'),menuOrder:numberValue(form,'menuOrder',100),excerpt:value(form,'excerpt'),body:value(form,'body'),coverUrl:value(form,'coverUrl'),seoTitle:value(form,'seoTitle'),seoDescription:value(form,'seoDescription'),templateKey:row.template_key||'standard',content:row.content||{},showInMenu:checked(form,'showInMenu'),status:value(form,'status')}}
function articlePayload(form,row){return {id:row.id||undefined,title:value(form,'title'),slug:value(form,'slug').toLowerCase(),category:value(form,'category'),authorName:value(form,'authorName'),excerpt:value(form,'excerpt'),body:value(form,'body'),coverUrl:value(form,'coverUrl'),seoTitle:value(form,'seoTitle'),seoDescription:value(form,'seoDescription'),featured:checked(form,'featured'),status:value(form,'status')}}
function value(form,key){return String(form.get(key)||'').trim()}
function numberValue(form,key,fallback){const result=Number(form.get(key));return Number.isFinite(result)?result:fallback}
function checked(form,key){return form.get(key)==='on'}
function itemsToText(items){return (Array.isArray(items)?items:[]).map(item=>`${item.title||''} | ${item.description||''}`).join('\n')}
function textToItems(text){return String(text||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const [title,...rest]=line.split('|');return {title:title.trim(),description:rest.join('|').trim()}}).filter(item=>item.title)}
function formatDateTime(value){try{return new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}catch{return ''}}
function entityLabel(value){return {site:'إعدادات الموقع',menu_item:'القائمة',section:'قسم',page:'صفحة',article:'مقال'}[value]||value}
function kindLabel(value){return {anchor:'قسم داخل الرئيسية',page:'صفحة',article:'مقال',external:'رابط خارجي',system:'رابط النظام'}[value]||value}
function sectionTypeLabel(value){return Object.fromEntries(sectionTypes.map(item=>[item.value,item.label]))[value]||value}
function newMenu(){return {label:'',href:'#',item_kind:'anchor',sort_order:100,is_visible:true,open_in_new_tab:false,status:'published'}}
function newSection(){return {section_key:`section-${Date.now()}`,section_type:'cards',eyebrow:'',title:'',summary:'',body:'',primary_cta:{},secondary_cta:{},items:[],media:{},style_variant:'light',sort_order:100,is_visible:true,status:'draft'}}
function newPage(){return {slug:`page-${Date.now()}`,title:'',menu_label:'',excerpt:'',body:'',content:{},template_key:'standard',seo_title:'',seo_description:'',cover_url:'',show_in_menu:false,menu_order:100,status:'draft'}}
function newArticle(){return {slug:`article-${Date.now()}`,title:'',excerpt:'',body:'',category:'',author_name:'فريق أودير',cover_url:'',seo_title:'',seo_description:'',featured:false,status:'draft'}}

const contentStatuses=[{value:'draft',label:'مسودة'},{value:'published',label:'منشور'}];
const siteStatuses=[...contentStatuses,{value:'maintenance',label:'وضع الصيانة'}];
const menuKinds=[{value:'anchor',label:'قسم داخل الصفحة الرئيسية'},{value:'page',label:'صفحة مستقلة'},{value:'article',label:'مقال'},{value:'external',label:'رابط خارجي'},{value:'system',label:'رابط للنظام'}];
const sectionTypes=[{value:'hero',label:'الهيدر الرئيسي'},{value:'journey',label:'رحلة وخطوات'},{value:'system',label:'منظومة مترابطة'},{value:'process',label:'مراحل متتابعة'},{value:'comparison',label:'مقارنة قبل وبعد'},{value:'team',label:'تمكين الفريق'},{value:'metrics',label:'بيانات ومؤشرات'},{value:'impact',label:'أثر ونتائج'},{value:'solutions',label:'حلول وخدمات'},{value:'cards',label:'كروت عامة'},{value:'partnership',label:'دعوة للشراكة'},{value:'contact',label:'نموذج تواصل'}];
const sectionVariants=[{value:'light',label:'فاتح'},{value:'paper',label:'كريمي'},{value:'dark',label:'داكن'}];
const messageStatuses=[{value:'new',label:'جديدة'},{value:'in_progress',label:'قيد المتابعة'},{value:'resolved',label:'تمت المعالجة'},{value:'spam',label:'مزعجة'},{value:'archived',label:'أرشفة'}];
