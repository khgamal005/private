'use client';

import {useMemo,useState} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {yeastarErrorMessage} from '../lib/yeastar-errors';
import ReportExcelButton from './report-excel-button';
import styles from './yeastar-reports.module.css';

const MISSED_STATUSES=new Set(['NO ANSWER','ABANDONED','BUSY']);
const ROLE_LABELS={
  tenant_owner:'مالك المنشأة',tenant_admin:'مدير المنشأة',executive_manager:'المدير التنفيذي',
  sales_manager:'مدير المبيعات',sales_supervisor:'مشرف المبيعات',sales_user:'مسؤول المبيعات',
  customer_service:'خدمة العملاء',data_officer:'مسؤول البيانات',data_analyst:'محلل البيانات',training_manager:'مدير التدريب'
};

export default function YeastarReports({
  slug,
  initialData,
  analytics,
  canUseAnalytics=false,
  canManage=false
}){
  const router=useRouter();
  const search=useSearchParams();
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const data=initialData||{};
  const summary=data.summary||{};
  const calls=data.calls||[];
  const configured=data.connection?.configured;
  const selectedExtension=search.get('extension')||data.appliedFilters?.extension||'';
  const selectedStaffId=search.get('staffId')||data.appliedFilters?.staffId||'';
  const offset=Math.max(Number(search.get('offset'))||0,0);
  const people=useMemo(()=>reportPeople(data),[data]);
  const extensionOptions=useMemo(()=>knownExtensions(data,people,analytics),[data,people,analytics]);
  const activeEmployee=useMemo(
    ()=>selectedExtension?people.find(person=>person.extensions.includes(selectedExtension)):personalEmployee(data,people),
    [data,people,selectedExtension]
  );
  const personalScope=Boolean(selectedExtension||data.viewer?.personalOnly||data.performance?.viewer?.scope==='employee');
  const departments=useMemo(()=>departmentRows(data,people),[data,people]);
  const canFilterExtension=Boolean(canUseAnalytics||data.viewer?.personalOnly);
  const exportPayload={
    slug,
    report:'calls',
    from:search.get('from')||'',
    to:search.get('to')||'',
    staffId:selectedStaffId,
    extension:selectedExtension,
    callType:search.get('callType')||'',
    status:search.get('status')||''
  };

  function apply(event){
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(values))if(value)params.set(key,String(value));
    router.push(reportHref(slug,params));
  }

  function applyRange(days){
    const to=new Date();
    const from=new Date();
    from.setDate(from.getDate()-days);
    const params=new URLSearchParams(search.toString());
    params.set('from',inputDate(from));
    params.set('to',inputDate(to));
    params.delete('offset');
    router.push(reportHref(slug,params));
  }

  async function sync(){
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/yeastar/sync',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tenantSlug:slug})
      });
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(errorMessage(payload.error,'تعذرت المزامنة'));
      setNotice(`تمت المزامنة: ${payload.fetchedCount||0} سجل، جديد ${payload.insertedCount||0}، محدث ${payload.updatedCount||0}.`);
      router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذرت المزامنة');}
    finally{setBusy(false);}
  }

  const heading=activeEmployee?`تقرير مكالمات ${activeEmployee.name}`:personalScope?'تقرير مكالماتي':'مركز ذكاء المكالمات';
  const headingCopy=activeEmployee
    ?`${activeEmployee.jobTitle||roleLabel(activeEmployee.roleKey)} · تحويلة ${activeEmployee.extensions.join('، ')||'غير مربوطة'}`
    :personalScope?'قياس نشاطك، جودة الرد، المكالمات الفائتة ووقت الحديث في تقرير واحد.':'رؤية تنفيذية لأداء الإدارات والموظفين وجودة التعامل مع المكالمات.';

  return <div className={styles.page}>
    <header className={styles.hero}>
      <div className={styles.heroContent}>
        <span className={styles.eyebrow}>YEASTAR CALL INTELLIGENCE</span><h2>{heading}</h2><p>{headingCopy}</p>
        <div className={styles.heroMeta}>
          <StatusPill tone={data.connection?.status==='active'?'success':'neutral'} label={data.connection?.status==='active'?'الاتصال نشط':'الاتصال يحتاج مراجعة'}/>
          <StatusPill tone="blue" label={personalScope?'عرض فردي':'عرض إداري شامل'}/>
          <span>آخر مزامنة: {syncTime(data.lastSync?.finishedAt)}</span>
        </div>
      </div>
      <div className={styles.heroActions}>
        {canUseAnalytics&&<ReportExcelButton payload={{...exportPayload,section:'all'}} label="تصدير التقرير XLSX"/>}
        <button className={styles.secondaryButton} type="button" onClick={()=>window.print()}>طباعة التقرير</button>
        {canManage&&<Link className={styles.secondaryButton} href={`/tenant/${encodeURIComponent(slug)}/yeastar/settings`}>إعدادات الربط</Link>}
        {canManage&&<button className={styles.primaryButton} type="button" onClick={sync} disabled={!configured||busy||data.connection?.status==='disabled'}>{busy?'جارٍ جلب المكالمات…':'مزامنة الآن'}</button>}
      </div>
    </header>

    {!configured&&<section className={styles.setupCard}>
      <span className={styles.setupIcon}>☎</span><div><b>{canManage?'لم يتم ربط Yeastar بعد':'الربط لم يكتمل بعد'}</b><p>بعد حفظ بيانات الجهاز وربط التحويلات بالموظفين ستظهر المؤشرات هنا تلقائيًا.</p></div>
      {canManage&&<Link className={styles.primaryButton} href={`/tenant/${encodeURIComponent(slug)}/yeastar/settings`}>فتح إعدادات الربط</Link>}
    </section>}

    {notice&&<div className={`${styles.alert} ${styles.alertSuccess}`}><b>تمت العملية بنجاح</b><span>{notice}</span></div>}
    {error&&<div className={`${styles.alert} ${styles.alertError}`}><b>تعذرت العملية</b><span>{error}</span></div>}
    {data.connection?.lastError&&!error&&<div className={`${styles.alert} ${styles.alertWarning}`}><b>آخر محاولة اتصال تحتاج مراجعة</b><span>{yeastarErrorMessage(data.connection.lastError)}</span></div>}

    <section className={styles.filterCard}>
      <div className={styles.quickRanges}>
        <span>الفترة السريعة</span>
        <button type="button" onClick={()=>applyRange(0)}>اليوم</button><button type="button" onClick={()=>applyRange(6)}>آخر 7 أيام</button><button type="button" onClick={()=>applyRange(29)}>آخر 30 يومًا</button>
        {(search.get('from')||search.get('to')||selectedExtension||selectedStaffId)&&<Link href={`/tenant/${encodeURIComponent(slug)}/yeastar`}>مسح الفلاتر</Link>}
      </div>
      <form className={styles.filters} onSubmit={apply}>
        <label>من<input type="date" name="from" defaultValue={search.get('from')||''}/></label>
        <label>إلى<input type="date" name="to" defaultValue={search.get('to')||''}/></label>
        {canFilterExtension&&<label>{canUseAnalytics?'الموظف أو التحويلة':'تحويلتي'}<select name="extension" defaultValue={selectedExtension}>
          <option value="">{canUseAnalytics?'كل الموظفين والتحويلات':'كل تحويلاتي'}</option>
          {extensionOptions.map(option=><option key={option.extension} value={option.extension}>{option.label}</option>)}
        </select></label>}
        <label>الاتجاه<select name="callType" defaultValue={search.get('callType')||''}><option value="">كل الأنواع</option><option value="Inbound">واردة</option><option value="Outbound">صادرة</option><option value="Internal">داخلية</option></select></label>
        <label>النتيجة<select name="status" defaultValue={search.get('status')||''}><option value="">كل النتائج</option><option value="ANSWERED">تم الرد</option><option value="NO ANSWER">بدون رد</option><option value="ABANDONED">متروكة</option><option value="BUSY">مشغول</option><option value="FAILED">فشلت</option><option value="VOICEMAIL">بريد صوتي</option></select></label>
        <button className={styles.applyButton}>تطبيق التقرير</button>
      </form>
    </section>

    {activeEmployee&&<EmployeeSpotlight employee={activeEmployee}/>} 

    {canUseAnalytics&&<div style={{display:'flex',justifyContent:'flex-end'}}><ReportExcelButton payload={{...exportPayload,section:'metrics'}} label="تصدير مؤشرات المكالمات XLSX" compact/></div>}
    <section className={styles.kpiGrid} aria-label="ملخص مؤشرات المكالمات">
      <Kpi icon="☎" label="إجمالي المكالمات" value={number(summary.totalCalls)} note={`${number(summary.inboundCalls)} واردة · ${number(summary.outboundCalls)} صادرة`} tone="navy"/>
      <Kpi icon="✓" label="تم الرد" value={number(summary.answeredCalls)} note={`نسبة الرد ${percent(summary.answerRate)}`} tone="green" progress={summary.answerRate}/>
      <Kpi icon="!" label="مكالمات فائتة" value={number(summary.missedCalls)} note={`${number(summary.failedCalls)} مكالمة فشلت`} tone="red"/>
      <Kpi icon="◷" label="إجمالي وقت الحديث" value={duration(summary.totalTalkSeconds)} note={`متوسط المكالمة ${duration(summary.averageTalkSeconds)}`} tone="blue"/>
      <Kpi icon="⌛" label="متوسط انتظار الرد" value={duration(summary.averageRoutingSeconds)} note="من بداية الرنين حتى الرد" tone="amber"/>
      <Kpi icon="◉" label="مكالمات مسجلة" value={number(summary.recordedCalls)} note="مؤشر فقط دون نسخ الصوت أو ملف التسجيل" tone="violet"/>
    </section>

    <section className={styles.insightGrid}>
      <article className={`${styles.panel} ${styles.trendPanel}`}><PanelHead eyebrow="DAILY TREND" title="اتجاه المكالمات اليومي" note="إجمالي مقابل تم الرد والفائت"/><DailyTrend rows={data.daily||[]}/></article>
      <article className={styles.panel}><PanelHead eyebrow="CALL OUTCOMES" title="جودة الرد والنتائج" note={`${number(summary.totalCalls)} مكالمة`}/><OutcomeBreakdown summary={summary}/></article>
    </section>
    <section className={styles.insightGrid}>
      <article className={styles.panel}><PanelHead eyebrow="PEAK HOURS" title="ساعات الذروة" note="أكثر الأوقات نشاطًا"/><HourlyBars rows={data.hourly||[]}/></article>
      <article className={styles.panel}><PanelHead eyebrow="CALL DIRECTION" title="توزيع اتجاه المكالمات" note="واردة وصادرة وداخلية"/><DirectionBars summary={summary}/></article>
    </section>

    {!personalScope&&departments.length>0&&<section className={styles.sectionBlock}>
      <PanelHead eyebrow="DEPARTMENT OVERVIEW" title="الأداء الإجمالي للإدارات" note={`${number(departments.length)} إدارات مرتبطة بـYeastar`}/>
      <div className={styles.departmentGrid}>{departments.map(department=><DepartmentCard key={department.name} department={department}/>)}</div>
    </section>}

    {!personalScope&&people.length>0&&<section className={`${styles.panel} ${styles.sectionPanel}`}>
      <PanelHead
        eyebrow="EMPLOYEE PERFORMANCE"
        title="أداء التحويلات والموظفين"
        note={`${number(people.length)} موظفين ضمن صلاحيتك`}
        action={canUseAnalytics?<ReportExcelButton payload={{...exportPayload,section:'callEmployees'}} label="تصدير الجدول XLSX" compact/>:null}
      />
      <div className={styles.tableWrap}><table className={styles.reportTable}>
        <thead><tr><th>#</th><th>الموظف</th><th>الإدارة</th><th>التحويلة</th><th>المكالمات</th><th>تم الرد</th><th>فائتة</th><th>نسبة الرد</th><th>وقت الحديث</th><th>التقرير</th></tr></thead>
        <tbody>{people.map((person,index)=><EmployeeRow key={person.staffId||`${person.name}-${index}`} person={person} index={index} slug={slug} search={search} canFilter={canUseAnalytics}/>)}</tbody>
      </table></div>
    </section>}

    <section className={`${styles.panel} ${styles.sectionPanel}`}>
      <PanelHead
        eyebrow="CALL DETAIL RECORDS"
        title="سجل المكالمات التفصيلي"
        note={`${number(data.totalRecords)} سجل ضمن الفترة`}
        action={canUseAnalytics?<ReportExcelButton payload={{...exportPayload,section:'calls'}} label="تصدير CDR كامل XLSX" compact/>:null}
      />
      <div className={styles.tableWrap}><table className={`${styles.reportTable} ${styles.callsTable}`}>
        <thead><tr><th>الوقت</th><th>الموظف</th><th>الاتجاه</th><th>من</th><th>إلى</th><th>النتيجة</th><th>الرنين</th><th>الحديث</th><th>المتابعة</th><th>التسجيل</th></tr></thead>
        <tbody>{calls.map(call=><CallRow key={call.id} call={call} people={people}/>)}</tbody>
      </table>{!calls.length&&<EmptyState title="لا توجد مكالمات ضمن الفلاتر الحالية" text="غيّر الفترة أو أزل أحد الفلاتر لعرض سجلات أخرى."/>}</div>
      <Pagination slug={slug} search={search} offset={offset} shown={calls.length} total={Number(data.totalRecords)||0}/>
    </section>

    <footer className={styles.syncFooter}><span>آخر مزامنة: {syncTime(data.lastSync?.finishedAt)}</span>{data.lastSync&&<span>الجهاز: {data.lastSync.deviceModel||'Yeastar'} · {data.lastSync.firmwareVersion||'—'} · API {data.lastSync.apiVersion||'—'}</span>}</footer>
  </div>;
}

