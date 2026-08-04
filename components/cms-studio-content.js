'use client';

import Link from 'next/link';
import {cmsBuilderPath,cmsPreviewPath,formatBytes,formatCmsDate} from '../lib/cms';
import {
  Status,Empty,PanelHeading,Toolbar,Field,Select,ColorField,
  matches,safeImage,newArticle,newCategory,value
} from './cms-studio-ui';
import styles from './cms-studio.module.css';

export function ArticlesPanel({context,articles,categories,query,setQuery,setEditor,archive}){
  const rows=articles.filter(article=>matches(query,article.title,article.slug,article.excerpt,article.category,...(article.tags||[])));
  return <section className={styles.panel}>
    <PanelHeading title="المقالات" description="اكتب العنوان والمختصر والصورة والتصنيف وSEO، ثم صمّم المقال الكامل بنفس البيلدر المستخدم للصفحات." action="مقال جديد" onAction={()=>setEditor({type:'article',value:newArticle()})}/>
    <div className={styles.articleTools}><Toolbar query={query} setQuery={setQuery} placeholder="ابحث في المقالات..."/><button type="button" onClick={()=>setEditor({type:'category',value:newCategory()})}>إدارة التصنيفات +</button></div>
    {categories.length>0&&<div className={styles.categoryChips}>{categories.map(category=><button type="button" key={category.id} onClick={()=>setQuery(category.name)}>{category.name}</button>)}</div>}
    <div className={styles.articleAdminGrid}>{rows.map(article=><article key={article.id} className={styles.articleAdminCard}>
      <div className={styles.articleImage} style={article.coverUrl?{backgroundImage:`linear-gradient(180deg,transparent,rgba(4,22,40,.82)),url(${safeImage(article.coverUrl)})`}:undefined}><span>{article.category||'غير مصنف'}</span>{article.featured&&<b>مميز</b>}</div>
      <div className={styles.articleAdminBody}><div><Status value={article.status}/><small>{article.readingMinutes?`${article.readingMinutes} دقائق قراءة`:'مدة القراءة تلقائية'}</small></div><h2>{article.title}</h2><p>{article.excerpt||'اكتب مختصرًا جذابًا يظهر في بطاقات المقالات ونتائج البحث.'}</p><div className={styles.tagRow}>{(article.tags||[]).slice(0,4).map(tag=><span key={tag}>#{tag}</span>)}</div><div className={styles.builderState}><span>{article.builder?.blockCount||0} عنصر</span><span>{article.builder?.hasUnpublishedChanges?'مسودة أحدث من المنشور':'جاهز'}</span></div></div>
      <footer><Link href={cmsBuilderPath(context,'article',article.id)} className={styles.designButton}>تصميم المقال</Link><button type="button" onClick={()=>setEditor({type:'article',value:article})}>البيانات</button><Link href={cmsPreviewPath(context,'article',article.id)} target="_blank">معاينة</Link><button type="button" className={styles.dangerText} onClick={()=>archive('archive-article',article.id,'المقال')}>أرشفة</button></footer>
    </article>)}{!rows.length&&<Empty text="لا توجد مقالات مطابقة."/>}</div>
  </section>;
}

export function MediaPanel({assets,query,setQuery,setEditor,archive,uploading,uploadFiles}){
  const rows=assets.filter(asset=>matches(query,asset.fileName,asset.altText,asset.caption));
  return <section className={styles.panel}>
    <PanelHeading title="مكتبة الوسائط" description="مكتبة مركزية للصور المستخدمة في الصفحات والمقالات والميجا منيو."/>
    <label className={`${styles.uploadZone} ${uploading?styles.uploading:''}`} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();uploadFiles(event.dataTransfer.files);}}>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple onChange={event=>uploadFiles(event.target.files)}/>
      <span>＋</span><strong>{uploading?'جارٍ رفع الصور…':'اسحب الصور هنا أو اضغط للاختيار'}</strong><small>JPG، PNG، WebP، GIF، AVIF — بحد أقصى 8MB للصورة</small>
    </label>
    <Toolbar query={query} setQuery={setQuery} placeholder="ابحث باسم الصورة أو النص البديل..."/>
    <div className={styles.mediaGrid}>{rows.map(asset=><article key={asset.id} className={styles.mediaCard}>
      <div style={{backgroundImage:`url(${safeImage(asset.url)})`}}/><section><b>{asset.fileName}</b><small>{formatBytes(asset.sizeBytes)} · {asset.mimeType?.replace('image/','').toUpperCase()}</small><p>{asset.altText||'لا يوجد نص بديل'}</p></section>
      <footer><button type="button" onClick={()=>navigator.clipboard?.writeText(asset.url)}>نسخ الرابط</button><button type="button" onClick={()=>setEditor({type:'asset',value:asset})}>تعديل</button><button type="button" className={styles.dangerText} onClick={()=>archive('archive-asset',asset.id,'الصورة')}>أرشفة</button></footer>
    </article>)}{!rows.length&&<Empty text="مكتبة الوسائط فارغة."/>}</div>
  </section>;
}

