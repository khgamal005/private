import {authRpc,requireTenantPermission} from '../../../../lib/server-auth';
import {getTenantYeastarAccess} from '../../../../lib/api';
import YeastarAddonUnavailable from '../../../../components/yeastar-addon-unavailable';
import YeastarReports from '../../../../components/yeastar-reports';

export const dynamic='force-dynamic';

function isoStart(value){
  if(!value)return null;
  const date=new Date(`${value}T00:00:00+03:00`);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

function isoEnd(value){
  if(!value)return null;
  const date=new Date(`${value}T23:59:59.999+03:00`);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

export default async function YeastarReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  const filters=query||{};
  await requireTenantPermission(slug,'tenant.crm.read');
  const access=await getTenantYeastarAccess(slug);

  if(!access.enabled){
    return <YeastarAddonUnavailable
      slug={slug}
      canManage={access.canManage}
    />;
  }

  let data;
  try{
    data=await authRpc('v3_tenant_yeastar_reports_snapshot',{
      p_slug:slug,
      p_from:isoStart(filters.from),
      p_to:isoEnd(filters.to),
      p_extension:filters.extension||null,
      p_call_type:filters.callType||null,
      p_status:filters.status||null,
      p_limit:100,
      p_offset:Math.max(Number(filters.offset)||0,0)
    });
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    if(detail.includes('yeastar_addon_not_enabled')){
      return <YeastarAddonUnavailable
        slug={slug}
        canManage={access.canManage}
      />;
    }
    const schemaPending=
      detail.includes('PGRST202')
      ||(
        detail.includes('Could not find the function')
        &&detail.includes('v3_tenant_yeastar_reports_snapshot')
      );
    if(!schemaPending)throw error;
    console.error('[yeastar-reports] database schema pending',{
      slug,
      code:'YEASTAR_SCHEMA_PENDING'
    });
    return <section className="mt-panel">
      <div className="mt-empty">
        تقارير Yeastar غير متاحة مؤقتًا. أعد تحميل الصفحة بعد لحظات.
      </div>
    </section>;
  }

  return <YeastarReports
    slug={slug}
    initialData={data}
    canManage={Boolean(access.canManage||data.viewer?.canManage)}
  />;
}