function StatusPill({tone,label}){return <span className={`${styles.statusPill} ${styles[`status_${tone}`]}`}><i/>{label}</span>;}
function EmployeeSpotlight({employee}){return <section className={styles.employeeSpotlight}><span className={styles.largeAvatar}>{initials(employee.name)}</span><div className={styles.employeeIdentity}><small>تقرير فردي</small><h3>{employee.name}</h3><p>{employee.jobTitle||roleLabel(employee.roleKey)} · {employee.department||'بدون إدارة محددة'}</p></div><div className={styles.employeeFacts}><div><span>التحويلة</span><b>{employee.extensions.join('، ')||'—'}</b></div><div><span>نسبة الرد</span><b>{percent(employee.callAnswerRate)}</b></div><div><span>وقت الحديث</span><b>{duration(employee.talkSeconds)}</b></div></div></section>;}
function Kpi({icon,label,value,note,tone,progress}){return <article className={`${styles.kpi} ${styles[`kpi_${tone}`]}`}><div className={styles.kpiTop}><span className={styles.kpiIcon}>{icon}</span><small>{label}</small></div><b>{value}</b><p>{note}</p>{progress!=null&&<i className={styles.kpiProgress}><span style={{width:`${clamp(progress)}%`}}/></i>}</article>;}
function PanelHead({eyebrow,title,note,action}){return <header className={styles.panelHead}><div><small>{eyebrow}</small><h3>{title}</h3></div><div style={{display:'flex',gap:8,alignItems:'center'}}>{note&&<span>{note}</span>}{action}</div></header>;}

