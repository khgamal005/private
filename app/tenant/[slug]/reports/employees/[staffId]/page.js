import {notFound,redirect} from 'next/navigation';
import {getTenantReports} from '../../../../../../lib/api';
import {isUuid,reportQuery,resolveReportRange} from '../../../../../../lib/reporting';
import {getTenantReportAnalytics} from '../../../../../../lib/report-analytics';
import ReportingCenter,{ReportsUnavailable} from '../../../../../../components/reporting-center';

export const dynamic='force-dynamic';

export default async function EmployeeReportPage({params,searchParams}){
  const [{slug,staffId},query]=await Promise.all([params,searchParams]);
  if(!isUuid(staffId))notFound();
  const analytics=await getTenantReportAnalytics(slug);
  const range=resolveReportRange(query);
  if(
    analytics.canUseAnalytics
    &&range.staffId
    &&range.staffId!==staffId
    &&analytics.staff.some(staff=>staff.staffId===range.staffId)
  ){
    redirect(
      `/tenant/${encodeURIComponent(slug)}/reports/employees/${range.staffId}?${reportQuery(range)}`
    );
  }
  let data;
  try{
    data=await getTenantReports(slug,{
      ...range,
      staffId,
      report:'employee'
    });
  }catch(error){
    console.error('[tenant-reports] employee unavailable',{
      slug,
      staffId,
      message:error instanceof Error?error.message:String(error)
    });
    return <ReportsUnavailable message="لا يمكن فتح تقرير هذا الموظف ضمن صلاحيتك الحالية، أو أن ملفه لم يعد نشطًا."/>;
  }
  if(!data?.selectedEmployee)notFound();
  return <ReportingCenter
    data={data}
    slug={slug}
    view="employee"
    range={{...range,staffId}}
    analytics={analytics}
  />;
}
