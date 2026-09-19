import {safePortfolioUrl} from '../supabase/functions/_shared/expert-application.mjs';
export const REQUEST_STATUS={requested:'قيد المراجعة',offered:'عرض بانتظار موافقتك',accepted:'تم اعتماد العرض',declined:'العرض مرفوض',cancelled:'ملغي'};
export {safePortfolioUrl,validateExpertApplication} from '../supabase/functions/_shared/expert-application.mjs';
export function publicationReasons(item,categories,providers){
  const reasons=[];
  if(!item.marketplaceVisible)reasons.push('الظهور في المتجر مغلق');
  if(!['active','beta'].includes(item.status))reasons.push('الخدمة ليست نشطة');
  if(!categories.some(c=>c.id===item.categoryId&&c.status==='active'))reasons.push('القسم غير نشط');
  if(item.providerId&&!providers.some(p=>p.id===item.providerId&&p.status==='active'))reasons.push('مقدم الخدمة غير نشط');
  return reasons;
}
export function canOrderDirectly(item){return item.pricingMode!=='quote'&&(item.pricingMode!=='from'||item.packages?.length>0);}

export function safeExpertImage(value){return typeof value==='string'&&/^\/api\/experts\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:safePortfolioUrl(value);}
