import {redirect} from 'next/navigation';
import {readAcademyAccess} from './academy-server';
import {academyTrainingViews,academyTrainingHref,academyBasePath} from './academy-navigation.mjs';

export async function redirectLegacyAcademy(slug,{section='lms',view='dashboard',entityType,entityId}={}){
  if(slug!=='marktone')return;
  const access=await readAcademyAccess(slug);
  if(access?.enabled!==true)return;
  if(section==='website'&&access.components?.website===true&&access.permissions?.manageWebsite===true){
    const base=`${academyBasePath(slug)}/website`;
    redirect(entityType&&entityId?`${base}/builder/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`:base);
  }
  if(section==='lms'&&academyTrainingViews(access).some(item=>item.key===view))redirect(academyTrainingHref(slug,view));
}
