export const TRAINING_JOURNEY_VIEWS=Object.freeze([
  {key:'dashboard',label:'نظرة عامة',icon:'overview'},
  {key:'admissions',label:'القبول والسداد',icon:'registrations'},
  {key:'courses',label:'الدورات والمحتوى',icon:'courses'},
  {key:'learners',label:'المتدربون',icon:'people'},
  {key:'calendar',label:'اللقاءات والحضور',icon:'tasks'},
  {key:'assessments',label:'التقييمات والواجبات',icon:'registrations'},
  {key:'requests',label:'طلبات المتدربين',icon:'support'},
  {key:'tasks',label:'متابعة التشغيل',icon:'tasks'},
  {key:'compliance',label:'جاهزية التعليم الإلكتروني',icon:'reports'},
  {key:'settings',label:'إعدادات المحتوى',icon:'settings'}
]);
const KEYS=new Set(TRAINING_JOURNEY_VIEWS.map(item=>item.key));
export const isTrainingJourneyView=value=>typeof value==='string'&&KEYS.has(value);
export function trainingJourneyHref(slug,view){
  if(!isTrainingJourneyView(view))return null;
  return `/tenant/${encodeURIComponent(slug)}/lms${view==='dashboard'?'':`/${view}`}`;
}

const PILOT_ID='3d185482-b916-49cc-b868-b6dfdb93eba8';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operationalPermissionKeys=Object.freeze([
  'tenant.academy.write','tenant.accounting.read',
  'tenant.admissions.read','tenant.admissions.write'
]);

// Separate from the prototype preview policy: operational staff need their own
// section, never academy authoring rights merely to confirm a payment.
export function trainingOperationsAccess({slug,context,addonAccess}={}){
  const denied={enabled:false,canManageLearning:false,canManage:false,tenantId:null,subjectId:null,views:[]};
  if(slug!=='marktone'||!ID.test(context?.subject?.id||''))return denied;
  if(context.subject.mustChangePassword===true||(context.subject.status&&context.subject.status!=='active'))return denied;
  if(addonAccess?.tenantSlug!==slug||addonAccess.tenantId!==PILOT_ID||!Array.isArray(addonAccess.enabledProductKeys)||!addonAccess.enabledProductKeys.includes('lms'))return denied;
  const membership=context.memberships?.find(item=>item.tenantSlug===slug);
  const platform=context.platformAccess===true;
  if(membership&&(membership.tenantId!==PILOT_ID||membership.status!=='active'))return denied;
  if(!platform&&!membership)return denied;
  const permissions=new Set(membership?.permissions||[]);
  if(!platform&&!operationalPermissionKeys.some(key=>permissions.has(key)))return denied;
  const canManageLearning=platform||permissions.has('tenant.academy.write');
  const canManage=platform||(canManageLearning&&permissions.has('tenant.admissions.write'));
  const allowed=canManageLearning?TRAINING_JOURNEY_VIEWS:TRAINING_JOURNEY_VIEWS.filter(view=>['dashboard','admissions','tasks'].includes(view.key));
  return {enabled:true,canManageLearning,canManage,tenantId:PILOT_ID,subjectId:context.subject.id,views:allowed};
}

export function trainingOperationsHref(slug,view='dashboard'){
  if(slug!=='marktone'||!isTrainingJourneyView(view))return null;
  return `/tenant/marktone/lms/operations?view=${encodeURIComponent(view)}`;
}
