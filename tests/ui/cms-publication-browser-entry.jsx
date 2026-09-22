import React from 'react';
import {createRoot} from 'react-dom/client';
import CmsStudio from '../../components/cms-studio';
import '../../app/globals.css';
import '../../app/marktone-theme.css';
const params=new URLSearchParams(window.location.search);
const siteStatus=params.get('site')||'draft';
const pageStatus=params.get('page')||'published';
const data={
 context:{scope:'tenant',siteKey:'tenant:marktone',tenantSlug:'marktone',canPublish:params.get('role')!=='editor',cmsVersion:2,addonStatus:'active'},
 site:{nameAr:'مركز ماركتون',status:siteStatus,settings:{siteTitle:'مركز ماركتون'}},
 pages:[{id:'61000000-0000-4000-8000-000000009400',title:'الصفحة الرئيسية',isHome:true,status:pageStatus,visibility:'public',slug:'home',builder:{hasDraft:true,blockCount:3,hasPublished:pageStatus==='published',hasUnpublishedChanges:params.has('changes'),draftUpdatedAt:'2026-09-22T12:00:00Z',publishedAt:pageStatus==='published'?'2026-09-22T11:00:00Z':null}}],
 stats:{pages:1,publishedPages:pageStatus==='published'?1:0,menus:1},menus:[],articles:[]
};
// No live writes: expose the requested action visibly for interaction assertions.
window.fetch=async(input,options)=>{
 const payload=JSON.parse(options.body);const output=document.getElementById('fixture-result');
 output.textContent=JSON.stringify({path:String(input),payload});
 return Response.json({success:true,data:{success:true}});
};
createRoot(document.getElementById('root')).render(<main style={{maxWidth:1200,margin:'auto',padding:16}}><CmsStudio initialData={data}/><output id="fixture-result"/></main>);
