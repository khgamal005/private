'use client';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {campaignHref,campaignObservation,campaignEconomics,sourceGroups,suggestCampaign} from '../lib/campaign-revenue.mjs';
import './campaign-revenue-report.css';

const n=value=>new Intl.NumberFormat('ar-SA',{maximumFractionDigits:2}).format(Number(value||0));
const money=(value,currency)=>value==null?'—':new Intl.NumberFormat('ar-SA',{style:'currency',currency:currency||'SAR'}).format(value/100);
const evidence={unreviewed:'يحتاج مراجعة',manual_name:'ربط يدوي بالاسم',manual_id:'معرّف راجعه المستخدم',source_only:'المصدر فقط'};
const statuses={new:'جديد',interested:'مهتم',very_interested:'مهتم جدًا',awaiting_payment:'بانتظار الدفع',paid:'بلاغ دفع من المبيعات',unqualified:'غير مؤهل',wrong_number:'رقم غير صحيح',no_answer:'لم يرد',phone_off:'الهاتف مغلق',follow_up:'متابعة',not_interested:'غير مهتم',busy:'مشغول',postponed:'مؤجل',cancelled:'ملغى',duplicate:'مكرر'};
const errors={source_changed_refresh_preview:'تغيّرت بيانات هذه المجموعة. حدّث المعاينة ثم راجع الربط.',command_id_reused:'تعذر إعادة استخدام طلب الربط. حدّث المعاينة.',ad_not_found:'رقم الإعلان لا ينتمي إلى الحملة المختارة.',campaign_not_found:'الحملة غير متاحة لهذه المنشأة.',forbidden:'ليست لديك صلاحية مراجعة المصادر.',session_expired:'انتهت الجلسة. سجّل الدخول مجددًا.'};
const api='/api/tenant/campaign-revenue';

