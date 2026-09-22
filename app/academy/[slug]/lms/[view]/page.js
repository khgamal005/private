import {notFound,redirect} from 'next/navigation';
import TrainingJourneyWorkspace from '../../../../../components/training-journey-workspace';
import {getAcademyAccess} from '../../../../../lib/academy-server';
import {getTrainingSnapshot} from '../../../../../lib/training-snapshot';
import {academyTrainingViews} from '../../../../../lib/academy-navigation.mjs';
import AcademyAuthoringWorkspace from '../../../../../components/academy-authoring-workspace';
import {getAcademyAuthoringSnapshot} from '../../../../../lib/academy-authoring-server';

export const dynamic='force-dynamic';

export default async function AcademyTrainingViewPage({params}){
  const {slug,view}=await params;
  const access=await getAcademyAccess(slug,{requiredComponent:'lms'});
  if(!academyTrainingViews(access).some(item=>item.key===view))notFound();
  if(slug==='marktone'&&['courses','paths','settings'].includes(view)){
    const authoring=await getAcademyAuthoringSnapshot(slug);
    if(authoring.available===true&&view==='settings')redirect(`/academy/${encodeURIComponent(slug)}/lms/courses`);
    if(authoring.available===true||view==='paths')return <AcademyAuthoringWorkspace key={`${slug}:${view}`} slug={slug} initialData={authoring} initialView={view}/>;
  }
  const initialData=await getTrainingSnapshot(slug,{role:'manager',workspace:'academy'});
  return <TrainingJourneyWorkspace key={`${slug}:${view}`} slug={slug} initialData={initialData} initialView={view} workspace="academy" canOpenOperations={access.odeirAccess===true}/>;
}
