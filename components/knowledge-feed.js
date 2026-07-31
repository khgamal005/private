'use client';

import {useCallback,useEffect,useMemo,useState} from 'react';
import styles from './knowledge-feed.module.css';

const FALLBACK=[{
  id:'welcome',title:'مرحبًا بكم في مركز أخبار ومعارف ماركتون',excerpt:'تصل إليك الأخبار والفرص والتنبيهات التي تهم قطاع التدريب في مكان واحد.',smart_summary:'يعمل المركز كمصدر يومي موثوق لأصحاب ومديري مراكز التدريب.',content_type:'news',status:'published',is_featured:true,is_breaking:false,importance_level:'normal',trust_score:100,relevance_score:90,why_it_matters:'يساعدك المركز على متابعة التغيّرات والفرص دون البحث في عشرات المواقع.',recommended_action:'راجع القسم بانتظام واحفظ المواد المرتبطة بخطة منشأتك.',published_at:new Date().toISOString(),knowledge_categories:{name:'أخبار قطاع التدريب',slug:'training-news'},source_name:'ماركتون',cover_image_url:''
}];

const FILTERS=[['all','الكل'],['important','الأهم لمنشأتك'],['tender','المنافسات'],['regulation','التشريعات'],['event','الفعاليات'],['article','المقالات'],['saved','المحفوظات']];

function safeDate(value){const date=new Date(value||'');return Number.isNaN(date.getTime())?null:date;}
function dateLabel(value,long=false){const date=safeDate(value);if(!date)return 'تاريخ غير محدد';return new Intl.DateTimeFormat('ar-SA',long?{day:'numeric',month:'long',year:'numeric'}:{day:'numeric',month:'short'}).format(date);}
function typeLabel(post){return ({tender:'منافسة وفرصة',article:'مقال معرفي',regulation:'تشريع وتنبيه',event:'فعالية ومبادرة',market_pulse:'نبض السوق',success_story:'قصة وتجربة'})[post.content_type]||'خبر التدريب';}
function typeIcon(type){return ({tender:'◎',regulation:'§',event:'◷',article:'✦',market_pulse:'↗',success_story:'★'})[type]||'●';}
function daysUntil(value){const date=safeDate(value);if(!date)return null;return Math.ceil((date.getTime()-Date.now())/86400000);}
function relevance(post){return Math.max(0,Math.min(100,Number(post.relevance_score||0)));}

