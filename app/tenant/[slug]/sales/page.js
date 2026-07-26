import {getTenant} from '../../../../lib/api';
import SalesWorkspace from '../../../../components/sales-workspace';

export const dynamic='force-dynamic';

export default async function SalesPage({params}){
  const {slug}=await params;
  return <SalesWorkspace slug={slug} initialData={await getTenant(slug)}/>;
}
