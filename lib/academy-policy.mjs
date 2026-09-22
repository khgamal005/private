// Pure route/access policy. Database RPCs remain the authority for every operation.
export const validAcademySlug=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
export function academyLoginPath(slug){return validAcademySlug(slug)?`/academy/login?tenant=${encodeURIComponent(slug)}`:'/academy/login';}
export function academyTrainingPath(slug,role='learner'){
  if(!validAcademySlug(slug))return '/training/login';
  return `/training/${encodeURIComponent(slug)}?workspace=academy${role==='instructor'?'&role=instructor':''}`;
}
export function hasAcademyManagement(access){
  return Boolean(access?.enabled===true&&Object.entries(access.permissions||{}).some(([key,value])=>value===true&&(/^(manage|publish|verify)/.test(key))));
}
export function academyAccessAllowed(access,slug,{requiredComponent,permission,management=false}={}){
  return Boolean(validAcademySlug(slug)&&access?.enabled===true&&access.tenant?.slug===slug&&access.tenant?.id
    &&(!requiredComponent||access.components?.[requiredComponent]===true)
    &&(!permission||access.permissions?.[permission]===true)
    &&(!management||hasAcademyManagement(access)));
}
export function academyTrainingPermission(action){
  return ['save_draft','publish_version','assign_version','assign_instructor','issue_invitation','issue_certificate'].includes(action)?'manageLearning':null;
}
export function recoveryContext(value){
  if(!value||!validAcademySlug(value.tenantSlug))return null;
  if(value.workspace==='academy')return {workspace:'academy',tenantSlug:value.tenantSlug};
  if(value.workspace==='training')return {workspace:'training',tenantSlug:value.tenantSlug,role:value.role==='instructor'?'instructor':'learner'};
  return null;
}
export function recoveryLoginPath(value){
  const context=recoveryContext(value);if(!context)return '/login';
  if(context.workspace==='academy')return academyLoginPath(context.tenantSlug);
  return `/training/login?tenant=${encodeURIComponent(context.tenantSlug)}&workspace=academy&role=${context.role}`;
}