export function MessagesPanel({submissions,call,busy}){
  return <section className={styles.panel}>
    <PanelHeading title="رسائل الموقع" description="الطلبات المرسلة من نماذج الصفحات مع المصدر والبيانات الأساسية."/>
    <div className={styles.messagesList}>{submissions.map(item=><article key={item.id}>
      <div className={styles.messageIdentity}><span>{Array.from(item.name||'م')[0]}</span><div><b>{item.name}</b><small>{item.organization||item.email||item.phone}</small></div></div>
      <p>{item.message}</p><div className={styles.messageMeta}><code>{item.reference}</code><span>{item.sourcePage}</span><time>{formatCmsDate(item.createdAt)}</time></div>
      <div className={styles.messageActions}><Status value={item.status}/><select value={item.status} disabled={busy==='set-submission-status'} onChange={event=>call('set-submission-status',{id:item.id,status:event.target.value},{message:'تم تحديث حالة الرسالة'})}><option value="new">جديدة</option><option value="in_progress">قيد المتابعة</option><option value="resolved">تمت المعالجة</option><option value="spam">مزعجة</option><option value="archived">أرشفة</option></select></div>
    </article>)}{!submissions.length&&<Empty text="لا توجد رسائل واردة حتى الآن."/>}</div>
  </section>;
}

export function SettingsPanel({data,call,busy}){
  const site=data.site||{};const settings=site.settings||{};const theme=site.theme||{};
  function submit(event){
    event.preventDefault();const form=new FormData(event.currentTarget);
    call('save-site',{
      nameAr:value(form,'nameAr'),nameEn:value(form,'nameEn'),status:value(form,'status'),locale:value(form,'locale'),primaryDomain:value(form,'primaryDomain'),
      settings:{siteTitle:value(form,'siteTitle'),description:value(form,'description'),logoUrl:value(form,'logoUrl'),customerLoginLabel:value(form,'customerLoginLabel'),customerLoginUrl:value(form,'customerLoginUrl'),contactCtaLabel:value(form,'contactCtaLabel'),contactCtaUrl:value(form,'contactCtaUrl'),contactEmail:value(form,'contactEmail'),contactPhone:value(form,'contactPhone'),country:value(form,'country'),footerText:value(form,'footerText'),articlesTitle:value(form,'articlesTitle'),articlesDescription:value(form,'articlesDescription')},
      theme:{navy:value(form,'navy'),navySoft:value(form,'navySoft'),gold:value(form,'gold'),paper:value(form,'paper'),white:value(form,'white')}
    },{message:'تم حفظ إعدادات الموقع'});
  }
  return <form className={styles.settingsGrid} onSubmit={submit}>
    <section className={styles.panel}><PanelHeading title="هوية الموقع" description="الاسم والشعار وبيانات الظهور العامة."/><div className={styles.formGrid}><Field label="اسم الموقع" name="nameAr" defaultValue={site.nameAr} required/><Field label="الاسم الإنجليزي" name="nameEn" defaultValue={site.nameEn}/><Field label="عنوان المتصفح" name="siteTitle" defaultValue={settings.siteTitle} wide/><Field label="وصف الموقع" name="description" defaultValue={settings.description} textarea wide/><Field label="رابط الشعار" name="logoUrl" defaultValue={settings.logoUrl} ltr wide/><Field label="لغة الموقع" name="locale" defaultValue={site.locale||'ar-SA'}/><Field label="الدومين الأساسي" name="primaryDomain" defaultValue={site.primaryDomain} ltr/><Select label="حالة الموقع" name="status" defaultValue={site.status} options={[["draft","مسودة"],["published","منشور"],["maintenance","صيانة"]]}/></div></section>
    <section className={styles.panel}><PanelHeading title="الهيدر والفوتر" description="الأزرار وبيانات التواصل والنصوص العامة."/><div className={styles.formGrid}><Field label="نص زر دخول العملاء" name="customerLoginLabel" defaultValue={settings.customerLoginLabel}/><Field label="رابط دخول العملاء" name="customerLoginUrl" defaultValue={settings.customerLoginUrl} ltr/><Field label="نص زر التواصل" name="contactCtaLabel" defaultValue={settings.contactCtaLabel}/><Field label="رابط زر التواصل" name="contactCtaUrl" defaultValue={settings.contactCtaUrl} ltr/><Field label="البريد" name="contactEmail" defaultValue={settings.contactEmail} ltr/><Field label="الجوال" name="contactPhone" defaultValue={settings.contactPhone} ltr/><Field label="الدولة" name="country" defaultValue={settings.country}/><Field label="نص الفوتر" name="footerText" defaultValue={settings.footerText} textarea wide/></div></section>
    <section className={styles.panel}><PanelHeading title="صفحة المقالات" description="عنوان ومقدمة أرشيف المقالات."/><div className={styles.formGrid}><Field label="العنوان" name="articlesTitle" defaultValue={settings.articlesTitle||'مقالات ورؤى عملية'} wide/><Field label="المقدمة" name="articlesDescription" defaultValue={settings.articlesDescription} textarea wide/></div></section>
    <section className={styles.panel}><PanelHeading title="ألوان الهوية" description="تنعكس تلقائيًا على الصفحات والقوائم."/><div className={styles.colorGrid}><ColorField label="الكحلي" name="navy" defaultValue={theme.navy||'#06182e'}/><ColorField label="الكحلي الفاتح" name="navySoft" defaultValue={theme.navySoft||'#0b2949'}/><ColorField label="الذهبي" name="gold" defaultValue={theme.gold||'#e6b34e'}/><ColorField label="الكريمي" name="paper" defaultValue={theme.paper||'#f7f2e8'}/><ColorField label="الأبيض" name="white" defaultValue={theme.white||'#ffffff'}/></div><button className={styles.saveSettings} disabled={busy==='save-site'}>{busy==='save-site'?'جارٍ الحفظ…':'حفظ جميع الإعدادات'}</button></section>
  </form>;
}