export default function KnowledgeFeed({tenant,embedded=false}){
  const [data,setData]=useState({posts:[],categories:[],stats:{}});
  const [filter,setFilter]=useState('all');
  const [category,setCategory]=useState('');
  const [search,setSearch]=useState('');
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [warning,setWarning]=useState('');
  const [selected,setSelected]=useState(null);
  const [saving,setSaving]=useState('');

  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const response=await fetch(`/api/knowledge/feed?tenant=${encodeURIComponent(tenant)}`,{cache:'no-store'});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||'تعذر تحميل الأخبار والمعارف');
      setData({posts:Array.isArray(payload.posts)?payload.posts:[],categories:Array.isArray(payload.categories)?payload.categories:[],stats:payload.stats||{}});
      setWarning(payload.warning||'');
    }catch(reason){setError(reason.message);setData(current=>({...current,posts:current.posts.length?current.posts:FALLBACK}));}
    finally{setLoading(false);}
  },[tenant]);

  useEffect(()=>{load();},[load]);

  const posts=data.posts.length?data.posts:FALLBACK;
  const shown=useMemo(()=>{
    const query=search.trim().toLocaleLowerCase('ar');
    return posts.filter(post=>{
      if(category&&post.category_id!==category)return false;
      if(query&&![post.title,post.excerpt,post.smart_summary,post.why_it_matters,post.source_name,(post.tags||[]).join(' ')].join(' ').toLocaleLowerCase('ar').includes(query))return false;
      if(filter==='important')return post.is_breaking||['high','urgent'].includes(post.importance_level)||relevance(post)>=80;
      if(filter==='saved')return Boolean(post.is_saved);
      if(filter!=='all')return post.content_type===filter;
      return true;
    });
  },[posts,filter,category,search]);

  const hero=shown.find(post=>post.is_featured)||shown[0]||null;
  const rest=shown.filter(post=>post.id!==hero?.id);
  const closingSoon=useMemo(()=>posts.filter(post=>post.content_type==='tender'&&daysUntil(post.tender_deadline)!==null).filter(post=>daysUntil(post.tender_deadline)>=0).sort((a,b)=>daysUntil(a.tender_deadline)-daysUntil(b.tender_deadline)).slice(0,4),[posts]);
  const official=useMemo(()=>posts.filter(post=>Number(post.trust_score||0)>=90).slice(0,4),[posts]);

  async function bookmark(post){
    if(post.id==='welcome')return;
    setSaving(post.id);
    try{
      const response=await fetch('/api/knowledge/bookmark',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tenant,postId:post.id,saved:Boolean(post.is_saved)})});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||'تعذر حفظ المادة');
      setData(current=>({...current,posts:current.posts.map(item=>item.id===post.id?{...item,is_saved:Boolean(payload.saved)}:item),stats:{...current.stats,saved:Math.max(0,Number(current.stats.saved||0)+(payload.saved?1:-1))}}));
      setSelected(current=>current?.id===post.id?{...current,is_saved:Boolean(payload.saved)}:current);
    }catch(reason){setError(reason.message);}finally{setSaving('');}
  }

  async function openPost(post){
    setSelected(post);
    if(post.id==='welcome')return;
    fetch('/api/knowledge/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tenant,postId:post.id})}).catch(()=>{});
  }

  const stats=[['إجمالي المواد',data.stats.total??posts.length,'●'],['منافسات نشطة',data.stats.activeTenders??posts.filter(p=>p.content_type==='tender').length,'◎'],['تغلق قريبًا',data.stats.closingSoon??closingSoon.filter(p=>daysUntil(p.tender_deadline)<=7).length,'◷'],['مواد مهمة',data.stats.important??posts.filter(p=>relevance(p)>=80).length,'!'],['محفوظاتي',data.stats.saved??posts.filter(p=>p.is_saved).length,'☆']];

  return <section className={`${styles.feed} ${embedded?styles.embedded:''}`} dir="rtl">
    <header className={styles.pageHeader}>
      <div><small>MARKTONE KNOWLEDGE INTELLIGENCE</small><h2>أخبار ومعارف</h2><p>ماذا حدث، لماذا يهم منشأتك، وما الإجراء الذي ينبغي اتخاذه الآن؟</p></div>
      <div className={styles.headerActions}>
        <label className={styles.search}><span>⌕</span><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="ابحث في الأخبار والمنافسات والتشريعات…"/>{search&&<button type="button" onClick={()=>setSearch('')}>×</button>}</label>
        <button className={styles.refresh} type="button" onClick={load} disabled={loading}>{loading?'جارٍ التحديث…':'تحديث المصادر'}</button>
      </div>
    </header>

    <div className={styles.stats}>{stats.map(([label,value,icon])=><article key={label}><span>{icon}</span><div><b>{Number(value||0).toLocaleString('ar-SA')}</b><small>{label}</small></div></article>)}</div>
    {warning&&<div className={styles.warning}><b>تنبيه تشغيلي</b><span>{warning}</span></div>}
    {error&&<div className={styles.error}><div><b>تعذر تحديث بعض المواد</b><span>{error}</span></div><button type="button" onClick={load}>إعادة المحاولة</button></div>}

    <div className={styles.filters}>
      <div className={styles.filterRow}>{FILTERS.map(([key,label])=><button type="button" key={key} className={filter===key?styles.active:''} onClick={()=>setFilter(key)}>{label}</button>)}</div>
      <div className={styles.categoryRow}><button type="button" className={!category?styles.activeCategory:''} onClick={()=>setCategory('')}>كل الأقسام</button>{data.categories.map(item=><button type="button" key={item.id} className={category===item.id?styles.activeCategory:''} onClick={()=>setCategory(item.id)}>{item.name}</button>)}</div>
    </div>

    {loading?<LoadingState/>:shown.length?<div className={styles.contentGrid}>
      <main>
        {hero&&<HeroCard post={hero} onOpen={()=>openPost(hero)} onBookmark={()=>bookmark(hero)} saving={saving===hero.id}/>} 
        <div className={styles.sectionHead}><div><small>آخر التحديثات</small><h3>الأخبار والمعارف المختارة</h3></div><span>{shown.length.toLocaleString('ar-SA')} مادة</span></div>
        <div className={styles.cards}>{rest.map(post=><KnowledgeCard post={post} key={post.id} onOpen={()=>openPost(post)} onBookmark={()=>bookmark(post)} saving={saving===post.id}/>)}</div>
      </main>
      <aside className={styles.sidebar}>
        <SidePanel title="منافسات تغلق قريبًا" icon="◷" empty="لا توجد منافسات ذات موعد قريب.">{closingSoon.map(post=><button type="button" key={post.id} onClick={()=>openPost(post)}><span className={styles.deadlineBadge}>{daysUntil(post.tender_deadline)===0?'اليوم':`${daysUntil(post.tender_deadline)} يوم`}</span><b>{post.title}</b><small>{post.tender_authority||post.source_name||'مصدر رسمي'}</small></button>)}</SidePanel>
        <SidePanel title="من المصادر الرسمية" icon="✓" empty="لا توجد تحديثات رسمية الآن.">{official.map(post=><button type="button" key={post.id} onClick={()=>openPost(post)}><span className={styles.officialMark}>موثوق {Number(post.trust_score||0)}%</span><b>{post.title}</b><small>{post.source_name||'ماركتون'} · {dateLabel(post.source_published_at||post.published_at)}</small></button>)}</SidePanel>
        <div className={styles.smartPanel}><span>✦</span><div><b>كيف يعمل المركز الذكي؟</b><p>يجمع المصادر، يزيل التكرار، يصنّف المواد، ثم يرسلها للمراجعة قبل النشر.</p></div></div>
      </aside>
    </div>:<EmptyState onReset={()=>{setSearch('');setFilter('all');setCategory('');}}/>}
    {selected&&<PostModal post={selected} saving={saving===selected.id} onClose={()=>setSelected(null)} onBookmark={()=>bookmark(selected)}/>} 
  </section>;
}

