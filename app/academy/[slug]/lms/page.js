import {notFound} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../../components/training-journey-workspace';
import {getAcademyAccess} from '../../../../lib/academy-server';
import {getTrainingSnapshot} from '../../../../lib/training-snapshot';
import {academyTrainingViews} from '../../../../lib/academy-navigation.mjs';

export const dynamic='force-dynamic';

export default async function AcademyTrainingPage({params}){
  const {slug}=await params;
  const access=await getAcademyAccess(slug,{requiredComponent:'lms'});
  const views=academyTrainingViews(access);
  if(!views.length)notFound();
  const initialData=await getTrainingSnapshot(slug,{role:'manager',workspace:'academy'});
  return <TrainingJourneyWorkspace slug={slug} initialData={initialData} initialView={views[0].key} workspace="academy" canOpenOperations={access.odeirAccess===true}/>;
}
