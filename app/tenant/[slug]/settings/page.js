import {getTenant} from '../../../../lib/api';
import TenantSettings from '../../../../components/tenant-settings';

export const dynamic='force-dynamic';

export default async function SettingsPage({params}){
  const {slug}=await params;
  return <TenantSettings slug={slug} initialData={await getTenant(slug)}/>;
}
