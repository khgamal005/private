import KnowledgeFeed from '../../../../components/knowledge-feed';
import {requireTenantPermission} from '../../../../lib/server-auth';
export const dynamic='force-dynamic';
export default async function Page({params}){const {slug}=await params;await requireTenantPermission(slug,'tenant.content.read');return <KnowledgeFeed tenant={slug}/>}