function DailyTrend({rows}){
  const visible=rows.slice(-14);const max=Math.max(...visible.map(row=>Number(row.total)||0),1);
  if(!visible.length)return <EmptyState title="لا توجد بيانات يومية بعد" text="ستظهر الاتجاهات بعد أول مزامنة ناجحة."/>;
  return <><div className={styles.chartLegend}><span><i className={styles.legendTotal}/>الإجمالي</span><span><i className={styles.legendAnswered}/>تم الرد</span><span><i className={styles.legendMissed}/>فائتة</span></div><div className={styles.dailyChart}>{visible.map(row=><div className={styles.dayColumn} key={row.date} title={`${row.date}: ${row.total}`}><strong>{number(row.total)}</strong><div className={styles.barStack}><i className={styles.totalBar} style={{height:`${barHeight(row.total,max)}%`}}/><i className={styles.answeredBar} style={{height:`${barHeight(row.answered,max)}%`}}/><i className={styles.missedBar} style={{height:`${barHeight(row.missed,max)}%`}}/></div><span>{shortDate(row.date)}</span></div>)}</div></>;
}

function OutcomeBreakdown({summary}){
  const total=Math.max(Number(summary.totalCalls)||0,0);const answered=Math.max(Number(summary.answeredCalls)||0,0);const missed=Math.max(Number(summary.missedCalls)||0,0);const failed=Math.max(Number(summary.failedCalls)||0,0);const other=Math.max(total-answered-missed-failed,0);
  const answeredDeg=portion(answered,total)*360;const missedDeg=answeredDeg+portion(missed,total)*360;const failedDeg=missedDeg+portion(failed,total)*360;
  return <div className={styles.outcomeLayout}><div className={styles.donut} style={{'--answered-end':`${answeredDeg}deg`,'--missed-end':`${missedDeg}deg`,'--failed-end':`${failedDeg}deg`}} role="img" aria-label={`نسبة الرد ${percent(summary.answerRate)}`}><div><b>{percent(summary.answerRate)}</b><span>نسبة الرد</span></div></div><div className={styles.outcomeList}><OutcomeItem tone="green" label="تم الرد" value={answered} total={total}/><OutcomeItem tone="red" label="فائتة" value={missed} total={total}/><OutcomeItem tone="amber" label="فشلت" value={failed} total={total}/><OutcomeItem tone="gray" label="نتائج أخرى" value={other} total={total}/></div></div>;
}
function OutcomeItem({tone,label,value,total}){return <div className={styles.outcomeItem}><i className={styles[`dot_${tone}`]}/><span><b>{label}</b><small>{percent(portion(value,total)*100)}</small></span><strong>{number(value)}</strong></div>;}
function HourlyBars({rows}){const max=Math.max(...rows.map(row=>Number(row.total)||0),1);if(!rows.length)return <EmptyState title="لا توجد بيانات لساعات الذروة" text="يظهر التحليل بعد توفر مكالمات في الفترة المختارة."/>;return <div className={styles.hourChart}>{rows.map(row=>{const answerRate=rate(row.answered,row.total);return <div className={styles.hourColumn} key={row.hour} title={`${row.hour}:00 · ${row.total} مكالمة`}><b>{number(row.total)}</b><div><i style={{height:`${barHeight(row.total,max)}%`}}><span style={{height:`${clamp(answerRate)}%`}}/></i></div><small>{String(row.hour).padStart(2,'0')}</small></div>;})}</div>;}
function DirectionBars({summary}){const rows=[{label:'واردة',value:summary.inboundCalls,tone:'blue'},{label:'صادرة',value:summary.outboundCalls,tone:'green'},{label:'داخلية',value:summary.internalCalls,tone:'amber'}];const total=Math.max(Number(summary.totalCalls)||0,1);return <div className={styles.directionList}>{rows.map(row=><div key={row.label}><header><span><i className={styles[`dot_${row.tone}`]}/>{row.label}</span><b>{number(row.value)}</b></header><div><i className={styles[`fill_${row.tone}`]} style={{width:`${clamp(portion(row.value,total)*100)}%`}}/></div><small>{percent(portion(row.value,total)*100)} من إجمالي المكالمات</small></div>)}</div>;}

