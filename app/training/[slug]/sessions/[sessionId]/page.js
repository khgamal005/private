import {redirect,notFound} from 'next/navigation';
import {accessToken} from '../../../../../lib/server-auth';
import {trainingRpc} from '../../../../../lib/training-server';
import {validTrainingId} from '../../../../../lib/training-request.mjs';
import ZoomLecture from '../../../../../components/zoom-lecture';
import {zoomErrorMessage} from '../../../../../lib/zoom-contract.mjs';
export const dynamic='force-dynamic';
export const metadata={title:'المحاضرة المباشرة | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function LecturePage({params,searchParams}){
 const {slug,sessionId}=await params,search=await searchParams;if(!validTrainingId(sessionId))notFound();
 const instructor=search?.role==='instructor';if(!await accessToken())redirect(`/training/login?workspace=zoom&tenant=${encodeURIComponent(slug)}&role=${instructor?'instructor':'learner'}`);
 try{
  const data=await trainingRpc('v1_zoom_snapshot',{p_slug:slug,p_view:instructor?'sessions':'learner',p_options:{sessionId}});const session=data.sessions[0];if(!session)return <main><p>هذه المحاضرة غير متاحة لحسابك.</p></main>;
  const recordings=session.linkId?await trainingRpc('v1_zoom_snapshot',{p_slug:slug,p_view:'recordings',p_options:{linkId:session.linkId}}):{recordings:[]};
  return <ZoomLecture slug={slug} session={session} instructor={instructor} recordings={recordings.recordings}/>;
 }catch(error){return <main><h1>المحاضرة المباشرة</h1><p role="alert">{zoomErrorMessage(error.code)}</p></main>;}
}
