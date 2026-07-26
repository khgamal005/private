import EngagementWorkspace from '../../../../components/engagement-workspace';

export const dynamic='force-dynamic';

export default async function IncentivesPage({params}){
  const {slug}=await params;
  return <EngagementWorkspace slug={slug}/>;
}