function DepartmentCard({department}){return <article className={styles.departmentCard}><header><span className={styles.departmentIcon}>{initials(department.name)}</span><div><small>الإدارة</small><h4>{department.name}</h4></div><em>{number(department.staffCount)} موظفين</em></header><div className={styles.departmentMetrics}><div><span>المكالمات</span><b>{number(department.calls)}</b></div><div><span>تم الرد</span><b>{number(department.answered)}</b></div><div><span>فائتة</span><b>{number(department.missed)}</b></div></div><footer><span>نسبة الرد <b>{percent(department.answerRate)}</b></span><i><span style={{width:`${clamp(department.answerRate)}%`}}/></i><small>وقت الحديث {duration(department.talkSeconds)}</small></footer></article>;}

function EmployeeRow({person,index,slug,search,canFilter}){
  const missed=Math.max(Number(person.calls)-Number(person.answeredCalls),0);const params=new URLSearchParams(search.toString());if(person.extensions[0])params.set('extension',person.extensions[0]);params.delete('staffId');params.delete('offset');
  return <tr><td><span className={styles.rank}>{number(index+1)}</span></td><td><div className={styles.personCell}><span>{initials(person.name)}</span><div><b>{person.name}</b><small>{person.jobTitle||roleLabel(person.roleKey)}</small></div></div></td><td>{person.department||'غير محدد'}</td><td><b dir="ltr">{person.extensions.join('، ')||'—'}</b></td><td><strong>{number(person.calls)}</strong></td><td className={styles.positive}>{number(person.answeredCalls)}</td><td className={missed?styles.negative:''}>{number(missed)}</td><td><div className={styles.rateCell}><b>{percent(person.callAnswerRate)}</b><i><span style={{width:`${clamp(person.callAnswerRate)}%`}}/></i></div></td><td>{duration(person.talkSeconds)}</td><td>{canFilter&&person.extensions[0]?<Link className={styles.rowLink} href={reportHref(slug,params)}>عرض الفردي</Link>:'—'}</td></tr>;
}

