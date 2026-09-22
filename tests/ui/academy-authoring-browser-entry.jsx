import React from 'react';
import {createRoot} from 'react-dom/client';
import AcademyShell from '../../components/academy-shell';
import AcademyAuthoringWorkspace from '../../components/academy-authoring-workspace';
import {createAuthoringDocument} from '../../lib/academy-authoring.mjs';
import {access} from './academy-fixtures.mjs';
import '../../app/globals.css';
import '../../app/marktone-theme.css';
import '../../app/rebuild.css';

// Synthetic verification transport. Never installed in a production route.
const id='fb373279-362b-4101-947d-08a6269ec6dd';
const document=createAuthoringDocument('مهارات القيادة وإدارة الفريق');
document.description='رحلة عملية لتطوير مهارات التواصل وقيادة فرق العمل.';
document.policy={...document.policy,termsVersion:'الشروط التدريبية ١',supportEmail:'training@example.test'};
document.topics=[{id:'topic-1',title:'أساسيات القيادة',summary:'ابدأ بفهم دور القائد ومهاراته.',units:[{id:'lesson-1',title:'ما الذي يصنع قائدًا ناجحًا؟',kind:'text',required:true,minimumSeconds:0,body:'حدد هدفًا واضحًا للفريق، ووزع المسؤوليات، ثم تابع النتائج بشكل منتظم.',url:'',questions:[],maxAttempts:3,passPercent:70}]},{id:'topic-2',title:'من المعرفة إلى التطبيق',summary:'طبّق ما تعلمته على موقف عملي.',units:[{id:'task-1',title:'خطة تطوير الفريق',kind:'assignment',required:true,minimumSeconds:0,body:'اكتب خطة من ثلاث خطوات لتطوير أداء فريقك خلال شهر.',url:'',questions:[],maxAttempts:3,passPercent:70}]}];
const courses=new Map([[id,{courseId:id,revision:1,document,publishedRevision:null,publishedVersionId:null,publishedAt:null}]]),paths=new Map();
function snapshot(payload={}){
  return {available:true,tenant:access.tenant,ai:{configured:false,status:'unconfigured'},offset:0,pathOffset:0,hasMore:{courses:false,paths:false},courses:[...courses.values()].map(c=>({id:c.courseId,title:c.document.title,draftTitle:c.document.title,category:c.document.category,authoringRevision:c.revision,publishedRevision:c.publishedRevision,publishedVersionId:c.publishedVersionId,publishedAt:c.publishedAt})),paths:[...paths.values()].map(p=>({pathId:p.pathId,title:p.document.title,revision:p.revision,publishedRevision:p.publishedRevision,courseCount:p.document.courseIds.length})),course:courses.get(payload.courseId)||null,path:paths.get(payload.pathId)||null};
}
window.fetch=async(input,options={})=>{
  if(!String(input).startsWith('/api/academy-authoring/'))return Response.json({error:'مسار خارج الفحص المعزول'},{status:403});
  const action=String(input).split('/').at(-1),{payload}=JSON.parse(options.body);
  if(action==='snapshot')return Response.json(snapshot(payload));
  if(action==='create_course'){
    const courseId=crypto.randomUUID();courses.set(courseId,{courseId,revision:1,document:createAuthoringDocument(payload.title),publishedRevision:null,publishedVersionId:null});return Response.json({courseId,revision:1});
  }
  if(action==='save_course'){
    const current=courses.get(payload.courseId);current.document=payload.document;current.revision++;return Response.json({courseId:current.courseId,revision:current.revision});
  }
  if(action==='save_path'){
    const pathId=payload.pathId||crypto.randomUUID(),prior=paths.get(pathId),revision=(prior?.revision||0)+1;
    paths.set(pathId,{...prior,pathId,revision,document:payload.document});return Response.json({pathId,revision});
  }
  if(action==='publish_course'){
    const current=courses.get(payload.courseId);current.publishedRevision=current.revision;current.publishedVersionId=crypto.randomUUID();current.publishedAt=new Date().toISOString();return Response.json({courseId:current.courseId,revision:current.revision});
  }
  if(action==='publish_path'){
    const current=paths.get(payload.pathId);current.publishedRevision=current.revision;current.publishedAt=new Date().toISOString();return Response.json({pathId:current.pathId,revision:current.revision});
  }
  return Response.json({error:'عملية غير متاحة في الفحص'},{status:400});
};
createRoot(window.document.getElementById('root')).render(<AcademyShell access={access}><AcademyAuthoringWorkspace slug="marktone" initialData={snapshot()} initialView={location.pathname.endsWith('/paths')?'paths':'courses'}/></AcademyShell>);
