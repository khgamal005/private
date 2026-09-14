import {redirect} from 'next/navigation';
import {authRpc,requireTenant} from '../../../../../lib/server-auth';
import {googleReportFilters} from '../../../../../lib/google-ads/ui.mjs';
import GoogleAdsConnect from '../../../../../components/google-ads-connect';

export const dynamic='force-dynamic';

export default async function GoogleAdsReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  if(['reefskills'].includes(slug.toLowerCase()))redirect(`/tenant/${encodeURIComponent(slug)}/reports`);
  await requireTenant(slug);
  let snapshot=null,report=null,unavailable=false;
  let filters=googleReportFilters(query);
  try{
    snapshot=await authRpc('v1_tenant_google_ads_snapshot',{p_slug:slug},{timeoutMs:8000,retryTransient:true});
    filters=googleReportFilters(query,new Date(),snapshot?.tenantTimezone||'Asia/Riyadh',snapshot?.selectedAccount?.timezone);
    // Start the Reef pilot with seven complete account-calendar days.
    if(slug==='reef-skills'&&!query.from&&!query.to){
      const lastComplete=new Date(Date.parse(`${filters.syncToday||filters.today}T12:00:00Z`)-86400000);
      const to=lastComplete.toISOString().slice(0,10);
      const from=new Date(lastComplete.getTime()-6*86400000).toISOString().slice(0,10);
      filters=googleReportFilters({...query,from,to},new Date(),snapshot?.tenantTimezone||'Asia/Riyadh',snapshot?.selectedAccount?.timezone);
    }
    if(snapshot?.addonEnabled&&snapshot?.enabled!==false&&snapshot?.selectedAccount){
      report=await authRpc('v1_tenant_google_ads_report',{
        p_slug:slug,p_from:filters.dateFrom,p_to:filters.dateTo,p_as_of:filters.asOf,p_page:filters.page,p_query:filters.search
      },{timeoutMs:12000,retryTransient:true});
    }
  }catch{unavailable=true;}
  return <GoogleAdsConnect slug={slug} initialData={snapshot} initialReport={report} filters={filters}
    outcome={query.google_ads} reason={query.reason} unavailable={unavailable}/>;
}
