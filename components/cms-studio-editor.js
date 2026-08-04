'use client';

import {
  PAGE_KINDS,VISIBILITY,Field,Select,Check,MediaSelect,
  payloadFor,safeImage,toDateTimeLocal
} from './cms-studio-ui';
import styles from './cms-studio.module.css';

export function EditorModal({editor,pages,articles,menus,menuItems,assets,categories,busy,onClose,onSubmit}){
  const {type,value:row}=editor;
  const titles={
    page:row.id?'تعديل بيانات الصفحة':'إنشاء صفحة جديدة',
    article:row.id?'تعديل بيانات المقال':'إنشاء مقال جديد',
    menu:row.id?'إعدادات القائمة':'قائمة جديدة',
    menuItem:row.id?'تعديل عنصر القائمة':'إضافة عنصر للقائمة',
    category:row.id?'تعديل التصنيف':'تصنيف جديد',
    asset:'بيانات الصورة'
  };
  function submit(event){event.preventDefault();onSubmit(type,payloadFor(type,new FormData(event.currentTarget),row));}
  return <div className={styles.modalBackdrop} onMouseDown={event=>event.target===event.currentTarget&&onClose()}>
    <section className={styles.modal} role="dialog" aria-modal="true" aria-label={titles[type]}>
      <header><div><span>Marktone CMS Studio</span><h2>{titles[type]}</h2></div><button type="button" onClick={onClose}>×</button></header>
      <form onSubmit={submit}><div className={styles.modalBody}>
        {type==='page'&&<PageFields row={row} pages={pages} assets={assets}/>} 
        {type==='article'&&<ArticleFields row={row} categories={categories} assets={assets}/>} 
        {type==='menu'&&<MenuFields row={row}/>} 
        {type==='menuItem'&&<MenuItemFields row={row} pages={pages} articles={articles} menus={menus} menuItems={menuItems} assets={assets}/>} 
        {type==='category'&&<CategoryFields row={row} categories={categories}/>} 
        {type==='asset'&&<AssetFields row={row}/>} 
      </div><footer><button type="button" onClick={onClose}>إلغاء</button><button className={styles.modalSave} disabled={Boolean(busy)}>{busy?'جارٍ الحفظ…':'حفظ'}</button></footer></form>
    </section>
  </div>;
}

function PageFields({row,pages,assets}){return <div className={styles.formGrid}>
  <Field label="عنوان الصفحة" name="title" defaultValue={row.title} required wide/>
  <Field label="الرابط المختصر" name="slug" defaultValue={row.slug} required ltr/>
  <Field label="اسمها في القائمة" name="menuLabel" defaultValue={row.menuLabel}/>
  <Select label="نوع الصفحة" name="pageKind" defaultValue={row.pageKind||'standard'} options={PAGE_KINDS}/>
  <Select label="الصفحة الأب" name="parentPageId" defaultValue={row.parentPageId||''} options={[["","بدون صفحة أب"],...pages.filter(page=>page.id!==row.id).map(page=>[page.id,page.title])]}/>
  <Field label="الوصف المختصر" name="excerpt" defaultValue={row.excerpt} textarea wide/>
  <MediaSelect label="صورة الغلاف" name="coverUrl" defaultValue={row.coverUrl} assets={assets}/>
  <Select label="الظهور" name="visibility" defaultValue={row.visibility||'public'} options={VISIBILITY}/>
  <Select label="الحالة" name="status" defaultValue={row.status||'draft'} options={[["draft","مسودة"],["published","منشور"]]}/>
  <Field label="ترتيب الصفحة" name="sortOrder" defaultValue={row.sortOrder??100} type="number"/>
  <Field label="عنوان SEO" name="seoTitle" defaultValue={row.seoTitle}/>
  <Field label="وصف SEO" name="seoDescription" defaultValue={row.seoDescription} textarea wide/>
  <Field label="Canonical URL" name="canonicalUrl" defaultValue={row.canonicalUrl} ltr/>
  <Select label="تعليمات محركات البحث" name="robots" defaultValue={row.robots||'index,follow'} options={[["index,follow","أرشفة وتتبع"],["noindex,follow","عدم الأرشفة"],["noindex,nofollow","خاص بالكامل"]]}/>
  <Check name="showInMenu" label="إظهار الصفحة تلقائيًا في القائمة" defaultChecked={row.showInMenu}/>
  <Field label="ترتيبها في القائمة" name="menuOrder" defaultValue={row.menuOrder??100} type="number"/>
  <input type="hidden" name="id" value={row.id||''}/>
</div>}

