import {notFound} from 'next/navigation';
import {getAcademyStorefront} from '../../../../lib/academy-commerce-server';
import AcademyStorefront from '../../../../components/academy-storefront';
import {validAcademySlug} from '../../../../lib/academy-policy.mjs';
export const dynamic='force-dynamic';
export const metadata={title:'الدورات التدريبية'};
export default async function PublicCoursesPage({params}){
 const {tenantSlug}=await params;if(!validAcademySlug(tenantSlug))notFound();
 let data;try{data=await getAcademyStorefront(tenantSlug);}catch(error){if(error?.status===403||error?.status===404)notFound();throw error;}
 return <AcademyStorefront slug={tenantSlug} data={data}/>;
}
