import {authRpc,requireTenantPermission} from '../../../../../lib/server-auth';
import {googleReportFilters} from '../../../../../lib/google-ads/ui.mjs';
import GoogleAdsConnect from '../../../../../components/google-ads-connect';
export const dynamic='force-dynamic';
export default async function GoogleKitSettingsPage({params,searchParams}){
 const [{slug},query]=await Promise.all([params,searchParams]);
 await requireTenantPermission(slug,'tenant.reports.campaigns');
 let snapshot=null,unavailable=false;
 try{snapshot=await authRpc('v1_tenant_google_ads_snapshot',{p_slug:slug},{timeoutMs:8000,retryTransient:true});}catch{unavailable=true;}
 const filters=googleReportFilters(query,new Date(),snapshot?.tenantTimezone||'Asia/Riyadh',snapshot?.selectedAccount?.timezone);
 return <GoogleAdsConnect slug={slug} initialData={snapshot} filters={filters} display="settings" outcome={query.google_ads} reason={query.reason} unavailable={unavailable}/>;
}
