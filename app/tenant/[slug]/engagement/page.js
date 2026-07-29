import {permanentRedirect} from 'next/navigation';

export default async function LegacyEngagementPage({params}){
  const {slug}=await params;
  permanentRedirect(`/tenant/${encodeURIComponent(slug)}/incentives`);
}
