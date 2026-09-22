'use client';

import Link from 'next/link';
import {cmsBuilderPath,cmsPreviewPath,cmsPublicPath,formatCmsDate} from '../lib/cms';
import {
  Status,Empty,PanelHeading,Toolbar,Stat,MenuActions,
  matches,newArticle,newPage
} from './cms-studio-ui';
import styles from './cms-studio.module.css';
import {pagePublication,sitePublication} from '../lib/cms-publication.mjs';

export function Overview({data,context,pages,articles,home,setSection,setEditor}){
  const stats=data.stats||{};
  const checklist=[
    ['الموقع متاح للزوار',sitePublication(data.site,home).live],
    ['الصفحة الرئيسية منشورة',home?.status==='published'],
    ['الصفحة الرئيسية مصممة',Boolean(home?.builder?.blockCount)],
    ['قائمة رئيسية جاهزة',Number(stats.menus)>0],
    ['هوية الموقع مضبوطة',Boolean(data.site?.settings?.siteTitle)],
    ['أول مقال منشور',Number(stats.publishedArticles)>0]
  ];
  return <div className={styles.overviewGrid}>
    <section className={styles.statsGrid}>
      <Stat value={stats.pages||0} label="صفحات" detail={`${stats.publishedPages||0} منشورة`} icon="▤"/>
      <Stat value={stats.articles||0} label="مقالات" detail={`${stats.publishedArticles||0} منشورة`} icon="✎"/>
      <Stat value={stats.menus||0} label="قوائم" detail="تدعم الميجا منيو" icon="☷"/>
      <Stat value={stats.assets||0} label="وسائط" detail="صور الموقع" icon="▧"/>
    </section>
    <section className={`${styles.panel} ${styles.homeCard}`}>
      <div className={styles.homeVisual}><span>HOME</span><i/><i/><i/></div>
      <div><p>الصفحة الأهم</p><h2>{home?.title||'الصفحة الرئيسية'}</h2><span>{home?.excerpt||'واجهة الموقع الأولى، قابلة للتعديل بالكامل بالبيلدر.'}</span><div className={styles.actionRow}>{home&&<Link href={cmsBuilderPath(context,'page',home.id)}>فتح المصمم</Link>}{home&&<Link href={`${cmsBuilderPath(context,'page',home.id)}?panel=templates`}>استيراد قالب ZIP</Link>}<button type="button" onClick={()=>setSection('pages')}>إدارة الصفحات</button></div></div>
    </section>
    <section className={styles.panel}>
      <PanelHeading title="جاهزية الموقع" description="خطوات أساسية قبل إطلاق الموقع."/>
      <div className={styles.checklist}>{checklist.map(([label,done])=><div key={label} className={done?styles.done:''}><span>{done?'✓':'○'}</span><b>{label}</b></div>)}</div>
    </section>
    <section className={styles.panel}>
      <PanelHeading title="آخر الصفحات" description="أحدث المحتوى الذي تم العمل عليه." action="كل الصفحات" onAction={()=>setSection('pages')}/>
      <div className={styles.compactList}>{pages.slice(0,4).map(page=><div key={page.id}><span>{page.isHome?'⌂':'P'}</span><div><b>{page.title}</b><small>{formatCmsDate(page.updatedAt)}</small></div><Status value={page.status}/></div>)}</div>
    </section>
    <section className={styles.panel}>
      <PanelHeading title="أحدث المقالات" description="المحتوى المعرفي والتسويقي." action="مقال جديد" onAction={()=>setEditor({type:'article',value:newArticle()})}/>
      <div className={styles.compactList}>{articles.slice(0,4).map(article=><div key={article.id}><span>✎</span><div><b>{article.title}</b><small>{article.category||'بدون تصنيف'}</small></div><Status value={article.status}/></div>)}{!articles.length&&<Empty text="لم تُضف مقالات بعد."/>}</div>
    </section>
    <section className={`${styles.panel} ${styles.architectureCard}`}>
      <span>ONE CORE</span><h2>محرك واحد لكل مواقع ماركتون</h2><p>أي تطوير في البيلدر أو المقالات أو القوائم أو الوسائط يصل إلى موقع ماركتون وإلى كل منشأة تستخدم الإضافة، دون نسخ الكود.</p><div><b>Multi-site</b><b>Tenant isolated</b><b>Versioned</b><b>Paid add-on</b></div>
    </section>
  </div>;
}

