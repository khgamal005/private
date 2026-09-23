import {notFound} from 'next/navigation';
import {getAcademyAccess} from '../../../../lib/academy-server';
import {trainingRpc} from '../../../../lib/training-server';
import AcademyPeopleWorkspace from '../../../../components/academy-people-workspace';
export const dynamic='force-dynamic';
export default async function AcademyPeoplePage({params}) {
 const {slug}=await params;
 const access=await getAcademyAccess(slug,{requiredComponent:'lms'});
 if(slug!=='marktone'||!['manageLearning','manageAdmissions','manageTeam'].some(key=>access.permissions?.[key]))notFound();
 const data=await trainingRpc('v1_academy_people_snapshot',{p_slug:slug,p_kind:'students',p_query:'',p_offset:0});
 return <AcademyPeopleWorkspace slug={slug} initialData={data} canOpenOperations={access.odeirAccess===true}/>;
}
