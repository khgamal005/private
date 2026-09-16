import {campaignFilters,campaignReportArgs} from './campaign-revenue.mjs';
import {googleReportFilters} from './google-ads/ui.mjs';
const keys=new Set(['platform','from','to','asOf','mode','staff','course','q','metaQ','status','campaign','group']);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export function parseCampaignReportContext(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.has(k)))throw new Error('odeiry_context_invalid');
 if(!['overview','meta','google'].includes(value.platform)||!date(value.from)||!date(value.to)||!date(value.asOf)||value.from>value.to||value.asOf<value.to||Date.parse(value.to)-Date.parse(value.from)>(value.mode==='crm'?365:92)*86400000)throw new Error('odeiry_context_invalid');
 if(value.mode&&!['cohort','cash','crm'].includes(value.mode))throw new Error('odeiry_context_invalid');
 if(value.status&&!['all','active','paused','other'].includes(value.status))throw new Error('odeiry_context_invalid');
 for(const key of ['staff','course','campaign'])if(value[key]&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value[key]))throw new Error('odeiry_context_invalid');
 const out={};for(const [k,v] of Object.entries(value)){if(typeof v!=='string'||v.length>100||/[\u0000-\u001f\u007f]/.test(v))throw new Error('odeiry_context_invalid');out[k]=v;}
 return out;
}
const numeric=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const pick=(value,fields)=>Object.fromEntries(fields.map(k=>[k,numeric(value?.[k])]));
const currency=v=>/^[A-Z]{3}$/.test(v||'')?v:null;
// Only whitelisted aggregate fields leave the application. Never forward raw
// reports, names, query text, identifiers, customer rows, tokens or account data.
export async function readCampaignDecisionReport({rpc,slug,context,now=new Date()}){
 const q=parseCampaignReportContext(context),f=campaignFilters(q,now);
 if(q.platform==='overview'&&q.mode==='crm'){
  const today=f.today;
  if(q.to>today)return {available:false,reason:'report_period_invalid'};
  const report=await rpc('v5_tenant_reports_snapshot',{p_slug:slug,p_from:q.from,p_to:q.to,p_staff_id:f.staff||null,p_report:'campaigns',p_limit:50,p_offset:0});
  return {available:true,sourceId:'manager.campaign_report.live',title:'ملخص الحملات من سجلات أودير للفترة المختارة',platform:'overview',range:{from:q.from,to:q.to,asOf:q.asOf,mode:'crm'},metrics:pick(report.summary,['leadsCreated','paidContacts','conversionRate','dataCompletenessRate']),limitations:['crm_results_only','spend_not_included','no_global_cac_or_roas']};
 }
 if(f.dateFrom!==q.from||f.dateTo!==q.to||f.asOf!==q.asOf)return {available:false,reason:'report_period_invalid'};
 let result;
 if(q.platform==='google'){
  const snapshot=await rpc('v1_tenant_google_ads_snapshot',{p_slug:slug});
  const gf=googleReportFilters(q,now,snapshot?.tenantTimezone,snapshot?.selectedAccount?.timezone);
  if(!snapshot?.enabled||!snapshot?.selectedAccount||gf.dateFrom!==q.from||gf.dateTo!==q.to)return {available:false,reason:'google_report_unavailable'};
  const report=await rpc('v1_tenant_google_ads_report',{p_slug:slug,p_from:q.from,p_to:q.to,p_as_of:q.asOf,p_page:1,p_query:q.q||''});
  result={metrics:pick(report.summary,['spendMinor','manualLeads','verifiedPayers','registrations','clicks','googleConversions',...(report.canReadMoney?['netCollectionsMinor']:[])]),currency:currency(report.currency),coverage:{spendComplete:report.coverage?.spendComplete===true,currencyMatches:report.coverage?.currencyMatches===true,timeBasisMatches:report.coverage?.timeBasisMatches===true,sourceDatesReliable:report.coverage?.sourceDatesReliable===true},limitations:['manual_attribution','google_conversions_are_not_verified_students','ga4_excluded_due_to_possible_overlap','no_global_cac_or_roas']};
 }else if(q.platform==='meta'){
  const report=await rpc('v3_tenant_campaign_meta_report',{p_slug:slug,p_from:q.from,p_to:q.to,p_campaign_id:f.campaign||null,p_page:1,p_query:f.metaSearch,p_status:f.status});
  result={metrics:pick(report.summary,['spendMinor','clicks','platformConversions','cpaMinor']),currency:currency(report.summary?.currency),coverage:{spendComplete:false},limitations:['provider_results_are_not_verified_students','coverage_not_confirmed','no_global_cac_or_roas']};
 }else{
  const report=await rpc('v1_tenant_campaign_revenue_report',campaignReportArgs(slug,f));
  if(!report?.enabled)return {available:false,reason:'report_unavailable'};
  result={metrics:pick(report.summary,['leads','payers','waiting','unreviewed','duplicates','invalid']),coverage:{spendComplete:false},limitations:['crm_results_only','spend_not_included','no_global_cac_or_roas']};
 }
 return {available:true,sourceId:'manager.campaign_report.live',title:'مؤشرات تقرير الحملات للفترة والفلاتر المختارة',platform:q.platform,range:{from:q.from,to:q.to,asOf:q.asOf,mode:f.mode},...result};
}
