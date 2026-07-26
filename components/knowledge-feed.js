'use client';

import {useEffect,useMemo,useState} from 'react';

const FALLBACK=[{
  id:'welcome',title:'مرحبًا بكم في أخبار ومعارف ماركتون',
  excerpt:'مركز موحد لأخبار التدريب والمنافسات والمقالات العملية.',
  content_type:'news',is_featured:true,published_at:new Date().toISOString(),
  knowledge_categories:{name:'أخبار قطاع التدريب'},cover_image_url:''
}];

function typeLabel(post){
  if(post.content_type==='tender')return 'منافسة وفرصة';
  if(post.content_type==='article')return 'مقال معرفي';
  if(post.content_type==='regulation')return 'تشريعات وتنبيهات';
  return 'خبر التدريب';
}

export default function KnowledgeFeed({tenant,embedded=false}){
  const [posts,setPosts]=useState([]);
  const [categories,setCategories]=useState([]);
  const [category,setCategory]=useState('');
  const [search,setSearch]=useState('');
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');

  useEffect(()=>{
    setLoading(true);setError('');
    Promise.all([
      fetch(`/api/knowledge/feed?tenant=${encodeURIComponent(tenant)}`,{cache:'no-store'}).then(async response=>{
        const payload=await response.json();if(!response.ok)throw new Error(payload.error||'تعذر تحميل المحتوى');return payload;
      }),
      fetch('/api/knowledge/categories',{cache:'no-store'}).then(async response=>{
        const payload=await response.json();if(!response.ok)throw new Error(payload.error||'تعذر تحميل الأقسام');return payload;
      })
    ]).then(([feed,items])=>{
      setPosts(feed.posts||[]);
      setCategories(Array.isArray(items)?items:[]);
    }).catch(err=>setError(err.message)).finally(()=>setLoading(false));
  },[tenant]);

  const shown=useMemo(()=>posts.filter(post=>
    (!category||post.category_id===category)&&
    (!search||`${post.title||''} ${post.excerpt||''}`.includes(search))
  ),[posts,category,search]);
  const all=shown.length?shown:(posts.length?[]:FALLBACK);
  const hero=all.find(post=>post.is_featured)||all[0];
  const rest=all.filter(post=>post.id!==hero?.id);

  return <main className={`knowledge-feed ${embedded?'is-embedded':''}`} dir="rtl">
    {embedded?<header className="mt-page-head">
      <div><small>NEWS & KNOWLEDGE</small><h2>أخبار ومعارف</h2><p>الأخبار والمنافسات والمقالات التي تهم قطاع التدريب السعودي.</p></div>
      <div className="mt-page-actions"><input className="mt-search" placeholder="ابحث في الأخبار والمنافسات…" value={search} onChange={event=>setSearch(event.target.value)}/></div>
    </header>:<header className="knowledge-feed-head">
      <div><a href={`/tenant/${encodeURIComponent(tenant)}`}>→</a><div><small>MARKTONE KNOWLEDGE</small><h1>أخبار ومعارف</h1><p>كل ما يهم قطاع التدريب السعودي في مكان واحد</p></div></div>
      <div className="knowledge-search"><input placeholder="ابحث في الأخبار والمنافسات…" value={search} onChange={event=>setSearch(event.target.value)}/></div>
    </header>}
    {error&&<div className="mt-alert error">{error}</div>}
    <nav className="knowledge-categories">
      <button className={!category?'active':''} onClick={()=>setCategory('')}>الرئيسية</button>
      {categories.map(item=><button className={category===item.id?'active':''} key={item.id} onClick={()=>setCategory(item.id)}>{item.name}</button>)}
    </nav>
    {loading?<div className="knowledge-loading">جارٍ تحميل الأخبار والمعارف…</div>:<>
      <section className="knowledge-hero">
        {hero&&<article><div className="knowledge-hero-image">
          {hero.cover_image_url?<img src={hero.cover_image_url} alt=""/>:<span>ماركتون</span>}
          <div className="knowledge-hero-overlay"><em>{typeLabel(hero)}</em><h2>{hero.title}</h2><p>{hero.excerpt}</p><small>{new Date(hero.published_at||hero.created_at).toLocaleDateString('ar-SA',{day:'numeric',month:'long',year:'numeric'})}</small></div>
        </div></article>}
        <aside>{rest.slice(0,3).map(post=><article key={post.id}>
          <div>{post.cover_image_url?<img src={post.cover_image_url} alt=""/>:<span>م</span>}</div>
          <section><em>{typeLabel(post)}</em><h3>{post.title}</h3><small>{new Date(post.published_at||post.created_at).toLocaleDateString('ar-SA')}</small></section>
        </article>)}</aside>
      </section>
      <section className="knowledge-section-title"><div><small>آخر التحديثات</small><h2>أحدث الأخبار والمعارف</h2></div><span>{all.length} مادة</span></section>
      <section className="knowledge-list">{all.map(post=><article key={post.id} className={post.content_type==='tender'?'tender':''}>
        <div className="knowledge-list-image">{post.cover_image_url?<img src={post.cover_image_url} alt=""/>:<span>م</span>}</div>
        <div className="knowledge-list-body">
          <div><em>{post.knowledge_categories?.name||typeLabel(post)}</em>{post.is_breaking&&<b>مهم</b>}</div>
          <h3>{post.title}</h3><p>{post.excerpt}</p>
          {post.content_type==='tender'&&post.tender_deadline&&<strong className="deadline">يغلق في {new Date(post.tender_deadline).toLocaleDateString('ar-SA')}</strong>}
          <footer><span>{post.source_name||'ماركتون'}</span><time>{new Date(post.published_at||post.created_at).toLocaleDateString('ar-SA')}</time></footer>
        </div>
      </article>)}</section>
    </>}
  </main>;
}
