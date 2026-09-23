import ZoomWorkspace from '../../../../../components/zoom-workspace';
import {trainingRpc} from '../../../../../lib/training-server';
import {zoomErrorMessage} from '../../../../../lib/zoom-contract.mjs';
import {requireTenantAddon} from '../../../../../lib/server-auth';
export const dynamic='force-dynamic';
export const metadata={title:'تشغيل زووم | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function ZoomSettingsPage({params,searchParams}){
 const {slug}=await params,search=await searchParams;
 await requireTenantAddon(slug,'zoom');
 const view=['accounts','reports','recordings'].includes(search?.view)?search.view:'sessions';
 let data;
 try{data=await trainingRpc('v1_zoom_snapshot',{p_slug:slug,p_view:view});}
 catch(e){
  const missingSnapshot=/Could not find the function public\.v1_zoom_snapshot\b|function public\.v1_zoom_snapshot\([^\n]*\) does not exist/.test(String(e.code||''));
  return <main className="mt-empty"><h1>تشغيل زووم</h1><p role="alert">{missingSnapshot?'إضافة Zoom بانتظار استكمال تجهيز الخادم. إعدادات الحسابات غير متاحة حاليًا؛ تواصل مع مسؤول المنصة لاستكمال التجهيز.':zoomErrorMessage(e.code)}</p></main>;
 }
 return <ZoomWorkspace slug={slug} initialData={data} initialView={view}/>;
}
