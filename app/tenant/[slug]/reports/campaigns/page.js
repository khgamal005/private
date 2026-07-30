import {getTenantReports} from '../../../../../lib/api';
import {resolveReportRange} from '../../../../../lib/reporting';
import ReportingCenter,{ReportsUnavailable} from '../../../../../components/reporting-center';

export const dynamic='force-dynamic';

export default async function CampaignReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
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
