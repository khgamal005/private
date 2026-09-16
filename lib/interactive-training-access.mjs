// The internal pilot is bound to the verified production tenant, not its URL alone.
// Expanding the rollout requires an explicit reviewed change to this allowlist.
export const INTERACTIVE_TRAINING_PILOT=Object.freeze({
  tenantId:'3d185482-b916-49cc-b868-b6dfdb93eba8',
  slug:'marktone',
  productKey:'lms'
});

export const INTERACTIVE_TRAINING_VIEWS=Object.freeze([
  {key:'dashboard',label:'نظرة عامة',icon:'overview'},
  {key:'courses',label:'الدورات التدريبية',icon:'courses'},
  {key:'paths',label:'المسارات التعليمية',icon:'interactive'},
  {key:'learners',label:'المتدربون',icon:'people'},
  {key:'calendar',label:'اللقاءات المباشرة',icon:'tasks'},
  {key:'assessments',label:'التقييمات والواجبات',icon:'registrations'},
  {key:'placement',label:'تحديد المستوى',icon:'reports'},
  {key:'waitlist',label:'قائمة الانتظار',icon:'leadQueue'},
  {key:'surveys',label:'الاستبيانات',icon:'content'},
  {key:'categories',label:'تصنيفات الدورات',icon:'catalog'},
  {key:'compliance',label:'جاهزية التعليم الإلكتروني',icon:'registrations'},
  {key:'settings',label:'إعدادات المنصة',icon:'settings'},
  {key:'support',label:'الدعم والسياسات',icon:'support'}
].map(view=>Object.freeze({...view,surfaceKey:`tenant.lms.${view.key}`})));

const VIEW_KEYS=new Set(INTERACTIVE_TRAINING_VIEWS.map(view=>view.key));
const PREVIEW_ROLES=new Set(['tenant_owner','tenant_admin','training_manager']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId=value=>typeof value==='string'&&UUID.test(value)?value.toLowerCase():null;

export function isInteractiveTrainingView(view){
  return typeof view==='string'&&VIEW_KEYS.has(view);
}

export function interactiveTrainingHref(slug,view='dashboard'){
  if(!isInteractiveTrainingView(view))return null;
  const base=`/tenant/${encodeURIComponent(slug)}/lms`;
  return view==='dashboard'?base:`${base}/${view}`;
}

/**
 * Pure policy for both server routes and native navigation. All inputs must come
 * from authenticated server snapshots; a browser flag never grants permission.
 * The entitlement RPC resolves tenantId and tenantSlug from core.tenants only
 * after its tenant access check, including for authorized platform operators.
 */
export function interactiveTrainingAccess({slug,context,addonAccess}={}){
  const denied={enabled:false,canPreviewRoles:false,tenantId:null,subjectId:null};
  if(slug!==INTERACTIVE_TRAINING_PILOT.slug)return denied;
  const subjectId=validId(context?.subject?.id);
  if(!subjectId)return denied;
  const platformAccess=context?.platformAccess===true;
  const membership=context?.memberships?.find(item=>item.tenantSlug===slug);
  if(!platformAccess&&!membership)return denied;
  const membershipId=validId(membership?.tenantId);
  const trustedTenantId=validId(addonAccess?.tenantId);
  // Inconsistent identity evidence is rejected, including a renamed/recreated slug.
  if(membership&&!membershipId)return denied;
  if(membershipId&&trustedTenantId&&membershipId!==trustedTenantId)return denied;
  if(addonAccess?.tenantSlug!==slug)return denied;
  if(membership&&!platformAccess&&membership.status!=='active')return denied;
  const tenantId=trustedTenantId;
  if(tenantId!==INTERACTIVE_TRAINING_PILOT.tenantId)return denied;
  const permissions=new Set(membership?.permissions||[]);
  if(!platformAccess&&(
    !permissions.has('tenant.academy.read')
    ||!permissions.has('tenant.academy.write')
  ))return denied;
  if(!Array.isArray(addonAccess?.enabledProductKeys)
    ||!addonAccess.enabledProductKeys.includes(INTERACTIVE_TRAINING_PILOT.productKey)){
    return denied;
  }
  const canPreviewRoles=platformAccess||Boolean(
    membership?.roles?.some(role=>PREVIEW_ROLES.has(role))
    &&permissions.has('tenant.academy.write')
  );
  return {enabled:true,canPreviewRoles,tenantId,subjectId};
}
