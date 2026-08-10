import {authRpc} from './server-auth';

export const REPORT_ANALYTICS_PERMISSION='tenant.reports.analytics';

const EMPTY_FILTERS={
  canUseAnalytics:false,
  permissionKey:REPORT_ANALYTICS_PERMISSION,
  staff:[],
  extensions:[]
};

export async function getTenantReportAnalytics(slug){
  try{
    const result=await authRpc('v2_tenant_report_filter_options',{
      p_slug:slug
    });
    return {
      ...EMPTY_FILTERS,
      ...(result||{}),
      canUseAnalytics:Boolean(result?.canUseAnalytics),
      staff:Array.isArray(result?.staff)?result.staff:[],
      extensions:Array.isArray(result?.extensions)?result.extensions:[]
    };
  }catch(error){
    console.error('[tenant-reports] analytics filter options unavailable',{
      slug,
      message:error instanceof Error?error.message:String(error)
    });
    return EMPTY_FILTERS;
  }
}

export function sanitizeAnalyticsRange(range,analytics){
  if(!analytics?.canUseAnalytics){
    return {...range,staffId:null};
  }
  if(!range?.staffId)return range;
  const allowed=new Set((analytics.staff||[]).map(item=>item.staffId));
  return allowed.has(range.staffId)
    ?range
    :{...range,staffId:null};
}

export function selectedStaffExtension(analytics,staffId){
  if(!analytics?.canUseAnalytics||!staffId)return null;
  const staff=(analytics.staff||[]).find(item=>item.staffId===staffId);
  const extensions=Array.isArray(staff?.extensions)?staff.extensions:[];
  return extensions.length?String(extensions[0]):null;
}
