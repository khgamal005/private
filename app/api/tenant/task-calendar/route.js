import {NextResponse} from 'next/server';
import {getTenantTaskCalendar} from '../../../../lib/api';
import {
  accessToken,
  requireTenantPermission
} from '../../../../lib/server-auth';
import {resolveTenantRoleKey} from '../../../../lib/tenant-role-policy';

const SALES_TASK_ROLES=new Set([
  'sales_manager',
  'sales_supervisor',
  'sales_user'
]);

export async function POST(request){
  if(!await accessToken()){
    return NextResponse.json({error:'انتهت الجلسة'},{status:401});
  }
  let body;
  try{
    body=await request.json();
  }catch{
    return NextResponse.json({error:'بيانات الطلب غير صالحة'},{status:400});
  }
  const slug=String(body?.tenantSlug||'').trim();
  if(!slug){
    return NextResponse.json({error:'لم يتم تحديد المنشأة'},{status:400});
  }

  const context=await requireTenantPermission(slug,'tenant.work.read');
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const roleKey=resolveTenantRoleKey({context,slug});
  const includeSales=Boolean(
    context.platformAccess
    ||membership?.permissions?.includes('tenant.crm.read')
  );
  const taskScope=SALES_TASK_ROLES.has(roleKey)?'sales':'all';
  const data=await getTenantTaskCalendar(slug,{includeSales,taskScope});

  return NextResponse.json(
    {data},
    {headers:{'Cache-Control':'private, no-store, max-age=0'}}
  );
}
