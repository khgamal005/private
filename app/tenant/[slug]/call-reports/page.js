import {authRpc} from '../../../../lib/server-auth';
import {requireTenantPermission} from '../../../../lib/server-auth';
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

export default async function CallReportsPage({params,searchParams}){
  const {slug}=await params;
  const query=await searchParams;
  await requireTenantPermission(slug,'tenant.crm.read');
  let data;
  try{
    data=await authRpc('v2_tenant_yeastar_reports_snapshot_v2',{
      p_slug:slug,
      p_from:isoStart(query.from),
      p_to:isoEnd(query.to),
      p_extension:query.extension||null,
      p_call_type:query.callType||null,
      p_status:query.status||null,
      p_limit:100,
      p_offset:Math.max(Number(query.offset)||0,0)
    });
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    const schemaPending=
      detail.includes('PGRST202')
      ||detail.includes('v2_tenant_yeastar_reports_snapshot');
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
  return <YeastarReports slug={slug} initialData={data}/>;
}
