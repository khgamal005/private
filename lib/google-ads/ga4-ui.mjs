export const ga4StatusLabels={verified:'دفع معتمد في أودير',payment_pending:'طلب مطابق — ينتظر اعتماد الدفع',missing_transaction_id:'معرّف المعاملة مفقود',duplicate_transaction:'معرّف معاملة متكرر',limited_ga4_data:'بيانات GA4 محدودة',order_not_found:'الطلب لم يصل من المتجر',ambiguous_order:'الرقم يطابق أكثر من طلب',order_reused:'أكثر من معاملة تشير لنفس الطلب',order_not_routed:'الطلب وصل — الربط التشغيلي لم يكتمل',finance_currency_conflict:'عملة الدفع تختلف عن الطلب'};
export const ga4AmountLabels={consistent_item_value:'قيمة البنود متوافقة',value_difference:'فرق في قيمة البنود',currency_mismatch:'العملات غير قابلة للمقارنة',item_value_missing:'قيمة البنود غير متاحة',not_comparable:'المقارنة غير متاحة'};
export function ga4Insights(report={}) {
 const s=report.summary||{},q=report.coverage||{},items=[];
 if(!q.complete)items.push('الفترة غير مكتملة. زامن الأيام الناقصة قبل مقارنة النتائج.');
 if(q.transactionDataLimited||q.trafficDataLimited)items.push('Google أعاد بيانات محدودة أو مجمعة؛ نتائج المطابقة لا تمثل تغطية كاملة.');
 if(s.pendingPayments>0)items.push(`${s.pendingPayments} طلبًا مطابقًا ينتظر اعتماد التحصيل داخل أودير؛ راجع التسجيل والقبول.`);
 if(s.unmatched>0)items.push(`${s.unmatched} معاملة تحتاج مراجعة أسباب المطابقة قبل استخدامها في التقييم المالي.`);
 if(s.valueDifferences>0)items.push(`${s.valueDifferences} معاملة بها فرق بين قيمة GA4 وقيمة بنود المتجر؛ راجع إرسال قيمة الشراء والضريبة والشحن.`);
 if(s.transactions>0&&s.sessionAttributedOrders<s.matchedOrders)items.push('بعض الطلبات المطابقة بلا دليل جلسة يطابق حساب جوجل المختار؛ تحقق من ربط Ads مع GA4 وإعداد التتبع.');
 if(!items.length)items.push(s.transactions?'راجع الأداء بعد مرور وقت كافٍ لاعتماد المدفوعات. هذه البيانات وحدها لا تثبت أن الإعلان سبب الشراء.':'لا توجد معاملات شراء محفوظة لهذه الفترة. تحقق من تسجيل purchase وtransaction_id في المتجر.');
 return items;
}
export function ga4Csv(rows) {
 const major=(v,c)=>v==null?'':(Number(v)/10**new Intl.NumberFormat('en',{style:'currency',currency:c||'SAR'}).resolvedOptions().maximumFractionDigits).toFixed(new Intl.NumberFormat('en',{style:'currency',currency:c||'SAR'}).resolvedOptions().maximumFractionDigits);
 const headers=['المعاملة','التاريخ','الطلب','المصدر','الوسيط','الحملة','حالة المطابقة','العملة','التحصيل','الاسترداد','الصافي'];
 const esc=v=>'"'+String(v??'').replace(/^\s*[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
 return '\uFEFF'+[headers,...rows.map(r=>[r.transactionId,r.date,r.orderNumber,r.source,r.medium,r.campaignName,ga4StatusLabels[r.status]||r.status,r.currency,major(r.collectionsMinor,r.currency),major(r.refundsMinor,r.currency),major(r.netMinor,r.currency)])].map(row=>row.map(esc).join(',')).join('\r\n');
}
