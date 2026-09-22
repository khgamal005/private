import AcademyShell from '../../../components/academy-shell';
import {getAcademyAccess} from '../../../lib/academy-server';

export const dynamic='force-dynamic';
export const metadata={title:'إدارة المنصة التدريبية | ماركتون',robots:{index:false,follow:false}};

export default async function AcademyLayout({children,params}){
  const {slug}=await params;
  const access=await getAcademyAccess(slug);
  return <AcademyShell access={access}>{children}</AcademyShell>;
}
