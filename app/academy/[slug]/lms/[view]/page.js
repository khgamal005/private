import {notFound} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../../../components/training-journey-workspace';
import {getAcademyAccess} from '../../../../../lib/academy-server';
import {getTrainingSnapshot} from '../../../../../lib/training-snapshot';
import {academyTrainingViews} from '../../../../../lib/academy-navigation.mjs';

export const dynamic='force-dynamic';

export default async function AcademyTrainingViewPage({params}){
  const {slug,view}=await params;
  const access=await getAcademyAccess(slug,{requiredComponent:'lms'});
  if(!academyTrainingViews(access).some(item=>item.key===view))notFound();
  const initialData=await getTrainingSnapshot(slug,{role:'manager',workspace:'academy'});
  return <TrainingJourneyWorkspace key={`${slug}:${view}`} slug={slug} initialData={initialData} initialView={view} workspace="academy" canOpenOperations={access.odeirAccess===true}/>;
}
