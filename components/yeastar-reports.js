'use client';

import {useState} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import styles from './yeastar-reports.module.css';

export default function YeastarReports({slug,initialData}){
  const router=useRouter();
  const search=useSearchParams();
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const data=initialData||{};
  const summary=data.summary||{};
  const calls=data.calls||[];
  const extensions=data.extensions||[];
  const configured=data.connection?.configured;

  function apply(event){
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(values)){
      if(value)params.set(key,String(value));
    }
    router.push(`/tenant/${encodeURIComponent(slug)}/call-reports?${params}`);
  }

  async function sync(){
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/yeastar/sync',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({tenantSlug:slug})
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'تعذرت المزامنة');
      setNotice(`تمت المزامنة: ${payload.fetchedCount||0} سجل، جديد ${payload.insertedCount||0}، محدث ${payload.updatedCount||0}.`);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>YEASTAR CALL INTELLIGENCE</small>
        <h2>تقارير المكالمات</h2>
        <p>أداء التحويلات، نسب الرد، المكالمات الفائتة، أوقات الذروة وتفاصيل CDR من Yeastar P550.</p>
      </div>
      <div className="mt-page-actions">
        <Link className="mt-button" href={`/tenant/${encodeURIComponent(slug)}/settings`}>إعدادات Yeastar</Link>
        <button className="mt-button primary" onClick={sync} disabled={!configured||busy||data.connection?.status==='disabled'}>
          {busy?'جارٍ جلب المكالمات…':'مزامنة الآن'}
        </button>
      </div>
    </header>

    {!configured&&<section className="mt-panel">
      <div className="mt-empty">
        لم يتم ربط Yeastar بعد.
        <Link className="mt-button primary" href={`/tenant/${encodeURIComponent(slug)}/settings`}>فتح الإعدادات</Link>
      </div>
    </section>}
    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}
    {data.connection?.lastError&&!error&&<div className="mt-alert error">{data.connection.lastError}</div>}

    <form className={`${styles.filters} mt-panel`} onSubmit={apply}>
      <label>من<input type="date" name="from" defaultValue={search.get('from')||''}/></label>
      <label>إلى<input type="date" name="to" defaultValue={search.get('to')||''}/></label>
      <label>التحويلة<select name="extension" defaultValue={search.get('extension')||''}>
        <option value="">كل التحويلات</option>
        {knownExtensions(data).map(extension=><option key={extension} value={extension}>{extension}</option>)}
      </select></label>
      <label>الاتجاه<select name="callType" defaultValue={search.get('callType')||''}>
        <option value="">كل الأنواع</option>
        <option value="Inbound">واردة</option>
        <option value="Outbound">صادرة</option>
        <option value="Internal">داخلية</option>
      </select></label>
      <label>النتيجة<select name="status" defaultValue={search.get('status')||''}>
        <option value="">كل النتائج</option>
        <option value="ANSWERED">تم الرد</option>
        <option value="NO ANSWER">بدون رد</option>
        <option value="ABANDONED">متروكة</option>
        <option value="BUSY">مشغول</option>
        <option value="FAILED">فشلت</option>
        <option value="VOICEMAIL">بريد صوتي</option>
      </select></label>
      <button className="mt-button primary">تطبيق التقرير</button>
    </form>

    <section className="mt-kpis">
      <Kpi label="إجمالي المكالمات" value={number(summary.totalCalls)} note={`${number(summary.inboundCalls)} واردة · ${number(summary.outboundCalls)} صادرة`}/>
      <Kpi label="تم الرد" value={number(summary.answeredCalls)} note={`نسبة الرد ${number(summary.answerRate)}%`} success/>
      <Kpi label="فائتة" value={number(summary.missedCalls)} note={`${number(summary.failedCalls)} مكالمة فشلت`} warning/>
      <Kpi label="وقت الحديث" value={duration(summary.totalTalkSeconds)} note={`المتوسط ${duration(summary.averageTalkSeconds)}`}/>
      <Kpi label="متوسط انتظار الرد" value={duration(summary.averageRoutingSeconds)} note="من بداية الرنين حتى الرد"/>
      <Kpi label="لها تسجيل" value={number(summary.recordedCalls)} note="مؤشر فقط دون نسخ الصوت"/>
    </section>

    <section className={styles.analyticsGrid}>
      <article className="mt-panel">
        <header className={styles.panelHead}><div><small>DAILY TREND</small><h3>اتجاه المكالمات اليومي</h3></div></header>
        <DailyBars rows={data.daily||[]}/>
      </article>
      <article className="mt-panel">
        <header className={styles.panelHead}><div><small>PEAK HOURS</small><h3>ساعات الذروة</h3></div></header>
        <HourlyBars rows={data.hourly||[]}/>
      </article>
    </section>

    <section className="mt-panel">
      <header className={styles.panelHead}>
        <div><small>EXTENSION PERFORMANCE</small><h3>أداء التحويلات</h3></div>
        <span>{extensions.length} تحويلة</span>
      </header>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>التحويلة</th><th>الإجمالي</th><th>تم الرد</th><th>فائتة</th><th>واردة</th><th>صادرة</th><th>نسبة الرد</th><th>وقت الحديث</th></tr></thead>
        <tbody>{extensions.map(row=><tr key={row.extension}>
          <td><b>{row.extension}</b>{row.extension==='105'&&<small>شهد</small>}</td>
          <td>{number(row.totalCalls)}</td>
          <td>{number(row.answeredCalls)}</td>
          <td>{number(row.missedCalls)}</td>
          <td>{number(row.inboundCalls)}</td>
          <td>{number(row.outboundCalls)}</td>
          <td>{number(row.answerRate)}%</td>
          <td>{duration(row.talkSeconds)}</td>
        </tr>)}</tbody>
      </table>{!extensions.length&&<div className="mt-empty">ستظهر إحصاءات التحويلات بعد أول مزامنة.</div>}</div>
    </section>

    <section className="mt-panel">
      <header className={styles.panelHead}>
        <div><small>CALL DETAIL RECORDS</small><h3>سجل المكالمات التفصيلي</h3></div>
        <span>{number(data.totalRecords)} سجل</span>
      </header>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>الوقت</th><th>النوع</th><th>من</th><th>إلى</th><th>النتيجة</th><th>الرنين</th><th>الحديث</th><th>المتابعة</th><th>التسجيل</th></tr></thead>
        <tbody>{calls.map(call=><tr key={call.id}>
          <td><b>{new Date(call.startedAt).toLocaleDateString('ar-SA')}</b><small>{new Date(call.startedAt).toLocaleTimeString('ar-SA')}</small></td>
          <td>{callType(call.callType)}</td>
          <td><b dir="ltr">{call.callerNumber||'—'}</b><small>{call.callerName||''}</small></td>
          <td><b dir="ltr">{call.calleeNumber||'—'}</b><small>{call.calleeName||call.lastParticipantName||''}</small></td>
          <td><span className={`mt-status ${call.finalStatus==='ANSWERED'?'active':''}`}>{status(call.finalStatus)}</span></td>
          <td>{duration(call.routingDurationSeconds)}</td>
          <td>{duration(call.handlingDurationSeconds)}</td>
          <td>{call.returnedAfterMissed===true?<span className={styles.returned}>تم الرد لاحقًا</span>:call.returnedAfterMissed===false?<span className={styles.notReturned}>لم يُعد الاتصال</span>:'—'}</td>
          <td>{call.hasRecording?'متاح':'—'}</td>
        </tr>)}</tbody>
      </table>{!calls.length&&<div className="mt-empty">لا توجد مكالمات ضمن الفلاتر الحالية.</div>}</div>
    </section>

    <footer className={styles.syncFooter}>
      <span>آخر مزامنة: {data.lastSync?.finishedAt?new Date(data.lastSync.finishedAt).toLocaleString('ar-SA'):'لم تتم بعد'}</span>
      {data.lastSync&&<span>الجهاز: {data.lastSync.deviceModel||'Yeastar'} · {data.lastSync.firmwareVersion||'—'} · API {data.lastSync.apiVersion||'—'}</span>}
    </footer>
  </>;
}