function ArticleFields({row,categories,assets}){return <div className={styles.formGrid}>
  <Field label="عنوان المقال" name="title" defaultValue={row.title} required wide/>
  <Field label="الرابط المختصر" name="slug" defaultValue={row.slug} required ltr/>
  <Field label="المختصر" name="excerpt" defaultValue={row.excerpt} textarea wide/>
  <MediaSelect label="الصورة البارزة" name="coverUrl" defaultValue={row.coverUrl} assets={assets}/>
  <Select label="التصنيف" name="category" defaultValue={row.category||''} options={[["","بدون تصنيف"],...categories.map(category=>[category.name,category.name])]}/>
  <Field label="الوسوم" name="tags" defaultValue={(row.tags||[]).join(', ')} hint="افصل بين الوسوم بفاصلة"/>
  <Field label="اسم الكاتب" name="authorName" defaultValue={row.authorName||'فريق العمل'}/>
  <Field label="مدة القراءة بالدقائق" name="readingMinutes" defaultValue={row.readingMinutes||''} type="number"/>
  <Select label="الظهور" name="visibility" defaultValue={row.visibility||'public'} options={VISIBILITY}/>
  <Select label="الحالة" name="status" defaultValue={row.status||'draft'} options={[["draft","مسودة"],["published","منشور"]]}/>
  <Field label="موعد النشر المجدول" name="scheduledAt" defaultValue={toDateTimeLocal(row.scheduledAt)} type="datetime-local"/>
  <Check name="featured" label="مقال مميز" defaultChecked={row.featured}/>
  <Field label="عنوان SEO" name="seoTitle" defaultValue={row.seoTitle}/>
  <Field label="وصف SEO" name="seoDescription" defaultValue={row.seoDescription} textarea wide/>
  <Field label="Canonical URL" name="canonicalUrl" defaultValue={row.canonicalUrl} ltr/>
  <Select label="تعليمات محركات البحث" name="robots" defaultValue={row.robots||'index,follow'} options={[["index,follow","أرشفة وتتبع"],["noindex,follow","عدم الأرشفة"],["noindex,nofollow","خاص بالكامل"]]}/>
  <input type="hidden" name="id" value={row.id||''}/>
</div>}

function MenuFields({row}){return <div className={styles.formGrid}>
  <Field label="اسم القائمة" name="name" defaultValue={row.name} required wide/>
  <Field label="مفتاح القائمة" name="key" defaultValue={row.key} ltr hint="يُنشأ تلقائيًا للقائمة الجديدة"/>
  <Select label="مكان الظهور" name="location" defaultValue={row.location||'custom'} options={[["header","الهيدر"],["footer","الفوتر"],["mobile","قائمة الجوال"],["custom","قائمة مخصصة"]]}/>
  <Select label="الحالة" name="status" defaultValue={row.status||'published'} options={[["draft","مسودة"],["published","منشورة"]]}/>
  <Field label="الوصف الداخلي" name="description" defaultValue={row.description} textarea wide/>
  <Check name="megaMenu" label="السماح بالميجا منيو" defaultChecked={row.settings?.megaMenu!==false}/>
  <Select label="قائمة الجوال" name="mobileStyle" defaultValue={row.settings?.mobileStyle||'drawer'} options={[["drawer","قائمة جانبية"],["accordion","أكورديون"]]}/>
  <input type="hidden" name="id" value={row.id||''}/>
</div>}

