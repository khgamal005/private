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
