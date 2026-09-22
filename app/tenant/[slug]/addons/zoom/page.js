import ZoomWorkspace from '../../../../../components/zoom-workspace';
import {trainingRpc} from '../../../../../lib/training-server';
import {zoomErrorMessage} from '../../../../../lib/zoom-contract.mjs';
export const dynamic='force-dynamic';
export const metadata={title:'تشغيل زووم | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function ZoomSettingsPage({params,searchParams}){
 const {slug}=await params,search=await searchParams;const view=['accounts','reports','recordings'].includes(search?.view)?search.view:'sessions';
 let data;try{data=await trainingRpc('v1_zoom_snapshot',{p_slug:slug,p_view:view});}catch(e){return <main className="mt-empty"><h1>تشغيل زووم</h1><p role="alert">{zoomErrorMessage(e.code)}</p></main>;}
 return <ZoomWorkspace slug={slug} initialData={data} initialView={view}/>;
}
