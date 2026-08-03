'use client';

import Link from 'next/link';
import {useMemo,useState} from 'react';
import {useRouter,useSearchParams} from 'next/navigation';
import {
  CMS_SECTIONS,buildMenuTree,cmsBasePath,cmsBuilderPath,
  cmsPublicPath,slugify
} from '../lib/cms';
import {Overview,PagesPanel} from './cms-studio-pages';
import {MenusPanel} from './cms-studio-menus';
import {ArticlesPanel,MediaPanel,MessagesPanel,SettingsPanel} from './cms-studio-content';
import {EditorModal} from './cms-studio-editor';
import {Status,cleanPayload} from './cms-studio-ui';
import styles from './cms-studio.module.css';

export default function CmsStudio({initialData}){
  const router=useRouter();
  const searchParams=useSearchParams();
  const data=initialData||{};
  const context=data.context||{};
  const base=cmsBasePath(context);
  const requested=searchParams.get('section');
  const [section,setSectionState]=useState(CMS_SECTIONS.some(item=>item.key===requested)?requested:'overview');
  const [editor,setEditor]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState(null);
  const [query,setQuery]=useState('');
  const [activeMenuId,setActiveMenuId]=useState(data.menus?.find(menu=>menu.location==='header')?.id||data.menus?.[0]?.id||'');
  const [uploading,setUploading]=useState(false);
  const pages=Array.isArray(data.pages)?data.pages:[];
  const articles=Array.isArray(data.articles)?data.articles:[];
  const menus=Array.isArray(data.menus)?data.menus:[];
  const menuItems=Array.isArray(data.menuItems)?data.menuItems:[];
  const assets=Array.isArray(data.assets)?data.assets:[];
  const categories=Array.isArray(data.categories)?data.categories:[];
  const submissions=Array.isArray(data.submissions)?data.submissions:[];
  const home=pages.find(page=>page.isHome);
  const activeMenu=menus.find(menu=>menu.id===activeMenuId)||menus[0];
  const activeTree=useMemo(()=>buildMenuTree(menuItems,activeMenu?.id),[menuItems,activeMenu?.id]);

  function setSection(key){
    setSectionState(key);
    const params=new URLSearchParams(searchParams.toString());
    params.set('section',key);
    router.replace(`${base}?${params.toString()}`,{scroll:false});
    setQuery('');
  }

  async function call(action,payload,{refresh=true,close=true,message='تم حفظ التعديلات'}={}){
    setBusy(action);setNotice(null);
    try{
      const response=await fetch(`/api/cms/${action}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({siteKey:context.siteKey,tenantSlug:context.tenantSlug||null,payload})
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result?.error||'تعذر تنفيذ العملية');
      if(close)setEditor(null);
      if(message)setNotice({type:'success',text:message});
      if(refresh)router.refresh();
      return result.data;
    }catch(error){
      setNotice({type:'error',text:error instanceof Error?error.message:String(error)});
      return null;
    }finally{setBusy('');}
  }

  async function submitEditor(type,payload){
    if(type==='menuItem'&&payload.kind==='page'&&payload.targetPageId==='__new__'){
      const title=payload.newPageTitle?.trim();
      if(!title){setNotice({type:'error',text:'اكتب عنوان الصفحة الجديدة'});return;}
      const created=await call('create-page',{
        title,slug:payload.newPageSlug||slugify(title,'page'),excerpt:'',status:'draft',
        pageKind:'standard',visibility:'public',showInMenu:false
      },{refresh:false,close:false,message:''});
      const newPageId=created?.result?.id;
      if(!newPageId)return;
      payload={...payload,targetPageId:newPageId};
    }
    if(type==='menuItem'&&payload.kind==='article'&&payload.targetArticleId==='__new__'){
      const title=payload.newArticleTitle?.trim();
      if(!title){setNotice({type:'error',text:'اكتب عنوان المقال الجديد'});return;}
      const created=await call('create-article',{
        title,slug:payload.newArticleSlug||slugify(title,'article'),excerpt:'',status:'draft',
        visibility:'public',tags:[]
      },{refresh:false,close:false,message:''});
      const id=created?.result?.id;
      if(!id)return;
      payload={...payload,targetArticleId:id};
    }
    const map={
      page:payload.id?'update-page':'create-page',
      article:payload.id?'update-article':'create-article',
      menu:payload.id?'update-menu':'create-menu',
      menuItem:'save-menu-item',
      category:payload.id?'update-category':'create-category',
      asset:'update-asset'
    };
    await call(map[type],cleanPayload(payload));
  }

  async function archive(action,id,label){
    if(!window.confirm(`هل تريد أرشفة ${label}؟ يمكن الاحتفاظ بالمحتوى دون حذفه نهائيًا.`))return;
    await call(action,{id},{message:'تمت الأرشفة بنجاح'});
  }

  async function uploadFiles(fileList){
    const files=Array.from(fileList||[]);
    if(!files.length)return;
    setUploading(true);setNotice(null);
    let success=0;
    for(const file of files){
      const form=new FormData();
      form.set('file',file);form.set('siteKey',context.siteKey||'marktone-main');
      if(context.tenantSlug)form.set('tenantSlug',context.tenantSlug);
      try{
        const response=await fetch('/api/cms/media/upload',{method:'POST',body:form});
        const result=await response.json();
        if(!response.ok)throw new Error(result?.error||`تعذر رفع ${file.name}`);
        success+=1;
      }catch(error){setNotice({type:'error',text:error instanceof Error?error.message:String(error)});}
    }
    setUploading(false);
    if(success){setNotice({type:'success',text:`تم رفع ${success} صورة إلى المكتبة`});router.refresh();}
  }

  const panelProps={data,context,base,pages,articles,menus,menuItems,assets,categories,submissions,query,setQuery,setEditor,call,archive,busy};
  return <div className={styles.studio} dir="rtl">
    <header className={styles.hero}>
      <div className={styles.heroCopy}>
        <span>{context.scope==='tenant'?'إضافة ماركتون المدفوعة':'Marktone CMS Studio'}</span>
        <h1>إدارة الموقع الإلكتروني</h1>
        <p>أنشئ الصفحات والمقالات والقوائم والميجا منيو، وصمّم كل محتوى بصريًا من نواة واحدة قابلة للتحديث لجميع المواقع.</p>
        <div className={styles.contextPills}><b>{data.site?.nameAr}</b><Status value={data.site?.status}/><small>CMS v{context.cmsVersion||2}</small>{context.scope==='tenant'&&<small>إضافة {context.addonStatus==='active'?'مفعلة':'تجريبية'}</small>}</div>
      </div>
      <div className={styles.heroActions}>
        <Link href={cmsPublicPath(context,'page',home||{isHome:true})} target="_blank" className={styles.outlineButton}>فتح الموقع ↗</Link>
        {home&&<Link href={cmsBuilderPath(context,'page',home.id)} className={styles.primaryButton}>تصميم الصفحة الرئيسية</Link>}
      </div>
    </header>

    {notice&&<div className={`${styles.notice} ${notice.type==='error'?styles.noticeError:styles.noticeSuccess}`}><span>{notice.text}</span><button type="button" onClick={()=>setNotice(null)}>×</button></div>}

    <nav className={styles.sectionNav} aria-label="أقسام إدارة الموقع">
      {CMS_SECTIONS.map(item=><button key={item.key} type="button" className={section===item.key?styles.activeSection:''} onClick={()=>setSection(item.key)}><span>{item.icon}</span>{item.label}{item.key==='messages'&&Number(data.stats?.newMessages)>0&&<b>{data.stats.newMessages}</b>}</button>)}
    </nav>

    <main className={styles.workspace}>
      {section==='overview'&&<Overview {...panelProps} home={home} setSection={setSection}/>} 
      {section==='pages'&&<PagesPanel {...panelProps}/>} 
      {section==='menus'&&<MenusPanel {...panelProps} activeMenu={activeMenu} activeTree={activeTree} setActiveMenuId={setActiveMenuId}/>} 
      {section==='articles'&&<ArticlesPanel {...panelProps}/>} 
      {section==='media'&&<MediaPanel {...panelProps} uploading={uploading} uploadFiles={uploadFiles}/>} 
      {section==='messages'&&<MessagesPanel {...panelProps}/>} 
      {section==='settings'&&<SettingsPanel {...panelProps}/>} 
    </main>

    {editor&&<EditorModal
      editor={editor} pages={pages} articles={articles} menus={menus}
      menuItems={menuItems} assets={assets} categories={categories}
      busy={busy} onClose={()=>setEditor(null)} onSubmit={submitEditor}
    />}
  </div>;
}
