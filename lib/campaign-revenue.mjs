import {normalizeSocialReportQuery} from './social-connect-report.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=value=>UUID.test(String(value||''))?String(value):'';
export function campaignFilters(query={},now=new Date(),timezone='Asia/Riyadh'){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
  const base=normalizeSocialReportQuery(query,new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`));
  const asOf=String(query.asOf||'');
  const valid=/^\d{4}-\d{2}-\d{2}$/.test(asOf)&&!Number.isNaN(Date.parse(asOf))&&new Date(asOf).toISOString().slice(0,10)===asOf;
  return {...base,asOf:valid&&asOf>=base.dateTo&&asOf<=base.today?asOf:base.today,
    mode:query.mode==='cash'?'cash':'cohort',staff:id(query.staff),course:id(query.course),
    group:String(query.group||'').slice(0,100),metaSearch:String(query.metaQ||'').trim().slice(0,80),
    offset:Math.max(0,Math.min(1000000,Number.parseInt(query.offset,10)||0))};
}
export function campaignReportArgs(slug,f){
  return {p_slug:slug,p_from:f.dateFrom,p_to:f.dateTo,p_as_of:f.asOf,p_mode:f.mode,
    p_campaign_id:f.campaign||null,p_staff_id:f.staff||null,p_course_id:f.course||null,p_query:f.search,p_offset:f.offset,p_group_key:f.group||null};
}
export function campaignHref(slug,f,overrides={}){
  const n={...f,...overrides};
  const params=new URLSearchParams({from:n.dateFrom,to:n.dateTo,asOf:n.asOf,mode:n.mode});
  for(const [key,value] of Object.entries({campaign:n.campaign,staff:n.staff,course:n.course,q:n.search,metaQ:n.metaSearch,status:n.status!=='all'?n.status:'',group:n.group,offset:n.offset||'',page:n.page>1?n.page:''}))if(value)params.set(key,String(value));
  return `/tenant/${encodeURIComponent(slug)}/reports/campaigns?${params}`;
}
export function sourceGroups(rows=[]){
  const groups=new Map();
  for(const row of rows){
    const key=JSON.stringify([row.batchId,row.source,row.campaignName,row.adSetName,row.adName,row.externalCampaignId,row.externalAdId,row.campaignId,row.adId,row.evidence]);
    if(!groups.has(key))groups.set(key,{...row,rows:[]});
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}
export function suggestCampaign(group,targets=[]){
  const matched=targets.filter(t=>group.externalCampaignId?t.externalId===group.externalCampaignId:
    group.campaignName&&t.name.trim().toLocaleLowerCase()===group.campaignName.trim().toLocaleLowerCase());
  return matched.length===1?matched[0].id:'';
}
export function campaignEconomics(group,meta,filters){
  const unavailable=reason=>({reason,cpl:null,cac:null,roas:null});
  if(filters.mode!=='cohort'||filters.staff||filters.course||filters.search)return unavailable('الإنفاق لا يتوزع على فلتر الموظف أو الدورة أو بحث المصدر؛ النسب المالية غير محسوبة.');
  if(!meta||meta.metricRows===0||meta.spendMinor==null)return unavailable('لا توجد بيانات إنفاق كافية لهذه الحملة في الفترة.');
  if(!meta.coverageConfirmed)return unavailable('بيانات الإنفاق المتاحة لم تكتمل مزامنتها لكل الفترة؛ التكلفة والعائد غير محسوبين.');
  if(group.unreviewed||group.estimatedDates)return unavailable('راجع ربط المصادر وتواريخ وصول العملاء قبل مقارنة الإنفاق بالتحصيل.');
  const money=group.money||[];
  const cash=money.length===1&&money[0].currency===meta.currency?money[0]:null;
  return {reason:!cash?'العملات مختلفة أو التحصيل غير متاح؛ لا يُحسب العائد.':'',
    cpl:group.leads?meta.spendMinor/group.leads:null,cac:group.payers?meta.spendMinor/group.payers:null,
    roas:cash&&meta.spendMinor>0?cash.netMinor/meta.spendMinor:null};
}
export function campaignObservation(g){
  if(g.unreviewed)return `${g.unreviewed} عميلًا يحتاج مراجعة المصدر قبل تقييم الحملة.`;
  if(g.waiting)return `${g.waiting} عميلًا ينتظر التوزيع؛ لم تكتمل فرصة المتابعة بعد.`;
  if(g.payers)return `${g.payers} عميلًا اعتمد التسجيل دفعه من أصل ${g.leads}. راجع صافي التحصيل والاسترداد قبل تغيير الإنفاق.`;
  if(g.unqualified)return `${g.unqualified} من ${g.leads} غير مؤهلين أو أرقامهم غير صحيحة. راجع أسباب الاستبعاد والاستهداف.`;
  return 'لا توجد تحويلات مؤكدة في هذه العينة حتى تاريخ المتابعة. راجع مدة دورة البيع ونتائج المكالمات قبل الحكم.';
}
export function csvCell(value){
  let text=String(value??'');
  if(/^[\s]*[=+\-@\t\r]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
export function campaignCsv(data){
  const rows=[['الحملة','المصدر','العملاء الفريدون','بانتظار التوزيع','مهتمون','مؤهلون','غير مؤهلين','دفع مؤكد','التحويل %','العملة','التحصيل','الاسترداد','الصافي','من','إلى','المتابعة حتى','نوع الفترة']];
  for(const g of data.groups||[]){
    const money=g.money?.length?g.money:[{}];
    for(const m of money)rows.push([g.name,g.source,g.leads,g.waiting,g.interested,g.qualified,g.unqualified,g.payers,g.conversion,m.currency,
      m.grossMinor==null?'':m.grossMinor/100,m.refundMinor==null?'':m.refundMinor/100,m.netMinor==null?'':m.netMinor/100,
      data.range.from,data.range.to,data.range.asOf,data.range.mode]);
  }
  for(const m of data.additionalCash||[])rows.push([m.campaign,'مبيعات إضافية لعملاء موجودين','','','','','','','',m.currency,'','',m.netMinor/100,
    data.range.from,data.range.to,data.range.asOf,data.range.mode]);
  return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
