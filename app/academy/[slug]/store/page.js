import {notFound} from 'next/navigation';
import {getAcademyAccess} from '../../../../lib/academy-server';
import {getAcademyCommerceSnapshot} from '../../../../lib/academy-commerce-server';
import AcademyCommerceWorkspace from '../../../../components/academy-commerce-workspace';
export const dynamic='force-dynamic';
export default async function AcademyStorePage({params}){
 const {slug}=await params;
 const access=await getAcademyAccess(slug,{requiredComponent:'store'});
 if(!['manageStore','manageAdmissions','verifyPayments'].some(key=>access.permissions?.[key]===true))notFound();
 return <AcademyCommerceWorkspace slug={slug} initialData={await getAcademyCommerceSnapshot(slug)}/>;
}
