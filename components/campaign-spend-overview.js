'use client';
import Link from 'next/link';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {requestGoogleAction,formatGoogleMetric,googleErrorMessage} from '../lib/google-ads/ui.mjs';
import styles from './campaign-decision.module.css';
export default function CampaignSpendOverview({slug,filters,meta,metaSnapshot,google,googleSnapshot,canManageMeta}){
 const router=useRouter(),[busy,setBusy]=useState(''),[notice,setNotice]=useState('');
 async function sync(platform){
  if(busy)return;setBusy(platform);setNotice('');
  try{
   let data;
   if(platform==='google')data=await requestGoogleAction({name:'sync',slug,payload:{dateFrom:filters.dateFrom,dateTo:filters.dateTo}});
   else{const response=await fetch('/api/tenant/social-connect/sync',{signal:AbortSignal.timeout(145_000),method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tenantSlug:slug,dateFrom:filters.dateFrom,dateTo:filters.dateTo})});data=await response.json();if(!response.ok)throw new Error('sync_failed');}
   if(data.status==='failed')throw new Error('sync_failed');
   setNotice(['queued','running'].includes(data.status)?'المزامنة جارية. حدّث التقرير بعد قليل.':'تم تحديث بيانات المنصة.');router.refresh();
  }catch(error){setNotice(platform==='google'?googleErrorMessage(error.message):'تعذر تحديث Meta. راجع حالة الاتصال في إعدادات الإضافة.');}finally{setBusy('');}
 }
 const sources=[
  {key:'meta',name:'Meta',report:meta,currency:meta?.summary?.currency,snapshot:metaSnapshot,manage:canManageMeta&&metaSnapshot?.syncEnabled&&!metaSnapshot?.legacyProtected,href:'campaigns?platform=meta',settings:'social-connect',complete:false},
  {key:'google',name:'Google Ads',report:google,currency:google?.currency,snapshot:googleSnapshot,manage:googleSnapshot?.canManage&&googleSnapshot?.enabled&&Boolean(google),href:'google-ads',settings:'google-kit',complete:google?.coverage?.spendComplete===true}
 ];
 return <section className={styles.panel} aria-label="إنفاق المنصات"><div className={styles.heading}><div><small>الإنفاق الإعلاني</small><h2>أين صُرفت الميزانية؟</h2></div><span className={styles.hint}>{filters.dateFrom} — {filters.dateTo}</span></div>
 <div className={styles.sources}>{sources.map(source=><article key={source.key}><div className={styles.heading}><b>{source.name}</b><span className={styles.badge}>{source.report?(source.complete?'الفترة مكتملة':'بيانات متزامنة'):source.snapshot?.selectedAccount?'الفترة غير متاحة':'غير مرتبط'}</span></div><strong>{formatGoogleMetric(source.report?.summary?.spendMinor,{money:true,currency:source.currency||''})}</strong><p>{source.report?(source.complete?'جميع أيام الفترة متاحة.':'راجع تغطية الفترة قبل مقارنة التكلفة بالتحصيل.'):'يعرض الإنفاق عند توفر الحساب وبيانات الفترة.'}</p><div className={styles.actions}><Link href={`/tenant/${encodeURIComponent(slug)}/reports/${source.href}&from=${filters.dateFrom}&to=${filters.dateTo}`.replace('google-ads&','google-ads?')}>تفاصيل التقرير ←</Link>{source.manage&&source.snapshot?.selectedAccount?<button type="button" disabled={Boolean(busy)} onClick={()=>sync(source.key)}>{busy===source.key?'جارٍ المزامنة…':'مزامنة سريعة'}</button>:<Link href={`/tenant/${encodeURIComponent(slug)}/addons/${source.settings}`}>إعدادات الإضافة</Link>}</div></article>)}</div>
 <p className={styles.hint}>الإنفاق حسب فلاتر كل منصة؛ فلاتر موظف المبيعات والدورة تخص نتائج أودير. لا نجمع العملات المختلفة أو نستنتج تكلفة الاستحواذ من مصادر غير مكتملة.</p>{notice?<p role="status">{notice}</p>:null}</section>;
}
