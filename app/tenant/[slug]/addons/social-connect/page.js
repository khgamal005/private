import {redirect} from 'next/navigation';
import {requireTenantPermission} from '../../../../../lib/server-auth';
import {campaignFilters,campaignHref} from '../../../../../lib/campaign-revenue.mjs';

export const dynamic='force-dynamic';
export default async function SocialConnectPage({params,searchParams}){
  const [{slug},query]=await Promise.all([params,searchParams]);
  await requireTenantPermission(slug,'tenant.meta_connect.read');
  const path=campaignHref(slug,campaignFilters({...query,metaQ:query.metaQ||query.q,q:''}));
  const outcome=new URLSearchParams();
  for(const key of ['social_connect','reason'])if(typeof query[key]==='string')outcome.set(key,query[key].slice(0,100));
  redirect(path+(outcome.size?'&'+outcome:''));
}
