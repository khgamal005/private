import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import AcademyShell from '../../components/academy-shell';
import AcademyCourseDelivery from '../../components/academy-course-delivery';
import AcademyPeopleWorkspace from '../../components/academy-people-workspace';
import AcademyStorefront from '../../components/academy-storefront';
import AcademyVideoField from '../../components/academy-video-field';
import {access} from './academy-fixtures.mjs';
import {courseId,deliveryView,peopleView,storeView} from '../fixtures/academy-delivery-ui.mjs';
import '../../app/globals.css';
import '../../app/marktone-theme.css';
import '../../app/rebuild.css';
const delivery=deliveryView();
window.fetch=async(input,options={})=>{
 const url=String(input),{payload={}}=JSON.parse(options.body||'{}'),action=url.split('/').at(-1);
 if(url.startsWith('/api/academy-delivery/')){
  if(action==='create_run'){const runId=crypto.randomUUID();delivery.runs.push({...payload,id:runId,status:'open',selfPaced:false,instructors:[],sessions:[]});return Response.json({runId});}
  if(action==='save_offer'){let offer=delivery.offers.find(row=>row.runId===payload.runId);if(!offer){offer={id:crypto.randomUUID(),runId:payload.runId,version:0,published:false};delivery.offers.push(offer);}Object.assign(offer,{...payload,version:offer.version+1});return Response.json({runId:payload.runId});}
  if(action==='publish_offer'){const offer=delivery.offers.find(row=>row.id===payload.offerId);offer.published=payload.published;offer.version++;return Response.json({});}
  if(action==='assign_instructor'){const run=delivery.runs.find(row=>row.id===payload.runId);run.instructors=payload.active?[{subjectId:payload.subjectId,name:'محاضر تجريبي'}]:[];return Response.json({});}
  return Response.json(delivery);
 }
 if(url.startsWith('/api/academy-people/'))return Response.json(action==='snapshot'?peopleView(payload.kind):action.startsWith('invite_')?{invitationUrl:'/training/accept?tenant=marktone#synthetic-preview'}:{studentId:courseId});
 return Response.json({error:'الفحص المعزول لا يرسل بيانات حقيقية.'},{status:403});
};
function Video(){const [value,setValue]=useState('');return <section style={{padding:24,background:'#fff',borderRadius:16,marginTop:20}}><h2>فيديو الدرس</h2><AcademyVideoField slug="marktone" courseId={courseId} value={value} onChange={setValue} enabled/></section>;}
const path=window.location.pathname;
createRoot(window.document.getElementById('root')).render(path.startsWith('/site/')?<AcademyStorefront slug="marktone" data={storeView()}/>:<AcademyShell access={access}><nav style={{display:'flex',gap:20,marginBottom:24}}><a href="/academy/marktone/delivery">الدورة والبيع</a><a href="/academy/marktone/people">الأشخاص</a><a href="/site/marktone/courses">المتجر</a></nav>{path.endsWith('/people')?<AcademyPeopleWorkspace slug="marktone" initialData={peopleView()} canOpenOperations/>:<div style={{maxWidth:1050,margin:'auto'}}><AcademyCourseDelivery slug="marktone" courseId={courseId} learningMode="live"/><Video/></div>}</AcademyShell>);
