'use client';
import {useRef,useState} from 'react';
import Link from 'next/link';
import {zoomRequest} from './zoom-workspace';
import styles from './zoom-workspace.module.css';

export default function ZoomLecture({slug,session,instructor=false,recordings=[]}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[sdkState,setSdkState]=useState(''),root=useRef(null);
 async function run(action,payload={}){if(busy)return;setBusy(true);setError('');try{const result=await zoomRequest(slug,action,{sessionId:session.id,enrollmentId:session.enrollmentId,...payload});if(result.url)window.location.assign(result.url);return result;}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function embed(){const result=await run('sdk',{asHost:instructor});if(!result)return;if(!result.available){setSdkState(result.reasonLabel||'الدخول المضمن غير متاح لهذا الحساب. يمكنك الانضمام من تطبيق زووم.');return;}try{setSdkState('جارٍ تهيئة الاجتماع. اسمح باستخدام الصوت والكاميرا عند الطلب.');const {startZoomSdk}=await import('../lib/zoom-sdk-browser.mjs');await startZoomSdk(result,root.current);setSdkState('بدأت واجهة زووم. حالة الصوت والكاميرا تظهر داخل الاجتماع.');}catch{setSdkState('تعذر الدخول المضمن. استخدم زر الانضمام عبر زووم.');}}
 return <main className={styles.workspace} dir="rtl"><header className={styles.header}><div><p className={styles.eyebrow}>{session.courseTitle} · {session.runTitle}</p><h1>{session.title}</h1><p>{new Date(session.startsAt).toLocaleString('ar-SA')} — {new Date(session.endsAt).toLocaleTimeString('ar-SA')}</p><p>المدرب: {session.instructor||'يحدده مسؤول التدريب'}</p></div><Link href={`/training/${slug}/zoom${instructor?'?role=instructor':''}`}>محاضراتي</Link></header>
 {error&&<p className={styles.error} role="alert">{error}</p>}
 <section className={styles.card}><h2>{instructor?'بدء المحاضرة':'الدخول للمحاضرة'}</h2><p>{instructor?'يُتحقق من إسنادك وتفويضك لدى زووم قبل إتاحة البدء.':'يُتحقق من تسجيلك واستحقاقك عند كل دخول. رابطك مرتبط بحسابك؛ لا تشاركه.'}</p><div className={styles.actions}><button disabled={busy} onClick={()=>run(instructor?'instructor_start':'join')}>{busy?'جارٍ التحقق…':instructor?'بدء عبر زووم':'الانضمام عبر زووم'}</button><button disabled={busy} onClick={embed}>الدخول داخل أودير عند توفره</button></div>{sdkState&&<p role="status">{sdkState}</p>}<div ref={root} aria-label="واجهة اجتماع زووم"/></section>
 {!instructor&&session.attendance&&<section className={styles.card}><h2>حضوري</h2><p>{session.attendance.status==='present'?'حاضر':session.attendance.status==='late'?'متأخر':session.attendance.status==='excused'?'بعذر':session.attendance.status==='absent'?'غائب':'بانتظار اعتماد الحضور'}</p><p>{session.attendance.percent==null?'المدة لم تعتمد بعد.':`نسبة الزمن المؤهل: ${Number(session.attendance.percent).toFixed(1)}٪`}</p></section>}
 <h2>مواد المحاضرة وتسجيلاتها</h2><div className={styles.cards}>{recordings.map(r=><article key={r.id} className={styles.card}><h3>{r.title}</h3><p>{r.file_type} · متاح حتى {r.expires_at?new Date(r.expires_at).toLocaleDateString('ar-SA'):'اعتماد السياسة'}</p><button disabled={busy} onClick={()=>run('recording_access',{recordingId:r.id})}>فتح التسجيل</button><p>المتاح هنا دليل فتح الرابط. لا تُحتسب مدة المشاهدة من بقاء الصفحة مفتوحة.</p></article>)}</div>{!recordings.length&&<p className={styles.empty}>لم يُنشر تسجيل للمحاضرة حتى الآن.</p>}
 </main>;
}