function CallRow({call,people}){const owner=callOwner(call,people);return <tr><td><div className={styles.dateCell}><b>{dateOnly(call.startedAt)}</b><small>{timeOnly(call.startedAt)}</small></div></td><td>{owner?<div className={styles.compactPerson}><span>{initials(owner.name)}</span><div><b>{owner.name}</b><small>تحويلة {matchingExtensions(call,owner).join('، ')}</small></div></div>:<span className={styles.muted}>غير مربوط</span>}</td><td><span className={`${styles.directionTag} ${styles[`direction_${call.callType}`]}`}>{callType(call.callType)}</span></td><td><div className={styles.phoneCell}><b dir="ltr">{call.callerNumber||'—'}</b><small>{call.callerName||''}</small></div></td><td><div className={styles.phoneCell}><b dir="ltr">{call.calleeNumber||'—'}</b><small>{call.calleeName||call.lastParticipantName||''}</small></div></td><td><span className={`${styles.callStatus} ${statusTone(call.finalStatus)}`}>{status(call.finalStatus)}</span></td><td>{duration(call.routingDurationSeconds)}</td><td><b>{duration(call.handlingDurationSeconds)}</b></td><td>{call.returnedAfterMissed===true?<span className={styles.returned}>تم الرد لاحقًا</span>:call.returnedAfterMissed===false?<span className={styles.notReturned}>لم يُعد الاتصال</span>:'—'}</td><td>{call.hasRecording?<span className={styles.recording}>● متاح</span>:'—'}</td></tr>;}

