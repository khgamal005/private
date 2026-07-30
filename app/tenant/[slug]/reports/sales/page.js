import {getTenantReports} from '../../../../../lib/api';
import {resolveReportRange} from '../../../../../lib/reporting';
import ReportingCenter,{ReportsUnavailable} from '../../../../../components/reporting-center';

export const dynamic='force-dynamic';

export default async function SalesReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const range=resolveReportRange(query);
  let data;
  try{
    data=await getTenantReports(slug,{...range,report:'sales'});
  }catch(error){
    console.error('[tenant-reports] sales unavailable',{
      slug,
      message:error instanceof Error?error.message:String(error)
    });
    return <ReportsUnavailable/>;
  }
  return <ReportingCenter data={data} slug={slug} view="sales" range={range}/>;
}
