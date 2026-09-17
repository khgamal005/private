// Finite diagnostics only. Provider messages, IDs and credentials never leave the adapter.
const FIELDS = ['date','transactionId','hostName','sessionSource','sessionMedium','sessionGoogleAdsCustomerId','sessionGoogleAdsCampaignId','sessionCampaignName','currencyCode','streamId','eventName','ecommercePurchases','grossPurchaseRevenue','sessions','engagedSessions','screenPageViews','addToCarts','checkouts'];
const KINDS = ['transactions','traffic'];
const REASONS = ['invalid','incompatible','not_found','unavailable','rejected'];
const CODES = new Set(KINDS.flatMap(kind=>REASONS.flatMap(reason=>[
  `ga4_${kind}_${reason}`,
  ...(['invalid','incompatible'].includes(reason)?FIELDS.map(field=>`ga4_${kind}_${reason}_${field.toLowerCase()}`):[])
])));
export const isGA4ReportError = code => typeof code==='string'&&CODES.has(code);
export function ga4ReportFailureCode(status,payload,kind) {
  if(!KINDS.includes(kind))return 'ga4_request_failed';
  if(status===404)return `ga4_${kind}_not_found`;
  if(status>=500)return `ga4_${kind}_unavailable`;
  if(status!==400)return `ga4_${kind}_rejected`;
  // Inspect only a bounded INVALID_ARGUMENT message, then discard it. The saved
  // suffix is an allowlisted schema field, never provider-supplied free text.
  const message=payload?.error?.status==='INVALID_ARGUMENT'&&typeof payload.error.message==='string'&&payload.error.message.length<=4096?payload.error.message:'';
  const reason=/\bincompatible\b/i.test(message)?'incompatible':'invalid';
  const field=FIELDS.find(name=>new RegExp(`\\b${name}\\b`).test(message));
  return `ga4_${kind}_${reason}${field?'_'+field.toLowerCase():''}`;
}
export function ga4ReportErrorMessage(code) {
  if(!isGA4ReportError(code))return null;
  const subject=code.startsWith('ga4_transactions_')?'تقرير معاملات الشراء':'تقرير الزيارات والتفاعل';
  if(code.includes('_incompatible'))return `رفض Google جمع بعض حقول ${subject}. تم حفظ رمز التشخيص للدعم لمراجعة الموصل.`;
  if(code.includes('_invalid'))return `رفض Google صيغة طلب ${subject}. تم حفظ رمز التشخيص للدعم لمراجعة الموصل.`;
  if(code.endsWith('_not_found'))return `تعذر العثور على خاصية GA4 المطلوبة عند جلب ${subject}. راجع الخاصية المختارة.`;
  if(code.endsWith('_unavailable'))return `خدمة Google غير متاحة مؤقتًا لجلب ${subject}. أعد المزامنة بعد قليل.`;
  return `لم يقبل Google طلب ${subject}. تم حفظ رمز التشخيص للدعم.`;
}
