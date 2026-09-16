import Link from 'next/link';
import {redirect} from 'next/navigation';
import {getTenantReports} from '../../../../../lib/api';
import {resolveReportRange} from '../../../../../lib/reporting';
import {getTenantReportAnalytics,sanitizeAnalyticsRange} from '../../../../../lib/report-analytics';
import {authRpc,requireTenant} from '../../../../../lib/server-auth';
import {tenantRolePolicyFromContext} from '../../../../../lib/tenant-role-policy';
import {campaignAiAvailable} from '../../../../../lib/campaign-report-access';
import {campaignFilters,campaignReportArgs} from '../../../../../lib/campaign-revenue.mjs';
import {googleReportFilters} from '../../../../../lib/google-ads/ui.mjs';
import ReportingCenter,{ReportsUnavailable} from '../../../../../components/reporting-center';
import CampaignRevenueReport from '../../../../../components/campaign-revenue-report';
import CampaignReportPlatformNav from '../../../../../components/campaign-report-platform-nav';
import CampaignRecommendations from '../../../../../components/campaign-recommendations';
import CampaignSpendOverview from '../../../../../components/campaign-spend-overview';
import SocialConnectV2 from '../../../../../components/social-connect-v2';
import styles from '../../../../../components/campaign-report-platform-nav.module.css';
export const dynamic='force-dynamic';
const options={timeoutMs:8000,retryTransient:true,redirectForbidden:false};
export default async function CampaignReportsPage({params,searchParams}){
 const [{slug},query]=await Promise.all([params,searchParams]);
 const context=await requireTenant(slug);
 const canReports=tenantRolePolicyFromContext(context,slug).showCampaignReports;
 const membership=context.memberships?.find(item=>item.tenantSlug===slug);
 const allowed=permission=>Boolean(context.platformAccess||membership?.permissions?.includes(permission));
 const canMeta=allowed('tenant.meta_connect.read')||allowed('tenant.meta_connect.manage');
 if(!canReports&&!canMeta)redirect(`/tenant/${encodeURIComponent(slug)}/reports`);
 if(query.social_connect){
  const outcome=new URLSearchParams();for(const key of ['social_connect','reason'])if(typeof query[key]==='string')outcome.set(key,query[key].slice(0,100));
  redirect(`/tenant/${encodeURIComponent(slug)}/addons/social-connect?${outcome}`);
 }
 const platform=canReports&&query.platform!=='meta'?'overview':'meta';
 const [snapshot,access,aiAvailable]=await Promise.all([
  canMeta?authRpc('v1_tenant_meta_connect_v2_snapshot',{p_tenant_slug:slug},options).catch(()=>null):null,
  canReports?authRpc('v1_tenant_campaign_report_access',{p_slug:slug},options).catch(()=>null):null,
  campaignAiAvailable(slug)
 ]);
 let filters=campaignFilters(query,new Date(),access?.timezone||'Asia/Riyadh');
 let analytics=null,range=null;
 if(platform==='overview'&&!access?.enabled){
  analytics=await getTenantReportAnalytics(slug);
  range=sanitizeAnalyticsRange(resolveReportRange(query),analytics);
  // All visible provider summaries use the final, permission-bounded CRM range.
  filters={...filters,dateFrom:range.from,dateTo:range.to,asOf:range.to,staff:range.staffId||'',mode:'crm',campaign:'',metaSearch:'',search:'',status:'all',group:''};
 }
 const span=(Date.parse(filters.dateTo)-Date.parse(filters.dateFrom))/86400000;
 const metaTask=snapshot?.selectedAccount&&span<=92?authRpc('v3_tenant_campaign_meta_report',{
  p_slug:slug,p_from:filters.dateFrom,p_to:filters.dateTo,p_campaign_id:filters.campaign||null,p_page:filters.page,p_query:filters.metaSearch,p_status:filters.status
 },options).catch(()=>null):Promise.resolve(null);
 const navigation=<CampaignReportPlatformNav slug={slug} active={platform} from={filters.dateFrom} to={filters.dateTo}/>;
 if(platform==='meta'){
  const meta=await metaTask;
  return <main className={styles.platformPage} dir="rtl"><header className={styles.platformHeading}><div><h1>تقرير Meta</h1><p>ملخص الإنفاق والنتائج، ثم الحملات والإعلانات.</p></div><Link href={`/tenant/${encodeURIComponent(slug)}/addons/social-connect`}>إعدادات الإضافة</Link></header>{navigation}
   {snapshot?.addonEnabled?<><SocialConnectV2 slug={slug} initialData={snapshot} initialReport={meta} reportFilters={filters} canManage={allowed('tenant.meta_connect.manage')} display="performance" recommendations={<CampaignRecommendations slug={slug} platform="meta" filters={filters} available={aiAvailable}/>}/>{snapshot.selectedAccount&&!meta?<p role="status">تعذر تحميل بيانات Meta لهذه الفترة؛ جرّب التحديث.</p>:null}</>:<section className={styles.platformPanel}><h2>تقرير Meta غير متاح</h2><p>راجع تفعيل الإضافة وصلاحياتك من الإعدادات.</p></section>}
  </main>;
 }
 const googleTask=(async()=>{
  try{
   const snapshot=await authRpc('v1_tenant_google_ads_snapshot',{p_slug:slug},options);
   const f=googleReportFilters({from:filters.dateFrom,to:filters.dateTo,asOf:filters.asOf},new Date(),snapshot?.tenantTimezone,snapshot?.selectedAccount?.timezone);
   const report=snapshot?.enabled&&snapshot?.selectedAccount&&f.dateFrom===filters.dateFrom&&f.dateTo===filters.dateTo
    ?await authRpc('v1_tenant_google_ads_report',{p_slug:slug,p_from:filters.dateFrom,p_to:filters.dateTo,p_as_of:filters.asOf,p_page:1,p_query:''},options):null;
   return {snapshot,report};
  }catch{return {snapshot:null,report:null};}
 })();
 let data;
 const dataTask=access?.enabled?authRpc('v1_tenant_campaign_revenue_report',campaignReportArgs(slug,filters),{...options,timeoutMs:15000}):getTenantReports(slug,{...range,report:'campaigns'});
 const [meta,google,reportResult]=await Promise.all([metaTask,googleTask,dataTask.then(value=>({value})).catch(()=>({error:true}))]);
 if(reportResult.error)return <ReportsUnavailable/>;
 data=reportResult.value;
 const spendOverview=<CampaignSpendOverview slug={slug} filters={filters} meta={meta} metaSnapshot={snapshot} google={google.report} googleSnapshot={google.snapshot} canManageMeta={allowed('tenant.meta_connect.manage')}/>;
 if(access?.enabled)return <CampaignRevenueReport slug={slug} data={data} filters={filters} meta={meta} navigation={navigation} spendOverview={spendOverview} aiAvailable={aiAvailable}/>;
 return <ReportingCenter data={data} slug={slug} view="campaigns" range={range} analytics={analytics} campaignNavigation={navigation} campaignSpendOverview={spendOverview} campaignRecommendations={<CampaignRecommendations slug={slug} platform="overview" filters={filters} available={aiAvailable}/>}/>;
}