function Pagination({slug,search,offset,shown,total}){if(total<=100)return null;const previous=new URLSearchParams(search.toString());const next=new URLSearchParams(search.toString());previous.set('offset',String(Math.max(offset-100,0)));next.set('offset',String(offset+100));const start=total?offset+1:0;const end=Math.min(offset+shown,total);return <footer className={styles.pagination}><span>عرض {number(start)}–{number(end)} من {number(total)}</span><div>{offset>0?<Link href={reportHref(slug,previous)}>السابق</Link>:<span>السابق</span>}{offset+shown<total?<Link href={reportHref(slug,next)}>التالي</Link>:<span>التالي</span>}</div></footer>;}
function EmptyState({title,text}){return <div className={styles.emptyState}><span>⌁</span><b>{title}</b><p>{text}</p></div>;}

function reportPeople(data){
  const performance=data.performance?.employees||[];const team=data.dashboard?.team||[];const teamById=new Map(team.map(member=>[member.staffId,member]));const viewer=data.dashboard?.viewer||{};
  const rows=performance.map(employee=>{const member=teamById.get(employee.staffId)||{};const personalExtensions=employee.staffId===viewer.staffId?data.dashboard?.telephony?.extensions:'';return {...employee,extensions:splitExtensions(member.extension||personalExtensions),calls:Number(employee.calls)||0,answeredCalls:Number(employee.answeredCalls)||0,talkSeconds:Number(employee.talkSeconds)||0,callAnswerRate:Number(employee.callAnswerRate)||0};});
  if(data.performance?.viewer?.scope==='employee'&&viewer.staffId&&!rows.some(row=>row.staffId===viewer.staffId))rows.push({staffId:viewer.staffId,name:viewer.name||'الموظف',jobTitle:viewer.jobTitle,roleKey:viewer.roleKey,department:data.performance?.selectedEmployee?.department,extensions:splitExtensions(data.dashboard?.telephony?.extensions),calls:Number(data.dashboard?.telephony?.totalCalls)||0,answeredCalls:Math.round((Number(data.dashboard?.telephony?.totalCalls)||0)*(Number(data.dashboard?.telephony?.answerRate)||0)/100),talkSeconds:Number(data.dashboard?.telephony?.talkSeconds)||0,callAnswerRate:Number(data.dashboard?.telephony?.answerRate)||0});
  for(const member of team){if(rows.some(row=>row.staffId===member.staffId))continue;rows.push({staffId:member.staffId,name:member.name,jobTitle:member.jobTitle,roleKey:member.roleKey,department:'غير محدد',extensions:splitExtensions(member.extension),calls:Number(member.totalCalls)||0,answeredCalls:Math.round((Number(member.totalCalls)||0)*(Number(member.answerRate)||0)/100),talkSeconds:Number(member.talkSeconds)||0,callAnswerRate:Number(member.answerRate)||0});}
  return rows.filter(person=>person.extensions.length||person.calls>0).sort((a,b)=>b.calls-a.calls||a.name.localeCompare(b.name,'ar'));
}
function personalEmployee(data,people){const staffId=data.viewer?.staffId||data.performance?.viewer?.staffId;if(staffId)return people.find(person=>person.staffId===staffId)||null;if(data.performance?.viewer?.scope==='employee')return people[0]||null;return null;}
function knownExtensions(data,people,analytics){
  const configured=splitExtensions(data.connection?.extensions);const reported=(data.extensions||[]).map(row=>String(row.extension));const authorized=(analytics?.extensions||[]).map(row=>String(row.extension));
  const all=[...new Set([...configured,...reported,...authorized])].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  return all.map(extension=>{const person=people.find(item=>item.extensions.includes(extension));const access=(analytics?.extensions||[]).find(item=>String(item.extension)===extension);return {extension,label:person?`${person.name} · تحويلة ${extension}`:access?.staffName?`${access.staffName} · تحويلة ${extension}`:`تحويلة ${extension}`};});
}
function departmentRows(data,people){
  if(Array.isArray(data.departments)&&data.departments.length)return data.departments.map(department=>({departmentKey:department.departmentKey,name:department.name||'غير محدد',staffCount:Number(department.staffCount)||0,extensions:Array.isArray(department.extensions)?department.extensions.map(String):[],calls:Number(department.calls)||0,answered:Number(department.answered)||0,missed:Number(department.missed)||0,inbound:Number(department.inbound)||0,outbound:Number(department.outbound)||0,talkSeconds:Number(department.talkSeconds)||0,averageTalkSeconds:Number(department.averageTalkSeconds)||0,answerRate:Number(department.answerRate)||0})).sort((a,b)=>b.calls-a.calls||a.name.localeCompare(b.name,'ar'));
  const grouped=new Map();for(const person of people){const name=person.department||'غير محدد';const current=grouped.get(name)||{name,staffCount:0,calls:0,answered:0,missed:0,talkSeconds:0};current.staffCount+=1;current.calls+=Number(person.calls)||0;current.answered+=Number(person.answeredCalls)||0;current.missed+=Math.max(Number(person.calls)-Number(person.answeredCalls),0);current.talkSeconds+=Number(person.talkSeconds)||0;grouped.set(name,current);}return [...grouped.values()].map(row=>({...row,answerRate:rate(row.answered,row.calls)})).sort((a,b)=>b.calls-a.calls||a.name.localeCompare(b.name,'ar'));
}
function callOwner(call,people){const extensions=(call.extensions||[]).map(String);return people.find(person=>person.extensions.some(extension=>extensions.includes(extension)))||null;}
function matchingExtensions(call,person){const extensions=(call.extensions||[]).map(String);return person.extensions.filter(extension=>extensions.includes(extension));}
function splitExtensions(value){const values=Array.isArray(value)?value:String(value||'').split(',');return values.map(item=>String(item).trim()).filter(Boolean);}
function reportHref(slug,params){const query=params.toString();return `/tenant/${encodeURIComponent(slug)}/yeastar${query?`?${query}`:''}`;}
function inputDate(value){const year=value.getFullYear();const month=String(value.getMonth()+1).padStart(2,'0');const day=String(value.getDate()).padStart(2,'0');return `${year}-${month}-${day}`;}
function errorMessage(value,fallback){return yeastarErrorMessage(value,fallback)}
function number(value){return new Intl.NumberFormat('ar-SA').format(Number(value)||0)}
function percent(value){return `${number(Number(value)||0)}٪`}
function clamp(value){return Math.min(Math.max(Number(value)||0,0),100)}
function portion(value,total){return total>0?(Number(value)||0)/total:0}
function rate(value,total){return total>0?Math.round(1000*(Number(value)||0)/total)/10:0}
function barHeight(value,max){return Math.max(Number(value)?7:0,100*(Number(value)||0)/max)}
function roleLabel(value){return ROLE_LABELS[value]||'موظف'}
function initials(value){const words=String(value||'م').trim().split(/\s+/).filter(Boolean);return words.slice(0,2).map(word=>Array.from(word)[0]).join('')||'م';}
function duration(value){const seconds=Math.max(Number(value)||0,0);if(seconds<60)return `${number(Math.round(seconds))} ث`;const minutes=Math.floor(seconds/60);const rest=Math.round(seconds%60);if(minutes<60)return `${number(minutes)} د${rest?` ${number(rest)} ث`:''}`;return `${number(Math.floor(minutes/60))} س ${number(minutes%60)} د`;}
function syncTime(value){return value?new Date(value).toLocaleString('ar-SA',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'لم تتم بعد';}
function shortDate(value){return new Date(`${value}T12:00:00`).toLocaleDateString('ar-SA',{day:'numeric',month:'short'});}
function dateOnly(value){return new Date(value).toLocaleDateString('ar-SA',{day:'numeric',month:'short',year:'numeric'})}
function timeOnly(value){return new Date(value).toLocaleTimeString('ar-SA',{hour:'numeric',minute:'2-digit'})}
function callType(value){return ({Inbound:'واردة',Outbound:'صادرة',Internal:'داخلية'})[value]||'غير محدد'}
function statusTone(value){if(value==='ANSWERED')return styles.statusAnswered;if(MISSED_STATUSES.has(value))return styles.statusMissed;if(value==='FAILED')return styles.statusFailed;return styles.statusOther;}
function status(value){return ({ANSWERED:'تم الرد','NO ANSWER':'بدون رد',ABANDONED:'متروكة',BUSY:'مشغول',FAILED:'فشلت',VOICEMAIL:'بريد صوتي',UNKNOWN:'غير محدد'})[value]||value;}