export function PagesPanel({data,context,pages,query,setQuery,setEditor,call,archive,busy,publishPage}){
  const rows=pages.filter(page=>matches(query,page.title,page.slug,page.excerpt));
  const isTenant=context.scope==='tenant';
  const missingCore=isTenant?[]:[
    !pages.some(page=>page.isHome)&&'الصفحة الرئيسية',
    !pages.some(page=>page.slug==='free-trial')&&'صفحة جرّب الآن'
  ].filter(Boolean);
  return <>
    <div className={`${styles.scopeNotice} ${missingCore.length?styles.scopeNoticeWarning:''}`}>
      <span>{missingCore.length?'!':isTenant?'T':'M'}</span>
      <div>
        <b>{missingCore.length?'بيانات CMS غير مكتملة':isTenant?'موقع المنشأة مستقل':'موقع ماركتون الرئيسي'}</b>
        <p>{missingCore.length
          ?`لم تصل من قاعدة البيانات: ${missingCore.join('، ')}. راجع حالة migrations وCMS v3 قبل النشر.`
          :isTenant
            ?'هذه اللوحة تعرض صفحات المنشأة فقط. كل صفحة ترث تلقائيًا هيدر وفوتر وقوائم موقع المنشأة، بينما يظل محتواها مستقلًا داخل البيلدر.'
            :'أنت تدير موقع أودير الرئيسي؛ كل الصفحات الحالية محفوظة هنا وتستخدم تلقائيًا نفس الهيدر والفوتر والقوائم المُدارة من قسم «القوائم».'}</p>
      </div>
    </div>
    <section className={styles.panel}>
      <PanelHeading title="صفحات الموقع" description="محتوى كل صفحة مستقل في البيلدر، بينما الهيدر والفوتر والقوائم موحّدة على مستوى الموقع وتتحدث في كل الصفحات تلقائيًا." action="صفحة جديدة" onAction={()=>setEditor({type:'page',value:newPage()})}/>
      <Toolbar query={query} setQuery={setQuery} placeholder="ابحث باسم الصفحة أو الرابط..."/>
      <div className={styles.pageGrid}>{rows.map(page=>{
        const isFreeTrial=page.slug==='free-trial';
        const pagePath=cmsPublicPath(context,'page',page);
        const publication=pagePublication(data.site,page);
        return <article key={page.id} className={`${styles.pageCard} ${page.isHome?styles.homePageCard:isFreeTrial?styles.corePageCard:''}`}>
          <div className={styles.pageCardTop}><span>{page.isHome?'⌂':isFreeTrial?'↗':page.pageKind==='landing'?'↗':'P'}</span><div><Status value={page.status}/>{page.isHome&&<b>الرئيسية</b>}{isFreeTrial&&<b>جرّب الآن</b>}</div></div>
          <small dir="ltr">{pagePath}</small><h2>{page.title}</h2><p>{page.excerpt||'أضف وصفًا مختصرًا يساعد فريقك ومحركات البحث.'}</p>
          <div className={styles.pagePublication}><strong>{publication.label}</strong><small>{page.builder?.publishedAt?`آخر نشر: ${formatCmsDate(page.builder.publishedAt)}`:'لم تُنشر نسخة من التصميم بعد'}{page.builder?.hasUnpublishedChanges?' · توجد مسودة لم تُنشر':''}</small></div>
          <div className={styles.builderState}><span>{page.builder?.blockCount||0} عنصر</span><span>{page.builder?.hasUnpublishedChanges?'تعديلات غير منشورة':page.builder?.hasPublished?'آخر تصميم محفوظ منشور':'مسودة جديدة'}</span><span>تخطيط الموقع موحّد</span></div>
          <footer>
            <Link prefetch={false} href={cmsBuilderPath(context,'page',page.id)} className={styles.designButton}>تصميم الصفحة</Link>
            <button type="button" onClick={()=>setEditor({type:'page',value:page})}>البيانات</button>
            <Link prefetch={false} href={cmsPreviewPath(context,'page',page.id)} target="_blank">معاينة المسودة</Link>
            {context.canPublish&&<button type="button" disabled={Boolean(busy)||!page.builder?.hasDraft||(page.status==='published'&&!page.builder?.hasUnpublishedChanges)} onClick={()=>publishPage(page)}>{page.status!=='published'?'نشر الصفحة':page.builder?.hasUnpublishedChanges?'نشر التعديلات':'منشورة'}</button>}
            {publication.visible&&<Link prefetch={false} href={pagePath} target="_blank">فتح المنشور</Link>}
            <MenuActions items={[
              !page.isHome&&{label:'تعيين كرئيسية',onClick:()=>window.confirm('تعيين هذه الصفحة كرئيسية ونشرها؟')&&call('set-home-page',{id:page.id},{message:'تم تعيين الصفحة الرئيسية'})},
              {label:'إنشاء نسخة',onClick:()=>call('duplicate-page',{id:page.id},{message:'تم إنشاء نسخة كمسودة'})},
              !page.isHome&&!isFreeTrial&&{label:'أرشفة',danger:true,onClick:()=>archive('archive-page',page.id,'الصفحة')}
            ]}/>
          </footer>
        </article>
      })}{!rows.length&&<Empty text="لا توجد صفحات مطابقة."/>}</div>
    </section>
  </>;
}
