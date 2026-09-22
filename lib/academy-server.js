import {cache} from 'react';
import {notFound,redirect} from 'next/navigation';
import {trainingRpc} from './training-server';
import {academyAccessAllowed,academyLoginPath,validAcademySlug} from './academy-policy.mjs';

const snapshot=cache(slug=>trainingRpc('v1_academy_workspace_snapshot',{p_slug:slug}));
const optionalSnapshot=cache(slug=>trainingRpc('v1_academy_workspace_snapshot',{p_slug:slug},{timeoutMs:2000}));

// Optional navigation must never make the operating dashboard depend on a new
// product migration. The mandatory page/API checks still fail closed below.
export async function readAcademyAccess(slug){
  if(!validAcademySlug(slug))return null;
  try{const access=await optionalSnapshot(slug);return academyAccessAllowed(access,slug)?access:null;}
  catch{return null;}
}

export async function getAcademyAccess(slug,options={}){
  if(!validAcademySlug(slug))notFound();
  let access;
  try{access=await snapshot(slug);}
  catch(error){
    if(error?.status===401)redirect(academyLoginPath(slug));
    if(error?.code==='password_change_required')redirect(`${academyLoginPath(slug)}&reason=password`);
    if(error?.status===403||error?.status===404||/not_enabled|disabled|not_available/.test(error?.code||''))notFound();
    throw error;
  }
  if(!academyAccessAllowed(access,slug,options))notFound();
  return access;
}