function Kpi({label,value,note,success,warning}){
  return <article className={`mt-kpi ${success?'success':''} ${warning?styles.warningKpi:''}`}>
    <span>{label}</span><b>{value}</b><small>{note}</small>
  </article>;
}

function DailyBars({rows}){
  const max=Math.max(...rows.map(row=>Number(row.total)||0),1);
  if(!rows.length)return <div className="mt-empty">لا توجد بيانات يومية بعد.</div>;
  return <div className={styles.barList}>{rows.slice(-14).map(row=><div key={row.date}>
    <span>{new Date(`${row.date}T00:00:00`).toLocaleDateString('ar-SA',{month:'short',day:'numeric'})}</span>
    <i><b style={{width:`${Math.max(4,100*Number(row.total)/max)}%`}}/></i>
    <strong>{number(row.total)}</strong>
  </div>)}</div>;
}

function HourlyBars({rows}){
  const max=Math.max(...rows.map(row=>Number(row.total)||0),1);
  if(!rows.length)return <div className="mt-empty">لا توجد بيانات لساعات الذروة بعد.</div>;
  return <div className={styles.hourGrid}>{rows.map(row=><div key={row.hour}>
    <i style={{height:`${Math.max(8,100*Number(row.total)/max)}%`}}/>
    <b>{number(row.total)}</b>
    <span>{String(row.hour).padStart(2,'0')}:00</span>
  </div>)}</div>;
}

function knownExtensions(data){
  const configured=String(data.connection?.extensions||'').split(',').map(value=>value.trim()).filter(Boolean);
  const reported=(data.extensions||[]).map(row=>String(row.extension));
  return [...new Set([...configured,...reported])].sort();
}

function number(value){return new Intl.NumberFormat('ar-SA').format(Number(value)||0)}
function duration(value){
  const seconds=Math.max(Number(value)||0,0);
  if(seconds<60)return `${number(Math.round(seconds))} ث`;
  const minutes=Math.floor(seconds/60);
  const rest=Math.round(seconds%60);
  if(minutes<60)return `${number(minutes)} د ${rest?`${number(rest)} ث`:''}`;
  return `${number(Math.floor(minutes/60))} س ${number(minutes%60)} د`;
}
function callType(value){return ({Inbound:'واردة',Outbound:'صادرة',Internal:'داخلية'})[value]||'غير محدد'}
function status(value){
  return ({
    ANSWERED:'تم الرد',
    'NO ANSWER':'بدون رد',
    ABANDONED:'متروكة',
    BUSY:'مشغول',
    FAILED:'فشلت',
    VOICEMAIL:'بريد صوتي',
    UNKNOWN:'غير محدد'
  })[value]||value;
}
