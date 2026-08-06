const DEFAULT_MESSAGE=
  'تعذر الاتصال بـYeastar. راجع الرابط وبيانات API والسماح بالوصول الخارجي.';

function rawError(value){
  if(typeof value==='string')return value.trim();
  if(value&&typeof value==='object'){
    return String(
      value.message||value.error_description||value.code||''
    ).trim();
  }
  return '';
}

export function yeastarErrorMessage(value,fallback=DEFAULT_MESSAGE){
  const raw=rawError(value);
  const normalized=raw.toUpperCase();

  if(
    normalized.includes('YEASTAR_IP_FORBIDDEN')
    ||normalized.includes('IP FORBIDDEN')
    ||normalized.includes('70087')
  ){
    return 'رفض Yeastar عنوان الاتصال الحالي (IP FORBIDDEN). يلزم تمرير الربط عبر عنوان خروج ثابت وإضافته إلى Allowed IPs داخل Yeastar.';
  }

  if(
    normalized.includes('YEASTAR_IP_BLOCKED')
    ||normalized.includes('ACCOUNT IP BLOCKED')
  ){
    return 'حظر Yeastar عنوان الاتصال بعد محاولات فاشلة. احذفه من Blocked IPs ثم أعد الاختبار عبر عنوان خروج ثابت.';
  }

  if(
    normalized.includes('YEASTAR_HTTP_502')
    ||/\b502\b/.test(normalized)
  ){
    return 'بوابة Yeastar لم تستجب مؤقتًا. أعد الاختبار، وإن تكرر الخطأ راجع Remote Access وحالة الجهاز.';
  }

  return raw||fallback;
}
