import {redirect} from 'next/navigation';
import {requireTenantPermission} from '../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function LegacyCallReportsPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  await requireTenantPermission(slug,'tenant.crm.read');

  const target=new URLSearchParams();
  for(const [key,value] of Object.entries(query||{})){
    if(Array.isArray(value)){
      value.forEach(item=>target.append(key,item));
    }else if(value!=null&&value!==''){
      target.set(key,String(value));
    }
  }

  const suffix=target.size?`?${target.toString()}`:'';
  redirect(
    `/tenant/${encodeURIComponent(slug)}/yeastar${suffix}`
  );
}