export default function CampaignRevenueReport({slug,data,filters,meta,children}){
  const group=filters.group;
  const groups=data.groups||[];
  const total=data.summary||{};
  const from=campaignHref(slug,filters);
  const exportUrl=api+'?tenantSlug='+encodeURIComponent(slug)+'&action=export&'+from.split('?')[1];
  const day=value=>value?new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{dateStyle:'medium',timeZone:data.range.timezone}).format(new Date(value)):'—';
  return <main className="cr-page" dir="rtl">
    <header className="cr-heading"><div><small>من الإعلان إلى التسجيل</small><h1>تحليل الإعلانات والمبيعات</h1>
      <p>التحويل يعتمد على تأكيد وصول الدفع لدى التسجيل. نتائج Meta معروضة بمصدرها.</p></div>
      <a className="cr-button" href={exportUrl}>تصدير نتائج الفلاتر</a></header>
    <form className="cr-filters" method="get">
      <label>نوع الفترة<select name="mode" defaultValue={filters.mode}><option value="cohort">العملاء الذين وصلوا خلال الفترة</option><option value="cash">التحصيل خلال الفترة</option></select></label>
      <label>من<input type="date" name="from" defaultValue={filters.dateFrom} required max={filters.today}/></label>
      <label>إلى<input type="date" name="to" defaultValue={filters.dateTo} required max={filters.today}/></label>
      <label>متابعة النتائج حتى<input type="date" name="asOf" defaultValue={filters.asOf} min={filters.dateTo} max={filters.today} required/></label>
      <label>الحملة<select name="campaign" defaultValue={filters.campaign}><option value="">كل الحملات والمصادر</option>{(meta?.filters?.campaigns||groups.filter(g=>g.campaignId).map(g=>({id:g.campaignId,name:g.name}))).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>مسؤول المبيعات الحالي<select name="staff" defaultValue={filters.staff}><option value="">الكل</option>{data.staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>الدورة محل الاهتمام<select name="course" defaultValue={filters.course}><option value="">الكل</option>{data.courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>بحث المصدر / الحملة / الإعلان<input name="q" defaultValue={filters.search} maxLength={80}/></label>
      <input type="hidden" name="metaQ" value={filters.metaSearch||''}/><input type="hidden" name="status" value={filters.status}/>
      <button className="cr-button" type="submit">عرض التحليل</button><Link href={`/tenant/${encodeURIComponent(slug)}/reports/campaigns`}>مسح الفلاتر</Link>
    </form>
    <p className="cr-note">{filters.mode==='cohort'?`نحتسب العملاء الفريدين الذين وصلوا من ${filters.dateFrom} إلى ${filters.dateTo}، ونتابع دفعهم حتى ${filters.asOf}.`:'يعرض هذا الاختيار التحصيل والاسترداد خلال الفترة. نسبة تحويل العملاء غير محسوبة في هذا العرض.'} التوقيت: {data.range.timezone}. حالات الاهتمام والتأهيل تعكس آخر حالة مسجلة.</p>
    <section className="cr-metrics" aria-label="نتائج أودير">
      <Card title={filters.mode==='cohort'?'العملاء الفريدون':'عملاء لديهم حركة تحصيل'} value={n(total.leads)}/>
      <Card title="عملاء بدفع مؤكد من التسجيل" value={n(total.payers)}/>
      <Card title="التحويل إلى دفع مؤكد" value={filters.mode==='cohort'&&total.leads?n(total.payers*100/total.leads)+'%':'—'}/>
      <Card title="بانتظار التوزيع" value={n(total.waiting)}/>
      <Card title="مصادر تحتاج مراجعة" value={n(total.unreviewed)}/>
    </section>
    {!data.canReadMoney?<p className="cr-note">تفاصيل التحصيل تحتاج صلاحية تقارير الحسابات.</p>:null}
    <section className="cr-panel"><h2>أي الحملات تحولت إلى مبيعات؟</h2>
      <p>النقر على اسم الحملة يفتح تفاصيل العملاء في نفس الصفحة. الاهتمام والتأهيل مؤشرات مستقلة؛ قد يظهر العميل في كليهما.</p>
      {groups.length===0?<p className="cr-empty">لا توجد بيانات أودير مطابقة للفترة والفلاتر. يمكنك استيراد العملاء ومراجعة مصادرهم أدناه.</p>:<div className="cr-table"><table><thead><tr>
        <th>الحملة / المصدر</th><th>عملاء</th><th>مهتمون</th><th>مؤهلون</th><th>غير مؤهلين / رقم خطأ</th><th>ينتظر التوزيع</th><th>دفع مؤكد</th><th>تحويل</th><th>التحصيل والاسترداد</th><th>الإنفاق / التكلفة / العائد</th>
      </tr></thead><tbody>{groups.map(g=>{
        const economics=campaignEconomics(g,g.performance,filters);
        return <tr key={g.key}><td><Link className="cr-link" href={campaignHref(slug,filters,{group:g.key,offset:0})+'#campaign-customers'}>{g.name}</Link><small>{g.source||'غير محدد'}</small><small>{g.unreviewed?`${n(g.unreviewed)} مصدرًا يحتاج مراجعة`:'مصادر مراجعة'}</small></td>
          <td>{n(g.leads)}</td><td>{n(g.interested)}</td><td>{n(g.qualified)}</td><td>{n(g.unqualified)}</td><td>{n(g.waiting)}</td><td>{n(g.payers)}<small>{n(g.registrations)} تسجيلًا</small></td><td>{g.conversion==null?'—':n(g.conversion)+'%'}</td>
          <td>{g.money?.length?g.money.map(m=><div key={m.currency}><b>{money(m.netMinor,m.currency)}</b><small>محصل {money(m.grossMinor,m.currency)}</small><small>مسترد {money(m.refundMinor,m.currency)}</small></div>):'—'}</td>
          <td><b>{money(g.performance?.spendMinor,g.performance?.currency)}</b><small>لكل عميل: {money(economics.cpl,g.performance?.currency)}</small><small>لكل دافع: {money(economics.cac,g.performance?.currency)}</small><small>ROAS: {economics.roas==null?'—':n(economics.roas)+'×'}</small>{economics.reason?<small>{economics.reason}</small>:null}</td></tr>;
      })}</tbody></table></div>}
    </section>
    <section className="cr-panel"><h2>ملاحظات تستحق المتابعة</h2><div className="cr-observations">{groups.slice(0,6).map(g=><article key={g.key}><b>{g.name}</b><p>{campaignObservation(g)}</p><small>العينة: {n(g.leads)} عميلًا · متابعة حتى {filters.asOf}</small></article>)}</div>
      <p className="cr-note">هذه ملاحظات وصفية من سجلات أودير، وليست إثباتًا سببيًا لأثر الإعلان. لا تتغير الميزانيات تلقائيًا.</p></section>
    {data.canReadDetails?<section className="cr-panel" id="campaign-customers"><h2>العملاء وأدلة التحويل</h2>
      {group?<p>كل عملاء الحملة المختارة <Link className="cr-link" href={campaignHref(slug,filters,{group:'',offset:0})+'#campaign-customers'}>عرض الكل</Link></p>:null}
      <div className="cr-table"><table><thead><tr><th>العميل</th><th>المصدر / الإعلان</th><th>الوصول</th><th>دليل الربط</th><th>حالة المتابعة</th><th>اعتماد الدفع</th></tr></thead><tbody>{data.details.map(d=><tr key={d.key}>
        <td>{d.name||'بدون اسم'}<small>{d.contactId?'عميل مسجل':'لم يوزع بعد'}</small></td><td>{d.campaign}<small>{d.source} · {d.ad||'الإعلان غير محدد'}</small></td><td>{day(d.receivedAt)}<small>{d.dateEvidence==='upload_time'?'تاريخ الرفع؛ الوصول الأصلي غير موثق':d.dateEvidence==='reported'?'تاريخ مذكور بالشيت':'تاريخ إنشاء السجل'}</small></td><td>{evidence[d.evidence]}</td><td>{d.queueStatus==='awaiting_distribution'?'بانتظار التوزيع':statuses[d.status]||d.status||'جديد'}</td><td>{day(d.verifiedAt)}{d.cash?.length?<details><summary>توثيق التحصيل</summary>{d.cash.map(e=><p key={e.reference}>{e.kind==='refund'?'استرداد':'تحصيل'}: {money(e.amountMinor,e.currency)} · {day(e.at)}<small>{e.reference}</small></p>)}</details>:null}</td></tr>)}</tbody></table></div>
      <nav className="cr-pager" aria-label="صفحات العملاء">{filters.offset>0?<Link href={campaignHref(slug,filters,{offset:Math.max(0,filters.offset-50)})}>السابق</Link>:null}<span>{n(filters.offset+1)}–{n(Math.min(filters.offset+50,data.totalDetails))} من {n(data.totalDetails)}</span>{filters.offset+50<data.totalDetails?<Link href={campaignHref(slug,filters,{offset:filters.offset+50})}>التالي</Link>:null}</nav>
    </section>:null}
    {data.additionalCash?.length?<section className="cr-panel"><h2>مبيعات إضافية لعملاء موجودين</h2><p>تُنسب إلى مصدر فرصة البيع الموثق. لا نضيف هؤلاء إلى عدد العملاء الجدد.</p>{data.additionalCash.map((r,i)=><p key={i}>{r.campaign} · {n(r.customers)} عميلًا · صافي {money(r.netMinor,r.currency)}</p>)}</section>:null}
    <details className="cr-panel"><summary>جودة البيانات والمطابقة</summary><p>كل الشيتات في فترة الوصول: {n(total.duplicates)} صفًا مكررًا، و{n(total.invalid)} صفًا تعذر استيراده. لا يمثل المكرر عميلًا جديدًا. هذه الأعداد لا تتغير بفلاتر الموظف أو الحملة.</p>
      <p>تظل الأرقام الخاطئة وعدم التأهيل داخل مقام التحويل عند وجود سجل عميل صالح. اختلاف كتابة اسم الحملة يحتاج مراجعة، ولا يُعتمد كتطابق تلقائي.</p>
      {(data.unattributedCash||[]).map(m=><p key={m.currency}>تحصيل لا توجد له علاقة موثقة بمصدر فرصة البيع، لكل المنشأة في الفترة: {money(m.netMinor,m.currency)}. يظهر خارج إيرادات الحملات.</p>)}</details>
    {data.canReview?<SourceReview slug={slug}/>:null}
    {children}
  </main>;
}
function Card({title,value}){return <article><small>{title}</small><b>{value}</b></article>;}
function SourceReview({slug}){
  const router=useRouter();
  const [preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[batch,setBatch]=useState('');
  async function load(nextBatch=batch,offset=0){
    setBusy(true);setMessage('');
    try{const r=await fetch(api+'?'+new URLSearchParams({tenantSlug:slug,action:'sources',batch:nextBatch,offset:String(offset)}),{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error);setPreview(d);}
    catch(e){setMessage(errors[e.message]||'تعذر تحميل المعاينة. حاول مجددًا.');}finally{setBusy(false);}
  }
  return <details className="cr-panel"><summary>استيراد العملاء ومراجعة ربط المصادر</summary>
    <p>استورد الملف من <Link href={`/tenant/${encodeURIComponent(slug)}/lead-queue`}>استقبال وتوزيع العملاء</Link>، ثم راجع كل مجموعة من الصفوف هنا. نحفظ رقم الصف والدفعة والمصدر الأصلي. المراجعة لا تنشئ عميلًا أو مهمة.</p>
    <button className="cr-button" disabled={busy} onClick={()=>load()}>معاينة المصادر</button>
    {message?<p role="status">{message}</p>:null}
    {preview?<><label>دفعة الاستيراد<select value={batch} onChange={e=>{setBatch(e.target.value);load(e.target.value);}}><option value="">كل الدفعات والسجلات</option>{preview.batches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <p>المعاينة {n(preview.offset+1)}–{n(Math.min(preview.offset+200,preview.total))} من {n(preview.total)} صفًا. يظهر التطبيق على صفوف هذه المعاينة فقط.</p>
      {sourceGroups(preview.rows).map(g=><ReviewGroup key={g.key+g.reviewId} group={g} targets={preview.targets} slug={slug} onSaved={()=>{load(batch,preview.offset);router.refresh();}}/>)}
      <nav className="cr-pager">{preview.offset>0?<button disabled={busy} onClick={()=>load(batch,preview.offset-200)}>السابق</button>:null}{preview.offset+200<preview.total?<button disabled={busy} onClick={()=>load(batch,preview.offset+200)}>التالي</button>:null}</nav></>:null}
  </details>;
}
function ReviewGroup({group:g,targets,slug,onSaved}){
  const [campaign,setCampaign]=useState(g.campaignId||suggestCampaign(g,targets));
  const [ad,setAd]=useState(g.externalAdId||''),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [command,setCommand]=useState(null);
  async function save(e){
    e.preventDefault();setBusy(true);setError('');
    const body={tenantSlug:slug,rows:g.rows.map(r=>({key:r.key,token:r.token})),campaignId:campaign,adExternalId:campaign?ad:'',reason};
    const fingerprint=JSON.stringify(body);
    const next=command?.fingerprint===fingerprint?command:{fingerprint,id:crypto.randomUUID()};setCommand(next);
    try{const r=await fetch(api,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,commandId:next.id})});const d=await r.json();if(!r.ok)throw Error(d.error);onSaved();}
    catch(e){setError(errors[e.message]||'تعذر حفظ الربط. يمكنك إعادة المحاولة بأمان.');}finally{setBusy(false);}
  }
  return <form className="cr-review" onSubmit={save}><div><b>{g.campaignName||g.source||'مصدر غير محدد'} · {n(g.rows.length)} صفًا</b><p>{g.adSetName} / {g.adName||'الإعلان غير محدد'}</p><small>{evidence[g.evidence]} · {g.externalCampaignId||'معرّف الحملة غير مذكور'}</small></div>
    <label>الحملة المعتمدة<select value={campaign} onChange={e=>setCampaign(e.target.value)}><option value="">الاحتفاظ بالمصدر فقط</option>{targets.map(t=><option key={t.id} value={t.id}>{t.name} — {t.accountName} — {t.externalId}</option>)}</select></label>
    <label>معرّف الإعلان إن كان معروفًا<input value={ad} onChange={e=>setAd(e.target.value)} maxLength={100} disabled={!campaign}/></label>
    <label>سبب المراجعة<input value={reason} onChange={e=>setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="مثال: مطابق لاسم الحملة في شيت المودريتور"/></label>
    <button className="cr-button" disabled={busy}>{busy?'جارٍ الحفظ…':`اعتماد ربط ${n(g.rows.length)} صفًا`}</button>{error?<p role="alert">{error}</p>:null}
  </form>;
}
