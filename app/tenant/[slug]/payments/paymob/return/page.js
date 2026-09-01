import PaymobReturnStatus from '../../../../../../components/paymob-return-status';
import {requireTenantPermission} from '../../../../../../lib/server-auth';

export const dynamic='force-dynamic';

export default async function PaymobReturnPage({params,searchParams}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.settings.manage');
  const query=await searchParams;
  const rawAttempt=Array.isArray(query?.attempt)?query.attempt[0]:query?.attempt;
  return <PaymobReturnStatus
    slug={slug}
    attemptId={String(rawAttempt||'')}
  />;
}