function HeroCard({post,onOpen,onBookmark,saving}){
  return <article className={styles.hero}><div className={styles.heroImage}>{post.cover_image_url?<img src={post.cover_image_url} alt=""/>:<div className={styles.generatedCover}><span>{typeIcon(post.content_type)}</span><small>MARKTONE INTELLIGENCE</small></div>}<div className={styles.heroShade}/><div className={styles.heroContent}><div className={styles.badges}><em>{typeLabel(post)}</em>{post.is_breaking&&<b>عاجل</b>}{relevance(post)>0&&<span>{relevance(post)}% مناسب لك</span>}</div><h3>{post.title}</h3><p>{post.smart_summary||post.excerpt}</p><footer><div><span>{post.source_name||'ماركتون'}</span><time>{dateLabel(post.source_published_at||post.published_at,true)}</time></div><div><button type="button" onClick={event=>{event.stopPropagation();onBookmark();}} disabled={saving}>{post.is_saved?'★ محفوظ':'☆ حفظ'}</button><button type="button" onClick={onOpen}>اقرأ التحليل</button></div></footer></div></div></article>;
}

function KnowledgeCard({post,onOpen,onBookmark,saving}){
  const deadline=daysUntil(post.tender_deadline);
  return <article className={`${styles.card} ${post.content_type==='tender'?styles.tender:''}`}><button type="button" className={styles.cardClick} onClick={onOpen} aria-label={`فتح ${post.title}`}/><div className={styles.cardImage}>{post.cover_image_url?<img src={post.cover_image_url} alt=""/>:<div><span>{typeIcon(post.content_type)}</span><small>{typeLabel(post)}</small></div>}<em>{post.knowledge_categories?.name||typeLabel(post)}</em></div><div className={styles.cardBody}><div className={styles.cardMeta}><span>{post.source_name||'ماركتون'}</span><time>{dateLabel(post.source_published_at||post.published_at)}</time></div><h4>{post.title}</h4><p>{post.smart_summary||post.excerpt}</p>{deadline!==null&&deadline>=0&&<div className={styles.deadline}><span>آخر موعد</span><b>{deadline===0?'اليوم':`بعد ${deadline.toLocaleString('ar-SA')} يوم`}</b></div>}{post.why_it_matters&&<div className={styles.why}><b>لماذا يهمك؟</b><span>{post.why_it_matters}</span></div>}<footer><span className={styles.relevance}><i style={{width:`${relevance(post)}%`}}/><small>{relevance(post)}% ملاءمة</small></span><button type="button" className={styles.save} onClick={event=>{event.stopPropagation();onBookmark();}} disabled={saving}>{post.is_saved?'★':'☆'}</button></footer></div></article>;
}

