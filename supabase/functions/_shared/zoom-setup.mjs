// Only booleans and an allowlisted environment leave this boundary; never secrets.
export const ZOOM_SETUP_CHECKS=[
 ['oauth','بيانات تطبيق Zoom','ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET'],
 ['callback','عنوان العودة إلى أودير','ZOOM_PUBLIC_ORIGIN / ZOOM_REDIRECT_URI'],
 ['environment','بيئة الاتصال','ZOOM_ENVIRONMENT'],
 ['webhook','التحقق من إشعارات Zoom','ZOOM_WEBHOOK_SECRET'],
 ['dispatch','اعتماد عامل التشغيل','ZOOM_DISPATCH_SECRET'],
 ['runtime','السماح بتشغيل الربط','ZOOM_RUNTIME_ENABLED'],
 ['provider','السماح بطلبات Zoom','ZOOM_V1_ENABLED'],
 ['scheduler','جدولة عامل التشغيل','Scheduled POST /functions/v1/zoom-connect/dispatch']
];
export function zoomRuntimeReadiness(value,probe={}){
 let callback=false;
 try{
  const origin=new URL(value('ZOOM_PUBLIC_ORIGIN'));
  const redirect=new URL(value('ZOOM_REDIRECT_URI'));
  callback=origin.protocol==='https:'&&!origin.username&&!origin.password
   &&origin.href===`${origin.origin}/`&&value('ZOOM_PUBLIC_ORIGIN')===origin.origin
   &&redirect.href===`${origin.origin}/api/zoom/callback`;
 }catch{/* An absent or malformed setting is incomplete, not an exception page. */}
 const environment=['test','production'].includes(value('ZOOM_ENVIRONMENT'))?value('ZOOM_ENVIRONMENT'):null;
 const checks={oauth:!!(value('ZOOM_OAUTH_CLIENT_ID')?.trim()&&value('ZOOM_OAUTH_CLIENT_SECRET')?.trim()),callback,environment:!!environment,
  webhook:!!value('ZOOM_WEBHOOK_SECRET')?.trim(),dispatch:!!value('ZOOM_DISPATCH_SECRET')?.trim(),
  runtime:value('ZOOM_RUNTIME_ENABLED')==='true',provider:value('ZOOM_V1_ENABLED')==='true',scheduler:probe.schedulerConfigured===true};
 return {checks,environment,canConnect:Object.entries(checks).filter(([key])=>key!=='scheduler').every(([,ok])=>ok),
  canSchedule:Object.values(checks).every(Boolean),verification:'configuration_only'};
}
