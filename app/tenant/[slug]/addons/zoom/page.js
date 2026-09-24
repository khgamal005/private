import ZoomWorkspace from '../../../../../components/zoom-workspace';
import {zoomSnapshot} from '../../../../../lib/zoom-snapshot';
import {zoomErrorMessage} from '../../../../../lib/zoom-contract.mjs';
import {requireTenantAddon,hasPlatformPermission} from '../../../../../lib/server-auth';
export const dynamic='force-dynamic';
export const metadata={title:'تشغيل زووم | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function ZoomSettingsPage({params,searchParams}){
 const {slug}=await params,search=await searchParams;
 const context=await requireTenantAddon(slug,'zoom');
 const requestedView=['accounts','sessions','reports','recordings'].includes(search?.view)?search.view:null;
 let view=requestedView||'sessions';
 let data;
 try{data=await zoomSnapshot(slug,view);if(!requestedView&&data.permissions?.accounts){view='accounts';data=await zoomSnapshot(slug,view);}}
 catch(e){
  const missingSnapshot=/Could not find the function public\.v1_zoom_snapshot\b|function public\.v1_zoom_snapshot\([^\n]*\) does not exist/.test(String(e.code||''));
  return <main className="mt-empty"><h1>تشغيل زووم</h1><p role="alert">{missingSnapshot?'إضافة Zoom بانتظار استكمال تجهيز الخادم. إعدادات الحسابات غير متاحة حاليًا؛ تواصل مع مسؤول المنصة لاستكمال التجهيز.':zoomErrorMessage(e.code)}</p></main>;
 }
 return <ZoomWorkspace slug={slug} initialData={data} initialView={view} oauthOutcome={['connected','cancelled','failed'].includes(search?.zoom)?search.zoom:null} canManagePlatform={hasPlatformPermission(context,'platform.billing.manage')}/>;
}
