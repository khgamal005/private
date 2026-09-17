import {ga4ReportErrorMessage} from '../../supabase/functions/_shared/ga4-report-errors.mjs';
const DAY=86400000;
const ACTIONS=new Set(['start','assets','select','sync','disconnect','sources','review','ga4-status','ga4-assets','ga4-streams','ga4-select','ga4-sync','ga4-report','ga4-disable']);

export function finiteMetric(value){
  if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!value.trim())return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
}

export function formatGoogleMetric(value,{money=false,currency='',digits=0}={}){
  const number=finiteMetric(value);
  if(number===null||money&&!/^[A-Z]{3}$/.test(currency))return 'غير متاح';
  try{
    if(money){
      const formatter=new Intl.NumberFormat('ar-SA',{style:'currency',currency});
      const exponent=formatter.resolvedOptions().maximumFractionDigits;
      return formatter.format(number/(10**exponent));
    }
    return new Intl.NumberFormat('ar-SA',{maximumFractionDigits:digits}).format(number);
  }catch{return 'غير متاح';}
}

function dateOnly(value){
  const input=String(value||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input))return '';
  const date=new Date(`${input}T12:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===input?input:'';
}

export function googleReportFilters(query={},now=new Date(),timezone='Asia/Riyadh',accountTimezone=''){
  let parts;
  try{parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);}
  catch{parts=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);}
  const bits=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const today=`${bits.year}-${bits.month}-${bits.day}`;
  let syncToday=today;
  if(accountTimezone){
    try{
      const accountParts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:accountTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value]));
      const accountDay=`${accountParts.year}-${accountParts.month}-${accountParts.day}`;
      if(accountDay<syncToday)syncToday=accountDay;
    }catch{}
  }
  const requestedTo=dateOnly(query.to);
  const to=requestedTo&&requestedTo<=syncToday?requestedTo:syncToday;
  const defaultFrom=new Date(Date.parse(`${to}T12:00:00Z`)-29*DAY).toISOString().slice(0,10);
  const candidate=dateOnly(query.from);
  const requestedFrom=candidate&&candidate<=to?candidate:defaultFrom;
  const rangeLimited=Date.parse(`${to}T12:00:00Z`)-Date.parse(`${requestedFrom}T12:00:00Z`)>30*DAY;
  const from=rangeLimited?new Date(Date.parse(`${to}T12:00:00Z`)-30*DAY).toISOString().slice(0,10):requestedFrom;
  const requestedAsOf=dateOnly(query.asOf);
  const asOf=requestedAsOf&&requestedAsOf>=to&&requestedAsOf<=today?requestedAsOf:today;
  return {dateFrom:from,dateTo:to,asOf,today,search:String(query.q||'').trim().slice(0,80),page:Math.max(1,Math.min(10000,Number.parseInt(query.page,10)||1)),...(accountTimezone?{syncToday}:{}),...(rangeLimited?{rangeLimited:true}:{})};
}

export function googleReportHref(slug,filters,overrides={}){
  const next={...filters,...overrides};
  const query=new URLSearchParams({from:next.dateFrom,to:next.dateTo,asOf:next.asOf});
  if(next.search)query.set('q',next.search);
  if(next.page>1)query.set('page',String(next.page));
  return `/tenant/${encodeURIComponent(slug)}/reports/google-ads?${query}`;
}

export function googleCampaignEconomics(row={},coverage={}){
  const empty=reason=>({costPerPayerMinor:null,collectionRoas:null,reason});
  if(coverage.spendComplete!==true)return empty('تكتمل النسب بعد مزامنة الإنفاق لكل أيام الفترة.');
  if(coverage.currencyMatches===false||coverage.timeBasisMatches===false||coverage.sourceDatesReliable===false)return empty('تحتاج العملة أو تواريخ وصول العملاء وفترة المقارنة إلى مراجعة.');
  const spend=finiteMetric(row.spendMinor);
  const payers=finiteMetric(row.verifiedPayers);
  const cost=finiteMetric(row.manualCostPerPayerMinor);
  const roas=finiteMetric(row.manualCollectionRoas);
  return {
    costPerPayerMinor:spend!==null&&spend>=0&&payers!==null&&payers>0&&cost!==null&&cost>=0?cost:null,
    collectionRoas:spend!==null&&spend>0&&roas!==null?roas:null,
    reason:cost===null&&roas===null?'لا تتوافر بيانات متوافقة كافية لحساب النسب.':''
  };
}

export function groupGoogleSources(rows=[]){
  const groups=new Map();
  const seen=new Set();
  for(const row of rows){
    if(!row?.originKey||!row.previewToken||seen.has(row.originKey))continue;
    seen.add(row.originKey);
    const key=JSON.stringify([row.source||'',row.campaignName||'',row.campaignId||'',row.evidence||'']);
    if(!groups.has(key))groups.set(key,{key,source:row.source||'مصدر غير محدد',campaignName:row.campaignName||'اسم حملة غير مسجل',campaignId:row.campaignId||null,rows:[]});
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

export function googleSourcePreview(groups=[],selectedKeys=[],campaignId='',campaigns=[]){
  const campaign=campaigns.find(item=>String(item.campaignId)===String(campaignId));
  const chosen=groups.filter(group=>selectedKeys.includes(group.key));
  if(!campaign||!chosen.length)return null;
  const rows=chosen.flatMap(group=>group.rows).map(row=>({originKey:row.originKey,previewToken:row.previewToken}));
  return {campaignId:String(campaign.campaignId),campaignName:campaign.name,groupCount:chosen.length,rowCount:rows.length,rows};
}

export function safeGoogleAuthorizeUrl(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='accounts.google.com'&&!url.port&&!url.username&&!url.password&&url.pathname==='/o/oauth2/v2/auth'?url.href:null;
  }catch{return null;}
}

export async function requestGoogleAction({name,slug,payload={},fetcher=fetch,signal}){
  if(['reefskills'].includes(String(slug).toLowerCase()))throw new Error('protected_tenant');
  if(!ACTIONS.has(name))throw new Error('request_rejected');
  const response=await fetcher(`/api/tenant/google-ads/${name}`,{
    method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
    body:JSON.stringify({...payload,tenantSlug:slug}),signal
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.ok===false)throw new Error(result.error||'request_rejected');
  if(name==='start'){
    const authorizeUrl=safeGoogleAuthorizeUrl(result.authorizeUrl);
    if(!authorizeUrl)throw new Error('request_rejected');
    return {...result,authorizeUrl};
  }
  return result;
}

export function googleErrorMessage(code){
  const reportError=ga4ReportErrorMessage(code);if(reportError)return reportError;
  const messages={
    ga4_stream_required:'اختر موقع ويب صالحًا من خاصية GA4 ثم أعد المحاولة.',
    ga4_consent_required:'أضف إذن قراءة Analytics من زر ربط GA4.',
    ga4_access_denied:'رفض Google Analytics طلب الوصول. راجع صلاحية البريد على GA4، وإذا كانت صحيحة فتواصل مع إدارة أودير لمراجعة إعداد الموصل.',
    ga4_admin_api_disabled:'خدمة تحميل خصائص Analytics غير مفعلة لدى أودير. تواصل مع إدارة المنصة لتفعيلها، ثم أعد تحميل الخصائص.',
    ga4_data_api_disabled:'خدمة تقارير Analytics غير مفعلة لدى أودير. تواصل مع إدارة المنصة لتفعيلها، ثم أعد المزامنة.',
    ga4_store_mismatch:'نطاق المتجر لا يطابق مسار الويب في خاصية GA4 المختارة.',
    ga4_property_changed:'تغيرت عملة GA4 أو منطقتها الزمنية أو نطاقها. راجع إعداد الربط.',
    ga4_result_limit:'حجم البيانات كبير؛ اختر فترة أقصر ثم أعد المزامنة.',
    ga4_report_changed:'تغير تقرير Google أثناء جلب الصفحات. أعد المحاولة.',
    ga4_request_failed:'لم يكتمل طلب Analytics. أعد المحاولة، وإذا تكرر الخطأ فتواصل مع الدعم لمراجعة سبب الرفض.',
    ga4_not_configured:'اختر خاصية GA4 وموقع المنشأة أولًا.',
    authentication_required:'انتهت جلسة الدخول. سجّل الدخول ثم حاول مرة أخرى.',
    session_expired:'انتهت جلسة الدخول. سجّل الدخول ثم حاول مرة أخرى.',
    forbidden:'ليست لديك صلاحية تنفيذ هذه الخطوة. تواصل مع مدير المنشأة.',
    addon_not_enabled:'الإضافة غير مفعلة لهذه المنشأة.',
    google_ads_addon_not_enabled:'الإضافة غير مفعلة لهذه المنشأة.',
    protected_tenant:'الربط غير متاح لهذه المنشأة.',
    reporting_only:'التجربة الحالية لقراءة تقارير جوجل فقط؛ مطابقة مصادر العملاء غير متاحة خلالها.',
    configuration_missing:'إعداد ربط جوجل لم يكتمل لدى إدارة المنصة. تواصل مع الدعم.',
    google_ads_configuration_missing:'إعداد ربط جوجل لم يكتمل لدى إدارة المنصة. تواصل مع الدعم.',
    reauth_required:'انتهت صلاحية الاتصال. أعد ربط حساب جوجل.',
    google_ads_reauthorization_required:'انتهت صلاحية الاتصال. أعد ربط حساب جوجل.',
    oauth_state_invalid:'انتهت محاولة الربط. ابدأ محاولة جديدة.',
    oauth_state_invalid_or_used:'انتهت محاولة الربط أو استُخدمت بالفعل. ابدأ محاولة جديدة.',
    required_scopes_missing:'لم يكتمل تفويض قراءة الحساب. أعد الربط ووافق على الصلاحية المطلوبة.',
    account_not_available:'لم يعد الحساب متاحًا لهذا التفويض. أعد تحميل الحسابات.',
    ads_account_inactive:'حساب الإعلانات ملغى أو لم تكتمل تهيئته. اختر حساب إعلانات متاحًا، ثم أعد المحاولة.',
    no_eligible_ads_accounts:'لم نجد حساب إعلانات Google Ads متاحًا للربط بهذا البريد. أعد الربط ببريد لديه صلاحية على حساب إعلانات فعلي.',
    google_access_denied:'رفض جوجل الوصول إلى حسابات الإعلانات. تأكد من صلاحية البريد على الحساب، ثم أعد الربط. إذا استمر الرفض فتواصل مع الدعم.',
    platform_access_required:'مشروع جوجل الخاص بأودير يحتاج إلى موافقة للوصول إلى حسابات الإعلانات الفعلية. تواصل مع إدارة المنصة لاستكمال التفعيل.',
    google_api_not_enabled:'واجهة Google Ads غير مفعلة في مشروع جوجل الخاص بأودير. تواصل مع إدارة المنصة لاستكمال الإعداد.',
    google_oauth_exchange_failed:'تعذر استكمال التفويض مع جوجل. ابدأ محاولة ربط جديدة، وإذا تكرر الخطأ فتواصل مع الدعم.',
    google_accounts_unavailable:'تعذر تحميل حسابات الإعلانات من جوجل. حاول الربط مرة أخرى، وإذا تكرر الخطأ فتواصل مع الدعم.',
    google_connection_save_failed:'تعذر حفظ الاتصال داخل أودير بعد استجابة جوجل. تواصل مع الدعم ثم ابدأ محاولة ربط جديدة.',
    google_ads_account_not_available:'لم يعد الحساب متاحًا لهذا التفويض. أعد تحميل الحسابات.',
    google_ads_preview_stale:'تغيرت بعض المصادر بعد المعاينة. حدّث القائمة وراجع المجموعة مجددًا.',
    preview_stale:'تغيرت بعض المصادر بعد المعاينة. حدّث القائمة وراجع المجموعة مجددًا.',
    invalid_date_range:'راجع تاريخ البداية والنهاية، ثم جرّب فترة أقصر.',
    google_ads_range_invalid:'راجع التواريخ واختر فترة لا تتجاوز ٣١ يومًا.',
    google_ads_review_invalid:'اختر مجموعة وحملة واكتب سببًا واضحًا للمطابقة من ٥ أحرف على الأقل.',
    rate_limited:'تلقى جوجل عدة طلبات متقاربة. حاول مرة أخرى بعد قليل.',
    service_unavailable:'تعذر الوصول إلى خدمة الربط مؤقتًا. حاول مرة أخرى.',
    sync_in_progress:'المزامنة جارية. حدّث التقرير بعد قليل.',
    google_ads_sync_in_progress:'المزامنة جارية. حدّث التقرير بعد قليل.',
    TimeoutError:'استغرق الطلب وقتًا أطول من المعتاد. حدّث التقرير للتحقق من النتيجة قبل المحاولة مجددًا.',
    sync_failed:'لم تكتمل المزامنة. أعد المحاولة؛ الحساب المختار محفوظ.'
  };
  return typeof code==='string'&&Object.hasOwn(messages,code)?messages[code]:'لم تكتمل الخطوة. حاول مرة أخرى أو تواصل مع الدعم.';
}
