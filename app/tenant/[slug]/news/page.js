import {redirect} from 'next/navigation';
import KnowledgeFeed from '../../../../components/knowledge-feed';
import {requireTenantPermission} from '../../../../lib/server-auth';
import {tenantRolePolicyFromContext} from '../../../../lib/tenant-role-policy';

export const dynamic='force-dynamic';

export default async function NewsPage({params}){
  const {slug}=await params;
  const context=await requireTenantPermission(slug,'tenant.content.read');
  if(!tenantRolePolicyFromContext(context,slug).showNews){
    redirect(`/tenant/${encodeURIComponent(slug)}`);
  }
  return <KnowledgeFeed tenant={slug} embedded/>;
}
