export const ACADEMY_TRAINING_VIEWS=Object.freeze([
  {key:'dashboard',label:'نظرة عامة على التدريب',group:'training',icon:'chart'},
  {key:'admissions',label:'القبول والسداد',group:'training',icon:'admissions'},
  {key:'courses',label:'الدورات والمحتوى',group:'training',icon:'courses'},
  {key:'learners',label:'التسجيلات والمتدربون',group:'training',icon:'learners'},
  {key:'calendar',label:'اللقاءات والحضور',group:'training',icon:'schedule'},
  {key:'assessments',label:'التقييمات والواجبات',group:'training',icon:'assessments'},
  {key:'requests',label:'طلبات المتدربين',group:'training',icon:'requests'},
  {key:'tasks',label:'متابعة التدريب',group:'training',icon:'tasks'},
  {key:'compliance',label:'جاهزية التعليم الإلكتروني',group:'quality',icon:'compliance'},
  {key:'settings',label:'إعدادات المحتوى',group:'quality',icon:'settings'}
].map(view=>Object.freeze(view)));

export const ACADEMY_NAVIGATION_GROUPS=Object.freeze([
  Object.freeze({key:'start',label:'البداية'}),
  Object.freeze({key:'presence',label:'الموقع والبيع'}),
  Object.freeze({key:'training',label:'التدريب والتشغيل'}),
  Object.freeze({key:'quality',label:'الجودة والإعدادات'})
]);

export function academyBasePath(slug){
  return `/academy/${encodeURIComponent(slug)}`;
}

export function academyTrainingViews(access){
  if(access?.enabled!==true||access?.components?.lms!==true)return [];
  const permissions=access.permissions||{};
  const canOperate=permissions.manageAdmissions===true||permissions.verifyPayments===true;
  const connected=access.mode==='connected'&&access.odeirAccess===true;
  return ACADEMY_TRAINING_VIEWS.filter(view=>{
    if(view.key==='admissions')return connected&&canOperate;
    if(view.key==='tasks')return connected&&(canOperate||permissions.manageLearning===true);
    if(view.key==='requests')return connected?permissions.manageLearning===true:access.mode==='standalone'&&(permissions.manageAdmissions===true||permissions.manageLearning===true);
    if(view.key==='dashboard')return permissions.manageLearning===true||(connected&&canOperate)||(access.mode==='standalone'&&permissions.manageAdmissions===true);
    return permissions.manageLearning===true;
  });
}

export function canManageAcademy(access){
  if(access?.enabled!==true||!access?.tenant?.slug)return false;
  return Boolean(
    (access.components?.website===true&&access.permissions?.manageWebsite===true)
    ||(access.components?.store===true&&(access.permissions?.manageStore===true||access.permissions?.manageAdmissions===true||access.permissions?.verifyPayments===true))
    ||academyTrainingViews(access).length
  );
}

export function academyTrainingHref(slug,view='dashboard'){
  if(!ACADEMY_TRAINING_VIEWS.some(item=>item.key===view))return null;
  return `${academyBasePath(slug)}/lms${view==='dashboard'?'':`/${view}`}`;
}

export function academyNavigation(access){
  if(access?.enabled!==true||!access?.tenant?.slug)return [];
  const base=academyBasePath(access.tenant.slug);
  const items=[{key:'home',label:'لوحة المنصة',href:base,group:'start',icon:'home'}];
  if(access.components?.website===true&&access.permissions?.manageWebsite===true){
    items.push({key:'website',label:'الموقع الإلكتروني',href:`${base}/website`,group:'presence',icon:'website'});
  }
  if(access.components?.store===true&&(access.permissions?.manageStore===true||access.permissions?.manageAdmissions===true||access.permissions?.verifyPayments===true)){
    items.push({key:'store',label:'متجر الدورات والطلبات',href:`${base}/store`,group:'presence',icon:'store'});
  }
  if(access.components?.lms===true&&access.permissions?.manageLearning===true){
    items.push({key:'schedule',label:'جدولة اللقاءات والدفعات',href:`${base}/schedule`,group:'training',icon:'schedule'});
  }
  for(const view of academyTrainingViews(access)){
    items.push({key:`training-${view.key}`,label:view.label,href:academyTrainingHref(access.tenant.slug,view.key),group:view.group,icon:view.icon});
  }
  return items;
}
