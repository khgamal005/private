import {getAcademyAccess} from '../../../../lib/academy-server';
import {trainingRpc} from '../../../../lib/training-server';
import AcademyScheduleWorkspace from '../../../../components/academy-schedule-workspace';
export const dynamic='force-dynamic';
export default async function AcademySchedulePage({params}){
 const {slug}=await params;
 await getAcademyAccess(slug,{requiredComponent:'lms',permission:'manageLearning'});
 const initialData=await trainingRpc('v1_academy_schedule_snapshot',{p_slug:slug});
 return <AcademyScheduleWorkspace slug={slug} initialData={initialData}/>;
}
