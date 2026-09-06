import TamaraReturnStatus from '../../../../../../components/tamara-return-status';
import {requireTenantPermission} from '../../../../../../lib/server-auth';
export const dynamic='force-dynamic';
export default async function TamaraReturnPage({params,searchParams}){
 const {slug}=await params;
 await requireTenantPermission(slug,'tenant.settings.manage');
 const query=await searchParams;
 return <TamaraReturnStatus slug={slug} attemptId={typeof query?.attempt==='string'?query.attempt:''}/>;
}
