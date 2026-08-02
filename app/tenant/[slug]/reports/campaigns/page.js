import {redirect} from 'next/navigation';
import {getTenantReports} from '../../../../../lib/api';
import {resolveReportRange} from '../../../../../lib/reporting';
import {requireTenant} from '../../../../../lib/server-auth';
import {tenantRolePolicyFromContext} from '../../../../../lib/tenant-role-policy';
import ReportingCenter,{ReportsUnavailable} from '../../../../../components/reporting-center';

export const dynamic='force-dynamic';

export default async function CampaignReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const context=await requireTenant(slug);
  if(!tenantRolePolicyFromContext(context,slug).showCampaignReports){
    redirect(`/tenant/${encodeURIComponent(slug)}/reports`);
  }
  const range=resolveReportRange(query);
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
  return <ReportingCenter data={data} slug={slug} view="campaigns" range={range}/>;
}
