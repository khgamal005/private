'use client';
import {useState} from 'react';

const number=value=>new Intl.NumberFormat('ar-SA').format(value||0);
const money=(value,currency)=>new Intl.NumberFormat('ar-SA',{style:'currency',currency}).format(value/100);
const messages={forbidden:'تحتاج صلاحية تقارير الحسابات والحملات لعرض التحصيل.',session_expired:'انتهت الجلسة. سجّل الدخول مجددًا.',addon_not_enabled:'إضافة تقارير الحملات غير مفعلة.',campaign_report_not_enabled:'تقرير الحملات غير مفعل لهذه المنشأة.',campaign_report_filter_invalid:'راجع الفترة والفلاتر ثم أعد المحاولة.'};

export default function CampaignOpportunityCollections({slug,filters}){
 const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){
  setBusy(true);setError('');
  try{
   const params=new URLSearchParams({tenantSlug:slug,action:'opportunity-collections',from:filters.dateFrom,to:filters.dateTo});
   if(filters.staff)params.set('staff',filters.staff);
   if(filters.course)params.set('course',filters.course);
   if(filters.search)params.set('q',filters.search);
   const response=await fetch('/api/tenant/campaign-revenue?'+params,{cache:'no-store'});
   const result=await response.json();
   if(!response.ok)throw Error(result.error);
   setData(result);
  }catch(e){setError(messages[e.message]||'تعذر تحميل التحصيل. حاول مجددًا.');}
  finally{setBusy(false);}
 }
 return <section className="cr-panel" aria-labelledby="opportunity-collections-title">
  <h2 id="opportunity-collections-title">التحصيل حسب مصدر فرصة البيع</h2>
  <p>تحصيل واسترداد من {filters.dateFrom} إلى {filters.dateTo}، وفق مصدر كل عملية بيع الموثق. يشمل المبيعات المتكررة دون إضافتها إلى عدد العملاء الجدد.</p>
  <p className="cr-note">يطبق فترة التحصيل وفلتر الموظف والدورة وبحث المصدر. يظهر جميع مصادر فرص البيع؛ فلتر حملة اكتساب العميل لا يطبق هنا. لا يُحسب العائد على الإنفاق قبل مراجعة ربط إنفاق الحملة بمصدر البيع.</p>
  <button className="cr-button" disabled={busy} onClick={load}>{busy?'جارٍ التحميل…':data?'تحديث تحصيل فرص البيع':'عرض تحصيل فرص البيع'}</button>
  {error?<p role="alert">{error}</p>:null}
  {data?<>
   <p>فرص بيع لها حركة مالية: {number(data.opportunities)}. التوقيت: {data.range.timezone}.</p>
   {data.unlinkedEvents>0?<p className="cr-note">{number(data.unlinkedEvents)} حركة مالية لم تربط بفرصة بيع؛ تظل ضمن المصدر غير الموثق.</p>:null}
   {data.totals.map(total=><p key={total.currency}><b>صافي التحصيل: {money(total.netMinor,total.currency)}</b> · محصل {money(total.grossMinor,total.currency)} · مسترد {money(total.refundMinor,total.currency)}</p>)}
   {data.groups.length===0?<p className="cr-empty">لا توجد حركات تحصيل أو استرداد مطابقة للفترة والفلاتر.</p>:<div className="cr-table"><table><thead><tr><th>مصدر البيع / الحملة / الإعلان</th><th>فرص البيع</th><th>التحصيل</th><th>الاسترداد</th><th>الصافي</th></tr></thead><tbody>
    {data.groups.flatMap(group=>group.money.map((total,index)=><tr key={group.key+':'+total.currency}>
     <td>{group.documented?<>{group.campaignName||group.source||'مصدر موثق'}<small>{group.source||'المصدر غير مسمى'} · {group.adName||'الإعلان غير مسمى'}</small></>:'مصدر فرصة البيع غير موثق'}</td>
     <td>{index===0?number(group.opportunities):'—'}</td><td>{money(total.grossMinor,total.currency)}</td><td>{money(total.refundMinor,total.currency)}</td><td><b>{money(total.netMinor,total.currency)}</b></td>
    </tr>))}
   </tbody></table></div>}
  </>:null}
 </section>;
}