function SidePanel({title,icon,empty,children}){const list=Array.isArray(children)?children:[children];return <section className={styles.sidePanel}><header><span>{icon}</span><h4>{title}</h4></header><div>{list.some(Boolean)?children:<p className={styles.sideEmpty}>{empty}</p>}</div></section>;}

function PostModal({post,onClose,onBookmark,saving}){
  const deadline=daysUntil(post.tender_deadline);
  return <div className={styles.modalLayer} role="presentation"><button type="button" className={styles.backdrop} onClick={onClose} aria-label="إغلاق"/><article className={styles.modal} role="dialog" aria-modal="true"><header><div className={styles.badges}><em>{typeLabel(post)}</em>{post.is_breaking&&<b>عاجل</b>}{relevance(post)>0&&<span>{relevance(post)}% مناسب لمنشأتك</span>}</div><button type="button" onClick={onClose} aria-label="إغلاق">×</button></header>{post.cover_image_url&&<img className={styles.modalImage} src={post.cover_image_url} alt=""/>}<div className={styles.modalBody}><small>{post.source_name||'ماركتون'} · {dateLabel(post.source_published_at||post.published_at,true)}</small><h2>{post.title}</h2><p className={styles.lead}>{post.smart_summary||post.excerpt}</p>{post.why_it_matters&&<section className={styles.insight}><span>✦</span><div><b>لماذا يهم هذا منشأتك؟</b><p>{post.why_it_matters}</p></div></section>}{post.recommended_action&&<section className={styles.action}><span>→</span><div><b>الإجراء المقترح</b><p>{post.recommended_action}</p></div></section>}{post.content&&<div className={styles.articleText}>{post.content}</div>}{deadline!==null&&deadline>=0&&<div className={styles.tenderFacts}><div><small>الجهة</small><b>{post.tender_authority||post.source_name||'غير محدد'}</b></div><div><small>آخر موعد</small><b>{dateLabel(post.tender_deadline,true)}</b></div><div><small>المتبقي</small><b>{deadline===0?'اليوم':`${deadline} يوم`}</b></div><div><small>المنطقة</small><b>{post.tender_region||'غير محددة'}</b></div></div>}</div><footer><button type="button" className={styles.modalSave} onClick={onBookmark} disabled={saving}>{post.is_saved?'★ إزالة من المحفوظات':'☆ حفظ للرجوع إليه'}</button>{(post.application_url||post.source_url)&&<a href={post.application_url||post.source_url} target="_blank" rel="noreferrer">فتح المصدر الرسمي ↗</a>}</footer></article></div>;
}

function LoadingState(){return <div className={styles.skeleton}><div/><section><div/><div/><div/></section></div>;}
function EmptyState({onReset}){return <div className={styles.empty}><span>⌕</span><h3>لا توجد مواد مطابقة</h3><p>غيّر البحث أو الفلاتر لعرض بقية الأخبار والفرص.</p><button type="button" onClick={onReset}>عرض كل المواد</button></div>;}
