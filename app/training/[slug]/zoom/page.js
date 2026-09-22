import Link from 'next/link';
import {redirect} from 'next/navigation';
import {accessToken} from '../../../../lib/server-auth';
import {trainingRpc} from '../../../../lib/training-server';
import {zoomErrorMessage} from '../../../../lib/zoom-contract.mjs';
import styles from '../../../../components/zoom-workspace.module.css';
export const dynamic='force-dynamic';
export const metadata={title:'محاضراتي | أودير',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function ZoomPortal({params,searchParams}){
 const {slug}=await params,search=await searchParams,instructor=search?.role==='instructor';const role=instructor?'instructor':'learner';
 if(!await accessToken())redirect(`/training/login?workspace=zoom&tenant=${encodeURIComponent(slug)}&role=${role}`);
 let data,errorCode;
 try{
  await trainingRpc('v1_zoom_portal',{p_slug:slug,p_role:role});data=await trainingRpc('v1_zoom_snapshot',{p_slug:slug,p_view:instructor?'sessions':'learner'});
 }catch(error){errorCode=error.code||error.message;}
 if(errorCode)return <main className={styles.workspace}><h1>محاضراتي</h1><p role="alert">{zoomErrorMessage(errorCode)}</p></main>;
  return <main className={styles.workspace} dir="rtl"><h1>محاضراتي المباشرة</h1><p>{data.tenant.name}</p><div className={styles.cards}>{data.sessions.map(s=><article className={styles.card} key={s.id}><small>{s.courseTitle} · {s.runTitle}</small><h2>{s.title}</h2><p>{new Date(s.startsAt).toLocaleString('ar-SA')}</p><Link href={`/training/${slug}/sessions/${s.id}${instructor?'?role=instructor':''}`}>فتح صفحة المحاضرة</Link></article>)}</div>{!data.sessions.length&&<p>لا توجد محاضرات في الفترة الحالية.</p>}</main>;
}
