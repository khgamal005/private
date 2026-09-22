import React from 'react';
import {createRoot} from 'react-dom/client';
import AcademyShell from '../../components/academy-shell';
import AcademyOverviewPage from '../../app/academy/[slug]/page';
import AcademyLoginForm from '../../components/academy-login-form';
import AcademyInvitationForm from '../../components/academy-invitation-form';
import AcademyCommerceWorkspace from '../../components/academy-commerce-workspace';
import AcademyStorefront from '../../components/academy-storefront';
import BuiltPublicPage from '../../components/built-public-page';
import PlatformAcademyControls from '../../components/platform-academy-controls';
import {access,commerce,storefront,site} from './academy-fixtures.mjs';
import '../../app/globals.css';
import '../../app/marktone-theme.css';
import '../../app/rebuild.css';
import '../../app/auth-mobile-input-fix.css';

// Fixture-only transport: no production API or database request is possible.
window.fetch=async (input,options={})=>{
 const path=String(input);
 if(path==='/api/academy-invitations/preview')return Response.json({tenantName:access.tenant.name,email:'manager@example.test',role:'manager'});
 if(path.startsWith('/api/platform/academy-controls')&&(!options.method||options.method==='GET'))return Response.json({data:{actions:{canConfigure:true,canGrantTrial:true,canManageMembers:true},tenants:[{...access.tenant,...access,pilotEligible:true,version:1,academyMembers:[{subjectId:'qa-user',name:'مدير تجريبي',email:'manager@example.test',role:'manager',status:'active'}]}]}});
 return Response.json({error:'واجهة فحص مرئي فقط؛ لا تُنفذ عمليات.'},{status:403});
};
const route=window.location.pathname;
let content;
if(route==='/academy/login')content=<main className="auth-page" dir="rtl"><section className="auth-card narrow"><div className="auth-copy"><p>منصة ماركتون التدريبية</p><h1>إدارة الموقع والتدريب</h1><span>ادخل إلى مساحة منشأتك لإدارة الموقع والمتجر وتجربة التعلم.</span></div><AcademyLoginForm initialSlug="marktone"/></section></main>;
else if(route==='/academy/accept')content=<main style={{maxWidth:480,margin:'8vh auto',padding:24}}><AcademyInvitationForm tenantSlug="marktone"/></main>;
else if(route==='/site/marktone/courses')content=<AcademyStorefront slug="marktone" data={storefront}/>;
else if(route==='/site/marktone')content=<BuiltPublicPage snapshot={site} content={site.homePage}/>;
// This isolated bundle has no Next router; the harness intentionally uses document navigation.
// eslint-disable-next-line @next/next/no-location-assign-relative-destination
else if(route==='/control/tenants')content=<PlatformAcademyControls tenant={{name:access.tenant.name,slug:'marktone'}} onClose={()=>window.location.assign('/academy/marktone')}/>;
else content=<AcademyShell access={access}>{route.endsWith('/store')?<AcademyCommerceWorkspace slug="marktone" initialData={commerce}/>:await AcademyOverviewPage({params:Promise.resolve({slug:'marktone'})})}</AcademyShell>;
createRoot(document.getElementById('root')).render(content);