function MenuItemFields({row,pages,articles,menus,menuItems,assets}){
  const siblings=menuItems.filter(item=>item.menuId===row.menuId&&item.id!==row.id);
  return <div className={styles.formGrid}>
    <Select label="القائمة" name="menuId" defaultValue={row.menuId||menus[0]?.id} options={menus.map(menu=>[menu.id,menu.name])}/>
    <Field label="اسم العنصر" name="label" defaultValue={row.label} required/>
    <Select label="نوع الرابط" name="kind" defaultValue={row.kind||'page'} options={[["page","صفحة"],["article","مقال"],["anchor","قسم داخل الصفحة #"],["external","رابط خارجي"],["system","رابط النظام"],["group","عنوان مجموعة داخل ميجا منيو"]]}/>
    <Select label="صفحة مرتبطة" name="targetPageId" defaultValue={row.targetPageId||''} options={[["","اختر صفحة"],["__new__","＋ إنشاء صفحة جديدة وربطها"],...pages.map(page=>[page.id,page.isHome?`${page.title} — الرئيسية`:page.title])]}/>
    <div className={styles.inlineCreate}><Field label="عنوان الصفحة الجديدة" name="newPageTitle" defaultValue=""/><Field label="رابطها" name="newPageSlug" defaultValue="" ltr/></div>
    <Select label="مقال مرتبط" name="targetArticleId" defaultValue={row.targetArticleId||''} options={[["","اختر مقالًا"],["__new__","＋ إنشاء مقال جديد وربطه"],...articles.map(article=>[article.id,article.title])]}/>
    <div className={styles.inlineCreate}><Field label="عنوان المقال الجديد" name="newArticleTitle" defaultValue=""/><Field label="رابطه" name="newArticleSlug" defaultValue="" ltr/></div>
    <Field label="رابط مخصص أو #section" name="href" defaultValue={row.href} ltr wide/>
    <Select label="عنصر أب" name="parentId" defaultValue={row.parentId||''} options={[["","عنصر رئيسي"],...siblings.map(item=>[item.id,item.label])]}/>
    <Field label="وصف مختصر" name="description" defaultValue={row.description} textarea wide/>
    <Field label="أيقونة" name="icon" defaultValue={row.icon} hint="رمز مثل ✦ أو اسم مختصر"/>
    <Field label="شارة" name="badge" defaultValue={row.badge} hint="مثل: جديد أو قريبًا"/>
    <MediaSelect label="صورة العنصر أو الميجا منيو" name="imageUrl" defaultValue={row.imageUrl} assets={assets}/>
    <Field label="رقم العمود" name="columnIndex" defaultValue={row.columnIndex||1} type="number"/>
    <Field label="الترتيب" name="sortOrder" defaultValue={row.sortOrder??100} type="number"/>
    <Check name="isMega" label="تحويل العنصر الرئيسي إلى Mega Menu" defaultChecked={row.isMega}/>
    <Select label="عدد أعمدة الميجا منيو" name="megaColumns" defaultValue={row.megaSettings?.columns||3} options={[[2,'عمودان'],[3,'3 أعمدة'],[4,'4 أعمدة'],[5,'5 أعمدة'],[6,'6 أعمدة']]}/>
    <Field label="اسم مختلف للجوال" name="mobileLabel" defaultValue={row.mobileLabel}/>
    <Field label="CSS Class اختياري" name="cssClass" defaultValue={row.cssClass} ltr/>
    <Select label="الحالة" name="status" defaultValue={row.status||'published'} options={[["draft","مسودة"],["published","منشور"]]}/>
    <Check name="isVisible" label="ظاهر في القائمة" defaultChecked={row.isVisible!==false}/>
    <Check name="openInNewTab" label="فتح في نافذة جديدة" defaultChecked={row.openInNewTab}/>
    <input type="hidden" name="id" value={row.id||''}/>
  </div>;
}

function CategoryFields({row,categories}){return <div className={styles.formGrid}>
  <Field label="اسم التصنيف" name="name" defaultValue={row.name} required/>
  <Field label="الرابط المختصر" name="slug" defaultValue={row.slug} required ltr/>
  <Select label="التصنيف الأب" name="parentId" defaultValue={row.parentId||''} options={[["","بدون أب"],...categories.filter(item=>item.id!==row.id).map(item=>[item.id,item.name])]}/>
  <Field label="الترتيب" name="sortOrder" defaultValue={row.sortOrder??100} type="number"/>
  <Field label="الوصف" name="description" defaultValue={row.description} textarea wide/>
  <input type="hidden" name="id" value={row.id||''}/>
</div>}
function AssetFields({row}){return <div className={styles.formGrid}>
  <div className={styles.assetPreview} style={{backgroundImage:`url(${safeImage(row.url)})`}}/>
  <Field label="النص البديل" name="altText" defaultValue={row.altText} wide/>
  <Field label="التعليق" name="caption" defaultValue={row.caption} textarea wide/>
  <input type="hidden" name="id" value={row.id}/>
</div>}
