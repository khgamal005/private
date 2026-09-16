import {redirect} from 'next/navigation';
import {getTenantReports} from '../../../../../lib/api';
import {resolveReportRange} from '../../../../../lib/reporting';
import {getTenantReportAnalytics,sanitizeAnalyticsRange} from '../../../../../lib/report-analytics';
import {authRpc,requireTenant} from '../../../../../lib/server-auth';
import {tenantRolePolicyFromContext} from '../../../../../lib/tenant-role-policy';
import ReportingCenter,{ReportsUnavailable} from '../../../../../components/reporting-center';
import CampaignRevenueReport from '../../../../../components/campaign-revenue-report';
import CampaignReportPlatformNav from '../../../../../components/campaign-report-platform-nav';
import hubStyles from '../../../../../components/campaign-report-platform-nav.module.css';
import SocialConnectV2 from '../../../../../components/social-connect-v2';
import {campaignFilters,campaignReportArgs} from '../../../../../lib/campaign-revenue.mjs';

export const dynamic='force-dynamic';

export default async function CampaignReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const context=await requireTenant(slug);
  const canReports=tenantRolePolicyFromContext(context,slug).showCampaignReports;
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const allowed=permission=>Boolean(context.platformAccess||membership?.permissions?.includes(permission));
  const canMeta=allowed('tenant.meta_connect.read')||allowed('tenant.meta_connect.manage');
  if(!canReports&&!canMeta){
    redirect(`/tenant/${encodeURIComponent(slug)}/reports`);
  }
  const platform=canReports&&query.platform!=='meta'?'overview':'meta';
  let filters=campaignFilters(query);
  let snapshot=null,meta=null,revenue=null;
  try{
    if(canMeta)snapshot=await authRpc('v1_tenant_meta_connect_v2_snapshot',{p_tenant_slug:slug},{timeoutMs:8000,retryTransient:true});
    const access=canReports?await authRpc('v1_tenant_campaign_report_access',{p_slug:slug},{timeoutMs:8000,retryTransient:true}):null;
    filters=campaignFilters(query,new Date(),access?.timezone||'Asia/Riyadh');
    if(snapshot?.addonEnabled||access?.enabled){
      [meta,revenue]=await Promise.all([
        snapshot?.selectedAccount?authRpc('v3_tenant_campaign_meta_report',{
          p_slug:slug,p_from:filters.dateFrom,p_to:filters.dateTo,p_campaign_id:filters.campaign||null,p_page:filters.page,p_query:filters.metaSearch,p_status:filters.status
        },{timeoutMs:12000,retryTransient:true}):null,
        access?.enabled?authRpc('v1_tenant_campaign_revenue_report',campaignReportArgs(slug,filters),{timeoutMs:15000,retryTransient:true}):null
      ]);
    }
  }catch{
    return <ReportsUnavailable/>;
  }
  const navigation=<CampaignReportPlatformNav slug={slug} active={platform} from={filters.dateFrom} to={filters.dateTo}/>;
  const social=snapshot?.addonEnabled?<>
    <details className={hubStyles.platformPanel} open={!snapshot.selectedAccount||Boolean(query.social_connect)}><summary>ربط Meta والحساب والمزامنة</summary>
      <SocialConnectV2 slug={slug} initialData={snapshot} initialReport={meta} reportFilters={filters}
        canManage={allowed('tenant.meta_connect.manage')} outcome={query.social_connect} reason={query.reason} display="connection"/>
    </details>
    <details className={hubStyles.platformPanel} open={Boolean(snapshot.selectedAccount)}><summary>تفاصيل أداء الحملات والإعلانات وفق Meta</summary>
      <p>أرقام المنصة من {meta?.range?.from||filters.dateFrom} إلى {meta?.range?.to||filters.dateTo}. فلاتر الموظف والدورة وبحث المصدر تخص سجلات أودير؛ البحث والحالة أدناه يخصان تفاصيل Meta.</p>
      {meta?.metricRows===0?<p role="status">لا توجد نتائج مخزنة لهذه الفترة. حدّث الفترة من إعدادات الربط.</p>:null}
      <SocialConnectV2 slug={slug} initialData={snapshot} initialReport={meta} reportFilters={filters}
        canManage={allowed('tenant.meta_connect.manage')} display="performance" hideFilters={Boolean(revenue?.enabled)}/>
    </details>
  </>:null;
  if(platform==='meta'){
    return <main className={hubStyles.platformPage} dir="rtl">
      <header className={hubStyles.platformHeading}><h1>تقرير Meta</h1><p>الربط، والمزامنة، وأداء حملات Facebook وInstagram في مساحة مستقلة وواضحة.</p></header>
      {navigation}
      {social||<section className={hubStyles.platformPanel}><h2>تقرير Meta غير مفعّل</h2><p>فعّل إضافة Meta لهذه المنشأة لعرض الربط وبيانات الحملات.</p></section>}
    </main>;
  }
  if(revenue?.enabled)return <CampaignRevenueReport slug={slug} data={revenue} filters={filters} meta={meta} navigation={navigation}/>;
  const analytics=await getTenantReportAnalytics(slug);
  const range=sanitizeAnalyticsRange(resolveReportRange(query),analytics);
  let data;
  try{
    data=await getTenantReports(slug,{...range,report:'campaigns'});
  }catch(error){
    console.error('[tenant-reports] campaigns unavailable',{
      slug,
      message:error instanceof Error?error.message:String(error)
    });
    return <ReportsUnavailable/>;
  }
  return <ReportingCenter data={data} slug={slug} view="campaigns" range={range} analytics={analytics} campaignNavigation={navigation}/>;
}
