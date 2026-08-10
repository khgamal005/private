import {getTenantReports} from '../../../../lib/api';
import {resolveReportRange} from '../../../../lib/reporting';
import {getTenantReportAnalytics,sanitizeAnalyticsRange} from '../../../../lib/report-analytics';
import ReportingCenter,{ReportsUnavailable} from '../../../../components/reporting-center';

export const dynamic='force-dynamic';

export default async function ReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const analytics=await getTenantReportAnalytics(slug);
  const range=sanitizeAnalyticsRange(resolveReportRange(query),analytics);
  let data;
  try{
    data=await getTenantReports(slug,{...range,report:'overview'});
  }catch(error){
    console.error('[tenant-reports] overview unavailable',{
      slug,
      message:error instanceof Error?error.message:String(error)
    });
    return <ReportsUnavailable/>;
  }
  return <ReportingCenter data={data} slug={slug} view="overview" range={range} analytics={analytics}/>;
}
